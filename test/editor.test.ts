import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { graphemes, stringWidth } from '../src/ui/ansi.ts';
import { Editor } from '../src/ui/editor.ts';

const cp = (...points: number[]) => points.map((p) => String.fromCodePoint(p)).join('');
const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // one cluster, eight code units
const THUMB = cp(0x1f44d, 0x1f3fd); // thumbs up with skin tone
const FLAG = cp(0x1f1fa, 0x1f1f8); // regional indicator pair
const E_ACUTE = `e${cp(0x301)}`; // e + combining acute accent
const NIHON = cp(0x65e5, 0x672c); // two wide characters

function editor(text = '', cursor?: number): Editor {
  const ed = new Editor();
  ed.text = text;
  ed.cursor = cursor ?? text.length;
  return ed;
}

/** Offsets in `text` that fall between user-perceived characters. */
function boundaries(text: string): Set<number> {
  const set = new Set<number>([0]);
  let offset = 0;
  for (const g of graphemes(text)) {
    offset += g.length;
    set.add(offset);
  }
  return set;
}

function assertOnBoundary(ed: Editor, what: string): void {
  assert.ok(boundaries(ed.text).has(ed.cursor), `${what}: cursor ${ed.cursor} splits a character in ${JSON.stringify(ed.text)}`);
}

describe('inserting and deleting', () => {
  test('insert at the start, middle and end', () => {
    const ed = editor();
    ed.insert('world');
    ed.cursor = 0;
    ed.insert('hello ');
    assert.equal(ed.text, 'hello world');
    assert.equal(ed.cursor, 6);
    ed.cursor = 5;
    ed.insert(',');
    assert.equal(ed.text, 'hello, world');
    // value() rather than .text: the assertions above have narrowed the property's type.
    ed.cursor = ed.value().length;
    ed.insert('!');
    assert.equal(ed.value(), 'hello, world!');
    assert.equal(ed.cursor, ed.value().length);
  });

  test('inserted text is normalised: CRLF to LF, tabs to spaces', () => {
    const ed = editor();
    ed.insert('a\r\nb\rc\td');
    assert.equal(ed.text, 'a\nb\nc  d');
    assert.equal(ed.cursor, ed.text.length);
  });

  test('backspace and delete at the edges do nothing', () => {
    const ed = editor('abc', 0);
    ed.backspace();
    assert.equal(ed.text, 'abc');
    assert.equal(ed.cursor, 0);
    ed.cursor = 3;
    ed.del();
    assert.equal(ed.text, 'abc');
    assert.equal(ed.cursor, 3);
    const empty = editor();
    empty.backspace();
    empty.del();
    assert.equal(empty.text, '');
    assert.equal(empty.isEmpty, true);
  });

  test('backspace removes the character before the cursor, delete the one after', () => {
    const ed = editor('abcd', 2);
    ed.backspace();
    assert.equal(ed.text, 'acd');
    assert.equal(ed.cursor, 1);
    ed.del();
    assert.equal(ed.text, 'ad');
    assert.equal(ed.cursor, 1);
  });

  test('backspace across a line break joins the lines', () => {
    const ed = editor('ab\ncd', 3);
    ed.backspace();
    assert.equal(ed.text, 'abcd');
    assert.equal(ed.cursor, 2);
  });

  for (const [name, cluster] of [
    ['family emoji', FAMILY],
    ['emoji with skin tone', THUMB],
    ['flag', FLAG],
    ['combining accent', E_ACUTE],
    ['wide character', NIHON[0]!],
  ] as const) {
    test(`a ${name} is one character for backspace, delete and arrows`, () => {
      const text = `a${cluster}b`;
      const back = editor(text, 1 + cluster.length);
      back.backspace();
      assert.equal(back.text, 'ab');
      assert.equal(back.cursor, 1);

      const forward = editor(text, 1);
      forward.del();
      assert.equal(forward.text, 'ab');
      assert.equal(forward.cursor, 1);

      const move = editor(text, 0);
      const stops = [move.cursor];
      for (let i = 0; i < 4; i++) {
        move.right();
        stops.push(move.cursor);
      }
      assert.deepEqual(stops, [0, 1, 1 + cluster.length, text.length, text.length]);
      const back2 = [];
      for (let i = 0; i < 4; i++) {
        move.left();
        back2.push(move.cursor);
      }
      assert.deepEqual(back2, [1 + cluster.length, 1, 0, 0]);
    });
  }

  test('the cursor never lands inside a character, whatever the edits', () => {
    const pieces = ['a', ' ', FAMILY, THUMB, FLAG, E_ACUTE, NIHON, '\n', 'xyz', cp(0x1f600)];
    // A fixed pseudo-random sequence keeps the test deterministic.
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 8) % n; // the low bits of this generator cycle quickly
    };
    const ed = editor();
    for (let step = 0; step < 600; step++) {
      const op = next(11);
      if (op <= 2) ed.insert(pieces[next(pieces.length)]!);
      else if (op === 3) ed.backspace();
      else if (op === 4) ed.del();
      else if (op === 5) ed.left();
      else if (op === 6) ed.right();
      else if (op === 7) ed.up(4);
      else if (op === 8) ed.down(4);
      else if (op === 9) ed.home();
      else ed.end();
      assert.ok(ed.cursor >= 0 && ed.cursor <= ed.text.length);
      assertOnBoundary(ed, `step ${step} op ${op}`);
    }
  });

  test('set() replaces the text and puts the cursor at the end', () => {
    const ed = editor('old', 1);
    ed.set('brand new');
    assert.equal(ed.text, 'brand new');
    assert.equal(ed.cursor, 9);
    assert.equal(ed.isEmpty, false);
  });

  test('clear() empties the buffer', () => {
    const ed = editor('something');
    ed.clear();
    assert.equal(ed.text, '');
    assert.equal(ed.cursor, 0);
    assert.equal(ed.isEmpty, true);
    assert.equal(ed.value(), '');
  });
});

describe('word and line motion', () => {
  test('word left and right', () => {
    const ed = editor('foo bar  baz');
    const lefts = [];
    for (let i = 0; i < 4; i++) {
      ed.wordLeft();
      lefts.push(ed.cursor);
    }
    assert.deepEqual(lefts, [9, 4, 0, 0]);
    const rights = [];
    for (let i = 0; i < 4; i++) {
      ed.wordRight();
      rights.push(ed.cursor);
    }
    assert.deepEqual(rights, [3, 7, 12, 12]);
  });

  test('word motion crosses line breaks', () => {
    const ed = editor('one\ntwo', 4);
    ed.wordLeft();
    assert.equal(ed.cursor, 0);
    ed.wordRight();
    assert.equal(ed.cursor, 3);
    ed.wordRight();
    assert.equal(ed.cursor, 7);
  });

  test('home and end work on the current logical line', () => {
    const ed = editor('first\nsecond line\nthird', 10);
    ed.home();
    assert.equal(ed.cursor, 6);
    ed.home();
    assert.equal(ed.cursor, 6);
    ed.end();
    assert.equal(ed.cursor, 17);
    ed.end();
    assert.equal(ed.cursor, 17);
    ed.cursor = 2;
    ed.home();
    assert.equal(ed.cursor, 0);
    ed.cursor = ed.text.length;
    ed.home();
    assert.equal(ed.cursor, 18);
    ed.end();
    assert.equal(ed.cursor, ed.text.length);
  });

  test('home at the very start stays put, even before a blank first line', () => {
    const ed = editor('\nabc', 0);
    ed.home();
    assert.equal(ed.cursor, 0);
    ed.cursor = 1;
    ed.home();
    assert.equal(ed.cursor, 1);
  });

  test('home and end on an empty line', () => {
    const ed = editor('a\n\nb', 2);
    ed.home();
    assert.equal(ed.cursor, 2);
    ed.end();
    assert.equal(ed.cursor, 2);
  });
});

describe('killing and yanking', () => {
  test('kill to the end of the line, then yank it back elsewhere', () => {
    const ed = editor('keep this, drop that\nnext', 9);
    ed.killToEnd();
    assert.equal(ed.text, 'keep this\nnext');
    assert.equal(ed.cursor, 9);
    ed.cursor = ed.text.length;
    ed.yank();
    assert.equal(ed.text, 'keep this\nnext, drop that');
  });

  test('kill at the end of a line joins it with the next', () => {
    const ed = editor('one\ntwo', 3);
    ed.killToEnd();
    assert.equal(ed.text, 'onetwo');
    assert.equal(ed.cursor, 3);
  });

  test('kill to the start of the line', () => {
    const ed = editor('first\nsecond line', 12);
    ed.killToStart();
    assert.equal(ed.text, 'first\n line');
    assert.equal(ed.cursor, 6);
    ed.yank();
    assert.equal(ed.text, 'first\nsecond line');
  });

  test('kill to the start at position zero changes nothing, even before a blank line', () => {
    const ed = editor('\nabc', 0);
    ed.killToStart();
    assert.equal(ed.text, '\nabc');
    assert.equal(ed.cursor, 0);
  });

  test('kill the previous word', () => {
    const ed = editor('git commit --amend');
    ed.killWordBack();
    assert.equal(ed.text, 'git commit ');
    assert.equal(ed.cursor, 11);
    ed.killWordBack();
    assert.equal(ed.text, 'git ');
    ed.yank();
    assert.equal(ed.text, 'git commit ');
  });

  test('kill word in the middle keeps what follows', () => {
    const ed = editor('alpha beta gamma', 10);
    ed.killWordBack();
    assert.equal(ed.text, 'alpha  gamma');
    assert.equal(ed.cursor, 6);
  });

  test('a kill that removes nothing does not forget the previous kill', () => {
    const ed = editor('hello world', 5);
    ed.killToEnd();
    assert.equal(ed.text, 'hello');
    ed.killToEnd(); // nothing left to kill
    ed.cursor = 0;
    ed.killToStart(); // nothing before the cursor
    ed.killWordBack();
    ed.yank();
    assert.equal(ed.text, ' worldhello');
  });

  test('yank with nothing killed does nothing', () => {
    const ed = editor('abc');
    ed.yank();
    assert.equal(ed.text, 'abc');
  });
});

/** Start offset of each visual row, reconstructed from the layout. */
function rowStarts(text: string, rows: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const row of rows) {
    starts.push(offset);
    offset += row.length;
    if (text[offset] === '\n') offset++; // a hard line break sits between rows
  }
  assert.equal(offset, text.length, 'rows must cover the whole text');
  return starts;
}

describe('layout', () => {
  test('an empty buffer is one empty row with the cursor at the origin', () => {
    assert.deepEqual(editor().layout(20), { rows: [''], cursorRow: 0, cursorCol: 0 });
  });

  test('a short line is one row', () => {
    assert.deepEqual(editor('hello').layout(20), { rows: ['hello'], cursorRow: 0, cursorCol: 5 });
    assert.deepEqual(editor('hello', 2).layout(20), { rows: ['hello'], cursorRow: 0, cursorCol: 2 });
  });

  test('logical lines become rows, including empty ones', () => {
    const ed = editor('one\n\nthree\n');
    assert.deepEqual(ed.layout(20), { rows: ['one', '', 'three', ''], cursorRow: 3, cursorCol: 0 });
    ed.cursor = 4;
    assert.deepEqual(ed.layout(20).cursorRow, 1);
    assert.deepEqual(ed.layout(20).cursorCol, 0);
  });

  test('long lines wrap at the width', () => {
    const ed = editor('abcdefghijkl');
    assert.deepEqual(ed.layout(5), { rows: ['abcde', 'fghij', 'kl'], cursorRow: 2, cursorCol: 2 });
  });

  test('the cursor at a wrap point belongs to the start of the next row', () => {
    const ed = editor('abcdefghij', 5);
    assert.deepEqual(ed.layout(5), { rows: ['abcde', 'fghij'], cursorRow: 1, cursorCol: 0 });
  });

  test('the cursor at the end of a full last row stays on that row', () => {
    const ed = editor('abcde');
    assert.deepEqual(ed.layout(5), { rows: ['abcde'], cursorRow: 0, cursorCol: 5 });
    const two = editor('abcdefghij');
    assert.deepEqual(two.layout(5), { rows: ['abcde', 'fghij'], cursorRow: 1, cursorCol: 5 });
  });

  test('a full line followed by a line break does not add an empty row', () => {
    assert.deepEqual(editor('abcde\nfg').layout(5).rows, ['abcde', 'fg']);
  });

  test('wide characters wrap before they would overflow', () => {
    const text = `ab${NIHON}${NIHON}`; // widths 1 1 2 2 2 2
    const layout = editor(text).layout(5);
    assert.deepEqual(layout.rows, [`ab${NIHON[0]}`, `${NIHON[1]}${NIHON[0]}`, NIHON[1]!]);
    for (const row of layout.rows) assert.ok(stringWidth(row) <= 5);
    assert.equal(layout.cursorRow, 2);
    assert.equal(layout.cursorCol, 2);
  });

  test('a character wider than the row still gets a row of its own', () => {
    const layout = editor(NIHON).layout(1);
    assert.deepEqual(layout.rows, [NIHON[0]!, NIHON[1]!]);
  });

  test('a zero or negative width is treated as one column', () => {
    assert.deepEqual(editor('abc').layout(0).rows, ['a', 'b', 'c']);
    assert.deepEqual(editor('abc').layout(-5).rows, ['a', 'b', 'c']);
  });

  test('for every cursor position the column is the width of the text before it on its row', () => {
    const texts = [
      'hello world this is a long line of text that wraps',
      `mixed ${NIHON} widths ${THUMB} and ${FAMILY} clusters ${E_ACUTE}${E_ACUTE} here`,
      'short\n\nlines\nand a much longer line that needs wrapping\n',
      `${NIHON}${NIHON}${NIHON}${NIHON}`,
      'exactly10!\nexactly10!',
      '\n\n\n',
      '',
    ];
    for (const text of texts) {
      for (const width of [1, 2, 3, 5, 10, 17, 80]) {
        const ed = editor(text);
        for (const pos of boundaries(text)) {
          ed.cursor = pos;
          const layout = ed.layout(width);
          const starts = rowStarts(text, layout.rows);
          const where = `text ${JSON.stringify(text.slice(0, 20))} width ${width} cursor ${pos}`;
          assert.ok(layout.cursorRow >= 0 && layout.cursorRow < layout.rows.length, where);
          const start = starts[layout.cursorRow]!;
          assert.ok(pos >= start && pos <= start + layout.rows[layout.cursorRow]!.length, `${where}: cursor outside its row`);
          assert.equal(layout.cursorCol, stringWidth(text.slice(start, pos)), where);
          // Rows never exceed the width unless a single character is wider than it.
          for (const row of layout.rows) assert.ok(stringWidth(row) <= width || graphemes(row).length === 1, where);
          // The cursor sits at a wrap point only as column 0 of the following row.
          if (layout.cursorCol >= width && width > 1) {
            assert.equal(pos, start + layout.rows[layout.cursorRow]!.length, where);
            assert.ok(layout.cursorRow === layout.rows.length - 1 || text[pos] === '\n', where);
          }
        }
      }
    }
  });
});

describe('vertical movement', () => {
  test('moves between logical lines, clamping to shorter lines', () => {
    const ed = editor('hello\nhi\nworld!');
    assert.equal(ed.up(40), true);
    assert.equal(ed.cursor, 8); // end of "hi"
    assert.equal(ed.up(40), true);
    assert.equal(ed.cursor, 2); // column 2 of "hello"
    assert.equal(ed.up(40), false);
    assert.equal(ed.cursor, 2);
    assert.equal(ed.down(40), true);
    assert.equal(ed.cursor, 8);
    assert.equal(ed.down(40), true);
    assert.equal(ed.cursor, 11); // column 2 of "world!"
    assert.equal(ed.down(40), false);
    assert.equal(ed.cursor, 11);
  });

  test('keeps the column between rows of equal length', () => {
    const ed = editor('abcdef\nghijkl\nmnopqr', 3);
    ed.down(40);
    assert.equal(ed.cursor, 10);
    ed.down(40);
    assert.equal(ed.cursor, 17);
    ed.up(40);
    ed.up(40);
    assert.equal(ed.cursor, 3);
  });

  test('moves between the rows of one wrapped line', () => {
    const ed = editor('abcdefghijkl'); // rows: abcde / fghij / kl
    assert.equal(ed.up(5), true);
    assert.equal(ed.cursor, 7);
    assert.equal(ed.up(5), true);
    assert.equal(ed.cursor, 2);
    assert.equal(ed.up(5), false);
    assert.equal(ed.down(5), true);
    assert.equal(ed.cursor, 7);
    assert.equal(ed.down(5), true);
    assert.equal(ed.cursor, 12);
    assert.equal(ed.down(5), false);
  });

  test('up from the end of a full row lands on the row above, not at the start of the same row', () => {
    const ed = editor('abcdefghij'); // rows: abcde / fghij, cursor after "j"
    assert.deepEqual([ed.layout(5).cursorRow, ed.layout(5).cursorCol], [1, 5]);
    assert.equal(ed.up(5), true);
    assert.equal(ed.layout(5).cursorRow, 0);
    assert.equal(ed.cursor, 4);
    assert.equal(ed.up(5), false);
  });

  test('down onto a wrapped row never skips a row', () => {
    const ed = editor('abcdefghijklmno\nxy'); // rows: abcde / fghij / klmno / xy
    ed.cursor = 4; // row 0, column 4
    const visited = [ed.layout(5).cursorRow];
    while (ed.down(5)) visited.push(ed.layout(5).cursorRow);
    assert.deepEqual(visited, [0, 1, 2, 3]);
    const back = [ed.layout(5).cursorRow];
    while (ed.up(5)) back.push(ed.layout(5).cursorRow);
    assert.deepEqual(back, [3, 2, 1, 0]);
  });

  test('with wide characters the cursor lands on a character boundary at or before the column', () => {
    const text = `abcd\n${NIHON}${NIHON}`;
    const ed = editor(text, 3); // column 3 on row 0
    ed.down(40);
    assert.equal(ed.cursor, 5 + 1); // after the first wide character (columns 0-1); column 3 would split the second
    assertOnBoundary(ed, 'down');
    ed.up(40);
    assert.equal(ed.cursor, 2);
  });

  test('a single row has nowhere to go', () => {
    const ed = editor('just one line', 4);
    assert.equal(ed.up(80), false);
    assert.equal(ed.down(80), false);
    assert.equal(ed.cursor, 4);
    assert.equal(editor().up(80), false);
    assert.equal(editor().down(80), false);
  });

  test('through an empty line', () => {
    const ed = editor('abc\n\ndef', 2);
    ed.down(40);
    assert.equal(ed.cursor, 4);
    ed.down(40);
    assert.equal(ed.cursor, 5);
  });
});

describe('history', () => {
  test('walks back and forward, restoring the draft', () => {
    const ed = editor();
    ed.setHistory(['first', 'second', 'third']);
    ed.insert('my draft');
    assert.equal(ed.historyPrev(), true);
    assert.equal(ed.text, 'third');
    assert.equal(ed.cursor, 5);
    assert.equal(ed.historyPrev(), true);
    assert.equal(ed.text, 'second');
    assert.equal(ed.historyPrev(), true);
    assert.equal(ed.text, 'first');
    assert.equal(ed.historyPrev(), false);
    assert.equal(ed.text, 'first');
    assert.equal(ed.historyNext(), true);
    assert.equal(ed.text, 'second');
    assert.equal(ed.historyNext(), true);
    assert.equal(ed.historyNext(), true);
    assert.equal(ed.text, 'my draft');
    assert.equal(ed.historyNext(), false);
    assert.equal(ed.text, 'my draft');
  });

  test('no history', () => {
    const ed = editor('draft');
    assert.equal(ed.historyPrev(), false);
    assert.equal(ed.historyNext(), false);
    assert.equal(ed.text, 'draft');
  });

  test('blank entries are dropped and consecutive duplicates collapse', () => {
    const ed = editor();
    ed.setHistory(['a', '', '   ', 'b']);
    ed.addHistory('b');
    ed.addHistory('  ');
    ed.addHistory('c');
    ed.addHistory(' c ');
    ed.addHistory('b');
    const seen = [];
    while (ed.historyPrev()) seen.push(ed.text);
    assert.deepEqual(seen, ['b', 'c', 'b', 'a']);
  });

  test('clear() starts navigation from the newest entry again', () => {
    const ed = editor();
    ed.setHistory(['one', 'two']);
    ed.historyPrev();
    ed.historyPrev();
    assert.equal(ed.text, 'one');
    ed.clear();
    ed.addHistory('three');
    ed.historyPrev();
    assert.equal(ed.text, 'three');
  });

  test('an empty draft is restored as empty', () => {
    const ed = editor();
    ed.setHistory(['one']);
    ed.historyPrev();
    ed.historyNext();
    assert.equal(ed.text, '');
    assert.equal(ed.isEmpty, true);
  });

  test('multi-line entries come back whole', () => {
    const ed = editor();
    ed.addHistory('line one\nline two');
    ed.historyPrev();
    assert.equal(ed.text, 'line one\nline two');
    assert.equal(ed.cursor, ed.text.length);
  });
});

describe('pastes', () => {
  const big = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

  test('a small paste is inserted as typed text', () => {
    const ed = editor('say: ');
    ed.paste('hello\r\nworld');
    assert.equal(ed.text, 'say: hello\nworld');
    assert.equal(ed.value(), 'say: hello\nworld');
  });

  test('a paste of many lines collapses to a placeholder that value() expands', () => {
    const ed = editor('review this: ');
    ed.paste(big);
    assert.equal(ed.text, 'review this: [Pasted text #1 +12 lines]');
    assert.equal(ed.cursor, ed.text.length);
    ed.insert(' thanks');
    assert.equal(ed.value(), `review this: ${big} thanks`);
  });

  test('a long single-line paste also collapses', () => {
    const ed = editor();
    const long = 'x'.repeat(1000);
    ed.paste(long);
    assert.equal(ed.text, '[Pasted text #1 +1 lines]');
    assert.equal(ed.value(), long);
  });

  test('the collapse thresholds', () => {
    const six = editor();
    six.paste('1\n2\n3\n4\n5\n6');
    assert.equal(six.text, '1\n2\n3\n4\n5\n6');
    const seven = editor();
    seven.paste('1\n2\n3\n4\n5\n6\n7');
    assert.equal(seven.text, '[Pasted text #1 +7 lines]');
    const short = editor();
    short.paste('y'.repeat(800));
    assert.equal(short.text.length, 800);
  });

  test('several pastes are numbered and expanded independently', () => {
    const ed = editor();
    ed.paste(big);
    ed.insert(' vs ');
    ed.paste(big.toUpperCase());
    assert.equal(ed.text, '[Pasted text #1 +12 lines] vs [Pasted text #2 +12 lines]');
    assert.equal(ed.value(), `${big} vs ${big.toUpperCase()}`);
  });

  test('pasted content keeps its tabs and is normalised to LF', () => {
    const ed = editor();
    const code = Array.from({ length: 8 }, (_, i) => `\tindented ${i}`).join('\r\n');
    ed.paste(code);
    assert.equal(ed.value(), code.replace(/\r\n/g, '\n'));
  });

  test('backspace right after a placeholder removes the whole paste', () => {
    const ed = editor('a ');
    ed.paste(big);
    ed.backspace();
    assert.equal(ed.text, 'a ');
    assert.equal(ed.cursor, 2);
    assert.equal(ed.value(), 'a ');
    ed.insert('[Pasted text #1 +12 lines]'); // typed by hand: no longer a paste
    assert.equal(ed.value(), 'a [Pasted text #1 +12 lines]');
  });

  test('backspace elsewhere deletes one character', () => {
    const ed = editor();
    ed.paste(big);
    ed.insert('xy');
    ed.backspace();
    assert.equal(ed.text, '[Pasted text #1 +12 lines]x');
    assert.equal(ed.value(), `${big}x`);
  });

  test('pasted text that looks like another placeholder is not expanded again', () => {
    const ed = editor();
    const tricky = `${'see [Pasted text #2 +7 lines]\n'.repeat(7)}end`;
    ed.paste(tricky);
    ed.insert(' ');
    ed.paste('1\n2\n3\n4\n5\n6\n7');
    assert.equal(ed.text, '[Pasted text #1 +8 lines] [Pasted text #2 +7 lines]');
    assert.equal(ed.value(), `${tricky} 1\n2\n3\n4\n5\n6\n7`);
  });

  test('clear() forgets pastes', () => {
    const ed = editor();
    ed.paste(big);
    ed.clear();
    ed.insert('[Pasted text #1 +12 lines]');
    assert.equal(ed.value(), '[Pasted text #1 +12 lines]');
  });

  test('history stores what was sent, so a recalled prompt still has its paste', () => {
    const ed = editor('explain ');
    ed.paste(big);
    const sent = ed.value();
    ed.addHistory(ed.text);
    ed.clear();
    ed.historyPrev();
    assert.equal(ed.value(), sent);
    assert.ok(ed.value().includes('line 12'));
  });
});

describe('completion', () => {
  test('a slash command at the start of the prompt', () => {
    assert.deepEqual(editor('/he').completionToken(), { kind: 'command', query: 'he', start: 0 });
    assert.deepEqual(editor('/').completionToken(), { kind: 'command', query: '', start: 0 });
    assert.deepEqual(editor('/git:sy').completionToken(), { kind: 'command', query: 'git:sy', start: 0 });
    assert.deepEqual(editor('/mcp__server__prompt').completionToken(), { kind: 'command', query: 'mcp__server__prompt', start: 0 });
  });

  test('not a command once there is a space, a second slash, or text before it', () => {
    assert.equal(editor('/model qwen').completionToken(), null);
    assert.equal(editor('/usr/local').completionToken(), null);
    assert.equal(editor('see /he').completionToken(), null);
    assert.equal(editor(' /he').completionToken(), null);
    assert.equal(editor('line\n/he').completionToken(), null);
  });

  test('only the text before the cursor counts', () => {
    assert.deepEqual(editor('/help me', 3).completionToken(), { kind: 'command', query: 'he', start: 0 });
    assert.deepEqual(editor('see @src/in and more', 11).completionToken(), { kind: 'file', query: 'src/in', start: 4 });
  });

  test('a file mention anywhere in the prompt', () => {
    assert.deepEqual(editor('@').completionToken(), { kind: 'file', query: '', start: 0 });
    assert.deepEqual(editor('@src').completionToken(), { kind: 'file', query: 'src', start: 0 });
    assert.deepEqual(editor('look at @src/ui/app').completionToken(), { kind: 'file', query: 'src/ui/app', start: 8 });
    assert.deepEqual(editor('compare @a.ts and @b').completionToken(), { kind: 'file', query: 'b', start: 18 });
    assert.deepEqual(editor('first line\n@README').completionToken(), { kind: 'file', query: 'README', start: 11 });
    assert.deepEqual(editor('open @../other/file.ts').completionToken(), { kind: 'file', query: '../other/file.ts', start: 5 });
  });

  test('an e-mail address is not a file mention', () => {
    assert.equal(editor('mail me@example.com').completionToken(), null);
    assert.equal(editor('me@exa').completionToken(), null);
  });

  test('a finished mention followed by a space is no longer a token', () => {
    assert.equal(editor('look at @src/app.ts ').completionToken(), null);
    assert.equal(editor('plain text').completionToken(), null);
    assert.equal(editor('').completionToken(), null);
  });

  test('replaceRange swaps the token for the completion and moves the cursor after it', () => {
    const ed = editor('see @fo bar', 7);
    const token = ed.completionToken()!;
    ed.replaceRange(token.start, '@foo.ts ');
    assert.equal(ed.text, 'see @foo.ts  bar');
    assert.equal(ed.cursor, 12);

    const cmd = editor('/he');
    cmd.replaceRange(0, '/help ');
    assert.equal(cmd.text, '/help ');
    assert.equal(cmd.cursor, 6);
  });
});

describe('deleting the next word', () => {
  test('kills from the cursor to the end of the next word, and yank brings it back', () => {
    const ed = editor('git commit --amend', 4);
    ed.killWordForward();
    assert.equal(ed.text, 'git  --amend');
    assert.equal(ed.cursor, 4);
    ed.end();
    ed.yank();
    assert.equal(ed.text, 'git  --amendcommit');
  });

  test('skips the whitespace in front of the word', () => {
    const ed = editor('alpha   beta gamma', 5);
    ed.killWordForward();
    assert.equal(ed.text, 'alpha gamma');
    assert.equal(ed.cursor, 5);
    ed.yank();
    assert.equal(ed.text, 'alpha   beta gamma');
  });

  test('from inside a word only the rest of it goes', () => {
    const ed = editor('refactor', 2);
    ed.killWordForward();
    assert.equal(ed.text, 're');
    assert.equal(ed.cursor, 2);
  });

  test('crosses a line break to reach the next word', () => {
    const ed = editor('one\ntwo three', 3);
    ed.killWordForward();
    assert.equal(ed.text, 'one three');
    assert.equal(ed.cursor, 3);
  });

  test('at the end nothing happens and the previous kill is kept', () => {
    const ed = editor('keep me', 4);
    ed.killToEnd();
    ed.killWordForward();
    assert.equal(ed.text, 'keep');
    ed.yank();
    assert.equal(ed.text, 'keep me');
    const blank = editor('word   ', 4);
    blank.killWordForward(); // only spaces left: they go, like any other trailing text
    assert.equal(blank.text, 'word');
  });

  test('never splits a character', () => {
    const ed = editor(`a ${FAMILY}${THUMB} b`, 1);
    ed.killWordForward();
    assert.equal(ed.text, 'a b');
    assertOnBoundary(ed, 'after killing a word of emoji');
  });

  test('a collapsed paste is one word, forwards and backwards', () => {
    const big = Array.from({ length: 9 }, (_, i) => `row ${i}`).join('\n');
    const ed = editor('see ');
    ed.paste(big);
    ed.insert(' please');
    ed.cursor = 3;
    ed.killWordForward();
    assert.equal(ed.text, 'see please');
    // The placeholder is in the kill ring with its content still attached.
    ed.cursor = 3;
    ed.yank();
    assert.equal(ed.text, 'see [Pasted text #1 +9 lines] please');
    assert.equal(ed.value(), `see ${big} please`);
    ed.killWordBack();
    assert.equal(ed.text, 'see  please');
    assert.equal(ed.cursor, 4);
    assert.equal(ed.value(), 'see  please');
  });
});

describe('undo', () => {
  /** An editor on a clock the test moves by hand. */
  function clocked(): { ed: Editor; wait(ms: number): void } {
    let time = 1_000_000;
    return { ed: new Editor({ now: () => time }), wait: (ms) => void (time += ms) };
  }

  /** Undo until nothing is left, returning the text after each step. */
  function unwind(ed: Editor): string[] {
    const seen: string[] = [];
    while (ed.undo()) seen.push(ed.text);
    return seen;
  }

  test('with nothing done there is nothing to undo', () => {
    const ed = editor();
    assert.equal(ed.canUndo, false);
    assert.equal(ed.undo(), false);
    assert.equal(ed.text, '');
  });

  test('characters typed one after another are one step', () => {
    const ed = editor();
    for (const ch of 'hello world') ed.insert(ch);
    assert.equal(ed.canUndo, true);
    assert.equal(ed.undo(), true);
    assert.equal(ed.text, '');
    assert.equal(ed.cursor, 0);
    assert.equal(ed.undo(), false);
  });

  test('a pause in the typing starts a new step', () => {
    const { ed, wait } = clocked();
    for (const ch of 'first') ed.insert(ch);
    wait(999);
    ed.insert(' ');
    wait(1000);
    for (const ch of 'second') {
      ed.insert(ch);
      wait(400); // slow typing is still one run: the pause is measured between keys
    }
    assert.equal(ed.text, 'first second');
    assert.deepEqual(unwind(ed), ['first ', '']);
  });

  test('moving the cursor between keystrokes starts a new step', () => {
    const ed = editor();
    ed.insert('world');
    ed.home();
    ed.insert('hello ');
    assert.equal(ed.text, 'hello world');
    ed.undo();
    assert.equal(ed.text, 'world');
    assert.equal(ed.cursor, 0, 'the cursor goes back to where the edit was made');
    ed.undo();
    assert.equal(ed.text, '');
  });

  test('a run of backspaces is one step, apart from the typing before it', () => {
    const ed = editor();
    ed.insert('abcdef');
    ed.backspace();
    ed.backspace();
    ed.backspace();
    assert.equal(ed.text, 'abc');
    ed.undo();
    assert.equal(ed.text, 'abcdef');
    assert.equal(ed.cursor, 6);
    ed.undo();
    assert.equal(ed.text, '');
  });

  test('a run of forward deletes is one step, and typing after it another', () => {
    const ed = editor();
    ed.insert('abcdef');
    ed.cursor = 1;
    ed.del();
    ed.del();
    ed.insert('X');
    assert.equal(ed.text, 'aXdef');
    assert.deepEqual(unwind(ed), ['adef', 'abcdef', '']);
  });

  test('pastes, kills and yanks are each a step of their own', () => {
    const ed = editor();
    ed.insert('one ');
    ed.paste('two ');
    ed.paste('three');
    ed.insert('!');
    assert.equal(ed.text, 'one two three!');
    ed.killWordBack();
    ed.killWordBack();
    assert.equal(ed.text, 'one ');
    ed.yank();
    ed.yank();
    assert.equal(ed.text, 'one two two ');
    ed.cursor = 4;
    ed.killToEnd();
    ed.home();
    ed.killWordForward();
    assert.equal(ed.text, ' ');
    assert.deepEqual(unwind(ed), ['one ', 'one two two ', 'one two ', 'one ', 'one two ', 'one two three!', 'one two three', 'one two ', 'one ', '']);
  });

  test('accepting a completion is a step, so undo gives back what was typed', () => {
    const ed = editor();
    ed.insert('look at @sr');
    ed.replaceRange(ed.completionToken()!.start, '@src/ui/app.ts ');
    ed.insert('now');
    assert.equal(ed.text, 'look at @src/ui/app.ts now');
    ed.undo();
    assert.equal(ed.text, 'look at @src/ui/app.ts ');
    ed.undo();
    assert.equal(ed.text, 'look at @sr');
    assert.equal(ed.cursor, 11);
    assert.deepEqual(ed.completionToken(), { kind: 'file', query: 'sr', start: 8 });
  });

  test('each history recall is a step, and navigation carries on from where undo leaves it', () => {
    const ed = editor();
    ed.setHistory(['first', 'second', 'third']);
    ed.insert('draft');
    ed.historyPrev();
    ed.historyPrev();
    assert.equal(ed.text, 'second');
    ed.undo();
    assert.equal(ed.text, 'third');
    // Still on the newest entry: up continues to the one before it, down returns to the draft.
    ed.historyPrev();
    assert.equal(ed.text, 'second');
    ed.undo();
    ed.historyNext();
    assert.equal(ed.text, 'draft');
    ed.undo();
    assert.equal(ed.text, 'third');
    ed.undo();
    assert.equal(ed.text, 'draft');
    assert.equal(ed.cursor, 5);
    // Back on the draft itself, not on a history entry.
    assert.equal(ed.historyNext(), false);
    ed.undo();
    assert.equal(ed.text, '');
    assert.equal(ed.undo(), false);
  });

  test('editing a recalled entry and undoing returns to the entry, then to the draft', () => {
    const ed = editor();
    ed.setHistory(['run the tests']);
    ed.insert('half a thought');
    ed.historyPrev();
    ed.insert(' again');
    assert.deepEqual(unwind(ed), ['run the tests', 'half a thought', '']);
  });

  test('an edit that changes nothing adds no step', () => {
    const ed = editor();
    ed.insert('abc');
    ed.home();
    ed.backspace();
    ed.killToStart();
    ed.killWordBack();
    ed.end();
    ed.del();
    ed.killToEnd();
    ed.killWordForward();
    ed.insert('');
    ed.paste('');
    const fresh = editor('abc');
    fresh.yank(); // nothing killed yet
    assert.equal(fresh.canUndo, false);
    assert.deepEqual(unwind(ed), ['']);
  });

  test('typing after an undo is a new step, not part of the one before', () => {
    const ed = editor();
    ed.insert('abc');
    ed.killToStart();
    ed.undo();
    assert.equal(ed.text, 'abc');
    ed.insert('d');
    ed.insert('e');
    assert.deepEqual(unwind(ed), ['abc', '']);
  });

  test('the number of steps kept is bounded: the oldest are dropped', () => {
    const ed = editor();
    for (let i = 0; i < 250; i++) ed.paste(`${i} `);
    const full = ed.text;
    const seen = unwind(ed);
    assert.equal(seen.length, 100);
    // What is left is the state 100 steps back, not the empty prompt.
    assert.equal(ed.text, Array.from({ length: 150 }, (_, i) => `${i} `).join(''));
    assert.ok(full.startsWith(ed.text));
    assert.equal(ed.canUndo, false);
  });

  test('clear() forgets every step: a submitted prompt cannot be undone into the next one', () => {
    const ed = editor();
    ed.insert('sent to the model');
    ed.killWordBack();
    ed.clear();
    assert.equal(ed.canUndo, false);
    assert.equal(ed.undo(), false);
    assert.equal(ed.text, '');
    ed.insert('next');
    assert.deepEqual(unwind(ed), ['']);
  });

  test('discard() empties the prompt but can be undone', () => {
    const ed = editor();
    ed.setHistory(['old']);
    ed.insert('typed with care');
    ed.cursor = 5;
    ed.discard();
    assert.equal(ed.isEmpty, true);
    assert.equal(ed.cursor, 0);
    ed.discard(); // already empty: not a step
    ed.undo();
    assert.equal(ed.text, 'typed with care');
    assert.equal(ed.cursor, 5);
    // Discarding a recalled entry leaves history navigation at the newest entry again.
    ed.discard();
    ed.historyPrev();
    assert.equal(ed.text, 'old');
    ed.discard();
    ed.historyPrev();
    assert.equal(ed.text, 'old');
  });

  test('set() is a new starting point that undo does not go back past', () => {
    const ed = editor();
    ed.insert('before');
    ed.set('loaded');
    assert.equal(ed.canUndo, false);
    ed.insert(' and edited');
    assert.deepEqual(unwind(ed), ['loaded']);
  });

  describe('with collapsed pastes', () => {
    const big = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

    test('undoing a paste removes the placeholder, and what is sent no longer has it', () => {
      const ed = editor();
      ed.insert('review: ');
      ed.paste(big);
      assert.equal(ed.text, 'review: [Pasted text #1 +12 lines]');
      ed.undo();
      assert.equal(ed.text, 'review: ');
      assert.equal(ed.value(), 'review: ');
    });

    test('undoing the backspace that removed a paste restores the placeholder and its content', () => {
      const ed = editor();
      ed.insert('review: ');
      ed.paste(big);
      ed.backspace();
      assert.equal(ed.value(), 'review: ');
      ed.undo();
      assert.equal(ed.text, 'review: [Pasted text #1 +12 lines]');
      assert.equal(ed.cursor, ed.text.length);
      assert.equal(ed.value(), `review: ${big}`);
    });

    test('a second paste after an undone one gets a number of its own', () => {
      const ed = editor();
      ed.paste(big);
      ed.undo();
      ed.paste(big.toUpperCase());
      assert.equal(ed.text, '[Pasted text #2 +12 lines]');
      assert.equal(ed.value(), big.toUpperCase());
    });

    test('a killed placeholder can be yanked back after undoing past its paste', () => {
      const ed = editor();
      ed.paste(big);
      ed.killToStart();
      ed.undo(); // the kill
      ed.undo(); // the paste
      assert.equal(ed.text, '');
      ed.yank();
      assert.equal(ed.text, '[Pasted text #1 +12 lines]');
      assert.equal(ed.value(), big);
    });

    test('undo walks back through typing around a paste in order', () => {
      const ed = editor();
      ed.insert('a ');
      ed.paste(big);
      ed.insert(' b');
      assert.deepEqual(unwind(ed), ['a [Pasted text #1 +12 lines]', 'a ', '']);
    });

    test('a discarded prompt comes back with its paste intact', () => {
      const ed = editor();
      ed.insert('explain ');
      ed.paste(big);
      ed.discard();
      assert.equal(ed.value(), '');
      ed.undo();
      assert.equal(ed.value(), `explain ${big}`);
    });
  });
});

describe('replacing the whole prompt', () => {
  test('is one undo step and leaves the cursor at the end', () => {
    const ed = editor();
    ed.insert('first draft');
    ed.replaceAll('rewritten\nin an editor');
    assert.equal(ed.text, 'rewritten\nin an editor');
    assert.equal(ed.cursor, ed.text.length);
    ed.undo();
    assert.equal(ed.text, 'first draft');
  });

  test('line endings and tabs are normalised like typed text', () => {
    const ed = editor();
    ed.replaceAll('a\r\nb\rc\td');
    assert.equal(ed.text, 'a\nb\nc  d');
  });

  test('a paste that comes back untouched keeps its placeholder; a changed one is plain text', () => {
    const big = Array.from({ length: 8 }, (_, i) => `\tcode ${i}`).join('\n');
    const ed = editor();
    ed.insert('fix this: ');
    ed.paste(big);
    ed.replaceAll(`please fix this: ${big}\nthanks`);
    assert.equal(ed.text, 'please fix this: [Pasted text #1 +8 lines]\nthanks');
    assert.equal(ed.value(), `please fix this: ${big}\nthanks`, 'the tabs of the paste survive');
    ed.replaceAll(`please fix this: ${big.replace('code 3', 'CODE 3')}`);
    assert.ok(!ed.text.includes('[Pasted text'));
    assert.ok(ed.value().includes('CODE 3'));
    assert.equal(ed.value(), ed.text);
  });

  test('replacing with the same text is not a step', () => {
    const ed = editor();
    ed.replaceAll('same');
    ed.replaceAll('same');
    ed.undo();
    assert.equal(ed.text, '');
    assert.equal(ed.canUndo, false);
  });
});

describe('reverse history search', () => {
  const HISTORY = ['fix the login bug', 'add tests for the parser', 'Explain how LOGIN works', 'refactor the screen module', 'add tests for the parser'];

  function searching(draft = ''): Editor {
    const ed = editor();
    ed.setHistory(HISTORY);
    if (draft) ed.insert(draft);
    ed.searchStart();
    return ed;
  }

  test('no search is open until one is started', () => {
    const ed = editor('text');
    assert.equal(ed.search, null);
    // The search operations do nothing on their own.
    ed.searchInput('x');
    ed.searchBackspace();
    ed.searchOlder();
    ed.searchCancel();
    assert.equal(ed.searchAccept(), false);
    assert.equal(ed.text, 'text');
    assert.equal(ed.search, null);
  });

  test('an empty query matches nothing and leaves the prompt alone', () => {
    const ed = searching('my draft');
    assert.deepEqual(ed.search, { query: '', match: null, exhausted: false });
    assert.equal(ed.text, 'my draft');
  });

  test('typing narrows to the most recent entry containing the query, ignoring case', () => {
    const ed = searching('my draft');
    ed.searchInput('t');
    assert.equal(ed.search!.match, 'add tests for the parser');
    ed.searchInput('h');
    ed.searchInput('e');
    assert.deepEqual(ed.search, { query: 'the', match: 'add tests for the parser', exhausted: false });
    ed.searchInput(' s');
    assert.equal(ed.search!.match, 'refactor the screen module');
    const cased = searching();
    cased.searchInput('login');
    assert.equal(cased.search!.match, 'Explain how LOGIN works');
    const upper = searching();
    upper.searchInput('FIX THE');
    assert.equal(upper.search!.match, 'fix the login bug');
  });

  test('the match is previewed in the buffer with the cursor at its end', () => {
    const ed = searching('my draft');
    ed.searchInput('screen');
    assert.equal(ed.text, 'refactor the screen module');
    assert.equal(ed.cursor, ed.text.length);
  });

  test('asking again moves to the next older match and skips repeats of the one shown', () => {
    const ed = searching();
    ed.searchInput('e');
    const seen = [ed.search!.match];
    for (let i = 0; i < 3; i++) {
      ed.searchOlder();
      seen.push(ed.search!.match);
    }
    assert.deepEqual(seen, ['add tests for the parser', 'refactor the screen module', 'Explain how LOGIN works', 'add tests for the parser']);
    assert.equal(ed.search!.exhausted, false);
  });

  test('with no older match the current one stays and the search says so', () => {
    const ed = searching('draft');
    ed.searchInput('login');
    ed.searchOlder();
    assert.deepEqual(ed.search, { query: 'login', match: 'fix the login bug', exhausted: false });
    ed.searchOlder();
    assert.deepEqual(ed.search, { query: 'login', match: 'fix the login bug', exhausted: true });
    assert.equal(ed.text, 'fix the login bug');
    // Typing more searches afresh and clears the flag.
    ed.searchInput(' b');
    assert.deepEqual(ed.search, { query: 'login b', match: 'fix the login bug', exhausted: false });
  });

  test('typing after stepping back finds the newest entry for the longer query again', () => {
    const ed = editor();
    ed.setHistory(['alpha one', 'beta one', 'alpha two', 'alpha three']);
    ed.searchStart();
    ed.searchInput('alpha');
    ed.searchOlder();
    ed.searchOlder();
    assert.equal(ed.search!.match, 'alpha one');
    ed.searchInput(' t');
    assert.equal(ed.search!.match, 'alpha three');
    ed.searchOlder();
    assert.equal(ed.search!.match, 'alpha two');
  });

  test('a query nothing contains has no match, and the buffer shows the prompt from before', () => {
    const ed = editor('my draft', 2);
    ed.setHistory(HISTORY);
    ed.searchStart();
    ed.searchInput('parser');
    ed.searchInput('zz');
    assert.deepEqual(ed.search, { query: 'parserzz', match: null, exhausted: false });
    assert.equal(ed.text, 'my draft');
    assert.equal(ed.cursor, 2);
    ed.searchOlder(); // nothing to step through
    assert.equal(ed.search!.match, null);
    assert.equal(ed.search!.exhausted, false);
  });

  test('backspace edits the query, and the match is the newest entry for what is left', () => {
    const ed = searching('my draft');
    ed.searchInput('login');
    ed.searchOlder();
    assert.equal(ed.search!.match, 'fix the login bug');
    ed.searchInput('x');
    assert.equal(ed.search!.match, null);
    ed.searchBackspace();
    assert.deepEqual(ed.search, { query: 'login', match: 'Explain how LOGIN works', exhausted: false });
    for (let i = 0; i < 5; i++) ed.searchBackspace();
    assert.deepEqual(ed.search, { query: '', match: null, exhausted: false });
    assert.equal(ed.text, 'my draft');
    ed.searchBackspace(); // nothing left to remove
    assert.deepEqual(ed.search, { query: '', match: null, exhausted: false });
  });

  test('backspace removes a whole character from the query', () => {
    const ed = searching();
    ed.searchInput(`a${THUMB}`);
    ed.searchBackspace();
    assert.equal(ed.search!.query, 'a');
  });

  test('pasted text joins the query with its line breaks flattened', () => {
    const ed = searching();
    ed.searchInput('tests\nfor');
    assert.equal(ed.search!.query, 'tests for');
    assert.equal(ed.search!.match, 'add tests for the parser');
  });

  test('accepting puts the match in the prompt and ends the search', () => {
    const ed = searching('my draft');
    ed.searchInput('screen');
    assert.equal(ed.searchAccept(), true);
    assert.equal(ed.search, null);
    assert.equal(ed.text, 'refactor the screen module');
    assert.equal(ed.cursor, ed.text.length);
  });

  test('accepting is one undo step back to the prompt from before', () => {
    const ed = searching();
    ed.searchCancel();
    ed.insert('my draft');
    ed.searchStart();
    ed.searchInput('log');
    ed.searchInput('i');
    ed.searchOlder();
    ed.searchAccept();
    assert.equal(ed.text, 'fix the login bug');
    ed.undo();
    assert.equal(ed.text, 'my draft');
    ed.undo();
    assert.equal(ed.text, '');
    assert.equal(ed.undo(), false);
  });

  test('cancelling restores the prompt and the cursor, and adds no undo step', () => {
    const ed = searching();
    ed.searchCancel();
    ed.insert('my draft');
    ed.cursor = 3;
    ed.searchStart();
    ed.searchInput('parser');
    assert.equal(ed.text, 'add tests for the parser');
    ed.searchCancel();
    assert.equal(ed.search, null);
    assert.equal(ed.text, 'my draft');
    assert.equal(ed.cursor, 3);
    ed.undo();
    assert.equal(ed.text, '');
  });

  test('accepting with no match gives the old prompt back', () => {
    const ed = searching('my draft');
    ed.searchInput('nothing like this');
    assert.equal(ed.searchAccept(), false);
    assert.equal(ed.search, null);
    assert.equal(ed.text, 'my draft');
    const untouched = searching('my draft');
    assert.equal(untouched.searchAccept(), false);
    assert.equal(untouched.text, 'my draft');
  });

  test('up and down carry on from an accepted match, ending at the draft', () => {
    const ed = searching('my draft');
    ed.searchInput('login');
    ed.searchAccept();
    assert.equal(ed.text, 'Explain how LOGIN works');
    ed.historyPrev();
    assert.equal(ed.text, 'add tests for the parser');
    ed.historyNext();
    ed.historyNext();
    assert.equal(ed.text, 'refactor the screen module');
    ed.historyNext();
    ed.historyNext();
    assert.equal(ed.text, 'my draft');
    assert.equal(ed.historyNext(), false);
  });

  test('asking again with nothing typed repeats the previous search', () => {
    const ed = searching();
    ed.searchOlder(); // no earlier search to repeat
    assert.deepEqual(ed.search, { query: '', match: null, exhausted: false });
    ed.searchInput('parser');
    ed.searchCancel();
    ed.searchStart();
    ed.searchOlder();
    assert.deepEqual(ed.search, { query: 'parser', match: 'add tests for the parser', exhausted: false });
  });

  test('starting a search twice keeps the prompt saved by the first', () => {
    const ed = searching('my draft');
    ed.searchInput('screen');
    ed.searchStart();
    assert.equal(ed.search!.query, 'screen');
    ed.searchCancel();
    assert.equal(ed.text, 'my draft');
  });

  test('with no history every query fails', () => {
    const ed = editor('draft');
    ed.searchStart();
    ed.searchInput('a');
    assert.deepEqual(ed.search, { query: 'a', match: null, exhausted: false });
    assert.equal(ed.searchAccept(), false);
    assert.equal(ed.text, 'draft');
  });

  test('a prompt with a collapsed paste survives a search that was cancelled', () => {
    const big = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const ed = editor();
    ed.setHistory(HISTORY);
    ed.insert('explain ');
    ed.paste(big);
    ed.searchStart();
    ed.searchInput('login');
    ed.searchCancel();
    assert.equal(ed.text, 'explain [Pasted text #1 +12 lines]');
    assert.equal(ed.value(), `explain ${big}`);
  });

  test('multi-line entries are found by text on any of their lines', () => {
    const ed = editor();
    ed.setHistory(['one\ntwo words\nthree', 'other']);
    ed.searchStart();
    ed.searchInput('two w');
    ed.searchAccept();
    assert.equal(ed.text, 'one\ntwo words\nthree');
  });

  test('clear() ends a search', () => {
    const ed = searching('draft');
    ed.searchInput('login');
    ed.clear();
    assert.equal(ed.search, null);
    assert.equal(ed.text, '');
  });
});

describe('stash', () => {
  test('stashing empties the prompt; restoring brings back the text and the cursor', () => {
    const ed = editor();
    ed.insert('half-written thought');
    ed.cursor = 4;
    assert.equal(ed.stashCount, 0);
    assert.equal(ed.stash(), true);
    assert.equal(ed.isEmpty, true);
    assert.equal(ed.cursor, 0);
    assert.equal(ed.stashCount, 1);
    assert.equal(ed.unstash(), true);
    assert.equal(ed.text, 'half-written thought');
    assert.equal(ed.cursor, 4);
    assert.equal(ed.stashCount, 0);
  });

  test('an empty prompt is not stashed, and there may be nothing to restore', () => {
    const ed = editor();
    assert.equal(ed.stash(), false);
    assert.equal(ed.unstash(), false);
    assert.equal(ed.stashCount, 0);
  });

  test('a stash is only restored into an empty prompt', () => {
    const ed = editor();
    ed.insert('parked');
    ed.stash();
    ed.insert('new text');
    assert.equal(ed.unstash(), false);
    assert.equal(ed.text, 'new text');
    assert.equal(ed.stashCount, 1);
  });

  test('several stashes come back newest first', () => {
    const ed = editor();
    for (const text of ['one', 'two', 'three']) {
      ed.insert(text);
      ed.stash();
    }
    assert.equal(ed.stashCount, 3);
    const back: string[] = [];
    while (ed.unstash()) {
      back.push(ed.text);
      ed.clear();
    }
    assert.deepEqual(back, ['three', 'two', 'one']);
  });

  test('a stash outlives the prompt submitted in between, pastes included', () => {
    const big = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const ed = editor();
    ed.insert('look at ');
    ed.paste(big);
    ed.stash();
    ed.insert('quick question');
    ed.addHistory(ed.text);
    ed.clear(); // submitted
    ed.unstash();
    assert.equal(ed.text, 'look at [Pasted text #1 +12 lines]');
    assert.equal(ed.value(), `look at ${big}`);
  });

  test('undo does not reach across a stash in either direction', () => {
    const ed = editor();
    ed.insert('parked');
    ed.stash();
    assert.equal(ed.undo(), false, 'the stashed text is not undone back into the prompt');
    ed.unstash();
    assert.equal(ed.undo(), false, 'and a restored prompt is not undone away');
    assert.equal(ed.text, 'parked');
    ed.insert(' and more');
    ed.undo();
    assert.equal(ed.text, 'parked');
  });

  test('history navigation starts from the newest entry after a restore', () => {
    const ed = editor();
    ed.setHistory(['old one', 'old two']);
    ed.historyPrev();
    ed.historyPrev();
    ed.stash();
    ed.unstash();
    assert.equal(ed.text, 'old one');
    ed.historyPrev();
    assert.equal(ed.text, 'old two');
  });
});
