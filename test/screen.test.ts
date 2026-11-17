import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { c, setColorEnabled } from '../src/ui/ansi.ts';
import type { Cursor } from '../src/ui/screen.ts';
import { Screen, sanitizeLine } from '../src/ui/screen.ts';

/**
 * A minimal terminal: a grid, a cursor and the handful of sequences Screen
 * uses. Line feed also returns the carriage, as the tty driver does for a
 * real terminal (ONLCR stays on in Node's raw mode).
 */
class FakeTerminal {
  columns: number;
  rows: number;
  grid: string[][];
  /** Rows that scrolled off the top. */
  history: string[] = [];
  row = 0;
  col = 0;
  cursorVisible = true;
  written = '';
  private pendingWrap = false;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => this.blankRow());
  }

  private blankRow(): string[] {
    return Array.from({ length: this.columns }, () => ' ');
  }

  private lineFeed(): void {
    if (this.row === this.rows - 1) {
      this.history.push(this.grid.shift()!.join('').trimEnd());
      this.grid.push(this.blankRow());
    } else {
      this.row++;
    }
  }

  write(data: string): boolean {
    this.written += data;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch === '\x1b') {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(i));
        assert.ok(m, `unsupported escape at ${JSON.stringify(data.slice(i, i + 12))}`);
        this.control(m[1]!, m[2]!);
        i += m[0].length - 1;
      } else if (ch === '\r') {
        this.col = 0;
        this.pendingWrap = false;
      } else if (ch === '\n') {
        this.col = 0;
        this.pendingWrap = false;
        this.lineFeed();
      } else {
        assert.ok(ch.charCodeAt(0) >= 0x20, `unexpected control character ${ch.charCodeAt(0)}`);
        if (this.pendingWrap) {
          this.col = 0;
          this.pendingWrap = false;
          this.lineFeed();
        }
        this.grid[this.row]![this.col] = ch;
        if (this.col === this.columns - 1) this.pendingWrap = true;
        else this.col++;
      }
    }
    return true;
  }

  private control(params: string, final: string): void {
    const n = Number.parseInt(params, 10);
    const count = Number.isFinite(n) ? n : 1;
    this.pendingWrap = false;
    if (final === 'A') this.row = Math.max(0, this.row - count);
    else if (final === 'B') this.row = Math.min(this.rows - 1, this.row + count);
    else if (final === 'C') this.col = Math.min(this.columns - 1, this.col + count);
    else if (final === 'D') this.col = Math.max(0, this.col - count);
    else if (final === 'H') {
      this.row = 0;
      this.col = 0;
    } else if (final === 'J') {
      if (params === '2') this.grid = this.grid.map(() => this.blankRow());
      else if (params === '3') this.history = [];
      else {
        for (let x = this.col; x < this.columns; x++) this.grid[this.row]![x] = ' ';
        for (let y = this.row + 1; y < this.rows; y++) this.grid[y] = this.blankRow();
      }
    } else if (final === 'h' || final === 'l') {
      if (params === '?25') this.cursorVisible = final === 'h';
      else assert.ok(params === '?2026', `unexpected mode ${params}`);
    } else if (final !== 'm') {
      assert.fail(`unsupported sequence CSI ${params}${final}`);
    }
  }

  /** Visible rows, without trailing blank rows. */
  visible(): string[] {
    const rows = this.grid.map((r) => r.join('').trimEnd());
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    return rows;
  }

  /** Everything the user could scroll through. */
  all(): string[] {
    return [...this.history, ...this.visible()];
  }

  rowText(y: number): string {
    return this.grid[y]!.join('').trimEnd();
  }
}

function setup(columns = 40, rows = 10): { term: FakeTerminal; screen: Screen } {
  const term = new FakeTerminal(columns, rows);
  return { term, screen: new Screen(term) };
}

beforeEach(() => setColorEnabled(false));
afterEach(() => setColorEnabled(false));

describe('Screen', () => {
  test('reports the size of the terminal, with sane minimums', () => {
    const { screen } = setup(50, 12);
    assert.equal(screen.columns, 50);
    assert.equal(screen.rows, 12);
    assert.equal(screen.width, 49);
    const tiny = new Screen({ write: () => true, columns: 3, rows: 1 });
    assert.equal(tiny.columns, 20);
    assert.equal(tiny.rows, 6);
    const unknown = new Screen({ write: () => true });
    assert.equal(unknown.columns, 80);
    assert.equal(unknown.rows, 24);
  });

  test('printed lines appear from the top, in order', () => {
    const { term, screen } = setup();
    screen.print('first');
    screen.print(['second', 'third']);
    screen.render();
    assert.deepEqual(term.visible(), ['first', 'second', 'third']);
    assert.equal(term.row, 3);
    assert.equal(term.col, 0);
  });

  test('a multi-line string is split into rows, also inside an array', () => {
    const { term, screen } = setup();
    screen.print('one\ntwo\n\nfour');
    screen.print(['five\nsix', 'seven']);
    screen.render();
    assert.deepEqual(term.visible(), ['one', 'two', '', 'four', 'five', 'six', 'seven']);
  });

  test('the live region is drawn with the cursor where it was asked for', () => {
    const { term, screen } = setup();
    screen.setLive(['-----', '> hello', '-----', '  footer'], { row: 1, col: 7 });
    screen.render();
    assert.deepEqual(term.visible(), ['-----', '> hello', '-----', '  footer']);
    assert.deepEqual([term.row, term.col], [1, 7]);
    assert.equal(term.cursorVisible, true);
  });

  test('the cursor can sit on any row, including the first and last', () => {
    const { term, screen } = setup();
    for (const cursor of [{ row: 0, col: 0 }, { row: 0, col: 3 }, { row: 2, col: 1 }, { row: 3, col: 0 }, { row: 1, col: 5 }] as Cursor[]) {
      screen.setLive(['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd'], cursor);
      screen.render();
      assert.deepEqual([term.row, term.col], [cursor.row, cursor.col]);
      assert.deepEqual(term.visible(), ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd']);
    }
  });

  test('without a cursor the terminal cursor is hidden, and shown again when needed', () => {
    const { term, screen } = setup();
    screen.setLive(['working...'], null);
    screen.render();
    assert.equal(term.cursorVisible, false);
    screen.setLive(['> '], { row: 0, col: 2 });
    screen.render();
    assert.equal(term.cursorVisible, true);
    assert.deepEqual([term.row, term.col], [0, 2]);
  });

  test('scrollback goes above the live region, which is redrawn below it', () => {
    const { term, screen } = setup();
    screen.setLive(['[spinner]', '> prompt'], { row: 1, col: 8 });
    screen.render();
    screen.print(['output line 1', 'output line 2']);
    screen.render();
    assert.deepEqual(term.visible(), ['output line 1', 'output line 2', '[spinner]', '> prompt']);
    assert.deepEqual([term.row, term.col], [3, 8]);
    screen.print('output line 3');
    screen.render();
    assert.deepEqual(term.visible(), ['output line 1', 'output line 2', 'output line 3', '[spinner]', '> prompt']);
    assert.deepEqual([term.row, term.col], [4, 8]);
  });

  test('drawing the same content again changes nothing', () => {
    const { term, screen } = setup();
    screen.print('above');
    screen.setLive(['one', 'two', 'three'], { row: 1, col: 2 });
    screen.render();
    const before = { rows: term.visible(), row: term.row, col: term.col };
    for (let i = 0; i < 5; i++) screen.render();
    assert.deepEqual({ rows: term.visible(), row: term.row, col: term.col }, before);
  });

  test('a shrinking live region leaves no stale rows behind', () => {
    const { term, screen } = setup();
    screen.print('kept');
    screen.setLive(['a long first row here', 'second row', 'third row', 'fourth row'], { row: 3, col: 4 });
    screen.render();
    screen.setLive(['short'], { row: 0, col: 5 });
    screen.render();
    assert.deepEqual(term.visible(), ['kept', 'short']);
    assert.deepEqual([term.row, term.col], [1, 5]);
    screen.setLive([], null);
    screen.render();
    assert.deepEqual(term.visible(), ['kept']);
    assert.deepEqual([term.row, term.col], [1, 0]);
  });

  test('a growing live region pushes nothing out of place', () => {
    const { term, screen } = setup();
    screen.print('kept');
    screen.setLive(['one'], { row: 0, col: 1 });
    screen.render();
    screen.setLive(['one', 'two', 'three', 'four', 'five'], { row: 4, col: 2 });
    screen.render();
    assert.deepEqual(term.visible(), ['kept', 'one', 'two', 'three', 'four', 'five']);
    assert.deepEqual([term.row, term.col], [5, 2]);
  });

  test('scrollback longer than the screen is neither lost nor repeated', () => {
    const { term, screen } = setup(40, 8);
    const printed: string[] = [];
    screen.setLive(['~ status', '> input'], { row: 1, col: 3 });
    screen.render();
    for (let batch = 0; batch < 6; batch++) {
      const lines = Array.from({ length: 5 }, (_, i) => `line ${batch * 5 + i + 1}`);
      printed.push(...lines);
      screen.print(lines);
      screen.render();
      assert.deepEqual(term.all(), [...printed, '~ status', '> input'], `after batch ${batch}`);
      assert.equal(term.rowText(term.row), '> input');
      assert.equal(term.col, 3);
    }
    assert.equal(term.history.length, printed.length + 2 - 8);
  });

  test('one print call much taller than the screen', () => {
    const { term, screen } = setup(40, 6);
    const lines = Array.from({ length: 50 }, (_, i) => `row ${i}`);
    screen.setLive(['> '], { row: 0, col: 2 });
    screen.render();
    screen.print(lines);
    screen.render();
    assert.deepEqual(term.all(), [...lines, '>']);
    assert.deepEqual([term.row, term.col], [5, 2]);
  });

  test('live lines wider than the terminal are truncated, not wrapped', () => {
    const { term, screen } = setup(20, 8);
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789';
    screen.setLive([long, 'short', long], { row: 1, col: 5 });
    screen.render();
    const rows = term.visible();
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.length, 19); // one column is kept free
    assert.ok(rows[0]!.endsWith('…'));
    assert.ok(rows[0]!.startsWith('abcdefghijklmnopqr'));
    assert.equal(rows[1], 'short');
    assert.deepEqual([term.row, term.col], [1, 5]);
    // Redrawing still finds the top of the region.
    screen.print('above');
    screen.render();
    assert.deepEqual(term.visible().slice(0, 2), ['above', rows[0]]);
    assert.equal(term.visible().length, 4);
  });

  test('a cursor column beyond the width is clamped', () => {
    const { term, screen } = setup(20, 8);
    screen.setLive(['x'], { row: 0, col: 500 });
    screen.render();
    assert.equal(term.col, 19);
    screen.setLive(['x', 'y'], { row: 9, col: 1 });
    screen.render();
    assert.deepEqual([term.row, term.col], [1, 1]);
  });

  test('a scrollback line wider than the terminal wraps without disturbing the live region', () => {
    const { term, screen } = setup(20, 10);
    screen.setLive(['> prompt'], { row: 0, col: 8 });
    screen.render();
    screen.print('0123456789012345678901234567890123456789ab');
    screen.print('next');
    screen.render();
    assert.deepEqual(term.visible(), ['01234567890123456789', '01234567890123456789', 'ab', 'next', '> prompt']);
    assert.deepEqual([term.row, term.col], [4, 8]);
    screen.print('exactly twenty chars');
    screen.render();
    assert.deepEqual(term.visible().slice(-3), ['next', 'exactly twenty chars', '> prompt']);
  });

  test('a live region taller than the terminal shows its last rows, cursor adjusted', () => {
    const { term, screen } = setup(30, 6);
    const lines = Array.from({ length: 12 }, (_, i) => `live ${i}`);
    screen.print('scrollback');
    screen.setLive(lines, { row: 10, col: 4 });
    screen.render();
    // rows - 1 = 5 rows fit: live 7..11; the cursor was on "live 10".
    assert.deepEqual(term.visible().slice(-5), ['live 7', 'live 8', 'live 9', 'live 10', 'live 11']);
    assert.equal(term.rowText(term.row), 'live 10');
    assert.equal(term.col, 4);
    assert.ok(!term.all().includes('live 0'));

    // The region is still tracked correctly afterwards.
    screen.setLive(['small'], { row: 0, col: 0 });
    screen.print('more scrollback');
    screen.render();
    assert.deepEqual(term.all(), ['scrollback', 'more scrollback', 'small']);
  });

  test('a cursor inside the clipped part of a tall region moves to the first visible row', () => {
    const { term, screen } = setup(30, 6);
    screen.setLive(Array.from({ length: 12 }, (_, i) => `live ${i}`), { row: 2, col: 3 });
    screen.render();
    assert.equal(term.rowText(term.row), 'live 7');
    assert.equal(term.col, 3);
  });

  test('clearAll wipes the screen and scrollback, then redraws the live region at the top', () => {
    const { term, screen } = setup(30, 6);
    screen.setLive(['> prompt'], { row: 0, col: 2 });
    screen.print(Array.from({ length: 20 }, (_, i) => `old ${i}`));
    screen.render();
    assert.ok(term.history.length > 0);
    screen.print('queued but never shown');
    screen.clearAll();
    assert.deepEqual(term.all(), ['> prompt']);
    assert.deepEqual([term.row, term.col], [0, 2]);
    screen.print('fresh');
    screen.render();
    assert.deepEqual(term.all(), ['fresh', '> prompt']);
  });

  test('suspend removes the live region and resume draws it after whatever was printed meanwhile', () => {
    const { term, screen } = setup();
    screen.print('history');
    screen.setLive(['status', '> prompt'], { row: 1, col: 4 });
    screen.render();
    screen.suspend();
    assert.deepEqual(term.visible(), ['history']);
    assert.deepEqual([term.row, term.col], [1, 0]);
    assert.equal(term.cursorVisible, true);

    // Updates while another program owns the terminal are held back.
    const before = term.written.length;
    screen.print('printed while suspended');
    screen.setLive(['status 2', '> prompt'], { row: 1, col: 2 });
    screen.render();
    screen.clearAll();
    screen.suspend();
    assert.equal(term.written.length, before);

    term.write('editor output\n');
    screen.resume();
    assert.deepEqual(term.visible(), ['history', 'editor output', 'status 2', '> prompt']);
    assert.deepEqual([term.row, term.col], [3, 2]);
  });

  test('suspend with a hidden cursor makes it visible for the other program', () => {
    const { term, screen } = setup();
    screen.setLive(['busy'], null);
    screen.render();
    assert.equal(term.cursorVisible, false);
    screen.suspend();
    assert.equal(term.cursorVisible, true);
    screen.resume();
    assert.equal(term.cursorVisible, false);
    assert.deepEqual(term.visible(), ['busy']);
  });

  test('close removes the live region, flushes pending output and leaves the cursor visible', () => {
    const { term, screen } = setup();
    screen.print('kept output');
    screen.setLive(['spinner', '> prompt', 'footer'], null);
    screen.render();
    screen.print('last words');
    screen.close();
    assert.deepEqual(term.visible(), ['kept output', 'last words']);
    assert.deepEqual([term.row, term.col], [2, 0]);
    assert.equal(term.cursorVisible, true);

    const before = term.written.length;
    screen.print('ignored');
    screen.setLive(['ignored'], { row: 0, col: 0 });
    screen.render();
    assert.equal(term.written.length, before);
  });

  test('updates are drawn on their own shortly after, and coalesced', async () => {
    const { term, screen } = setup();
    screen.print('one');
    screen.print('two');
    screen.setLive(['> '], { row: 0, col: 2 });
    assert.equal(term.written, '');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(term.visible(), ['one', 'two', '>']);
    // One write for the three updates.
    assert.equal(term.written.match(/\x1b\[\?2026h/g)!.length, 1);
    screen.close();
  });

  test('an explicit render cancels the scheduled one', async () => {
    const { term, screen } = setup();
    screen.print('one');
    screen.render();
    const written = term.written.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(term.written.length, written);
    screen.close();
  });

  test('each frame is wrapped in synchronized-output markers', () => {
    const { term, screen } = setup();
    screen.setLive(['x'], { row: 0, col: 0 });
    screen.render();
    assert.ok(term.written.startsWith('\x1b[?2026h'));
    assert.ok(term.written.endsWith('\x1b[?2026l'));
  });

  test('colours pass through to the terminal', () => {
    setColorEnabled(true);
    const { term, screen } = setup();
    screen.print(c.red('error'));
    screen.setLive([c.cyan('> ') + 'typed'], { row: 0, col: 7 });
    screen.render();
    assert.ok(term.written.includes('\x1b[31merror\x1b[39m'));
    assert.ok(term.written.includes('\x1b[36m> \x1b[39mtyped'));
    assert.deepEqual(term.visible(), ['error', '> typed']);
    assert.deepEqual([term.row, term.col], [1, 7]);
  });

  test('control sequences in content cannot move the cursor or erase the screen', () => {
    const { term, screen } = setup();
    screen.print('safe');
    screen.print('progress 10%\rprogress 100%');
    screen.print('up\x1b[1A\x1b[2Kand erase\x1b[2J\x1b[H');
    screen.print('bell\x07 and tab\there');
    screen.setLive(['tool: \x1b[3A\x1b[Jsneaky\r\nline', '> ok'], { row: 1, col: 4 });
    screen.render();
    assert.deepEqual(term.visible(), ['safe', 'progress 10%progress 100%', 'upand erase', 'bell and tab    here', 'tool: sneaky line', '> ok']);
    assert.deepEqual([term.row, term.col], [5, 4]);
    // And the region is still where Screen thinks it is.
    screen.print('after');
    screen.render();
    assert.deepEqual(term.visible().slice(-3), ['after', 'tool: sneaky line', '> ok']);
  });

  test('random sequences of updates keep scrollback and live region consistent', () => {
    const columns = 30;
    const rows = 9;
    const { term, screen } = setup(columns, rows);
    let seed = 987654321;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 8) % n; // the low bits of this generator cycle quickly
    };
    const printed: string[] = [];
    let live: string[] = [];
    let cursor: Cursor | null = null;
    let counter = 0;

    for (let step = 0; step < 400; step++) {
      const op = next(10);
      if (op < 4) {
        const lines = Array.from({ length: next(4) }, () => (next(6) === 0 ? '' : `out ${counter++} ${'x'.repeat(next(12))}`));
        printed.push(...lines);
        screen.print(lines);
      }
      if (op >= 3) {
        live = Array.from({ length: next(13) }, (_, i) => `live ${step}.${i} ${'y'.repeat(next(40))}`);
        cursor = live.length && next(4) !== 0 ? { row: next(live.length), col: next(columns + 5) } : null;
        screen.setLive(live, cursor);
      }
      screen.render();

      // What should be on screen: the last rows-1 live lines, truncated to columns-1.
      const maxRows = rows - 1;
      const drop = Math.max(0, live.length - maxRows);
      const shown = live.slice(drop).map((l) => (l.length > columns - 1 ? `${l.slice(0, columns - 2)}…` : l));
      const lastRow = Math.max(0, shown.length - 1);
      const cursorRow: number = cursor ? Math.min(Math.max(0, cursor.row - drop), lastRow) : lastRow;
      const liveTop: number = term.row - cursorRow;
      const where = `step ${step}`;
      assert.ok(liveTop >= 0, where);

      const above: string[] = [...term.history, ...Array.from({ length: liveTop }, (_, y) => term.rowText(y))];
      // The fake terminal reports rows without trailing blanks.
      assert.deepEqual(above, printed.map((l) => l.trimEnd()), `${where}: scrollback`);
      for (let i = 0; i < shown.length; i++) assert.equal(term.rowText(liveTop + i), shown[i]!.trimEnd(), `${where}: live row ${i}`);
      for (let y = liveTop + Math.max(1, shown.length); y < rows; y++) assert.equal(term.rowText(y), '', `${where}: row ${y} should be blank`);
      if (cursor) {
        assert.equal(term.col, Math.min(cursor.col, columns - 1), `${where}: cursor column`);
        assert.equal(term.cursorVisible, true, where);
      } else {
        assert.equal(term.cursorVisible, false, where);
      }
    }
    assert.ok(printed.length > 100);
    assert.ok(term.history.length > 50);
  });
});

describe('sanitizeLine', () => {
  test('plain text and colours are untouched', () => {
    assert.equal(sanitizeLine('hello world'), 'hello world');
    assert.equal(sanitizeLine(''), '');
    const coloured = '\x1b[1m\x1b[38;5;196mbold red\x1b[39m\x1b[22m \x1b[0mreset\x1b[m';
    assert.equal(sanitizeLine(coloured), coloured);
    const unicode = `${String.fromCodePoint(0x65e5, 0x672c)} ${String.fromCodePoint(0x1f44d)} caf${String.fromCodePoint(0xe9)}`;
    assert.equal(sanitizeLine(unicode), unicode);
  });

  test('cursor movement, erasing and mode changes are removed', () => {
    assert.equal(sanitizeLine('a\x1b[2Ab\x1b[10;20Hc\x1b[Kd\x1b[2Je\x1b[?25lf\x1b[?1049hg'), 'abcdefg');
    assert.equal(sanitizeLine('x\x1b[1 qy\x1b[>0cz'), 'xyz');
  });

  test('titles, hyperlinks and other string sequences are removed', () => {
    assert.equal(sanitizeLine('a\x1b]0;window title\x07b'), 'ab');
    assert.equal(sanitizeLine('a\x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\b'), 'alinkb');
    assert.equal(sanitizeLine('a\x1b7b\x1b8c\x1bMd\x1bce'), 'abcde');
  });

  test('carriage returns, bells and other control characters are dropped', () => {
    assert.equal(sanitizeLine('one\rtwo'), 'onetwo');
    assert.equal(sanitizeLine('a\x00b\x07c\x08d\x0be\x0cf\x7fg'), 'abcdefg');
    assert.equal(sanitizeLine(`a${String.fromCodePoint(0x9b)}2Jb${String.fromCodePoint(0x85)}c`), 'a2Jbc');
  });

  test('a line break inside a row becomes a space', () => {
    assert.equal(sanitizeLine('first\nsecond\r\nthird'), 'first second third');
  });

  test('tabs become spaces up to the next tab stop', () => {
    assert.equal(sanitizeLine('a\tb'), 'a   b');
    assert.equal(sanitizeLine('\tindented'), '    indented');
    assert.equal(sanitizeLine('abcd\te'), 'abcd    e');
  });

  test('an unfinished sequence at the end does not swallow text before it', () => {
    assert.equal(sanitizeLine('text\x1b'), 'text');
    assert.equal(sanitizeLine('text\x1b['), 'text');
    assert.equal(sanitizeLine('colour \x1b[31mred\x1b[39m then \x1b[12'), 'colour \x1b[31mred\x1b[39m then 12');
  });

  test('long input is handled in linear time', () => {
    const line = '\x1b[31mx\x1b[39m\x1b[2K'.repeat(20_000);
    const started = Date.now();
    const out = sanitizeLine(line);
    assert.ok(Date.now() - started < 1000);
    assert.equal(out, '\x1b[31mx\x1b[39m'.repeat(20_000));
  });
});
