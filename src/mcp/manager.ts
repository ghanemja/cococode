import type { ImagePart, JsonSchema } from '../types.ts';
import { clampOutput } from '../tools/shell.ts';
import type { Tool, ToolContext, ToolResult } from '../tools/types.ts';
import { McpClient, type McpCallResult, type McpContentBlock, type McpPromptInfo, type McpToolInfo } from './client.ts';
import type { McpServerConfig, ScopedMcpServer } from './config.ts';

export interface McpServerStatus {
  name: string;
  scope: string;
  config: McpServerConfig;
  status: 'pending' | 'connected' | 'failed';
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
  /** Timeout for tool calls and other requests. */
  requestTimeoutMs?: number;
  clientVersion?: string;
  /** Working directory for stdio servers that do not set one. */
  cwd?: string;
}

interface Entry {
  server: ScopedMcpServer;
  client?: McpClient;
  status: McpServerStatus['status'];
  error?: string;
  tools: McpToolInfo[];
  prompts: McpPromptInfo[];
  instructions?: string;
  /** True once the server has connected at least once; lets a tool call retry after a crash. */
  everConnected: boolean;
  /** In-flight connect, shared so concurrent callers do not spawn the server twice. */
  connecting?: Promise<void>;
}

const MAX_DESCRIPTION = 1024;

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

  constructor(servers: ScopedMcpServer[], opts: McpManagerOptions = {}) {
    this.opts = opts;
    this.entries = servers.map((server) => ({
      server,
      status: 'pending',
      tools: [],
      prompts: [],
      everConnected: false,
    }));
  }

  /** Connect to every server in parallel. Failures are recorded, never thrown. */
  async connectAll(): Promise<void> {
    await Promise.all(this.entries.map((entry) => this.connectEntry(entry)));
  }

  private connectEntry(entry: Entry): Promise<void> {
    if (entry.connecting) return entry.connecting;
    const attempt = this.doConnect(entry).finally(() => {
      entry.connecting = undefined;
    });
    entry.connecting = attempt;
    return attempt;
  }

  private async doConnect(entry: Entry): Promise<void> {
    const previous = entry.client;
    entry.client = undefined;
    if (previous) await previous.close().catch(() => {});

    entry.status = 'pending';
    entry.error = undefined;

    const client: McpClient = new McpClient(entry.server.name, entry.server.config, {
      connectTimeoutMs: this.opts.connectTimeoutMs,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      clientVersion: this.opts.clientVersion,
      cwd: this.opts.cwd,
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

    try {
      await client.connect();
      entry.client = client;
      entry.tools = await client.listTools();
      entry.prompts = await client.listPrompts().catch(() => []);
      entry.instructions = client.instructions;
      // The connection may have dropped while listing; onClose already recorded why.
      if (client.connected) {
        entry.status = 'connected';
        entry.everConnected = true;
      } else if ((entry.status as McpServerStatus['status']) !== 'failed') {
        // onClose (above) normally sets this; the cast undoes TS narrowing from the assignment earlier.
        entry.status = 'failed';
        entry.error = 'Connection closed';
      }
    } catch (err) {
      entry.status = 'failed';
      entry.error = (err as Error).message || String(err);
      entry.tools = [];
      entry.prompts = [];
      entry.client = undefined;
      await client.close().catch(() => {});
    }
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

  /** Tools of every connected server, named mcp__<server>__<tool>. */
  tools(): Tool[] {
    const tools: Tool[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (entry.status !== 'connected') continue;
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
      description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
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
      // A server that crashed after working once gets one automatic restart.
      if (!entry.client?.connected && entry.everConnected) await this.connectEntry(entry);
      const client = entry.client;
      if (!client?.connected) {
        return {
          content: `MCP server "${server}" is not connected${entry.error ? `: ${entry.error}` : ''}`,
          isError: true,
        };
      }
      const result = await client.callTool(tool, args, ctx.signal);
      return toToolResult(result, ctx.settings.maxToolOutputChars ?? 30_000);
    } catch (err) {
      const error = err as Error;
      const message = error.name === 'AbortError' ? 'Tool call was cancelled.' : error.message || String(err);
      return { content: `MCP tool ${server}/${tool} failed: ${message}`, isError: true };
    }
  }

  prompts(): McpPrompt[] {
    const out: McpPrompt[] = [];
    for (const entry of this.entries) {
      if (entry.status !== 'connected') continue;
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

  private connectedClient(server: string): McpClient {
    const entry = this.entries.find((e) => e.server.name === server);
    if (!entry) throw new Error(`Unknown MCP server "${server}"`);
    if (!entry.client?.connected) {
      throw new Error(`MCP server "${server}" is not connected${entry.error ? `: ${entry.error}` : ''}`);
    }
    return entry.client;
  }

  /** Fetch a prompt and flatten its messages to plain text. */
  async getPrompt(server: string, name: string, args: Record<string, string>): Promise<string> {
    const result = await this.connectedClient(server).getPrompt(name, args);
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    return messages
      .map((m) => flattenContent(m?.content))
      .filter(Boolean)
      .join('\n\n');
  }

  async listResources(): Promise<McpResource[]> {
    const lists = await Promise.all(
      this.entries.map(async (entry): Promise<McpResource[]> => {
        if (entry.status !== 'connected' || !entry.client) return [];
        try {
          const resources = await entry.client.listResources();
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

  async readResource(server: string, uri: string): Promise<string> {
    const contents = await this.connectedClient(server).readResource(uri);
    return contents
      .map((c) => (typeof c.text === 'string' ? c.text : `[binary resource: ${c.uri}${c.mimeType ? ` (${c.mimeType})` : ''}]`))
      .join('\n');
  }

  /** Drop and re-establish one server's connection. The outcome is reflected in status(). */
  async reconnect(name: string): Promise<void> {
    const entry = this.entries.find((e) => e.server.name === name);
    if (!entry) throw new Error(`Unknown MCP server "${name}"`);
    if (entry.connecting) await entry.connecting.catch(() => {});
    await this.connectEntry(entry);
  }

  async close(): Promise<void> {
    await Promise.all(
      this.entries.map(async (entry) => {
        const client = entry.client;
        entry.client = undefined;
        if (entry.status === 'connected') entry.status = 'pending';
        if (client) await client.close().catch(() => {});
      }),
    );
  }
}
