import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { toolResultsDir } from '../src/config/paths.ts';
import { clampOutput } from '../src/tools/shell.ts';
import { spillOutput } from '../src/tools/spill.ts';
import { tempProject } from './helpers.ts';

const SESSION = 'session-1';
let dir: string;

beforeEach(() => {
  dir = tempProject('coco-spill-');
});

/** `count` lines of the form "line 1", "line 2", ... without a final newline. */
const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
const savedFile = (callId: string) => path.join(toolResultsDir(SESSION), `${callId}.txt`);
const savedFiles = () => (fs.existsSync(toolResultsDir(SESSION)) ? fs.readdirSync(toolResultsDir(SESSION)) : []);

/** Split a spilled result into what is shown and the note that follows it. */
function parts(result: string): { shown: string; note: string } {
  const at = result.lastIndexOf('\n\n[The output was ');
  assert.ok(at >= 0, `no note in: ${result.slice(-300)}`);
  return { shown: result.slice(0, at), note: result.slice(at + 2) };
}

describe('spillOutput', () => {
  test('content within the limit is returned unchanged and nothing is saved', () => {
    assert.equal(spillOutput(SESSION, 'c1', 'short', 100), 'short');
    assert.equal(spillOutput(SESSION, 'c1', '', 100), '');
    assert.equal(spillOutput(SESSION, 'c1', 'short', 100, { failed: true }), 'short');
    assert.deepEqual(savedFiles(), []);
  });

  test('the limit itself is within the limit; one character more is not', () => {
    const exact = 'x'.repeat(3000);
    assert.equal(spillOutput(SESSION, 'edge', exact, 3000), exact);
    assert.equal(spillOutput(SESSION, 'edge', exact, 3000, { failed: true }), exact);
    assert.deepEqual(savedFiles(), []);

    const over = `${exact}y`;
    const res = spillOutput(SESSION, 'edge', over, 3000);
    assert.notEqual(res, over);
    assert.ok(res.length < over.length);
    assert.equal(fs.readFileSync(savedFile('edge'), 'utf8'), over);
  });

  test('a successful result shows its first 2,000 characters and last lines, with a note on the rest', () => {
    const content = numbered(6000); // 52,893 characters
    const res = spillOutput(SESSION, 'ok', content, 30_000);
    const { shown, note } = parts(res);
    const [head, gap, tail, ...more] = shown.split('\n\n');
    assert.deepEqual(more, []);

    // The head stops at the last line break before 2,000 characters.
    assert.ok(content.startsWith(`${head}\n`));
    assert.ok(head!.length <= 2000 && head!.length > 1980, `head is ${head!.length} characters`);
    assert.equal(content.slice(0, 2000).lastIndexOf('\n'), head!.length);
    // The tail is whole lines from the end, within 500 characters.
    assert.ok(content.endsWith(`\n${tail}`));
    assert.ok(tail!.endsWith('line 5999\nline 6000'));
    assert.ok(tail!.length <= 500 && tail!.length > 480, `tail is ${tail!.length} characters`);
    assert.match(tail!, /^line \d{4}\n/);
    assert.equal(gap, `... [${content.length - head!.length - tail!.length} characters truncated] ...`);

    assert.equal(
      note,
      `[The output was ${content.length} characters (6000 lines), so only its first ${head!.length} characters and its last ${tail!.split('\n').length} lines are shown above. ` +
        `All of it is saved at ${savedFile('ok')}. Use Grep on that file to find what you need, or Read it with offset and limit.]`,
    );
    assert.equal(fs.readFileSync(savedFile('ok'), 'utf8'), content);
    assert.ok(res.length < 3000, `the whole result is ${res.length} characters`);
  });

  test('the preview does not grow with the limit, nor with the size of the output', () => {
    const big = numbered(60_000);
    const small = spillOutput(SESSION, 'a', numbered(4000), 30_000);
    const large = spillOutput(SESSION, 'b', big, 30_000);
    const roomy = spillOutput(SESSION, 'c', big, 500_000);
    for (const res of [small, large, roomy]) assert.ok(parts(res).shown.length < 2600, `shown ${parts(res).shown.length} characters`);
    assert.ok(parts(large).note.startsWith(`[The output was ${big.length} characters (60000 lines), `));
    assert.equal(roomy, large.replace('/b.txt', '/c.txt'));
  });

  test('text without line breaks is cut by length', () => {
    const content = 'a'.repeat(5000) + 'b'.repeat(5000);
    const { shown, note } = parts(spillOutput(SESSION, 'oneline', content, 4000));
    assert.equal(shown, `${'a'.repeat(2000)}\n\n... [7500 characters truncated] ...\n\n${'b'.repeat(500)}`);
    assert.match(note, /^\[The output was 10000 characters \(1 line\), so only its first 2000 characters and its last line are shown above\. /);
    // A line break far from the cut is not worth losing most of the preview for.
    const early = `first\n${'c'.repeat(9000)}`;
    assert.ok(parts(spillOutput(SESSION, 'early', early, 4000)).shown.startsWith(`first\n${'c'.repeat(1994)}\n\n... [`));
  });

  test('a trailing newline is not counted as a line', () => {
    const content = `${numbered(3000)}\n`;
    const { shown, note } = parts(spillOutput(SESSION, 'nl', content, 5000));
    assert.match(note, /^\[The output was \d+ characters \(3000 lines\)/);
    assert.ok(shown.endsWith('line 3000\n'));
  });

  test('with a limit below the preview size, the preview shrinks to fit it', () => {
    const content = numbered(500);
    const res = spillOutput(SESSION, 'tiny', content, 600);
    const { shown } = parts(res);
    const [head, , tail] = shown.split('\n\n');
    assert.ok(head!.length <= 480 && head!.length > 400, `head is ${head!.length} characters`);
    assert.ok(tail!.length <= 120 && tail!.length > 90, `tail is ${tail!.length} characters`);
    assert.ok(head!.startsWith('line 1\nline 2\n'));
    assert.ok(tail!.endsWith('line 500'));
    assert.equal(fs.readFileSync(savedFile('tiny'), 'utf8'), content);
  });

  test('a failed result keeps its head and tail, up to 10,000 characters', () => {
    const content = numbered(6000);
    const res = spillOutput(SESSION, 'bad', content, 30_000, { failed: true });
    const { shown, note } = parts(res);
    assert.ok(shown.length <= 10_000 && shown.length > 9_950, `excerpt is ${shown.length} characters`);
    assert.ok(shown.startsWith('line 1\nline 2\n'));
    assert.ok(shown.endsWith('line 5999\nline 6000'));
    const [head, gap, tail, ...more] = shown.split('\n\n');
    assert.deepEqual(more, []);
    assert.ok(content.startsWith(head!) && content.endsWith(tail!));
    assert.ok(head!.length > 3900 && tail!.length > 5900, 'both ends are kept, the tail more generously');
    assert.equal(gap, `... [${content.length - head!.length - tail!.length} characters truncated] ...`);
    assert.equal(
      note,
      `[The output was ${content.length} characters (6000 lines), so only its beginning and end are shown above. ` +
        `All of it is saved at ${savedFile('bad')}. Use Grep on that file to find what you need, or Read it with offset and limit.]`,
    );
    assert.equal(fs.readFileSync(savedFile('bad'), 'utf8'), content);
  });

  test('a failed result is cut to the limit when that is below 10,000 characters', () => {
    const content = numbered(6000);
    const small = parts(spillOutput(SESSION, 'bad-small', content, 3000, { failed: true })).shown;
    assert.ok(small.length <= 3000 && small.length > 2950, `excerpt is ${small.length} characters`);
    assert.ok(small.startsWith('line 1\n') && small.endsWith('\nline 6000'));
    // A limit above 10,000 characters does not raise the excerpt above them.
    const middling = numbered(1500); // 13,392 characters
    const res = spillOutput(SESSION, 'bad-mid', middling, 12_000, { failed: true });
    assert.ok(parts(res).shown.length <= 10_000 && parts(res).shown.length > 9_950);
    assert.equal(fs.readFileSync(savedFile('bad-mid'), 'utf8'), middling);
  });

  test('when the results directory cannot be written, the text is simply cut to the limit', () => {
    // A file where the configuration directory should be: nothing can be created beneath it.
    fs.writeFileSync(path.join(dir, 'blocker'), '');
    process.env.COCO_CONFIG_DIR = path.join(dir, 'blocker', 'config');
    const content = numbered(6000);
    for (const options of [undefined, { failed: false }, { failed: true }]) {
      const res = spillOutput(SESSION, 'lost', content, 3000, options);
      assert.equal(res, clampOutput(content, 3000));
      assert.doesNotMatch(res, /saved at/);
    }
    assert.equal(spillOutput(SESSION, 'lost', 'fits', 3000), 'fits');
  });

  test('a result that was already trimmed for this call is left as it is, and the saved copy stays whole', () => {
    const content = numbered(6000);
    // A limit so small that the trimmed result, with its note, is over it again.
    const once = spillOutput(SESSION, 'twice', content, 300);
    assert.ok(once.length > 300);
    assert.equal(spillOutput(SESSION, 'twice', once, 300), once);
    assert.equal(spillOutput(SESSION, 'twice', `${once}\nExit code 1`, 300, { failed: true }), `${once}\nExit code 1`);
    assert.equal(fs.readFileSync(savedFile('twice'), 'utf8'), content);
    // The note of another call is just text.
    const other = spillOutput(SESSION, 'other', once, 300);
    assert.notEqual(other, once);
    assert.equal(fs.readFileSync(savedFile('other'), 'utf8'), once);
  });

  test('the saved file is named after the call, safely', () => {
    const content = 'z'.repeat(50);
    assert.match(spillOutput(SESSION, 'call/../../etc:1', content, 10), new RegExp(`All of it is saved at ${savedFile('call_______etc_1').replace(/[.]/g, '\\.')}\\.`));
    assert.match(spillOutput(SESSION, '', content, 10), /tool-results\/session-1\/output\.txt\. Use Grep/);
    assert.deepEqual(savedFiles().sort(), ['call_______etc_1.txt', 'output.txt']);
    for (const name of savedFiles()) assert.equal(fs.readFileSync(path.join(toolResultsDir(SESSION), name), 'utf8'), content);
  });
});
