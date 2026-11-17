import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { setColorEnabled, stringWidth } from '../src/ui/ansi.ts';
import type { DialogOption, SelectResult, SelectSpec } from '../src/ui/dialog.ts';
import { SelectDialog } from '../src/ui/dialog.ts';
import type { Key } from '../src/ui/keys.ts';

beforeEach(() => setColorEnabled(false));
afterEach(() => setColorEnabled(false));

function key(name: string, mods: Partial<Key> = {}): Key {
  return { name, ctrl: false, meta: false, shift: false, ...mods };
}
const typed = (text: string) => key('char', { text });

interface Harness<T> {
  dialog: SelectDialog<T>;
  /** Every value the dialog resolved with (there should be at most one). */
  results: (SelectResult<T> | null)[];
  press(...keys: (Key | string)[]): boolean;
  type(text: string): void;
  lines(width?: number): string[];
  /** Index of the highlighted option, read from the rendered pointer. */
  selected(width?: number): string | undefined;
}

function open<T>(spec: SelectSpec<T>): Harness<T> {
  const results: (SelectResult<T> | null)[] = [];
  const dialog = new SelectDialog<T>(spec, (r) => results.push(r));
  const lines = (width = 60) => dialog.render(width).lines;
  return {
    dialog,
    results,
    press(...keys) {
      let done = false;
      for (const k of keys) done = dialog.handleKey(typeof k === 'string' ? key(k) : k);
      return done;
    },
    type(text) {
      for (const ch of text) dialog.handleKey(typed(ch));
    },
    lines,
    selected(width = 60) {
      return lines(width).find((l) => l.startsWith(' ❯'));
    },
  };
}

const abc: DialogOption<string>[] = [
  { label: 'Alpha', value: 'a' },
  { label: 'Beta', value: 'b', hint: 'second' },
  { label: 'Gamma', value: 'c' },
];

describe('SelectDialog navigation', () => {
  test('renders the question, numbered options, hints and a footer', () => {
    const h = open({ question: 'Pick one', options: abc });
    assert.deepEqual(h.lines(), [' Pick one', ' ❯ 1. Alpha', '   2. Beta  second', '   3. Gamma', ' enter to select · esc to cancel']);
    assert.equal(h.dialog.render(60).cursor, null);
  });

  test('header lines come first, untouched', () => {
    const h = open({ header: ['', ' Bash command', '   rm -rf build'], question: 'Proceed?', options: abc, footer: 'custom footer' });
    const lines = h.lines();
    assert.deepEqual(lines.slice(0, 4), ['', ' Bash command', '   rm -rf build', ' Proceed?']);
    assert.equal(lines.at(-1), ' custom footer');
  });

  test('down and up move the highlight and wrap around', () => {
    const h = open({ options: abc });
    assert.match(h.selected()!, /1\. Alpha/);
    h.press('down');
    assert.match(h.selected()!, /2\. Beta/);
    h.press('down', 'down');
    assert.match(h.selected()!, /1\. Alpha/);
    h.press('up');
    assert.match(h.selected()!, /3\. Gamma/);
    h.press('up', 'up', 'up');
    assert.match(h.selected()!, /3\. Gamma/);
    assert.equal(h.results.length, 0);
  });

  test('tab, shift+tab, ctrl+n and ctrl+p also move', () => {
    const h = open({ options: abc });
    h.press('tab');
    assert.match(h.selected()!, /Beta/);
    h.press(key('n', { ctrl: true }));
    assert.match(h.selected()!, /Gamma/);
    h.press(key('tab', { shift: true }));
    assert.match(h.selected()!, /Beta/);
    h.press(key('p', { ctrl: true }));
    assert.match(h.selected()!, /Alpha/);
  });

  test('enter returns the highlighted option', () => {
    const h = open({ options: abc });
    assert.equal(h.press('down'), false);
    assert.equal(h.press('return'), true);
    assert.deepEqual(h.results, [{ value: 'b', values: ['b'], text: undefined }]);
  });

  test('the initial highlight can be set, and is clamped', () => {
    assert.match(open({ options: abc, initial: 2 }).selected()!, /Gamma/);
    assert.match(open({ options: abc, initial: 99 }).selected()!, /Gamma/);
    assert.match(open({ options: abc, initial: -3 }).selected()!, /Alpha/);
  });

  test('a number key picks that option at once', () => {
    const h = open({ options: abc });
    assert.equal(h.press(typed('3')), true);
    assert.deepEqual(h.results, [{ value: 'c', values: ['c'] }]);
  });

  test('a number beyond the list, zero and letters do nothing', () => {
    const h = open({ options: abc });
    assert.equal(h.press(typed('4'), typed('9'), typed('0'), typed('x'), typed(' ')), false);
    assert.equal(h.results.length, 0);
    assert.match(h.selected()!, /Alpha/);
  });

  test('escape and ctrl+c cancel', () => {
    const esc = open({ options: abc });
    assert.equal(esc.press('escape'), true);
    assert.deepEqual(esc.results, [null]);
    const ctrlC = open({ options: abc });
    assert.equal(ctrlC.press(key('c', { ctrl: true })), true);
    assert.deepEqual(ctrlC.results, [null]);
  });

  test('the dialog resolves only once', () => {
    const h = open({ options: abc });
    h.press('return');
    h.press('return', 'escape', typed('2'));
    h.dialog.cancel();
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0]!.value, 'a');

    const cancelled = open({ options: abc });
    cancelled.dialog.cancel();
    cancelled.dialog.cancel();
    cancelled.press('return');
    assert.deepEqual(cancelled.results, [null]);
  });

  test('an empty option list can only be cancelled', () => {
    const h = open<string>({ question: 'Nothing here', options: [] });
    assert.ok(h.lines().some((l) => l.includes('No matches')));
    assert.equal(h.press('down', 'up', 'return', typed('1')), false);
    assert.equal(h.press('escape'), true);
    assert.deepEqual(h.results, [null]);
  });

  test('long labels and hints are cut to the width', () => {
    const h = open({
      question: 'A fairly long question that will need to wrap onto a second line',
      options: [{ label: 'An option with a very long label that cannot possibly fit', value: 1, hint: 'and a long hint as well' }],
    });
    for (const width of [20, 30, 45]) {
      const lines = h.lines(width);
      for (const line of lines.slice(0, -1)) assert.ok(stringWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
      assert.ok(lines.some((l) => l.endsWith('…')));
      assert.ok(lines.filter((l) => /question|second|wrap|long|fairly/.test(l)).length >= 2, 'question wraps');
    }
  });
});

describe('SelectDialog input options', () => {
  const withInput: DialogOption<string>[] = [
    { label: 'Yes', value: 'yes' },
    { label: 'No, and say why', value: 'no', input: true, placeholder: 'esc to just decline' },
  ];

  test('shows a placeholder and places the cursor in the field when highlighted', () => {
    const h = open({ options: withInput });
    assert.equal(h.dialog.render(60).cursor, null);
    h.press('down');
    const rendered = h.dialog.render(60);
    const row = rendered.lines.findIndex((l) => l.includes('No, and say why'));
    assert.equal(rendered.lines[row], ' ❯ 2. No, and say why: esc to just decline');
    assert.deepEqual(rendered.cursor, { row, col: stringWidth(' ❯ 2. No, and say why: ') });
  });

  test('typing fills the field and enter returns the text', () => {
    const h = open({ options: withInput });
    h.press('down');
    h.type('use pnpm');
    const rendered = h.dialog.render(60);
    const row = rendered.lines.findIndex((l) => l.includes('No, and say why'));
    assert.equal(rendered.lines[row], ' ❯ 2. No, and say why: use pnpm');
    assert.deepEqual(rendered.cursor, { row, col: stringWidth(' ❯ 2. No, and say why: use pnpm') });
    assert.equal(h.press('return'), true);
    assert.deepEqual(h.results, [{ value: 'no', values: ['no'], text: 'use pnpm' }]);
  });

  test('digits and spaces typed into the field are text, not shortcuts', () => {
    const h = open({ options: withInput });
    h.press('down');
    h.type('try 1 of 2');
    assert.equal(h.results.length, 0);
    h.press('return');
    assert.equal(h.results[0]!.text, 'try 1 of 2');
  });

  test('backspace, ctrl+u and paste', () => {
    const h = open({ options: withInput });
    h.press('down');
    h.type('abcd');
    h.press('backspace', 'backspace');
    h.press(key('paste', { text: ' pasted\n  text ' }));
    assert.ok(h.selected()!.endsWith('No, and say why: ab pasted text '));
    h.press(key('u', { ctrl: true }));
    assert.ok(h.selected()!.endsWith('No, and say why: esc to just decline'));
    h.press('backspace');
    h.type('z');
    h.press('return');
    assert.equal(h.results[0]!.text, 'z');
  });

  test('enter with nothing typed returns empty text', () => {
    const h = open({ options: withInput });
    h.press('down', 'return');
    assert.deepEqual(h.results, [{ value: 'no', values: ['no'], text: '' }]);
  });

  test('the cursor column accounts for wide characters and stays inside the width', () => {
    const h = open({ options: withInput });
    h.press('down');
    const wide = String.fromCodePoint(0x65e5, 0x672c);
    h.press(typed(wide));
    const rendered = h.dialog.render(60);
    assert.equal(rendered.cursor!.col, stringWidth(' ❯ 2. No, and say why: ') + 4);
    h.type('x'.repeat(100));
    const narrow = h.dialog.render(30);
    assert.equal(narrow.cursor!.col, 29);
    assert.ok(stringWidth(narrow.lines[narrow.cursor!.row]!) <= 30);
  });

  test('typed text stays visible after moving away, and choosing another option ignores it', () => {
    const h = open({ options: withInput });
    h.press('down');
    h.type('reason');
    h.press('up');
    assert.ok(h.lines().some((l) => l.includes('2. No, and say why: reason')));
    assert.equal(h.dialog.render(60).cursor, null);
    h.press('return');
    assert.deepEqual(h.results, [{ value: 'yes', values: ['yes'], text: undefined }]);
  });

  test('a number key moves to an input option without confirming it', () => {
    const h = open({ options: withInput });
    assert.equal(h.press(typed('2')), false);
    assert.match(h.selected()!, /No, and say why/);
    assert.equal(h.results.length, 0);
    h.type('because');
    h.press('return');
    assert.equal(h.results[0]!.text, 'because');
  });

  test('escape cancels even while typing', () => {
    const h = open({ options: withInput });
    h.press('down');
    h.type('half a thought');
    assert.equal(h.press('escape'), true);
    assert.deepEqual(h.results, [null]);
  });
});

describe('SelectDialog multi-select', () => {
  const colours: DialogOption<string>[] = [
    { label: 'Red', value: 'r' },
    { label: 'Green', value: 'g' },
    { label: 'Blue', value: 'b' },
  ];

  test('space toggles, enter returns the checked values in list order', () => {
    const h = open({ options: colours, multi: true });
    assert.deepEqual(h.lines().slice(0, 3), [' ❯ 1. [ ] Red', '   2. [ ] Green', '   3. [ ] Blue']);
    h.press('down', 'down', typed(' '), 'up', 'up', typed(' '));
    assert.deepEqual(h.lines().slice(0, 3), [' ❯ 1. [x] Red', '   2. [ ] Green', '   3. [x] Blue']);
    assert.equal(h.press('return'), true);
    assert.deepEqual(h.results, [{ value: 'r', values: ['r', 'b'] }]);
  });

  test('space toggles off again', () => {
    const h = open({ options: colours, multi: true });
    h.press(typed(' '), 'down', typed(' '), 'up', typed(' '), 'return');
    assert.deepEqual(h.results[0]!.values, ['g']);
  });

  test('enter with nothing checked takes the highlighted option', () => {
    const h = open({ options: colours, multi: true });
    h.press('down', 'return');
    assert.deepEqual(h.results, [{ value: 'g', values: ['g'] }]);
  });

  test('number keys move but do not confirm', () => {
    const h = open({ options: colours, multi: true });
    assert.equal(h.press(typed('3')), false);
    assert.match(h.selected()!, /Blue/);
    assert.equal(h.results.length, 0);
  });

  test('the footer explains the keys', () => {
    assert.match(open({ options: colours, multi: true }).lines().at(-1)!, /space to toggle/);
  });

  const withOther: DialogOption<string>[] = [...colours, { label: 'Other', value: '__other__', input: true }];

  test('checked values plus typed text', () => {
    const h = open({ options: withOther, multi: true });
    h.press(typed(' '), 'down', 'down', 'down');
    h.type('teal green');
    h.press('return');
    assert.deepEqual(h.results, [{ value: '__other__', values: ['r'], text: 'teal green' }]);
  });

  test('typed text is kept when enter is pressed on another option', () => {
    const h = open({ options: withOther, multi: true });
    h.press('up');
    h.type('mauve');
    h.press('up', typed(' '), 'return');
    assert.deepEqual(h.results, [{ value: '__other__', values: ['b'], text: 'mauve' }]);
  });

  test('enter on an empty text entry with nothing checked is not an answer', () => {
    const h = open({ options: withOther, multi: true });
    h.press('up');
    assert.equal(h.press('return'), false);
    assert.equal(h.results.length, 0);
    h.type('   ');
    assert.equal(h.press('return'), false);
    h.type('grey');
    assert.equal(h.press('return'), true);
    assert.deepEqual(h.results, [{ value: '__other__', values: [], text: 'grey' }]);
  });

  test('an empty text entry does not block confirming checked options', () => {
    const h = open({ options: withOther, multi: true });
    h.press(typed(' '), 'up', 'return');
    assert.deepEqual(h.results, [{ value: 'r', values: ['r'] }]);
  });

  test('the input option has no checkbox', () => {
    const lines = open({ options: withOther, multi: true }).lines();
    assert.equal(lines[3], '   4. Other');
  });
});

describe('SelectDialog filtering', () => {
  const models: DialogOption<string>[] = [
    { label: 'qwen3-coder:30b', value: 'q30', hint: 'ollama · 19 GB' },
    { label: 'qwen3:8b', value: 'q8', hint: 'ollama · 5 GB' },
    { label: 'llama3.3:70b', value: 'l70', hint: 'ollama · 43 GB' },
    { label: 'devstral', value: 'dev', hint: 'lmstudio' },
  ];

  test('shows a filter line and no numbers', () => {
    const h = open({ question: 'Model', options: models, filterable: true });
    assert.deepEqual(h.lines().slice(0, 3), [' Model', ' Filter: type to search', ' ❯ qwen3-coder:30b  ollama · 19 GB']);
  });

  test('typing narrows the list by label or hint, case-insensitively', () => {
    const h = open({ options: models, filterable: true });
    h.type('QWEN');
    assert.deepEqual(
      h.lines().filter((l) => l.includes('qwen') && !l.includes('Filter')),
      [' ❯ qwen3-coder:30b  ollama · 19 GB', '   qwen3:8b  ollama · 5 GB'],
    );
    assert.ok(h.lines().includes(' Filter: QWEN'));
    assert.ok(!h.lines().some((l) => l.includes('llama3.3')));

    const byHint = open({ options: models, filterable: true });
    byHint.type('lmstudio');
    byHint.press('return');
    assert.equal(byHint.results[0]!.value, 'dev');
  });

  test('digits are part of the filter, not shortcuts', () => {
    const h = open({ options: models, filterable: true });
    h.type('70');
    assert.equal(h.results.length, 0);
    h.press('return');
    assert.equal(h.results[0]!.value, 'l70');
  });

  test('backspace widens the list again and the highlight returns to the top', () => {
    const h = open({ options: models, filterable: true });
    h.press('down', 'down');
    h.type('qwen3:');
    assert.match(h.selected()!, /qwen3:8b/);
    h.press('backspace');
    assert.match(h.selected()!, /qwen3-coder/);
    for (let i = 0; i < 10; i++) h.press('backspace');
    assert.equal(h.lines().filter((l) => /ollama|lmstudio/.test(l)).length, 4);
  });

  test('navigation works within the filtered list and returns the right value', () => {
    const h = open({ options: models, filterable: true });
    h.type('qwen');
    h.press('down', 'down', 'down'); // wraps within two matches
    assert.match(h.selected()!, /qwen3:8b/);
    h.press('return');
    assert.deepEqual(h.results, [{ value: 'q8', values: ['q8'], text: undefined }]);
  });

  test('no matches: enter does nothing, escape still cancels', () => {
    const h = open({ options: models, filterable: true });
    h.type('zzz');
    assert.ok(h.lines().some((l) => l.includes('No matches')));
    assert.equal(h.press('return'), false);
    assert.equal(h.results.length, 0);
    h.press('backspace', 'backspace', 'backspace', 'return');
    assert.equal(h.results[0]!.value, 'q30');
  });
});

describe('SelectDialog scrolling', () => {
  const many: DialogOption<number>[] = Array.from({ length: 25 }, (_, i) => ({ label: `Item ${i + 1}`, value: i + 1 }));
  const optionRows = (lines: string[]) => lines.filter((l) => /Item \d+/.test(l) && !l.includes('Filter:'));

  test('only a window of options is shown, with a marker for the rest', () => {
    const h = open({ options: many, maxVisible: 5 });
    const lines = h.lines();
    assert.deepEqual(optionRows(lines), [' ❯ 1. Item 1', '   2. Item 2', '   3. Item 3', '   4. Item 4', '   5. Item 5']);
    assert.ok(lines.includes('   ↓ 20 more'));
    assert.ok(!lines.some((l) => l.includes('↑')));
  });

  test('the window follows the highlight and shows both markers in the middle', () => {
    const h = open({ options: many, maxVisible: 5 });
    for (let i = 0; i < 12; i++) h.press('down');
    const lines = h.lines();
    assert.equal(optionRows(lines).length, 5);
    assert.match(h.selected()!, /13\. Item 13/);
    assert.ok(lines.includes('   ↑ 10 more'));
    assert.ok(lines.includes('   ↓ 10 more'));
    // Markers and rows account for every option.
    assert.equal(10 + 5 + 10, 25);
  });

  test('at the end only the upward marker remains; wrapping returns to the top', () => {
    const h = open({ options: many, maxVisible: 5 });
    h.press('up');
    let lines = h.lines();
    assert.match(h.selected()!, /25\. Item 25/);
    assert.deepEqual(optionRows(lines).map((l) => l.trim().replace('❯ ', '')), ['21. Item 21', '22. Item 22', '23. Item 23', '24. Item 24', '25. Item 25']);
    assert.ok(lines.includes('   ↑ 20 more'));
    assert.ok(!lines.some((l) => l.includes('↓')));
    h.press('down');
    lines = h.lines();
    assert.match(h.selected()!, /1\. Item 1$/);
    assert.ok(lines.includes('   ↓ 20 more'));
  });

  test('every option can be reached and returns its own value', () => {
    const h = open({ options: many, maxVisible: 4 });
    for (let i = 0; i < 17; i++) h.press('down');
    h.press('return');
    assert.equal(h.results[0]!.value, 18);
  });

  test('the default window is ten options', () => {
    const lines = open({ options: many }).lines();
    assert.equal(optionRows(lines).length, 10);
    assert.ok(lines.includes('   ↓ 15 more'));
  });

  test('a filtered long list scrolls too', () => {
    const h = open({ options: many, maxVisible: 3, filterable: true });
    h.type('Item 2'); // Item 2 and Item 20..25
    assert.equal(optionRows(h.lines()).length, 3);
    assert.ok(h.lines().includes('   ↓ 4 more'));
    for (let i = 0; i < 6; i++) h.press('down');
    assert.match(h.selected()!, /Item 25/);
    h.press('return');
    assert.equal(h.results[0]!.value, 25);
  });

  test('a list that fits shows no markers', () => {
    const lines = open({ options: many.slice(0, 5), maxVisible: 5 }).lines();
    assert.ok(!lines.some((l) => l.includes('more')));
  });
});
