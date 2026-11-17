import type { ImagePart, JsonSchema } from '../types.ts';
import { clampOutput } from '../tools/shell.ts';
import type { Tool, ToolContext, ToolResult } from '../tools/types.ts';
import { MCP_TIMEOUT_CODE, McpClient, McpError, type McpCallResult, type McpContentBlock, type McpPromptInfo, type McpToolInfo } from './client.ts';
import type { McpServerConfig, ScopedMcpServer } from './config.ts';

export interface McpServerStatus {
  name: string;
  scope: string;
  config: McpServerConfig;
  /** `disabled` servers are configured but switched off: not connected, no tools. */
  status: 'pending' | 'connected' | 'failed' | 'disabled';
  error?: string;
  toolCount: number;
  instructions?: string;
}

export interface McpPrompt {
  server: string;
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpResource {
  server: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpManagerOptions {
  connectTimeoutMs?: number;
  /**
   * Timeout for tool calls and other requests. Unset, MCP_TOOL_TIMEOUT applies, then (for tool
   * calls) the server's `timeout` field, then 30 minutes for stdio and 5 minutes for http/sse.
   */
  requestTimeoutMs?: number;
  clientVersion?: string;
  /** The project directory: working directory for stdio servers that set none, and the root offered through roots/list. */
  cwd?: string;
  /** Names of servers that start switched off. setEnabled(name, true) connects them later. */
  disabled?: string[];
  /** Waits out the backoff between connection attempts. Tests inject one that returns at once. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface Entry {
  server: ScopedMcpServer;
  client?: McpClient;
  status: McpServerStatus['status'];
  error?: string;
  tools: McpToolInfo[];
  prompts: McpPromptInfo[];
  instructions?: string;
  /** Whether the server advertised the resources capability when it last connected. */
  resources: boolean;
  /** True once the server has connected at least once; lets a later use bring a dropped connection back. */
  everConnected: boolean;
  /** In-flight connect (with its retries), shared so concurrent callers do not spawn the server twice. */
  connecting?: Promise<void>;
  /** Aborted to stop the in-flight connect: on close, disable, or a manual reconnect. */
  cancel?: AbortController;
  /** The client whose handshake is in flight, so it can be closed early. */
  attempt?: McpClient;
  /** Automatic reconnection attempts since the last request that succeeded. */
  reconnects: number;
  /** Set when automatic reconnection stopped; only reconnect() or setEnabled() clears it. */
  gaveUp: boolean;
}

type ConnectMode = 'once' | 'first' | 'revive';

export const DEFAULT_MAX_MCP_DESCRIPTION = 4096;
/** Extra attempts for a remote server that cannot be reached when it is first connected. */
export const FIRST_CONNECT_RETRIES = 3;
const FIRST_CONNECT_BACKOFF_MS = 500;
/** Automatic reconnections of a dropped server before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MS = 1000;
const RECONNECT_BACKOFF_CAP_MS = 30_000;

/** Wait before the next automatic reconnection after `failures` attempts in a row: 1s, 2s, 4s ... capped at 30s. */
export function reconnectDelayMs(failures: number): number {
  if (!(failures > 0)) return 0;
  return Math.min(RECONNECT_BACKOFF_CAP_MS, RECONNECT_BACKOFF_MS * 2 ** Math.min(failures - 1, 30));
}

/**
 * Cut an over-long tool description (default cap 4096 characters, or
 * CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH). The first line says what the tool
 * is for, so it is never cut, even when it alone is longer than the cap.
 */
export function capDescription(description: string, max: number = maxDescriptionLength()): string {
  if (description.length <= max) return description;
  const ellipsis = String.fromCodePoint(0x2026);
  const newline = description.indexOf('\n');
  const firstLine = newline === -1 ? description : description.slice(0, newline);
  if (firstLine.length >= max) return firstLine.length === description.length ? description : `${firstLine.trimEnd()}${ellipsis}`;
  return `${description.slice(0, max - 1)}${ellipsis}`;
}

function maxDescriptionLength(): number {
  const n = Number(process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_MCP_DESCRIPTION;
}

function isRemote(config: McpServerConfig): boolean {
  return 'url' in config;
}

/**
 * Whether a failed connection attempt may succeed if repeated. A server that
 * answered with a refusal (HTTP 4xx, a JSON-RPC error) or used up the whole
 * connect timeout is not asked again.
 */
function worthRetrying(err: unknown): boolean {
  if (!(err instanceof McpError) || err.code === undefined) return true;
  if (err.code === MCP_TIMEOUT_CODE) return false;
  return err.code >= 500 || err.code === 408 || err.code === 429;
}

function abortError(): Error {
  const err = new Error('Request cancelled');
  err.name = 'AbortError';
  return err;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || !(ms > 0)) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Wait for `promise`, but stop waiting (not the work itself) when `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function sanitizeMcpName(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpName(server)}__${sanitizeMcpName(tool)}`;
}

/** Compact one-line rendering of tool arguments for the transcript. */
function compactArgs(input: unknown, max = 80): string {
  if (input === null || typeof input !== 'object') return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    let rendered: string;
    try {
      rendered = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
    } catch {
      rendered = String(value);
    }
    parts.push(`${key}: ${rendered}`);
  }
  const line = parts.join(', ').replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function blockText(block: McpContentBlock): string {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'image':
      return `[image: ${block.mimeType ?? 'unknown type'}]`;
    case 'audio':
      return `[audio: ${block.mimeType ?? 'unknown type'}]`;
    case 'resource': {
      const res = block.resource;
      if (typeof res?.text === 'string') return res.text;
      return `[binary resource: ${res?.uri ?? 'unknown'}${res?.mimeType ? ` (${res.mimeType})` : ''}]`;
    }
    case 'resource_link':
      return `[resource: ${[block.name, block.uri].filter(Boolean).join(' ')}]`;
    default:
      return typeof block.text === 'string' ? block.text : `[${block.type} content]`;
  }
}

/** Convert an MCP tools/call result into what the agent loop expects. */
export function toToolResult(result: McpCallResult | undefined, maxChars: number): ToolResult {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const images: ImagePart[] = [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'image' && typeof block.data === 'string') {
      images.push({ type: 'image', mediaType: block.mimeType ?? 'image/png', data: block.data });
    }
    const text = blockText(block);
    if (text) texts.push(text);
  }

  let content = texts.join('\n');
  if (blocks.length === 0 && result?.structuredContent !== undefined) {
    try {
      content = JSON.stringify(result.structuredContent, null, 2);
    } catch {
      content = String(result.structuredContent);
    }
  }
  if (!content) content = '(no output)';

  const out: ToolResult = { content: clampOutput(content, maxChars) };
  if (result?.isError) out.isError = true;
  if (images.length) out.images = images;
  return out;
}

function flattenContent(content: McpContentBlock | McpContentBlock[] | string | undefined): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) => (b && typeof b === 'object' ? blockText(b) : ''))
    .filter(Boolean)
    .join('\n');
}

/** Owns the connections to every configured MCP server and exposes their tools. */
export class McpManager {
  private entries: Entry[];
  private readonly opts: McpManagerOptions;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(servers: ScopedMcpServer[], opts: McpManagerOptions = {}) {
    this.opts = opts;
    this.sleep = opts.sleep ?? defaultSleep;
    const disabled = new Set(opts.disabled ?? []);
    this.entries = servers.map((server) => ({
      server,
      status: disabled.has(server.name) ? 'disabled' : 'pending',
      tools: [],
      prompts: [],
      resources: false,
      everConnected: false,
      reconnects: 0,
      gaveUp: false,
    }));
  }

  /** Connect to every enabled server in parallel. Failures are recorded, never thrown. */
  async connectAll(): Promise<void> {
    await Promise.all(this.entries.filter((entry) => entry.status !== 'disabled').map((entry) => this.connectEntry(entry, 'first')));
  }

  /**
   * Start connecting, or join the attempt already in flight.
   * `first` retries a remote server that cannot be reached, `revive` brings back
   * a connection that dropped, `once` is a single attempt.
   */
  private connectEntry(entry: Entry, mode: ConnectMode): Promise<void> {
    if (entry.connecting) return entry.connecting;
    const cancel = new AbortController();
    const run = this.runConnect(entry, mode, cancel.signal)
      // doConnect records failures itself; this only shields callers from an injected sleep that throws.
      .catch(() => {})
      .finally(() => {
        if (entry.cancel !== cancel) return;
        entry.connecting = undefined;
        entry.cancel = undefined;
      });
    entry.cancel = cancel;
    entry.connecting = run;
    return run;
  }

  /** Abandon the connect in flight, if any, and wait until it has let go of the entry. */
  private async stopConnecting(entry: Entry): Promise<void> {
    const inflight = entry.connecting;
    const attempt = entry.attempt;
    entry.cancel?.abort();
    entry.connecting = undefined;
    entry.cancel = undefined;
    entry.attempt = undefined;
    if (attempt) await attempt.close().catch(() => {});
    if (inflight) await inflight;
  }

  private async runConnect(entry: Entry, mode: ConnectMode, signal: AbortSignal): Promise<void> {
    if (mode === 'revive') {
      await this.revive(entry, signal);
      return;
    }
    const retries = mode === 'first' && isRemote(entry.server.config) ? FIRST_CONNECT_RETRIES : 0;
    for (let attempt = 0; ; attempt++) {
      const retry = await this.doConnect(entry, signal);
      if (!retry || attempt >= retries || signal.aborted) return;
      await this.sleep(FIRST_CONNECT_BACKOFF_MS * 2 ** attempt, signal);
      if (signal.aborted) return;
    }
  }

  /**
   * Bring back a server that worked earlier in the session. A remote server is
   * retried here with a growing wait; a local one gets one restart per use.
   * Either way, MAX_RECONNECT_ATTEMPTS attempts without a successful request
   * in between end automatic reconnection.
   */
  private async revive(entry: Entry, signal: AbortSignal): Promise<void> {
    const remote = isRemote(entry.server.config);
    for (;;) {
      if (entry.reconnects >= MAX_RECONNECT_ATTEMPTS) {
        this.giveUp(entry);
        return;
      }
      if (remote && entry.reconnects > 0) {
        await this.sleep(reconnectDelayMs(entry.reconnects), signal);
        if (signal.aborted) return;
      }
      entry.reconnects++;
      await this.doConnect(entry, signal);
      if (signal.aborted || entry.status !== 'failed') return;
      if (!remote) {
        if (entry.reconnects >= MAX_RECONNECT_ATTEMPTS) this.giveUp(entry);
        return;
      }
    }
  }

  private giveUp(entry: Entry): void {
    const client = entry.client;
    entry.client = undefined;
    if (client) void client.close().catch(() => {});
    entry.gaveUp = true;
    entry.status = 'failed';
    const last = (entry.error ?? 'Connection lost').replace(/[.\s]+$/, '');
    entry.error = `${last}. Gave up after ${MAX_RECONNECT_ATTEMPTS} reconnection attempts; run /mcp reconnect ${entry.server.name} to try again.`;
  }

  /** One connection attempt. Resolves true when it failed in a way that may pass, so a retry is worthwhile. */
  private async doConnect(entry: Entry, signal: AbortSignal): Promise<boolean> {
    const previous = entry.client;
    entry.client = undefined;
    if (previous) await previous.close().catch(() => {});
    if (signal.aborted) return false;

    entry.status = 'pending';
    entry.error = undefined;

    const client: McpClient = new McpClient(entry.server.name, entry.server.config, {
      connectTimeoutMs: this.opts.connectTimeoutMs,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      clientVersion: this.opts.clientVersion,
      cwd: this.opts.cwd,
      roots: this.opts.cwd ? [this.opts.cwd] : undefined,
      onClose: (error) => {
        if (entry.client !== client) return;
        entry.status = 'failed';
        entry.error = error?.message ?? 'Connection closed';
      },
      onNotification: (method) => {
        if (entry.client !== client) return;
        if (method === 'notifications/tools/list_changed') {
          void client
            .listTools()
            .then((tools) => {
              if (entry.client === client) entry.tools = tools;
            })
            .catch(() => {});
        } else if (method === 'notifications/prompts/list_changed') {
          void client
            .listPrompts()
            .then((prompts) => {
              if (entry.client === client) entry.prompts = prompts;
            })
            .catch(() => {});
        }
      },
    });
    entry.attempt = client;

    try {
      await client.connect();
      if (signal.aborted) throw abortError();
      entry.client = client;
      entry.tools = await client.listTools();
      entry.prompts = await client.listPrompts().catch(() => []);
      if (signal.aborted) throw abortError();
      entry.instructions = client.instructions;
      entry.resources = client.capabilities.resources !== undefined;
      // The connection may have dropped while listing; onClose already recorded why.
      if (client.connected) {
        entry.status = 'connected';
        entry.everConnected = true;
        return false;
      }
      if ((entry.status as McpServerStatus['status']) !== 'failed') {
        // onClose (above) normally sets this; the cast undoes TS narrowing from the assignment earlier.
        entry.status = 'failed';
        entry.error = 'Connection closed';
      }
      return true;
    } catch (err) {
      if (entry.client === client) entry.client = undefined;
      await client.close().catch(() => {});
      // Superseded by close(), setEnabled() or reconnect(): they decide what the entry says now.
      if (signal.aborted) return false;
      entry.status = 'failed';
      entry.error = (err as Error).message || String(err);
      // A server that worked before keeps its last known lists, so its tools stay on offer while it can be revived.
      if (!entry.everConnected) {
        entry.tools = [];
        entry.prompts = [];
      }
      return worthRetrying(err);
    } finally {
      if (entry.attempt === client) entry.attempt = undefined;
    }
  }

  /** A server that connected before and may be reconnected automatically on its next use. */
  private revivable(entry: Entry): boolean {
    return entry.everConnected && !entry.gaveUp && entry.status !== 'disabled';
  }

  /** Whether the server's tools, prompts and resources are on offer: connected, or expected back. */
  private offered(entry: Entry): boolean {
    return entry.status === 'connected' || this.revivable(entry);
  }

  /** The server's client, ready for a request. A connection that worked earlier and dropped is re-established first. */
  private async ready(entry: Entry, signal?: AbortSignal): Promise<McpClient | undefined> {
    if (!entry.client?.connected && this.revivable(entry)) await raceAbort(this.connectEntry(entry, 'revive'), signal);
    return entry.client?.connected ? entry.client : undefined;
  }

  private unavailable(entry: Entry): string {
    const name = entry.server.name;
    if (entry.status === 'disabled') return `MCP server "${name}" is disabled. The user can turn it on with /mcp enable ${name}.`;
    return `MCP server "${name}" is not connected${entry.error ? `: ${entry.error}` : ''}`;
  }

  status(): McpServerStatus[] {
    return this.entries.map((entry) => {
      const status: McpServerStatus = {
        name: entry.server.name,
        scope: entry.server.scope,
        config: entry.server.config,
        status: entry.status,
        toolCount: entry.status === 'connected' ? entry.tools.length : 0,
      };
      if (entry.error) status.error = entry.error;
      if (entry.instructions) status.instructions = entry.instructions;
      return status;
    });
  }

  /**
   * Tools of every connected server, named mcp__<server>__<tool>. A server whose
   * connection dropped keeps its tools listed until reconnection is given up,
   * so that the model's next call can bring it back.
   */
  tools(): Tool[] {
    const tools: Tool[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (!this.offered(entry)) continue;
      for (const info of entry.tools) {
        if (!info || typeof info.name !== 'string') continue;
        const name = mcpToolName(entry.server.name, info.name);
        if (seen.has(name)) continue;
        seen.add(name);
        tools.push(this.makeTool(entry, info, name));
      }
    }
    return tools;
  }

  private makeTool(entry: Entry, info: McpToolInfo, name: string): Tool {
    const server = entry.server.name;
    const description = (info.description ?? info.title ?? info.annotations?.title ?? `${info.name} (${server})`).trim();
    const schema = info.inputSchema && typeof info.inputSchema === 'object' ? info.inputSchema : undefined;
    const parameters: JsonSchema = schema ? { type: 'object', ...(schema as JsonSchema) } : { type: 'object', properties: {} };
    if (parameters.properties === undefined) parameters.properties = {};
    const readOnly = info.annotations?.readOnlyHint === true;

    return {
      name,
      description: capDescription(description),
      parameters,
      isReadOnly: () => readOnly,
      permission: () => ({ tool: name, kind: 'mcp', description: `${server}: ${info.name}` }),
      label: (input: unknown) => compactArgs(input),
      execute: (input: unknown, ctx: ToolContext) => this.execute(entry, info.name, input, ctx),
    };
  }

  private async execute(entry: Entry, tool: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const server = entry.server.name;
    const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    try {
      const client = await this.ready(entry, ctx.signal);
      if (!client) return { content: this.unavailable(entry), isError: true };
      const result = await client.callTool(tool, args, ctx.signal);
      entry.reconnects = 0;
      return toToolResult(result, ctx.settings.maxToolOutputChars ?? 30_000);
    } catch (err) {
      const error = err as Error;
      let message = error.name === 'AbortError' ? 'Tool call was cancelled.' : error.message || String(err);
      if (error instanceof McpError && error.code === MCP_TIMEOUT_CODE) {
        // Without this a model tends to send the identical call again and wait out the same timeout.
        message = `${message.replace(/[.\s]+$/, '')}. The server did not answer in time. Do not repeat the same call unchanged: change the arguments, ask for less, or take another approach.`;
      } else if (error.name !== 'AbortError' && !entry.client?.connected && this.revivable(entry)) {
        message = `${message.replace(/[.\s]+$/, '')}. The connection to this server was lost; the next call to it reconnects first.`;
      }
      return { content: `MCP tool ${server}/${tool} failed: ${message}`, isError: true };
    }
  }

  prompts(): McpPrompt[] {
    const out: McpPrompt[] = [];
    for (const entry of this.entries) {
      if (!this.offered(entry)) continue;
      for (const p of entry.prompts) {
        if (!p || typeof p.name !== 'string') continue;
        const prompt: McpPrompt = { server: entry.server.name, name: p.name };
        if (p.description) prompt.description = p.description;
        if (Array.isArray(p.arguments)) prompt.arguments = p.arguments;
        out.push(prompt);
      }
    }
    return out;
  }

  private entryFor(server: string): Entry {
    const entry = this.entries.find((e) => e.server.name === server);
    if (!entry) throw new Error(`Unknown MCP server "${server}"`);
    return entry;
  }

  /** Run one request against a server, reviving a dropped connection first. Rejects when it is unavailable. */
  private async withClient<T>(server: string, signal: AbortSignal | undefined, run: (client: McpClient) => Promise<T>): Promise<T> {
    const entry = this.entryFor(server);
    const client = await this.ready(entry, signal);
    if (!client) throw new Error(this.unavailable(entry));
    const result = await run(client);
    entry.reconnects = 0;
    return result;
  }

  /** Fetch a prompt and flatten its messages to plain text. */
  async getPrompt(server: string, name: string, args: Record<string, string>): Promise<string> {
    const result = await this.withClient(server, undefined, (client) => client.getPrompt(name, args));
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    return messages
      .map((m) => flattenContent(m?.content))
      .filter(Boolean)
      .join('\n\n');
  }

  /** Servers that advertise the resources capability and are connected (or expected back). */
  resourceServers(): string[] {
    return this.entries.filter((entry) => entry.resources && this.offered(entry)).map((entry) => entry.server.name);
  }

  /**
   * Resources of every server that offers them, or of one server when named.
   * Listing is a use of the server, so a dropped connection is revived first.
   * Never rejects: a server that fails contributes nothing.
   */
  async listResources(server?: string): Promise<McpResource[]> {
    const lists = await Promise.all(
      this.entries.map(async (entry): Promise<McpResource[]> => {
        if (server !== undefined ? entry.server.name !== server : !entry.resources) return [];
        try {
          const client = await this.ready(entry);
          if (!client) return [];
          const resources = await client.listResources();
          entry.reconnects = 0;
          return resources
            .filter((r) => r && typeof r.uri === 'string')
            .map((r) => {
              const res: McpResource = { server: entry.server.name, uri: r.uri };
              if (r.name) res.name = r.name;
              if (r.description) res.description = r.description;
              if (r.mimeType) res.mimeType = r.mimeType;
              return res;
            });
        } catch {
          return [];
        }
      }),
    );
    return lists.flat();
  }

  async readResource(server: string, uri: string, signal?: AbortSignal): Promise<string> {
    const contents = await this.withClient(server, signal, (client) => client.readResource(uri, signal));
    return contents
      .map((c) => (typeof c.text === 'string' ? c.text : `[binary resource: ${c.uri}${c.mimeType ? ` (${c.mimeType})` : ''}]`))
      .join('\n');
  }

  /** Drop and re-establish one server's connection. The outcome is reflected in status(). */
  async reconnect(name: string): Promise<void> {
    const entry = this.entryFor(name);
    if (entry.status === 'disabled') throw new Error(`MCP server "${name}" is disabled. Turn it on with /mcp enable ${name}.`);
    await this.stopConnecting(entry);
    entry.reconnects = 0;
    entry.gaveUp = false;
    await this.connectEntry(entry, 'once');
  }

  /**
   * Switch a server off (close its connection and withdraw its tools) or back
   * on (connect it again). The outcome is reflected in status(). Rejects only
   * for a name that is not configured.
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const entry = this.entryFor(name);
    if (!enabled) {
      entry.status = 'disabled';
      await this.stopConnecting(entry);
      const client = entry.client;
      entry.client = undefined;
      entry.status = 'disabled';
      entry.error = undefined;
      entry.tools = [];
      entry.prompts = [];
      entry.instructions = undefined;
      entry.resources = false;
      entry.everConnected = false;
      entry.reconnects = 0;
      entry.gaveUp = false;
      if (client) await client.close().catch(() => {});
      return;
    }
    if (entry.status !== 'disabled') return;
    entry.status = 'pending';
    await this.connectEntry(entry, 'first');
  }

  async close(): Promise<void> {
    await Promise.all(
      this.entries.map(async (entry) => {
        await this.stopConnecting(entry);
        const client = entry.client;
        entry.client = undefined;
        if (entry.status === 'connected') entry.status = 'pending';
        if (client) await client.close().catch(() => {});
      }),
    );
  }
}
