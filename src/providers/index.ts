import type { ProviderConfig, Settings } from '../config/settings.ts';
import { DEFAULTS } from '../config/settings.ts';
import type { ToolCall } from '../types.ts';
import { OllamaProvider, normalizeOllamaHost } from './ollama.ts';
import { OpenAIProvider } from './openai.ts';
import { TextStreamParser, toTextProtocol } from './textTools.ts';
import type { ChatRequest, ModelInfo, Provider, StreamEvent } from './types.ts';
import { ProviderError, fetchWithTimeout } from './types.ts';

export * from './types.ts';

/** Built-in endpoints, in the order they are probed during auto-detection. */
export const PRESETS: Record<string, ProviderConfig> = {
  ollama: { type: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
  lmstudio: { type: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' },
  llamacpp: { type: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' },
  vllm: { type: 'openai', baseUrl: 'http://127.0.0.1:8000/v1' },
  jan: { type: 'openai', baseUrl: 'http://127.0.0.1:1337/v1' },
  koboldcpp: { type: 'openai', baseUrl: 'http://127.0.0.1:5001/v1' },
  tabby: { type: 'openai', baseUrl: 'http://127.0.0.1:5000/v1' },
  // Not probed automatically; selected by name or by --base-url.
  'ollama-openai': { type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' },
  openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1' },
};

const PROBE_ORDER = ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'jan', 'koboldcpp', 'tabby'];

export function providerConfigs(settings: Settings): Record<string, ProviderConfig> {
  // Null prototype: a provider called "constructor" or "toString" must not resolve to an inherited member.
  const configs: Record<string, ProviderConfig> = Object.assign(Object.create(null) as Record<string, ProviderConfig>, PRESETS, settings.providers ?? {});
  const ollamaHost = process.env.OLLAMA_HOST;
  if (ollamaHost && !settings.providers?.ollama) {
    try {
      configs.ollama = { type: 'ollama', baseUrl: normalizeOllamaHost(ollamaHost) };
    } catch {
      // malformed OLLAMA_HOST: keep the default
    }
  }
  if (process.env.OPENAI_BASE_URL && !settings.providers?.openai) {
    configs.openai = { type: 'openai', baseUrl: process.env.OPENAI_BASE_URL };
  }
  return configs;
}

export function createProvider(name: string, config: ProviderConfig): Provider {
  if (config.type === 'ollama') return new OllamaProvider({ name, ...config });
  return new OpenAIProvider({ name, ...config });
}

export interface DetectedServer {
  name: string;
  config: ProviderConfig;
  models: ModelInfo[];
}

async function probe(name: string, config: ProviderConfig, timeoutMs: number): Promise<DetectedServer | null> {
  try {
    // A cheap reachability check first so dead ports fail fast.
    const url = config.type === 'ollama' ? `${config.baseUrl}/api/version` : `${config.baseUrl}/models`;
    const res = await fetchWithTimeout(url, { headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {} }, timeoutMs);
    if (!res.ok) return null;
    await res.body?.cancel();
    const models = await createProvider(name, config).listModels();
    return { name, config, models };
  } catch {
    return null;
  }
}

/** Find local model servers that are running right now. */
export async function detectServers(settings: Settings, timeoutMs = 700): Promise<DetectedServer[]> {
  const configs = providerConfigs(settings);
  const names = [...PROBE_ORDER, ...Object.keys(settings.providers ?? {}).filter((n) => !PROBE_ORDER.includes(n))];
  const results = await Promise.all(names.map((n) => (configs[n] ? probe(n, configs[n]!, timeoutMs) : null)));
  return results.filter((r): r is DetectedServer => r !== null);
}

const EMBEDDING_RE = /embed|bge-|e5-|nomic|minilm|rerank/i;

/** Models usable for chat, best default first: loaded, then most recently modified. */
export function rankModels(models: ModelInfo[]): ModelInfo[] {
  return models
    .filter((m) => !EMBEDDING_RE.test(m.id) && !m.capabilities?.includes('embedding'))
    .sort((a, b) => {
      if (Boolean(a.loaded) !== Boolean(b.loaded)) return a.loaded ? -1 : 1;
      return (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '');
    });
}

export interface ResolvedProvider {
  provider: Provider;
  /** Model named by settings, if any. */
  model?: string;
  /** Other servers found while auto-detecting. */
  detected?: DetectedServer[];
}

export const NO_SERVER_HELP = [
  'No local model server found.',
  '',
  'Start one of these, then run coco again:',
  '  Ollama      ollama serve            (then: ollama pull qwen3-coder)',
  '  LM Studio   start the local server from the Developer tab',
  '  llama.cpp   llama-server -m model.gguf --jinja --ctx-size 32768',
  '',
  'Or point coco at any OpenAI-compatible endpoint:',
  '  coco --base-url http://host:port/v1 --model <name>',
].join('\n');

function buildProvider(name: string, base: ProviderConfig, settings: Settings): Provider {
  const config: ProviderConfig = {
    ...base,
    baseUrl: settings.baseUrl ?? base.baseUrl,
    apiKey: settings.apiKey ?? base.apiKey ?? (name === 'openai' ? process.env.OPENAI_API_KEY : undefined),
  };
  return createProvider(name, config);
}

/**
 * Decide which server to talk to. An explicit provider or base URL wins;
 * otherwise the first running local server is used.
 */
export async function resolveProvider(settings: Settings): Promise<ResolvedProvider> {
  const configs = providerConfigs(settings);
  const model = settings.model;

  if (settings.provider) {
    const base = configs[settings.provider];
    if (!base) {
      throw new ProviderError('other', `Unknown provider "${settings.provider}". Known providers: ${Object.keys(configs).join(', ')}.`);
    }
    return { provider: buildProvider(settings.provider, base, settings), model };
  }

  if (settings.baseUrl) {
    const url = settings.baseUrl.replace(/\/+$/, '');
    // Ollama's native API unless the URL explicitly targets its /v1 endpoint.
    const isOllama = /:11434$/.test(url);
    const config: ProviderConfig = {
      type: isOllama ? 'ollama' : 'openai',
      baseUrl: url,
      apiKey: settings.apiKey ?? process.env.OPENAI_API_KEY,
    };
    return { provider: createProvider(isOllama ? 'ollama' : 'custom', config), model };
  }

  // "provider/model" shorthand, only when the prefix names a known provider.
  const slash = model ? model.indexOf('/') : -1;
  const prefix = model && slash > 0 ? model.slice(0, slash) : undefined;
  const shorthand = prefix !== undefined && configs[prefix] ? { name: prefix, model: model!.slice(slash + 1) } : undefined;

  let detected: DetectedServer[] | undefined;
  if (shorthand) {
    // Model ids can themselves begin with a provider's name ("openai/gpt-oss-20b"
    // on LM Studio). A running server that lists the full id takes precedence.
    detected = await detectServers(settings);
    const local = detected.find((d) => d.models.some((m) => m.id === model));
    if (local) return { provider: createProvider(local.name, local.config), model, detected };
    return { provider: buildProvider(shorthand.name, configs[shorthand.name]!, settings), model: shorthand.model };
  }

  detected = await detectServers(settings);
  if (detected.length === 0) throw new ProviderError('connection', NO_SERVER_HELP);
  // Prefer a server that actually has the requested model.
  const withModel = model ? detected.find((d) => d.models.some((m) => m.id === model || m.id === `${model}:latest`)) : undefined;
  const chosen = withModel ?? detected.find((d) => d.models.length > 0) ?? detected[0]!;
  return { provider: createProvider(chosen.name, chosen.config), model, detected };
}

export interface ModelProfile {
  info?: ModelInfo;
  /** Context window we plan around and, on Ollama, request. */
  contextWindow: number;
  maxOutputTokens: number;
  toolMode: 'native' | 'prompt';
  vision: boolean;
  /** Human-readable notes worth showing the user (context warnings and the like). */
  notes: string[];
}

/** Work out context size, output budget and tool mode for a model. */
export async function profileModel(provider: Provider, model: string, settings: Settings): Promise<ModelProfile> {
  const info = await provider.modelInfo(model).catch(() => undefined);
  const notes: string[] = [];
  let contextWindow: number;

  if (settings.contextWindow) {
    contextWindow = settings.contextWindow;
    if (info?.contextLength && contextWindow > info.contextLength) {
      notes.push(`contextWindow ${contextWindow} exceeds the model's maximum (${info.contextLength}); using ${info.contextLength}.`);
      contextWindow = info.contextLength;
    }
  } else if (provider.type === 'ollama') {
    // We set num_ctx on every request, so this is what the model actually gets.
    contextWindow = Math.min(info?.contextLength ?? DEFAULTS.contextWindow, DEFAULTS.contextWindow);
  } else if (info?.loadedContextLength) {
    contextWindow = info.loadedContextLength;
  } else {
    contextWindow = Math.min(info?.contextLength ?? DEFAULTS.contextWindow, DEFAULTS.contextWindow);
    if (/:11434\/v1$/.test(provider.baseUrl)) {
      notes.push(
        "Ollama's /v1 endpoint cannot set the context window per request and defaults to 4k on most GPUs. " +
          'Use the native provider (--provider ollama) or set OLLAMA_CONTEXT_LENGTH.',
      );
    }
  }
  if (contextWindow < 8192) {
    notes.push(
      `The context window is only ${contextWindow} tokens. The system prompt and tool definitions use roughly 3k, so expect frequent compaction. ` +
        'Reload the model with a larger context (16k or more) if you can.',
    );
  }

  const maxOutputTokens = settings.maxOutputTokens ?? Math.max(1024, Math.min(8192, Math.floor(contextWindow / 4)));

  let toolMode: 'native' | 'prompt' = 'native';
  if (settings.toolMode === 'prompt') toolMode = 'prompt';
  else if (settings.toolMode !== 'native' && info?.capabilities && !info.capabilities.includes('tools')) {
    toolMode = 'prompt';
    notes.push(`${model} does not advertise native tool calling; using the text tool protocol.`);
  }

  return {
    info,
    contextWindow,
    maxOutputTokens,
    toolMode,
    vision: Boolean(info?.vision ?? info?.capabilities?.includes('vision')),
    notes,
  };
}

/**
 * A provider plus a model profile. Adds what every caller needs on top of the
 * raw stream: text-protocol tool calling, leaked tool-call recovery and the
 * automatic fallback when a server rejects native tools.
 */
export class ModelClient {
  provider: Provider;
  model: string;
  profile: ModelProfile;
  private readonly settings: Settings;

  constructor(provider: Provider, model: string, profile: ModelProfile, settings: Settings) {
    this.provider = provider;
    this.model = model;
    this.profile = profile;
    this.settings = settings;
  }

  async *chat(req: Omit<ChatRequest, 'model' | 'contextWindow' | 'keepAlive'> & { maxTokens?: number }): AsyncGenerator<StreamEvent> {
    const base: ChatRequest = {
      ...req,
      model: this.model,
      contextWindow: this.profile.contextWindow,
      maxTokens: req.maxTokens ?? this.profile.maxOutputTokens,
      temperature: req.temperature ?? this.settings.temperature,
      thinking: req.thinking ?? this.settings.thinking,
      keepAlive: this.settings.keepAlive ?? DEFAULTS.keepAlive,
    };

    // A hung server would otherwise hang the session: give up when nothing at all arrives for too long.
    const timeoutMs = this.settings.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    const watchdog = new AbortController();
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (!(timeoutMs > 0)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        watchdog.abort();
      }, timeoutMs);
    };
    base.signal = req.signal ? AbortSignal.any([req.signal, watchdog.signal]) : watchdog.signal;
    try {
      yield* this.attempt(base, arm, () => stalled, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  private async *attempt(base: ChatRequest, arm: () => void, isStalled: () => boolean, timeoutMs: number): AsyncGenerator<StreamEvent> {
    for (let attempt = 0; attempt < 2; attempt++) {
      arm();
      const wire = this.profile.toolMode === 'prompt' ? toTextProtocol(base) : base;
      const parser = new TextStreamParser(base.tools.map((t) => t.name));
      let emitted = false;
      let calls = 0;
      let finished = false;
      // Some servers put a call in the structured field and also leave its
      // text in the content. The same call from both sources is one call.
      const seen = new Map<string, 'native' | 'text'>();
      const isRepeat = (call: ToolCall, source: 'native' | 'text'): boolean => {
        const key = `${call.name}\n${JSON.stringify(call.arguments)}`;
        const earlier = seen.get(key);
        if (earlier !== undefined && earlier !== source) return true;
        seen.set(key, source);
        return false;
      };
      const fromParser = function* (events: StreamEvent[]): Generator<StreamEvent> {
        for (const parsed of events) {
          if (parsed.type === 'tool_call') {
            if (isRepeat(parsed.call, 'text')) continue;
            calls++;
          }
          yield parsed;
        }
      };
      try {
        for await (const event of this.provider.chat(wire)) {
          arm();
          if (event.type === 'text') {
            for (const parsed of fromParser(parser.push(event.text))) {
              emitted = true;
              yield parsed;
            }
          } else if (event.type === 'done') {
            yield* fromParser(parser.flush());
            finished = true;
            yield { type: 'done', stopReason: calls > 0 ? 'tool_calls' : event.stopReason };
          } else if (event.type === 'tool_call') {
            if (isRepeat(event.call, 'native')) continue;
            calls++;
            emitted = true;
            yield event;
          } else {
            if (event.type !== 'usage') emitted = true;
            yield event;
          }
        }
        if (!finished) {
          // A stream that ends without saying so still has text held in the parser.
          yield* fromParser(parser.flush());
          yield { type: 'done', stopReason: calls > 0 ? 'tool_calls' : 'stop' };
        }
        return;
      } catch (err) {
        if (isStalled()) {
          const minutes = Math.round(timeoutMs / 6000) / 10;
          throw new ProviderError(
            'timeout',
            `The model server sent nothing for ${minutes} minute${minutes === 1 ? '' : 's'}. It may be overloaded, still loading the model, or stuck. ` +
              'If your hardware simply needs longer, raise requestTimeoutMs.',
          );
        }
        const canFallBack =
          err instanceof ProviderError &&
          err.kind === 'tools_unsupported' &&
          this.profile.toolMode === 'native' &&
          this.settings.toolMode !== 'native' &&
          !emitted;
        if (!canFallBack) throw err;
        this.profile.toolMode = 'prompt';
        this.profile.notes.push(`${this.model} rejected native tool calling; switched to the text tool protocol.`);
      }
    }
  }

  /** One-shot completion without tools, for summaries and titles. */
  async complete(system: string, prompt: string, opts: { signal?: AbortSignal; maxTokens?: number } = {}): Promise<string> {
    let text = '';
    for await (const event of this.chat({
      system,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal: opts.signal,
      maxTokens: opts.maxTokens,
    })) {
      if (event.type === 'text') text += event.text;
    }
    return text.trim();
  }
}
