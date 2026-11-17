/**
 * Terminal output in two parts: an append-only scrollback (finished content,
 * printed once and left to the terminal) and a "live region" at the bottom
 * that is erased and redrawn (streaming text, spinner, prompt, dialogs).
 */
import { truncate } from './ansi.ts';

const ESC = '\x1b[';
const SYNC_START = `${ESC}?2026h`;
const SYNC_END = `${ESC}?2026l`;

export interface Cursor {
  row: number;
  col: number;
}

export interface OutputStream {
  write(data: string): unknown;
  columns?: number;
  rows?: number;
}

export class Screen {
  private readonly out: OutputStream;
  private live: string[] = [];
  private cursor: Cursor | null = null;
  /** Rows between the top of the drawn live region and where the terminal cursor sits. */
  private drawnCursorRow = 0;
  private drawnHeight = 0;
  private pending: string[] = [];
  private scheduled: NodeJS.Timeout | null = null;
  private suspended = false;
  private cursorHidden = false;

  constructor(out: OutputStream = process.stdout) {
    this.out = out;
  }

  get columns(): number {
    return Math.max(20, this.out.columns ?? 80);
  }

  get rows(): number {
    return Math.max(6, this.out.rows ?? 24);
  }

  /** Width available for content: one column is kept free to avoid terminal auto-wrap. */
  get width(): number {
    return this.columns - 1;
  }

  /** Queue lines for the scrollback. They appear above the live region on the next render. */
  print(text: string | string[]): void {
    const lines = Array.isArray(text) ? text : text.split('\n');
    this.pending.push(...lines);
    this.schedule();
  }

  setLive(lines: string[], cursor: Cursor | null): void {
    this.live = lines;
    this.cursor = cursor;
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.suspended) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.render();
    }, 16);
  }

  /** Draw now. Safe to call at any time. */
  render(): void {
    if (this.suspended) return;
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
    const width = this.width;
    let out = SYNC_START;

    // Go to the top of the previous live region and erase it.
    if (this.drawnCursorRow > 0) out += `${ESC}${this.drawnCursorRow}A`;
    out += `\r${ESC}J`;

    if (this.pending.length) {
      out += this.pending.join('\n') + '\n';
      this.pending = [];
    }

    // The live region must fit on screen or relative cursor movement breaks.
    const maxRows = this.rows - 1;
    let lines = this.live.map((l) => truncate(l, width));
    let cursor = this.cursor;
    if (lines.length > maxRows) {
      const drop = lines.length - maxRows;
      lines = lines.slice(drop);
      if (cursor) cursor = { row: Math.max(0, cursor.row - drop), col: cursor.col };
    }

    out += lines.join('\n');
    const lastRow = Math.max(0, lines.length - 1);
    if (cursor) {
      const row = Math.min(cursor.row, lastRow);
      const up = lastRow - row;
      if (up > 0) out += `${ESC}${up}A`;
      out += '\r';
      const col = Math.min(cursor.col, width);
      if (col > 0) out += `${ESC}${col}C`;
      if (this.cursorHidden) out += `${ESC}?25h`;
      this.cursorHidden = false;
      this.drawnCursorRow = row;
    } else {
      if (!this.cursorHidden) out += `${ESC}?25l`;
      this.cursorHidden = true;
      this.drawnCursorRow = lastRow;
    }
    this.drawnHeight = lines.length;
    out += SYNC_END;
    this.out.write(out);
  }

  /** Clear the whole terminal, including scrollback (/clear, ctrl+l). */
  clearAll(): void {
    this.pending = [];
    this.out.write(`${ESC}2J${ESC}3J${ESC}H`);
    this.drawnCursorRow = 0;
    this.drawnHeight = 0;
    this.render();
  }

  /** Hand the terminal to another program (an editor, a pager). */
  suspend(): void {
    this.render();
    const down = this.drawnHeight - 1 - this.drawnCursorRow;
    let out = '';
    if (this.drawnCursorRow > 0) out += `${ESC}${this.drawnCursorRow}A`;
    out += `\r${ESC}J${ESC}?25h`;
    void down;
    this.out.write(out);
    this.drawnCursorRow = 0;
    this.drawnHeight = 0;
    this.cursorHidden = false;
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
    this.render();
  }

  /** Leave the terminal clean on exit: live region removed, cursor visible. */
  close(): void {
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.live = [];
    this.cursor = null;
    this.suspended = false;
    this.render();
    this.out.write(`${ESC}?25h`);
    this.cursorHidden = false;
    this.suspended = true;
  }
}
