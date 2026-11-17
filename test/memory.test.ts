import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { appendMemory, findImports, loadMemory, memoryTargets, renderMemory } from '../src/memory/memory.ts';
import { tempProject, writeFiles } from './helpers.ts';

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = tempProject();
  // A .git marker bounds the upward walk at the temp project.
  fs.mkdirSync(path.join(root, '.git'));
  savedHome = process.env.HOME;
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

/** Paths relative to the temp project, for readable assertions. */
function rel(files: { path: string }[]): string[] {
  return files.map((f) => path.relative(root, f.path));
}

describe('findImports', () => {
  test('finds path-like references', () => {
    assert.deepEqual(findImports('See @docs/style.md and @./local.md, also (@../shared/rules.md)\n@~/notes.md\n@/abs/path.txt'), [
      'docs/style.md',
      './local.md',
      '../shared/rules.md',
      '~/notes.md',
      '/abs/path.txt',
    ]);
  });

  test('a sentence-ending full stop is not part of the path', () => {
    assert.deepEqual(findImports('Read @docs/guide.md. Then @README.md...'), ['docs/guide.md', 'README.md']);
  });

  test('people and e-mail addresses are not imports', () => {
    assert.deepEqual(findImports('Ask @alice or @bob-smith, mail me@example.com, ping team@corp.io.'), []);
  });

  test('references in code spans and fenced blocks are ignored', () => {
    const text = ['Use `@types/node` for types.', '```', '@in/fence.md', '```', '~~~sh', 'npm i @scope/pkg.js', '~~~', 'Real: @real/file.md'].join('\n');
    assert.deepEqual(findImports(text), ['real/file.md']);
  });

  test('a bare word with an extension counts, a bare word does not', () => {
    assert.deepEqual(findImports('@CONVENTIONS.md and @todo'), ['CONVENTIONS.md']);
  });
});

describe('loadMemory', () => {
  test('nothing to load', () => {
    assert.deepEqual(loadMemory(root, true), []);
  });

  test('user files come first, then each directory from the root down', () => {
    writeFiles(root, {
      '.coco-home/COCO.md': 'user coco',
      'home/.claude/CLAUDE.md': 'user claude',
      'COCO.md': 'root coco',
      'pkg/COCO.md': 'pkg coco',
      'pkg/app/COCO.md': 'app coco',
      'other/COCO.md': 'not on the path',
    });
    const files = loadMemory(path.join(root, 'pkg', 'app'), true);
    assert.deepEqual(rel(files), [
      path.join('.coco-home', 'COCO.md'),
      path.join('home', '.claude', 'CLAUDE.md'),
      'COCO.md',
      path.join('pkg', 'COCO.md'),
      path.join('pkg', 'app', 'COCO.md'),
    ]);
    assert.deepEqual(
      files.map((f) => f.scope),
      ['user', 'user', 'project', 'project', 'project'],
    );
    assert.deepEqual(
      files.map((f) => f.content),
      ['user coco', 'user claude', 'root coco', 'pkg coco', 'app coco'],
    );
  });

  test('every file name in a directory, with local files last', () => {
    writeFiles(root, {
      'COCO.md': 'one',
      '.coco/COCO.md': 'two',
      'AGENTS.md': 'three',
      'CLAUDE.md': 'four',
      '.claude/CLAUDE.md': 'five',
      'COCO.local.md': 'six',
      'CLAUDE.local.md': 'seven',
    });
    const files = loadMemory(root, true);
    assert.deepEqual(rel(files), ['COCO.md', path.join('.coco', 'COCO.md'), 'AGENTS.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'COCO.local.md', 'CLAUDE.local.md']);
    assert.deepEqual(
      files.map((f) => f.scope),
      ['project', 'project', 'project', 'project', 'project', 'local', 'local'],
    );
  });

  test('a parent directory local file still precedes the child directory', () => {
    writeFiles(root, { 'COCO.local.md': 'root local', 'sub/COCO.md': 'sub project' });
    assert.deepEqual(rel(loadMemory(path.join(root, 'sub'), true)), ['COCO.local.md', path.join('sub', 'COCO.md')]);
  });

  test('with compat off only coco and AGENTS files are read', () => {
    writeFiles(root, {
      'home/.claude/CLAUDE.md': 'user claude',
      'COCO.md': 'coco',
      'AGENTS.md': 'agents',
      'CLAUDE.md': 'claude',
      '.claude/CLAUDE.md': 'dot claude',
      'CLAUDE.local.md': 'claude local',
    });
    assert.deepEqual(rel(loadMemory(root, false)), ['COCO.md', 'AGENTS.md']);
  });

  test('directories above the project root are not read', () => {
    writeFiles(root, { 'outer/COCO.md': 'outside the repo', 'outer/repo/.git/HEAD': 'x', 'outer/repo/COCO.md': 'inside', 'outer/repo/src/x.ts': '' });
    assert.deepEqual(rel(loadMemory(path.join(root, 'outer', 'repo', 'src'), true)), [path.join('outer', 'repo', 'COCO.md')]);
  });

  test('empty and whitespace-only files are skipped', () => {
    writeFiles(root, { 'COCO.md': '', 'AGENTS.md': '  \n\n', 'CLAUDE.md': 'real' });
    assert.deepEqual(rel(loadMemory(root, true)), ['CLAUDE.md']);
  });

  test('identical content is loaded once', () => {
    writeFiles(root, { 'AGENTS.md': 'Same rules.\n', 'CLAUDE.md': 'Same rules.\n', 'COCO.md': 'Different.\n' });
    assert.deepEqual(rel(loadMemory(root, true)), ['COCO.md', 'AGENTS.md']);
  });

  test('a symlink to another memory file is loaded once', { skip: process.platform === 'win32' }, () => {
    writeFiles(root, { 'AGENTS.md': 'Shared rules.\n' });
    fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
    fs.symlinkSync('AGENTS.md', path.join(root, 'COCO.md'));
    const files = loadMemory(root, true);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.content, 'Shared rules.\n');
  });

  test('a directory named like a memory file is ignored', () => {
    fs.mkdirSync(path.join(root, 'COCO.md'));
    writeFiles(root, { 'AGENTS.md': 'ok' });
    assert.deepEqual(rel(loadMemory(root, true)), ['AGENTS.md']);
  });

  test('imports are resolved relative to the importing file and follow it in order', () => {
    writeFiles(root, {
      'COCO.md': 'Root rules.\nSee @docs/style.md and @docs/api/errors.md\n',
      'docs/style.md': 'Style guide. Also @api/naming.md\n',
      'docs/api/naming.md': 'Naming.\n',
      'docs/api/errors.md': 'Errors.\n',
      'AGENTS.md': 'Agents.\n',
    });
    const files = loadMemory(root, true);
    assert.deepEqual(rel(files), ['COCO.md', path.join('docs', 'style.md'), path.join('docs', 'api', 'naming.md'), path.join('docs', 'api', 'errors.md'), 'AGENTS.md']);
    assert.equal(files[1]!.importedBy, path.join(root, 'COCO.md'));
    assert.equal(files[2]!.importedBy, path.join(root, 'docs', 'style.md'));
    assert.equal(files[0]!.importedBy, undefined);
    assert.ok(files.every((f) => f.scope === 'project'));
  });

  test('imports inherit the scope of the importing file', () => {
    writeFiles(root, { '.coco-home/COCO.md': 'User. @extra.md\n', '.coco-home/extra.md': 'Extra.\n', 'COCO.local.md': 'Local. @mine.md\n', 'mine.md': 'Mine.\n' });
    const scopes = Object.fromEntries(loadMemory(root, true).map((f) => [path.basename(f.path), f.scope]));
    assert.deepEqual(scopes, { 'COCO.md': 'user', 'extra.md': 'user', 'COCO.local.md': 'local', 'mine.md': 'local' });
  });

  test('home-relative and absolute imports', () => {
    const abs = path.join(root, 'elsewhere', 'abs.md');
    writeFiles(root, { 'home/notes.md': 'Home notes.\n', 'elsewhere/abs.md': 'Absolute.\n', 'COCO.md': `Mine. @~/notes.md and @${abs}\n` });
    assert.deepEqual(rel(loadMemory(root, true)), ['COCO.md', path.join('home', 'notes.md'), path.join('elsewhere', 'abs.md')]);
  });

  test('nested imports stop at the depth limit', () => {
    const files: Record<string, string> = { 'COCO.md': 'level 0 @chain/l1.md' };
    for (let i = 1; i <= 8; i++) files[`chain/l${i}.md`] = `level ${i} @l${i + 1}.md`;
    writeFiles(root, files);
    const loaded = rel(loadMemory(root, true));
    // The root file is depth 0; five levels of imports are followed.
    assert.deepEqual(loaded, ['COCO.md', ...[1, 2, 3, 4, 5].map((i) => path.join('chain', `l${i}.md`))]);
  });

  test('import cycles terminate', () => {
    writeFiles(root, { 'COCO.md': 'A @b.md', 'b.md': 'B @c.md', 'c.md': 'C @COCO.md @b.md' });
    assert.deepEqual(rel(loadMemory(root, true)), ['COCO.md', 'b.md', 'c.md']);
  });

  test('a file that imports itself is loaded once', () => {
    writeFiles(root, { 'COCO.md': 'Self @COCO.md @./COCO.md' });
    assert.equal(loadMemory(root, true).length, 1);
  });

  test('missing files, directories and code references are not imported', () => {
    writeFiles(root, {
      'COCO.md': ['@missing/file.md', '@docs/', '@docs', 'Install `@types/node.d.ts`', '```', '@fenced.md', '```', '@present.md'].join('\n'),
      'docs/x.md': 'x',
      'fenced.md': 'should not load',
      'present.md': 'present',
    });
    assert.deepEqual(rel(loadMemory(root, true)), ['COCO.md', 'present.md']);
  });

  test('mentions of people are left alone even when a file has that name', () => {
    writeFiles(root, { 'COCO.md': 'Ask @alice about deploys.', alice: 'not instructions' });
    assert.deepEqual(rel(loadMemory(root, true)), ['COCO.md']);
  });

  test('an import with a trailing full stop still resolves', () => {
    writeFiles(root, { 'COCO.md': 'Conventions are in @docs/conventions.md.', 'docs/conventions.md': 'Conventions.' });
    assert.deepEqual(rel(loadMemory(root, true)), ['COCO.md', path.join('docs', 'conventions.md')]);
  });

  test('oversized files are truncated', () => {
    writeFiles(root, { 'COCO.md': 'x'.repeat(50_000) });
    const [file] = loadMemory(root, true);
    assert.ok(file!.content.length < 41_000);
    assert.ok(file!.content.startsWith('xxxx'));
    assert.match(file!.content, /truncated\]$/);
  });

  test('the same file reached twice is loaded once', () => {
    writeFiles(root, { 'COCO.md': 'Root @shared.md', 'AGENTS.md': 'Agents @shared.md', 'shared.md': 'Shared.' });
    assert.deepEqual(rel(loadMemory(root, true)), ['COCO.md', 'shared.md', 'AGENTS.md']);
  });
});

describe('renderMemory', () => {
  test('empty when there is nothing', () => {
    assert.equal(renderMemory([]), '');
  });

  test('wraps each file with its source and kind, in order', () => {
    const text = renderMemory([
      { path: '/home/u/.coco/COCO.md', scope: 'user', content: '  Be brief.  \n' },
      { path: '/repo/COCO.md', scope: 'project', content: 'Use pnpm.' },
      { path: '/repo/COCO.local.md', scope: 'local', content: 'My sandbox.' },
    ]);
    assert.match(text, /^# Instructions from the user\n/);
    assert.ok(text.includes('<instructions source="/home/u/.coco/COCO.md" kind="user instructions">\nBe brief.\n</instructions>'));
    assert.ok(text.includes('<instructions source="/repo/COCO.md" kind="project instructions">\nUse pnpm.\n</instructions>'));
    assert.ok(text.includes('kind="local project instructions">\nMy sandbox.\n</instructions>'));
    assert.ok(text.indexOf('Be brief.') < text.indexOf('Use pnpm.'));
    assert.ok(text.indexOf('Use pnpm.') < text.indexOf('My sandbox.'));
  });
});

describe('appendMemory / memoryTargets', () => {
  test('creates the file and its directory', () => {
    const file = path.join(root, 'new', 'dir', 'COCO.md');
    appendMemory(file, '  always run the linter  ');
    assert.equal(fs.readFileSync(file, 'utf8'), '- always run the linter\n');
  });

  test('appends after existing content, adding a newline when one is missing', () => {
    const file = path.join(root, 'COCO.md');
    fs.writeFileSync(file, '# Project\n\n- first');
    appendMemory(file, 'second');
    appendMemory(file, 'third');
    assert.equal(fs.readFileSync(file, 'utf8'), '# Project\n\n- first\n- second\n- third\n');
  });

  test('an appended note is picked up by the next load', () => {
    const targets = memoryTargets(root);
    appendMemory(targets.project, 'use tabs');
    appendMemory(targets.local, 'my local note');
    appendMemory(targets.user, 'be concise');
    const files = loadMemory(root, true);
    assert.deepEqual(
      files.map((f) => [f.scope, f.content]),
      [
        ['user', '- be concise\n'],
        ['project', '- use tabs\n'],
        ['local', '- my local note\n'],
      ],
    );
  });

  test('targets point at the project root, not the current subdirectory', () => {
    writeFiles(root, { 'pkg/src/x.ts': '' });
    const targets = memoryTargets(path.join(root, 'pkg', 'src'));
    assert.deepEqual(targets, {
      user: path.join(root, '.coco-home', 'COCO.md'),
      project: path.join(root, 'COCO.md'),
      local: path.join(root, 'COCO.local.md'),
    });
  });
});
