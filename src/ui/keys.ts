/**
 * Decodes raw terminal input into key events. Handles CSI/SS3 sequences,
 * modifier encodings (xterm, kitty, modifyOtherKeys), Alt-prefixed keys and
 * bracketed paste, including sequences split across reads. Two-key chords
 * are tracked with ChordPrefix.
 */

export interface Key {
  /** "char" for text, "paste" for pasted text, otherwise a key name. */
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** Printable text for name "char"; pasted text for name "paste". */
  text?: string;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** Longest escape sequence we wait for before giving up on it. */
const MAX_SEQUENCE = 64;

const CSI_FINAL: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'tab', // shift+tab; shift is set below
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

const TILDE_CODES: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

function key(name: string, mods: Partial<Key> = {}): Key {
  return { name, ctrl: false, meta: false, shift: false, ...mods };
}

/** Decode a modifier parameter ("5", or kitty's "5:1"); 1 means none. */
function modifiers(param: string | undefined): Pick<Key, 'ctrl' | 'meta' | 'shift'> {
  const code = Number.parseInt(param ?? '1', 10);
  const bits = Number.isFinite(code) ? Math.max(0, code - 1) : 0;
  return { shift: (bits & 1) !== 0, meta: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

/** Name of the key that produces a C0 control code together with ctrl. */
function controlName(code: number): string {
  // ctrl+a..z are 1..26; 28..31 are ctrl+\ ] ^ _
  return String.fromCharCode(code <= 26 ? code + 96 : code + 64);
}

function fromCodepoint(cp: number, mods: Pick<Key, 'ctrl' | 'meta' | 'shift'>): Key {
  if (cp === 13) return key('return', mods);
  if (cp === 9) return key('tab', mods);
  if (cp === 27) return key('escape', mods);
  if (cp === 127 || cp === 8) return key('backspace', mods);
  if (cp === 32) return mods.ctrl || mods.meta ? key('space', mods) : key('char', { ...mods, text: ' ' });
  const ch = String.fromCodePoint(cp);
  if (mods.ctrl || mods.meta) return key(ch.toLowerCase(), mods);
  return key('char', { ...mods, text: ch });
}

/** How long a chord prefix waits for its second key. */
export const CHORD_TIMEOUT_MS = 1500;

/**
 * The first key of a two-key chord (ctrl+x, waiting for ctrl+e). It is
 * short-lived: the very next key either completes the chord or is an
 * ordinary key again, and a prefix nobody followed up on lapses by itself.
 */
export class ChordPrefix {
  private armedAt: number | null = null;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = CHORD_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /** The prefix key was pressed. */
  arm(now: number = Date.now()): void {
    this.armedAt = now;
  }

  /** Whether the prefix is waiting for its second key at this moment. */
  pending(now: number = Date.now()): boolean {
    return this.armedAt !== null && now - this.armedAt <= this.timeoutMs;
  }

  /** Call once for every key: true when that key directly follows the prefix. The prefix is used up either way. */
  take(now: number = Date.now()): boolean {
    const armed = this.pending(now);
    this.armedAt = null;
    return armed;
  }
}

export class KeyParser {
  private buffer = '';
  private pasting = false;
  private pasteBuffer = '';

  /** True when input ended in the middle of a possible escape sequence. */
  get pending(): boolean {
    return this.buffer.length > 0 && !this.pasting;
  }

  /** Called after a short timeout: whatever is buffered was typed, not a sequence. */
  flush(): Key[] {
    if (this.pasting || this.buffer === '') return [];
    const rest = this.buffer;
    this.buffer = '';
    if (rest === '\x1b') return [key('escape')];
    // An unrecognised sequence: surface the escape, then treat the rest as input.
    return [key('escape'), ...this.feed(rest.slice(1))];
  }

  feed(data: string): Key[] {
    const keys: Key[] = [];
    this.buffer += data;

    for (;;) {
      if (this.pasting) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end < 0) {
          // Keep a possible partial terminator in the buffer.
          const keep = Math.min(this.buffer.length, PASTE_END.length - 1);
          this.pasteBuffer += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          return keys;
        }
        this.pasteBuffer += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        this.pasting = false;
        keys.push(key('paste', { text: this.pasteBuffer.replace(/\r\n?/g, '\n') }));
        this.pasteBuffer = '';
        continue;
      }
      if (this.buffer === '') return keys;

      if (this.buffer.startsWith(PASTE_START)) {
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.pasting = true;
        continue;
      }

      const ch = this.buffer[0]!;
      if (ch === '\x1b') {
        const consumed = this.parseEscape(keys);
        if (consumed === 0) return keys; // incomplete: wait for more or for flush()
        this.buffer = this.buffer.slice(consumed);
        continue;
      }

      const code = ch.charCodeAt(0);
      if (code < 32 || code === 127) {
        this.buffer = this.buffer.slice(1);
        if (ch === '\r') keys.push(key('return'));
        else if (ch === '\n') keys.push(key('j', { ctrl: true }));
        else if (ch === '\t') keys.push(key('tab'));
        else if (code === 127 || code === 8) keys.push(key('backspace'));
        else if (code === 0) keys.push(key('space', { ctrl: true }));
        else keys.push(key(controlName(code), { ctrl: true }));
        continue;
      }

      // A run of printable characters arrives as one event (fast typing, unbracketed paste).
      let end = 1;
      while (end < this.buffer.length) {
        const c = this.buffer.charCodeAt(end);
        if (c < 32 || c === 127 || c === 27) break;
        end++;
      }
      keys.push(key('char', { text: this.buffer.slice(0, end) }));
      this.buffer = this.buffer.slice(end);
    }
  }

  /** Parse an escape sequence at the start of the buffer. Returns chars consumed, 0 if incomplete. */
  private parseEscape(keys: Key[]): number {
    const buf = this.buffer;
    if (buf.length === 1) return 0;
    const next = buf[1]!;

    if (next === '[') {
      // CSI: parameter bytes (0-9 : ; < = > ?), intermediate bytes (space to /), then a final byte (@ to ~).
      let i = 2;
      while (i < buf.length && buf.charCodeAt(i) >= 0x30 && buf.charCodeAt(i) <= 0x3f) i++;
      const paramEnd = i;
      while (i < buf.length && buf.charCodeAt(i) >= 0x20 && buf.charCodeAt(i) <= 0x2f) i++;
      // Incomplete: wait for the rest, unless it is absurdly long (then drop it).
      if (i >= buf.length) return buf.length > MAX_SEQUENCE ? buf.length : 0;
      const finalCode = buf.charCodeAt(i);
      // Not a valid sequence: drop what was scanned and reparse from the odd byte.
      if (finalCode < 0x40 || finalCode > 0x7e) return i;
      const consumed = i + 1;
      // Sequences with intermediate bytes are terminal reports, never keys.
      if (i > paramEnd) return consumed;
      const final = buf[i]!;
      const params = buf.slice(2, paramEnd).split(';');
      if (final === '~') {
        // modifyOtherKeys: CSI 27 ; mod ; code ~
        if (params[0] === '27' && params.length >= 3) {
          const cp = Number.parseInt(params[2]!, 10);
          if (Number.isFinite(cp) && cp > 0) keys.push(fromCodepoint(cp, modifiers(params[1])));
          return consumed;
        }
        const name = TILDE_CODES[params[0]!];
        if (name) keys.push(key(name, modifiers(params[1])));
        return consumed;
      }
      if (final === 'u') {
        // kitty: CSI code ; mod u
        const cp = Number.parseInt(params[0]!, 10);
        if (Number.isFinite(cp) && cp > 0) keys.push(fromCodepoint(cp, modifiers(params[1])));
        return consumed;
      }
      const name = CSI_FINAL[final];
      if (name) {
        const mods = modifiers(params[1]);
        if (final === 'Z') mods.shift = true;
        keys.push(key(name, mods));
      }
      return consumed; // unknown CSI sequences are swallowed
    }

    if (next === 'O') {
      if (buf.length < 3) return 0;
      const name = CSI_FINAL[buf[2]!];
      if (name) keys.push(key(name));
      return 3;
    }

    if (next === '\x1b') {
      // ESC ESC: report one escape and reparse from the second.
      keys.push(key('escape'));
      return 1;
    }

    // Alt + key
    const code = next.charCodeAt(0);
    if (next === '\r') keys.push(key('return', { meta: true }));
    else if (next === '\t') keys.push(key('tab', { meta: true }));
    else if (code === 127 || code === 8) keys.push(key('backspace', { meta: true }));
    else if (code === 0) keys.push(key('space', { ctrl: true, meta: true }));
    else if (code < 32) keys.push(key(controlName(code), { ctrl: true, meta: true }));
    else {
      const cp = buf.codePointAt(1)!;
      const text = String.fromCodePoint(cp);
      keys.push(key(text.toLowerCase(), { meta: true, shift: text !== text.toLowerCase() }));
      return 1 + text.length;
    }
    return 2;
  }
}
