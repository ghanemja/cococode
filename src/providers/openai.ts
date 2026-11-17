/**
 * OpenAI-compatible chat completions: LM Studio, llama.cpp server, vLLM, Jan,
 * LocalAI, KoboldCpp, Ollama's /v1 endpoint and hosted APIs with the same shape.
 */
import type { ContentPart, Message, StopReason, ToolCall, Usage } from '../types.ts';
import { isRecord, parseJsonLoose } from '../util/json.ts';
import { TRUNCATED_ARGS } from './textTools.ts';
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

interface WireToolCall {
  id: string;
  name: string;
  args: string;
}

interface WireMessage {
  role: string;
  content: string | null | unknown[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

function contentParts(parts: ContentPart[]): unknown[] {
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } },
  );
}

export function toOpenAIMessages(system: string, messages: Message[]): WireMessage[] {
  const out: WireMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: typeof msg.content === 'string' ? msg.content : contentParts(msg.content) });
    } else if (msg.role === 'assistant') {
      const wire: WireMessage = { role: 'assistant', content: msg.content ?? '' };
      if (msg.toolCalls?.length) {
        wire.tool_calls = msg.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      }
      out.push(wire);
    } else {
      out.push({ role: 'tool', tool_call_id: msg.toolCallId, name: msg.name, content: msg.content });
      if (msg.images?.length) {
        // Tool messages cannot carry images on most servers; attach them as a user turn.
        out.push({ role: 'user', content: contentParts([{ type: 'text', text: `Image returned by ${msg.name}:` }, ...msg.images]) });
      }
    }
  }
  return out;
}

function mapFinish(reason: unknown): StopReason | undefined {
  if (reason === 'stop' || reason === 'eos' || reason === 'end_turn') return 'stop';
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call' || reason === 'tool_use') return 'tool_calls';
  if (typeof reason === 'string' && reason) return 'stop';
  return undefined;
}

export interface OpenAIOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

/** Optional request fields that some servers reject; dropped one at a time on a 400. */
const OPTIONAL_FIELDS = ['stream_options', 'parallel_tool_calls', 'reasoning_effort'] as const;

export class OpenAIProvider implements Provider {
  readonly type = 'openai' as const;
  readonly name: string;
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly rejected = new Set<string>();

  constructor(opts: OpenAIOptions) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.headers ?? {};
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...this.extraHeaders };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /** Server root without the /v1 suffix, for vendor-specific endpoints. */
  private root(): string {
    return this.baseUrl.replace(/\/v1$/, '');
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
    };
    if (!this.rejected.has('stream_options')) body.stream_options = { include_usage: true };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      // llama.cpp only emits several calls per turn when asked to.
      if (!this.rejected.has('parallel_tool_calls')) body.parallel_tool_calls = true;
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (!this.rejected.has('reasoning_effort')) {
      if (typeof req.thinking === 'string') body.reasoning_effort = req.thinking;
      else if (req.thinking === false) body.reasoning_effort = 'none';
    }
    return body;
  }

  async *chat(req: ChatRequest): AsyncGenerator<StreamEvent> {
    let res: Response | undefined;
    for (let attempt = 0; attempt < OPTIONAL_FIELDS.length + 1; attempt++) {
      const body = this.buildBody(req);
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
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
      if (res.status === 400 || res.status === 422) {
        const lower = message.toLowerCase();
        const culprit = OPTIONAL_FIELDS.find((f) => f in body && lower.includes(f));
        if (culprit) {
          this.rejected.add(culprit);
          continue;
        }
      }
      const kind = classifyError(res.status, message);
      // A 404 that is not about the model usually means the URL is missing its /v1 suffix.
      const hint = res.status === 404 && kind === 'http' ? ` (${this.baseUrl}/chat/completions was not found; OpenAI-compatible servers usually need a base URL ending in /v1)` : '';
      throw new ProviderError(kind, `${message}${hint}`, res.status);
    }
    if (!res || !res.ok) throw new ProviderError('http', 'The server rejected the request.');

    const calls = new Map<number, WireToolCall>();
    let nextSlot = 0;
    const slotByIndex = new Map<number, number>();
    let stop: StopReason | undefined;
    let usage: Usage | undefined;

    const isComplete = (args: string): boolean => {
      if (!args.trim()) return false;
      try {
        JSON.parse(args);
        return true;
      } catch {
        return false;
      }
    };

    const handle = function* (chunk: Record<string, unknown>): Generator<StreamEvent> {
      if (chunk.error) {
        const err = chunk.error as { message?: string } | string;
        const message = typeof err === 'string' ? err : (err.message ?? JSON.stringify(err));
        throw new ProviderError(classifyError(500, message), message);
      }

      const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (u && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined)) {
        usage = { ...(usage ?? {}), inputTokens: u.prompt_tokens ?? usage?.inputTokens ?? 0, outputTokens: u.completion_tokens ?? usage?.outputTokens ?? 0 };
      }
      // llama.cpp reports generation speed in a `timings` object.
      const timings = chunk.timings as { predicted_per_second?: number; predicted_ms?: number; prompt_n?: number; predicted_n?: number } | undefined;
      if (timings) {
        usage = {
          inputTokens: usage?.inputTokens ?? timings.prompt_n ?? 0,
          outputTokens: usage?.outputTokens ?? timings.predicted_n ?? 0,
          evalMs: timings.predicted_ms,
          tokensPerSecond: timings.predicted_per_second,
        };
      }

      const choice = (chunk.choices as Record<string, unknown>[] | undefined)?.[0];
      if (!choice) return;
      // `message` instead of `delta` when a server answers without streaming.
      const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
      if (delta) {
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking', text: reasoning };
        if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
        const deltaCalls = delta.tool_calls as Record<string, unknown>[] | undefined;
        if (Array.isArray(deltaCalls)) {
          for (const tc of deltaCalls) {
            const fn = (tc.function ?? {}) as { name?: string; arguments?: unknown };
            const index = typeof tc.index === 'number' ? tc.index : 0;
            const id = typeof tc.id === 'string' ? tc.id : '';
            let slot = slotByIndex.get(index);
            const existing = slot !== undefined ? calls.get(slot) : undefined;
            // Some servers reuse index 0 for every call. A fragment that names a
            // function starts a new call when it carries a different id, or when
            // the call already in that slot is complete.
            const startsNew =
              existing !== undefined &&
              typeof fn.name === 'string' &&
              fn.name !== '' &&
              ((id !== '' && existing.id !== '' && id !== existing.id) || (existing.name !== '' && isComplete(existing.args)));
            if (!existing || startsNew) {
              slot = nextSlot++;
              slotByIndex.set(index, slot);
              calls.set(slot, { id, name: '', args: '' });
            }
            const entry = calls.get(slot!)!;
            if (id && !entry.id) entry.id = id;
            if (typeof fn.name === 'string' && fn.name) entry.name = fn.name;
            if (typeof fn.arguments === 'string') entry.args += fn.arguments;
            else if (isRecord(fn.arguments)) entry.args = JSON.stringify(fn.arguments);
          }
        }
      }
      const finish = mapFinish(choice.finish_reason);
      if (finish) stop = finish;
    };

    // A server that ignores `stream: true` answers with one JSON document
    // instead of events. It is recognised by its first line, because the
    // content type is not reliable either way.
    let wholeBody: string | null = null;
    for await (const line of readLines(res, req.signal)) {
      if (wholeBody !== null) {
        wholeBody += `\n${line}`;
        continue;
      }
      if (!line.startsWith('data:')) {
        if (/^\s*\{/.test(line)) wholeBody = line;
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (isRecord(chunk)) yield* handle(chunk);
    }
    if (wholeBody !== null) {
      const parsed = parseJsonLoose(wholeBody);
      if (parsed.ok && isRecord(parsed.value)) yield* handle(parsed.value);
    }

    const hadCalls = [...calls.values()].some((call) => call.name);
    for (const call of [...calls.entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1])) {
      if (!call.name) continue;
      const toolCall: ToolCall = { id: call.id || newCallId(), name: call.name, arguments: {} };
      const raw = call.args.trim();
      if (raw) {
        const parsed = parseJsonLoose(raw);
        if (parsed.ok && isRecord(parsed.value)) {
          toolCall.arguments = parsed.value;
          if (parsed.truncated) toolCall.parseError = TRUNCATED_ARGS;
        } else {
          toolCall.parseError = `arguments were not valid JSON: ${raw.slice(0, 200)}`;
        }
      }
      yield { type: 'tool_call', call: toolCall };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', stopReason: hadCalls ? 'tool_calls' : (stop ?? 'stop') };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/models`, { headers: this.headers() }, 5000, signal);
    } catch (err) {
      throw connectionError(this.baseUrl, err);
    }
    if (!res.ok) throw new ProviderError('http', await readErrorBody(res), res.status);
    const json = (await res.json()) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] };
    const items = json.data ?? json.models ?? [];
    const models: ModelInfo[] = items
      .map((m): ModelInfo | null => {
        const id = (m.id ?? m.name ?? m.model) as string | undefined;
        if (!id) return null;
        const meta = isRecord(m.meta) ? m.meta : {};
        const ctx = (m.max_model_len ?? m.context_length ?? m.context_window ?? m.max_context_length) as number | undefined;
        return {
          id,
          contextLength: typeof ctx === 'number' ? ctx : typeof meta.n_ctx_train === 'number' ? meta.n_ctx_train : undefined,
          sizeBytes: typeof meta.size === 'number' ? meta.size : undefined,
        };
      })
      .filter((m): m is ModelInfo => m !== null);

    // Enrich from vendor endpoints when they exist. Failures are expected and ignored.
    await Promise.all([this.enrichFromLmStudio(models), this.enrichFromLlamaCpp(models)]);
    return models;
  }

  private async enrichFromLmStudio(models: ModelInfo[]): Promise<void> {
    try {
      const res = await fetchWithTimeout(`${this.root()}/api/v0/models`, { headers: this.headers() }, 1500);
      if (!res.ok) return;
      const json = (await res.json()) as { data?: Record<string, unknown>[] };
      for (const item of json.data ?? []) {
        const model = models.find((m) => m.id === item.id);
        if (!model) continue;
        if (typeof item.max_context_length === 'number') model.contextLength = item.max_context_length;
        if (typeof item.loaded_context_length === 'number') model.loadedContextLength = item.loaded_context_length;
        model.loaded = item.state === 'loaded';
        if (typeof item.quantization === 'string') model.quantization = item.quantization;
        if (item.type === 'vlm') model.vision = true;
        // Tool support is only known when the server lists capabilities; older
        // versions do not, and absence must not be read as "no tools".
        if (Array.isArray(item.capabilities) || item.type === 'embeddings') {
          const caps: string[] = [];
          if (Array.isArray(item.capabilities) && item.capabilities.includes('tool_use')) caps.push('tools');
          if (item.type === 'vlm') caps.push('vision');
          if (item.type === 'embeddings') caps.push('embedding');
          model.capabilities = caps;
        }
      }
    } catch {
      // not LM Studio
    }
  }

  private async enrichFromLlamaCpp(models: ModelInfo[]): Promise<void> {
    if (models.length !== 1) return; // /props describes the single loaded model
    try {
      const res = await fetchWithTimeout(`${this.root()}/props`, { headers: this.headers() }, 1500);
      if (!res.ok) return;
      const props = (await res.json()) as Record<string, unknown>;
      const model = models[0]!;
      const gen = isRecord(props.default_generation_settings) ? props.default_generation_settings : {};
      if (typeof gen.n_ctx === 'number') model.loadedContextLength = gen.n_ctx;
      model.loaded = true;
      const modalities = isRecord(props.modalities) ? props.modalities : {};
      if (modalities.vision) model.vision = true;
      // Without template capabilities tool support is unknown, so leave it unset.
      const templateCaps = isRecord(props.chat_template_caps) ? props.chat_template_caps : undefined;
      if (templateCaps) {
        const caps: string[] = [];
        if (templateCaps.supports_tools || templateCaps.supports_tool_calls) caps.push('tools');
        if (modalities.vision) caps.push('vision');
        model.capabilities = caps;
      }
    } catch {
      // not llama.cpp
    }
  }

  async modelInfo(model: string): Promise<ModelInfo | undefined> {
    try {
      const models = await this.listModels();
      return models.find((m) => m.id === model);
    } catch {
      return undefined;
    }
  }
}
