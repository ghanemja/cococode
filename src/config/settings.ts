import * as path from 'node:path';
import type { PermissionMode } from '../types.ts';
import { PROJECT_DIR, configDir, readJsonFile, writeJsonFile } from './paths.ts';

export interface ProviderConfig {
  /** Wire protocol. `ollama` is the native Ollama API, `openai` is any /v1/chat/completions server. */
  type: 'ollama' | 'openai';
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface HookCommand {
  type: 'command';
  command: string;
  /** Seconds. */
  timeout?: number;
}

export interface HookMatcher {
  /** Regex matched against the tool name (tool events only). Empty or "*" matches everything. */
  matcher?: string;
  hooks: HookCommand[];
}

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd';

export const HOOK_EVENTS: HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
];

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

export interface PermissionSettings {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  defaultMode?: PermissionMode;
  additionalDirectories?: string[];
}

export interface Settings {
  /** Name of a built-in provider preset or a key of `providers`. */
  provider?: string;
  model?: string;
  /** Overrides the provider's base URL. */
  baseUrl?: string;
  apiKey?: string;
  providers?: Record<string, ProviderConfig>;
  /** Optional lighter model for summaries and other background work. */
  smallModel?: string;

  /** Context window in tokens. Detected from the server when unset. */
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  /** true/false, or a level such as "low" | "medium" | "high" for models that take one. */
  thinking?: boolean | string;
  /** How tools are exposed: native tool calling, a text protocol, or auto-detect. */
  toolMode?: 'auto' | 'native' | 'prompt';
  /** Ollama keep_alive, e.g. "30m". */
  keepAlive?: string;

  permissions?: PermissionSettings;
  hooks?: HooksConfig;
  env?: Record<string, string>;

  autoCompact?: boolean;
  /** Fraction of the context window at which auto-compaction triggers. */
  compactThreshold?: number;
  maxToolOutputChars?: number;
  bashTimeoutMs?: number;
  bashMaxTimeoutMs?: number;

  outputStyle?: string;
  statusLine?: { type: 'command'; command: string };
  webSearch?: { provider?: 'duckduckgo' | 'searxng'; url?: string };
  /** Also read CLAUDE.md and .claude/{commands,agents,skills,settings.json}. Default true. */
  claudeCompat?: boolean;
  verbose?: boolean;
  /** Ring the terminal bell when a turn finishes or input is needed. */
  bell?: boolean;
  mcpServers?: Record<string, unknown>;
  disabledMcpServers?: string[];
  /** Transcripts older than this are deleted at startup. */
  cleanupPeriodDays?: number;
}

export type SettingsScope = 'user' | 'project' | 'local';

export const DEFAULTS = {
  contextWindow: 32768,
  compactThreshold: 0.8,
  maxToolOutputChars: 30000,
  bashTimeoutMs: 120_000,
  bashMaxTimeoutMs: 600_000,
  keepAlive: '30m',
  cleanupPeriodDays: 30,
} as const;

export function settingsPath(scope: SettingsScope, projectRoot: string): string {
  switch (scope) {
    case 'user':
      return path.join(configDir(), 'settings.json');
    case 'project':
      return path.join(projectRoot, PROJECT_DIR, 'settings.json');
    case 'local':
      return path.join(projectRoot, PROJECT_DIR, 'settings.local.json');
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Merge settings so that later sources win for scalars, while permission
 * rule lists and hook lists accumulate across sources.
 */
export function mergeSettings(...sources: (Settings | undefined)[]): Settings {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined) continue;
      const prev = out[key];
      if (key === 'permissions' && isPlainObject(value)) {
        const a = (prev ?? {}) as PermissionSettings;
        const b = value as PermissionSettings;
        out[key] = {
          ...a,
          ...b,
          allow: uniq([...(a.allow ?? []), ...(b.allow ?? [])]),
          ask: uniq([...(a.ask ?? []), ...(b.ask ?? [])]),
          deny: uniq([...(a.deny ?? []), ...(b.deny ?? [])]),
          additionalDirectories: uniq([...(a.additionalDirectories ?? []), ...(b.additionalDirectories ?? [])]),
        } satisfies PermissionSettings;
      } else if (key === 'hooks' && isPlainObject(value)) {
        const merged: Record<string, unknown[]> = { ...((prev ?? {}) as Record<string, unknown[]>) };
        for (const [event, list] of Object.entries(value)) {
          if (Array.isArray(list)) merged[event] = [...(merged[event] ?? []), ...list];
        }
        out[key] = merged;
      } else if (isPlainObject(value) && isPlainObject(prev)) {
        out[key] = { ...prev, ...value };
      } else {
        out[key] = value;
      }
    }
  }
  return out as Settings;
}

export interface LoadedSettings {
  merged: Settings;
  /** Per-source settings, kept so the UI can show where a value came from. */
  sources: { scope: string; path?: string; settings: Settings }[];
  errors: string[];
}

export interface LoadOptions {
  projectRoot: string;
  /** --settings: a path to a JSON file or an inline JSON string. */
  extra?: string;
  /** Flags and environment, applied last. */
  overrides?: Settings;
}

function envSettings(env: NodeJS.ProcessEnv): Settings {
  const s: Settings = {};
  if (env.COCO_PROVIDER) s.provider = env.COCO_PROVIDER;
  if (env.COCO_MODEL) s.model = env.COCO_MODEL;
  if (env.COCO_BASE_URL) s.baseUrl = env.COCO_BASE_URL;
  if (env.COCO_API_KEY) s.apiKey = env.COCO_API_KEY;
  if (env.COCO_SMALL_MODEL) s.smallModel = env.COCO_SMALL_MODEL;
  const ctx = Number(env.COCO_CONTEXT_WINDOW);
  if (Number.isFinite(ctx) && ctx > 0) s.contextWindow = ctx;
  const out = Number(env.COCO_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(out) && out > 0) s.maxOutputTokens = out;
  if (env.COCO_TOOL_MODE === 'native' || env.COCO_TOOL_MODE === 'prompt' || env.COCO_TOOL_MODE === 'auto') {
    s.toolMode = env.COCO_TOOL_MODE;
  }
  return s;
}

/** Only these keys are honoured from .claude/settings.json; model choices there are Claude-specific. */
const CLAUDE_COMPAT_KEYS: (keyof Settings)[] = ['permissions', 'hooks', 'env'];

function pick(settings: Settings, keys: (keyof Settings)[]): Settings {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (settings[k] !== undefined) out[k] = settings[k];
  return out as Settings;
}

export function loadSettings(opts: LoadOptions): LoadedSettings {
  const sources: LoadedSettings['sources'] = [];
  const errors: string[] = [];

  const read = (scope: string, file: string, filter?: (keyof Settings)[]) => {
    try {
      const data = readJsonFile<Settings>(file);
      if (data && isPlainObject(data)) {
        sources.push({ scope, path: file, settings: filter ? pick(data, filter) : data });
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  };

  read('user', settingsPath('user', opts.projectRoot));

  // Compat files are read first so that .coco settings win on conflicts.
  const userSettings = sources[0]?.settings;
  const projectProbe = (() => {
    try {
      return readJsonFile<Settings>(settingsPath('project', opts.projectRoot));
    } catch {
      return undefined;
    }
  })();
  const compat = projectProbe?.claudeCompat ?? userSettings?.claudeCompat ?? true;
  if (compat) {
    read('claude-project', path.join(opts.projectRoot, '.claude', 'settings.json'), CLAUDE_COMPAT_KEYS);
    read('claude-local', path.join(opts.projectRoot, '.claude', 'settings.local.json'), CLAUDE_COMPAT_KEYS);
  }
  read('project', settingsPath('project', opts.projectRoot));
  read('local', settingsPath('local', opts.projectRoot));

  if (opts.extra) {
    const trimmed = opts.extra.trim();
    if (trimmed.startsWith('{')) {
      try {
        sources.push({ scope: 'flag', settings: JSON.parse(trimmed) as Settings });
      } catch (err) {
        errors.push(`--settings is not valid JSON: ${(err as Error).message}`);
      }
    } else {
      read('flag', path.resolve(trimmed));
    }
  }

  const env = envSettings(process.env);
  if (Object.keys(env).length) sources.push({ scope: 'env', settings: env });
  if (opts.overrides && Object.keys(opts.overrides).length) {
    sources.push({ scope: 'cli', settings: opts.overrides });
  }

  return { merged: mergeSettings(...sources.map((s) => s.settings)), sources, errors };
}

/** Read-modify-write a single settings file. */
export function updateSettingsFile(
  scope: SettingsScope,
  projectRoot: string,
  mutate: (settings: Settings) => void,
): string {
  const file = settingsPath(scope, projectRoot);
  let current: Settings = {};
  try {
    current = readJsonFile<Settings>(file) ?? {};
  } catch {
    current = {};
  }
  mutate(current);
  writeJsonFile(file, current);
  return file;
}

/** Set a dotted key ("permissions.defaultMode") on a settings object. */
export function setByPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (value === undefined) delete node[last];
  else node[last] = value;
}

export function getByPath(source: unknown, dotted: string): unknown {
  let node: unknown = source;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** Parse a CLI value: JSON when it looks like JSON, otherwise a plain string. */
export function parseSettingValue(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === 'undefined') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  return raw;
}
