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
