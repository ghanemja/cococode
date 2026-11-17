import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { editTool, fuzzyFind, numberLines, planEdit, readForContext, readTool, writeTool } from '../src/tools/files.ts';
import { MAX_HASH_BYTES, checkFresh, decodeUtf8, detectEol, encodingProblem, examineFile, hashContent, looksBinary, looksUtf16, recordRead, resolvePath } from '../src/tools/fsutil.ts';
import type { ToolContext, ToolResult } from '../src/tools/types.ts';
import { makeContext, tempProject, writeFiles } from './helpers.ts';

const BOM = String.fromCodePoint(0xfeff);
const REPLACEMENT = String.fromCodePoint(0xfffd);

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = tempProject('coco-files-');
  ctx = makeContext(dir, {});
});

const file = (rel: string) => path.join(dir, rel);
const put = (rel: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), content);
};
const get = (rel: string) => fs.readFileSync(file(rel), 'utf8');
const read = (rel: string, extra: Record<string, unknown> = {}) => readTool.execute({ file_path: rel, ...extra } as never, ctx);
const write = (rel: string, content: string) => writeTool.execute({ file_path: rel, content }, ctx);
const edit = (rel: string, oldString: string, newString: string, replaceAll?: boolean): Promise<ToolResult> =>
  editTool.execute({ file_path: rel, old_string: oldString, new_string: newString, replace_all: replaceAll }, ctx);
/** Put a file and mark it read, as if the model had just looked at it. */
const seen = (rel: string, content: string | Buffer) => {
  put(rel, content);
  recordRead(ctx, file(rel));
};
const bytes = (rel: string) => fs.readFileSync(file(rel));
/** Give a file a new modification time without touching its content, as `touch` does. */
const touch = (rel: string, aheadMs = 60_000) => {
  const later = new Date(Date.now() + aheadMs);
  fs.utimesSync(file(rel), later, later);
};
/** Replace a file's content behind the model's back, with a later modification time. */
const changeOutside = (rel: string, content: string | Buffer) => {
  fs.writeFileSync(file(rel), content);
  touch(rel);
};

describe('Read', () => {
  test('numbers lines and records the read', async () => {
    put('a.txt', 'one\ntwo\nthree\n');
    const res = await read('a.txt');
    assert.equal(res.content, '     1\tone\n     2\ttwo\n     3\tthree');
    assert.equal(res.summary, 'Read 3 lines');
    assert.equal(res.isError, undefined);
    assert.deepEqual(ctx.session.readFiles.get(file('a.txt'))?.partial, false);
  });

  test('a file without a trailing newline reads the same', async () => {
    put('a.txt', 'one\ntwo');
    assert.equal((await read('a.txt')).content, '     1\tone\n     2\ttwo');
    put('b.txt', 'only');
    assert.equal((await read('b.txt')).summary, 'Read 1 line');
  });

  test('absolute paths and paths relative to the session directory both work', async () => {
    put('sub/a.txt', 'x\n');
    assert.equal((await read(file('sub/a.txt'))).content, '     1\tx');
    ctx.session.cwd = file('sub');
    assert.equal((await read('a.txt')).content, '     1\tx');
    assert.equal(readTool.label!({ file_path: 'a.txt' }, ctx), 'a.txt');
  });

  test('offset and limit page through a file, with a hint for where to continue', async () => {
    put('n.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const first = await read('n.txt', { limit: 3 });
    assert.equal(first.content, '     1\tline 1\n     2\tline 2\n     3\tline 3\n\n[Showing lines 1-3 of 10. Call Read with offset=4 to continue.]');
    assert.equal(first.summary, 'Read 3 lines (1-3 of 10)');
    assert.equal(ctx.session.readFiles.get(file('n.txt'))?.partial, true);
    const middle = await read('n.txt', { offset: 4, limit: 3 });
    assert.match(middle.content, /^ {5}4\tline 4\n {5}5\tline 5\n {5}6\tline 6\n\n\[Showing lines 4-6 of 10/);
    const last = await read('n.txt', { offset: 8 });
    assert.equal(last.content, '     8\tline 8\n     9\tline 9\n    10\tline 10');
    assert.equal(last.summary, 'Read 3 lines (8-10 of 10)');
  });

  test('odd offsets and limits are handled', async () => {
    put('n.txt', 'a\nb\nc\n');
    assert.equal((await read('n.txt', { offset: 0 })).content, '     1\ta\n     2\tb\n     3\tc');
    assert.equal((await read('n.txt', { offset: -5, limit: 0 })).content.split('\n')[0], '     1\ta');
    assert.equal((await read('n.txt', { offset: 3 })).content, '     3\tc');
    const past = await read('n.txt', { offset: 4 });
    assert.equal(past.isError, true);
    assert.match(past.content, /offset 4 is past the end of the file \(3 lines\)/);
    assert.equal((await read('n.txt', { offset: 2.9, limit: 1.2 })).content.split('\n')[0], '     2\tb');
  });

  test('the default limit is 2000 lines', async () => {
    put('big.txt', Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n'));
    const res = await read('big.txt');
    assert.match(res.content, /\[Showing lines 1-2000 of 2500\. Call Read with offset=2001 to continue\.\]$/);
    assert.equal(res.content.split('\n').length, 2002);
  });

  test('very long lines are truncated', async () => {
    put('long.txt', `${'x'.repeat(5000)}\nshort\n`);
    const res = await read('long.txt');
    const [first, second] = res.content.split('\n');
    assert.equal(first!.length, 7 + 2000 + '… [line truncated]'.length);
    assert.ok(first!.endsWith('… [line truncated]'));
    assert.equal(second, '     2\tshort');
  });

  test('output is capped by maxToolOutputChars, and says so', async () => {
    ctx = makeContext(dir, { maxToolOutputChars: 500 });
    put('wide.txt', Array.from({ length: 100 }, (_, i) => `${i}:${'y'.repeat(40)}`).join('\n'));
    const res = await read('wide.txt');
    assert.match(res.content, /\(output size limit reached\)\. Call Read with offset=(\d+) to continue/);
    const shown = res.content.split('\n\n[')[0]!.split('\n').length;
    assert.ok(shown >= 5 && shown < 20, `showed ${shown} lines`);
    const next = Number(/offset=(\d+)/.exec(res.content)![1]);
    assert.equal(next, shown + 1);
    // A single line longer than the cap is still returned rather than nothing.
    put('one.txt', 'z'.repeat(1500));
    assert.match((await read('one.txt')).content, /^ {5}1\tz{1500}$/);
  });

  test('an empty file, a missing file and a directory', async () => {
    put('empty.txt', '');
    const empty = await read('empty.txt');
    assert.equal(empty.content, '(The file exists but is empty.)');
    assert.equal(empty.isError, undefined);
    assert.ok(ctx.session.readFiles.has(file('empty.txt')));

    const missing = await read('nope.txt');
    assert.equal(missing.isError, true);
    assert.match(missing.content, /File does not exist: .*nope\.txt\. The working directory is /);
    assert.equal(ctx.session.readFiles.has(file('nope.txt')), false);

    fs.mkdirSync(file('d'));
    const directory = await read('d');
    assert.equal(directory.isError, true);
    assert.match(directory.content, /is a directory/);
  });

  test('binary files are refused; PDFs get a pointer', async () => {
    put('blob.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0xff, 0x00]));
    const res = await read('blob.bin');
    assert.equal(res.isError, true);
    assert.match(res.content, /binary file \(7 bytes\)/);
    put('doc.pdf', '%PDF-1.4');
    assert.match((await read('doc.pdf')).content, /PDF files cannot be read directly/);
  });

  test('a byte-order mark is dropped and CRLF line endings do not leak into lines', async () => {
    put('bom.txt', `${BOM}first\r\nsecond\r\n`);
    assert.equal((await read('bom.txt')).content, '     1\tfirst\n     2\tsecond');
  });

  test('tabs and unicode survive', async () => {
    put('u.txt', '\tindented\nnaïve café 日本\n');
    assert.equal((await read('u.txt')).content, '     1\t\tindented\n     2\tnaïve café 日本');
  });

  test('notebooks are rendered cell by cell; a broken one is an error', async () => {
    put('n.ipynb', JSON.stringify({ cells: [{ cell_type: 'code', source: ['print(1)\n'], outputs: [], metadata: {}, execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
    const res = await read('n.ipynb');
    assert.match(res.content, /print\(1\)/);
    assert.equal(res.summary, 'Read notebook');
    assert.ok(ctx.session.readFiles.has(file('n.ipynb')));
    put('bad.ipynb', '{not json');
    assert.equal((await read('bad.ipynb')).isError, true);
  });

  test('images need a model that accepts them', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    put('pic.png', png);
    const refused = await read('pic.png');
    assert.equal(refused.isError, true);
    assert.match(refused.content, /does not accept images/);
    ctx.session.vision = true;
    const res = await read('pic.png');
    assert.equal(res.isError, undefined);
    assert.equal(res.images?.length, 1);
    assert.equal(res.images![0]!.mediaType, 'image/png');
    assert.equal(res.images![0]!.data, png.toString('base64'));
    put('PHOTO.JPG', png);
    assert.equal((await read('PHOTO.JPG')).images![0]!.mediaType, 'image/jpeg');
  });

  test('is read-only and asks permission for the resolved path', () => {
    assert.equal(readTool.isReadOnly({ file_path: 'x' }), true);
    assert.deepEqual(readTool.permission!({ file_path: 'sub/../a.txt' }, ctx), { tool: 'Read', kind: 'read', target: file('a.txt'), description: 'Read a.txt' });
  });
});

describe('Write', () => {
  test('creates a file and its parent directories', async () => {
    const res = await write('a/b/c.txt', 'hello\nworld\n');
    assert.equal(res.isError, undefined);
    assert.equal(get('a/b/c.txt'), 'hello\nworld\n');
    assert.match(res.content, /^Created a\/b\/c\.txt \(2 lines, 12 bytes\)\.$/);
    assert.equal(res.summary, 'Wrote 2 lines');
    assert.deepEqual(res.diff, { path: file('a/b/c.txt'), before: null, after: 'hello\nworld\n' });
  });

  test('overwriting needs a prior read', async () => {
    put('a.txt', 'old');
    const refused = await write('a.txt', 'new');
    assert.equal(refused.isError, true);
    assert.match(refused.content, /You must Read a\.txt before changing it/);
    assert.equal(get('a.txt'), 'old');
    await read('a.txt');
    const res = await write('a.txt', 'new');
    assert.equal(res.isError, undefined);
    assert.equal(get('a.txt'), 'new');
    assert.match(res.content, /^Overwrote a\.txt \(1 line, 3 bytes\)\.$/);
    assert.equal(res.diff?.before, 'old');
  });

  test('a file it just wrote can be written again without re-reading', async () => {
    await write('a.txt', 'one');
    assert.equal((await write('a.txt', 'two')).isError, undefined);
    assert.equal((await edit('a.txt', 'two', 'three')).isError, undefined);
    assert.equal(get('a.txt'), 'three');
  });

  test('a change on disk since the last read is detected', async () => {
    put('a.txt', 'v1');
    await read('a.txt');
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(file('a.txt'), 'changed by someone else');
    fs.utimesSync(file('a.txt'), later, later);
    const res = await write('a.txt', 'mine');
    assert.equal(res.isError, true);
    assert.match(res.content, /changed on disk since you last read it/);
    assert.equal(get('a.txt'), 'changed by someone else');
    // Edit is refused too when what it was to replace is no longer there.
    const viaEdit = await edit('a.txt', 'v1', 'x');
    assert.equal(viaEdit.isError, true);
    assert.equal(viaEdit.content, 'a.txt changed on disk since you last read it. Read it again before editing.');
    assert.equal(get('a.txt'), 'changed by someone else');
  });

  test('identical content is not rewritten', async () => {
    seen('a.txt', 'same');
    const before = fs.statSync(file('a.txt')).mtimeMs;
    const res = await write('a.txt', 'same');
    assert.match(res.content, /already has exactly this content/);
    assert.equal(res.diff, undefined);
    assert.equal(fs.statSync(file('a.txt')).mtimeMs, before);
  });

  test('a directory cannot be overwritten', async () => {
    fs.mkdirSync(file('d'));
    const res = await write('d', 'x');
    assert.equal(res.isError, true);
    assert.ok(fs.statSync(file('d')).isDirectory());
  });

  test('empty content and content without a final newline are counted sensibly', async () => {
    assert.match((await write('e.txt', '')).content, /\(0 lines, 0 bytes\)/);
    assert.match((await write('f.txt', 'a\nb')).content, /\(2 lines, 3 bytes\)/);
    assert.match((await write('g.txt', 'é')).content, /\(1 line, 2 bytes\)/);
  });

  test('a checkpoint is recorded before the change, so it can be rewound', async () => {
    seen('a.txt', 'original');
    ctx.session.turn = 3;
    await write('a.txt', 'changed');
    await write('new.txt', 'fresh');
    assert.deepEqual(ctx.session.checkpoints.changedSince(3).sort(), [file('a.txt'), file('new.txt')].sort());
    ctx.session.checkpoints.rewindTo(3);
    assert.equal(get('a.txt'), 'original');
    assert.equal(fs.existsSync(file('new.txt')), false);
  });

  test('preview shows the change without making it', () => {
    put('a.txt', 'old');
    assert.deepEqual(writeTool.preview!({ file_path: 'a.txt', content: 'new' }, ctx), { path: file('a.txt'), before: 'old', after: 'new' });
    assert.deepEqual(writeTool.preview!({ file_path: 'x/new.txt', content: 'n' }, ctx), { path: file('x/new.txt'), before: null, after: 'n' });
    assert.equal(get('a.txt'), 'old');
    assert.equal(fs.existsSync(file('x')), false);
  });

  test('the permission request distinguishes create from overwrite', () => {
    put('a.txt', 'x');
    assert.equal(writeTool.permission!({ file_path: 'a.txt', content: '' }, ctx)?.description, 'Overwrite a.txt');
    assert.equal(writeTool.permission!({ file_path: 'b.txt', content: '' }, ctx)?.description, 'Create b.txt');
    assert.equal(writeTool.permission!({ file_path: 'b.txt', content: '' }, ctx)?.tool, 'Edit');
    assert.equal(writeTool.isReadOnly({ file_path: 'b.txt', content: '' }), false);
  });
});

describe('Edit', () => {
  test('replaces an exact, unique match and shows the result', async () => {
    seen('a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const res = await edit('a.ts', 'const b = 2;', 'const b = 20;');
    assert.equal(res.isError, undefined);
    assert.equal(get('a.ts'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
    assert.equal(res.summary, 'Replaced 1 occurrence');
    assert.equal(res.content, 'Edited a.ts: replaced 1 occurrence. The file now reads:\n     1\tconst a = 1;\n     2\tconst b = 20;\n     3\tconst c = 3;');
    assert.deepEqual(res.diff, { path: file('a.ts'), before: 'const a = 1;\nconst b = 2;\nconst c = 3;\n', after: 'const a = 1;\nconst b = 20;\nconst c = 3;\n' });
  });

  test('the result snippet shows a few lines around the change', async () => {
    seen('n.txt', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const res = await edit('n.txt', 'line 15', 'LINE FIFTEEN\nand a half');
    const shown = res.content.split('\n').slice(1);
    assert.equal(shown[0], '    12\tline 12');
    assert.ok(shown.includes('    15\tLINE FIFTEEN'));
    assert.ok(shown.includes('    16\tand a half'));
    assert.equal(shown[shown.length - 1], '    19\tline 18');
  });

  test('needs a prior read, and refuses a missing file', async () => {
    put('a.txt', 'abc');
    const unread = await edit('a.txt', 'b', 'x');
    assert.equal(unread.isError, true);
    assert.match(unread.content, /You must Read a\.txt before changing it/);
    assert.equal(get('a.txt'), 'abc');
    const missing = await edit('nope.txt', 'a', 'b');
    assert.equal(missing.isError, true);
    assert.match(missing.content, /File does not exist/);
    assert.equal(fs.existsSync(file('nope.txt')), false);
  });

  test('text that is not there: an error with the nearest lines as a hint', async () => {
    seen('a.ts', 'function alpha() {\n  return computeTotal(items, taxRate);\n}\n\nfunction beta() {}\n');
    const res = await edit('a.ts', '  return computeTotal(items, discount);', 'x');
    assert.equal(res.isError, true);
    assert.match(res.content, /old_string was not found in a\.ts/);
    assert.match(res.content, /The closest text in the file is around line 2:/);
    assert.match(res.content, / {5}2\t {2}return computeTotal\(items, taxRate\);/);
    assert.match(res.content, /Read the file again/);
    assert.equal(get('a.ts').includes('taxRate'), true);
    // Nothing remotely similar: no hint, still an error.
    const far = await edit('a.ts', 'zzzz qqqq wwww', 'x');
    assert.equal(far.isError, true);
    assert.doesNotMatch(far.content, /closest text/);
  });

  test('several matches: an error listing the lines, unless replace_all', async () => {
    seen('a.txt', 'x = 1\ny = 2\nx = 1\nz = 3\nx = 1\n');
    const res = await edit('a.txt', 'x = 1', 'x = 9');
    assert.equal(res.isError, true);
    assert.match(res.content, /appears 3 times in a\.txt \(lines 1, 3, 5\)/);
    assert.equal(get('a.txt'), 'x = 1\ny = 2\nx = 1\nz = 3\nx = 1\n');
    const all = await edit('a.txt', 'x = 1', 'x = 9', true);
    assert.equal(all.isError, undefined);
    assert.equal(all.summary, 'Replaced 3 occurrences');
    assert.equal(get('a.txt'), 'x = 9\ny = 2\nx = 9\nz = 3\nx = 9\n');
  });

  test('more context makes an ambiguous match unique', async () => {
    seen('a.txt', 'x = 1\ny = 2\nx = 1\nz = 3\n');
    assert.equal((await edit('a.txt', 'x = 1\nz = 3', 'x = 7\nz = 3')).isError, undefined);
    assert.equal(get('a.txt'), 'x = 1\ny = 2\nx = 7\nz = 3\n');
  });

  test('replace_all with one match, and with overlapping candidates', async () => {
    seen('a.txt', 'aaaa b');
    assert.equal((await edit('a.txt', 'aa', 'X', true)).summary, 'Replaced 2 occurrences');
    assert.equal(get('a.txt'), 'XX b');
    assert.equal((await edit('a.txt', 'b', 'c', true)).summary, 'Replaced 1 occurrence');
  });

  test('identical old and new strings are refused', async () => {
    seen('a.txt', 'abc');
    const res = await edit('a.txt', 'b', 'b');
    assert.equal(res.isError, true);
    assert.match(res.content, /identical/);
  });

  test('an empty old_string creates a missing file, fills an empty one, and is refused otherwise', async () => {
    const created = await edit('new/file.txt', '', 'content\n');
    assert.equal(created.isError, undefined);
    assert.equal(get('new/file.txt'), 'content\n');
    assert.equal(created.diff?.before, null);

    seen('empty.txt', '');
    assert.equal((await edit('empty.txt', '', 'filled')).isError, undefined);
    assert.equal(get('empty.txt'), 'filled');

    seen('blank.txt', '  \n\n');
    assert.equal((await edit('blank.txt', '', 'now text')).isError, undefined);
    assert.equal(get('blank.txt'), 'now text');

    seen('full.txt', 'something');
    const refused = await edit('full.txt', '', 'x');
    assert.equal(refused.isError, true);
    assert.match(refused.content, /old_string is empty but the file has content/);
    assert.equal(get('full.txt'), 'something');
  });

  test('characters that are special in replacement patterns are inserted literally', async () => {
    seen('a.txt', 'price = 1\n');
    await edit('a.txt', 'price = 1', "cost = $& $1 $$ $` $' \\n \\1");
    assert.equal(get('a.txt'), "cost = $& $1 $$ $` $' \\n \\1\n");
    seen('b.txt', 'a.b a.b axb\n');
    await edit('b.txt', 'a.b', '$&$&', true);
    assert.equal(get('b.txt'), '$&$& $&$& axb\n');
    seen('c.txt', 'f(x) [y] {z} ^ $ * + ? | \\ end\n');
    await edit('c.txt', '[y] {z} ^ $ * + ? | \\', 'ok');
    assert.equal(get('c.txt'), 'f(x) ok end\n');
  });

  test('deleting text: an empty new_string', async () => {
    seen('a.txt', 'keep\nremove me\nkeep too\n');
    await edit('a.txt', 'remove me\n', '');
    assert.equal(get('a.txt'), 'keep\nkeep too\n');
  });

  test('a CRLF file keeps CRLF, whichever line endings the model used', async () => {
    seen('w.txt', 'one\r\ntwo\r\nthree\r\n');
    const res = await edit('w.txt', 'one\ntwo', 'uno\ndos\ntres');
    assert.equal(res.isError, undefined);
    assert.equal(get('w.txt'), 'uno\r\ndos\r\ntres\r\nthree\r\n');
    await edit('w.txt', 'uno\r\ndos', 'eins\r\nzwei');
    assert.equal(get('w.txt'), 'eins\r\nzwei\r\ntres\r\nthree\r\n');
    // And an LF file stays LF even if the model sends CRLF.
    seen('u.txt', 'a\nb\n');
    await edit('u.txt', 'a\r\nb', 'c\r\nd');
    assert.equal(get('u.txt'), 'c\nd\n');
  });

  test('line-number prefixes pasted from Read output are ignored', async () => {
    seen('a.ts', 'function f() {\n  return 1;\n}\n');
    const res = await edit('a.ts', '     1\tfunction f() {\n     2\t  return 1;', '     1\tfunction f() {\n     2\t  return 2;');
    assert.equal(res.isError, undefined);
    assert.equal(get('a.ts'), 'function f() {\n  return 2;\n}\n');
    // Numbered old text with an unnumbered replacement works too.
    recordRead(ctx, file('a.ts'));
    assert.equal((await edit('a.ts', '     2\t  return 2;', '  return 3;')).isError, undefined);
    assert.equal(get('a.ts'), 'function f() {\n  return 3;\n}\n');
  });

  test('rows that really begin with a number and a tab are left alone', async () => {
    seen('data.tsv', '1\tAlice\n2\tBob\n');
    assert.equal((await edit('data.tsv', '2\tBob', '2\tBob\n3\tCarol')).isError, undefined);
    assert.equal(get('data.tsv'), '1\tAlice\n2\tBob\n3\tCarol\n');
    recordRead(ctx, file('data.tsv'));
    assert.equal((await edit('data.tsv', '1\tAlice', '1\tAlicia')).isError, undefined);
    assert.equal(get('data.tsv'), '1\tAlicia\n2\tBob\n3\tCarol\n');
  });

  test('whitespace differences: trailing spaces', async () => {
    seen('a.py', 'def f():   \n    return 1\t\n\nprint(f())\n');
    const res = await edit('a.py', 'def f():\n    return 1', 'def f():\n    return 2');
    assert.equal(res.isError, undefined);
    assert.match(res.summary!, /matched ignoring trailing whitespace/);
    assert.equal(get('a.py'), 'def f():\n    return 2\n\nprint(f())\n');
  });

  test('whitespace differences: indentation, re-indented to match the file', async () => {
    seen('a.py', 'class A:\n    def f(self):\n        x = 1\n        return x\n');
    // The model dropped four spaces of indentation.
    const res = await edit('a.py', 'def f(self):\n    x = 1\n    return x', 'def f(self):\n    x = 2\n    if x:\n        return x');
    assert.equal(res.isError, undefined);
    assert.match(res.summary!, /matched ignoring indentation/);
    assert.equal(get('a.py'), 'class A:\n    def f(self):\n        x = 2\n        if x:\n            return x\n');

    // The other way round: the model indented more than the file does.
    seen('b.js', 'function g() {\n  return 1;\n}\n');
    assert.equal((await edit('b.js', '        function g() {\n          return 1;\n        }', '        function g() {\n          return 2;\n        }')).isError, undefined);
    assert.equal(get('b.js'), 'function g() {\n  return 2;\n}\n');
  });

  test('whitespace differences: tabs in the file, spaces from the model', async () => {
    seen('m.go', 'func main() {\n\tx := 1\n\tfmt.Println(x)\n}\n');
    const res = await edit('m.go', '    x := 1\n    fmt.Println(x)', '    x := 2\n    fmt.Println(x)');
    assert.equal(res.isError, undefined);
    assert.equal(get('m.go'), 'func main() {\n\tx := 2\n\tfmt.Println(x)\n}\n');
  });

  test('whitespace differences inside a line', async () => {
    seen('a.c', 'int  x   =  1;\nint y = 2;\n');
    const res = await edit('a.c', 'int x = 1;', 'int x = 5;');
    assert.equal(res.isError, undefined);
    assert.match(res.summary!, /matched ignoring whitespace differences/);
    assert.equal(get('a.c'), 'int x = 5;\nint y = 2;\n');
  });

  test('an ambiguous whitespace-tolerant match is refused', async () => {
    const original = 'if a:\n    go()\nelse:\n    pass\nif a:\n\tgo()\n';
    seen('a.py', original);
    const res = await edit('a.py', 'if a:\ngo()', 'if a:\nstop()');
    assert.equal(res.isError, true);
    assert.match(res.content, /matches 2 places in a\.py \(ignoring indentation\)/);
    assert.equal(get('a.py'), original);
    // With replace_all the caller has said every place is meant; each keeps its own indentation.
    const all = await edit('a.py', 'if a:\ngo()', 'if a:\nstop()', true);
    assert.equal(all.isError, undefined);
    assert.equal(all.summary, 'Replaced 2 occurrences (matched ignoring indentation)');
    assert.equal(get('a.py'), 'if a:\n    stop()\nelse:\n    pass\nif a:\n\tstop()\n');
  });

  test('a whitespace-tolerant match that would need guessed indentation is refused', async () => {
    const original = 'def f():\n    if a:\n        go()\n';
    seen('a.py', original);
    const res = await edit('a.py', 'if a:\ngo()', 'if a:\ngo()\nlog()');
    assert.equal(res.isError, true);
    assert.match(res.content, /old_string was not found/);
    assert.equal(get('a.py'), original);
  });

  test('a whitespace-tolerant deletion removes the lines instead of leaving a blank one', async () => {
    seen('a.txt', 'keep\n    remove me   \nkeep too\n');
    assert.equal((await edit('a.txt', 'remove me\n', '')).isError, undefined);
    assert.equal(get('a.txt'), 'keep\nkeep too\n');
  });

  test('an exact match is preferred over a looser one elsewhere', async () => {
    seen('a.txt', '  target\ntarget\n');
    await edit('a.txt', 'target\n', 'hit\n', false);
    // "target\n" occurs exactly twice as a substring (once inside "  target\n"), so it is ambiguous...
    assert.equal(get('a.txt'), '  target\ntarget\n');
    // ...until the context pins it down.
    assert.equal((await edit('a.txt', '\ntarget\n', '\nhit\n')).isError, undefined);
    assert.equal(get('a.txt'), '  target\nhit\n');
  });

  test('planEdit computes the change and touches nothing', () => {
    seen('a.txt', 'one two three');
    const mtime = fs.statSync(file('a.txt')).mtimeMs;
    const plan = planEdit({ file_path: 'a.txt', old_string: 'two', new_string: '2' }, ctx);
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.equal(plan.before, 'one two three');
    assert.equal(plan.after, 'one 2 three');
    assert.equal(plan.output, 'one 2 three');
    assert.equal(get('a.txt'), 'one two three');
    assert.equal(fs.statSync(file('a.txt')).mtimeMs, mtime);
    assert.deepEqual(planEdit({ file_path: 'a.txt', old_string: 'zzz', new_string: '2' }, ctx), {
      error: 'old_string was not found in a.txt. It must match the file exactly, including whitespace and indentation.\nRead the file again and copy the text exactly.',
    });
  });

  test('preview returns the diff for a valid edit and null for an invalid one, without writing', () => {
    seen('a.txt', 'hello world');
    assert.deepEqual(editTool.preview!({ file_path: 'a.txt', old_string: 'world', new_string: 'there' }, ctx), { path: file('a.txt'), before: 'hello world', after: 'hello there' });
    assert.equal(editTool.preview!({ file_path: 'a.txt', old_string: 'absent', new_string: 'x' }, ctx), null);
    assert.equal(editTool.preview!({ file_path: 'unread.txt', old_string: '', new_string: 'x' }, ctx)?.before, null);
    assert.equal(get('a.txt'), 'hello world');
    assert.equal(fs.existsSync(file('unread.txt')), false);
    assert.equal(ctx.session.checkpoints.changedSince(0).length, 0);
  });

  test('edits are checkpointed and leave the file marked as read', async () => {
    seen('a.txt', 'v1');
    ctx.session.turn = 2;
    await edit('a.txt', 'v1', 'v2');
    await edit('a.txt', 'v2', 'v3');
    assert.equal(get('a.txt'), 'v3');
    ctx.session.checkpoints.rewindTo(2);
    assert.equal(get('a.txt'), 'v1');
  });

  test('a directory is refused', async () => {
    fs.mkdirSync(file('d'));
    const res = await edit('d', 'a', 'b');
    assert.equal(res.isError, true);
    assert.match(res.content, /is a directory/);
  });

  test('random exact edits equal a plain string replacement', async () => {
    // Deterministic pseudo-random generator, so a failure is reproducible.
    let seed = 0x2545f491;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const alphabet = ['a', 'b', ' ', '\n', '\t', '$', '&', '(', ')', '.', '*', '\\', '1', '"', "'", '{', '}', '  ', 'foo', 'é'];
    const text = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
    let applied = 0;
    for (let round = 0; round < 300; round++) {
      const content = text(5 + Math.floor(rand() * 60));
      const start = Math.floor(rand() * content.length);
      const len = 1 + Math.floor(rand() * Math.min(12, content.length - start));
      const oldString = content.slice(start, start + len);
      const newString = text(Math.floor(rand() * 10));
      if (oldString === newString || content.trim() === '') continue;
      const occurrences = content.split(oldString).length - 1;
      const all = rand() < 0.5;
      seen('r.txt', content);
      const res = await edit('r.txt', oldString, newString, all);
      if (occurrences > 1 && !all) {
        assert.equal(res.isError, true, `round ${round}: expected ambiguity error`);
        assert.equal(get('r.txt'), content);
        continue;
      }
      assert.equal(res.isError, undefined, `round ${round}: ${JSON.stringify({ content, oldString, newString, all })} -> ${res.content}`);
      const expected = all ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
      assert.equal(get('r.txt'), expected, `round ${round}: ${JSON.stringify({ content, oldString, newString, all })}`);
      applied++;
    }
    assert.ok(applied > 100, `only ${applied} edits were applied`);
  });
});

describe('staleness is judged by content, not by the clock', () => {
  test('reading records a hash and the size of what was shown', async () => {
    put('a.txt', 'one\ntwo\n');
    await read('a.txt');
    const record = ctx.session.readFiles.get(file('a.txt'))!;
    assert.match(record.hash!, /^[0-9a-f]{64}$/);
    assert.equal(record.hash, hashContent(Buffer.from('one\ntwo\n')));
    assert.equal(record.size, 8);
    assert.equal(record.mtimeMs, fs.statSync(file('a.txt')).mtimeMs);
    assert.equal(record.partial, false);
  });

  test('a new modification time with the same content is not a change', async () => {
    put('a.py', 'def f():\n    return 1\n');
    await read('a.py');
    touch('a.py');
    assert.notEqual(fs.statSync(file('a.py')).mtimeMs, ctx.session.readFiles.get(file('a.py'))!.mtimeMs);
    assert.equal(examineFile(ctx, file('a.py')).state, 'fresh');
    // Whitespace-tolerant matching stays available: the model has seen exactly this content.
    const fuzzy = await edit('a.py', 'def f():\nreturn 1', 'def f():\nreturn 2');
    assert.equal(fuzzy.isError, undefined);
    assert.match(fuzzy.summary!, /matched ignoring indentation/);
    assert.doesNotMatch(fuzzy.content, /changed on disk/);
    assert.equal(get('a.py'), 'def f():\n    return 2\n');
    // A formatter or a checkout that writes the same bytes again is no change either.
    changeOutside('a.py', 'def f():\n    return 2\n');
    assert.equal((await write('a.py', 'def f():\n    return 3\n')).isError, undefined);
    assert.equal(get('a.py'), 'def f():\n    return 3\n');
  });

  test('different content under the same modification time is a change', async () => {
    const when = new Date('2024-05-06T07:08:09Z');
    put('a.txt', 'alpha one\n');
    fs.utimesSync(file('a.txt'), when, when);
    await read('a.txt');
    // Same length, same timestamp, different bytes: only the content gives it away.
    fs.writeFileSync(file('a.txt'), 'alpha two\n');
    fs.utimesSync(file('a.txt'), when, when);
    const record = ctx.session.readFiles.get(file('a.txt'))!;
    assert.equal(fs.statSync(file('a.txt')).mtimeMs, record.mtimeMs);
    assert.equal(fs.statSync(file('a.txt')).size, record.size);
    assert.equal(examineFile(ctx, file('a.txt')).state, 'changed');
    const res = await write('a.txt', 'mine\n');
    assert.equal(res.isError, true);
    assert.equal(res.content, 'a.txt changed on disk since you last read it. Read it again before editing.');
    assert.equal(get('a.txt'), 'alpha two\n');
    // An older timestamp hides nothing either.
    const earlier = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(file('a.txt'), earlier, earlier);
    assert.match(checkFresh(ctx, file('a.txt'))!, /changed on disk/);
    // Reading it again settles it.
    await read('a.txt');
    assert.equal((await write('a.txt', 'mine\n')).isError, undefined);
    assert.equal(get('a.txt'), 'mine\n');
  });

  test('a file put back to what was read is fresh again', () => {
    seen('a.txt', 'v1');
    changeOutside('a.txt', 'v2');
    assert.equal(examineFile(ctx, file('a.txt')).state, 'changed');
    changeOutside('a.txt', 'v1');
    assert.deepEqual(examineFile(ctx, file('a.txt')), { state: 'fresh' });
  });

  test('examineFile tells new, unread and directory apart, each with what to do', () => {
    assert.deepEqual(examineFile(ctx, file('nothing.txt')), { state: 'new' });
    put('a.txt', 'x');
    assert.deepEqual(examineFile(ctx, file('a.txt')), { state: 'unread', message: 'You must Read a.txt before changing it, so the edit is based on its current content.' });
    fs.mkdirSync(file('d'));
    assert.equal(examineFile(ctx, file('d')).state, 'directory');
    // Bytes the caller already holds are compared instead of reading the file again.
    recordRead(ctx, file('a.txt'));
    assert.equal(examineFile(ctx, file('a.txt'), Buffer.from('x')).state, 'fresh');
    assert.equal(examineFile(ctx, file('a.txt'), Buffer.from('y')).state, 'changed');
  });

  test('files too large to hash, and records without a hash, go by the modification time', () => {
    put('big.txt', Buffer.alloc(MAX_HASH_BYTES + 1, 0x61));
    try {
      recordRead(ctx, file('big.txt'));
      const record = ctx.session.readFiles.get(file('big.txt'))!;
      assert.equal(record.hash, undefined);
      assert.equal(record.size, MAX_HASH_BYTES + 1);
      assert.equal(checkFresh(ctx, file('big.txt')), null);
      touch('big.txt');
      assert.match(checkFresh(ctx, file('big.txt'))!, /changed on disk/);
    } finally {
      fs.rmSync(file('big.txt'));
    }
    // A record made elsewhere without a hash (an @-mention, an older session) behaves the same way.
    put('m.txt', 'mentioned');
    ctx.session.readFiles.set(file('m.txt'), { mtimeMs: fs.statSync(file('m.txt')).mtimeMs, partial: false });
    assert.equal(checkFresh(ctx, file('m.txt')), null);
    touch('m.txt');
    assert.match(checkFresh(ctx, file('m.txt'))!, /changed on disk/);
  });

  test('writing and editing leave the file recorded with its new content', async () => {
    await write('a.txt', 'one');
    assert.equal(ctx.session.readFiles.get(file('a.txt'))!.hash, hashContent(Buffer.from('one')));
    await edit('a.txt', 'one', 'two é');
    const record = ctx.session.readFiles.get(file('a.txt'))!;
    assert.equal(record.hash, hashContent(Buffer.from('two é')));
    assert.equal(record.size, 6);
    assert.equal(checkFresh(ctx, file('a.txt')), null);
  });
});

describe('Edit on a file that changed since it was read', () => {
  const original = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

  test('a target that still matches exactly once is edited, and the result says the file had changed', async () => {
    seen('a.ts', original);
    const outside = '// formatted\nconst a = 1;\nconst b = 2;\nconst c = 33;\n';
    changeOutside('a.ts', outside);
    const res = await edit('a.ts', 'const b = 2;', 'const b = 20;');
    assert.equal(res.isError, undefined);
    // The edit lands in the file as it is now; the outside change is kept.
    assert.equal(get('a.ts'), '// formatted\nconst a = 1;\nconst b = 20;\nconst c = 33;\n');
    assert.equal(
      res.content,
      'Edited a.ts: replaced 1 occurrence. Note: a.ts had changed on disk since you last read it. old_string still matched it exactly, so the edit was applied; ' +
        'Read the file again if you need to see what else is different. The file now reads:\n' +
        '     1\t// formatted\n     2\tconst a = 1;\n     3\tconst b = 20;\n     4\tconst c = 33;',
    );
    assert.equal(res.summary, 'Replaced 1 occurrence');
    assert.equal(res.diff?.before, outside);
    // The edit leaves the file recorded in its new state: no note the second time.
    const again = await edit('a.ts', 'const b = 20;', 'const b = 21;');
    assert.equal(again.isError, undefined);
    assert.doesNotMatch(again.content, /changed on disk/);
  });

  test('a target that now matches twice is refused, unless replace_all', async () => {
    seen('a.ts', original);
    const outside = 'const b = 2;\nconst a = 1;\nconst b = 2;\n';
    changeOutside('a.ts', outside);
    const res = await edit('a.ts', 'const b = 2;', 'const b = 20;');
    assert.equal(res.isError, true);
    assert.equal(
      res.content,
      'old_string appears 2 times in a.ts (lines 1, 3). Add surrounding lines to make it unique, or set replace_all to true. ' +
        'The file also changed on disk since you last read it, so Read it again to see what is there now.',
    );
    assert.equal(get('a.ts'), outside);
    const all = await edit('a.ts', 'const b = 2;', 'const b = 20;', true);
    assert.equal(all.isError, undefined);
    assert.equal(all.summary, 'Replaced 2 occurrences');
    assert.match(all.content, /a\.ts had changed on disk since you last read it/);
    assert.equal(get('a.ts'), 'const b = 20;\nconst a = 1;\nconst b = 20;\n');
  });

  test('a target that is gone is refused and the file is left alone', async () => {
    seen('a.ts', original);
    const outside = 'const a = 1;\nconst b = 200;\nconst c = 3;\n';
    changeOutside('a.ts', outside);
    const res = await edit('a.ts', 'const b = 2;', 'const b = 20;');
    assert.equal(res.isError, true);
    assert.equal(res.content, 'a.ts changed on disk since you last read it. Read it again before editing.');
    assert.equal((await edit('a.ts', 'const b = 2;', 'const b = 20;', true)).isError, true);
    assert.equal(get('a.ts'), outside);
    // After reading it again the model edits what is really there.
    await read('a.ts');
    assert.equal((await edit('a.ts', 'const b = 200;', 'const b = 20;')).isError, undefined);
    assert.equal(get('a.ts'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
  });

  test('whitespace-tolerant matching is not used on a changed file', async () => {
    const py = 'class A:\n    def f(self):\n        return 1   \n';
    seen('a.py', py);
    const outside = `# header\n${py}`;
    changeOutside('a.py', outside);
    const stale = 'a.py changed on disk since you last read it. Read it again before editing.';
    // Wrong indentation: on a file the model had seen, this would match ignoring it.
    const indent = { file_path: 'a.py', old_string: 'def f(self):\n    return 1', new_string: 'def f(self):\n    return 2' };
    const res = await editTool.execute(indent, ctx);
    assert.equal(res.isError, true);
    assert.equal(res.content, stale);
    assert.equal(editTool.preview!(indent, ctx), null);
    // Trailing whitespace and spacing inside a line are no different, with or without replace_all.
    assert.equal((await edit('a.py', '        return 1\n', '        return 2\n')).content, stale);
    assert.equal((await edit('a.py', 'def  f(self):', 'def g(self):', true)).content, stale);
    assert.equal(get('a.py'), outside);
    // Once it has been read again, the same edit goes through.
    await read('a.py');
    const ok = await editTool.execute(indent, ctx);
    assert.equal(ok.isError, undefined);
    assert.match(ok.summary!, /matched ignoring indentation/);
    assert.equal(get('a.py'), '# header\nclass A:\n    def f(self):\n        return 2\n');
  });

  test('line-number prefixes pasted from Read are still dropped, for an exact match only', async () => {
    seen('a.ts', original);
    changeOutside('a.ts', `// formatted\n${original}`);
    const res = await edit('a.ts', '     2\tconst b = 2;', '     2\tconst b = 20;');
    assert.equal(res.isError, undefined);
    assert.match(res.content, /had changed on disk/);
    assert.equal(get('a.ts'), '// formatted\nconst a = 1;\nconst b = 20;\nconst c = 3;\n');
    // Without the prefix the text would only match loosely: refused.
    changeOutside('a.ts', 'const  a = 1;\n');
    const loose = await edit('a.ts', '     1\tconst a = 1;', '     1\tconst a = 10;');
    assert.equal(loose.isError, true);
    assert.match(loose.content, /changed on disk since you last read it\. Read it again/);
    assert.equal(get('a.ts'), 'const  a = 1;\n');
  });

  test('filling a blank file replaces all of it, so it needs a current read', async () => {
    seen('e.txt', 'text');
    changeOutside('e.txt', '\n');
    const res = await edit('e.txt', '', 'filled');
    assert.equal(res.isError, true);
    assert.match(res.content, /changed on disk since you last read it/);
    assert.equal(get('e.txt'), '\n');
  });

  test('Write stays strict, and a file that was never read is refused whatever it holds', async () => {
    seen('a.txt', 'hello world\n');
    changeOutside('a.txt', 'hello world\nmore\n');
    const overwrite = await write('a.txt', 'replaced\n');
    assert.equal(overwrite.isError, true);
    assert.match(overwrite.content, /changed on disk since you last read it/);
    assert.equal(get('a.txt'), 'hello world\nmore\n');

    put('never.txt', 'hello world\n');
    const unread = await edit('never.txt', 'hello', 'bye');
    assert.equal(unread.isError, true);
    assert.match(unread.content, /You must Read never\.txt before changing it/);
    assert.equal(get('never.txt'), 'hello world\n');
  });

  test('line endings of the changed file are kept, and preview shows the same change', async () => {
    seen('w.txt', 'one\ntwo\n');
    changeOutside('w.txt', 'zero\r\none\r\ntwo\r\n');
    const input = { file_path: 'w.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' };
    assert.deepEqual(editTool.preview!(input, ctx), { path: file('w.txt'), before: 'zero\none\ntwo\n', after: 'zero\nuno\ndos\n' });
    assert.equal(get('w.txt'), 'zero\r\none\r\ntwo\r\n');
    assert.equal((await editTool.execute(input, ctx)).isError, undefined);
    assert.equal(get('w.txt'), 'zero\r\nuno\r\ndos\r\n');
  });
});

describe('files that are not UTF-8', () => {
  // "café" as Latin-1 writes it: one byte, 0xE9, that is not UTF-8.
  const latin1 = Buffer.concat([Buffer.from('nom = "caf'), Buffer.from([0xe9]), Buffer.from('"\nprix = 3\n')]);

  test('Read shows a Latin-1 file with a note, and Edit refuses it without touching a byte', async () => {
    put('l.txt', latin1);
    const shown = await read('l.txt');
    assert.equal(shown.isError, undefined);
    const [text, note, ...more] = shown.content.split('\n\n');
    assert.equal(text, `     1\tnom = "caf${REPLACEMENT}"\n     2\tprix = 3`);
    assert.equal(
      note,
      `[l.txt is not valid UTF-8 (it is probably Latin-1, Windows-1252 or another legacy encoding). Bytes that do not decode are shown as ${REPLACEMENT}, ` +
        'and Edit will refuse this file: change it with a shell tool such as sed, or convert it to UTF-8 with iconv first.]',
    );
    assert.equal(note!.includes('\n'), false, 'the note is one line');
    assert.deepEqual(more, []);

    const input = { file_path: 'l.txt', old_string: 'prix = 3', new_string: 'prix = 4' };
    const res = await editTool.execute(input, ctx);
    assert.equal(res.isError, true);
    assert.equal(
      res.content,
      'l.txt is not valid UTF-8 (it is probably Latin-1, Windows-1252 or another legacy encoding), and Edit only works on UTF-8 text: ' +
        'decoding the file would replace the bytes that do not fit and corrupt it. Change it with a shell tool such as sed, or convert it to UTF-8 with iconv first.',
    );
    assert.equal(editTool.preview!(input, ctx), null);
    // Not with the replacement character the model was shown either, nor with replace_all.
    assert.equal((await edit('l.txt', `caf${REPLACEMENT}`, 'cafe', true)).isError, true);
    assert.equal((await edit('l.txt', '', 'x')).isError, true);
    assert.deepEqual(bytes('l.txt'), latin1);
  });

  test('a paged read of such a file carries the note after the paging hint', async () => {
    put('l.txt', latin1);
    const res = await read('l.txt', { limit: 1 });
    assert.match(res.content, /\[Showing lines 1-1 of 2\. Call Read with offset=2 to continue\.\]\n\n\[l\.txt is not valid UTF-8 /);
  });

  test('UTF-16 files are refused, with or without a byte-order mark', async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('key = value\n', 'utf16le')]);
    put('u16.txt', le);
    const shown = await read('u16.txt');
    assert.equal(shown.isError, true);
    assert.match(shown.content, /^u16\.txt is a binary file \(26 bytes\) and cannot be shown as text\. It looks like UTF-16 text: convert it with Bash, for example iconv -f UTF-16 -t UTF-8/);
    recordRead(ctx, file('u16.txt')); // as after `cat u16.txt`
    const res = await edit('u16.txt', 'value', 'other');
    assert.equal(res.isError, true);
    assert.match(res.content, /^u16\.txt is UTF-16 text, not UTF-8, and Edit only works on UTF-8 text: .*sed.*iconv/);
    assert.deepEqual(bytes('u16.txt'), le);

    // Without the mark these bytes are letters and zeros, which UTF-8 allows; it is the same encoding all the same.
    const bare = Buffer.from('key = value\n', 'utf16le');
    assert.notEqual(decodeUtf8(bare), null);
    seen('bare.txt', bare);
    const res2 = await edit('bare.txt', 'value', 'other');
    assert.equal(res2.isError, true);
    assert.match(res2.content, /^bare\.txt is UTF-16 text, not UTF-8/);
    assert.deepEqual(bytes('bare.txt'), bare);

    const be = Buffer.from(le).swap16();
    seen('be.txt', be);
    assert.match((await edit('be.txt', 'value', 'other')).content, /^be\.txt is UTF-16 text, not UTF-8/);
    assert.deepEqual(bytes('be.txt'), be);
  });

  test('binary data is refused as well', async () => {
    const blob = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x41]);
    seen('blob.bin', blob);
    const res = await edit('blob.bin', 'A', 'B');
    assert.equal(res.isError, true);
    assert.match(res.content, /^blob\.bin is binary data, not UTF-8 text, and Edit only works on UTF-8 text/);
    assert.deepEqual(bytes('blob.bin'), blob);
  });

  test('a byte-order mark is valid UTF-8 and survives an edit', async () => {
    put('bom.txt', `${BOM}first\r\nsecond\r\n`);
    assert.equal((await read('bom.txt')).content, '     1\tfirst\n     2\tsecond');
    const res = await edit('bom.txt', 'first', 'FIRST');
    assert.equal(res.isError, undefined);
    assert.equal(res.content, 'Edited bom.txt: replaced 1 occurrence. The file now reads:\n     1\tFIRST\n     2\tsecond');
    assert.equal(res.diff?.before, 'first\nsecond\n');
    assert.deepEqual([...bytes('bom.txt').subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepEqual(bytes('bom.txt'), Buffer.from(`${BOM}FIRST\r\nsecond\r\n`));

    // A whitespace-tolerant match on the first line keeps the mark too.
    seen('b2.txt', `${BOM}  alpha\n  beta\n`);
    const fuzzy = await edit('b2.txt', 'alpha\nbeta', 'ALPHA\nBETA');
    assert.equal(fuzzy.isError, undefined);
    assert.deepEqual(bytes('b2.txt'), Buffer.from(`${BOM}  ALPHA\n  BETA\n`));

    // So does replacing everything after it, and filling a file that holds nothing else.
    seen('b3.txt', `${BOM}only`);
    assert.equal((await edit('b3.txt', 'only', 'all new')).isError, undefined);
    assert.deepEqual(bytes('b3.txt'), Buffer.from(`${BOM}all new`));
    seen('b4.txt', BOM);
    assert.equal((await edit('b4.txt', '', 'text\n')).isError, undefined);
    assert.deepEqual(bytes('b4.txt'), Buffer.from(`${BOM}text\n`));
    // A file without one does not gain one.
    seen('plain.txt', 'x');
    await edit('plain.txt', 'x', 'y');
    assert.deepEqual(bytes('plain.txt'), Buffer.from('y'));
  });

  test('multi-byte UTF-8 text is edited as before', async () => {
    seen('u.txt', 'naïve café 日本\nrésumé ✓\n');
    assert.equal((await edit('u.txt', 'café 日本', 'thé 東京')).isError, undefined);
    assert.equal(get('u.txt'), 'naïve thé 東京\nrésumé ✓\n');
  });

  test('decodeUtf8, looksUtf16 and encodingProblem', () => {
    assert.equal(decodeUtf8(Buffer.from('plain')), 'plain');
    assert.equal(decodeUtf8(Buffer.from(`${BOM}x`)), `${BOM}x`);
    assert.equal(decodeUtf8(Buffer.alloc(0)), '');
    assert.equal(decodeUtf8(Buffer.from([0x63, 0xe9])), null);
    assert.equal(decodeUtf8(Buffer.from([0x63, 0xc3])), null, 'a sequence cut short');
    assert.equal(decodeUtf8(Buffer.from([0xed, 0xa0, 0x80])), null, 'a lone surrogate');
    assert.equal(looksUtf16(Buffer.from('ascii text')), false);
    assert.equal(looksUtf16(Buffer.from('hello there', 'utf16le')), true);
    assert.equal(looksUtf16(Buffer.from([0xfe, 0xff, 0x00, 0x68])), true);
    assert.equal(looksUtf16(Buffer.alloc(64)), false, 'all zeros is not text');
    assert.equal(looksUtf16(Buffer.alloc(0)), false);
    assert.equal(encodingProblem(Buffer.from('naïve café ✓')), null);
    assert.equal(encodingProblem(Buffer.alloc(0)), null);
    assert.match(encodingProblem(Buffer.from([0x89, 0x50, 0x00, 0xff]))!, /binary data/);
    assert.match(encodingProblem(Buffer.from([0x63, 0xe9]))!, /not valid UTF-8/);
  });
});

describe('fuzzyFind', () => {
  test('returns null when nothing is close, or the text is only whitespace', () => {
    assert.equal(fuzzyFind('a\nb\nc', 'zzz', 'y'), null);
    assert.equal(fuzzyFind('a\nb\nc', '   \n  ', 'y'), null);
    assert.equal(fuzzyFind('', 'a', 'b'), null);
  });

  test('finds the real text, reports how, and counts candidates', () => {
    const found = fuzzyFind('  alpha  \n    beta\n', 'alpha\nbeta', 'ALPHA\nBETA');
    assert.ok(found);
    assert.equal(found!.actual, '  alpha  \n    beta');
    assert.equal(found!.how, 'ignoring indentation');
    assert.equal(found!.count, 1);
    assert.equal(found!.replacement, '  ALPHA\n    BETA');
    assert.deepEqual(found!.regions.map((r) => [r.startLine, r.lineCount]), [[0, 2]]);
    assert.equal(fuzzyFind('x\n  go()\ny\n\tgo()\n', 'go()', 'no()')!.count, 2);
  });

  test('prefers the strictest strategy that matches', () => {
    assert.equal(fuzzyFind('a  \nb\n', 'a\nb', 'c')!.how, 'ignoring trailing whitespace');
    assert.equal(fuzzyFind('  a\n', 'a', 'c')!.how, 'ignoring indentation');
    assert.equal(fuzzyFind('a   b\n', 'a b', 'c')!.how, 'ignoring whitespace differences');
  });

  test('blank lines around the search text are not required to match', () => {
    const found = fuzzyFind('one\n  two\nthree\n', '\n\ntwo\n\n', '\nTWO\n');
    assert.equal(found!.actual, '  two');
    assert.equal(found!.replacement, '  TWO');
  });

  test('relative indentation inside the replacement is preserved', () => {
    const found = fuzzyFind('\t\tif (x) {\n\t\t\ty();\n\t\t}\n', 'if (x) {\n  y();\n}', 'if (x) {\n  y();\n  z();\n}');
    assert.equal(found!.replacement, '\t\tif (x) {\n\t\t\ty();\n\t\t\tz();\n\t\t}');
  });

  test('new, deeper lines are indented in the file\'s own style', () => {
    // Tabs in the file, four spaces from the model.
    const tabs = fuzzyFind('func f() {\n\tx := 1\n}\n', 'func f() {\n    x := 1\n}', 'func f() {\n    if ok {\n        x := 1\n    }\n}');
    assert.equal(tabs!.replacement, 'func f() {\n\tif ok {\n\t\tx := 1\n\t}\n}');
    // Spaces in the file, tabs from the model.
    const spaces = fuzzyFind('def f():\n    return 1\n', 'def f():\n\treturn 1', 'def f():\n\tif x:\n\t\treturn 1');
    assert.equal(spaces!.replacement, 'def f():\n    if x:\n        return 1');
    // A dedent below every level seen in old_string.
    const dedent = fuzzyFind('class A:\n        x = 1\n', '    x = 1', '    x = 2\ny = 3');
    assert.equal(dedent!.replacement, '        x = 2\n    y = 3');
  });

  test('refuses to guess when old_string flattened the indentation and the replacement changes shape', () => {
    const content = 'if a:\n    go()\n';
    // Same shape: each line keeps the indentation of the line it replaces.
    assert.equal(fuzzyFind(content, 'if a:\ngo()', 'if b:\nstop()')!.replacement, 'if b:\n    stop()');
    // An added line could belong at either level.
    assert.equal(fuzzyFind(content, 'if a:\ngo()', 'if a:\ngo()\nmore()'), null);
  });

  test('an empty replacement removes the matched lines', () => {
    const found = fuzzyFind('a\n  b  \nc\n', 'b', '');
    assert.equal(found!.replacement, '');
    assert.equal(found!.actual, '  b  ');
  });
});

describe('fsutil helpers', () => {
  test('resolvePath expands ~ and trims', () => {
    const home = process.env.HOME;
    process.env.HOME = '/home/tester';
    try {
      assert.equal(resolvePath(ctx, '~/x.txt'), '/home/tester/x.txt');
      assert.equal(resolvePath(ctx, '  a/../b.txt '), file('b.txt'));
      assert.equal(resolvePath(ctx, '/abs/p'), '/abs/p');
    } finally {
      process.env.HOME = home;
    }
  });

  test('checkFresh: new files pass, unread and stale files do not', () => {
    assert.equal(checkFresh(ctx, file('new.txt')), null);
    put('a.txt', 'x');
    assert.match(checkFresh(ctx, file('a.txt'))!, /must Read/);
    recordRead(ctx, file('a.txt'));
    assert.equal(checkFresh(ctx, file('a.txt')), null);
    // A new modification time alone is not a change; different content is.
    touch('a.txt');
    assert.equal(checkFresh(ctx, file('a.txt')), null);
    changeOutside('a.txt', 'y');
    assert.match(checkFresh(ctx, file('a.txt'))!, /changed on disk/);
    fs.mkdirSync(file('d'));
    assert.match(checkFresh(ctx, file('d'))!, /is a directory/);
  });

  test('looksBinary and detectEol', () => {
    assert.equal(looksBinary(Buffer.from('plain text\nwith lines\n')), false);
    assert.equal(looksBinary(Buffer.from('tabs\tand\r\nreturns')), false);
    assert.equal(looksBinary(Buffer.from([1, 2, 3, 0, 4])), true);
    assert.equal(looksBinary(Buffer.alloc(0)), false);
    assert.equal(looksBinary(Buffer.from('naïve café ✓ 日本語')), false);
    assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
    assert.equal(detectEol('a\nb\n'), '\n');
    assert.equal(detectEol('a\r\nb\nc\nd\n'), '\n');
    assert.equal(detectEol('no newline'), '\n');
  });

  test('numberLines pads to six columns', () => {
    assert.equal(numberLines(['a', 'b'], 9), '     9\ta\n    10\tb');
    assert.equal(numberLines([], 1), '');
  });

  test('readForContext returns text, clips long files and skips binaries', () => {
    writeFiles(dir, { 'a.txt': 'hello', 'long.txt': 'x'.repeat(50) });
    put('b.bin', Buffer.from([0, 1, 2]));
    assert.equal(readForContext(ctx, file('a.txt'), 100), 'hello');
    assert.equal(ctx.session.readFiles.get(file('a.txt'))?.partial, false);
    assert.match(readForContext(ctx, file('long.txt'), 10)!, /^x{10}\n… \[truncated, 40 more characters\]$/);
    assert.equal(ctx.session.readFiles.get(file('long.txt'))?.partial, true);
    assert.equal(readForContext(ctx, file('b.bin'), 100), null);
    assert.equal(readForContext(ctx, file('missing'), 100), null);
  });
});
