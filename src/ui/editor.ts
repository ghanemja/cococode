/**
 * The prompt editor: a multi-line text buffer with a cursor, kill ring,
 * history and collapsed pastes. Pure state, no terminal I/O, so it can be
 * tested by feeding it operations.
 */
import { graphemeWidth, graphemes, stringWidth } from './ansi.ts';

export interface EditorLayout {
  /** Visual rows after wrapping, without any prompt prefix. */
  rows: string[];
  cursorRow: number;
  cursorCol: number;
}

interface Row {
  start: number;
  end: number;
}

const PASTE_LINES = 6;
const PASTE_CHARS = 800;

export class Editor {
  text = '';
  cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = '';
  private killed = '';
  private pastes = new Map<string, string>();
  private pasteCount = 0;

  setHistory(entries: string[]): void {
    this.history = entries.filter((e) => e.trim() !== '');
    this.historyIndex = -1;
  }

  addHistory(entry: string): void {
    const e = entry.trim();
    if (!e || this.history[this.history.length - 1] === e) return;
    this.history.push(e);
  }

  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  /** The text to submit, with collapsed pastes expanded. */
  value(): string {
    let out = this.text;
    for (const [token, content] of this.pastes) out = out.split(token).join(content);
    return out;
  }

  set(text: string): void {
    this.text = text;
    this.cursor = text.length;
  }

  clear(): void {
    this.text = '';
    this.cursor = 0;
    this.historyIndex = -1;
    this.pastes.clear();
  }

  insert(s: string): void {
    const clean = s.replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
    this.text = this.text.slice(0, this.cursor) + clean + this.text.slice(this.cursor);
    this.cursor += clean.length;
  }

  /** Large pastes are shown as a placeholder so the prompt stays readable. */
  paste(s: string): void {
    const clean = s.replace(/\r\n?/g, '\n');
    const lines = clean.split('\n').length;
    if (lines > PASTE_LINES || clean.length > PASTE_CHARS) {
      const token = `[Pasted text #${++this.pasteCount} +${lines} lines]`;
      this.pastes.set(token, clean);
      this.insert(token);
    } else {
      this.insert(clean);
    }
  }

  private prevBoundary(pos: number): number {
    if (pos <= 0) return 0;
    const before = graphemes(this.text.slice(Math.max(0, pos - 32), pos));
    return pos - (before[before.length - 1]?.length ?? 1);
  }

  private nextBoundary(pos: number): number {
    if (pos >= this.text.length) return this.text.length;
    const after = graphemes(this.text.slice(pos, pos + 32));
    return pos + (after[0]?.length ?? 1);
  }

  backspace(): void {
    if (this.cursor === 0) return;
    // A collapsed paste is deleted as a unit.
    for (const token of this.pastes.keys()) {
      if (this.text.slice(0, this.cursor).endsWith(token)) {
        this.text = this.text.slice(0, this.cursor - token.length) + this.text.slice(this.cursor);
        this.cursor -= token.length;
        this.pastes.delete(token);
        return;
      }
    }
    const prev = this.prevBoundary(this.cursor);
    this.text = this.text.slice(0, prev) + this.text.slice(this.cursor);
    this.cursor = prev;
  }

  del(): void {
    if (this.cursor >= this.text.length) return;
    const next = this.nextBoundary(this.cursor);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(next);
  }

  left(): void {
    this.cursor = this.prevBoundary(this.cursor);
  }

  right(): void {
    this.cursor = this.nextBoundary(this.cursor);
  }

  wordLeft(): void {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.text[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(this.text[i - 1]!)) i--;
    this.cursor = i;
  }

  wordRight(): void {
    let i = this.cursor;
    while (i < this.text.length && /\s/.test(this.text[i]!)) i++;
    while (i < this.text.length && !/\s/.test(this.text[i]!)) i++;
    this.cursor = i;
  }

  /** Start of the current logical line. */
  home(): void {
    this.cursor = this.text.lastIndexOf('\n', this.cursor - 1) + 1;
  }

  end(): void {
    const nl = this.text.indexOf('\n', this.cursor);
    this.cursor = nl < 0 ? this.text.length : nl;
  }

  killToEnd(): void {
    const nl = this.text.indexOf('\n', this.cursor);
    const end = nl < 0 ? this.text.length : nl === this.cursor ? nl + 1 : nl;
    this.killed = this.text.slice(this.cursor, end);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }

  killToStart(): void {
    const start = this.text.lastIndexOf('\n', this.cursor - 1) + 1;
    this.killed = this.text.slice(start, this.cursor);
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  killWordBack(): void {
    const end = this.cursor;
    this.wordLeft();
    this.killed = this.text.slice(this.cursor, end);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }

  yank(): void {
    if (this.killed) this.insert(this.killed);
  }

  /** Split the buffer into visual rows of at most `width` columns. */
  private layoutRows(width: number): Row[] {
    const rows: Row[] = [];
    const w = Math.max(1, width);
    let pos = 0;
    for (const line of this.text.split('\n')) {
      let rowStart = pos;
      let col = 0;
      let offset = pos;
      for (const g of graphemes(line)) {
        const gw = graphemeWidth(g);
        if (col + gw > w && col > 0) {
          rows.push({ start: rowStart, end: offset });
          rowStart = offset;
          col = 0;
        }
        col += gw;
        offset += g.length;
      }
      rows.push({ start: rowStart, end: offset });
      pos += line.length + 1;
    }
    return rows;
  }

  private rowOfCursor(rows: Row[]): number {
    for (let r = rows.length - 1; r >= 0; r--) {
      if (this.cursor >= rows[r]!.start) return r;
    }
    return 0;
  }

  layout(width: number): EditorLayout {
    const rows = this.layoutRows(width);
    let cursorRow = this.rowOfCursor(rows);
    let row = rows[cursorRow]!;
    let cursorCol = stringWidth(this.text.slice(row.start, this.cursor));
    // The cursor sitting exactly at a soft-wrap point belongs at the start of the next row.
    if (cursorCol >= Math.max(1, width) && cursorRow + 1 < rows.length && rows[cursorRow + 1]!.start === this.cursor) {
      cursorRow++;
      row = rows[cursorRow]!;
      cursorCol = 0;
    }
    return { rows: rows.map((r) => this.text.slice(r.start, r.end)), cursorRow, cursorCol };
  }

  private moveVertical(width: number, delta: -1 | 1): boolean {
    const rows = this.layoutRows(width);
    const current = this.rowOfCursor(rows);
    const target = current + delta;
    if (target < 0 || target >= rows.length) return false;
    const col = stringWidth(this.text.slice(rows[current]!.start, this.cursor));
    const row = rows[target]!;
    let pos = row.start;
    let w = 0;
    for (const g of graphemes(this.text.slice(row.start, row.end))) {
      const gw = graphemeWidth(g);
      if (w + gw > col) break;
      w += gw;
      pos += g.length;
    }
    this.cursor = pos;
    return true;
  }

  /** Move up a visual row. Returns false at the top, where the caller may go to history. */
  up(width: number): boolean {
    return this.moveVertical(width, -1);
  }

  down(width: number): boolean {
    return this.moveVertical(width, 1);
  }

  historyPrev(): boolean {
    if (this.history.length === 0) return false;
    if (this.historyIndex === -1) {
      this.draft = this.text;
      this.historyIndex = this.history.length;
    }
    if (this.historyIndex === 0) return false;
    this.historyIndex--;
    this.set(this.history[this.historyIndex]!);
    return true;
  }

  historyNext(): boolean {
    if (this.historyIndex === -1) return false;
    this.historyIndex++;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = -1;
      this.set(this.draft);
    } else {
      this.set(this.history[this.historyIndex]!);
    }
    return true;
  }

  /** The token being typed at the cursor, for completion: "/cmd" or "@path". */
  completionToken(): { kind: 'command' | 'file'; query: string; start: number } | null {
    const before = this.text.slice(0, this.cursor);
    if (/^\/[^\s/]*$/.test(before)) return { kind: 'command', query: before.slice(1), start: 0 };
    const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (at) return { kind: 'file', query: at[1]!, start: this.cursor - at[1]!.length - 1 };
    return null;
  }

  /** Replace the text from `start` to the cursor (used to accept a completion). */
  replaceRange(start: number, replacement: string): void {
    this.text = this.text.slice(0, start) + replacement + this.text.slice(this.cursor);
    this.cursor = start + replacement.length;
  }
}
