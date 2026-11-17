import type { Message, StopReason, ToolCall, ToolSpec, Usage } from '../types.ts';

export interface ChatRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** Requested context window (Ollama num_ctx). Ignored by servers that fix it at load time. */
  contextWindow?: number;
  thinking?: boolean | string;
  keepAlive?: string;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  /** Output is arriving that is not shown yet (tool-call arguments). Keeps stall detection and progress honest. */
  | { type: 'progress'; chars: number }
  | { type: 'done'; stopReason: StopReason };

export interface ModelInfo {
  id: string;
  /** Largest context the model supports. */
  contextLength?: number;
  /** Context the server currently runs the model with, when known. */
  loadedContextLength?: number;
  /** Known capability names: "tools", "vision", "thinking". Undefined when the server does not say. */
  capabilities?: string[];
  /** Image input, when the server reports it separately from `capabilities`. */
  vision?: boolean;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  loaded?: boolean;
  modifiedAt?: string;
}

export type ProviderErrorKind =
  | 'connection'
  | 'model_not_found'
  | 'tools_unsupported'
  | 'context_overflow'
  | 'aborted'
  | 'timeout'
  | 'http'
  | 'other';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;

  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

export interface Provider {
  /** Preset or config name, e.g. "ollama", "lmstudio". */
  readonly name: string;
  readonly type: 'ollama' | 'openai';
  readonly baseUrl: string;
  chat(req: ChatRequest): AsyncGenerator<StreamEvent>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  modelInfo(model: string): Promise<ModelInfo | undefined>;
}

/** Classify an error body from a local server into something we can act on. */
export function classifyError(status: number, message: string): ProviderErrorKind {
  const m = message.toLowerCase();
  if (/does not support tools|tool(s)? (is|are) not supported|tool calling is not supported|no tool support|does not support function/.test(m)) {
    return 'tools_unsupported';
  }
  if (
    /context (length|window|size)|exceeds? the (available )?context|maximum context|too many tokens|prompt is too long|context_length_exceeded|n_ctx|exceed_context/.test(
      m,
    )
  ) {
    return 'context_overflow';
  }
  if (/model .*not found|no such model|no models? loaded|model not loaded|try pulling it first|model .*does not exist|unknown model/.test(m)) {
    return 'model_not_found';
  }
  // A bare 404 is more often a wrong base URL than a missing model.
  if (status === 404 && /model/.test(m)) return 'model_not_found';
  return 'http';
}

export function connectionError(baseUrl: string, err: unknown): ProviderError {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (err instanceof ProviderError) return err;
  if (e?.name === 'AbortError') return new ProviderError('aborted', 'Request aborted');
  if (e?.name === 'TimeoutError') {
    return new ProviderError('connection', `Timed out waiting for ${baseUrl}. Is the model server running and responsive?`);
  }
  const code = e?.cause?.code ?? '';
  const detail = code || e?.cause?.message || e?.message || String(err);
  return new ProviderError('connection', `Could not reach ${baseUrl} (${detail}). Is the model server running?`);
}

export async function readErrorBody(res: Response): Promise<string> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
  try {
    const json = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
    if (typeof json.error === 'string') return json.error;
    if (json.error && typeof json.error.message === 'string') return json.error.message;
    if (typeof json.message === 'string') return json.message;
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 500) || `HTTP ${res.status}`;
}

/**
 * Yield complete lines from a streaming response body. A read that fails is
 * reported as an abort when the caller cancelled, and otherwise as a dropped
 * connection, so callers never see a raw fetch error.
 */
export async function* readLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new ProviderError('aborted', 'Request aborted');
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal?.aborted || (err as Error)?.name === 'AbortError') throw new ProviderError('aborted', 'Request aborted');
        const e = err as Error & { cause?: { code?: string; message?: string } };
        const detail = e?.cause?.code || e?.cause?.message || e?.message || String(err);
        throw new ProviderError('connection', `The connection to the model server was lost mid-response (${detail}).`);
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally {
    reader.cancel().catch(() => {});
  }
}

let callCounter = 0;

export function newCallId(): string {
  return `call_${Date.now().toString(36)}${(callCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return fetch(url, { ...init, signal: AbortSignal.any(signals) });
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Failures worth retrying: the server was unreachable, stalled, overloaded or
 * still loading the model. Bad requests and missing models are not.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.kind === 'connection' || err.kind === 'timeout') return true;
  if (err.kind !== 'http') return false;
  if (err.status !== undefined && TRANSIENT_STATUS.has(err.status)) return true;
  return /loading model|model is loading|server busy|overloaded|try again|temporarily unavailable/i.test(err.message);
}
