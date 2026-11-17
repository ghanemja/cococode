/**
 * The prompt editor: a multi-line text buffer with a cursor, kill ring, undo,
 * history (with incremental search), a stash and collapsed pastes. Pure
 * state, no terminal I/O, so it can be tested by feeding it operations.
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
/** Undo steps kept; the oldest are dropped beyond this. */
const UNDO_LIMIT = 100;
/** A pause this long between keystrokes starts a new undo step. */
const UNDO_PAUSE_MS = 1000;

/** What undo, the stash and a cancelled search put back. */
interface Snapshot {
  text: string;
  cursor: number;
  historyIndex: number;
  pastes: Map<string, string>;
}

/** Edits that merge with the one before: a run of typing or of deleting is one undo step. */
type EditKind = 'type' | 'backspace' | 'delete';

/** A reverse history search in progress, as the UI shows it. */
export interface EditorSearch {
  query: string;
  /** The history entry found (also previewed in the buffer), or null when nothing contains the query. */
  match: string | null;
  /** An older match was asked for and there is none. */
  exhausted: boolean;
}

export interface EditorOptions {
  /** Clock used to group keystrokes into undo steps. Replaceable in tests. */
  now?: () => number;
}

export class Editor {
  text = '';
  cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = '';
  private killed = '';
  private pastes = new Map<string, string>();
  private pasteCount = 0;
  private readonly now: () => number;
  private undoStack: Snapshot[] = [];
  private lastEdit: { kind: EditKind; text: string; cursor: number; at: number } | null = null;
  private stashed: Snapshot[] = [];
  private searchState: { query: string; index: number; exhausted: boolean; saved: Snapshot } | null = null;
  private lastQuery = '';

  constructor(opts: EditorOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  setHistory(entries: string[]): void {
    this.history = entries.filter((e) => e.trim() !== '');
    this.historyIndex = -1;
  }

  addHistory(entry: string): void {
    // Store what was actually sent: a recalled placeholder would have lost its paste.
    const e = this.expand(entry).trim();
    if (!e || this.history[this.history.length - 1] === e) return;
    this.history.push(e);
  }

  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  /** The text to submit, with collapsed pastes expanded. */
  value(): string {
    return this.expand(this.text);
  }

  /** Replace paste placeholders by their content, in one pass so pasted text is never re-scanned. */
  private expand(text: string): string {
    if (this.pastes.size === 0) return text;
    return text.replace(/\[Pasted text #\d+ \+\d+ lines\]/g, (token) => this.pastes.get(token) ?? token);
  }

  /** Load text as a new starting point, cursor at the end. Undo does not go back past it. */
  set(text: string): void {
    this.load(text);
    this.forgetUndo();
    this.searchState = null;
  }

  private load(text: string): void {
    this.text = text;
    this.cursor = text.length;
  }

  /** Start over after a submit: nothing of the old prompt is left, not even for undo. */
  clear(): void {
    this.text = '';
    this.cursor = 0;
    this.historyIndex = -1;
    this.pastes.clear();
    this.forgetUndo();
    this.searchState = null;
  }

  /** Empty the prompt as an edit: unlike clear(), undo brings the text back. */
  discard(): void {
    this.edit(null, () => {
      this.text = '';
      this.cursor = 0;
      this.historyIndex = -1;
    });
  }

  // --------------------------------------------------------------------- undo

  private snapshot(): Snapshot {
    return { text: this.text, cursor: this.cursor, historyIndex: this.historyIndex, pastes: new Map(this.pastes) };
  }

  private restore(snap: Snapshot): void {
    this.text = snap.text;
    this.cursor = snap.cursor;
    this.historyIndex = snap.historyIndex;
    // Pastes are only ever added back: a placeholder that is still in the kill ring must keep its content.
    for (const [token, content] of snap.pastes) this.pastes.set(token, content);
  }

  private forgetUndo(): void {
    this.undoStack = [];
    this.lastEdit = null;
  }

  /**
   * Make one change to the buffer, remembering the state before it for undo().
   * A change of the same `kind` as the one just before it, continuing where
   * that one stopped and without a pause, joins its undo step; with no kind
   * the change is always a step of its own.
   */
  private edit(kind: EditKind | null, change: () => void): void {
    const before = this.snapshot();
    const last = this.lastEdit;
    const at = this.now();
    const joins = kind !== null && last !== null && last.kind === kind && last.cursor === before.cursor && last.text === before.text && at - last.at < UNDO_PAUSE_MS;
    change();
    if (this.text === before.text) return; // nothing changed, so there is nothing to undo
    if (!joins) {
      this.undoStack.push(before);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    }
    this.lastEdit = kind ? { kind, text: this.text, cursor: this.cursor, at } : null;
  }

  /** Whether undo() has a step to go back to. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Go back to before the last edit. Returns false when there is nothing to undo. */
  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.restore(snap);
    this.lastEdit = null;
    return true;
  }

  // ------------------------------------------------------------------ editing

  private insertRaw(s: string): void {
    const clean = s.replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
    this.text = this.text.slice(0, this.cursor) + clean + this.text.slice(this.cursor);
    this.cursor += clean.length;
  }

  /** Typed text. Consecutive calls are one undo step. */
  insert(s: string): void {
    this.edit('type', () => this.insertRaw(s));
  }

  /** Large pastes are shown as a placeholder so the prompt stays readable. */
  paste(s: string): void {
    const clean = s.replace(/\r\n?/g, '\n');
    const lines = clean.split('\n').length;
    this.edit(null, () => {
      if (lines > PASTE_LINES || clean.length > PASTE_CHARS) {
        const token = `[Pasted text #${++this.pasteCount} +${lines} lines]`;
        this.pastes.set(token, clean);
        this.insertRaw(token);
      } else {
        this.insertRaw(clean);
      }
    });
  }

  /**
   * Swap the whole buffer for `text` as one edit (what came back from an
   * external editor). A collapsed paste that is still there word for word
   * keeps its placeholder.
   */
  replaceAll(text: string): void {
    let next = text.replace(/\r\n?/g, '\n');
    for (const [token, content] of this.pastes) {
      if (!this.text.includes(token)) continue;
      const at = next.indexOf(content);
      if (at >= 0) next = next.slice(0, at) + token + next.slice(at + content.length);
    }
    next = next.replace(/\t/g, '  ');
    this.edit(null, () => {
      this.load(next);
      this.historyIndex = -1;
    });
  }

  /** The collapsed paste whose placeholder ends (or starts) at `pos`: placeholders are removed whole. */
  private pasteAt(pos: number, side: 'before' | 'after'): string | undefined {
    for (const token of this.pastes.keys()) {
      if (side === 'before' ? this.text.endsWith(token, pos) : this.text.startsWith(token, pos)) return token;
    }
    return undefined;
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
    this.edit('backspace', () => {
      // A collapsed paste is deleted as a unit.
      const token = this.pasteAt(this.cursor, 'before');
      if (token) this.pastes.delete(token);
      const prev = token ? this.cursor - token.length : this.prevBoundary(this.cursor);
      this.text = this.text.slice(0, prev) + this.text.slice(this.cursor);
      this.cursor = prev;
    });
  }

  del(): void {
    if (this.cursor >= this.text.length) return;
    this.edit('delete', () => {
      const next = this.nextBoundary(this.cursor);
      this.text = this.text.slice(0, this.cursor) + this.text.slice(next);
    });
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

  /** Index where the logical line containing the cursor starts. */
  private lineStart(): number {
    // lastIndexOf clamps a negative start to 0, which would find a newline at index 0.
    return this.cursor === 0 ? 0 : this.text.lastIndexOf('\n', this.cursor - 1) + 1;
  }

  /** Start of the current logical line. */
  home(): void {
    this.cursor = this.lineStart();
  }

  end(): void {
    const nl = this.text.indexOf('\n', this.cursor);
    this.cursor = nl < 0 ? this.text.length : nl;
  }

  /** Remove [start, end) and remember it for yank. Killing nothing keeps the previous kill. */
  private kill(start: number, end: number): void {
    if (end <= start) return;
    this.edit(null, () => {
      this.killed = this.text.slice(start, end);
      this.text = this.text.slice(0, start) + this.text.slice(end);
      this.cursor = start;
    });
  }

  killToEnd(): void {
    const nl = this.text.indexOf('\n', this.cursor);
    // At the end of a line, kill the line break itself (joining the lines).
    const end = nl < 0 ? this.text.length : nl === this.cursor ? nl + 1 : nl;
    this.kill(this.cursor, end);
  }

  killToStart(): void {
    this.kill(this.lineStart(), this.cursor);
  }

  killWordBack(): void {
    const end = this.cursor;
    let start = end;
    while (start > 0 && /\s/.test(this.text[start - 1]!)) start--;
    // A placeholder has spaces in it but is one word: half of one would be sent as it stands.
    const token = this.pasteAt(start, 'before');
    if (token) start -= token.length;
    else while (start > 0 && !/\s/.test(this.text[start - 1]!)) start--;
    this.kill(start, end);
  }

  /** Kill from the cursor to the end of the next word. */
  killWordForward(): void {
    let end = this.cursor;
    while (end < this.text.length && /\s/.test(this.text[end]!)) end++;
    const token = this.pasteAt(end, 'after');
    if (token) end += token.length;
    else while (end < this.text.length && !/\s/.test(this.text[end]!)) end++;
    this.kill(this.cursor, end);
  }

  yank(): void {
    if (this.killed) this.edit(null, () => this.insertRaw(this.killed));
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
    // On a soft-wrapped row the position after its last character is the start
    // of the next row, so the cursor may go no further than before that character.
    const softWrapped = target + 1 < rows.length && rows[target + 1]!.start === row.end;
    const parts = graphemes(this.text.slice(row.start, row.end));
    const limit = softWrapped ? parts.length - 1 : parts.length;
    let pos = row.start;
    let w = 0;
    for (let i = 0; i < limit; i++) {
      const gw = graphemeWidth(parts[i]!);
      if (w + gw > col) break;
      w += gw;
      pos += parts[i]!.length;
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

  /** Recall the entry before the current one. Each recall is an undo step. */
  historyPrev(): boolean {
    if (this.history.length === 0 || this.historyIndex === 0) return false;
    this.edit(null, () => {
      if (this.historyIndex === -1) {
        this.draft = this.text;
        this.historyIndex = this.history.length;
      }
      this.historyIndex--;
      this.load(this.history[this.historyIndex]!);
    });
    return true;
  }

  historyNext(): boolean {
    if (this.historyIndex === -1) return false;
    this.edit(null, () => {
      this.historyIndex++;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1;
        this.load(this.draft);
      } else {
        this.load(this.history[this.historyIndex]!);
      }
    });
    return true;
  }

  // ----------------------------------------------------------- history search

  /** The reverse search in progress, or null. */
  get search(): EditorSearch | null {
    const s = this.searchState;
    if (!s) return null;
    return { query: s.query, match: s.index >= 0 ? this.history[s.index]! : null, exhausted: s.exhausted };
  }

  /** Begin a reverse search through history. The prompt is kept aside until the search ends. */
  searchStart(): void {
    if (this.searchState) return;
    this.searchState = { query: '', index: -1, exhausted: false, saved: this.snapshot() };
  }

  /** Newest entry at or before `start` that contains the query, ignoring case; -1 when there is none. */
  private searchFrom(start: number, skip?: string): number {
    const query = this.searchState!.query.toLowerCase();
    for (let i = Math.min(start, this.history.length - 1); i >= 0; i--) {
      const entry = this.history[i]!;
      if (entry !== skip && entry.toLowerCase().includes(query)) return i;
    }
    return -1;
  }

  /** Preview the match in the buffer; with none, show the prompt the search started from. */
  private searchShow(index: number): void {
    const s = this.searchState!;
    s.index = index;
    if (index >= 0) {
      this.load(this.history[index]!);
    } else {
      this.text = s.saved.text;
      this.cursor = s.saved.cursor;
    }
  }

  /** Add typed text to the query: the match becomes the newest entry containing all of it. */
  searchInput(text: string): void {
    const s = this.searchState;
    const added = text.replace(/\s+/g, ' ');
    if (!s || !added) return;
    s.query += added;
    s.exhausted = false;
    this.searchShow(this.searchFrom(this.history.length - 1));
  }

  /** Remove the last character of the query; the match is again the newest entry containing it. */
  searchBackspace(): void {
    const s = this.searchState;
    if (!s || !s.query) return;
    s.query = graphemes(s.query).slice(0, -1).join('');
    s.exhausted = false;
    this.searchShow(s.query ? this.searchFrom(this.history.length - 1) : -1);
  }

  /** Move to the next older entry containing the query (a different one from what is shown). */
  searchOlder(): void {
    const s = this.searchState;
    if (!s) return;
    if (!s.query) {
      // As in readline: asking again with nothing typed repeats the previous search.
      if (!this.lastQuery) return;
      s.query = this.lastQuery;
      this.searchShow(this.searchFrom(this.history.length - 1));
      return;
    }
    if (s.index < 0) return;
    const older = this.searchFrom(s.index - 1, this.history[s.index]);
    if (older < 0) s.exhausted = true;
    else this.searchShow(older);
  }

  private searchEnd(): void {
    const s = this.searchState!;
    this.searchState = null;
    if (s.query) this.lastQuery = s.query;
    this.text = s.saved.text;
    this.cursor = s.saved.cursor;
  }

  /**
   * End the search with the match as the prompt, as one undo step back to
   * what was there before. Like a recalled entry, up and down continue from
   * it. Returns false, with the old prompt back, when there was no match.
   */
  searchAccept(): boolean {
    const s = this.searchState;
    if (!s) return false;
    this.searchEnd();
    if (s.index < 0) return false;
    this.edit(null, () => {
      if (this.historyIndex === -1) this.draft = this.text;
      this.historyIndex = s.index;
      this.load(this.history[s.index]!);
    });
    return true;
  }

  /** End the search and put back what was in the prompt. */
  searchCancel(): void {
    if (this.searchState) this.searchEnd();
  }

  // -------------------------------------------------------------------- stash

  /** Number of prompts set aside. */
  get stashCount(): number {
    return this.stashed.length;
  }

  /** Set the prompt aside and empty the buffer. Returns false when there is nothing to set aside. */
  stash(): boolean {
    if (this.isEmpty) return false;
    this.searchCancel();
    this.stashed.push(this.snapshot());
    this.clear();
    return true;
  }

  /** Bring the most recently stashed prompt back. Only into an empty buffer, so nothing is overwritten. */
  unstash(): boolean {
    if (!this.isEmpty || this.stashed.length === 0) return false;
    this.restore(this.stashed.pop()!);
    this.historyIndex = -1;
    this.forgetUndo();
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
    this.edit(null, () => {
      this.text = this.text.slice(0, start) + replacement + this.text.slice(this.cursor);
      this.cursor = start + replacement.length;
    });
  }
}
