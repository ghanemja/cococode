/**
 * Native Ollama API. Preferred over Ollama's /v1 endpoint because only the
 * native API lets a request set the context window (`options.num_ctx`).
 * Ollama otherwise picks a default from available VRAM (4k below 24 GB),
 * which silently truncates the system prompt and tool definitions.
 */
import type { Message, StopReason, ToolCall } from '../types.ts';
import { isRecord, parseJsonLoose } from '../util/json.ts';
import type { ChatRequest, ModelInfo, Provider, StreamEvent } from './types.ts';
import {
  ProviderError,
  classifyError,
  connectionError,
  fetchWithTimeout,
  newCallId,
  readErrorBody,
  readLines,
} from './types.ts';

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: unknown[];
  tool_name?: string;
}

export function toOllamaMessages(system: string, messages: Message[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else {
        const text = msg.content
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('\n');
        const images = msg.content.filter((p) => p.type === 'image').map((p) => (p as { data: string }).data);
        out.push(images.length ? { role: 'user', content: text, images } : { role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      const wire: OllamaMessage = { role: 'assistant', content: msg.content ?? '' };
      if (msg.toolCalls?.length) {
        wire.tool_calls = msg.toolCalls.map((c, index) => ({
          type: 'function',
          function: { index, name: c.name, arguments: c.arguments ?? {} },
        }));
      }
      out.push(wire);
    } else {
      out.push({ role: 'tool', content: msg.content, tool_name: msg.name });
      if (msg.images?.length) {
        out.push({ role: 'user', content: `Image returned by ${msg.name}:`, images: msg.images.map((i) => i.data) });
      }
    }
  }
  return out;
}

/** Normalise OLLAMA_HOST-style values ("0.0.0.0:11434", "localhost") to a URL. */
export function normalizeOllamaHost(host: string): string {
  let h = host.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  const url = new URL(h);
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1';
  if (!url.port && url.protocol === 'http:' && !/^https?:\/\/[^/]+:\d+/.test(h)) url.port = '11434';
  return url.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export interface OllamaOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export class OllamaProvider implements Provider {
  readonly type = 'ollama' as const;
  readonly name: string;
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;
  /** Models that rejected the `think` parameter. */
  private readonly noThink = new Set<string>();
  private readonly infoCache = new Map<string, ModelInfo>();

  constructor(opts: OllamaOptions) {
    this.name = opts.name;
    this.baseUrl = normalizeOllamaHost(opts.baseUrl);
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.headers ?? {};
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...this.extraHeaders };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async *chat(req: ChatRequest): AsyncGenerator<StreamEvent> {
    let res: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const options: Record<string, unknown> = {};
      if (req.contextWindow) options.num_ctx = req.contextWindow;
      if (req.maxTokens) options.num_predict = req.maxTokens;
      if (req.temperature !== undefined) options.temperature = req.temperature;
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toOllamaMessages(req.system, req.messages),
        stream: true,
        options,
      };
      if (req.keepAlive) body.keep_alive = req.keepAlive;
      if (req.tools.length) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      const sentThink = req.thinking !== undefined && !this.noThink.has(req.model);
      if (sentThink) body.think = req.thinking;

      try {
        res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        throw connectionError(this.baseUrl, err);
      }
      if (res.ok) break;
      const message = await readErrorBody(res);
      if (sentThink && /think/i.test(message)) {
        this.noThink.add(req.model);
        continue;
      }
      throw new ProviderError(classifyError(res.status, message), message, res.status);
    }
    if (!res || !res.ok) throw new ProviderError('http', 'The server rejected the request.');

    let sawCalls = false;
    let stop: StopReason = 'stop';
    for await (const line of readLines(res, req.signal)) {
      if (!line.trim()) continue;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof chunk.error === 'string') {
        throw new ProviderError(classifyError(500, chunk.error), chunk.error);
      }
      const message = chunk.message as Record<string, unknown> | undefined;
      if (message) {
        if (typeof message.thinking === 'string' && message.thinking) yield { type: 'thinking', text: message.thinking };
        if (typeof message.content === 'string' && message.content) yield { type: 'text', text: message.content };
        if (Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls as Record<string, unknown>[]) {
            const fn = (tc.function ?? {}) as { name?: string; arguments?: unknown };
            if (!fn.name) continue;
            const call: ToolCall = { id: typeof tc.id === 'string' && tc.id ? tc.id : newCallId(), name: fn.name, arguments: {} };
            if (isRecord(fn.arguments)) call.arguments = fn.arguments;
            else if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
              const parsed = parseJsonLoose(fn.arguments);
              if (parsed.ok && isRecord(parsed.value)) call.arguments = parsed.value;
              else call.parseError = `arguments were not valid JSON: ${fn.arguments.slice(0, 200)}`;
            }
            sawCalls = true;
            yield { type: 'tool_call', call };
          }
        }
      }
      if (chunk.done === true) {
        if (chunk.done_reason === 'length') stop = 'length';
        const outputTokens = typeof chunk.eval_count === 'number' ? chunk.eval_count : 0;
        const evalNs = typeof chunk.eval_duration === 'number' ? chunk.eval_duration : 0;
        yield {
          type: 'usage',
          usage: {
            inputTokens: typeof chunk.prompt_eval_count === 'number' ? chunk.prompt_eval_count : 0,
            outputTokens,
            evalMs: evalNs ? evalNs / 1e6 : undefined,
            tokensPerSecond: evalNs && outputTokens ? outputTokens / (evalNs / 1e9) : undefined,
          },
        };
      }
    }
    yield { type: 'done', stopReason: sawCalls ? 'tool_calls' : stop };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/api/tags`, { headers: this.headers() }, 5000, signal);
    } catch (err) {
      throw connectionError(this.baseUrl, err);
    }
    if (!res.ok) throw new ProviderError('http', await readErrorBody(res), res.status);
    const json = (await res.json()) as { models?: Record<string, unknown>[] };
    const models: ModelInfo[] = (json.models ?? []).map((m) => {
      const details = isRecord(m.details) ? m.details : {};
      return {
        id: String(m.name ?? m.model),
        sizeBytes: typeof m.size === 'number' ? m.size : undefined,
        modifiedAt: typeof m.modified_at === 'string' ? m.modified_at : undefined,
        parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : undefined,
        quantization: typeof details.quantization_level === 'string' ? details.quantization_level : undefined,
      };
    });
    try {
      const ps = await fetchWithTimeout(`${this.baseUrl}/api/ps`, { headers: this.headers() }, 2000, signal);
      if (ps.ok) {
        const running = (await ps.json()) as { models?: Record<string, unknown>[] };
        for (const r of running.models ?? []) {
          const model = models.find((m) => m.id === r.name || m.id === r.model);
          if (!model) continue;
          model.loaded = true;
          if (typeof r.context_length === 'number') model.loadedContextLength = r.context_length;
        }
      }
    } catch {
      // older servers have no /api/ps
    }
    return models;
  }

  async modelInfo(model: string): Promise<ModelInfo | undefined> {
    const cached = this.infoCache.get(model);
    if (cached) return cached;
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/show`,
        { method: 'POST', headers: this.headers(), body: JSON.stringify({ model }) },
        5000,
      );
      if (!res.ok) return undefined;
      const json = (await res.json()) as Record<string, unknown>;
      const info: ModelInfo = { id: model };
      const modelInfo = isRecord(json.model_info) ? json.model_info : {};
      for (const [key, value] of Object.entries(modelInfo)) {
        if (key.endsWith('.context_length') && typeof value === 'number') info.contextLength = value;
      }
      if (Array.isArray(json.capabilities)) {
        info.capabilities = (json.capabilities as unknown[]).filter((c): c is string => typeof c === 'string');
      }
      const details = isRecord(json.details) ? json.details : {};
      if (typeof details.parameter_size === 'string') info.parameterSize = details.parameter_size;
      if (typeof details.quantization_level === 'string') info.quantization = details.quantization_level;
      this.infoCache.set(model, info);
      return info;
    } catch {
      return undefined;
    }
  }
}
