/**
 * Terminal output in two parts: an append-only scrollback (finished content,
 * printed once and left to the terminal) and a "live region" at the bottom
 * that is erased and redrawn (streaming text, spinner, prompt, dialogs).
 */
import { expandTabs, truncate } from './ansi.ts';

const ESC = '\x1b[';
const SYNC_START = `${ESC}?2026h`;
const SYNC_END = `${ESC}?2026l`;

// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\x00-\x1f\x7f-\x9f]/;
// Sticky patterns, matched at a given index.
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;:]*m/y;
// CSI, OSC (ended by BEL or ST), or ESC plus one character.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[\s\S])?/y;

/**
 * Make one row safe to draw. Tool output can contain carriage returns, tabs
 * and cursor-movement sequences; any of those would move the terminal cursor
 * behind our back and corrupt the live region. Colours (SGR) are kept, tabs
 * become spaces and every other control sequence is dropped.
 */
export function sanitizeLine(line: string): string {
  if (!HAS_CONTROL.test(line)) return line;
  const text = line.includes('\t') ? expandTabs(line) : line;
  let out = '';
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      SGR.lastIndex = i;
      const sgr = SGR.exec(text);
      if (sgr) {
        out += sgr[0];
        i += sgr[0].length;
      } else {
        ESCAPE.lastIndex = i;
        i += ESCAPE.exec(text)![0].length;
      }
    } else if (code === 0x0a) {
      out += ' '; // a row cannot contain a line break
      i++;
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      i++;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

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
    for (const chunk of Array.isArray(text) ? text : [text]) {
      for (const line of chunk.split('\n')) this.pending.push(sanitizeLine(line));
    }
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
    let lines = this.live.map((l) => truncate(sanitizeLine(l), width));
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
    out += SYNC_END;
    this.out.write(out);
  }

  /** Clear the whole terminal, including scrollback (/clear, ctrl+l). */
  clearAll(): void {
    this.pending = [];
    if (this.suspended) return; // the terminal belongs to another program right now
    this.out.write(`${ESC}2J${ESC}3J${ESC}H`);
    this.drawnCursorRow = 0;
    this.render();
  }

  /** Hand the terminal to another program (an editor, a pager). */
  suspend(): void {
    if (this.suspended) return;
    this.render();
    let out = '';
    if (this.drawnCursorRow > 0) out += `${ESC}${this.drawnCursorRow}A`;
    out += `\r${ESC}J${ESC}?25h`;
    this.out.write(out);
    this.drawnCursorRow = 0;
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
