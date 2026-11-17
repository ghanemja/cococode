import { plural } from '../ui/ansi.ts';
import { decodeEntities, stripTags } from '../util/html.ts';
import { errorResult, type PermissionRequest, type Tool, type ToolContext, type ToolResult } from './types.ts';

export interface WebSearchInput {
  query: string;
  max_results?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; cococode)';
const TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 8;
const DUCKDUCKGO_URL = 'https://html.duckduckgo.com/html/';

/** DuckDuckGo wraps result links in a redirect; the real URL is the `uddg` parameter. */
function unwrapDuckDuckGoUrl(href: string): string | undefined {
  let raw = decodeEntities(href).trim();
  if (!raw) return undefined;
  if (raw.startsWith('//')) raw = `https:${raw}`;
  else if (raw.startsWith('/')) raw = `https://duckduckgo.com${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) {
    const target = url.searchParams.get('uddg');
    if (!target) return undefined; // ads (y.js) and internal links
    try {
      return new URL(target).href;
    } catch {
      return undefined;
    }
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
}

const RESULT_LINK_RE = /<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
const SNIPPET_RE = /<(a|div|span|td)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** Extract results from DuckDuckGo's HTML-only results page. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const links: { attrs: string; inner: string; start: number; end: number }[] = [];
  RESULT_LINK_RE.lastIndex = 0;
  for (let m = RESULT_LINK_RE.exec(html); m; m = RESULT_LINK_RE.exec(html)) {
    links.push({ attrs: m[1]!, inner: m[2]!, start: m.index, end: m.index + m[0].length });
  }

  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    const href = HREF_RE.exec(link.attrs);
    const url = unwrapDuckDuckGoUrl(href?.[1] ?? href?.[2] ?? '');
    const title = stripTags(link.inner);
    if (!url || !title || seen.has(url)) continue;
    // The snippet sits between this result's link and the next one.
    const between = html.slice(link.end, links[i + 1]?.start ?? html.length);
    const snippet = SNIPPET_RE.exec(between);
    seen.add(url);
    results.push({ title, url, snippet: snippet ? stripTags(snippet[2]!) : '' });
  }
  return results;
}

function normalizeDomain(d: string): string {
  return String(d)
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/^www\./, '')
    .replace(/[/:].*$/, '');
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function asDomainList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? value.split(',') : [];
  return list.map(normalizeDomain).filter(Boolean);
}

/** Keep results on an allowed domain (when any are given) and drop blocked ones. Subdomains match. */
export function filterResults(results: SearchResult[], allowed?: unknown, blocked?: unknown): SearchResult[] {
  const allow = asDomainList(allowed);
  const block = asDomainList(blocked);
  if (allow.length === 0 && block.length === 0) return results;
  return results.filter((r) => {
    let host: string;
    try {
      host = new URL(r.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return false;
    }
    if (block.some((d) => hostMatches(host, d))) return false;
    return allow.length === 0 || allow.some((d) => hostMatches(host, d));
  });
}

export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results found for "${query}".`;
  const lines = [`Search results for "${query}":`, ''];
  results.forEach((r, i) => {
    const title = r.title.replace(/[\[\]]/g, '');
    lines.push(`${i + 1}. [${title}](${r.url})`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

/** Add site: operators so the engine itself narrows the search; results are filtered again afterwards. */
function withSiteOperators(query: string, allowed: string[], blocked: string[]): string {
  let q = query;
  if (allowed.length === 1) q += ` site:${allowed[0]}`;
  else if (allowed.length > 1) q += ` (${allowed.map((d) => `site:${d}`).join(' OR ')})`;
  for (const d of blocked) q += ` -site:${d}`;
  return q;
}

async function getText(url: URL, signal: AbortSignal, accept: string): Promise<{ status: number; ok: boolean; body: string }> {
  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  return { status: res.status, ok: res.ok, body: await res.text() };
}

async function searchDuckDuckGo(query: string, endpoint: string | undefined, signal: AbortSignal): Promise<SearchResult[]> {
  const url = new URL(endpoint || DUCKDUCKGO_URL);
  url.searchParams.set('q', query);
  const res = await getText(url, signal, 'text/html');
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}.`);
  const results = parseDuckDuckGoHtml(res.body);
  if (results.length === 0 && /anomaly|captcha|challenge-form|bots use DuckDuckGo/i.test(res.body)) {
    throw new Error(
      'DuckDuckGo refused the request (bot check or rate limit). Try again later, or point settings.webSearch at a SearXNG instance.',
    );
  }
  return results;
}

async function searchSearxng(query: string, endpoint: string | undefined, signal: AbortSignal): Promise<SearchResult[]> {
  if (!endpoint) throw new Error('settings.webSearch.url must be set to your SearXNG instance, e.g. http://localhost:8888.');
  const url = new URL(endpoint);
  if (!/\/search\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}/search`;
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const res = await getText(url, signal, 'application/json');
  if (!res.ok) {
    const hint = res.status === 403 ? ' Enable the json format under search.formats in the SearXNG settings.' : '';
    throw new Error(`SearXNG returned HTTP ${res.status}.${hint}`);
  }
  let data: { results?: { title?: unknown; url?: unknown; content?: unknown }[] };
  try {
    data = JSON.parse(res.body) as typeof data;
  } catch {
    throw new Error('SearXNG did not return JSON. Enable the json format under search.formats in its settings.');
  }
  const results: SearchResult[] = [];
  for (const r of data.results ?? []) {
    if (typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) continue;
    results.push({
      title: stripTags(String(r.title ?? r.url)) || r.url,
      url: r.url,
      snippet: stripTags(String(r.content ?? '')),
    });
  }
  return results;
}

export const webSearchTool: Tool<WebSearchInput> = {
  name: 'WebSearch',
  description:
    'Search the web and return a list of results with titles, URLs and snippets. ' +
    'Use it for current information or documentation, then WebFetch a result to read it.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      max_results: { type: 'number', description: 'How many results to return (default 8).' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only return results from these domains.' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never return results from these domains.' },
    },
    required: ['query'],
  },

  isReadOnly: () => true,

  permission(input): PermissionRequest {
    return { tool: 'WebSearch', kind: 'web', description: `Search the web for "${String(input.query ?? '').trim()}"` };
  },

  label(input): string {
    return String(input.query ?? '');
  },

  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const query = String(input.query ?? '').trim();
    if (!query) return errorResult('query is required.');
    const requested = Math.floor(Number(input.max_results));
    const maxResults = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 25) : DEFAULT_MAX_RESULTS;
    const allowed = asDomainList(input.allowed_domains);
    const blocked = asDomainList(input.blocked_domains);

    const config = ctx.settings.webSearch ?? {};
    const provider = config.provider ?? 'duckduckgo';
    const fullQuery = withSiteOperators(query, allowed, blocked);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]);

    try {
      const found =
        provider === 'searxng'
          ? await searchSearxng(fullQuery, config.url, signal)
          : await searchDuckDuckGo(fullQuery, config.url, signal);
      const results = filterResults(found, allowed, blocked).slice(0, maxResults);
      return {
        content: formatResults(query, results),
        summary: results.length === 0 ? 'No results' : `Found ${plural(results.length, 'result')}`,
      };
    } catch (err) {
      if (ctx.signal.aborted) return errorResult('Web search was interrupted.');
      const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      if (e?.name === 'TimeoutError') return errorResult(`Web search timed out after ${TIMEOUT_MS / 1000}s.`);
      const detail = e?.cause?.code ?? e?.cause?.message;
      return errorResult(`Web search failed: ${e?.message ?? String(err)}${detail ? ` (${detail})` : ''}`);
    }
  },
};
