import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { MemoryFile } from '../src/memory/memory.ts';
import { appendMemory, findImports, loadMemory, loadedPaths, memoryTargets, onDemandInstructions, renderMemory, renderOnDemand } from '../src/memory/memory.ts';
import { tempProject, writeFiles } from './helpers.ts';

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = tempProject();
  // A .git marker makes the temp directory the project root.
  fs.mkdirSync(path.join(root, '.git'));
  savedHome = process.env.HOME;
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

/** Paths relative to the temp project, for readable assertions. */
function rel(files: { path: string }[]): string[] {
  return files.map((f) => path.relative(root, f.path));
}

/**
 * `loadMemory`, without whatever the machine running the tests keeps above
 * the temp directory: the walk goes up to the filesystem root, and a stray
 * /tmp/CLAUDE.md is not part of any test.
 */
function load(cwd: string, claudeCompat: boolean, excludes?: string[]): MemoryFile[] {
  return loadMemory(cwd, claudeCompat, excludes).filter((f) => !path.relative(root, f.path).startsWith('..'));
}

/** A slash-separated path in the platform's spelling. */
function p(slashed: string): string {
  return slashed.split('/').join(path.sep);
}

function contents(files: MemoryFile[]): string[] {
  return files.map((f) => f.content);
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
    assert.deepEqual(load(root, true), []);
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
    const files = load(path.join(root, 'pkg', 'app'), true);
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
    const files = load(root, true);
    assert.deepEqual(rel(files), ['COCO.md', path.join('.coco', 'COCO.md'), 'AGENTS.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'COCO.local.md', 'CLAUDE.local.md']);
    assert.deepEqual(
      files.map((f) => f.scope),
      ['project', 'project', 'project', 'project', 'project', 'local', 'local'],
    );
  });

  test('a parent directory local file still precedes the child directory', () => {
    writeFiles(root, { 'COCO.local.md': 'root local', 'sub/COCO.md': 'sub project' });
    assert.deepEqual(rel(load(path.join(root, 'sub'), true)), ['COCO.local.md', path.join('sub', 'COCO.md')]);
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
    assert.deepEqual(rel(load(root, false)), ['COCO.md', 'AGENTS.md']);
  });

  test('directories above the project root are read too, outermost first', () => {
    writeFiles(root, {
      'COCO.md': 'two levels above the repo',
      'outer/COCO.md': 'above the repo',
      'outer/COCO.local.md': 'above the repo, local',
      'outer/sibling/COCO.md': 'not an ancestor',
      'outer/repo/.git/HEAD': 'x',
      'outer/repo/COCO.md': 'inside',
      'outer/repo/src/x.ts': '',
    });
    assert.deepEqual(rel(load(path.join(root, 'outer', 'repo', 'src'), true)), ['COCO.md', p('outer/COCO.md'), p('outer/COCO.local.md'), p('outer/repo/COCO.md')]);
  });

  test('user files and rules, then parents, then the project root with its rules, then the working directory', () => {
    writeFiles(root, {
      '.coco-home/COCO.md': 'user coco',
      '.coco-home/rules/style.md': 'user rule',
      'home/.claude/CLAUDE.md': 'user claude',
      'home/.claude/rules/git.md': 'user claude rule',
      'COCO.md': 'above the repo',
      'COCO.local.md': 'above the repo, local',
      'repo/.git/HEAD': 'x',
      'repo/CLAUDE.md': 'repo',
      'repo/.coco/rules/a.md': 'repo rule a',
      'repo/.claude/rules/b.md': 'repo rule b',
      'repo/CLAUDE.local.md': 'repo local',
      'repo/pkg/COCO.md': 'pkg',
      'repo/pkg/app/AGENTS.md': 'app',
      'repo/pkg/app/COCO.local.md': 'app local',
    });
    const files = load(path.join(root, 'repo', 'pkg', 'app'), true);
    assert.deepEqual(
      files.map((f) => [f.scope, f.content]),
      [
        ['user', 'user coco'],
        ['user', 'user claude'],
        ['user', 'user rule'],
        ['user', 'user claude rule'],
        ['project', 'above the repo'],
        ['local', 'above the repo, local'],
        ['project', 'repo'],
        ['project', 'repo rule a'],
        ['project', 'repo rule b'],
        ['local', 'repo local'],
        ['project', 'pkg'],
        ['project', 'app'],
        ['local', 'app local'],
      ],
    );
  });

  test('the user file is not loaded a second time when the walk passes the home directory', () => {
    // ~/.coco/COCO.md is both the user file and a candidate of the directory "~".
    process.env.COCO_CONFIG_DIR = path.join(home, '.coco');
    writeFiles(root, { 'home/.coco/COCO.md': 'user', 'home/.claude/CLAUDE.md': 'user claude', 'home/work/.git/HEAD': 'x', 'home/work/COCO.md': 'work' });
    const files = load(path.join(home, 'work'), true);
    assert.deepEqual(
      files.map((f) => [f.scope, f.content]),
      [
        ['user', 'user'],
        ['user', 'user claude'],
        ['project', 'work'],
      ],
    );
  });

  test('empty and whitespace-only files are skipped', () => {
    writeFiles(root, { 'COCO.md': '', 'AGENTS.md': '  \n\n', 'CLAUDE.md': 'real' });
    assert.deepEqual(rel(load(root, true)), ['CLAUDE.md']);
  });

  test('identical content is loaded once', () => {
    writeFiles(root, { 'AGENTS.md': 'Same rules.\n', 'CLAUDE.md': 'Same rules.\n', 'COCO.md': 'Different.\n' });
    assert.deepEqual(rel(load(root, true)), ['COCO.md', 'AGENTS.md']);
  });

  test('a symlink to another memory file is loaded once', { skip: process.platform === 'win32' }, () => {
    writeFiles(root, { 'AGENTS.md': 'Shared rules.\n' });
    fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
    fs.symlinkSync('AGENTS.md', path.join(root, 'COCO.md'));
    const files = load(root, true);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.content, 'Shared rules.\n');
  });

  test('a directory named like a memory file is ignored', () => {
    fs.mkdirSync(path.join(root, 'COCO.md'));
    writeFiles(root, { 'AGENTS.md': 'ok' });
    assert.deepEqual(rel(load(root, true)), ['AGENTS.md']);
  });

  test('imports are resolved relative to the importing file and follow it in order', () => {
    writeFiles(root, {
      'COCO.md': 'Root rules.\nSee @docs/style.md and @docs/api/errors.md\n',
      'docs/style.md': 'Style guide. Also @api/naming.md\n',
      'docs/api/naming.md': 'Naming.\n',
      'docs/api/errors.md': 'Errors.\n',
      'AGENTS.md': 'Agents.\n',
    });
    const files = load(root, true);
    assert.deepEqual(rel(files), ['COCO.md', path.join('docs', 'style.md'), path.join('docs', 'api', 'naming.md'), path.join('docs', 'api', 'errors.md'), 'AGENTS.md']);
    assert.equal(files[1]!.importedBy, path.join(root, 'COCO.md'));
    assert.equal(files[2]!.importedBy, path.join(root, 'docs', 'style.md'));
    assert.equal(files[0]!.importedBy, undefined);
    assert.ok(files.every((f) => f.scope === 'project'));
  });

  test('imports inherit the scope of the importing file', () => {
    writeFiles(root, { '.coco-home/COCO.md': 'User. @extra.md\n', '.coco-home/extra.md': 'Extra.\n', 'COCO.local.md': 'Local. @mine.md\n', 'mine.md': 'Mine.\n' });
    const scopes = Object.fromEntries(load(root, true).map((f) => [path.basename(f.path), f.scope]));
    assert.deepEqual(scopes, { 'COCO.md': 'user', 'extra.md': 'user', 'COCO.local.md': 'local', 'mine.md': 'local' });
  });

  test('home-relative and absolute imports', () => {
    const abs = path.join(root, 'elsewhere', 'abs.md');
    writeFiles(root, { 'home/notes.md': 'Home notes.\n', 'elsewhere/abs.md': 'Absolute.\n', 'COCO.md': `Mine. @~/notes.md and @${abs}\n` });
    assert.deepEqual(rel(load(root, true)), ['COCO.md', path.join('home', 'notes.md'), path.join('elsewhere', 'abs.md')]);
  });

  test('nested imports stop at the depth limit', () => {
    const files: Record<string, string> = { 'COCO.md': 'level 0 @chain/l1.md' };
    for (let i = 1; i <= 8; i++) files[`chain/l${i}.md`] = `level ${i} @l${i + 1}.md`;
    writeFiles(root, files);
    const loaded = rel(load(root, true));
    // The root file is depth 0; five levels of imports are followed.
    assert.deepEqual(loaded, ['COCO.md', ...[1, 2, 3, 4, 5].map((i) => path.join('chain', `l${i}.md`))]);
  });

  test('import cycles terminate', () => {
    writeFiles(root, { 'COCO.md': 'A @b.md', 'b.md': 'B @c.md', 'c.md': 'C @COCO.md @b.md' });
    assert.deepEqual(rel(load(root, true)), ['COCO.md', 'b.md', 'c.md']);
  });

  test('a file that imports itself is loaded once', () => {
    writeFiles(root, { 'COCO.md': 'Self @COCO.md @./COCO.md' });
    assert.equal(load(root, true).length, 1);
  });

  test('missing files, directories and code references are not imported', () => {
    writeFiles(root, {
      'COCO.md': ['@missing/file.md', '@docs/', '@docs', 'Install `@types/node.d.ts`', '```', '@fenced.md', '```', '@present.md'].join('\n'),
      'docs/x.md': 'x',
      'fenced.md': 'should not load',
      'present.md': 'present',
    });
    assert.deepEqual(rel(load(root, true)), ['COCO.md', 'present.md']);
  });

  test('mentions of people are left alone even when a file has that name', () => {
    writeFiles(root, { 'COCO.md': 'Ask @alice about deploys.', alice: 'not instructions' });
    assert.deepEqual(rel(load(root, true)), ['COCO.md']);
  });

  test('an import with a trailing full stop still resolves', () => {
    writeFiles(root, { 'COCO.md': 'Conventions are in @docs/conventions.md.', 'docs/conventions.md': 'Conventions.' });
    assert.deepEqual(rel(load(root, true)), ['COCO.md', path.join('docs', 'conventions.md')]);
  });

  test('oversized files are truncated', () => {
    writeFiles(root, { 'COCO.md': 'x'.repeat(50_000) });
    const [file] = load(root, true);
    assert.ok(file!.content.length < 41_000);
    assert.ok(file!.content.startsWith('xxxx'));
    assert.match(file!.content, /truncated\]$/);
  });

  test('the same file reached twice is loaded once', () => {
    writeFiles(root, { 'COCO.md': 'Root @shared.md', 'AGENTS.md': 'Agents @shared.md', 'shared.md': 'Shared.' });
    assert.deepEqual(rel(load(root, true)), ['COCO.md', 'shared.md', 'AGENTS.md']);
  });
});

describe('rules directories', () => {
  test('every markdown file below rules/ loads, sorted by path, .coco before .claude', () => {
    writeFiles(root, {
      '.coco/rules/testing.md': 'testing',
      '.coco/rules/api/v2/naming.md': 'naming',
      '.coco/rules/api/errors.md': 'errors',
      '.coco/rules/build.md': 'build',
      '.coco/rules/notes.txt': 'not markdown',
      '.coco/rules/api/schema.json': '{}',
      '.claude/rules/a.md': 'claude a',
    });
    assert.deepEqual(rel(load(root, true)), [
      p('.coco/rules/api/errors.md'),
      p('.coco/rules/api/v2/naming.md'),
      p('.coco/rules/build.md'),
      p('.coco/rules/testing.md'),
      p('.claude/rules/a.md'),
    ]);
  });

  test('user rules come from both config directories and have user scope', () => {
    writeFiles(root, {
      '.coco-home/rules/z.md': 'coco user rule',
      '.coco-home/rules/deep/er/a.md': 'deep user rule',
      'home/.claude/rules/a.md': 'claude user rule',
      'COCO.md': 'project',
    });
    const files = load(root, true);
    assert.deepEqual(
      files.map((f) => [f.scope, f.content]),
      [
        ['user', 'deep user rule'],
        ['user', 'coco user rule'],
        ['user', 'claude user rule'],
        ['project', 'project'],
      ],
    );
  });

  test('only the project root has a rules directory', () => {
    writeFiles(root, { '.coco/rules/r.md': 'root rule', 'pkg/.coco/rules/x.md': 'rules of a subdirectory', 'pkg/COCO.md': 'pkg' });
    assert.deepEqual(rel(load(path.join(root, 'pkg'), true)), [p('.coco/rules/r.md'), p('pkg/COCO.md')]);
  });

  test('front matter is not part of the loaded content', () => {
    writeFiles(root, { '.coco/rules/style.md': '---\ndescription: House style\n---\nUse tabs.\n' });
    const [file] = load(root, true);
    assert.equal(file!.content, 'Use tabs.\n');
    assert.equal(file!.paths, undefined);
    assert.ok(!renderMemory([file!]).includes('description'));
  });

  test('a rule scoped to paths is not loaded at launch, however the list is written', () => {
    writeFiles(root, {
      '.coco/rules/always.md': 'always',
      '.coco/rules/scalar.md': '---\npaths: src/**/*.ts\n---\nscalar',
      '.coco/rules/quoted.md': '---\npaths: "src/**/*.ts"\n---\nquoted',
      '.coco/rules/inline.md': '---\npaths: ["src/**/*.ts", "lib/**"]\n---\ninline',
      '.coco/rules/block.md': '---\npaths:\n  - "src/**/*.ts"\n  - lib/**\n---\nblock',
      '.claude/rules/claude-scoped.md': '---\npaths: docs/**\n---\nclaude scoped',
      '.coco-home/rules/user-scoped.md': '---\npaths: "*.sql"\n---\nuser scoped',
      'home/.claude/rules/user-scoped.md': '---\npaths: "*.py"\n---\nuser claude scoped',
    });
    assert.deepEqual(contents(load(root, true)), ['always']);
  });

  test('an empty paths key does not scope the rule', () => {
    writeFiles(root, { '.coco/rules/a.md': '---\npaths:\n---\nEverywhere.', '.coco/rules/b.md': '---\npaths: []\n---\nAlso everywhere.' });
    assert.deepEqual(contents(load(root, true)), ['Everywhere.', 'Also everywhere.']);
  });

  test('malformed front matter is read as text and never throws', () => {
    const open = '---\npaths: src/**\nThe block is never closed.\n';
    const prose = '---\nA horizontal rule, then prose.\n---\nBody.\n';
    writeFiles(root, { '.coco/rules/open.md': open, '.coco/rules/prose.md': prose, '.coco/rules/only.md': '---\npaths: src/**\n---\n', '.coco/rules/empty.md': '' });
    assert.deepEqual(contents(load(root, true)), [open, prose]);
  });

  test('a rules file that cannot be read is skipped', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    writeFiles(root, { '.coco/rules/a.md': 'readable', '.coco/rules/b.md': 'unreadable' });
    fs.chmodSync(path.join(root, '.coco', 'rules', 'b.md'), 0o000);
    assert.deepEqual(contents(load(root, true)), ['readable']);
  });

  test('a directory named like a rule and a rules path that is a file are ignored', () => {
    writeFiles(root, { '.coco/rules/dir.md/inner.md': 'inside a directory', '.claude/rules': 'a file, not a directory' });
    assert.deepEqual(rel(load(root, true)), [p('.coco/rules/dir.md/inner.md')]);
  });

  test('symlinks are followed and a link back up does not loop', { skip: process.platform === 'win32' }, () => {
    writeFiles(root, { 'shared/security.md': 'shared rule', 'shared/more/extra.md': 'extra rule', '.coco/rules/own.md': 'own rule' });
    const rules = path.join(root, '.coco', 'rules');
    fs.symlinkSync(path.join(root, 'shared', 'security.md'), path.join(rules, 'security.md'));
    fs.symlinkSync(path.join(root, 'shared', 'more'), path.join(rules, 'more'));
    fs.symlinkSync(rules, path.join(rules, 'loop'));
    fs.symlinkSync(path.join(root, 'nowhere.md'), path.join(rules, 'dangling.md'));
    assert.deepEqual(rel(load(root, true)), [p('.coco/rules/more/extra.md'), p('.coco/rules/own.md'), p('.coco/rules/security.md')]);
  });

  test('a rule can import other files', () => {
    writeFiles(root, { '.coco/rules/api.md': '---\ndescription: API\n---\nSee @../../docs/api.md\n', 'docs/api.md': 'API guide.' });
    const files = load(root, true);
    assert.deepEqual(rel(files), [p('.coco/rules/api.md'), p('docs/api.md')]);
    assert.equal(files[1]!.importedBy, path.join(root, '.coco', 'rules', 'api.md'));
  });

  test('a rule with the same text as an instruction file is loaded once', () => {
    writeFiles(root, { 'COCO.md': 'Use tabs.', '.coco/rules/tabs.md': 'Use tabs.', '.claude/rules/tabs.md': '---\ndescription: x\n---\nUse tabs.' });
    assert.deepEqual(rel(load(root, true)), ['COCO.md']);
  });
});

describe('excludes', () => {
  /** The temp project as the start of an absolute glob. */
  const abs = (slashed: string) => `${root.split(path.sep).join('/')}/${slashed}`;

  beforeEach(() => {
    writeFiles(root, {
      '.coco-home/COCO.md': 'user',
      'COCO.md': 'root',
      'COCO.local.md': 'root local',
      '.coco/rules/a.md': 'rule a',
      '.coco/rules/team/b.md': 'rule b',
      'pkg/COCO.md': 'pkg',
      'pkg/AGENTS.md': 'pkg agents',
    });
  });

  const all = ['user', 'root', 'rule a', 'rule b', 'root local', 'pkg', 'pkg agents'];
  const without = (...skipped: string[]) => all.filter((c) => !skipped.includes(c));
  const launch = (excludes?: string[]) => contents(load(path.join(root, 'pkg'), true, excludes));

  test('no patterns, nothing skipped', () => {
    assert.deepEqual(launch(), all);
    assert.deepEqual(launch([]), all);
  });

  test('globs are matched against the absolute path', () => {
    assert.deepEqual(launch([abs('pkg/COCO.md')]), without('pkg'));
    assert.deepEqual(launch(['**/pkg/*.md']), without('pkg', 'pkg agents'));
    assert.deepEqual(launch(['**/.coco/rules/team/**']), without('rule b'));
    assert.deepEqual(launch([abs('.coco/rules/**')]), without('rule a', 'rule b'));
    assert.deepEqual(launch([abs('{COCO,COCO.local}.md'), '**/.coco-home/COCO.md']), without('user', 'root', 'root local'));
    assert.deepEqual(launch([abs('pkg/')]), without('pkg', 'pkg agents'));
  });

  test('a pattern without a slash is matched against the file name', () => {
    assert.deepEqual(launch(['AGENTS.md']), without('pkg agents'));
    assert.deepEqual(launch(['COCO.md']), without('user', 'root', 'pkg'));
    assert.deepEqual(launch(['*.local.md']), without('root local'));
    assert.deepEqual(launch(['?.md']), without('rule a', 'rule b'));
  });

  test('a relative pattern with a slash matches nothing, because paths are absolute', () => {
    assert.deepEqual(launch(['pkg/COCO.md', 'rules/a.md']), all);
  });

  test('excluded files are not imported either', () => {
    writeFiles(root, { 'COCO.md': 'root @docs/a.md @docs/secret.md', 'docs/a.md': 'a @secret.md', 'docs/secret.md': 'secret' });
    assert.deepEqual(rel(load(root, true, ['**/docs/secret.md'])).slice(1, 3), ['COCO.md', p('docs/a.md')]);
    assert.ok(!contents(load(root, true, ['secret.md'])).includes('secret'));
    assert.ok(contents(load(root, true)).includes('secret'));
  });

  test('a file reached through a link is skipped when either of its paths matches', { skip: process.platform === 'win32' }, () => {
    writeFiles(root, { 'shared/team.md': 'team rule' });
    fs.symlinkSync(path.join(root, 'shared', 'team.md'), path.join(root, '.coco', 'rules', 'linked.md'));
    assert.ok(contents(load(root, true)).includes('team rule'));
    assert.ok(!contents(load(root, true, ['**/shared/**'])).includes('team rule'));
    assert.ok(!contents(load(root, true, ['linked.md'])).includes('team rule'));
  });

  test('patterns that are not usable are ignored', () => {
    assert.deepEqual(launch(['[z-a]', '', '   ', 42 as unknown as string]), all);
    assert.deepEqual(launch('COCO.md' as unknown as string[]), all);
  });
});

describe('onDemandInstructions', () => {
  /** A session: what was loaded at launch, and a way to touch files afterwards. */
  function session(cwd: string, claudeCompat = true, excludes?: string[]) {
    const launch = load(cwd, claudeCompat, excludes);
    const loaded = loadedPaths(launch);
    return {
      launch,
      loaded,
      touch: (file: string) => onDemandInstructions(cwd, path.resolve(cwd, p(file)), claudeCompat, loaded, excludes),
    };
  }

  test('nothing to add for a file in the working directory', () => {
    writeFiles(root, { 'COCO.md': 'root', 'x.ts': '' });
    const s = session(root);
    assert.deepEqual(s.touch('x.ts'), []);
    assert.deepEqual(s.touch('missing.ts'), []);
  });

  test('instruction files of the directories leading to the file, outermost first', () => {
    writeFiles(root, {
      'COCO.md': 'root',
      'pkg/COCO.md': 'pkg',
      'pkg/app/CLAUDE.md': 'app',
      'pkg/app/CLAUDE.local.md': 'app local',
      'pkg/app/.claude/CLAUDE.md': 'app dot claude',
      'pkg/app/src/AGENTS.md': 'src',
      'pkg/app/src/deeper/COCO.md': 'below the file',
      'pkg/other/COCO.md': 'beside the path',
      'pkg/app/src/x.ts': '',
    });
    const s = session(root);
    const files = s.touch('pkg/app/src/x.ts');
    assert.deepEqual(rel(files), [p('pkg/COCO.md'), p('pkg/app/CLAUDE.md'), p('pkg/app/.claude/CLAUDE.md'), p('pkg/app/CLAUDE.local.md'), p('pkg/app/src/AGENTS.md')]);
    assert.deepEqual(
      files.map((f) => f.scope),
      ['project', 'project', 'project', 'local', 'project'],
    );
  });

  test('each file is delivered once per session', () => {
    writeFiles(root, { 'pkg/COCO.md': 'pkg', 'pkg/app/COCO.md': 'app', 'pkg/lib/COCO.md': 'lib' });
    const s = session(root);
    assert.deepEqual(contents(s.touch('pkg/a.ts')), ['pkg']);
    assert.deepEqual(contents(s.touch('pkg/a.ts')), []);
    assert.deepEqual(contents(s.touch('pkg/app/b.ts')), ['app']);
    assert.deepEqual(contents(s.touch('pkg/lib/deep/c.ts')), ['lib']);
    assert.deepEqual(contents(s.touch('pkg/app/b.ts')), []);
    for (const dir of ['pkg', p('pkg/app'), p('pkg/lib')]) assert.ok(s.loaded.has(path.join(root, dir, 'COCO.md')));
  });

  test('files loaded at launch are not delivered again', () => {
    writeFiles(root, { 'COCO.md': 'root', 'pkg/COCO.md': 'pkg', 'pkg/app/COCO.md': 'app', 'pkg/app/src/COCO.md': 'src' });
    const cwd = path.join(root, 'pkg');
    const launch = load(cwd, true);
    assert.deepEqual(contents(launch), ['root', 'pkg']);
    const loaded = loadedPaths(launch);
    assert.deepEqual(contents(onDemandInstructions(cwd, path.join(cwd, 'app', 'src', 'x.ts'), true, loaded)), ['app', 'src']);
    // Without the launch set nothing above the working directory is offered either: only directories below it count.
    assert.deepEqual(contents(onDemandInstructions(cwd, path.join(cwd, 'app', 'src', 'x.ts'), true, new Set())), ['app', 'src']);
  });

  test('imports of a nested file follow it, unless they were loaded before', () => {
    writeFiles(root, {
      'COCO.md': 'root @docs/shared.md',
      'docs/shared.md': 'shared',
      'pkg/COCO.md': 'pkg @../docs/shared.md @notes.md',
      'pkg/notes.md': 'notes',
    });
    const s = session(root);
    const files = s.touch('pkg/x.ts');
    assert.deepEqual(rel(files), [p('pkg/COCO.md'), p('pkg/notes.md')]);
    assert.equal(files[1]!.importedBy, path.join(root, 'pkg', 'COCO.md'));
  });

  test('copies in one directory are delivered once, also on a later touch', () => {
    writeFiles(root, { 'pkg/AGENTS.md': 'Same.', 'pkg/CLAUDE.md': 'Same.', 'pkg/empty/COCO.md': '  \n' });
    const s = session(root);
    assert.deepEqual(rel(s.touch('pkg/empty/a.ts')), [p('pkg/AGENTS.md')]);
    assert.deepEqual(s.touch('pkg/b.ts'), []);
  });

  test('touching an instruction file does not echo it, but the next file there brings it in', () => {
    writeFiles(root, { 'pkg/COCO.md': 'pkg', 'pkg/sub/COCO.md': 'sub' });
    const s = session(root);
    assert.deepEqual(contents(s.touch('pkg/sub/COCO.md')), ['pkg']);
    assert.deepEqual(contents(s.touch('pkg/sub/x.ts')), ['sub']);
  });

  test('a rule scoped to paths arrives with the first matching file, exactly once', () => {
    writeFiles(root, {
      '.coco/rules/ts.md': '---\npaths:\n  - "src/**/*.ts"\n---\nTypeScript rule.\n',
      '.claude/rules/docs.md': '---\npaths: docs/**\n---\nDocs rule.',
      '.coco/rules/always.md': 'Always.',
    });
    const s = session(root);
    assert.deepEqual(contents(s.launch), ['Always.']);
    assert.deepEqual(s.touch('lib/a.ts'), []);
    assert.deepEqual(s.touch('src/a.js'), []);
    const files = s.touch('src/deep/er/a.ts');
    assert.deepEqual(files, [{ path: path.join(root, '.coco', 'rules', 'ts.md'), scope: 'project', content: 'TypeScript rule.\n', importedBy: undefined, paths: ['src/**/*.ts'] }]);
    assert.deepEqual(s.touch('src/b.ts'), []);
    assert.deepEqual(contents(s.touch('docs/guide.md')), ['Docs rule.']);
    assert.deepEqual(s.touch('docs/other.md'), []);
  });

  test('glob forms: **, *, ?, {a,b}, and a pattern without a slash at any depth', () => {
    const rule = (paths: string) => `---\npaths: ${paths}\n---\n${paths}`;
    writeFiles(root, {
      '.coco/rules/1.md': rule('"*.sql"'),
      '.coco/rules/2.md': rule('"src/*.ts"'),
      '.coco/rules/3.md': rule('"src/**/*.{tsx,jsx}"'),
      '.coco/rules/4.md': rule('"migrations/00?.sql"'),
      '.coco/rules/5.md': rule('"{api,web}/**"'),
      '.coco/rules/6.md': rule('"/README.md"'),
      '.coco/rules/7.md': rule('test/fixtures'),
      '.coco/rules/8.md': rule('"**/*.css, **/*.scss"'),
    });
    const matched = (file: string) => contents(session(root).touch(file));
    assert.deepEqual(matched('schema.sql'), ['"*.sql"']);
    assert.deepEqual(matched('db/old/schema.sql'), ['"*.sql"']);
    assert.deepEqual(matched('src/a.ts'), ['"src/*.ts"']);
    assert.deepEqual(matched('src/deep/a.ts'), []);
    assert.deepEqual(matched('src/App.tsx'), ['"src/**/*.{tsx,jsx}"']);
    assert.deepEqual(matched('src/ui/deep/App.jsx'), ['"src/**/*.{tsx,jsx}"']);
    assert.deepEqual(matched('migrations/001.sql'), ['"*.sql"', '"migrations/00?.sql"']);
    assert.deepEqual(matched('migrations/0010.sql'), ['"*.sql"']);
    assert.deepEqual(matched('web/index.html'), ['"{api,web}/**"']);
    assert.deepEqual(matched('website/index.html'), []);
    assert.deepEqual(matched('README.md'), ['"/README.md"']);
    assert.deepEqual(matched('docs/README.md'), []);
    assert.deepEqual(matched('test/fixtures/a/b.json'), ['test/fixtures']);
    assert.deepEqual(matched('a/b/c.scss'), ['"**/*.css, **/*.scss"']);
  });

  test('paths are relative to the project root, not to the working directory', () => {
    writeFiles(root, {
      '.coco/rules/api.md': '---\npaths: pkg/src/**\n---\nrooted at the project',
      '.coco/rules/wrong.md': '---\npaths: src/**\n---\nrooted at the working directory',
      'pkg/src/x.ts': '',
    });
    const cwd = path.join(root, 'pkg');
    assert.deepEqual(contents(onDemandInstructions(cwd, path.join(cwd, 'src', 'x.ts'), true, loadedPaths(load(cwd, true)))), ['rooted at the project']);
  });

  test('nested files come first, then user rules, then project rules', () => {
    writeFiles(root, {
      '.coco-home/rules/ts.md': '---\npaths: "*.ts"\n---\nuser rule',
      'home/.claude/rules/ts.md': '---\npaths: "*.ts"\n---\nuser claude rule',
      '.coco/rules/ts.md': '---\npaths: "*.ts"\n---\nproject rule',
      '.claude/rules/ts.md': '---\npaths: "*.ts"\n---\nproject claude rule',
      'pkg/COCO.md': 'pkg',
    });
    const files = session(root).touch('pkg/a.ts');
    assert.deepEqual(
      files.map((f) => [f.scope, f.content]),
      [
        ['project', 'pkg'],
        ['user', 'user rule'],
        ['user', 'user claude rule'],
        ['project', 'project rule'],
        ['project', 'project claude rule'],
      ],
    );
  });

  test('a file outside the working directory gets only matching user rules', () => {
    writeFiles(root, {
      '.coco-home/rules/sql.md': '---\npaths: "*.sql"\n---\nuser sql rule',
      '.coco-home/rules/ts.md': '---\npaths: "**/*.ts"\n---\nuser ts rule',
      'repo/.git/HEAD': 'x',
      'repo/.coco/rules/sql.md': '---\npaths: "**/*.sql"\n---\nproject sql rule',
      'repo/app/COCO.md': 'app',
      'repo/lib/COCO.md': 'lib, in the project but beside the working directory',
      'elsewhere/COCO.md': 'another project',
      'elsewhere/db/COCO.md': 'another project, nested',
    });
    const cwd = path.join(root, 'repo', 'app');
    const loaded = loadedPaths(load(cwd, true));
    const touch = (file: string) => contents(onDemandInstructions(cwd, path.join(root, p(file)), true, loaded));
    assert.deepEqual(touch('elsewhere/db/schema.sql'), ['user sql rule']);
    assert.deepEqual(touch('repo/lib/x.ts'), ['user ts rule']);
    assert.deepEqual(touch('repo/lib/y.sql'), []);
    // Inside the working directory the project rule applies as usual.
    assert.deepEqual(touch('repo/app/z.sql'), ['project sql rule']);
  });

  test('a path written with .. is judged by where it leads', () => {
    writeFiles(root, { 'repo/.git/HEAD': 'x', 'repo/pkg/COCO.md': 'pkg', 'outside/COCO.md': 'outside' });
    const cwd = path.join(root, 'repo');
    const loaded = new Set<string>();
    assert.deepEqual(onDemandInstructions(cwd, `${cwd}${path.sep}pkg${path.sep}..${path.sep}..${path.sep}outside${path.sep}x.ts`, true, loaded), []);
    assert.deepEqual(contents(onDemandInstructions(cwd, p('sub/../pkg/x.ts'), true, loaded)), ['pkg']);
  });

  test('the working directory reached through a link is still the working directory', { skip: process.platform === 'win32' }, () => {
    writeFiles(root, { 'real/.git/HEAD': 'x', 'real/pkg/COCO.md': 'pkg' });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    const viaLink = onDemandInstructions(path.join(root, 'real'), path.join(root, 'link', 'pkg', 'x.ts'), true, new Set());
    assert.deepEqual(rel(viaLink), [p('real/pkg/COCO.md')]);
  });

  test('with compat off no Claude name is read, at launch or later', () => {
    writeFiles(root, {
      'home/.claude/CLAUDE.md': 'user claude',
      'home/.claude/rules/r.md': 'user claude rule',
      'home/.claude/rules/scoped.md': '---\npaths: "*.ts"\n---\nuser claude scoped',
      'CLAUDE.md': 'parent claude',
      'CLAUDE.local.md': 'parent claude local',
      '.claude/CLAUDE.md': 'parent dot claude',
      'repo/.git/HEAD': 'x',
      'repo/CLAUDE.md': 'claude',
      'repo/.claude/CLAUDE.md': 'dot claude',
      'repo/CLAUDE.local.md': 'claude local',
      'repo/.claude/rules/r.md': 'claude rule',
      'repo/.claude/rules/scoped.md': '---\npaths: "*.ts"\n---\nclaude scoped',
      'repo/sub/CLAUDE.md': 'nested claude',
      'repo/sub/.claude/CLAUDE.md': 'nested dot claude',
      'repo/sub/CLAUDE.local.md': 'nested claude local',
      'repo/COCO.md': 'coco',
      'repo/.coco/rules/r.md': 'coco rule',
      'repo/.coco/rules/scoped.md': '---\npaths: "*.ts"\n---\ncoco scoped',
      'repo/sub/COCO.md': 'nested coco',
    });
    const off = session(path.join(root, 'repo'), false);
    assert.deepEqual(contents(off.launch), ['coco', 'coco rule']);
    assert.deepEqual(contents(off.touch('sub/x.ts')), ['nested coco', 'coco scoped']);

    const on = session(path.join(root, 'repo'), true);
    assert.deepEqual(contents(on.launch), [
      'user claude',
      'user claude rule',
      'parent claude',
      'parent dot claude',
      'parent claude local',
      'coco',
      'claude',
      'dot claude',
      'coco rule',
      'claude rule',
      'claude local',
    ]);
    assert.deepEqual(contents(on.touch('sub/x.ts')), ['nested coco', 'nested claude', 'nested dot claude', 'nested claude local', 'user claude scoped', 'coco scoped', 'claude scoped']);
  });

  test('excludes apply to nested files, their imports and scoped rules', () => {
    writeFiles(root, {
      'pkg/COCO.md': 'pkg\n@notes.md @private.md',
      'pkg/notes.md': 'notes',
      'pkg/private.md': 'private',
      'pkg/vendor/AGENTS.md': 'vendored',
      'pkg/vendor/lib/COCO.md': 'vendored lib',
      '.coco/rules/ts.md': '---\npaths: "*.ts"\n---\nts rule',
      '.coco/rules/legacy/ts.md': '---\npaths: "*.ts"\n---\nlegacy ts rule',
    });
    const firstLines = (files: MemoryFile[]) => files.map((f) => f.content.split('\n')[0]);
    const s = session(root, true, ['**/vendor/**', 'private.md', '**/rules/legacy/**']);
    assert.deepEqual(firstLines(s.touch('pkg/vendor/lib/x.ts')), ['pkg', 'notes', 'ts rule']);
    assert.deepEqual(firstLines(session(root).touch('pkg/vendor/lib/x.ts')), ['pkg', 'notes', 'private', 'vendored', 'vendored lib', 'legacy ts rule', 'ts rule']);
  });

  test('a rule with a pattern that is not a valid glob matches nothing and does not throw', () => {
    writeFiles(root, { '.coco/rules/bad.md': '---\npaths: "[z-a].ts"\n---\nbad', '.coco/rules/odd.md': '---\npaths: [unclosed\n---\nodd' });
    const s = session(root);
    assert.deepEqual(s.launch, []);
    assert.deepEqual(s.touch('src/a.ts'), []);
  });

  test('a relative file path is taken from the working directory', () => {
    writeFiles(root, { 'pkg/COCO.md': 'pkg' });
    assert.deepEqual(contents(onDemandInstructions(root, p('pkg/x.ts'), true, new Set())), ['pkg']);
  });
});

describe('loadedPaths', () => {
  test('holds the real path of every delivered file, imports included', { skip: process.platform === 'win32' }, () => {
    writeFiles(root, { 'docs/real.md': 'Real. @extra.md', 'docs/extra.md': 'Extra.' });
    fs.symlinkSync(path.join(root, 'docs', 'real.md'), path.join(root, 'COCO.md'));
    const files = load(root, true);
    assert.deepEqual(rel(files), ['COCO.md', p('docs/extra.md')]);
    assert.deepEqual([...loadedPaths(files)].sort(), [path.join(root, 'docs', 'extra.md'), path.join(root, 'docs', 'real.md')]);
  });

  test('empty for nothing, and tolerant of files that are gone', () => {
    assert.equal(loadedPaths([]).size, 0);
    const gone = path.join(root, 'gone.md');
    assert.deepEqual([...loadedPaths([{ path: gone, scope: 'project', content: 'x' }])], [gone]);
  });
});

describe('renderOnDemand', () => {
  test('empty when there is nothing', () => {
    assert.equal(renderOnDemand([]), '');
  });

  test('one line that says what it is, then each file tagged with its path', () => {
    const text = renderOnDemand([
      { path: '/repo/pkg/COCO.md', scope: 'project', content: '  Use pnpm here.\n' },
      { path: '/repo/pkg/COCO.local.md', scope: 'local', content: 'My sandbox.' },
      { path: '/home/u/.coco/rules/sql.md', scope: 'user', content: 'Upper-case keywords.', paths: ['*.sql', 'db/**'] },
    ]);
    const lines = text.split('\n');
    assert.equal(lines[0], '<loaded-instructions>');
    assert.match(lines[1]!, /^Instruction files for the part of the project you just touched\./);
    assert.match(lines[1]!, /not part of the tool output/);
    assert.equal(lines[2], '<instructions source="/repo/pkg/COCO.md" kind="project instructions">');
    assert.equal(lines.at(-1), '</loaded-instructions>');
    assert.ok(text.includes('<instructions source="/repo/pkg/COCO.md" kind="project instructions">\nUse pnpm here.\n</instructions>'));
    assert.ok(text.includes('<instructions source="/repo/pkg/COCO.local.md" kind="local project instructions">\nMy sandbox.\n</instructions>'));
    assert.ok(text.includes('<instructions source="/home/u/.coco/rules/sql.md" kind="user instructions" applies-to="*.sql, db/**">\nUpper-case keywords.\n</instructions>'));
    assert.ok(text.indexOf('Use pnpm here.') < text.indexOf('My sandbox.'));
    assert.ok(text.indexOf('My sandbox.') < text.indexOf('Upper-case keywords.'));
  });

  test('renders what a touched file brought in', () => {
    writeFiles(root, { 'pkg/COCO.md': 'Use pnpm here.', '.coco/rules/ts.md': '---\npaths: "*.ts"\n---\nNo default exports.' });
    const text = renderOnDemand(onDemandInstructions(root, path.join(root, 'pkg', 'a.ts'), true, new Set()));
    assert.ok(text.includes(`source="${path.join(root, 'pkg', 'COCO.md')}"`));
    assert.ok(text.includes('applies-to="*.ts">\nNo default exports.'));
    assert.ok(!text.includes('paths:'));
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
    const files = load(root, true);
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
