/**
 * Deferred tool loading ("tool search"). Every tool definition costs context
 * on each request, and a few MCP servers can bring hundreds. When their
 * definitions would take more than a share of the context window they are
 * held back: the model sees their names in the system prompt and loads the
 * ones it needs with the ToolSearch tool. Pure logic, no I/O.
 */
import { toolSpecTokens } from '../agent/tokens.ts';
import type { Tool, ToolResult } from './types.ts';
import { errorResult } from './types.ts';

export interface DeferralState {
  /** Names of deferred tools the model has loaded this session. */
  loaded: Set<string>;
}

export interface DeferralOptions {
  /** Context window of the current model, in tokens. */
  contextWindow: number;
  /** Share of the window the MCP tool definitions may take before they are deferred. Default 10. */
  thresholdPercent?: number;
  /** Tools that must stay loaded whatever their cost. */
  alwaysLoad?: (tool: Tool) => boolean;
  state: DeferralState;
}

export const DEFAULT_DEFER_THRESHOLD_PERCENT = 10;

const MCP_PREFIX = 'mcp__';
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;
const NAMES_WHEN_NO_MATCH = 20;
const DESCRIPTION_CHARS = 200;
const LISTING_CHARS = 1500;
/** Room kept inside LISTING_CHARS for the line that says how many names were left out. */
const OMITTED_NOTE_CHARS = 70;
/** Query words that say nothing about which tool is wanted. */
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'and', 'or', 'with', 'mcp', 'tool', 'tools']);

/**
 * Read an ENABLE_TOOL_SEARCH value. Returns the threshold percent to pass to
 * planDeferral, or null when tool search is switched off.
 * Unset or `auto` is 10, `auto:N` is N, `true` defers MCP tools always (0), `false` never.
 */
export function toolSearchThreshold(value: string | undefined): number | null {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'auto') return DEFAULT_DEFER_THRESHOLD_PERCENT;
  if (v === 'false' || v === '0' || v === 'off' || v === 'no') return null;
  if (v === 'true' || v === '1' || v === 'on' || v === 'yes') return 0;
  const custom = /^auto:\s*(\d+(?:\.\d+)?)$/.exec(v);
  if (custom) return Math.min(100, Number(custom[1]));
  return DEFAULT_DEFER_THRESHOLD_PERCENT;
}

/**
 * Split the tools into those sent to the model in full and those deferred.
 * Only MCP tools can be deferred. While all of them together fit within the
 * threshold nothing is; beyond it every one is, except those the model has
 * loaded and those `alwaysLoad` keeps.
 */
export function planDeferral(tools: Tool[], opts: DeferralOptions): { active: Tool[]; deferred: Tool[] } {
  const candidates = tools.filter((t) => t.name.startsWith(MCP_PREFIX));
  const window = Number(opts.contextWindow);
  if (candidates.length === 0 || !Number.isFinite(window) || window <= 0) return { active: [...tools], deferred: [] };

  const percent = typeof opts.thresholdPercent === 'number' && opts.thresholdPercent >= 0 ? opts.thresholdPercent : DEFAULT_DEFER_THRESHOLD_PERCENT;
  if (toolSpecTokens(candidates) <= (window * percent) / 100) return { active: [...tools], deferred: [] };

  const active: Tool[] = [];
  const deferred: Tool[] = [];
  for (const tool of tools) {
    const keep = !tool.name.startsWith(MCP_PREFIX) || opts.state.loaded.has(tool.name) || opts.alwaysLoad?.(tool) === true;
    (keep ? active : deferred).push(tool);
  }
  return { active, deferred };
}

function compareNames(a: Tool, b: Tool): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** mcp__<server>__<tool> split at the first separator after the prefix. */
function splitName(name: string): { server: string; tool: string } {
  if (name.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length);
    const sep = rest.indexOf('__');
    if (sep > 0 && sep + 2 < rest.length) return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
  }
  return { server: '', tool: name };
}

/** Lower case, with spaces and hyphens folded into the underscores tool names use. */
function fold(text: string): string {
  return text.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function queryWords(query: string): string[] {
  const all = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
  const telling = all.filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return telling.length ? telling : all;
}

/**
 * Deferred tools that match the query, best first: the exact name, then names
 * containing the query, then tools whose name or description has every query
 * word, then those with any of them. Ties go by name.
 */
function rank(tools: Tool[], query: string): Tool[] {
  const folded = fold(query);
  const words = queryWords(query);
  const hits: { tool: Tool; tier: number }[] = [];
  for (const tool of tools) {
    const name = fold(tool.name);
    let tier: number;
    if (name === folded || fold(splitName(tool.name).tool) === folded) tier = 0;
    else if (folded && name.includes(folded)) tier = 1;
    else {
      const text = `${tool.name} ${tool.description}`.toLowerCase();
      const found = words.filter((w) => text.includes(w)).length;
      if (found === 0) continue;
      tier = found === words.length ? 2 : 3;
    }
    hits.push({ tool, tier });
  }
  hits.sort((a, b) => a.tier - b.tier || compareNames(a.tool, b.tool));
  return hits.map((h) => h.tool);
}

/** Find the tool a `select:` entry names: the full name, or an unambiguous `<tool>` / `<server>__<tool>` ending. */
function selectOne(tools: Tool[], wanted: string): Tool | undefined {
  const exact = tools.find((t) => t.name === wanted) ?? tools.find((t) => t.name.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;
  const ending = `__${wanted.toLowerCase()}`;
  const partial = tools.filter((t) => t.name.toLowerCase().endsWith(ending));
  return partial.length === 1 ? partial[0] : undefined;
}

function brief(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}${String.fromCodePoint(0x2026)}` : flat;
}

function someNames(tools: Tool[]): string {
  const shown = tools.slice(0, NAMES_WHEN_NO_MATCH).map((t) => t.name);
  const more = tools.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` (and ${more} more)` : ''}`;
}

interface ToolSearchInput {
  query: string;
  max_results?: number;
}

/**
 * The ToolSearch tool. `getDeferred` returns the tools currently held back;
 * the names it loads are added to `state.loaded`, so the next planDeferral
 * with the same state makes them active.
 */
export function toolSearchTool(getDeferred: () => Tool[], state: DeferralState): Tool<ToolSearchInput> {
  return {
    name: 'ToolSearch',
    description:
      'Load tools that are listed by name only, so you can call them. Search by keywords, or use "select:name1,name2" for exact names. ' +
      'Loaded tools can be called from your next message on.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, or "select:<name>,<name>" for exact tool names' },
        max_results: { type: 'number', description: 'How many tools to load at most (default 5)' },
      },
      required: ['query'],
    },
    isReadOnly: () => true,
    label: (input) => brief(typeof input.query === 'string' ? input.query : '', 80),
    async execute(input): Promise<ToolResult> {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) return errorResult('Give a query: keywords describing the tool, or "select:<name>" for an exact name.');
      let deferred: Tool[];
      try {
        deferred = getDeferred();
      } catch (err) {
        return errorResult(`Could not look up the tools: ${(err as Error).message || String(err)}`);
      }
      if (deferred.length === 0) return { content: 'No tools are waiting to be loaded: every tool is already available to call.', summary: 'Nothing to load' };

      const chosen: Tool[] = [];
      const notes: string[] = [];
      const select = /^select\s*:/i.exec(query);
      if (select) {
        const already: string[] = [];
        const unknown: string[] = [];
        // Tool names contain no spaces, so names separated by spaces instead of commas are understood too.
        for (const wanted of query.slice(select[0].length).split(/[,\s]+/).filter(Boolean)) {
          const tool = selectOne(deferred, wanted);
          if (tool) {
            if (!chosen.includes(tool)) chosen.push(tool);
          } else if (state.loaded.has(wanted)) already.push(wanted);
          else unknown.push(wanted);
        }
        if (already.length) notes.push(`Already available: ${already.join(', ')}.`);
        if (unknown.length) notes.push(`No tool named ${unknown.join(', ')}.`);
      } else {
        const wanted = Number(input.max_results);
        const limit = Number.isFinite(wanted) && wanted >= 1 ? Math.min(MAX_RESULTS, Math.floor(wanted)) : DEFAULT_RESULTS;
        chosen.push(...rank(deferred, query).slice(0, limit));
      }

      if (chosen.length === 0) {
        const head = select ? notes.join(' ') || 'No tool names followed "select:".' : `No tools matched "${brief(query, 80)}".`;
        return {
          content: `${head} Tools that can be loaded: ${someNames(deferred)}. Search with other words, or load one with "select:<name>".`,
          summary: 'No match',
        };
      }

      for (const tool of chosen) state.loaded.add(tool.name);
      const lines = chosen.map((tool) => {
        const description = brief(tool.description, DESCRIPTION_CHARS);
        return description ? `${tool.name}: ${description}` : tool.name;
      });
      const closing = chosen.length === 1 ? 'This tool is now available to call.' : 'These tools are now available to call.';
      return {
        content: [...lines, [closing, ...notes].join(' ')].join('\n'),
        summary: `Loaded ${chosen.length} tool${chosen.length === 1 ? '' : 's'}`,
      };
    },
  };
}

/**
 * The system-prompt section that tells the model which tools exist but are not
 * loaded: tool names grouped by server, cut off at about 1,500 characters.
 * Empty when nothing is deferred.
 */
export function deferredListing(deferred: Tool[]): string {
  if (deferred.length === 0) return '';

  const groups = new Map<string, string[]>();
  for (const tool of deferred) {
    const { server, tool: short } = splitName(tool.name);
    const names = groups.get(server);
    if (names) names.push(short);
    else groups.set(server, [short]);
  }

  const count = deferred.length;
  const head = `# More tools\n${count} more tool${count === 1 ? ' is' : 's are'} available but not loaded, listed by server. Full names are mcp__<server>__<tool>.`;
  const closing = 'Before using any of them, call ToolSearch with keywords or "select:<full name>" to load it.';

  let room = LISTING_CHARS - head.length - closing.length - OMITTED_NOTE_CHARS;
  let shown = 0;
  let full = false;
  const lines: string[] = [];
  for (const [server, names] of groups) {
    let line = '';
    for (const name of names) {
      // +1 for the newline that starts a server's line.
      const piece = line ? `, ${name}` : `- ${server ? `${server}: ` : ''}${name}`;
      const cost = piece.length + (line ? 0 : 1);
      if (cost > room) {
        full = true;
        break;
      }
      line += piece;
      room -= cost;
      shown++;
    }
    if (line) lines.push(line);
    if (full) break;
  }

  const omitted = count - shown;
  if (omitted > 0) lines.push(`(${omitted} more not listed here; ToolSearch finds them by keyword.)`);
  return [head, ...lines, closing].join('\n');
}
