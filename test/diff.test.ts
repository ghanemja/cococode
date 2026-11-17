import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { setColorEnabled, stringWidth, stripAnsi } from '../src/ui/ansi.ts';
import { diffLines, diffStats, renderDiff, unifiedDiff, type Hunk } from '../src/util/diff.ts';

afterEach(() => setColorEnabled(false));

const lines = (n: number, prefix = 'line ') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const text = (ls: string[]) => (ls.length ? ls.join('\n') + '\n' : '');

/** Rebuild both sides from a diff made with unlimited context. */
function reconstruct(hunks: Hunk[]): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type !== 'add') before.push(line.text);
      if (line.type !== 'del') after.push(line.text);
    }
  }
  return { before, after };
}

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('diffLines', () => {
  test('identical texts have no hunks', () => {
    assert.deepEqual(diffLines('a\nb\n', 'a\nb\n'), []);
    assert.deepEqual(diffLines('', ''), []);
  });

  test('a replaced line is a deletion followed by an addition', () => {
    const hunks = diffLines('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0], {
      oldStart: 1,
      newStart: 1,
      lines: [
        { type: 'ctx', oldNo: 1, newNo: 1, text: 'one' },
        { type: 'del', oldNo: 2, text: 'two' },
        { type: 'add', newNo: 2, text: 'TWO' },
        { type: 'ctx', oldNo: 3, newNo: 3, text: 'three' },
      ],
    });
  });

  test('deletions come before additions within a changed block', () => {
    const hunks = diffLines('a\nb\nc\nd\n', 'a\nx\ny\nz\nd\n');
    const types = hunks[0]!.lines.map((l) => l.type);
    assert.deepEqual(types, ['ctx', 'del', 'del', 'add', 'add', 'add', 'ctx']);
  });

  test('context is limited and distant changes get separate hunks', () => {
    const before = lines(30);
    const after = before.slice();
    after[4] = 'changed 5';
    after[24] = 'changed 25';
    const hunks = diffLines(text(before), text(after), 2);
    assert.equal(hunks.length, 2);
    assert.deepEqual(
      hunks[0]!.lines.map((l) => `${l.type}:${l.text}`),
      ['ctx:line 3', 'ctx:line 4', 'del:line 5', 'add:changed 5', 'ctx:line 6', 'ctx:line 7'],
    );
    assert.equal(hunks[0]!.oldStart, 3);
    assert.equal(hunks[0]!.newStart, 3);
    assert.equal(hunks[1]!.oldStart, 23);
    assert.equal(hunks[1]!.lines[0]!.oldNo, 23);
  });

  test('changes whose context overlaps share one hunk', () => {
    const before = lines(20);
    const after = before.slice();
    after[4] = 'x';
    after[9] = 'y';
    assert.equal(diffLines(text(before), text(after), 3).length, 1);
    assert.equal(diffLines(text(before), text(after), 1).length, 2);
  });

  test('zero context keeps only the changed lines', () => {
    const hunks = diffLines('a\nb\nc\n', 'a\nB\nc\n', 0);
    assert.deepEqual(
      hunks[0]!.lines.map((l) => l.type),
      ['del', 'add'],
    );
  });

  test('new file: everything is added', () => {
    const hunks = diffLines('', 'a\nb\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0]!.oldStart, 0);
    assert.equal(hunks[0]!.newStart, 1);
    assert.deepEqual(hunks[0]!.lines, [
      { type: 'add', newNo: 1, text: 'a' },
      { type: 'add', newNo: 2, text: 'b' },
    ]);
  });

  test('emptied file: everything is deleted', () => {
    const hunks = diffLines('a\nb\n', '');
    assert.equal(hunks[0]!.oldStart, 1);
    assert.equal(hunks[0]!.newStart, 0);
    assert.deepEqual(
      hunks[0]!.lines.map((l) => [l.type, l.oldNo, l.text]),
      [
        ['del', 1, 'a'],
        ['del', 2, 'b'],
      ],
    );
  });

  test('a missing final newline alone is not a difference', () => {
    assert.deepEqual(diffLines('a\nb', 'a\nb\n'), []);
    assert.deepEqual(diffLines('a\nb\n', 'a\nb'), []);
    const hunks = diffLines('a\nb', 'a\nc');
    assert.deepEqual(
      hunks[0]!.lines.map((l) => `${l.type}:${l.text}`),
      ['ctx:a', 'del:b', 'add:c'],
    );
  });

  test('blank lines are real lines', () => {
    const hunks = diffLines('a\n\nb\n', 'a\nb\n');
    assert.deepEqual(
      hunks[0]!.lines.map((l) => `${l.type}:${l.text}`),
      ['ctx:a', 'del:', 'ctx:b'],
    );
    assert.equal(diffLines('', '\n')[0]!.lines.length, 1);
  });

  test('CRLF and LF content compare equal and no carriage return leaks out', () => {
    assert.deepEqual(diffLines('a\r\nb\r\n', 'a\nb\n'), []);
    const hunks = diffLines('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n');
    for (const line of hunks[0]!.lines) assert.ok(!line.text.includes('\r'));
    assert.deepEqual(diffStats(hunks), { added: 1, removed: 1 });
  });

  test('random edits reconstruct both sides exactly', () => {
    const rand = rng(42);
    const vocab = ['a', 'b', 'c', 'd', 'e', 'f', ''];
    for (let round = 0; round < 300; round++) {
      const pick = () => vocab[Math.floor(rand() * vocab.length)]!;
      const before = Array.from({ length: Math.floor(rand() * 25) }, pick);
      const after = before.slice();
      const edits = Math.floor(rand() * 8);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rand() * (after.length + 1));
        const kind = rand();
        if (kind < 0.4) after.splice(at, 0, pick());
        else if (kind < 0.8) after.splice(at, 1);
        else after.splice(at, 1, pick());
      }
      const hunks = diffLines(text(before), text(after), 1_000_000);
      if (text(before) === text(after)) {
        assert.deepEqual(hunks, []);
        continue;
      }
      const rebuilt = reconstruct(hunks);
      assert.deepEqual(rebuilt.before, before, `round ${round} before`);
      assert.deepEqual(rebuilt.after, after, `round ${round} after`);
      // The script is minimal enough that it never rewrites more than both files.
      const stats = diffStats(hunks);
      assert.ok(stats.added + stats.removed <= before.length + after.length);
    }
  });

  test('line numbers are consecutive on each side', () => {
    const before = lines(40);
    const after = [...before.slice(0, 10), 'new a', 'new b', ...before.slice(12, 30), ...before.slice(33)];
    for (const hunk of diffLines(text(before), text(after), 3)) {
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.type !== 'add') assert.equal(line.oldNo, oldNo++);
        if (line.type !== 'del') assert.equal(line.newNo, newNo++);
      }
    }
  });

  test('stays fast on a 20k-line file with scattered edits', () => {
    const before = lines(20_000);
    const after = before.slice();
    for (let i = 100; i < after.length; i += 997) after[i] = `edited ${i}`;
    after.splice(15_000, 3);
    after.splice(5_000, 0, 'inserted 1', 'inserted 2');
    const started = performance.now();
    const hunks = diffLines(text(before), text(after));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `took ${elapsed.toFixed(0)}ms`);
    const stats = diffStats(hunks);
    assert.equal(stats.added, 22);
    assert.equal(stats.removed, 23);
  });

  test('falls back to a block replace when two large files share nothing', () => {
    const before = lines(6000, 'old ');
    const after = lines(6000, 'new ');
    const started = performance.now();
    const hunks = diffLines(text(before), text(after));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `took ${elapsed.toFixed(0)}ms`);
    assert.deepEqual(diffStats(hunks), { added: 6000, removed: 6000 });
    const rebuilt = reconstruct(hunks);
    assert.deepEqual(rebuilt.before, before);
    assert.deepEqual(rebuilt.after, after);
  });

  test('a small edit between long unchanged regions ignores the rest', () => {
    const before = lines(20_000);
    const after = before.slice();
    after[10_000] = 'x';
    const hunks = diffLines(text(before), text(after));
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0]!.lines.length, 8);
    assert.equal(hunks[0]!.oldStart, 9998);
  });
});

describe('diffStats', () => {
  test('counts additions and removals across hunks', () => {
    const before = lines(30);
    const after = before.slice();
    after.splice(2, 1);
    after.push('tail a', 'tail b');
    assert.deepEqual(diffStats(diffLines(text(before), text(after), 1)), { added: 2, removed: 1 });
    assert.deepEqual(diffStats([]), { added: 0, removed: 0 });
  });
});

describe('renderDiff', () => {
  const before = text(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']);
  const after = text(['one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven']);

  test('shows a line-number gutter and +/- markers', () => {
    const rows = renderDiff(diffLines(before, after, 1), 40);
    assert.deepEqual(rows, [' 2   two', ' 3 - three', ' 3 + THREE', ' 4   four', ' ⋮', '10   ten', '11 + eleven']);
  });

  test('returns nothing for an empty diff', () => {
    assert.deepEqual(renderDiff([], 40), []);
  });

  test('rows are truncated to the width', () => {
    const long = 'x'.repeat(200);
    const rows = renderDiff(diffLines('a\n', `a\n${long}\n`), 30, { indent: '  ' });
    for (const row of rows) assert.ok(stringWidth(row) <= 30, row);
    assert.ok(rows[1]!.endsWith('…'));
    assert.ok(rows[1]!.startsWith('  2 + '));
  });

  test('maxLines cuts the output and reports what is hidden', () => {
    const rows = renderDiff(diffLines('', text(lines(50))), 40, { maxLines: 10 });
    assert.equal(rows.length, 11);
    assert.equal(rows[10], '… +40 lines');
    assert.equal(rows[9], '10 + line 10');
  });

  test('maxLines does not replace a single row with a summary', () => {
    const hunks = diffLines('', text(lines(11)));
    assert.equal(renderDiff(hunks, 40, { maxLines: 10 }).length, 11);
    assert.ok(!renderDiff(hunks, 40, { maxLines: 10 }).some((r) => r.includes('…')));
    assert.equal(renderDiff(hunks, 40, { maxLines: 11 }).length, 11);
    assert.equal(renderDiff(hunks, 40, { maxLines: 9 }).at(-1), '… +2 lines');
  });

  test('tabs are expanded and control characters neutralised', () => {
    const rows = renderDiff(diffLines('', '\tindented\n\x1b[31mred\x07\n'), 40);
    assert.equal(rows[0], '1 +     indented');
    assert.ok(!rows[1]!.includes('\x1b') && !rows[1]!.includes('\x07'));
    assert.ok(rows[1]!.includes('[31mred'));
  });

  test('coloured rows are tinted bands of the full width', () => {
    setColorEnabled(true);
    const rows = renderDiff(diffLines(before, after, 1), 40);
    const add = rows.find((r) => stripAnsi(r).includes('+ THREE'))!;
    const del = rows.find((r) => stripAnsi(r).includes('- three'))!;
    assert.ok(add.includes('\x1b[48;5;22m') && add.includes('\x1b[32m'), JSON.stringify(add));
    assert.ok(del.includes('\x1b[48;5;52m') && del.includes('\x1b[31m'), JSON.stringify(del));
    assert.equal(stringWidth(add), 40);
    assert.equal(stringWidth(del), 40);
    assert.ok(add.endsWith('\x1b[49m'), 'background is closed at the end of the row');
    const ctx = rows.find((r) => stripAnsi(r).endsWith('two'))!;
    assert.ok(!ctx.includes('48;5'), 'context rows have no background');
    for (const row of rows) assert.ok(stringWidth(row) <= 40);
  });

  test('the gutter widens for large line numbers', () => {
    const big = lines(1200);
    const changed = big.slice();
    changed[1100] = 'x';
    const rows = renderDiff(diffLines(text(big), text(changed), 0), 40);
    assert.deepEqual(rows, ['1101 - line 1101', '1101 + x']);
  });
});

describe('unifiedDiff', () => {
  test('is empty for identical texts', () => {
    assert.equal(unifiedDiff('f.txt', 'a\n', 'a\n'), '');
  });

  test('produces standard headers and hunks', () => {
    const out = unifiedDiff('src/f.txt', 'one\ntwo\nthree\n', 'one\n2\nthree\nfour\n');
    assert.equal(out, ['--- a/src/f.txt', '+++ b/src/f.txt', '@@ -1,3 +1,4 @@', ' one', '-two', '+2', ' three', '+four', ''].join('\n'));
  });

  test('new and emptied files use zero-length ranges', () => {
    assert.ok(unifiedDiff('f', '', 'a\nb\n').includes('@@ -0,0 +1,2 @@'));
    assert.ok(unifiedDiff('f', 'a\nb\n', '').includes('@@ -1,2 +0,0 @@'));
  });

  test('marks a missing final newline', () => {
    const added = unifiedDiff('f', 'a\nb', 'a\nb\n');
    assert.equal(added, ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b', ''].join('\n'));
    const removed = unifiedDiff('f', 'a\nb\n', 'a\nb');
    assert.ok(removed.includes('+b\n\\ No newline at end of file'));
    const both = unifiedDiff('f', 'a\nb', 'A\nb');
    assert.ok(both.endsWith(' b\n\\ No newline at end of file\n'));
  });

  test('respects the context argument', () => {
    const before = lines(20);
    const after = before.slice();
    after[10] = 'x';
    const out = unifiedDiff('f', text(before), text(after), 1);
    assert.ok(out.includes('@@ -10,3 +10,3 @@'));
    assert.equal(out.split('\n').filter((l) => l.startsWith(' ')).length, 2);
  });

  test('strips carriage returns', () => {
    const out = unifiedDiff('f', 'a\r\nb\r\n', 'a\r\nc\r\n');
    assert.ok(!out.includes('\r'));
    assert.ok(out.includes('-b\n+c\n'));
  });

  const hasPatch = spawnSync('patch', ['--version']).status === 0;
  test('patch(1) applies the output and yields the new text', { skip: hasPatch ? false : 'patch is not installed' }, () => {
    const rand = rng(7);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-diff-'));
    try {
      for (let round = 0; round < 25; round++) {
        const before = Array.from({ length: 5 + Math.floor(rand() * 40) }, (_, i) => `row ${i} ${Math.floor(rand() * 5)}`);
        const after = before.slice();
        for (let e = 0; e < 1 + Math.floor(rand() * 6); e++) {
          const at = Math.floor(rand() * (after.length + 1));
          const kind = rand();
          if (kind < 0.4) after.splice(at, 0, `ins ${round}-${e}`);
          else if (kind < 0.7) after.splice(at, 1);
          else after.splice(at, 1, `rep ${round}-${e}`);
        }
        // Vary the final newline on both sides.
        const beforeText = before.join('\n') + (rand() < 0.7 ? '\n' : '');
        const afterText = after.length ? after.join('\n') + (rand() < 0.7 ? '\n' : '') : '';
        const patchText = unifiedDiff('f.txt', beforeText, afterText);
        if (patchText === '') {
          assert.equal(beforeText, afterText);
          continue;
        }
        const file = path.join(dir, 'f.txt');
        fs.writeFileSync(file, beforeText);
        const res = spawnSync('patch', ['-p1', '--no-backup-if-mismatch', '-s'], { cwd: dir, input: patchText, encoding: 'utf8' });
        assert.equal(res.status, 0, `round ${round}: ${res.stdout}${res.stderr}\n${patchText}`);
        const result = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        assert.equal(result, afterText, `round ${round}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
