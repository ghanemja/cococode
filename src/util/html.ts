/**
 * HTML to Markdown, without a DOM.
 *
 * A tolerant tokenizer feeds an iterative renderer that keeps an explicit
 * stack of open elements. Nothing recurses and no step rescans the output,
 * so malformed markup, very deep nesting and multi-megabyte documents are all
 * handled in roughly linear time.
 */

// ---------------------------------------------------------------- entities

const NAMED: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'",
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a',
  ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e', dagger: '\u2020', Dagger: '\u2021',
  bull: '\u2022', bullet: '\u2022', hellip: '\u2026', permil: '\u2030', prime: '\u2032', Prime: '\u2033',
  lsaquo: '\u2039', rsaquo: '\u203a', oline: '\u203e', frasl: '\u2044', euro: '\u20ac',
  trade: '\u2122', larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194',
  lArr: '\u21d0', rArr: '\u21d2', hArr: '\u21d4', forall: '\u2200', part: '\u2202', exist: '\u2203',
  empty: '\u2205', nabla: '\u2207', isin: '\u2208', prod: '\u220f', sum: '\u2211', minus: '\u2212',
  lowast: '\u2217', radic: '\u221a', infin: '\u221e', and: '\u2227', or: '\u2228', cap: '\u2229',
  cup: '\u222a', int: '\u222b', there4: '\u2234', sim: '\u223c', asymp: '\u2248', ne: '\u2260',
  equiv: '\u2261', le: '\u2264', ge: '\u2265', sub: '\u2282', sup: '\u2283', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009', hairsp: '\u200a', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e',
  rlm: '\u200f', OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178',
  fnof: '\u0192', circ: '\u02c6', tilde: '\u02dc', loz: '\u25ca', spades: '\u2660', clubs: '\u2663',
  hearts: '\u2665', diams: '\u2666', check: '\u2713', cross: '\u2717', star: '\u2606', starf: '\u2605',
  hyphen: '\u2010', dash: '\u2010', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']',
  lcub: '{', rcub: '}', lbrace: '{', rbrace: '}', vert: '|', verbar: '|', bsol: '\\', sol: '/',
  colon: ':', semi: ';', comma: ',', period: '.', excl: '!', quest: '?', num: '#', dollar: '$',
  percnt: '%', ast: '*', plus: '+', equals: '=', commat: '@', grave: '`', lowbar: '_', Hat: '^',
  Tab: '\t', NewLine: '\n', sigmaf: '\u03c2', thetasym: '\u03d1', piv: '\u03d6',
});

// U+00A0..U+00FF in order.
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 ' +
  'acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde ' +
  'Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute ' +
  'Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde ' +
  'auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ' +
  'ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
LATIN1.split(' ').forEach((name, i) => {
  NAMED[name] = String.fromCharCode(0xa0 + i);
});

// U+0391.. (capital) and U+03B1.. (small); "_" is the unassigned slot before Sigma.
const GREEK =
  'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho _ Sigma Tau ' +
  'Upsilon Phi Chi Psi Omega';
GREEK.split(' ').forEach((name, i) => {
  if (name === '_') return;
  NAMED[name] = String.fromCharCode(0x391 + i);
  NAMED[name.toLowerCase()] = String.fromCharCode(0x3b1 + i);
});

// Numeric references in 0x80..0x9F are Windows-1252 in practice.
const CP1252 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

function fromCodePoint(cp: number): string {
  if (cp >= 0x80 && cp <= 0x9f) cp = CP1252[cp - 0x80] || cp;
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(cp);
}

// Named references need their semicolon, so "?a=1&copy=2" in a URL is left alone.
const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]{1,6});?|#([0-9]{1,7});?|([a-zA-Z][a-zA-Z0-9]{1,31});)/g;

/** Decode named and numeric character references. Unknown names are left as written. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_RE, (match, hex?: string, dec?: string, name?: string) => {
    if (hex) return fromCodePoint(Number.parseInt(hex, 16));
    if (dec) return fromCodePoint(Number.parseInt(dec, 10));
    return (name && NAMED[name]) ?? match;
  });
}

/** Text content of an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// --------------------------------------------------------------- tokenizer

const TEXT = 0;
const OPEN = 1;
const CLOSE = 2;

type Attrs = Record<string, string>;

interface Token {
  kind: 0 | 1 | 2;
  /** Lower-cased tag name; empty for text. */
  name: string;
  /** Raw text (entities not yet decoded); empty for tags. */
  text: string;
  attrs: Attrs | undefined;
}

/** Elements whose content is raw text and is dropped. */
const SKIP_RAW = new Set(['script', 'style', 'noscript', 'iframe', 'textarea', 'title']);
/** Dropped elements that may contain themselves. */
const SKIP_NESTED = new Set(['svg', 'template', 'select', 'canvas', 'object']);
/** Tags whose attributes the renderer looks at. */
const WANT_ATTRS = new Set(['a', 'img', 'pre', 'code', 'ol', 'div', 'section']);

function isSpace(c: number): boolean {
  return c === 32 || c === 10 || c === 9 || c === 13 || c === 12;
}

function isAlpha(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

function isNameChar(c: number): boolean {
  return isAlpha(c) || (c >= 48 && c <= 58) || c === 45 || c === 95; // includes ':' (58)
}

interface TagScan {
  /** Index just past the closing '>'. */
  end: number;
  attrs: Attrs | undefined;
  selfClosing: boolean;
}

/** Scan a start tag's attributes, beginning just after the tag name. */
function scanTag(html: string, start: number, collect: boolean): TagScan {
  const n = html.length;
  let i = start;
  let attrs: Attrs | undefined;
  let selfClosing = false;
  for (;;) {
    while (i < n && isSpace(html.charCodeAt(i))) i++;
    if (i >= n) return { end: n, attrs, selfClosing };
    const ch = html.charCodeAt(i);
    if (ch === 62 /* > */) return { end: i + 1, attrs, selfClosing };
    if (ch === 47 /* / */) {
      selfClosing = html.charCodeAt(i + 1) === 62;
      i++;
      continue;
    }
    const nameStart = i;
    while (i < n) {
      const c = html.charCodeAt(i);
      if (isSpace(c) || c === 61 || c === 62 || c === 47) break;
      i++;
    }
    if (i === nameStart) {
      i++; // stray '='; keep moving
      continue;
    }
    const name = collect ? html.slice(nameStart, i).toLowerCase() : '';
    while (i < n && isSpace(html.charCodeAt(i))) i++;
    let value = '';
    if (html.charCodeAt(i) === 61 /* = */) {
      i++;
      while (i < n && isSpace(html.charCodeAt(i))) i++;
      const q = html.charCodeAt(i);
      if (q === 34 || q === 39) {
        const close = html.indexOf(q === 34 ? '"' : "'", i + 1);
        if (close === -1) {
          // Unterminated quote: end the value at the tag's '>' rather than eating the document.
          const gt = html.indexOf('>', i + 1);
          const stop = gt === -1 ? n : gt;
          if (collect) value = html.slice(i + 1, stop);
          i = stop;
        } else {
          if (collect) value = html.slice(i + 1, close);
          i = close + 1;
        }
      } else {
        const valueStart = i;
        while (i < n) {
          const c = html.charCodeAt(i);
          if (isSpace(c) || c === 62) break;
          i++;
        }
        if (collect) value = html.slice(valueStart, i);
      }
    }
    if (collect) {
      attrs ??= Object.create(null) as Attrs;
      if (!(name in attrs)) attrs[name] = value;
    }
  }
}

const regexCache = new Map<string, RegExp>();

function cachedRegex(key: string, source: string): RegExp {
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(source, 'gi');
    regexCache.set(key, re);
  }
  return re;
}

function afterTagEnd(html: string, from: number): number {
  const gt = html.indexOf('>', from);
  return gt === -1 ? html.length : gt + 1;
}

/** Index just past `</name>`, or -1 when the element is never closed. */
function skipRawElement(html: string, pos: number, name: string): number {
  const re = cachedRegex(`raw:${name}`, `</${name}(?=[\\s>/])`);
  re.lastIndex = pos;
  const m = re.exec(html);
  return m ? afterTagEnd(html, m.index) : -1;
}

function skipNestedElement(html: string, pos: number, name: string): number {
  const re = cachedRegex(`nested:${name}`, `<(/?)${name}(?=[\\s>/])`);
  re.lastIndex = pos;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!m[1]) depth++;
    else if (--depth === 0) return afterTagEnd(html, m.index);
  }
  return -1;
}

/** `<head>` ends at `</head>`, or failing that where `<body>` starts. */
function skipHead(html: string, pos: number): number {
  const closed = skipRawElement(html, pos, 'head');
  if (closed !== -1) return closed;
  const re = cachedRegex('body', '<body(?=[\\s>/])');
  re.lastIndex = pos;
  const m = re.exec(html);
  return m ? m.index : -1;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const n = html.length;
  let i = 0;
  let textStart = 0;
  // Elements we failed to find the end of once; never rescan for them.
  const unclosed = new Set<string>();

  const flushText = (end: number) => {
    if (end > textStart) tokens.push({ kind: TEXT, name: '', text: html.slice(textStart, end), attrs: undefined });
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);

    if (next === 33 /* ! */) {
      flushText(lt);
      let end: number;
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        end = close === -1 ? n : close + 3;
      } else if (html.startsWith('<![CDATA[', lt)) {
        const close = html.indexOf(']]>', lt + 9);
        const stop = close === -1 ? n : close;
        if (stop > lt + 9) tokens.push({ kind: TEXT, name: '', text: html.slice(lt + 9, stop), attrs: undefined });
        end = close === -1 ? n : close + 3;
      } else {
        end = afterTagEnd(html, lt + 2);
      }
      i = textStart = end;
      continue;
    }

    if (next === 63 /* ? */) {
      flushText(lt);
      i = textStart = afterTagEnd(html, lt + 2);
      continue;
    }

    if (next === 47 /* / */) {
      flushText(lt);
      if (isAlpha(html.charCodeAt(lt + 2))) {
        let j = lt + 2;
        while (j < n && isNameChar(html.charCodeAt(j))) j++;
        tokens.push({ kind: CLOSE, name: html.slice(lt + 2, j).toLowerCase(), text: '', attrs: undefined });
        i = textStart = afterTagEnd(html, j);
      } else {
        i = textStart = afterTagEnd(html, lt + 2); // "</>" and friends are bogus comments
      }
      continue;
    }

    if (isAlpha(next)) {
      flushText(lt);
      let j = lt + 1;
      while (j < n && isNameChar(html.charCodeAt(j))) j++;
      const name = html.slice(lt + 1, j).toLowerCase();
      const tag = scanTag(html, j, WANT_ATTRS.has(name));
      let end = tag.end;
      let skipped = false;

      if (!unclosed.has(name)) {
        let after = -2; // -2: not a skipped element
        if (name === 'head') after = skipHead(html, end);
        else if (SKIP_RAW.has(name)) after = skipRawElement(html, end, name);
        else if (SKIP_NESTED.has(name)) after = tag.selfClosing ? end : skipNestedElement(html, end, name);

        if (after >= 0) {
          end = after;
          skipped = true;
        } else if (after === -1) {
          if (name === 'script' || name === 'style') {
            end = n; // the rest is code, not content
            skipped = true;
          } else {
            unclosed.add(name); // treat as transparent from here on
          }
        }
      }

      if (!skipped) tokens.push({ kind: OPEN, name, text: '', attrs: tag.attrs });
      i = textStart = end;
      continue;
    }

    i = lt + 1; // a literal '<'
  }
  flushText(n);
  return tokens;
}

// ---------------------------------------------------------------- renderer

/** Append-only text buffer that knows how it currently ends, so nothing has to rescan it. */
class Buf {
  private parts: string[] = [];
  /** No content yet. */
  empty = true;
  /** Ends with a single space. */
  space = false;
  /** Number of trailing newlines. */
  newlines = 0;

  /** Inline text with whitespace already collapsed to single spaces. */
  text(s: string): void {
    if (s.charCodeAt(0) === 32 && (this.empty || this.space || this.newlines > 0)) s = s.slice(1);
    if (s === '') return;
    this.push(s);
  }

  /** A finished piece of Markdown, added as-is. */
  push(s: string): void {
    if (s === '') return;
    this.parts.push(s);
    this.empty = false;
    let k = s.length;
    while (k > 0 && s.charCodeAt(k - 1) === 10) k--;
    const trailing = s.length - k;
    if (trailing > 0) {
      this.newlines = k === 0 ? this.newlines + trailing : trailing;
      this.space = false;
    } else {
      this.newlines = 0;
      this.space = s.charCodeAt(s.length - 1) === 32;
    }
  }

  private dropSpace(): void {
    if (!this.space) return;
    const last = this.parts.length - 1;
    const trimmed = this.parts[last]!.slice(0, -1);
    if (trimmed) this.parts[last] = trimmed;
    else this.parts.pop();
    this.space = false;
  }

  lineBreak(): void {
    if (this.empty || this.newlines >= 1) return;
    this.dropSpace();
    this.parts.push('\n');
    this.newlines = 1;
  }

  blockBreak(): void {
    if (this.empty || this.newlines >= 2) return;
    this.dropSpace();
    this.parts.push(this.newlines === 1 ? '\n' : '\n\n');
    this.newlines = 2;
  }

  endsWithGap(): boolean {
    return this.space || this.newlines > 0;
  }

  toString(): string {
    return this.parts.join('');
  }
}

type FrameKind = 'root' | 'inline' | 'link' | 'heading' | 'quote' | 'list' | 'item' | 'pre' | 'table' | 'row' | 'cell';

interface TableRow {
  cells: string[];
  header: boolean;
}

interface Frame {
  kind: FrameKind;
  buf: Buf;
  /** inline: the Markdown marker. */
  mark?: string;
  /** inline/link: whitespace preceded the content. */
  lead?: boolean;
  href?: string;
  title?: string;
  level?: number;
  ordered?: boolean;
  index?: number;
  lang?: string;
  /** pre: text outside any <code> child. */
  raw?: string[];
  /** pre: one entry per <code> child; each becomes its own fenced block. */
  blocks?: { lang: string; parts: string[] }[];
  /** pre: the <code> child currently being read. */
  code?: string[];
  /** pre: inside a <button> (copy buttons), whose text is dropped. */
  inButton?: boolean;
  rows?: TableRow[];
  inHead?: boolean;
  nested?: boolean;
  cells?: string[];
  allTh?: boolean;
  headRow?: boolean;
  isTh?: boolean;
}

const INLINE_MARK: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  strong: '**', b: '**', em: '*', i: '*', del: '~~', s: '~~', strike: '~~',
  code: '`', kbd: '`', samp: '`', tt: '`',
});

const BLOCK = new Set([
  'address', 'article', 'aside', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'html', 'legend', 'main', 'nav',
  'p', 'section', 'summary', 'option', 'optgroup',
]);

const HEADING_RE = /^h[1-6]$/;
const PERMALINK_RE = /^(#|\u00b6|\u00a7|\ud83d\udd17|permalink)$/i;
/** Deeper nesting than this is flattened; real pages never get close. */
const MAX_DEPTH = 96;

const isTable = (f: Frame) => f.kind === 'table';
const isCellBoundary = (f: Frame) => f.kind === 'cell' || f.kind === 'table';
const isBlockBoundary = (f: Frame) => f.kind !== 'inline' && f.kind !== 'link' && f.kind !== 'heading';
const isNotInline = (f: Frame) => f.kind !== 'inline' && f.kind !== 'link';

/** Join lines into one, trimming each. Linear, unlike a `\s*\n\s*` regex. */
function flatten(s: string): string {
  if (!s.includes('\n')) return s.trim();
  const out: string[] = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t) out.push(t);
  }
  return out.join(' ');
}

function longestRun(s: string, ch: string): number {
  const code = ch.charCodeAt(0);
  let best = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === code) {
      if (++run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

function resolveUrl(raw: string | undefined, base: string | undefined, isImage = false): string | undefined {
  if (!raw) return undefined;
  let href = decodeEntities(raw).trim();
  if (!href) return undefined;
  const scheme = href.slice(0, 12).toLowerCase();
  if (scheme.startsWith('javascript:') || scheme.startsWith('vbscript:') || scheme.startsWith('data:')) return undefined;
  if (!isImage && href.startsWith('#')) return undefined;
  if (base) {
    try {
      href = new URL(href, base).href;
    } catch {
      // keep the href as written
    }
  }
  return href.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function languageOf(attrs: Attrs | undefined): string {
  if (!attrs) return '';
  const cls = attrs.class ?? '';
  const m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/i.exec(cls) ?? /(?:^|\s)highlight-(?:source-)?([\w+#.-]+)/i.exec(cls);
  const lang = (m?.[1] ?? attrs['data-lang'] ?? attrs['data-language'] ?? '').toLowerCase();
  return lang === 'none' || lang === 'plaintext' ? '' : lang;
}

function imageSource(attrs: Attrs): string | undefined {
  for (const key of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
    const v = attrs[key]?.trim();
    if (v && !v.toLowerCase().startsWith('data:')) return v;
  }
  const first = attrs.srcset?.trim().split(/[\s,]+/)[0];
  return first && !first.toLowerCase().startsWith('data:') ? first : undefined;
}

function renderTable(rows: TableRow[], nested: boolean): string {
  if (rows.length === 0) return '';
  let cols = 0;
  let hasBlocks = false;
  for (const row of rows) {
    if (row.cells.length > cols) cols = row.cells.length;
    for (const cell of row.cells) if (cell.length > 1000 || cell.includes('```')) hasBlocks = true;
  }

  // Layout tables (nested, single column, or holding whole blocks) read better as plain blocks.
  if (nested || cols <= 1 || hasBlocks) {
    const blocks: string[] = [];
    for (const row of rows) {
      const cells = row.cells.filter(Boolean);
      if (cells.length === 0) continue;
      blocks.push(cells.some((c) => c.includes('\n')) ? cells.join('\n\n') : cells.join(' '));
    }
    return blocks.join('\n\n');
  }

  const line = (cells: string[]) => {
    const out: string[] = [];
    for (let i = 0; i < cols; i++) out.push(flatten(cells[i] ?? '').replace(/\|/g, '\\|'));
    return `| ${out.join(' | ')} |`;
  };
  const lines = [line(rows[0]!.cells), `| ${new Array<string>(cols).fill('---').join(' | ')} |`];
  for (let i = 1; i < rows.length; i++) lines.push(line(rows[i]!.cells));
  return lines.join('\n');
}

class Renderer {
  private readonly base: string | undefined;
  private readonly stack: Frame[] = [{ kind: 'root', buf: new Buf() }];

  constructor(base: string | undefined) {
    this.base = base;
  }

  run(tokens: Token[], from: number, to: number): string {
    for (let i = from; i < to; i++) {
      const tok = tokens[i]!;
      const top = this.top();
      if (top.kind === 'pre') this.inPre(top, tok);
      else if (tok.kind === TEXT) this.text(tok.text);
      else if (tok.kind === OPEN) this.open(tok);
      else this.close(tok.name);
    }
    this.closeTo(1);
    return this.stack[0]!.buf.toString().trim();
  }

  private top(): Frame {
    return this.stack[this.stack.length - 1]!;
  }

  private push(frame: Frame): boolean {
    if (this.stack.length >= MAX_DEPTH) return false;
    this.stack.push(frame);
    return true;
  }

  /** Nearest open frame matching `match`, searching no further than a frame matching `stop`. */
  private find(match: (f: Frame) => boolean, stop?: (f: Frame) => boolean): number {
    for (let i = this.stack.length - 1; i >= 1; i--) {
      const f = this.stack[i]!;
      if (match(f)) return i;
      if (stop?.(f)) return -1;
    }
    return -1;
  }

  /** First frame of `kind` opened inside the table at stack index `table`. */
  private findInTable(table: number, kind: FrameKind): number {
    for (let i = table + 1; i < this.stack.length; i++) if (this.stack[i]!.kind === kind) return i;
    return -1;
  }

  private closeTo(index: number): void {
    while (this.stack.length > index) this.closeTop();
  }

  /** Unclosed <b>/<i>/<code> must not leak across a block boundary. */
  private closeInline(): void {
    while (this.top().kind === 'inline') this.closeTop();
  }

  private inline(s: string): void {
    const top = this.top();
    if (top.buf.empty && s.charCodeAt(0) === 32 && (top.kind === 'inline' || top.kind === 'link')) top.lead = true;
    top.buf.text(s);
  }

  private block(s: string): void {
    const buf = this.top().buf;
    buf.blockBreak();
    buf.push(s);
    buf.blockBreak();
  }

  private breakBlock(): void {
    this.closeInline();
    this.top().buf.blockBreak();
  }

  private text(raw: string): void {
    let s = decodeEntities(raw);
    if (/[\u200b\u00ad\ufeff\u2060]/.test(s)) s = s.replace(/[\u200b\u00ad\ufeff\u2060]/g, '');
    s = s.replace(/\s+/g, ' ');
    if (s) this.inline(s);
  }

  private inPre(pre: Frame, tok: Token): void {
    // Once a <pre> has <code> children, only their text is code; toolbars around them are not.
    const target = pre.code ?? pre.raw!;
    if (tok.kind === TEXT) {
      if (!pre.inButton) target.push(decodeEntities(tok.text));
      return;
    }
    const name = tok.name;
    if (tok.kind === OPEN) {
      if (name === 'br') {
        target.push('\n');
      } else if (name === 'button') {
        pre.inButton = true;
      } else if (name === 'code' && !pre.code) {
        pre.code = [];
        pre.blocks!.push({ lang: languageOf(tok.attrs), parts: pre.code });
      }
      return;
    }
    if (name === 'pre') {
      this.closeTop();
    } else if (name === 'code') {
      pre.code = undefined;
    } else if (name === 'button') {
      pre.inButton = false;
    } else if (name === 'div' || name === 'p' || name === 'li' || name === 'tr') {
      // Highlighters that wrap each line in a block element omit the newlines.
      const last = target[target.length - 1];
      if (last !== undefined && !last.endsWith('\n')) target.push('\n');
    }
  }

  private open(tok: Token): void {
    const name = tok.name;
    switch (name) {
      case 'br': {
        const buf = this.top().buf;
        if (buf.newlines === 0) buf.lineBreak();
        else if (buf.newlines === 1) buf.blockBreak();
        return;
      }
      case 'hr':
        this.closeInline();
        this.block('---');
        return;
      case 'img':
        this.image(tok.attrs);
        return;
      case 'a': {
        const open = this.find((f) => f.kind === 'link', isCellBoundary);
        if (open !== -1) this.closeTo(open);
        this.push({ kind: 'link', buf: new Buf(), href: tok.attrs?.href, title: tok.attrs?.title || tok.attrs?.['aria-label'] });
        return;
      }
      case 'blockquote':
        this.breakBlock();
        this.push({ kind: 'quote', buf: new Buf() });
        return;
      case 'ul':
      case 'ol':
      case 'menu': {
        this.closeInline();
        const parent = this.top();
        if (parent.kind === 'item') parent.buf.lineBreak();
        else parent.buf.blockBreak();
        const start = Number.parseInt(tok.attrs?.start ?? '', 10);
        this.push({ kind: 'list', buf: new Buf(), ordered: name === 'ol', index: Number.isFinite(start) ? start : 1 });
        return;
      }
      case 'li': {
        this.closeInline();
        const i = this.find((f) => f.kind === 'item' || f.kind === 'list', isCellBoundary);
        if (i !== -1 && this.stack[i]!.kind === 'item') this.closeTo(i);
        this.push({ kind: 'item', buf: new Buf() });
        return;
      }
      case 'pre':
        this.breakBlock();
        this.push({ kind: 'pre', buf: new Buf(), raw: [], blocks: [], lang: languageOf(tok.attrs) });
        return;
      case 'table':
        this.breakBlock();
        this.push({ kind: 'table', buf: new Buf(), rows: [], inHead: false });
        return;
      case 'thead':
      case 'tbody':
      case 'tfoot': {
        const t = this.find(isTable);
        if (t !== -1) this.stack[t]!.inHead = name === 'thead';
        return;
      }
      case 'tr': {
        this.closeInline();
        const t = this.find(isTable);
        if (t === -1) {
          this.top().buf.blockBreak();
          return;
        }
        const row = this.findInTable(t, 'row');
        if (row !== -1) this.closeTo(row);
        this.push({ kind: 'row', buf: new Buf(), cells: [], allTh: true, headRow: this.stack[t]!.inHead === true });
        return;
      }
      case 'td':
      case 'th': {
        this.closeInline();
        const t = this.find(isTable);
        if (t === -1) {
          this.top().buf.blockBreak();
          return;
        }
        const cell = this.findInTable(t, 'cell');
        if (cell !== -1) this.closeTo(cell);
        if (this.findInTable(t, 'row') === -1) {
          this.push({ kind: 'row', buf: new Buf(), cells: [], allTh: true, headRow: this.stack[t]!.inHead === true });
        }
        this.push({ kind: 'cell', buf: new Buf(), isTh: name === 'th' });
        return;
      }
    }

    if (HEADING_RE.test(name)) {
      this.closeInline();
      const open = this.find((f) => f.kind === 'heading', isBlockBoundary);
      if (open !== -1) this.closeTo(open);
      this.top().buf.blockBreak();
      this.push({ kind: 'heading', buf: new Buf(), level: Number(name[1]) });
      return;
    }

    const mark = INLINE_MARK[name];
    if (mark) {
      // Skip a marker that is already active, and any formatting inside inline code.
      const active = this.find((f) => f.kind === 'inline' && (f.mark === mark || f.mark === '`'), isNotInline);
      if (active === -1) this.push({ kind: 'inline', buf: new Buf(), mark });
      return;
    }

    if (BLOCK.has(name)) this.breakBlock();
  }

  private close(name: string): void {
    switch (name) {
      case 'a': {
        const i = this.find((f) => f.kind === 'link', isCellBoundary);
        if (i !== -1) this.closeTo(i);
        return;
      }
      case 'blockquote': {
        const i = this.find((f) => f.kind === 'quote', isCellBoundary);
        if (i !== -1) this.closeTo(i);
        else this.breakBlock();
        return;
      }
      case 'ul':
      case 'ol':
      case 'menu': {
        const i = this.find((f) => f.kind === 'list', isCellBoundary);
        if (i !== -1) this.closeTo(i);
        return;
      }
      case 'li': {
        const i = this.find((f) => f.kind === 'item' || f.kind === 'list', isCellBoundary);
        if (i !== -1 && this.stack[i]!.kind === 'item') this.closeTo(i);
        return;
      }
      case 'table': {
        const i = this.find(isTable);
        if (i !== -1) this.closeTo(i);
        return;
      }
      case 'thead': {
        const t = this.find(isTable);
        if (t !== -1) {
          // Finish any row still open so it is counted as a header row.
          const row = this.findInTable(t, 'row');
          if (row !== -1) this.closeTo(row);
          this.stack[t]!.inHead = false;
        }
        return;
      }
      case 'tbody':
      case 'tfoot':
      case 'pre':
        return;
      case 'tr':
      case 'td':
      case 'th': {
        const t = this.find(isTable);
        if (t === -1) {
          this.breakBlock();
          return;
        }
        const i = this.findInTable(t, name === 'tr' ? 'row' : 'cell');
        if (i !== -1) this.closeTo(i);
        return;
      }
    }

    if (HEADING_RE.test(name)) {
      const i = this.find((f) => f.kind === 'heading', isBlockBoundary);
      if (i !== -1) this.closeTo(i);
      else this.breakBlock();
      return;
    }

    const mark = INLINE_MARK[name];
    if (mark) {
      const i = this.find((f) => f.kind === 'inline' && f.mark === mark, isNotInline);
      if (i !== -1) this.closeTo(i);
      return;
    }

    if (BLOCK.has(name)) this.breakBlock();
  }

  private image(attrs: Attrs | undefined): void {
    if (!attrs || attrs.width === '1' || attrs.height === '1') return; // tracking pixels
    const alt = decodeEntities(attrs.alt ?? '')
      .replace(/[\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const url = resolveUrl(imageSource(attrs), this.base, true);
    if (url) this.inline(`![${alt}](${url})`);
    else if (alt) this.inline(alt);
  }

  /** Pop the top frame and write its Markdown into the frame below. */
  private closeTop(): void {
    const f = this.stack.pop()!;
    const parent = this.top();

    switch (f.kind) {
      case 'inline': {
        const inner = f.buf.toString();
        const body = inner.trim();
        const lead = f.lead ? ' ' : '';
        const trail = f.buf.endsWithGap() ? ' ' : '';
        if (!body) {
          if (lead || trail) this.inline(' ');
          return;
        }
        let out: string;
        if (f.mark === '`') {
          const code = flatten(body);
          const run = longestRun(code, '`');
          const fence = '`'.repeat(run + 1);
          const pad = run > 0 && (code.startsWith('`') || code.endsWith('`')) ? ' ' : '';
          out = fence + pad + code + pad + fence;
        } else {
          out = f.mark + body + f.mark;
        }
        this.inline(lead + out + trail);
        return;
      }

      case 'link': {
        const inner = f.buf.toString();
        // A link wrapping whole blocks (a "card") becomes a block of its own.
        const blocky = inner.includes('\n');
        let label = flatten(inner).replace(/^#{1,6}\s+/, '');
        if (!label) label = decodeEntities(f.title ?? '').replace(/\s+/g, ' ').trim();
        const lead = f.lead ? ' ' : '';
        const trail = f.buf.endsWithGap() ? ' ' : '';
        if (!label) {
          if (lead || trail) this.inline(' ');
          return;
        }
        const href = resolveUrl(f.href, this.base);
        // Heading permalinks ("#", "\u00b6") are page furniture, not content.
        if (!href && f.href?.trim().startsWith('#') && PERMALINK_RE.test(label)) {
          if (lead || trail) this.inline(' ');
          return;
        }
        const out = href ? `[${label}](${href})` : label;
        if (blocky && parent.kind !== 'inline') this.block(out);
        else this.inline(lead + out + trail);
        return;
      }

      case 'heading': {
        const label = flatten(f.buf.toString());
        if (label) this.block(`${'#'.repeat(f.level ?? 1)} ${label}`);
        return;
      }

      case 'quote': {
        const inner = f.buf.toString().trim();
        if (!inner) return;
        const lines = inner.split('\n');
        for (let i = 0; i < lines.length; i++) lines[i] = lines[i] ? `> ${lines[i]}` : '>';
        this.block(lines.join('\n'));
        return;
      }

      case 'list': {
        const inner = f.buf.toString().trimEnd();
        if (!inner) return;
        if (parent.kind === 'item') {
          parent.buf.lineBreak();
          parent.buf.push(inner);
          parent.buf.lineBreak();
        } else {
          this.block(inner);
        }
        return;
      }

      case 'item': {
        const inner = f.buf.toString().trim();
        if (!inner) return;
        let marker = '- ';
        if (parent.kind === 'list' && parent.ordered) {
          marker = `${parent.index ?? 1}. `;
          parent.index = (parent.index ?? 1) + 1;
        }
        const pad = ' '.repeat(marker.length);
        const lines = inner.split('\n');
        lines[0] = marker + lines[0];
        for (let i = 1; i < lines.length; i++) if (lines[i]) lines[i] = pad + lines[i];
        parent.buf.lineBreak();
        parent.buf.push(lines.join('\n'));
        parent.buf.lineBreak();
        return;
      }

      case 'pre': {
        const fenced = (parts: string[], lang: string): boolean => {
          let code = parts.join('').replace(/\r\n?/g, '\n');
          if (code.startsWith('\n')) code = code.slice(1);
          code = code.trimEnd();
          if (!/\S/.test(code)) return false;
          const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
          this.block(`${fence}${lang}\n${code}\n${fence}`);
          return true;
        };
        let emitted = false;
        for (const block of f.blocks ?? []) {
          if (fenced(block.parts, block.lang || f.lang || '')) emitted = true;
        }
        if (!emitted) fenced(f.raw ?? [], f.lang ?? '');
        return;
      }

      case 'cell': {
        const content = f.buf.toString().trim();
        const row = this.find((x) => x.kind === 'row');
        if (row === -1) {
          if (content) this.block(content);
          return;
        }
        const r = this.stack[row]!;
        r.cells!.push(content);
        if (!f.isTh) r.allTh = false;
        return;
      }

      case 'row': {
        const t = this.find(isTable);
        if (t !== -1 && f.cells!.length > 0) {
          this.stack[t]!.rows!.push({ cells: f.cells!, header: f.headRow === true || f.allTh === true });
        }
        return;
      }

      case 'table': {
        const outer = this.find(isTable);
        if (outer !== -1) this.stack[outer]!.nested = true;
        const caption = flatten(f.buf.toString());
        if (caption) this.block(caption);
        const table = renderTable(f.rows ?? [], f.nested === true);
        if (table) this.block(table);
        return;
      }

      case 'root':
        this.stack.push(f); // never popped; restore
        return;
    }
  }
}

// -------------------------------------------------------------- public API

function matchingClose(tokens: Token[], open: number): number {
  const name = tokens[open]!.name;
  let depth = 1;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.name !== name) continue;
    if (t.kind === OPEN) depth++;
    else if (t.kind === CLOSE && --depth === 0) return i;
  }
  return tokens.length;
}

/** Token ranges holding the page's main content: `<main>`, else every top-level `<article>`. */
function contentRanges(tokens: Token[]): [number, number][] | undefined {
  const main = tokens.findIndex((t) => t.kind === OPEN && (t.name === 'main' || t.attrs?.role === 'main'));
  if (main !== -1) return [[main + 1, matchingClose(tokens, main)]];
  const ranges: [number, number][] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === OPEN && t.name === 'article') {
      const end = matchingClose(tokens, i);
      ranges.push([i + 1, end]);
      i = end;
    }
  }
  return ranges.length > 0 ? ranges : undefined;
}

/** Below this many characters a `<main>`/`<article>` is assumed to be an empty app shell. */
const MIN_MAIN_CHARS = 80;

/**
 * Convert an HTML document or fragment to Markdown.
 *
 * Scripts, styles, the head and other non-content elements are dropped. When
 * the page has a `<main>` or `<article>`, only that is converted. Relative
 * links are resolved against `baseUrl`.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  if (!html) return '';
  const tokens = tokenize(html);
  const ranges = contentRanges(tokens);
  if (!ranges) return new Renderer(baseUrl).run(tokens, 0, tokens.length);

  const selected = ranges
    .map(([from, to]) => new Renderer(baseUrl).run(tokens, from, to))
    .filter(Boolean)
    .join('\n\n');
  if (selected.length >= MIN_MAIN_CHARS) return selected;
  const full = new Renderer(baseUrl).run(tokens, 0, tokens.length);
  return full.length > selected.length ? full : selected;
}

/** The document title: `<title>`, else the Open Graph title. */
export function extractTitle(html: string): string | undefined {
  const head = html.length > 300_000 ? html.slice(0, 300_000) : html;
  const clean = (s: string | undefined) => {
    const t = decodeEntities(s ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return t || undefined;
  };
  const title = /<title\b[^>]*>([^<]*)/i.exec(head);
  const fromTitle = clean(title?.[1]);
  if (fromTitle) return fromTitle;
  const og =
    /<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(head) ??
    /<meta\b[^>]*\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\bproperty\s*=\s*["']og:title["']/i.exec(head);
  return clean(og?.[1] ?? og?.[2]);
}
