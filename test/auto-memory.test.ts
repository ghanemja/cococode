import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { projectSlug } from '../src/config/paths.ts';
import { AUTO_MEMORY_MAX_BYTES, AUTO_MEMORY_MAX_LINES, autoMemoryDir, autoMemoryPrompt, isAutoMemoryPath, loadAutoMemory } from '../src/memory/autoMemory.ts';
import { tempProject, writeFiles } from './helpers.ts';

let root: string;
let project: string;
let dir: string;

beforeEach(() => {
  root = tempProject();
  project = path.join(root, 'repo');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  dir = autoMemoryDir(project);
});

function writeIndex(text: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), text);
}

/** `count` numbered lines, each ending in a line break. */
function numbered(count: number, width = 0): string {
  return Array.from({ length: count }, (_, i) => `- entry ${i + 1} `.padEnd(width, 'x') + '\n').join('');
}

describe('autoMemoryDir', () => {
  test('is in the user config directory, named after the project root', () => {
    assert.equal(dir, path.join(root, '.coco-home', 'projects', projectSlug(project), 'memory'));
  });

  test('every directory of a repository shares one', () => {
    writeFiles(project, { 'pkg/src/x.ts': '' });
    assert.equal(autoMemoryDir(path.join(project, 'pkg', 'src')), dir);
    assert.equal(autoMemoryDir(path.join(project, 'not', 'there', 'yet')), dir);
  });

  test('two repositories do not share one', () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    assert.notEqual(autoMemoryDir(other), dir);
  });

  test('follows the config directory', () => {
    process.env.COCO_CONFIG_DIR = path.join(root, 'elsewhere');
    assert.equal(autoMemoryDir(project), path.join(root, 'elsewhere', 'projects', projectSlug(project), 'memory'));
  });
});

describe('loadAutoMemory', () => {
  test('no index yet: nothing loaded and nothing created', () => {
    assert.deepEqual(loadAutoMemory(project), { dir, truncated: false });
    assert.ok(!fs.existsSync(dir));
    fs.mkdirSync(dir, { recursive: true });
    assert.deepEqual(loadAutoMemory(project), { dir, truncated: false });
  });

  test('a short index is loaded whole', () => {
    const text = '# Memory\n\n- build: `npm run build` (see build.md)\n- the user prefers tabs\n';
    writeIndex(text);
    assert.deepEqual(loadAutoMemory(project), { dir, index: text, truncated: false });
    assert.deepEqual(loadAutoMemory(path.join(project, 'pkg', 'src')), { dir, index: text, truncated: false });
  });

  test('an empty index is loaded as empty text', () => {
    writeIndex('');
    assert.deepEqual(loadAutoMemory(project), { dir, index: '', truncated: false });
  });

  test('exactly 200 lines fit, with or without a final line break', () => {
    const text = numbered(AUTO_MEMORY_MAX_LINES);
    writeIndex(text);
    assert.deepEqual(loadAutoMemory(project), { dir, index: text, truncated: false });
    writeIndex(text.slice(0, -1));
    assert.deepEqual(loadAutoMemory(project), { dir, index: text.slice(0, -1), truncated: false });
  });

  test('201 lines are cut to the first 200', () => {
    writeIndex(numbered(201));
    const mem = loadAutoMemory(project);
    assert.equal(mem.truncated, true);
    assert.equal(mem.index, numbered(200));
    writeIndex(numbered(201).slice(0, -1));
    assert.deepEqual(loadAutoMemory(project), { dir, index: numbered(200), truncated: true });
  });

  test('more than 25 KB is cut at the last whole line that fits', () => {
    // 100 lines of 400 bytes: 40 KB, well under the line limit.
    const text = numbered(100, 399);
    assert.equal(Buffer.byteLength(text), 40_000);
    writeIndex(text);
    const mem = loadAutoMemory(project);
    assert.equal(mem.truncated, true);
    assert.equal(mem.index, numbered(62, 399));
    assert.ok(Buffer.byteLength(mem.index!) <= AUTO_MEMORY_MAX_BYTES);
  });

  test('exactly 25 KB fits; one byte more does not', () => {
    // 125 lines of 200 bytes.
    const text = numbered(125, 199);
    assert.equal(Buffer.byteLength(text), AUTO_MEMORY_MAX_BYTES);
    writeIndex(text);
    assert.deepEqual(loadAutoMemory(project), { dir, index: text, truncated: false });
    writeIndex(`${text}y`);
    const mem = loadAutoMemory(project);
    assert.equal(mem.truncated, true);
    assert.equal(mem.index, text);
  });

  test('whichever limit is reached first applies', () => {
    // 300 short lines: the line limit comes first.
    writeIndex(numbered(300));
    assert.equal(loadAutoMemory(project).index, numbered(200));
    // 190 lines of 200 bytes: 38 KB, so the byte limit comes first.
    writeIndex(numbered(190, 199));
    assert.equal(loadAutoMemory(project).index, numbered(125, 199));
    // 400 lines of 200 bytes: both exceeded, the smaller result wins.
    writeIndex(numbered(400, 199));
    assert.equal(loadAutoMemory(project).index, numbered(125, 199));
  });

  test('a single oversized line is cut between characters, not inside one', () => {
    // The euro sign takes three bytes; 25 000 is not a multiple of three.
    const euro = String.fromCodePoint(0x20ac);
    writeIndex(euro.repeat(10_000));
    const mem = loadAutoMemory(project);
    assert.equal(mem.truncated, true);
    assert.equal(mem.index, euro.repeat(8333));
    assert.ok(!mem.index!.includes(String.fromCodePoint(0xfffd)));
  });

  test('a byte order mark is dropped', () => {
    writeIndex(`${String.fromCodePoint(0xfeff)}- a note\n`);
    assert.equal(loadAutoMemory(project).index, '- a note\n');
  });

  test('an index that is not a readable file is treated as missing', () => {
    fs.mkdirSync(path.join(dir, 'MEMORY.md'), { recursive: true });
    assert.deepEqual(loadAutoMemory(project), { dir, truncated: false });
  });
});

describe('autoMemoryPrompt', () => {
  test('names the directory and the index, and shows what the index holds', () => {
    writeIndex('- build: npm run build\n- the user prefers tabs\n');
    const text = autoMemoryPrompt(loadAutoMemory(project));
    assert.match(text, /^# Your memory\n/);
    assert.ok(text.includes(`${dir} holds your own notes about this project`));
    assert.match(text, /persist between sessions/);
    assert.match(text, /MEMORY\.md there is the index, loaded at the start of every session/);
    assert.match(text, /one line per entry, with the detail in topic files beside it/);
    assert.match(text, /a durable fact about the project, a preference of the user, or a correction/);
    assert.match(text, /Do not save the state of the current task/);
    assert.ok(text.endsWith('Current MEMORY.md:\n<memory-index>\n- build: npm run build\n- the user prefers tabs\n</memory-index>'));
    assert.ok(!text.includes('cut off'));
  });

  test('says so when the index is empty or missing', () => {
    const missing = autoMemoryPrompt(loadAutoMemory(project));
    assert.ok(missing.endsWith('MEMORY.md is empty: nothing has been saved yet.'));
    assert.ok(!missing.includes('<memory-index>'));
    writeIndex('  \n\n');
    assert.equal(autoMemoryPrompt(loadAutoMemory(project)), missing);
  });

  test('says so when the index was cut', () => {
    writeIndex(numbered(201));
    const text = autoMemoryPrompt(loadAutoMemory(project));
    assert.ok(text.endsWith('- entry 200\n</memory-index>\nOnly the first 200 lines or 25 KB are loaded and the rest was cut off. Shorten the index.'));
    assert.ok(!text.includes('- entry 201'));
  });

  test('the guidance stays short', () => {
    const words = autoMemoryPrompt({ dir, truncated: false }).split(/\s+/).filter(Boolean);
    assert.ok(words.length < 120, `${words.length} words`);
  });
});

describe('isAutoMemoryPath', () => {
  test('the directory and what is in it, whether it exists yet or not', () => {
    for (const round of ['before', 'after']) {
      assert.equal(isAutoMemoryPath(project, dir), true, round);
      assert.equal(isAutoMemoryPath(project, path.join(dir, 'MEMORY.md')), true, round);
      assert.equal(isAutoMemoryPath(project, path.join(dir, 'topics', 'build.md')), true, round);
      assert.equal(isAutoMemoryPath(path.join(project, 'pkg'), path.join(dir, 'MEMORY.md')), true, round);
      writeFiles(dir, { 'MEMORY.md': '- x\n', 'topics/build.md': 'npm run build\n' });
    }
  });

  test('everything else is outside', () => {
    writeIndex('- x\n');
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    for (const outside of [
      path.join(project, 'MEMORY.md'),
      path.join(project, 'memory', 'MEMORY.md'),
      root,
      path.dirname(dir),
      path.join(path.dirname(dir), 'session.jsonl'),
      `${dir}-backup`,
      path.join(`${dir}-backup`, 'MEMORY.md'),
      path.join(autoMemoryDir(other), 'MEMORY.md'),
      path.parse(dir).root,
    ]) {
      assert.equal(isAutoMemoryPath(project, outside), false, outside);
    }
  });

  test('a path that climbs out with .. is outside', () => {
    writeFiles(dir, { 'MEMORY.md': '- x\n', 'topics/build.md': 'b\n' });
    const sep = path.sep;
    assert.equal(isAutoMemoryPath(project, `${dir}${sep}..${sep}session.jsonl`), false);
    assert.equal(isAutoMemoryPath(project, `${dir}${sep}topics${sep}..${sep}..${sep}..${sep}x.md`), false);
    assert.equal(isAutoMemoryPath(project, `${dir}${sep}topics${sep}..${sep}MEMORY.md`), true);
    assert.equal(isAutoMemoryPath(project, `${dir}${sep}.${sep}topics${sep}${sep}build.md`), true);
  });

  test('a link inside the directory that points outside is outside', { skip: process.platform === 'win32' }, () => {
    writeFiles(root, { 'outside/secret.txt': 'secret', 'outside/deep/x.md': 'x' });
    writeIndex('- x\n');
    fs.symlinkSync(path.join(root, 'outside', 'secret.txt'), path.join(dir, 'notes.md'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(dir, 'topics'));
    fs.symlinkSync(path.join(root, 'outside', 'not-there-yet.md'), path.join(dir, 'dangling.md'));
    fs.symlinkSync(path.join(dir, 'loop-b'), path.join(dir, 'loop-a'));
    fs.symlinkSync(path.join(dir, 'loop-a'), path.join(dir, 'loop-b'));

    assert.equal(isAutoMemoryPath(project, path.join(dir, 'notes.md')), false);
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'topics')), false);
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'topics', 'secret.txt')), false);
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'topics', 'new', 'file.md')), false);
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'dangling.md')), false);
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'loop-a')), false);
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'loop-a', 'x.md')), false);
    // The plain file next to the links is still inside.
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'MEMORY.md')), true);
  });

  test('.. after a link is judged both ways', { skip: process.platform === 'win32' }, () => {
    writeFiles(root, { 'outside/deep/x.md': 'x' });
    writeIndex('- x\n');
    fs.symlinkSync(path.join(root, 'outside', 'deep'), path.join(dir, 'out'));
    // The system resolves this to outside/MEMORY.md; tidied first it reads as the index.
    assert.equal(isAutoMemoryPath(project, `${dir}${path.sep}out${path.sep}..${path.sep}MEMORY.md`), false);
    // The other way round: the system lands on the index, a tool that tidies first writes repo/MEMORY.md.
    fs.mkdirSync(path.join(dir, 'topics'));
    fs.symlinkSync(path.join(dir, 'topics'), path.join(project, 'notes'));
    assert.equal(isAutoMemoryPath(project, `${project}${path.sep}notes${path.sep}..${path.sep}MEMORY.md`), false);
    assert.equal(isAutoMemoryPath(project, path.join(project, 'notes', 'build.md')), true);
  });

  test('a link that stays inside the directory is inside', { skip: process.platform === 'win32' }, () => {
    writeFiles(dir, { 'MEMORY.md': '- x\n', 'topics/build.md': 'b\n' });
    fs.symlinkSync(path.join(dir, 'topics', 'build.md'), path.join(dir, 'build.md'));
    fs.symlinkSync(path.join(dir, 'topics'), path.join(dir, 'more'));
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'build.md')), true);
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'more', 'new.md')), true);
  });

  test('a memory directory that is itself a link counts where it leads', { skip: process.platform === 'win32' }, () => {
    const synced = path.join(root, 'synced', 'memory');
    writeFiles(synced, { 'MEMORY.md': '- x\n' });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(synced, dir);
    assert.equal(loadAutoMemory(project).index, '- x\n');
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'MEMORY.md')), true);
    assert.equal(isAutoMemoryPath(project, path.join(dir, 'new.md')), true);
    assert.equal(isAutoMemoryPath(project, path.join(synced, 'new.md')), true);
    assert.equal(isAutoMemoryPath(project, path.join(root, 'synced', 'other.md')), false);
  });

  test('a link elsewhere that leads into the directory is inside', { skip: process.platform === 'win32' }, () => {
    writeIndex('- x\n');
    fs.symlinkSync(dir, path.join(project, 'notes'));
    assert.equal(isAutoMemoryPath(project, path.join(project, 'notes', 'MEMORY.md')), true);
  });
});
