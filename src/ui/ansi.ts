/**
 * Terminal text utilities: colours, display width, wrapping and truncation.
 * Everything that prints to the terminal goes through these so that colour
 * can be switched off in one place (NO_COLOR, pipes, tests).
 */

let colorEnabled = !process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR) || Boolean(process.stdout.isTTY));

export function setColorEnabled(on: boolean): void {
  colorEnabled = on;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

const ESC = '\x1b[';

function style(open: string, close: string): (s: string) => string {
  return (s: string) => {
    if (!colorEnabled || s === '') return s;
    // Re-open after any nested close so that inner styles do not cancel the outer one.
    const closeSeq = `${ESC}${close}m`;
    const openSeq = `${ESC}${open}m`;
    const inner = s.includes(closeSeq) ? s.split(closeSeq).join(closeSeq + openSeq) : s;
    return openSeq + inner + closeSeq;
  };
}

export const c = {
  bold: style('1', '22'),
  dim: style('2', '22'),
  italic: style('3', '23'),
  underline: style('4', '24'),
  inverse: style('7', '27'),
  strike: style('9', '29'),
  red: style('31', '39'),
  green: style('32', '39'),
  yellow: style('33', '39'),
  blue: style('34', '39'),
  magenta: style('35', '39'),
  cyan: style('36', '39'),
  white: style('37', '39'),
  gray: style('90', '39'),
  brightRed: style('91', '39'),
  brightGreen: style('92', '39'),
  brightYellow: style('93', '39'),
  brightBlue: style('94', '39'),
  brightMagenta: style('95', '39'),
  brightCyan: style('96', '39'),
  /** 256-colour foreground. */
  fg: (n: number) => style(`38;5;${n}`, '39'),
  /** 256-colour background. */
  bg: (n: number) => style(`48;5;${n}`, '49'),
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.includes('\x1b') ? s.replace(ANSI_RE, '') : s;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZeroWidth(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp < 0xa0) ||
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Split into user-perceived characters. */
export function graphemes(s: string): string[] {
  // Fast path: printable ASCII has one grapheme per code unit.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(s)) return s.split('');
  return Array.from(segmenter.segment(s), (seg) => seg.segment);
}

const VARIATION_SELECTOR_16 = String.fromCodePoint(0xfe0f);
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;

/** Display width of a single grapheme cluster. */
export function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x7f) {
    if (cp < 0x20) return 0;
    // Keycap sequences such as "1" + VS16 + U+20E3 render as one wide emoji.
    return g.length > 1 && g.includes(VARIATION_SELECTOR_16) ? 2 : 1;
  }
  if (isZeroWidth(cp)) return 0;
  if (isWide(cp)) return 2;
  // Emoji that default to emoji presentation, flags, and text symbols forced to emoji by VS16.
  if (EMOJI_PRESENTATION.test(g) || REGIONAL_INDICATOR.test(g)) return 2;
  if (g.length > 1 && g.includes(VARIATION_SELECTOR_16) && PICTOGRAPHIC.test(g)) return 2;
  return 1;
}

/** Number of terminal columns a string occupies, ignoring ANSI escapes. */
export function stringWidth(s: string): number {
  const plain = stripAnsi(s);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(plain)) return plain.length;
  let width = 0;
  for (const g of graphemes(plain)) width += graphemeWidth(g);
  return width;
}

/** Tracks which SGR attributes are active so wrapped lines can re-open them. */
class SgrState {
  private attrs = new Map<string, string>();

  apply(params: string): void {
    const codes = params === '' ? ['0'] : params.split(';');
    for (let i = 0; i < codes.length; i++) {
      const code = Number(codes[i]);
      if (code === 0) this.attrs.clear();
      else if (code === 1) this.attrs.set('bold', '1');
      else if (code === 2) this.attrs.set('dim', '2');
      else if (code === 3) this.attrs.set('italic', '3');
      else if (code === 4) this.attrs.set('underline', '4');
      else if (code === 7) this.attrs.set('inverse', '7');
      else if (code === 9) this.attrs.set('strike', '9');
      else if (code === 22) {
        this.attrs.delete('bold');
        this.attrs.delete('dim');
      } else if (code === 23) this.attrs.delete('italic');
      else if (code === 24) this.attrs.delete('underline');
      else if (code === 27) this.attrs.delete('inverse');
      else if (code === 29) this.attrs.delete('strike');
      else if (code === 39) this.attrs.delete('fg');
      else if (code === 49) this.attrs.delete('bg');
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.attrs.set('fg', String(code));
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.attrs.set('bg', String(code));
      else if (code === 38 || code === 48) {
        const key = code === 38 ? 'fg' : 'bg';
        if (codes[i + 1] === '5') {
          this.attrs.set(key, `${code};5;${codes[i + 2]}`);
          i += 2;
        } else if (codes[i + 1] === '2') {
          this.attrs.set(key, `${code};2;${codes[i + 2]};${codes[i + 3]};${codes[i + 4]}`);
          i += 4;
        }
      }
    }
  }

  open(): string {
    return this.attrs.size ? `${ESC}${[...this.attrs.values()].join(';')}m` : '';
  }

  close(): string {
    return this.attrs.size ? `${ESC}0m` : '';
  }
}

type Token = { kind: 'ansi'; text: string; sgr?: string } | { kind: 'char'; text: string; width: number };

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  ANSI_RE.lastIndex = 0;
  const pushText = (text: string) => {
    for (const g of graphemes(text)) tokens.push({ kind: 'char', text: g, width: graphemeWidth(g) });
  };
  for (let m = ANSI_RE.exec(s); m; m = ANSI_RE.exec(s)) {
    if (m.index > last) pushText(s.slice(last, m.index));
    const seq = m[0];
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(seq); // eslint-disable-line no-control-regex
    tokens.push(sgr ? { kind: 'ansi', text: seq, sgr: sgr[1] } : { kind: 'ansi', text: seq });
    last = m.index + seq.length;
  }
  if (last < s.length) pushText(s.slice(last));
  return tokens;
}

export interface WrapOptions {
  /** Prefix for the first line (counted against the width). */
  indent?: string;
  /** Prefix for continuation lines. Defaults to `indent`. */
  hangingIndent?: string;
  /** Break anywhere instead of at spaces (for code and paths). */
  hard?: boolean;
}

/**
 * Wrap a single logical line (no newlines) to `width` columns. ANSI styles
 * are carried across the break so each returned line is self-contained.
 * Breaks fall at spaces; a word longer than a whole row is split.
 */
export function wrapLine(line: string, width: number, opts: WrapOptions = {}): string[] {
  const indent = opts.indent ?? '';
  const hanging = opts.hangingIndent ?? indent;
  const firstAvail = Math.max(1, width - stringWidth(indent));
  const restAvail = Math.max(1, width - stringWidth(hanging));
  if (stringWidth(line) <= firstAvail) return [indent + line];

  const tokens = tokenize(line);
  const sgr = new SgrState();
  const lines: string[] = [];
  let cur = '';
  let curWidth = 0;
  /** Whether the current row holds anything other than spaces. */
  let hasInk = false;

  const avail = () => (lines.length === 0 ? firstAvail : restAvail);
  const breakLine = () => {
    // A row of nothing but leading spaces is dropped rather than emitted blank.
    // Hard wrapping is for code, where trailing spaces are content.
    const row = opts.hard ? cur : cur.replace(/ +$/, '');
    if (hasInk || lines.length > 0) lines.push((lines.length === 0 ? indent : hanging) + row + sgr.close());
    else if (stripAnsi(cur).trim() === '' && lines.length === 0) lines.push('\0skip');
    cur = sgr.open();
    curWidth = 0;
    hasInk = false;
  };
  const place = (tok: Token) => {
    if (tok.kind === 'ansi') {
      cur += tok.text;
      if (tok.sgr !== undefined) sgr.apply(tok.sgr);
      return;
    }
    // Never break before placing at least one character, or a too-wide glyph would loop forever.
    if (curWidth > 0 && curWidth + tok.width > avail()) breakLine();
    cur += tok.text;
    curWidth += tok.width;
    hasInk = true;
  };
  const isSpace = (tok: Token) => tok.kind === 'char' && tok.text === ' ';

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.kind === 'ansi') {
      place(tok);
      i++;
      continue;
    }
    if (opts.hard) {
      place(tok);
      i++;
      continue;
    }
    if (isSpace(tok)) {
      if (curWidth + 1 > avail()) breakLine();
      else if (curWidth > 0 || lines.length === 0) {
        cur += ' ';
        curWidth += 1;
      }
      i++;
      continue;
    }
    // Gather one word, including any style changes inside it.
    let j = i;
    let wordWidth = 0;
    while (j < tokens.length && !isSpace(tokens[j]!)) {
      const t = tokens[j]!;
      if (t.kind === 'char') wordWidth += t.width;
      j++;
    }
    if (curWidth + wordWidth > avail() && curWidth > 0) breakLine();
    // Fits on the (possibly new) row as a unit, or is longer than any row and gets split.
    for (let k = i; k < j; k++) place(tokens[k]!);
    i = j;
  }
  if (curWidth > 0 || lines.length === 0) lines.push((lines.length === 0 ? indent : hanging) + cur);
  else if (cur !== '' && stripAnsi(cur) === '') lines[lines.length - 1] += cur;

  // Remove the placeholder left when the first row held only spaces.
  if (lines[0] === '\0skip') {
    lines.shift();
    if (lines.length === 0) return [indent];
    lines[0] = indent + lines[0]!.slice(hanging.length);
  }
  return lines;
}

/** Wrap text that may contain newlines. */
export function wrapText(text: string, width: number, opts: WrapOptions = {}): string[] {
  const out: string[] = [];
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    const first = i === 0 ? (opts.indent ?? '') : (opts.hangingIndent ?? opts.indent ?? '');
    out.push(...wrapLine(expandTabs(parts[i]!), width, { ...opts, indent: first }));
  }
  return out;
}

/** Cut a string to at most `width` columns, appending an ellipsis if it was cut. */
export function truncate(s: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (stringWidth(s) <= width) return s;
  const target = Math.max(0, width - stringWidth(ellipsis));
  const sgr = new SgrState();
  let out = '';
  let w = 0;
  for (const tok of tokenize(s)) {
    if (tok.kind === 'ansi') {
      out += tok.text;
      if (tok.sgr !== undefined) sgr.apply(tok.sgr);
      continue;
    }
    if (w + tok.width > target) break;
    out += tok.text;
    w += tok.width;
  }
  return out + sgr.close() + ellipsis;
}

export function padEnd(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

export function expandTabs(s: string, tabSize = 4): string {
  if (!s.includes('\t')) return s;
  let out = '';
  let col = 0;
  for (const tok of tokenize(s)) {
    if (tok.kind === 'ansi') {
      out += tok.text;
    } else if (tok.text === '\t') {
      const n = tabSize - (col % tabSize);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += tok.text;
      col += tok.width;
    }
  }
  return out;
}

/** 12345 -> "12.3k". */
export function formatCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Context sizes are powers of two: 32768 reads better as "32k" than "33k". */
export function formatContext(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}k`;
  return formatCount(tokens);
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function plural(n: number, word: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? word : (pluralForm ?? word + 's')}`;
}
