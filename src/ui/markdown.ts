/**
 * Markdown to ANSI, built for streaming.
 *
 * Rendering is line oriented: a source line becomes final as soon as its
 * newline arrives, so finished rows can go straight to scrollback while the
 * model is still writing. Two constructs need lookahead and are held back
 * until they are complete: tables (columns are sized from every row) and a
 * paragraph line that may turn out to be a setext heading or a table header.
 */
import { c, expandTabs, stringWidth, wrapLine } from './ansi.ts';
import { highlightLine, type HighlightState } from './highlight.ts';

export interface MarkdownOptions {
  /** Total row width in columns, including the indent. Read on every render so resizes are picked up. */
  width: () => number;
  /** Prefix for every non-empty row. */
  indent?: string;
}

// ---------------------------------------------------------------------------
// Inline markup
// ---------------------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}]/u;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** For a backtick run at `at`: its length and where the matching closing run starts (-1 if none). */
function codeSpan(src: string, at: number): { run: number; close: number } {
  let run = 1;
  while (src[at + run] === '`') run++;
  let j = at + run;
  while (j < src.length) {
    const k = src.indexOf('`', j);
    if (k < 0) break;
    let r = 1;
    while (src[k + r] === '`') r++;
    if (r === run) return { run, close: k };
    j = k + r;
  }
  return { run, close: -1 };
}

/**
 * Find the closing emphasis delimiter (`len` repetitions of `ch`) for content
 * starting at `from`. Code spans and escapes are skipped.
 */
function findClosing(src: string, from: number, ch: string, len: number): number {
  let j = from;
  while (j < src.length) {
    const cur = src[j]!;
    if (cur === '\\') {
      j += 2;
      continue;
    }
    if (cur === '`') {
      const span = codeSpan(src, j);
      j = span.close < 0 ? j + span.run : span.close + span.run;
      continue;
    }
    if (cur !== ch) {
      j++;
      continue;
    }
    let run = 1;
    while (src[j + run] === ch) run++;
    // A longer run closes inner emphasis first, so the outer delimiter is its tail.
    let pos = -1;
    if (len === 1) pos = run === 1 ? j : run >= 3 ? j + run - 1 : -1;
    else if (len === 2) pos = run >= 2 ? j + run - 2 : -1;
    else pos = run >= 3 ? j : -1;
    if (pos > from) {
      const before = src[j - 1];
      const after = src[pos + len];
      const closes = before !== undefined && !/\s/.test(before) && (ch !== '_' || !isWord(after));
      if (closes) return pos;
    }
    j += run;
  }
  return -1;
}

interface Link {
  label: string;
  url: string;
  end: number;
}

/** Parse `[label](url)` with `src[open] === '['`. */
function parseLink(src: string, open: number): Link | null {
  let depth = 0;
  let close = -1;
  for (let j = open; j < src.length; j++) {
    const ch = src[j]!;
    if (ch === '\\') {
      j++;
    } else if (ch === '`') {
      const span = codeSpan(src, j);
      j = (span.close < 0 ? j + span.run : span.close + span.run) - 1;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        close = j;
        break;
      }
    }
  }
  if (close < 0 || src[close + 1] !== '(') return null;

  let parens = 0;
  let end = -1;
  for (let j = close + 1; j < src.length; j++) {
    const ch = src[j]!;
    if (ch === '\\') {
      j++;
    } else if (ch === '(') {
      parens++;
    } else if (ch === ')') {
      parens--;
      if (parens === 0) {
        end = j;
        break;
      }
    }
  }
  if (end < 0) return null;

  let url = src.slice(close + 2, end).trim();
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(url);
  if (titled) url = titled[1]!;
  if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
  if (/\s/.test(url)) return null;
  return { label: src.slice(open + 1, close), url, end: end + 1 };
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const x of s) if (x === ch) n++;
  return n;
}

/** A bare URL starting at the beginning of `s`, without trailing punctuation that belongs to the sentence. */
function bareUrl(s: string): string | null {
  const m = /^https?:\/\/[^\s<>]+/.exec(s);
  if (!m) return null;
  let url = m[0];
  for (;;) {
    const trimmed = url.replace(/[.,;:!?*_~'"`]+$/, '');
    let next = trimmed;
    if (next.endsWith(')') && count(next, ')') > count(next, '(')) next = next.slice(0, -1);
    else if (next.endsWith(']') && count(next, ']') > count(next, '[')) next = next.slice(0, -1);
    if (next === url) break;
    url = next;
  }
  return url.length > 'https://'.length - 1 ? url : null;
}

/** Delimiter matching is quadratic in the worst case; lines this long are data, not prose. */
const MAX_INLINE_LENGTH = 20_000;

/** Render inline Markdown (emphasis, code spans, links) to ANSI. */
export function renderInline(src: string): string {
  if (src.length > MAX_INLINE_LENGTH) return src;
  let out = '';
  let i = 0;
  const n = src.length;
  // A delimiter with no closer from here has none from any later position
  // either; remembering that keeps a line full of stray markers linear.
  const unclosed = new Set<string>();
  const closing = (from: number, ch: string, len: number): number => {
    const key = ch + len;
    if (unclosed.has(key)) return -1;
    const at = findClosing(src, from, ch, len);
    if (at < 0) unclosed.add(key);
    return at;
  };
  let noMoreLinks = false;
  while (i < n) {
    const ch = src[i]!;

    if (ch === '\\' && i + 1 < n && ESCAPABLE.test(src[i + 1]!)) {
      out += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const span = codeSpan(src, i);
      if (span.close >= 0) {
        let code = src.slice(i + span.run, span.close);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
        out += c.cyan(code);
        i = span.close + span.run;
      } else {
        out += src.slice(i, i + span.run);
        i += span.run;
      }
      continue;
    }

    if (ch === 'h' && !isWord(src[i - 1]) && (src.startsWith('http://', i) || src.startsWith('https://', i))) {
      const url = bareUrl(src.slice(i));
      if (url) {
        out += url;
        i += url.length;
        continue;
      }
    }

    if (!noMoreLinks && (ch === '[' || (ch === '!' && src[i + 1] === '['))) {
      if (src.indexOf('](', i) < 0) noMoreLinks = true;
      const link = noMoreLinks ? null : parseLink(src, ch === '!' ? i + 1 : i);
      if (link) {
        const label = renderInline(link.label);
        const same = link.url === '' || link.label === link.url || `mailto:${link.label}` === link.url;
        out += same ? c.underline(label || link.url) : `${c.underline(label)} ${c.dim(`(${link.url})`)}`;
        i = link.end;
        continue;
      }
    }

    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(src.slice(i));
      if (auto) {
        out += c.underline(auto[1]!);
        i += auto[0].length;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      let run = 1;
      while (src[i + run] === ch) run++;
      const next = src[i + run];
      const canOpen = next !== undefined && !/\s/.test(next) && (ch === '*' || !isWord(src[i - 1]));
      if (canOpen && run <= 3) {
        if (run === 3) {
          const close = closing(i + 3, ch, 3);
          if (close >= 0) {
            out += c.bold(c.italic(renderInline(src.slice(i + 3, close))));
            i = close + 3;
            continue;
          }
        }
        if (run >= 2) {
          const close = closing(i + 2, ch, 2);
          if (close >= 0) {
            out += c.bold(renderInline(src.slice(i + 2, close)));
            i = close + 2;
            continue;
          }
        }
        if (run === 1) {
          const close = closing(i + 1, ch, 1);
          if (close >= 0) {
            out += c.italic(renderInline(src.slice(i + 1, close)));
            i = close + 1;
            continue;
          }
        }
      }
      out += src.slice(i, i + run);
      i += run;
      continue;
    }

    if (ch === '~' && src[i + 1] === '~' && src[i + 2] !== '~' && src[i + 2] !== undefined && !/\s/.test(src[i + 2]!)) {
      const close = src.indexOf('~~', i + 2);
      if (close > i + 2) {
        out += c.strike(renderInline(src.slice(i + 2, close)));
        i = close + 2;
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET = /^(\s*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const SETEXT = /^ {0,3}(=+|-{2,})[ \t]*$/;

/** Text must keep at least this many columns, however deeply it is nested. */
const MIN_TEXT_WIDTH = 16;

function leadWidth(ws: string): number {
  let w = 0;
  for (const ch of ws) w += ch === '\t' ? 4 - (w % 4) : 1;
  return w;
}

/** Leading indentation as spaces, limited so narrow terminals still have room for text. */
function leadSpaces(ws: string, width: number, prefix: string): string {
  const room = Math.max(0, width - stringWidth(prefix) - MIN_TEXT_WIDTH);
  return ' '.repeat(Math.min(leadWidth(ws), room));
}

/** Remove up to `columns` columns of leading whitespace. */
function stripIndent(line: string, columns: number): string {
  let w = 0;
  let i = 0;
  while (i < line.length && w < columns) {
    const ch = line[i];
    if (ch === ' ') w++;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
    i++;
  }
  return line.slice(i);
}

function fenceOpening(src: string): { char: string; len: number; lang: string; indent: number } | null {
  const m = FENCE_OPEN.exec(src);
  if (!m) return null;
  const marker = m[2]!;
  const info = m[3]!;
  // "```code```" on one line is an inline code span, not a fence.
  if (marker[0] === '`' && info.includes('`')) return null;
  const lang = /[A-Za-z0-9_+#.-]+/.exec(info)?.[0]?.toLowerCase() ?? '';
  return { char: marker[0]!, len: marker.length, lang, indent: leadWidth(m[1]!) };
}

/** A line of running text: nothing that starts another kind of block. */
function isParagraph(src: string): boolean {
  return !HEADING.test(src) && !HR.test(src) && !QUOTE.test(src) && !BULLET.test(src) && !ORDERED.test(src);
}

/** Render one non-blank line that is not part of a fence or table. */
function renderLeaf(src: string, width: number, prefix: string): string[] {
  let m = HEADING.exec(src);
  if (m) {
    const text = renderInline((m[2] ?? '').trim());
    if (!text) return [];
    return wrapLine(m[1]!.length === 1 ? c.bold(c.underline(text)) : c.bold(text), width, { indent: prefix });
  }
  if (HR.test(src)) {
    return [prefix + c.dim('─'.repeat(Math.max(1, width - stringWidth(prefix))))];
  }
  m = QUOTE.exec(src);
  if (m) {
    const inner = m[1]!;
    if (inner.trim() === '') return [prefix + c.dim('│')];
    return renderLeaf(inner, width, `${prefix}${c.dim('│')} `);
  }
  m = BULLET.exec(src);
  if (m) {
    const lead = leadSpaces(m[1]!, width, prefix);
    const task = TASK.exec(m[3]!);
    const marker = task ? (task[1] === ' ' ? '☐' : c.green('☑')) : '•';
    return wrapLine(renderInline(task ? task[2]! : m[3]!), width, {
      indent: `${prefix}${lead}${marker} `,
      hangingIndent: `${prefix}${lead}  `,
    });
  }
  m = ORDERED.exec(src);
  if (m) {
    const lead = leadSpaces(m[1]!, width, prefix);
    const marker = m[2]!;
    return wrapLine(renderInline(m[3]!), width, {
      indent: `${prefix}${lead}${marker} `,
      hangingIndent: `${prefix}${lead}${' '.repeat(marker.length + 1)}`,
    });
  }
  const lead = leadSpaces(/^\s*/.exec(src)![0], width, prefix);
  return wrapLine(renderInline(src.trim()), width, { indent: prefix + lead });
}

function renderSetext(text: string, level: number, width: number, prefix: string): string[] {
  const inline = renderInline(text.trim());
  return wrapLine(level === 1 ? c.bold(c.underline(inline)) : c.bold(inline), width, { indent: prefix });
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type Align = 'left' | 'center' | 'right';

function splitCellsWith(line: string, honourCode: boolean): { cells: string[]; openCode: boolean } {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`' && honourCode) {
      inCode = !inCode;
      cur += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return { cells, openCode: inCode };
}

/** Split a table row into cells. Pipes inside a code span stay in the cell. */
function splitCells(line: string): string[] {
  const first = splitCellsWith(line, true);
  // An unbalanced backtick would swallow the rest of the row; split on every pipe instead.
  return first.openCode ? splitCellsWith(line, false).cells : first.cells;
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function isTableRow(line: string): boolean {
  return line.trim() !== '' && line.includes('|');
}

function alignCell(text: string, width: number, align: Align): string {
  const pad = Math.max(0, width - stringWidth(text));
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + text + ' '.repeat(pad - left);
  }
  return text + ' '.repeat(pad);
}

const MIN_COLUMN_WIDTH = 3;
const READABLE_COLUMN_WIDTH = 8;

function renderTable(rows: string[], width: number, indent: string): string[] {
  const header = splitCells(rows[0]!).map(renderInline);
  const cols = header.length;
  const aligns: Align[] = splitCells(rows[1]!).map((cell) =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left',
  );
  const body = rows.slice(2).map((row) => {
    const cells = splitCells(row).map(renderInline);
    while (cells.length < cols) cells.push('');
    // Extra cells would be lost; keep their text in the last column instead.
    if (cells.length > cols) cells.splice(cols - 1, cells.length - cols + 1, cells.slice(cols - 1).join(' │ '));
    return cells;
  });

  const avail = width - stringWidth(indent);
  // Each column costs its content plus " │ "; one more "│" closes the row.
  const budget = avail - (3 * cols + 1);

  /** Too narrow for a grid: list each row as "header: value". */
  const stacked = (): string[] => {
    if (body.length === 0) return wrapLine(header.map((h) => c.bold(h)).join(' · '), width, { indent });
    const out: string[] = [];
    body.forEach((cells, r) => {
      if (r > 0) out.push('');
      cells.forEach((cell, i) => {
        if (cell !== '') out.push(...wrapLine(`${c.bold(header[i]!)}: ${cell}`, width, { indent }));
      });
    });
    return out;
  };
  if (budget < cols * MIN_COLUMN_WIDTH) return stacked();

  let widths = header.map((h, i) => Math.max(1, stringWidth(h), ...body.map((cells) => stringWidth(cells[i]!))));
  const total = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  if (total(widths) > budget) {
    // Shrink the widest columns to a common cap until the table fits.
    let cap = Math.max(...widths);
    while (cap > MIN_COLUMN_WIDTH && total(widths.map((w) => Math.min(w, cap))) > budget) cap--;
    // Columns squeezed to a few characters split every word; a list reads better.
    if (cap < READABLE_COLUMN_WIDTH) return stacked();
    widths = widths.map((w) => Math.min(w, cap));
  }

  const bar = c.dim('│');
  const rule = (left: string, mid: string, right: string) =>
    indent + c.dim(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);
  const renderRow = (cells: string[], bold: boolean): string[] => {
    const wrapped = cells.map((cell, i) => wrapLine(bold ? c.bold(cell) : cell, widths[i]!));
    const height = Math.max(...wrapped.map((w) => w.length));
    const lines: string[] = [];
    for (let r = 0; r < height; r++) {
      const parts = wrapped.map((w, i) => alignCell(w[r] ?? '', widths[i]!, aligns[i] ?? 'left'));
      lines.push(`${indent}${bar} ${parts.join(` ${bar} `)} ${bar}`);
    }
    return lines;
  };

  const bodyRows = body.map((cells) => renderRow(cells, false));
  const separate = bodyRows.some((r) => r.length > 1);
  const out = [rule('┌', '┬', '┐'), ...renderRow(header, true)];
  bodyRows.forEach((lines, r) => {
    if (r === 0 || separate) out.push(rule('├', '┼', '┤'));
    out.push(...lines);
  });
  out.push(rule('└', '┴', '┘'));
  return out;
}

// ---------------------------------------------------------------------------
// Block state machine
// ---------------------------------------------------------------------------

interface Fence {
  char: string;
  len: number;
  lang: string;
  indent: number;
  hl: HighlightState;
}

/** Control characters other than tab would corrupt the display. */
function clean(raw: string): string {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  // eslint-disable-next-line no-control-regex
  return line.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '');
}

class BlockRenderer {
  private readonly width: () => number;
  private readonly indent: string;
  private fence: Fence | null = null;
  /** A paragraph line waiting to learn whether the next line makes it a heading or a table header. */
  private held: string | null = null;
  private table: string[] | null = null;
  /** A blank line was seen; it is printed only if more content follows. */
  private blank = false;
  private started = false;

  constructor(width: () => number, indent: string) {
    this.width = width;
    this.indent = indent;
  }

  clone(): BlockRenderer {
    const copy = new BlockRenderer(this.width, this.indent);
    copy.fence = this.fence ? { ...this.fence } : null;
    copy.held = this.held;
    copy.table = this.table ? [...this.table] : null;
    copy.blank = this.blank;
    copy.started = this.started;
    return copy;
  }

  /** Consume one complete source line; returns the rows that became final. */
  line(raw: string): string[] {
    const out: string[] = [];
    this.consume(clean(raw), out);
    return out;
  }

  /** End of input: render whatever was being held and reset. */
  end(): string[] {
    const out: string[] = [];
    if (this.table) this.emit(out, renderTable(this.table, this.columns(), this.indent));
    if (this.held !== null) this.emit(out, renderLeaf(this.held, this.columns(), this.indent));
    this.table = null;
    this.held = null;
    this.fence = null;
    this.blank = false;
    this.started = false;
    return out;
  }

  private emit(out: string[], rows: string[]): void {
    if (rows.length === 0) return;
    if (this.blank && this.started) out.push('');
    this.blank = false;
    this.started = true;
    for (const row of rows) out.push(row);
  }

  /** The caller's width, made safe: a pipe has no columns and a resize can report zero. */
  private columns(): number {
    const w = Math.floor(this.width());
    return Number.isFinite(w) && w > 0 ? w : 80;
  }

  private consume(src: string, out: string[]): void {
    const width = this.columns();

    if (this.fence) {
      const fence = this.fence;
      const close = FENCE_CLOSE.exec(src);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        this.fence = null;
        return;
      }
      this.emit(out, this.codeLine(src, fence, width));
      return;
    }

    if (this.table) {
      if (isTableRow(src)) {
        this.table.push(src);
        return;
      }
      this.emit(out, renderTable(this.table, width, this.indent));
      this.table = null;
    }

    if (this.held !== null) {
      const held = this.held;
      this.held = null;
      if (held.includes('|') && isDelimiterRow(src) && splitCells(held).length === splitCells(src).length) {
        this.table = [held, src];
        return;
      }
      const underline = SETEXT.exec(src);
      if (underline) {
        this.emit(out, renderSetext(held, underline[1]![0] === '=' ? 1 : 2, width, this.indent));
        return;
      }
      this.emit(out, renderLeaf(held, width, this.indent));
    }

    if (src.trim() === '') {
      if (this.started) this.blank = true;
      return;
    }

    const fence = fenceOpening(src);
    if (fence) {
      this.fence = { ...fence, hl: null };
      return;
    }

    if (isParagraph(src)) {
      this.held = src;
      return;
    }
    this.emit(out, renderLeaf(src, width, this.indent));
  }

  private codeLine(src: string, fence: Fence, width: number): string[] {
    const res = highlightLine(expandTabs(stripIndent(src, fence.indent)), fence.lang, fence.hl);
    fence.hl = res.state;
    if (res.text === '') return [''];
    const nested = ' '.repeat(Math.min(fence.indent, Math.max(0, width - stringWidth(this.indent) - MIN_TEXT_WIDTH)));
    return wrapLine(res.text, width, { indent: `${this.indent}${nested}  `, hard: true });
  }
}

/**
 * Incremental renderer for a streamed message. Feed chunks with `push()` and
 * print what it returns; show `pending()` in a redrawn region; call `flush()`
 * when the message ends. Chunk boundaries never change the output.
 */
export class MarkdownStream {
  private renderer: BlockRenderer;
  private buffer = '';

  constructor(opts: MarkdownOptions) {
    this.renderer = new BlockRenderer(opts.width, opts.indent ?? '');
  }

  /** Feed a streamed chunk. Returns rendered rows that are complete and final. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let start = 0;
    for (let nl = this.buffer.indexOf('\n', start); nl >= 0; nl = this.buffer.indexOf('\n', start)) {
      for (const row of this.renderer.line(this.buffer.slice(start, nl))) out.push(row);
      start = nl + 1;
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Rendered preview of everything not yet returned by `push()`. Does not consume it. */
  pending(): string[] {
    const preview = this.renderer.clone();
    const out = this.buffer ? preview.line(this.buffer) : [];
    for (const row of preview.end()) out.push(row);
    return out;
  }

  /** End of message: returns everything not yet returned and resets for the next message. */
  flush(): string[] {
    const out = this.buffer ? this.renderer.line(this.buffer) : [];
    this.buffer = '';
    for (const row of this.renderer.end()) out.push(row);
    return out;
  }
}

/** Render a complete Markdown document to terminal rows. */
export function renderMarkdown(text: string, width: number, indent = ''): string[] {
  const stream = new MarkdownStream({ width: () => width, indent });
  const out = stream.push(text);
  for (const row of stream.flush()) out.push(row);
  return out;
}
