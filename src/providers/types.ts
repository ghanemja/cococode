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
  | { type: 'done'; stopReason: StopReason };

export interface ModelInfo {
  id: string;
  /** Largest context the model supports. */
  contextLength?: number;
  /** Context the server currently runs the model with, when known. */
  loadedContextLength?: number;
  /** Known capability names: "tools", "vision", "thinking". Undefined when the server does not say. */
  capabilities?: string[];
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
  if (status === 404 || /model .*not found|no such model|model not loaded|try pulling it first/.test(m)) {
    return 'model_not_found';
  }
  return 'http';
}

export function connectionError(baseUrl: string, err: unknown): ProviderError {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return new ProviderError('aborted', 'Request aborted');
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

/** Yield complete lines from a streaming response body. */
export async function* readLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new ProviderError('aborted', 'Request aborted');
      const { done, value } = await reader.read();
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
