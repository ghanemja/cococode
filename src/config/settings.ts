import * as fs from 'node:fs';
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
  | 'PostCompact'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'SubagentStart'
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
  'PostCompact',
  'PostToolUseFailure',
  'PermissionRequest',
  'SubagentStart',
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
  /** Models to try, in order, for the rest of a turn when the session model fails. */
  fallbackModel?: string | string[];

  /** Context window in tokens. Detected from the server when unset. */
  contextWindow?: number;
  maxOutputTokens?: number;
  /** How many times a request that failed for a transient reason is retried. */
  maxRetries?: number;
  /** Abort a request when the server sends nothing for this long (ms). 0 disables the check. */
  requestTimeoutMs?: number;
  temperature?: number;
  /** true/false, or a level such as "low" | "medium" | "high" for models that take one. */
  thinking?: boolean | string;
  /** How tools are exposed: native tool calling, a text protocol, or auto-detect. */
  toolMode?: 'auto' | 'native' | 'prompt';
  /** Ollama keep_alive, e.g. "30m". */
  keepAlive?: string;

  permissions?: PermissionSettings;
  hooks?: HooksConfig;
  /** Turn every hook off without removing its configuration. */
  disableAllHooks?: boolean;
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
  /** Glob patterns for instruction files that should not be loaded. */
  claudeMdExcludes?: string[];
  /** Let the agent keep its own notes for this project between sessions. Default true. */
  autoMemoryEnabled?: boolean;
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
  maxRetries: 10,
  requestTimeoutMs: 600_000,
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

/** Deep copy of JSON-like data, so the merged result never aliases a source. */
function clone<T>(value: T): T {
  return typeof value === 'object' && value !== null ? structuredClone(value) : value;
}

/**
 * Merge settings so that later sources win for scalars, while permission
 * rule lists and hook lists accumulate across sources. The result shares no
 * objects with its inputs, so changing it cannot alter a source.
 */
export function mergeSettings(...sources: (Settings | undefined)[]): Settings {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [key, raw] of Object.entries(src)) {
      if (raw === undefined) continue;
      const value: unknown = clone(raw);
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
  const retries = Number(env.COCO_MAX_RETRIES);
  if (env.COCO_MAX_RETRIES !== undefined && Number.isInteger(retries) && retries >= 0) s.maxRetries = retries;
  const timeout = Number(env.COCO_REQUEST_TIMEOUT_MS);
  if (env.COCO_REQUEST_TIMEOUT_MS !== undefined && Number.isFinite(timeout) && timeout >= 0) s.requestTimeoutMs = timeout;
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
  type Source = LoadedSettings['sources'][number];
  const errors: string[] = [];

  const read = (scope: string, file: string, how: { filter?: (keyof Settings)[]; required?: boolean } = {}): Source | undefined => {
    let data: unknown;
    try {
      data = readJsonFile<unknown>(file);
    } catch (err) {
      errors.push((err as Error).message);
      return undefined;
    }
    if (data === undefined) {
      if (how.required) errors.push(`Settings file not found: ${file}`);
      return undefined;
    }
    if (!isPlainObject(data)) {
      errors.push(`${file} must contain a JSON object.`);
      return undefined;
    }
    return { scope, path: file, settings: how.filter ? pick(data as Settings, how.filter) : (data as Settings) };
  };

  const user = read('user', settingsPath('user', opts.projectRoot));
  const project = read('project', settingsPath('project', opts.projectRoot));
  const local = read('local', settingsPath('local', opts.projectRoot));

  const tail: Source[] = [];
  if (opts.extra) {
    const trimmed = opts.extra.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isPlainObject(parsed)) tail.push({ scope: 'flag', settings: parsed as Settings });
        else errors.push('--settings must be a JSON object.');
      } catch (err) {
        errors.push(`--settings is not valid JSON: ${(err as Error).message}`);
      }
    } else {
      const flag = read('flag', path.resolve(trimmed), { required: true });
      if (flag) tail.push(flag);
    }
  }
  const env = envSettings(process.env);
  if (Object.keys(env).length) tail.push({ scope: 'env', settings: env });
  if (opts.overrides && Object.keys(opts.overrides).length) tail.push({ scope: 'cli', settings: opts.overrides });

  // Whether to honour .claude files is itself a setting, decided by coco's own sources.
  const own = [user, project, local, ...tail].filter((s): s is Source => s !== undefined);
  const compat = mergeSettings(...own.map((s) => s.settings)).claudeCompat ?? true;
  const claude = compat
    ? [
        read('claude-project', path.join(opts.projectRoot, '.claude', 'settings.json'), { filter: CLAUDE_COMPAT_KEYS }),
        read('claude-local', path.join(opts.projectRoot, '.claude', 'settings.local.json'), { filter: CLAUDE_COMPAT_KEYS }),
      ]
    : [];

  // Compat files sit just above user settings so that .coco settings win on conflicts.
  const sources = [user, ...claude, project, local, ...tail].filter((s): s is Source => s !== undefined);
  return { merged: mergeSettings(...sources.map((s) => s.settings)), sources, errors };
}

/** Keep a copy of a settings file we cannot parse before writing over it. */
function preserveInvalid(file: string): void {
  try {
    fs.copyFileSync(file, `${file}.invalid`);
  } catch {
    // nothing to preserve
  }
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
    const data = readJsonFile<unknown>(file);
    if (isPlainObject(data)) current = data as Settings;
    else if (data !== undefined) preserveInvalid(file);
  } catch {
    // The file is not valid JSON. It contributes nothing while it is broken,
    // but the user's text is kept next to it rather than silently replaced.
    preserveInvalid(file);
  }
  mutate(current);
  writeJsonFile(file, current);
  return file;
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Set a dotted key ("permissions.defaultMode") on a settings object. */
export function setByPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  if (parts.some((p) => p === '' || UNSAFE_KEYS.has(p))) throw new Error(`Invalid settings key: ${dotted}`);
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!Object.hasOwn(node, key) || !isPlainObject(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (value === undefined) delete node[last];
  else node[last] = value;
}

export function getByPath(source: unknown, dotted: string): unknown {
  let node: unknown = source;
  for (const part of dotted.split('.')) {
    // Own properties only: "toString" is not a setting.
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) return undefined;
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
