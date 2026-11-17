import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MIN_SERVER_TIMEOUT_MS, type McpHttpConfig, type McpServerConfig, type McpStdioConfig } from './config.ts';

/**
 * A small Model Context Protocol client: JSON-RPC 2.0 over stdio, Streamable
 * HTTP, or the legacy HTTP+SSE transport. No SDK dependency.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** Tool calls may run long: a local server gets 30 minutes, a remote one 5. */
const DEFAULT_STDIO_TOOL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_REMOTE_TOOL_TIMEOUT_MS = 5 * 60_000;
/** setTimeout fires at once for anything larger. */
const MAX_TIMER_MS = 2_147_483_647;
/** JSON-RPC error code used for requests that ran out of time. */
export const MCP_TIMEOUT_CODE = -32001;
const STDERR_TAIL = 4096;

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  code?: number;
  data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
  [key: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpPromptResult {
  description?: string;
  messages: { role: string; content: McpContentBlock | McpContentBlock[] | string }[];
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpClientOptions {
  /**
   * Timeout for every request, tool calls included. Without it, MCP_TOOL_TIMEOUT applies; failing
   * that, tool calls use the server's `timeout` or a transport default (30 min stdio, 5 min
   * http/sse) and other requests use 60s.
   */
  requestTimeoutMs?: number;
  /** Timeout for starting the transport and for `initialize`. Default 30s (or MCP_TIMEOUT). */
  connectTimeoutMs?: number;
  clientVersion?: string;
  /** Working directory for stdio servers that do not set their own. */
  cwd?: string;
  /** Directories offered to the server through roots/list. None means the capability is not advertised. */
  roots?: string[];
  /** Server notifications such as notifications/tools/list_changed. */
  onNotification?: (method: string, params: unknown) => void;
  /** Called once when an established connection is lost (not on an explicit close()). */
  onClose?: (error?: Error) => void;
}

interface Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;
  start(): Promise<void>;
  /** `signal` scopes the delivery of one request; aborting it drops any stream opened for it. */
  send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  setProtocolVersion?(version: string): void;
  /** Extra context for error messages (e.g. the tail of a child's stderr). */
  detail?(): string;
}

function envTimeout(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

// ---------------------------------------------------------------------------
// Server-sent events

interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Incrementally parse a text/event-stream body. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;

  const takeLine = (final: boolean): string | undefined => {
    const idx = buffer.search(/\r\n|\n|\r/);
    if (idx === -1) {
      if (final && buffer.length) {
        const rest = buffer;
        buffer = '';
        return rest;
      }
      return undefined;
    }
    // A trailing lone \r may be the first half of \r\n; wait for more input.
    if (buffer[idx] === '\r' && idx === buffer.length - 1 && !final) return undefined;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + (buffer.startsWith('\r\n', idx) ? 2 : 1));
    return line;
  };

  const feed = function* (final: boolean): Generator<SseEvent> {
    for (let line = takeLine(final); line !== undefined; line = takeLine(final)) {
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n'), id };
        event = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* feed(false);
    }
    buffer += decoder.decode();
    yield* feed(true);
    if (data.length) yield { event, data: data.join('\n'), id };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // a read was still pending; the stream is being torn down anyway
    }
  }
}

// ---------------------------------------------------------------------------
// stdio transport

class StdioTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;
  private proc?: ChildProcess;
  private stderr = '';
  private exited = false;
  private closing = false;
  private readonly config: McpStdioConfig;
  private readonly defaultCwd?: string;

  constructor(config: McpStdioConfig, defaultCwd?: string) {
    this.config = config;
    this.defaultCwd = defaultCwd;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;
      let proc: ChildProcess;
      try {
        proc = spawn(this.config.command, this.config.args ?? [], {
          cwd: this.config.cwd ?? this.defaultCwd,
          env: { ...process.env, ...this.config.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
          windowsHide: true,
        });
      } catch (err) {
        reject(new McpError(`Failed to start "${this.config.command}": ${(err as Error).message}`));
        return;
      }
      this.proc = proc;

      let buffer = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let message: JsonRpcMessage;
          try {
            message = JSON.parse(line) as JsonRpcMessage;
          } catch {
            continue; // servers sometimes log to stdout; ignore anything that is not JSON
          }
          if (message && typeof message === 'object') this.onmessage?.(message);
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
      });
      // Writing to a dead child raises EPIPE on stdin; the exit handler reports the real cause.
      proc.stdin?.on('error', () => {});

      proc.once('spawn', () => {
        started = true;
        resolve();
      });
      proc.once('error', (err) => {
        this.exited = true;
        const code = (err as NodeJS.ErrnoException).code;
        const message =
          code === 'ENOENT'
            ? `Command not found: ${this.config.command}`
            : `Failed to start "${this.config.command}": ${err.message}`;
        const error = new McpError(message);
        if (!started) reject(error);
        else this.onclose?.(error);
      });
      proc.once('close', (code, signal) => {
        this.exited = true;
        if (!started) return;
        if (this.closing) {
          this.onclose?.();
          return;
        }
        const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
        this.onclose?.(new McpError(`Server process ${how}${this.detail()}`));
      });
    });
  }

  send(message: JsonRpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (!stdin || this.exited || stdin.destroyed || !stdin.writable) {
        reject(new McpError(`Server process is not running${this.detail()}`));
        return;
      }
      stdin.write(JSON.stringify(message) + '\n', (err) => {
        if (err) reject(new McpError(`Failed to write to server: ${err.message}`));
        else resolve();
      });
    });
  }

  detail(): string {
    const tail = this.stderr.trim();
    return tail ? `\n${tail.slice(-1000)}` : '';
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.exited || !this.proc) return Promise.resolve(true);
    const proc = this.proc;
    return new Promise((resolve) => {
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        proc.off('close', onClose);
        resolve(this.exited);
      }, ms);
      proc.once('close', onClose);
    });
  }

  /** Close stdin and give the server a moment to exit before signalling it. */
  async close(): Promise<void> {
    this.closing = true;
    const proc = this.proc;
    if (!proc || this.exited) return;
    try {
      proc.stdin?.end();
    } catch {
      // already closed
    }
    if (await this.waitExit(500)) return;
    try {
      proc.kill('SIGTERM');
    } catch {
      // already gone
    }
    if (await this.waitExit(1500)) return;
    try {
      proc.kill('SIGKILL');
    } catch {
      // already gone
    }
    await this.waitExit(500);
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport

class HttpTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;
  private sessionId?: string;
  private protocolVersion?: string;
  private readonly lifetime = new AbortController();
  private readonly config: McpHttpConfig;

  constructor(config: McpHttpConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    // Nothing to open: every message is its own POST.
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.config.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    return headers;
  }

  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const requestId = message.method !== undefined && message.id !== undefined && message.id !== null ? message.id : undefined;
    const sentSession = this.sessionId;

    let res: Response;
    try {
      res = await fetch(this.config.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(message),
        signal: combined,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      const why = cause?.code ?? cause?.message ?? (err as Error).message;
      const error = new McpError(`Could not reach ${this.config.url}: ${why}`);
      // There is no socket to watch, so an unreachable server is how a dropped connection shows up.
      this.onclose?.(error);
      throw error;
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hint = res.status === 401 || res.status === 403 ? ' (authentication required; set a header in the server config)' : '';
      const detail = body.trim() ? `: ${body.trim().slice(0, 300)}` : '';
      const error = new McpError(`HTTP ${res.status} ${res.statusText}${hint}${detail}`.trim(), res.status);
      // 404 for a session the server issued means it expired or the server restarted: a new handshake is needed.
      if (res.status === 404 && sentSession) this.onclose?.(error);
      throw error;
    }

    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (res.status === 202 || res.status === 204 || !res.body) {
      await res.body?.cancel().catch(() => {});
      return;
    }

    if (type.includes('text/event-stream')) {
      // Do not await: the response (and any server requests) arrive on the stream.
      void this.consume(res.body, requestId);
      return;
    }

    const text = await res.text();
    if (!text.trim()) return;
    if (!type.includes('json')) {
      throw new McpError(`Unexpected response content type "${type || 'unknown'}" from ${this.config.url}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new McpError(`Server returned invalid JSON: ${text.slice(0, 200)}`);
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item && typeof item === 'object') this.onmessage?.(item as JsonRpcMessage);
    }
  }

  private async consume(body: ReadableStream<Uint8Array>, requestId: JsonRpcId | undefined): Promise<void> {
    let answered = requestId === undefined;
    let failure: string | undefined;
    try {
      for await (const event of parseSse(body)) {
        if (event.event && event.event !== 'message') continue;
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(event.data) as JsonRpcMessage;
        } catch {
          continue;
        }
        if (message.id === requestId && message.method === undefined) answered = true;
        this.onmessage?.(message);
      }
    } catch (err) {
      if (isAbortError(err)) return;
      failure = (err as Error).message;
    }
    if (!answered) {
      // Surface a dropped stream as an error for the request that was waiting on it.
      this.onmessage?.({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: `Response stream ended before a result arrived${failure ? `: ${failure}` : ''}` },
      });
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    if (!this.sessionId) return;
    try {
      // Best effort: tell the server it can drop the session.
      await fetch(this.config.url, {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      // servers may not support DELETE
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy HTTP+SSE transport

class SseTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;
  private endpoint?: string;
  private closing = false;
  private readonly lifetime = new AbortController();
  private readonly config: McpHttpConfig;

  constructor(config: McpHttpConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.config.url, {
        headers: { ...this.config.headers, Accept: 'text/event-stream' },
        signal: this.lifetime.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      throw new McpError(`Could not reach ${this.config.url}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new McpError(`HTTP ${res.status} ${res.statusText} opening the event stream`, res.status);
    }

    const body = res.body;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const pump = async () => {
        let failure: Error | undefined;
        try {
          for await (const event of parseSse(body)) {
            if (event.event === 'endpoint') {
              try {
                this.endpoint = new URL(event.data.trim(), this.config.url).toString();
              } catch {
                throw new McpError(`Server sent an invalid endpoint: ${event.data}`);
              }
              ready = true;
              resolve();
            } else if (!event.event || event.event === 'message') {
              try {
                this.onmessage?.(JSON.parse(event.data) as JsonRpcMessage);
              } catch {
                // ignore malformed events
              }
            }
          }
        } catch (err) {
          if (!isAbortError(err)) failure = err as Error;
        }
        if (!ready) reject(failure ?? new McpError('Event stream closed before the server announced an endpoint'));
        else if (!this.closing) this.onclose?.(failure ?? new McpError('Event stream closed by the server'));
      };
      void pump();
    });
  }

  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (!this.endpoint) throw new McpError('Not connected');
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { ...this.config.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: combined,
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throw new McpError(`HTTP ${res.status} ${res.statusText}${body.trim() ? `: ${body.trim().slice(0, 300)}` : ''}`, res.status);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.lifetime.abort();
  }
}

// ---------------------------------------------------------------------------
// Client

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  settle: () => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class McpClient {
  readonly name: string;
  readonly config: McpServerConfig;
  serverInfo?: { name: string; version?: string; title?: string };
  instructions?: string;
  capabilities: Record<string, unknown> = {};
  /** Version the server agreed to during initialize. */
  protocolVersion?: string;

  private transport?: Transport;
  private pending = new Map<JsonRpcId, Pending>();
  private nextId = 1;
  private isConnected = false;
  private closed = false;
  private closeError?: Error;
  private readonly opts: McpClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  /** Timeout applied to tools/call: option, then MCP_TOOL_TIMEOUT, then the server's `timeout`, then the transport default. */
  readonly toolTimeoutMs: number;
  private readonly roots: { uri: string; name: string }[];

  constructor(name: string, config: McpServerConfig, opts: McpClientOptions = {}) {
    this.name = name;
    this.config = config;
    this.opts = opts;
    const fromEnv = envTimeout('MCP_TOOL_TIMEOUT');
    this.requestTimeoutMs = clampTimer(opts.requestTimeoutMs ?? fromEnv ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.connectTimeoutMs = clampTimer(opts.connectTimeoutMs ?? envTimeout('MCP_TIMEOUT') ?? DEFAULT_CONNECT_TIMEOUT_MS);
    const perServer = typeof config.timeout === 'number' && Number.isFinite(config.timeout) && config.timeout >= MIN_SERVER_TIMEOUT_MS ? config.timeout : undefined;
    const transportDefault = 'url' in config ? DEFAULT_REMOTE_TOOL_TIMEOUT_MS : DEFAULT_STDIO_TOOL_TIMEOUT_MS;
    this.toolTimeoutMs = clampTimer(opts.requestTimeoutMs ?? fromEnv ?? perServer ?? transportDefault);
    this.roots = toRoots(opts.roots);
  }

  get connected(): boolean {
    return this.isConnected;
  }

  private createTransport(): Transport {
    const config = this.config;
    if ('url' in config) return config.type === 'sse' ? new SseTransport(config) : new HttpTransport(config);
    return new StdioTransport(config, this.opts.cwd);
  }

  /** Start the transport and perform the initialize handshake. */
  async connect(): Promise<void> {
    if (this.isConnected) return;
    this.closed = false;
    this.closeError = undefined;
    const transport = this.createTransport();
    this.transport = transport;
    transport.onmessage = (message) => this.handleMessage(message);
    transport.onclose = (error) => this.handleClose(error);

    try {
      await withTimeout(transport.start(), this.connectTimeoutMs, `Timed out starting the server after ${seconds(this.connectTimeoutMs)}`);
      const result = await this.send<{
        protocolVersion?: string;
        capabilities?: Record<string, unknown>;
        serverInfo?: { name: string; version?: string; title?: string };
        instructions?: string;
      }>(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          // listChanged is false: the project directory does not change during a session.
          capabilities: this.roots.length ? { roots: { listChanged: false } } : {},
          clientInfo: { name: 'cococode', version: this.opts.clientVersion ?? '0.1.0' },
        },
        { timeoutMs: this.connectTimeoutMs },
      );
      this.protocolVersion = result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
      this.capabilities = result?.capabilities ?? {};
      this.serverInfo = result?.serverInfo;
      this.instructions = typeof result?.instructions === 'string' && result.instructions.trim() ? result.instructions : undefined;
      transport.setProtocolVersion?.(this.protocolVersion);
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.isConnected = true;
    } catch (err) {
      const detail = transport.detail?.() ?? '';
      this.closed = true;
      this.isConnected = false;
      this.rejectAll(new McpError('Connection failed'));
      await transport.close().catch(() => {});
      const base = err instanceof Error ? err : new Error(String(err));
      if (detail && !base.message.includes(detail.trim().slice(-200))) {
        throw new McpError(base.message + detail, (base as McpError).code);
      }
      throw base;
    }
  }

  /** Send a request and wait for its result. */
  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (!this.isConnected) {
      return Promise.reject(new McpError(`MCP server "${this.name}" is not connected${this.closeError ? `: ${this.closeError.message}` : ''}`));
    }
    return this.send<T>(method, params, options);
  }

  private send<T>(method: string, params: unknown, options: RequestOptions): Promise<T> {
    const transport = this.transport;
    if (!transport || this.closed) return Promise.reject(new McpError(`MCP server "${this.name}" is not connected`));
    if (options.signal?.aborted) return Promise.reject(abortError());

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const delivery = new AbortController();

    return new Promise<T>((resolve, reject) => {
      const cancel = (error: Error, reason: string) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.settle();
        // initialize must not be cancelled; everything else gets a courtesy notification.
        if (method !== 'initialize' && !this.closed) {
          void transport
            .send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } })
            .catch(() => {});
        }
        reject(error);
      };

      const timer = setTimeout(
        () => cancel(new McpError(`Request timed out after ${seconds(timeoutMs)}: ${method}`, MCP_TIMEOUT_CODE), 'timeout'),
        timeoutMs,
      );
      const onAbort = () => cancel(abortError(), 'cancelled by user');
      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        settle: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          delivery.abort();
        },
      });

      const message: JsonRpcMessage = { jsonrpc: '2.0', id, method };
      if (params !== undefined) message.params = params;
      transport.send(message, delivery.signal).catch((err: unknown) => {
        const entry = this.pending.get(id);
        if (!entry) return; // already answered, timed out or cancelled
        this.pending.delete(id);
        entry.settle();
        reject(err instanceof Error ? err : new McpError(String(err)));
      });
    });
  }

  /** Send a notification (no response expected). */
  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.transport || this.closed) throw new McpError(`MCP server "${this.name}" is not connected`);
    const message: JsonRpcMessage = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    await this.transport.send(message);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (!message || typeof message !== 'object') return;

    if (message.method !== undefined) {
      if (message.id !== undefined && message.id !== null) {
        // Server-initiated request. We implement ping, and roots/list when roots were offered.
        let reply: JsonRpcMessage;
        if (message.method === 'ping') reply = { jsonrpc: '2.0', id: message.id, result: {} };
        else if (message.method === 'roots/list' && this.roots.length) reply = { jsonrpc: '2.0', id: message.id, result: { roots: this.roots } };
        else reply = { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
        void this.transport?.send(reply).catch(() => {});
      } else {
        try {
          this.opts.onNotification?.(message.method, message.params);
        } catch {
          // a listener must not break the connection
        }
      }
      return;
    }

    if (message.id === undefined || message.id === null) return;
    const entry = this.pending.get(message.id);
    if (!entry) return; // late reply to a cancelled or timed-out request
    this.pending.delete(message.id);
    entry.settle();
    if (message.error) {
      entry.reject(new McpError(message.error.message || `Request failed: ${entry.method}`, message.error.code, message.error.data));
    } else {
      entry.resolve(message.result);
    }
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    const wasConnected = this.isConnected;
    this.closed = true;
    this.isConnected = false;
    this.closeError = error ?? new McpError('Connection closed');
    this.rejectAll(this.closeError);
    if (wasConnected) this.opts.onClose?.(error);
  }

  private rejectAll(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.settle();
      entry.reject(error);
    }
  }

  private async paginate<T>(method: string, key: string, options?: RequestOptions): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const result = await this.request<Record<string, unknown>>(method, cursor ? { cursor } : {}, options);
      const batch = result?.[key];
      if (Array.isArray(batch)) items.push(...(batch as T[]));
      const next = result?.nextCursor;
      if (typeof next !== 'string' || !next) break;
      cursor = next;
    }
    return items;
  }

  /** List with pagination; a server that does not implement the method yields an empty list. */
  private async listOptional<T>(capability: string, method: string, key: string): Promise<T[]> {
    if (this.capabilities[capability] === undefined) return [];
    try {
      return await this.paginate<T>(method, key);
    } catch (err) {
      if (err instanceof McpError && err.code === -32601) return [];
      throw err;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    try {
      return await this.paginate<McpToolInfo>('tools/list', 'tools');
    } catch (err) {
      if (err instanceof McpError && err.code === -32601) return [];
      throw err;
    }
  }

  callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpCallResult> {
    return this.request<McpCallResult>('tools/call', { name, arguments: args ?? {} }, { signal, timeoutMs: this.toolTimeoutMs });
  }

  listPrompts(): Promise<McpPromptInfo[]> {
    return this.listOptional<McpPromptInfo>('prompts', 'prompts/list', 'prompts');
  }

  getPrompt(name: string, args: Record<string, string> = {}): Promise<McpPromptResult> {
    return this.request<McpPromptResult>('prompts/get', { name, arguments: args });
  }

  listResources(): Promise<McpResourceInfo[]> {
    return this.listOptional<McpResourceInfo>('resources', 'resources/list', 'resources');
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]> {
    const result = await this.request<{ contents?: McpResourceContent[] }>('resources/read', { uri }, { signal });
    return Array.isArray(result?.contents) ? result.contents : [];
  }

  async close(): Promise<void> {
    const transport = this.transport;
    const wasClosed = this.closed;
    this.closed = true;
    this.isConnected = false;
    if (!wasClosed) this.closeError = new McpError('Client closed');
    this.rejectAll(new McpError('Client closed'));
    this.transport = undefined;
    if (transport) await transport.close().catch(() => {});
  }
}

function abortError(): Error {
  const err = new Error('Request cancelled');
  err.name = 'AbortError';
  return err;
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`;
}

function clampTimer(ms: number): number {
  return Math.min(ms, MAX_TIMER_MS);
}

/** Directories as MCP roots (file:// URIs). A path that cannot be converted is left out. */
function toRoots(dirs: string[] | undefined): { uri: string; name: string }[] {
  const roots: { uri: string; name: string }[] = [];
  for (const dir of dirs ?? []) {
    if (typeof dir !== 'string' || !dir) continue;
    try {
      const abs = path.resolve(dir);
      roots.push({ uri: pathToFileURL(abs).href, name: path.basename(abs) || abs });
    } catch {
      // not a usable path
    }
  }
  return roots;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpError(message, MCP_TIMEOUT_CODE)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new McpError(String(err)));
      },
    );
  });
}
