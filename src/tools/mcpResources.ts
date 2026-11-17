/** Tools that let the model list and read the resources MCP servers publish. */
import { sanitizeMcpName, type McpManager } from '../mcp/manager.ts';
import { clampOutput } from './shell.ts';
import type { Tool, ToolResult } from './types.ts';
import { errorResult } from './types.ts';

/** The part of McpManager these tools need. */
export type McpResourceSource = Pick<McpManager, 'status' | 'resourceServers' | 'listResources' | 'readResource'>;

interface ListInput {
  server?: string;
}

interface ReadInput {
  server: string;
  uri: string;
}

const MAX_FIELD = 200;

function brief(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_FIELD ? `${flat.slice(0, MAX_FIELD - 1)}${String.fromCodePoint(0x2026)}` : flat;
}

/**
 * Resolve the server a call names, or explain why it cannot be used.
 * The sanitised form seen in tool names (mcp__<server>__...) is accepted too.
 */
function resolveServer(source: McpResourceSource, given: string): { name: string } | { problem: string } {
  const statuses = source.status();
  const usable = source.resourceServers();
  const known = statuses.find((s) => s.name === given) ?? statuses.find((s) => sanitizeMcpName(s.name) === given);
  const hint = usable.length ? ` Servers with resources: ${usable.join(', ')}.` : '';
  if (!known) return { problem: `Unknown MCP server "${given}".${hint}` };
  if (usable.includes(known.name)) return { name: known.name };
  if (known.status === 'connected') return { problem: `MCP server "${known.name}" does not offer resources.${hint}` };
  if (known.status === 'disabled') return { problem: `MCP server "${known.name}" is disabled.${hint}` };
  return { problem: `MCP server "${known.name}" is not connected${known.error ? `: ${known.error}` : '.'}${known.error ? '' : hint}` };
}

function listTool(source: McpResourceSource): Tool<ListInput> {
  return {
    name: 'ListMcpResources',
    description: 'List the resources (documents, data) that MCP servers offer. Read one with ReadMcpResource.',
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', description: 'Only list this server (default: all)' } },
    },
    isReadOnly: () => true,
    label: (input) => (typeof input.server === 'string' ? input.server : ''),
    async execute(input, ctx): Promise<ToolResult> {
      const given = typeof input.server === 'string' ? input.server.trim() : '';
      let server: string | undefined;
      if (given) {
        const resolved = resolveServer(source, given);
        if ('problem' in resolved) return errorResult(resolved.problem);
        server = resolved.name;
      }
      try {
        const resources = await source.listResources(server);
        if (resources.length === 0) {
          return { content: server ? `MCP server "${server}" lists no resources.` : 'No MCP resources are available.', summary: 'No resources' };
        }
        // One JSON object per line: the server and uri go straight into ReadMcpResource.
        const lines = resources.map((r) => {
          const row: Record<string, string> = { server: r.server, uri: r.uri };
          if (r.name) row.name = brief(r.name);
          if (r.description) row.description = brief(r.description);
          if (r.mimeType) row.mimeType = r.mimeType;
          return JSON.stringify(row);
        });
        return {
          content: clampOutput(lines.join('\n'), ctx.settings.maxToolOutputChars ?? 30_000),
          summary: `${resources.length} resource${resources.length === 1 ? '' : 's'}`,
        };
      } catch (err) {
        return errorResult(`Could not list MCP resources: ${(err as Error).message || String(err)}`);
      }
    },
  };
}

function readTool(source: McpResourceSource): Tool<ReadInput> {
  return {
    name: 'ReadMcpResource',
    description: 'Read one MCP resource by server and URI, as listed by ListMcpResources.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Name of the MCP server' },
        uri: { type: 'string', description: 'URI of the resource' },
      },
      required: ['server', 'uri'],
    },
    isReadOnly: () => true,
    label: (input) => (typeof input.uri === 'string' ? input.uri : ''),
    async execute(input, ctx): Promise<ToolResult> {
      const given = typeof input.server === 'string' ? input.server.trim() : '';
      const uri = typeof input.uri === 'string' ? input.uri.trim() : '';
      if (!given || !uri) return errorResult('Give both "server" and "uri". ListMcpResources shows the valid pairs.');
      const resolved = resolveServer(source, given);
      if ('problem' in resolved) return errorResult(resolved.problem);
      try {
        const text = await source.readResource(resolved.name, uri, ctx.signal);
        return {
          content: clampOutput(text || '(the resource is empty)', ctx.settings.maxToolOutputChars ?? 30_000),
          summary: `Read ${uri}`,
        };
      } catch (err) {
        const error = err as Error;
        const why = error.name === 'AbortError' ? 'the read was cancelled' : error.message || String(err);
        return errorResult(`Could not read ${uri} from MCP server "${resolved.name}": ${why}`);
      }
    },
  };
}

/**
 * ListMcpResources and ReadMcpResource, or nothing when no connected server
 * advertises resources, so the tools cost no context when they would be useless.
 * Neither needs permission: they only read what a configured server publishes.
 */
export function mcpResourceTools(manager: McpResourceSource | undefined): Tool[] {
  if (!manager) return [];
  try {
    if (manager.resourceServers().length === 0) return [];
  } catch {
    return [];
  }
  return [listTool(manager), readTool(manager)];
}
