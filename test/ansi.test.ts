import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  c,
  expandTabs,
  padEnd,
  padStart,
  setColorEnabled,
  stringWidth,
  stripAnsi,
  truncate,
  wrapLine,
  wrapText,
} from '../src/ui/ansi.ts';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

afterEach(() => setColorEnabled(false));

/** Every row must fit, whatever the styling. */
function assertFits(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(stringWidth(line) <= width, `row wider than ${width}: ${JSON.stringify(line)}`);
  }
}

describe('stringWidth', () => {
  test('ASCII is one column per character', () => {
    assert.equal(stringWidth(''), 0);
    assert.equal(stringWidth('hello'), 5);
    assert.equal(stringWidth('a b c'), 5);
  });

  test('escape sequences take no space', () => {
    setColorEnabled(true);
    assert.equal(stringWidth(c.red('abc')), 3);
    assert.equal(stringWidth(c.bold(c.underline('héllo'))), 5);
    assert.equal(stringWidth(c.bg(22)(c.fg(194)('x y'))), 3);
    assert.equal(stringWidth('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), 4);
  });

  test('CJK and emoji are two columns', () => {
    assert.equal(stringWidth('日本語'), 6);
    assert.equal(stringWidth('한글'), 4);
    assert.equal(stringWidth('ａｂ'), 4);
    assert.equal(stringWidth('😀'), 2);
    assert.equal(stringWidth('🚀 go'), 5);
    assert.equal(stringWidth('a日b'), 4);
  });

  test('combining marks and joined emoji form one cell group', () => {
    assert.equal(stringWidth('é'), 1);
    assert.equal(stringWidth('👨‍👩‍👧'), 2);
    assert.equal(stringWidth('👍🏽'), 2);
    assert.equal(stringWidth('a​b'), 2);
  });

  test('a text symbol with the emoji variation selector is wide', () => {
    assert.equal(stringWidth('⚠️'), 2);
    assert.equal(stringWidth('❤️'), 2);
  });

  test('emoji-presentation symbols in the BMP are wide', () => {
    for (const ch of ['✅', '❌', '⭐', '⚡', '✨', '⏳']) assert.equal(stringWidth(ch), 2, ch);
  });

  test('flags and keycaps are wide', () => {
    assert.equal(stringWidth('🇺🇸'), 2);
    assert.equal(stringWidth('1️⃣'), 2);
  });
});

describe('wrapLine', () => {
  test('returns the line untouched when it fits', () => {
    assert.deepEqual(wrapLine('short', 10), ['short']);
    assert.deepEqual(wrapLine('exactly10!', 10), ['exactly10!']);
    assert.deepEqual(wrapLine('', 10, { indent: '  ' }), ['  ']);
  });

  test('breaks at spaces and drops the space at the break', () => {
    assert.deepEqual(wrapLine('the quick brown fox jumps over the lazy dog', 10), [
      'the quick',
      'brown fox',
      'jumps over',
      'the lazy',
      'dog',
    ]);
    assert.deepEqual(wrapLine('abcde fghij', 5), ['abcde', 'fghij']);
  });

  test('a word longer than the width is split', () => {
    const lines = wrapLine('aaa bbbbbbbbbbbbbbbbbbbbbbbb cc', 10);
    assert.deepEqual(lines, ['aaa', 'bbbbbbbbbb', 'bbbbbbbbbb', 'bbbb cc']);
    assertFits(lines, 10);
  });

  test('indent and hanging indent count against the width', () => {
    const lines = wrapLine('one two three four five six', 12, { indent: '> ', hangingIndent: '  ' });
    assert.deepEqual(lines, ['> one two', '  three four', '  five six']);
    assertFits(lines, 12);
  });

  test('hard mode breaks anywhere and keeps spaces', () => {
    assert.deepEqual(wrapLine('abcdefghijklmnopqrstuvwxyz', 10, { hard: true }), ['abcdefghij', 'klmnopqrst', 'uvwxyz']);
    const lines = wrapLine('ab cd ef gh ij kl mn', 7, { hard: true });
    assert.equal(lines.join(''), 'ab cd ef gh ij kl mn');
    assertFits(lines, 7);
    assert.deepEqual(wrapLine('const x = 1;', 20, { hard: true, indent: '    ' }), ['    const x = 1;']);
  });

  test('wide characters are measured by columns, not code units', () => {
    const lines = wrapLine('日本語のテキストを折り返す', 10);
    assert.deepEqual(lines, ['日本語のテ', 'キストを折', 'り返す']);
    assertFits(lines, 10);
    // An odd width cannot be filled exactly by double-width characters.
    assertFits(wrapLine('日本語のテキストを折り返す', 7, { hard: true }), 7);
  });

  test('styles are closed at each break and reopened on the next row', () => {
    setColorEnabled(true);
    const lines = wrapLine(c.bold('one two three four five six'), 12);
    assert.deepEqual(lines.map(stripAnsi), ['one two', 'three four', 'five six']);
    for (const line of lines) assert.ok(line.startsWith(BOLD), JSON.stringify(line));
    assert.ok(lines[0]!.endsWith(RESET));
    assert.ok(lines[1]!.endsWith(RESET));
    assertFits(lines, 12);
  });

  test('a style that starts mid-line carries only onto the rows it covers', () => {
    setColorEnabled(true);
    const lines = wrapLine(`aa ${c.red('bb cc dd ee ff gg')} hh ii`, 8);
    assert.deepEqual(lines.map(stripAnsi), ['aa bb cc', 'dd ee ff', 'gg hh ii']);
    assert.ok(lines[0]!.includes(RED) && lines[0]!.endsWith(RESET));
    assert.ok(lines[1]!.startsWith(RED) && lines[1]!.endsWith(RESET));
    assert.ok(lines[2]!.startsWith(RED));
    assert.ok(!lines[2]!.endsWith(RESET), 'the last row keeps its own close sequence');
  });

  test('nested styles are all restored after a break', () => {
    setColorEnabled(true);
    const lines = wrapLine(c.bold(`aaa ${c.red('bbb ccc ddd')} eee fff`), 9);
    assert.deepEqual(lines.map(stripAnsi), ['aaa bbb', 'ccc ddd', 'eee fff']);
    assert.ok(lines[1]!.startsWith('\x1b[1;31m'), JSON.stringify(lines[1]));
    assert.ok(lines[2]!.startsWith(BOLD));
  });

  test('styled text in hard mode', () => {
    setColorEnabled(true);
    const lines = wrapLine(c.green('abcdefghijklmnop'), 6, { hard: true });
    assert.deepEqual(lines.map(stripAnsi), ['abcdef', 'ghijkl', 'mnop']);
    for (const line of lines) assert.ok(line.startsWith('\x1b[32m'));
  });

  test('256-colour and background styles survive a wrap', () => {
    setColorEnabled(true);
    const lines = wrapLine(c.bg(52)(c.fg(224)('alpha beta gamma delta')), 11);
    assert.deepEqual(lines.map(stripAnsi), ['alpha beta', 'gamma delta']);
    assert.ok(lines[1]!.includes('48;5;52') && lines[1]!.includes('38;5;224'), JSON.stringify(lines[1]));
  });

  test('never produces rows wider than the width for ordinary text', () => {
    const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.';
    for (let width = 4; width <= 60; width++) {
      const lines = wrapLine(text, width, { indent: '  ' });
      assertFits(lines, width);
      // Once the longest word fits, wrapping only ever replaces a space with a break.
      if (width >= 14) assert.equal(lines.map((l) => l.trim()).join(' '), text, `width ${width}`);
      else assert.equal(lines.map((l) => l.trim()).join('').replace(/ /g, ''), text.replace(/ /g, ''), `width ${width}`);
    }
  });

  // Known problems in src/ui/ansi.ts (see the fork report).
  test('a hanging indent wider than the first indent still fits', () => {
    const lines = wrapLine('ab cdefghijklmnopqrstuvwxyz', 20, { indent: '', hangingIndent: ' '.repeat(15) });
    assertFits(lines, 20);
  });

  test('leading whitespace does not produce a whitespace-only row', () => {
    const lines = wrapLine('    four five six seven', 7);
    assert.ok(lines.every((l) => l.trim() !== ''), JSON.stringify(lines));
  });

  test('a wide character in a one-column width does not add an empty row', () => {
    assert.deepEqual(wrapLine('日本', 1), ['日', '本']);
  });
});

describe('wrapText', () => {
  test('wraps each line and applies the hanging indent after the first', () => {
    const lines = wrapText('one two three\nfour five six seven', 9, { indent: '- ', hangingIndent: '  ' });
    assert.deepEqual(lines, ['- one two', '  three', '  four', '  five', '  six', '  seven']);
  });

  test('keeps blank lines and expands tabs', () => {
    assert.deepEqual(wrapText('a\n\nb', 10), ['a', '', 'b']);
    assert.deepEqual(wrapText('a\tb', 20), ['a   b']);
  });
});

describe('truncate', () => {
  test('leaves short strings alone', () => {
    assert.equal(truncate('hello', 5), 'hello');
    assert.equal(truncate('', 3), '');
  });

  test('cuts and appends an ellipsis within the width', () => {
    assert.equal(truncate('hello world', 8), 'hello w…');
    assert.equal(stringWidth(truncate('hello world', 8)), 8);
    assert.equal(truncate('hello world', 8, '...'), 'hello...');
    assert.equal(truncate('abc', 1), '…');
    assert.equal(truncate('abc', 0), '');
  });

  test('does not split a wide character', () => {
    const cut = truncate('日本語テキスト', 6);
    assert.equal(cut, '日本…');
    assert.ok(stringWidth(cut) <= 6);
  });

  test('closes open styles before the ellipsis', () => {
    setColorEnabled(true);
    const cut = truncate(c.red('hello world'), 8);
    assert.equal(stripAnsi(cut), 'hello w…');
    assert.ok(cut.endsWith(`${RESET}…`), JSON.stringify(cut));
    assert.equal(stringWidth(cut), 8);
  });
});

describe('expandTabs', () => {
  test('advances to the next tab stop', () => {
    assert.equal(expandTabs('a\tb\tccccc\td'), 'a   b   ccccc   d');
    assert.equal(expandTabs('\tx', 2), '  x');
    assert.equal(expandTabs('no tabs'), 'no tabs');
  });

  test('ignores escape sequences when counting columns', () => {
    setColorEnabled(true);
    assert.equal(stripAnsi(expandTabs(`${c.red('a')}\tb`)), 'a   b');
  });

  test('counts wide characters as two columns', () => {
    assert.equal(expandTabs('日\tx'), '日  x');
  });
});

describe('padding', () => {
  test('pads by display width', () => {
    assert.equal(padEnd('ab', 5), 'ab   ');
    assert.equal(padStart('ab', 5), '   ab');
    assert.equal(padEnd('日本', 6), '日本  ');
    assert.equal(padEnd('toolong', 3), 'toolong');
  });

  test('ignores styling', () => {
    setColorEnabled(true);
    assert.equal(stringWidth(padEnd(c.red('ab'), 5)), 5);
  });
});
