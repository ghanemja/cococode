import { formatBytes, formatCount } from '../ui/ansi.ts';
import { extractTitle, htmlToMarkdown } from '../util/html.ts';
import { looksBinary } from './fsutil.ts';
import { errorResult, type PermissionRequest, type Tool, type ToolContext, type ToolResult } from './types.ts';

export interface WebFetchInput {
  url: string;
  max_length?: number;
  start_index?: number;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; cococode)';
const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_LENGTH = 30_000;

/** Hosts that are plain http in practice: local dev servers. */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    /^10\.\d+\.\d+\.\d+$/.test(h) ||
    /^192\.168\.\d+\.\d+$/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)
  );
}

/**
 * Parse a model-supplied URL. Only http and https are accepted; a bare
 * domain gets https (http for local addresses). Returns an error message
 * string when the URL is unusable.
 */
export function parseFetchUrl(raw: unknown): URL | string {
  const text = String(raw ?? '')
    .trim()
    .replace(/^<|>$/g, '');
  if (!text) return 'url is required.';
  let candidate = text;
  if (!/^https?:\/\//i.test(text)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(file|data|javascript|mailto|about|blob|ftp|tel):/i.test(text)) {
      return `Only http and https URLs can be fetched: ${text}`;
    }
    const host = text.replace(/^\/\//, '').split(/[/?#]/)[0]!.replace(/:\d+$/, '');
    candidate = `${isLocalHost(host) ? 'http' : 'https'}://${text.replace(/^\/\//, '')}`;
  }
  try {
    const url = new URL(candidate);
    if (!url.hostname) return `Invalid URL: ${text}`;
    return url;
  } catch {
    return `Invalid URL: ${text}`;
  }
}

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  /** The URL that was asked for, when a redirect changed it. */
  requestedUrl?: string;
  title?: string;
  /** Converted text of the page. */
  text: string;
  /** Extra line for the header, e.g. that the download was cut short. */
  note?: string;
}

export interface PageSlice {
  /** Header plus the requested range of the text. */
  content: string;
  start: number;
  end: number;
  total: number;
  truncated: boolean;
}

/**
 * Cut the requested window out of a fetched page and put a short header in
 * front of it that tells the model how to ask for the rest.
 */
export function slicePage(page: FetchedPage, startIndex = 0, maxLength = DEFAULT_MAX_LENGTH): PageSlice {
  const total = page.text.length;
  const start = Math.min(total, Math.max(0, Math.floor(Number(startIndex) || 0)));
  const max = Math.max(1, Math.floor(Number(maxLength) || DEFAULT_MAX_LENGTH));
  let end = Math.min(total, start + max);
  if (end < total) {
    // Prefer to stop at a line boundary when one is close.
    const newline = page.text.lastIndexOf('\n', end - 1);
    if (newline >= start + Math.floor(max * 0.8)) end = newline + 1;
  }
  const truncated = end < total;

  const header = [`URL: ${page.url}`];
  if (page.requestedUrl && page.requestedUrl !== page.url) header.push(`Redirected from: ${page.requestedUrl}`);
  if (page.title) header.push(`Title: ${page.title}`);
  header.push(`Length: ${total} characters`);
  if (truncated) {
    header.push(`Showing characters ${start}-${end}. More follows: call WebFetch again with start_index=${end}.`);
  } else if (start > 0) {
    header.push(start >= total ? `start_index ${start} is past the end of the content.` : `Showing characters ${start}-${end} (end of content).`);
  }
  if (page.note) header.push(page.note);

  const body = page.text.slice(start, end);
  return { content: `${header.join('\n')}\n\n${body}`.trimEnd(), start, end, total, truncated };
}

async function readCapped(res: Response, cap: number): Promise<{ bytes: Buffer; capped: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), capped: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - total));
      total = cap;
      capped = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks, total), capped };
}

function decodeBody(bytes: Buffer, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = bytes.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]{0,200}charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function isTextual(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('javascript') ||
    mime.includes('yaml') ||
    mime.includes('toml') ||
    mime === 'application/x-sh' ||
    mime === 'application/x-www-form-urlencoded' ||
    mime === 'application/sql'
  );
}

function describeError(err: unknown, url: string, userAborted: boolean): string {
  if (userAborted) return `Fetch of ${url} was interrupted.`;
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError') return `Timed out after ${TIMEOUT_MS / 1000}s fetching ${url}.`;
  const cause = e?.cause;
  const detail = cause?.code ? `${cause.code}${cause.message ? ` (${cause.message})` : ''}` : (cause?.message ?? e?.message ?? String(err));
  return `Could not fetch ${url}: ${detail}`;
}

export const webFetchTool: Tool<WebFetchInput> = {
  name: 'WebFetch',
  description:
    'Fetch a URL and return its content as text. HTML is converted to Markdown and JSON is pretty-printed. ' +
    'Long pages come back in parts: pass start_index to read further. Only http and https URLs work.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch.' },
      max_length: { type: 'number', description: 'Maximum number of characters to return.' },
      start_index: { type: 'number', description: 'Character offset to start from, for reading a long page in parts.' },
    },
    required: ['url'],
  },

  isReadOnly: () => true,

  permission(input): PermissionRequest | null {
    const url = parseFetchUrl(input.url);
    if (typeof url === 'string') return null; // execute() reports the problem without touching the network
    return { tool: 'WebFetch', kind: 'web', target: `domain:${url.hostname}`, description: `Fetch ${url.href}` };
  },

  label(input): string {
    return String(input.url ?? '');
  },

  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const url = parseFetchUrl(input.url);
    if (typeof url === 'string') return errorResult(url);

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    try {
      const res = await fetch(url, {
        signal,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const finalUrl = res.url || url.href;

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return errorResult(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} fetching ${finalUrl}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      const mime = contentType.split(';')[0]!.trim().toLowerCase();
      const declaredSize = Number(res.headers.get('content-length'));

      if (mime && !isTextual(mime)) {
        await res.body?.cancel().catch(() => undefined);
        const size = Number.isFinite(declaredSize) && declaredSize > 0 ? `, ${formatBytes(declaredSize)}` : '';
        return {
          content: `URL: ${finalUrl}\nThis is ${mime} content${size}, not text, so it is not shown.`,
          summary: `Not text (${mime})`,
        };
      }

      const { bytes, capped } = await readCapped(res, MAX_BODY_BYTES);
      if (!mime && looksBinary(bytes)) {
        return {
          content: `URL: ${finalUrl}\nThis is binary content (${formatBytes(bytes.length)}), so it is not shown.`,
          summary: 'Not text (binary)',
        };
      }

      const body = decodeBody(bytes, contentType);
      const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml' || (!mime && /^\s*<(!doctype html|html[\s>])/i.test(body));
      let text = body;
      let title: string | undefined;
      if (isHtml) {
        title = extractTitle(body);
        text = htmlToMarkdown(body, finalUrl);
      } else if (mime.includes('json')) {
        try {
          text = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          // not valid JSON after all; show it as received
        }
      }

      const maxLength = input.max_length ?? ctx.settings.maxToolOutputChars ?? DEFAULT_MAX_LENGTH;
      const slice = slicePage(
        {
          url: finalUrl,
          requestedUrl: url.href,
          title,
          text,
          note: capped ? `Note: the download was cut off at ${formatBytes(MAX_BODY_BYTES)}.` : undefined,
        },
        input.start_index,
        maxLength,
      );
      const host = new URL(finalUrl).hostname;
      const range = slice.truncated || slice.start > 0 ? ` (${slice.start}-${slice.end} of ${formatCount(slice.total)})` : '';
      return {
        content: slice.content,
        summary: `Fetched ${formatCount(slice.end - slice.start)} characters from ${host}${range}`,
      };
    } catch (err) {
      return errorResult(describeError(err, url.href, ctx.signal.aborted));
    }
  },
};
