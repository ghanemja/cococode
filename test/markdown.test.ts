import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { setColorEnabled, stringWidth, stripAnsi } from '../src/ui/ansi.ts';
import { MarkdownStream, renderInline, renderMarkdown } from '../src/ui/markdown.ts';

const BOLD = '\x1b[1m';
const BOLD_OFF = '\x1b[22m';
const ITALIC = '\x1b[3m';
const ITALIC_OFF = '\x1b[23m';
const UNDERLINE = '\x1b[4m';
const UNDERLINE_OFF = '\x1b[24m';
const STRIKE = '\x1b[9m';
const STRIKE_OFF = '\x1b[29m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const FG_OFF = '\x1b[39m';

afterEach(() => setColorEnabled(false));

const md = (text: string, width = 80, indent = '') => renderMarkdown(text, width, indent);

/** A document exercising every construct, used for the streaming properties. */
const SAMPLE = `# Project *overview*

Intro paragraph with **bold**, *italic*, ~~struck~~, \`inline code\` and a [link](https://example.com/docs) that is long enough to wrap around on narrow terminals. It mentions snake_case_names and 2 * 3 * 4.

Setext heading
==============

Second level
------------

## Lists

- first item with enough words to need wrapping when the terminal is not very wide at all
  - nested **bold** item
    - third level
- second item
* star bullet
+ plus bullet

1. ordered one
2. ordered two with a long tail that keeps going and going so that it wraps onto another row
10. tenth

- [ ] open task
- [x] finished task

> A quote with *emphasis* that is also long enough to wrap around when the width is small.
>
> > nested quote

| Name | Count | Notes |
|:-----|------:|:-----:|
| alpha | 1 | the first row has a rather long note in it |
| beta | 22 | \`a|b\` and **bold** |
| gamma \\| delta | 333 | |

\`\`\`ts
// a comment
const answer: number = 42;
/* block
   comment */
const s = \`multi
line\`;
\`\`\`

~~~
plain *fence* with **markup** left alone
    indented
~~~

1. Step with code:
   \`\`\`bash
   npm install # deps
   \`\`\`

***

Trailing paragraph with a bare URL https://example.com/a_b_c?x=1, and an unterminated **bold.

Final line without newline`;

describe('inline markup', () => {
  test('emphasis, code and strike produce the right styles', () => {
    setColorEnabled(true);
    assert.equal(renderInline('a **b** c'), `a ${BOLD}b${BOLD_OFF} c`);
    assert.equal(renderInline('a __b__ c'), `a ${BOLD}b${BOLD_OFF} c`);
    assert.equal(renderInline('a *b* c'), `a ${ITALIC}b${ITALIC_OFF} c`);
    assert.equal(renderInline('a _b_ c'), `a ${ITALIC}b${ITALIC_OFF} c`);
    assert.equal(renderInline('a ~~b~~ c'), `a ${STRIKE}b${STRIKE_OFF} c`);
    assert.equal(renderInline('a `b` c'), `a ${CYAN}b${FG_OFF} c`);
    assert.equal(renderInline('***both***'), `${BOLD}${ITALIC}both${ITALIC_OFF}${BOLD_OFF}`);
  });

  test('nested emphasis', () => {
    setColorEnabled(true);
    assert.equal(stripAnsi(renderInline('**bold with *italic* inside**')), 'bold with italic inside');
    assert.ok(renderInline('**bold with *italic* inside**').includes(ITALIC));
    assert.equal(stripAnsi(renderInline('*italic with **bold** inside*')), 'italic with bold inside');
    assert.equal(stripAnsi(renderInline('**a *b***')), 'a b');
    assert.equal(stripAnsi(renderInline('*a **b***')), 'a b');
    assert.equal(stripAnsi(renderInline('**`code` in bold**')), 'code in bold');
  });

  test('underscores inside words are literal', () => {
    setColorEnabled(true);
    assert.equal(renderInline('snake_case_name and __dunder_name'), 'snake_case_name and __dunder_name');
    assert.equal(renderInline('file_name.py and other_file.py'), 'file_name.py and other_file.py');
    assert.equal(renderInline('a_b_ c'), 'a_b_ c');
  });

  test('asterisks that are not emphasis stay literal', () => {
    setColorEnabled(true);
    assert.equal(renderInline('2 * 3 * 4'), '2 * 3 * 4');
    assert.equal(renderInline('a * b'), 'a * b');
    assert.equal(renderInline('**unterminated bold'), '**unterminated bold');
    assert.equal(renderInline('*unterminated'), '*unterminated');
    assert.equal(renderInline('trailing **'), 'trailing **');
    assert.equal(renderInline('****'), '****');
    assert.equal(renderInline('~~unterminated'), '~~unterminated');
    assert.equal(renderInline('`unterminated'), '`unterminated');
  });

  test('backslash escapes', () => {
    setColorEnabled(true);
    assert.equal(renderInline('\\*not italic\\*'), '*not italic*');
    assert.equal(renderInline('\\`tick\\` and \\[x\\]'), '`tick` and [x]');
    assert.equal(renderInline('C:\\path\\name'), 'C:\\path\\name');
  });

  test('markup inside code spans is untouched', () => {
    setColorEnabled(true);
    assert.equal(renderInline('`**x** _y_ [z](u)`'), `${CYAN}**x** _y_ [z](u)${FG_OFF}`);
    assert.equal(renderInline('``a ` b``'), `${CYAN}a \` b${FG_OFF}`);
    assert.equal(renderInline('*a `*` b*'), `${ITALIC}a ${CYAN}*${FG_OFF} b${ITALIC_OFF}`);
  });

  test('links show the text underlined and the target dimmed', () => {
    setColorEnabled(true);
    assert.equal(renderInline('[docs](https://example.com)'), `${UNDERLINE}docs${UNDERLINE_OFF} ${DIM}(https://example.com)${BOLD_OFF}`);
    assert.equal(renderInline('[https://example.com](https://example.com)'), `${UNDERLINE}https://example.com${UNDERLINE_OFF}`);
    assert.equal(renderInline('[src/a.ts](src/a.ts)'), `${UNDERLINE}src/a.ts${UNDERLINE_OFF}`);
    assert.equal(stripAnsi(renderInline('[**bold** link](x.md "Title")')), 'bold link (x.md)');
    assert.equal(stripAnsi(renderInline('![diagram](img.png)')), 'diagram (img.png)');
    assert.equal(stripAnsi(renderInline('[a](https://en.wikipedia.org/wiki/A_(letter)) b')), 'a (https://en.wikipedia.org/wiki/A_(letter)) b');
    assert.equal(renderInline('<https://example.com>'), `${UNDERLINE}https://example.com${UNDERLINE_OFF}`);
  });

  test('things that only look like links are literal', () => {
    setColorEnabled(true);
    assert.equal(renderInline('[not a link]'), '[not a link]');
    assert.equal(renderInline('[x] (y)'), '[x] (y)');
    assert.equal(renderInline('arr[i](a b)'), 'arr[i](a b)');
    assert.equal(renderInline('[unclosed](x'), '[unclosed](x');
    assert.equal(renderInline('a < b > c'), 'a < b > c');
  });

  test('bare URLs are left alone, including their underscores', () => {
    setColorEnabled(true);
    assert.equal(renderInline('see https://example.com/a_b_c/d_e.'), 'see https://example.com/a_b_c/d_e.');
    assert.equal(renderInline('(https://example.com/x_y_z)'), '(https://example.com/x_y_z)');
    assert.equal(renderInline('**https://example.com/a_b**'), `${BOLD}https://example.com/a_b${BOLD_OFF}`);
  });
});

describe('blocks', () => {
  test('ATX headings are bold; h1 is also underlined', () => {
    setColorEnabled(true);
    assert.deepEqual(md('# One'), [`${BOLD}${UNDERLINE}One${UNDERLINE_OFF}${BOLD_OFF}`]);
    assert.deepEqual(md('## Two'), [`${BOLD}Two${BOLD_OFF}`]);
    assert.deepEqual(md('###### Six ######'), [`${BOLD}Six${BOLD_OFF}`]);
    assert.deepEqual(md('# C#').map(stripAnsi), ['C#']);
    assert.deepEqual(md('#hashtag'), ['#hashtag']);
    assert.deepEqual(md('####### seven'), ['####### seven']);
  });

  test('setext headings', () => {
    setColorEnabled(true);
    assert.deepEqual(md('Title\n=====\n\nSub\n---\ntext'), [`${BOLD}${UNDERLINE}Title${UNDERLINE_OFF}${BOLD_OFF}`, '', `${BOLD}Sub${BOLD_OFF}`, 'text']);
  });

  test('paragraphs wrap at word boundaries', () => {
    assert.deepEqual(md('the quick brown fox jumps over the lazy dog', 16), ['the quick brown', 'fox jumps over', 'the lazy dog']);
  });

  test('bullets get a dot and a hanging indent', () => {
    assert.deepEqual(md('- alpha beta gamma delta\n* two\n+ three', 14), ['• alpha beta', '  gamma delta', '• two', '• three']);
  });

  test('nested and ordered lists keep their indentation', () => {
    assert.deepEqual(md('- a\n  - b bb bbb bbbb bbbbb bbbbbb\n    - c\n1. one\n2. two words here and more of them\n   continuation', 24), [
      '• a',
      '  • b bb bbb bbbb bbbbb',
      '    bbbbbb',
      '    • c',
      '1. one',
      '2. two words here and',
      '   more of them',
      '   continuation',
    ]);
    assert.deepEqual(md('10) ten is long enough', 12), ['10) ten is', '    long', '    enough']);
    assert.deepEqual(md('\t- tab nested'), ['    • tab nested']);
  });

  test('deep nesting is flattened rather than squeezing the text on narrow terminals', () => {
    const rows = md('- a\n        - deeply nested words here', 20);
    assert.deepEqual(rows, ['• a', '    • deeply nested', '      words here']);
    for (const row of rows) assert.ok(stringWidth(row) <= 20);
  });

  test('task list items', () => {
    assert.deepEqual(md('- [ ] todo\n- [x] done\n- [X] also done'), ['☐ todo', '☑ done', '☑ also done']);
  });

  test('a list marker needs a following space', () => {
    assert.deepEqual(md('-not a list\n*emphasis* first\n1.5 is a number'), ['-not a list', 'emphasis first', '1.5 is a number']);
  });

  test('blockquotes have a gutter on every row, including wrapped ones', () => {
    assert.deepEqual(md('> quoted words that wrap\n>\n> > inner', 14), ['│ quoted words', '│ that wrap', '│', '│ │ inner']);
    assert.deepEqual(md('> - item\n> # head'), ['│ • item', '│ head']);
  });

  test('horizontal rules span the width', () => {
    assert.deepEqual(md('a\n\n---\n\nb', 10), ['a', '', '──────────', '', 'b']);
    assert.deepEqual(md('***\n___\n- - -', 5), ['─────', '─────', '─────']);
    assert.deepEqual(md('x\n\n---', 10, '  '), ['  x', '', '  ────────']);
  });

  test('blank lines collapse; leading and trailing ones are dropped', () => {
    assert.deepEqual(md('\n\n\na\n\n\n\nb\n\n\n'), ['a', '', 'b']);
    assert.deepEqual(md(''), []);
    assert.deepEqual(md('\n \n\t\n'), []);
  });

  test('every non-empty row carries the indent', () => {
    const rows = md(SAMPLE, 50, '>> ');
    assert.ok(rows.length > 20);
    for (const row of rows) assert.ok(row === '' || row.startsWith('>> '), JSON.stringify(row));
  });

  test('CRLF input renders like LF input', () => {
    assert.deepEqual(md(SAMPLE.replace(/\n/g, '\r\n'), 60), md(SAMPLE, 60));
  });

  test('control characters are removed from the output', () => {
    const rows = md('a\x1b[31mb\x07c\x00d');
    assert.deepEqual(rows, ['a[31mbcd']);
  });

  test('indented continuation lines keep their indentation', () => {
    assert.deepEqual(md('- item\n\n  more about the item'), ['• item', '', '  more about the item']);
  });
});

describe('fenced code', () => {
  test('fence lines are hidden and code is indented two spaces', () => {
    assert.deepEqual(md('before\n```js\nconst a = 1;\n\n  nested();\n```\nafter'), ['before', '  const a = 1;', '', '    nested();', 'after']);
  });

  test('markup inside code is untouched', () => {
    assert.deepEqual(md('```\n**not bold** `x` # not heading\n- not a list\n| a | b |\n```'), [
      '  **not bold** `x` # not heading',
      '  - not a list',
      '  | a | b |',
    ]);
  });

  test('blank lines inside code are preserved', () => {
    assert.deepEqual(md('```\na\n\n\nb\n```'), ['  a', '', '', '  b']);
  });

  test('the fence language drives highlighting', () => {
    setColorEnabled(true);
    const rows = md('```ts\nconst x = 1; // c\n```');
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.includes('\x1b[35mconst\x1b[39m'), JSON.stringify(rows[0]));
    assert.ok(rows[0]!.includes('\x1b[90m// c\x1b[39m'));
    assert.equal(stripAnsi(rows[0]!), '  const x = 1; // c');
    // Unknown language: no colour at all.
    assert.deepEqual(md('```nope\nconst x = 1;\n```'), ['  const x = 1;']);
  });

  test('multi-line constructs keep their colour on every row', () => {
    setColorEnabled(true);
    const rows = md('```js\n/* one\ntwo */ x\n```');
    assert.ok(rows[0]!.includes('\x1b[90m/* one\x1b[39m'));
    assert.ok(rows[1]!.includes('\x1b[90mtwo */\x1b[39m'));
  });

  test('long code lines are hard-wrapped, not word-wrapped', () => {
    const rows = md('```\naaaa bbbb cccc dddd eeee\n```', 12);
    assert.deepEqual(rows, ['  aaaa bbbb ', '  cccc dddd ', '  eeee']);
    for (const row of rows) assert.ok(stringWidth(row) <= 12);
  });

  test('tilde fences, longer fences and info strings', () => {
    assert.deepEqual(md('~~~python title="x"\nprint(1)\n~~~'), ['  print(1)']);
    assert.deepEqual(md('````\n```\ninner\n```\n````'), ['  ```', '  inner', '  ```']);
    assert.deepEqual(md('```\na\n~~~\nb\n```'), ['  a', '  ~~~', '  b']);
  });

  test('a fence nested in a list keeps the list indentation', () => {
    assert.deepEqual(md('1. Run:\n   ```sh\n   npm test\n     --watch\n   ```\n2. Done'), ['1. Run:', '     npm test', '       --watch', '2. Done']);
  });

  test('tabs in code are expanded', () => {
    assert.deepEqual(md('```\n\tx\n```'), ['      x']);
  });

  test('an unterminated fence still renders as code', () => {
    assert.deepEqual(md('```js\nlet a;\n**x**'), ['  let a;', '  **x**']);
  });

  test('triple backticks used inline are not a fence', () => {
    setColorEnabled(true);
    assert.deepEqual(md('```code``` and text').map(stripAnsi), ['code and text']);
  });
});

describe('tables', () => {
  const TABLE = '| Name | Count |\n|------|------:|\n| alpha | 1 |\n| b | 22 |';

  test('are drawn with box characters and aligned columns', () => {
    assert.deepEqual(md(TABLE), [
      '┌───────┬───────┐',
      '│ Name  │ Count │',
      '├───────┼───────┤',
      '│ alpha │     1 │',
      '│ b     │    22 │',
      '└───────┴───────┘',
    ]);
  });

  test('honour left, centre and right alignment', () => {
    const rows = md('| a | b | c |\n|:--|:-:|--:|\n| x | y | z |\n| long1 | long2 | long3 |');
    assert.equal(rows[3], '│ x     │   y   │     z │');
  });

  test('work without outer pipes and with ragged rows', () => {
    assert.deepEqual(md('a | b\n--|--\n1 | 2\n3 |\n4 | 5 | 6'), [
      '┌───┬───────┐',
      '│ a │ b     │',
      '├───┼───────┤',
      '│ 1 │ 2     │',
      '│ 3 │       │',
      '│ 4 │ 5 │ 6 │',
      '└───┴───────┘',
    ]);
  });

  test('cells may contain inline markup, escaped pipes and pipes in code', () => {
    setColorEnabled(true);
    const rows = md('| k | v |\n|---|---|\n| **b** | `a|b` |\n| x \\| y | [l](u) |');
    const plain = rows.map(stripAnsi);
    assert.equal(plain[3], '│ b     │ a|b   │');
    assert.equal(plain[4], '│ x | y │ l (u) │');
    assert.ok(rows[3]!.includes(`${BOLD}b${BOLD_OFF}`));
    assert.ok(rows[1]!.includes(`${BOLD}k${BOLD_OFF}`), 'header cells are bold');
  });

  test('shrink the widest column and wrap its text when too wide', () => {
    const wide = `| id | description |\n|----|-------------|\n| 1 | ${'word '.repeat(30).trim()} |\n| 2 | short |`;
    for (const width of [30, 40, 55, 80]) {
      const rows = md(wide, width);
      for (const row of rows) assert.ok(stringWidth(row) <= width, `${width}: ${row}`);
      assert.equal(new Set(rows.map((r) => stringWidth(r))).size, 1, 'all rows have the same width');
      assert.ok(rows.some((r) => r.startsWith('│ 1  │ word')));
      assert.ok(rows.some((r) => r.startsWith('│    │ word')), 'wrapped rows leave the narrow column blank');
      assert.equal(stripAnsi(rows.join('\n')).match(/word/g)!.length, 30, 'no text is lost');
    }
  });

  test('rows are separated when any cell wraps', () => {
    const rows = md('| a | b |\n|---|---|\n| 1 | one two three four five six |\n| 2 | x |', 20);
    assert.equal(rows.filter((r) => r.startsWith('├')).length, 2);
  });

  test('fall back to a list when the terminal is too narrow for a grid', () => {
    const rows = md('| name | role | team | site |\n|---|---|---|---|\n| ann | dev | core | nyc |\n| bob | ops | | sfo |', 14);
    assert.deepEqual(rows, ['name: ann', 'role: dev', 'team: core', 'site: nyc', '', 'name: bob', 'role: ops', 'site: sfo']);
    for (const row of rows) assert.ok(stringWidth(row) <= 14);
    assert.deepEqual(md('| name | role | team | site |\n|---|---|---|---|', 14), ['name · role ·', 'team · site']);
  });

  test('fall back to a list rather than squeezing columns to a few characters', () => {
    const table = '| one | two | three |\n|---|---|---|\n| alpha beta gamma | delta epsilon zeta | eta theta iota |';
    assert.ok(md(table, 60)[0]!.startsWith('┌'));
    assert.deepEqual(md(table, 30), ['one: alpha beta gamma', 'two: delta epsilon zeta', 'three: eta theta iota']);
  });

  test('a pipe in ordinary text does not start a table', () => {
    assert.deepEqual(md('a | b\nplain text\n\nx | y\n\n- a | b\n- |---|'), ['a | b', 'plain text', '', 'x | y', '', '• a | b', '• |---|']);
  });

  test('a table ends at the first line without a pipe', () => {
    const rows = md(`${TABLE}\nafter the table\n\n${TABLE}`);
    assert.equal(rows[6], 'after the table');
    assert.equal(rows[7], '');
    assert.equal(rows[8], '┌───────┬───────┐');
    assert.equal(rows.length, 14);
  });

  test('wide characters keep the grid aligned', () => {
    const rows = md('| 名前 | n |\n|---|---|\n| 日本語 | 1 |\n| a | 2 |');
    assert.equal(new Set(rows.map((r) => stringWidth(r))).size, 1);
  });
});

describe('MarkdownStream', () => {
  const widths = [24, 37, 60, 100];

  test('one character at a time gives the same rows as rendering the whole text', () => {
    for (const width of widths) {
      for (const colour of [false, true]) {
        setColorEnabled(colour);
        const stream = new MarkdownStream({ width: () => width, indent: '  ' });
        const rows: string[] = [];
        for (const ch of SAMPLE) rows.push(...stream.push(ch));
        rows.push(...stream.flush());
        assert.deepEqual(rows, renderMarkdown(SAMPLE, width, '  '), `width ${width}, colour ${colour}`);
      }
    }
  });

  test('arbitrary chunk boundaries give the same rows', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const expected = renderMarkdown(SAMPLE, 48);
    for (let round = 0; round < 40; round++) {
      const stream = new MarkdownStream({ width: () => 48 });
      const rows: string[] = [];
      let at = 0;
      while (at < SAMPLE.length) {
        const size = 1 + Math.floor(rand() * 40);
        rows.push(...stream.push(SAMPLE.slice(at, at + size)));
        at += size;
      }
      rows.push(...stream.flush());
      assert.deepEqual(rows, expected, `round ${round}`);
    }
  });

  test('pending() never changes what is eventually returned', () => {
    const stream = new MarkdownStream({ width: () => 40 });
    const rows: string[] = [];
    for (const ch of SAMPLE) {
      rows.push(...stream.push(ch));
      stream.pending();
      stream.pending();
    }
    rows.push(...stream.flush());
    assert.deepEqual(rows, renderMarkdown(SAMPLE, 40));
  });

  test('final rows followed by the pending preview always equal a full render of the text so far', () => {
    for (const width of [30, 72]) {
      const stream = new MarkdownStream({ width: () => width });
      const rows: string[] = [];
      let seen = '';
      for (const ch of SAMPLE) {
        seen += ch;
        rows.push(...stream.push(ch));
        assert.deepEqual([...rows, ...stream.pending()], renderMarkdown(seen, width), `after ${JSON.stringify(seen.slice(-30))}`);
      }
    }
  });

  test('rows never exceed the width', () => {
    for (let width = 20; width <= 100; width += 7) {
      for (const colour of [false, true]) {
        setColorEnabled(colour);
        for (const row of renderMarkdown(SAMPLE, width, '  ')) {
          assert.ok(stringWidth(row) <= width, `width ${width}: ${JSON.stringify(stripAnsi(row))}`);
        }
      }
    }
  });

  test('no text is lost at any width', () => {
    // Tables reflow cell by cell (and repeat headers when stacked), so check them separately.
    const prose = SAMPLE.split('\n')
      .filter((line) => !line.startsWith('|'))
      .join('\n');
    const letters = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');
    const reference = letters(renderMarkdown(prose, 200).join(''));
    for (const width of [20, 33, 61]) assert.equal(letters(renderMarkdown(prose, width).join('')), reference, `width ${width}`);
  });

  test('a line is final only once the next line settles what it is', () => {
    const stream = new MarkdownStream({ width: () => 40 });
    assert.deepEqual(stream.push('Hello **wor'), []);
    assert.deepEqual(stream.pending(), ['Hello **wor']);
    // The newline arrived, but this could still become a setext heading or a table header.
    assert.deepEqual(stream.push('ld**\n'), []);
    assert.deepEqual(stream.pending(), ['Hello world']);
    assert.deepEqual(stream.push('\n'), ['Hello world']);
    assert.deepEqual(stream.pending(), []);
    assert.deepEqual(stream.push('# Head\n- item\n'), ['', 'Head', '• item']);
    assert.deepEqual(stream.flush(), []);
  });

  test('headings, list items and code lines are final as soon as their newline arrives', () => {
    const stream = new MarkdownStream({ width: () => 40 });
    assert.deepEqual(stream.push('## Title\n'), ['Title']);
    assert.deepEqual(stream.push('- one\n'), ['• one']);
    assert.deepEqual(stream.push('```js\n'), []);
    assert.deepEqual(stream.push('let a;\nlet '), ['  let a;']);
    assert.deepEqual(stream.pending(), ['  let ']);
    assert.deepEqual(stream.push('b;\n```\n'), ['  let b;']);
    assert.deepEqual(stream.pending(), []);
  });

  test('a table is held until it ends and previewed while it grows', () => {
    const stream = new MarkdownStream({ width: () => 40 });
    assert.deepEqual(stream.push('| a | b |\n'), []);
    assert.deepEqual(stream.pending(), ['| a | b |']);
    assert.deepEqual(stream.push('|---|---|\n| 1 | 2 |\n'), []);
    assert.deepEqual(stream.pending(), ['┌───┬───┐', '│ a │ b │', '├───┼───┤', '│ 1 │ 2 │', '└───┴───┘']);
    assert.deepEqual(stream.push('| 333 | 4'), []);
    assert.equal(stream.pending()[4], '│ 333 │ 4 │');
    assert.deepEqual(stream.push(' |\n\n'), ['┌─────┬───┐', '│ a   │ b │', '├─────┼───┤', '│ 1   │ 2 │', '│ 333 │ 4 │', '└─────┴───┘']);
    assert.deepEqual(stream.push('after\n\n'), ['', 'after']);
  });

  test('the preview of an open code fence is code', () => {
    const stream = new MarkdownStream({ width: () => 40 });
    stream.push('```\n**x');
    assert.deepEqual(stream.pending(), ['  **x']);
    assert.deepEqual(stream.flush(), ['  **x']);
  });

  test('flush resets the stream for the next message', () => {
    const stream = new MarkdownStream({ width: () => 40 });
    stream.push('```\nopen fence');
    stream.flush();
    assert.deepEqual(stream.push('**bold**\n\n'), ['bold']);
    assert.deepEqual(stream.flush(), []);
    assert.deepEqual(stream.pending(), []);
  });

  test('the width is read at render time', () => {
    let width = 40;
    const stream = new MarkdownStream({ width: () => width });
    assert.deepEqual(stream.push('- one two three four\n'), ['• one two three four']);
    width = 10;
    assert.deepEqual(stream.push('- one two three four\n'), ['• one two', '  three', '  four']);
  });

  test('a missing or zero width falls back to 80 columns', () => {
    const text = 'word '.repeat(40).trim();
    for (const bad of [0, Number.NaN, undefined as unknown as number, -5]) {
      const stream = new MarkdownStream({ width: () => bad });
      assert.deepEqual([...stream.push(text), ...stream.flush()], renderMarkdown(text, 80));
    }
  });

  test('very long lines are passed through without inline parsing', () => {
    const long = '*a '.repeat(10_000);
    const started = performance.now();
    const rows = renderMarkdown(long, 80);
    assert.ok(performance.now() - started < 2000);
    assert.equal(rows.join(' ').replace(/\s+/g, ' ').trim(), long.trim());
  });

  test('renderMarkdown matches a single push and flush', () => {
    const stream = new MarkdownStream({ width: () => 64, indent: ' ' });
    assert.deepEqual([...stream.push(SAMPLE), ...stream.flush()], renderMarkdown(SAMPLE, 64, ' '));
  });
});
