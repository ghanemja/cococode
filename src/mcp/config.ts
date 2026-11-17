import * as path from 'node:path';
import { PROJECT_DIR, configDir, readJsonFile, writeJsonFile } from '../config/paths.ts';

export interface McpStdioConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Tool-call timeout for this server in milliseconds. Values under 1000 are ignored. */
  timeout?: number;
}

export interface McpHttpConfig {
  /** `http` is Streamable HTTP; `sse` is the older HTTP+SSE transport. */
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  /** Tool-call timeout for this server in milliseconds. Values under 1000 are ignored. */
  timeout?: number;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export type McpScope = 'user' | 'project' | 'local';

export interface ScopedMcpServer {
  name: string;
  scope: McpScope | 'settings' | 'flag';
  config: McpServerConfig;
}

export const MCP_SCOPES: McpScope[] = ['user', 'project', 'local'];

/**
 * user    -> ~/.coco/mcp.json
 * project -> <root>/.mcp.json            (shared, the same file other MCP clients read)
 * local   -> <root>/.coco/mcp.local.json (personal, not committed)
 */
export function mcpConfigPath(scope: McpScope, projectRoot: string): string {
  switch (scope) {
    case 'user':
      return path.join(configDir(), 'mcp.json');
    case 'project':
      return path.join(projectRoot, '.mcp.json');
    case 'local':
      return path.join(projectRoot, PROJECT_DIR, 'mcp.local.json');
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Accepts `{ "mcpServers": {...} }` or a bare `{ name: config }` map. */
function serverMap(data: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(data)) return undefined;
  if (isPlainObject(data.mcpServers)) return data.mcpServers;
  if ('mcpServers' in data) return undefined;
  return data;
}

/** Expand ${VAR} and ${VAR:-default} from the environment. Missing variables are reported. */
function expand(value: string, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return '';
  });
}

function stringMap(value: unknown, missing: Set<string>): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    out[k] = expand(String(v), missing);
  }
  return out;
}

/** Smallest per-server `timeout` that is honoured; anything lower is almost certainly seconds typed by mistake. */
export const MIN_SERVER_TIMEOUT_MS = 1000;

/** The per-server tool-call timeout, when it is a usable number of milliseconds. */
function timeoutField(value: unknown, missing: Set<string>): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const n = typeof value === 'number' ? value : Number(expand(value, missing).trim() || NaN);
  return Number.isFinite(n) && n >= MIN_SERVER_TIMEOUT_MS ? Math.floor(n) : undefined;
}

/** Validate one server entry and expand environment references. Returns an error string on failure. */
export function normalizeMcpConfig(raw: unknown): { config?: McpServerConfig; error?: string; missingEnv: string[] } {
  const missing = new Set<string>();
  if (!isPlainObject(raw)) return { error: 'must be an object', missingEnv: [] };

  const rawType = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
  const hasUrl = typeof raw.url === 'string' && raw.url.trim() !== '';
  const hasCommand = typeof raw.command === 'string' && raw.command.trim() !== '';

  if (rawType === 'sse' || rawType === 'http' || rawType === 'streamable-http' || rawType === 'streamablehttp' || (!rawType && hasUrl && !hasCommand)) {
    if (!hasUrl) return { error: `type "${rawType}" requires a "url"`, missingEnv: [] };
    const url = expand(String(raw.url), missing);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)');
    } catch {
      return { error: `invalid url "${url}"`, missingEnv: [...missing] };
    }
    const config: McpHttpConfig = { type: rawType === 'sse' ? 'sse' : 'http', url };
    const headers = stringMap(raw.headers, missing);
    if (headers && Object.keys(headers).length) config.headers = headers;
    const timeout = timeoutField(raw.timeout, missing);
    if (timeout !== undefined) config.timeout = timeout;
    return { config, missingEnv: [...missing] };
  }

  if (rawType !== undefined && rawType !== 'stdio') {
    return { error: `unknown type "${String(raw.type)}" (expected stdio, http or sse)`, missingEnv: [] };
  }
  if (!hasCommand) return { error: 'needs either a "command" or a "url"', missingEnv: [] };

  const config: McpStdioConfig = { type: 'stdio', command: expand(String(raw.command), missing) };
  if (Array.isArray(raw.args)) config.args = raw.args.map((a) => expand(String(a), missing));
  else if (raw.args !== undefined) return { error: '"args" must be an array', missingEnv: [] };
  const env = stringMap(raw.env, missing);
  if (env && Object.keys(env).length) config.env = env;
  if (typeof raw.cwd === 'string' && raw.cwd) config.cwd = expand(raw.cwd, missing);
  const timeout = timeoutField(raw.timeout, missing);
  if (timeout !== undefined) config.timeout = timeout;
  return { config, missingEnv: [...missing] };
}

export interface LoadMcpOptions {
  /** --mcp-config values: file paths, or inline JSON strings. They override every other source. */
  extraFiles?: string[];
  /** `mcpServers` from settings.json. Lowest precedence. */
  inline?: Record<string, unknown>;
  /** Server names to skip. */
  disabled?: string[];
}

/**
 * Collect MCP servers from every source. When the same name appears more than
 * once the more specific source wins: flag > local > project > user > settings.
 * Never throws; problems are returned in `errors`.
 */
export function loadMcpServers(
  projectRoot: string,
  opts: LoadMcpOptions = {},
): { servers: ScopedMcpServer[]; errors: string[] } {
  const errors: string[] = [];
  const byName = new Map<string, ScopedMcpServer>();
  const disabled = new Set(opts.disabled ?? []);

  const addAll = (scope: ScopedMcpServer['scope'], origin: string, map: Record<string, unknown> | undefined) => {
    if (!map) return;
    for (const [name, raw] of Object.entries(map)) {
      if (disabled.has(name)) continue;
      const { config, error, missingEnv } = normalizeMcpConfig(raw);
      if (!config) {
        errors.push(`${origin}: MCP server "${name}" ${error}`);
        continue;
      }
      if (missingEnv.length) {
        errors.push(`${origin}: MCP server "${name}" references unset environment variable(s): ${missingEnv.join(', ')}`);
      }
      // Re-insert so the winning definition also determines ordering.
      byName.delete(name);
      byName.set(name, { name, scope, config });
    }
  };

  const readFile = (scope: ScopedMcpServer['scope'], file: string, mustExist: boolean) => {
    let data: unknown;
    try {
      data = readJsonFile<unknown>(file);
    } catch (err) {
      errors.push((err as Error).message);
      return;
    }
    if (data === undefined) {
      if (mustExist) errors.push(`MCP config file not found: ${file}`);
      return;
    }
    const map = serverMap(data);
    if (!map) {
      errors.push(`${file}: expected { "mcpServers": { ... } }`);
      return;
    }
    addAll(scope, file, map);
  };

  if (opts.inline !== undefined) {
    if (isPlainObject(opts.inline)) addAll('settings', 'settings', opts.inline);
    else errors.push('settings: "mcpServers" must be an object');
  }
  for (const scope of MCP_SCOPES) readFile(scope, mcpConfigPath(scope, projectRoot), false);

  for (const extra of opts.extraFiles ?? []) {
    const trimmed = extra.trim();
    if (trimmed.startsWith('{')) {
      try {
        const map = serverMap(JSON.parse(trimmed));
        if (map) addAll('flag', '--mcp-config', map);
        else errors.push('--mcp-config: expected { "mcpServers": { ... } }');
      } catch (err) {
        errors.push(`--mcp-config is not valid JSON: ${(err as Error).message}`);
      }
    } else {
      readFile('flag', path.resolve(projectRoot, trimmed), true);
    }
  }

  return { servers: [...byName.values()], errors };
}

function readScopeFile(file: string): Record<string, unknown> {
  try {
    const data = readJsonFile<unknown>(file);
    return isPlainObject(data) ? data : {};
  } catch {
    return {};
  }
}

function writeServer(scope: McpScope, projectRoot: string, name: string, definition: unknown): string {
  const file = mcpConfigPath(scope, projectRoot);
  const data = readScopeFile(file);
  const servers = isPlainObject(data.mcpServers) ? data.mcpServers : {};
  servers[name] = definition;
  data.mcpServers = servers;
  writeJsonFile(file, data);
  return file;
}

/** Add or replace a server in the given scope's file. Returns the file written. */
export function addMcpServer(scope: McpScope, projectRoot: string, name: string, config: McpServerConfig): string {
  return writeServer(scope, projectRoot, name, config);
}

/**
 * `mcp add-json`: add or replace a server from a JSON definition such as
 * `{"type":"http","url":"https://example.com/mcp"}`. The definition is checked
 * with normalizeMcpConfig but written as given, so `${VAR}` references stay
 * references instead of being baked into the file. Never throws.
 */
export function addMcpServerJson(scope: McpScope, projectRoot: string, name: string, json: string): { file?: string; error?: string } {
  const serverName = typeof name === 'string' ? name.trim() : '';
  if (!serverName) return { error: 'A server name is required.' };
  if (!MCP_SCOPES.includes(scope)) return { error: `Unknown scope "${String(scope)}" (expected user, project or local).` };
  let raw: unknown;
  try {
    raw = JSON.parse(String(json));
  } catch (err) {
    return { error: `Invalid JSON: ${(err as Error).message}` };
  }
  const { config, error } = normalizeMcpConfig(raw);
  if (!config) return { error: `Invalid MCP server definition: ${error ?? 'unknown problem'}` };
  try {
    return { file: writeServer(scope, projectRoot, serverName, raw) };
  } catch (err) {
    return { error: `Could not write ${mcpConfigPath(scope, projectRoot)}: ${(err as Error).message}` };
  }
}

/**
 * Remove a server. Without a scope, the most specific file that defines it is
 * used (local, then project, then user). Returns the scope it was removed from.
 */
export function removeMcpServer(projectRoot: string, name: string, scope?: McpScope): McpScope | undefined {
  const order: McpScope[] = scope ? [scope] : ['local', 'project', 'user'];
  for (const s of order) {
    const file = mcpConfigPath(s, projectRoot);
    const data = readScopeFile(file);
    if (!isPlainObject(data.mcpServers) || !(name in data.mcpServers)) continue;
    delete data.mcpServers[name];
    writeJsonFile(file, data);
    return s;
  }
  return undefined;
}
