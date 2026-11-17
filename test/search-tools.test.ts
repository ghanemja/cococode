import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { agentTool, askUserTool, exitPlanModeTool, renderSkill, renderTodos, skillTool, todoWriteTool } from '../src/tools/meta.ts';
import { READ_ONLY_TOOLS, builtinTools, filterTools, toolSpecs } from '../src/tools/registry.ts';
import { comparePaths, globFiles, grepFiles, listProjectFiles, setRipgrep, walkFiles } from '../src/tools/search.ts';
import { globTool, grepTool } from '../src/tools/searchTools.ts';
import type { AskQuestion, RuntimeHandle, SubagentRequest, ToolContext } from '../src/tools/types.ts';
import { makeContext, tempProject, writeFiles } from './helpers.ts';

const hasRipgrep = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
/** Every assertion runs against the built-in search and, when installed, against ripgrep. */
const backends: [string, string | null][] = hasRipgrep
  ? [
      ['built-in search', null],
      ['ripgrep', 'rg'],
    ]
  : [['built-in search', null]];

after(() => setRipgrep(undefined));

function project(): { dir: string; ctx: ToolContext } {
  const dir = tempProject('coco-search-');
  writeFiles(dir, {
    'a.ts': 'const alpha = 1;\nconst Beta = 2;\n// TODO fix\n',
    'src/b.ts': 'export function alpha() {}\nlet x = 1;\nlet y = 2;\nTODO later\nlet z = 3;\n',
    'src/deep/c.ts': 'alpha\nbeta\ngamma\n',
    'src/deep/d.js': 'alpha in js\n',
    'src/e.py': 'def alpha():\n    pass\n',
    'docs/readme.md': '# Title\n\nalpha docs\n',
    '.hidden/h.ts': 'alpha hidden\n',
    '.env': 'ALPHA=1\n',
    'node_modules/pkg/index.ts': 'alpha in dep\n',
    '.git/config': 'alpha in git\n',
    'dist/out.ts': 'alpha built\n',
    'logs/a.log': 'alpha log\n',
    'logs/keep.log': 'alpha kept\n',
    'build/x.ts': 'alpha build\n',
    'src/build/y.ts': 'alpha nested build dir, not ignored\n',
    'src/gen/z.ts': 'alpha generated\n',
    'src/.gitignore': 'gen/\n',
    '.gitignore': '# build output\ndist/\n*.log\n!keep.log\n/build\n',
    'multi.txt': 'start\nfoo\nbar\nend\nfoo\nbaz\n',
    'crlf.txt': 'alpha one\r\nplain\r\n',
  });
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 97, 108, 112, 104, 97, 0]));
  fs.symlinkSync(path.join(dir, 'a.ts'), path.join(dir, 'link.ts'));
  // Distinct modification times, oldest first, so "most recent first" is well defined.
  const ordered = ['a.ts', 'src/b.ts', 'src/deep/c.ts', 'src/deep/d.js', 'src/e.py', 'docs/readme.md', '.hidden/h.ts', '.env', 'multi.txt', 'logs/keep.log', 'src/build/y.ts', 'crlf.txt', '.gitignore', 'src/.gitignore', 'bin.dat'];
  let t = Date.now() - 1_000_000;
  for (const f of ordered) {
    t += 10_000;
    fs.utimesSync(path.join(dir, f), new Date(t), new Date(t));
  }
  return { dir, ctx: makeContext(dir, {}) };
}

const results = new Map<string, Map<string, string>>();
/** Remember each backend's answer so that they can be compared at the end. */
function record(backend: string, key: string, value: string): string {
  if (!results.has(key)) results.set(key, new Map());
  results.get(key)!.set(backend, value);
  return value;
}

for (const [backend, rg] of backends) {
  describe(`Glob (${backend})`, () => {
    let dir: string;
    let ctx: ToolContext;
    before(() => {
      ({ dir, ctx } = project());
    });
    const glob = async (pattern: string, where?: string) => {
      setRipgrep(rg);
      const res = await globTool.execute({ pattern, path: where }, ctx);
      return record(backend, `glob ${pattern} ${where ?? ''}`, res.content);
    };

    test('*.ts matches at any depth, most recently modified first', async () => {
      assert.equal(await glob('*.ts'), 'src/build/y.ts\n.hidden/h.ts\nsrc/deep/c.ts\nsrc/b.ts\na.ts');
      assert.equal(await glob('**/*.ts'), 'src/build/y.ts\n.hidden/h.ts\nsrc/deep/c.ts\nsrc/b.ts\na.ts');
    });

    test('patterns with a directory part are anchored to the search root', async () => {
      assert.equal(await glob('src/**/*.ts'), 'src/build/y.ts\nsrc/deep/c.ts\nsrc/b.ts');
      assert.equal(await glob('src/*.ts'), 'src/b.ts');
      assert.equal(await glob('**/deep/*'), 'src/deep/d.js\nsrc/deep/c.ts');
      assert.equal(await glob('./src/*.py'), 'src/e.py');
    });

    test('brace patterns', async () => {
      assert.equal(await glob('*.{js,py}'), 'src/e.py\nsrc/deep/d.js');
      assert.equal(await glob('src/**/*.{ts,js}'), 'src/build/y.ts\nsrc/deep/d.js\nsrc/deep/c.ts\nsrc/b.ts');
    });

    test('.gitignore is respected: directory rules, globs, negation, anchoring and nested files', async () => {
      const all = (await glob('**/*')).split('\n');
      assert.deepEqual([...all].sort(), ['.env', '.gitignore', '.hidden/h.ts', 'a.ts', 'bin.dat', 'crlf.txt', 'docs/readme.md', 'logs/keep.log', 'multi.txt', 'src/.gitignore', 'src/b.ts', 'src/build/y.ts', 'src/deep/c.ts', 'src/deep/d.js', 'src/e.py']);
      // An explicit pattern does not reach into ignored places either.
      assert.equal(await glob('*.log'), 'logs/keep.log');
      assert.equal(await glob('dist/*.ts'), 'No files found.');
      assert.equal(await glob('build/*.ts'), 'No files found.');
      assert.equal(await glob('src/gen/*'), 'No files found.');
    });

    test('.git and node_modules are skipped, hidden files are found, symlinks are not listed', async () => {
      assert.equal(await glob('.git/*'), 'No files found.');
      assert.equal(await glob('node_modules/**'), 'No files found.');
      assert.equal(await glob('.env'), '.env');
      assert.equal(await glob('.hidden/*'), '.hidden/h.ts');
      assert.equal(await glob('link.ts'), 'No files found.');
    });

    test('a search directory: results are still relative to the working directory', async () => {
      assert.equal(await glob('*.ts', 'src'), 'src/build/y.ts\nsrc/deep/c.ts\nsrc/b.ts');
      assert.equal(await glob('*.ts', path.join(dir, 'src/deep')), 'src/deep/c.ts');
      // The project's .gitignore still applies when searching from a subdirectory.
      assert.equal(await glob('*', 'logs'), 'logs/keep.log');
    });

    test('an absolute pattern carries its own root', async () => {
      assert.equal(await glob(path.join(dir, 'src/**/*.py')), 'src/e.py');
      assert.equal(await glob(path.join(dir, 'docs/*.md')), 'docs/readme.md');
    });

    test('a directory outside the working directory gives absolute paths', async () => {
      const other = tempProject('coco-search-other-');
      writeFiles(other, { 'x/one.md': '1' });
      setRipgrep(rg);
      const res = await globTool.execute({ pattern: '*.md', path: other }, ctx);
      assert.equal(res.content, path.join(other, 'x/one.md'));
    });

    test('nothing found, a missing directory and a file given as the directory', async () => {
      assert.equal(await glob('*.zzz'), 'No files found.');
      setRipgrep(rg);
      const missing = await globTool.execute({ pattern: '*', path: 'nope' }, ctx);
      assert.equal(missing.isError, true);
      assert.match(missing.content, /Directory does not exist/);
      const notDir = await globTool.execute({ pattern: '*', path: 'a.ts' }, ctx);
      assert.equal(notDir.isError, true);
      assert.match(notDir.content, /is not a directory/);
    });

    test('at most 100 paths are shown, with a note about the rest', async () => {
      const big = tempProject('coco-search-big-');
      const files: Record<string, string> = {};
      for (let i = 0; i < 130; i++) files[`f/${String(i).padStart(3, '0')}.txt`] = '';
      writeFiles(big, files);
      setRipgrep(rg);
      const res = await globTool.execute({ pattern: '*.txt' }, makeContext(big, {}));
      const lines = res.content.split('\n');
      assert.equal(lines.filter((l) => l.endsWith('.txt')).length, 100);
      assert.equal(lines[lines.length - 1], '[30 more files not shown. Use a narrower pattern.]');
      assert.equal(res.summary, 'Found 130 files');
    });

    test('summary, label and permission', async () => {
      setRipgrep(rg);
      assert.equal((await globTool.execute({ pattern: 'src/*.ts' }, ctx)).summary, 'Found 1 file');
      assert.equal(globTool.label!({ pattern: '*.ts' }, ctx), '*.ts');
      assert.equal(globTool.label!({ pattern: '*.ts', path: 'src' }, ctx), '*.ts in src');
      assert.deepEqual(globTool.permission!({ pattern: '*', path: 'src' }, ctx), { tool: 'Read', kind: 'read', target: path.join(dir, 'src'), description: 'Search src' });
      assert.equal(globTool.isReadOnly({ pattern: '*' }), true);
    });
  });

  describe(`Grep (${backend})`, () => {
    let dir: string;
    let ctx: ToolContext;
    before(() => {
      ({ dir, ctx } = project());
    });
    const grep = async (input: Record<string, unknown>) => {
      setRipgrep(rg);
      const res = await grepTool.execute(input as never, ctx);
      return record(backend, `grep ${JSON.stringify(input)}`, res.content);
    };

    test('files_with_matches is the default, most recently modified first', async () => {
      assert.equal(await grep({ pattern: 'alpha' }), 'crlf.txt\nsrc/build/y.ts\nlogs/keep.log\n.hidden/h.ts\ndocs/readme.md\nsrc/e.py\nsrc/deep/d.js\nsrc/deep/c.ts\nsrc/b.ts\na.ts');
    });

    test('content mode shows path:line:text in path order', async () => {
      assert.equal(
        await grep({ pattern: 'alpha', output_mode: 'content' }),
        [
          '.hidden/h.ts:1:alpha hidden',
          'a.ts:1:const alpha = 1;',
          'crlf.txt:1:alpha one',
          'docs/readme.md:3:alpha docs',
          'logs/keep.log:1:alpha kept',
          'src/b.ts:1:export function alpha() {}',
          'src/build/y.ts:1:alpha nested build dir, not ignored',
          'src/deep/c.ts:1:alpha',
          'src/deep/d.js:1:alpha in js',
          'src/e.py:1:def alpha():',
        ].join('\n'),
      );
    });

    test('count mode', async () => {
      assert.equal(await grep({ pattern: 'let', output_mode: 'count' }), 'src/b.ts:3');
      assert.equal(await grep({ pattern: 'a', output_mode: 'count', path: 'src/deep' }), 'src/deep/c.ts:3\nsrc/deep/d.js:1');
    });

    test('ignored files, .git, node_modules and binary files are not searched', async () => {
      const files = (await grep({ pattern: 'alpha' })).split('\n');
      for (const skipped of ['dist/out.ts', 'logs/a.log', 'build/x.ts', 'src/gen/z.ts', 'node_modules/pkg/index.ts', '.git/config', 'bin.dat', 'link.ts']) {
        assert.ok(!files.includes(skipped), skipped);
      }
      // Hidden files are searched; the match is case-sensitive unless asked otherwise.
      assert.equal(await grep({ pattern: 'ALPHA', output_mode: 'content' }), '.env:1:ALPHA=1');
    });

    test('case-insensitive search', async () => {
      assert.equal(await grep({ pattern: 'beta', output_mode: 'content' }), 'src/deep/c.ts:2:beta');
      assert.equal(await grep({ pattern: 'beta', output_mode: 'content', case_insensitive: true }), 'a.ts:2:const Beta = 2;\nsrc/deep/c.ts:2:beta');
    });

    test('context lines, with -- between separate groups', async () => {
      assert.equal(
        await grep({ pattern: 'TODO', output_mode: 'content', context: 1 }),
        ['a.ts-2-const Beta = 2;', 'a.ts:3:// TODO fix', '--', 'src/b.ts-3-let y = 2;', 'src/b.ts:4:TODO later', 'src/b.ts-5-let z = 3;'].join('\n'),
      );
      // Overlapping context is merged, and there is no phantom line after the last one.
      assert.equal(
        await grep({ pattern: 'let', output_mode: 'content', context: 1, path: 'src/b.ts' }),
        ['src/b.ts-1-export function alpha() {}', 'src/b.ts:2:let x = 1;', 'src/b.ts:3:let y = 2;', 'src/b.ts-4-TODO later', 'src/b.ts:5:let z = 3;'].join('\n'),
      );
      assert.equal(await grep({ pattern: 'start|baz', output_mode: 'content', context: 1, path: 'multi.txt' }), 'multi.txt:1:start\nmulti.txt-2-foo\n--\nmulti.txt-5-foo\nmulti.txt:6:baz');
    });

    test('a glob limits which files are searched', async () => {
      assert.equal(await grep({ pattern: 'alpha', glob: '*.py' }), 'src/e.py');
      assert.equal(await grep({ pattern: 'alpha', glob: 'src/**/*.ts', output_mode: 'content' }), 'src/b.ts:1:export function alpha() {}\nsrc/build/y.ts:1:alpha nested build dir, not ignored\nsrc/deep/c.ts:1:alpha');
      assert.equal(await grep({ pattern: 'alpha', glob: '*.{js,md}', output_mode: 'count' }), 'docs/readme.md:1\nsrc/deep/d.js:1');
      // Naming an ignored file type in the glob does not un-ignore it.
      assert.equal(await grep({ pattern: 'alpha', glob: '*.log', output_mode: 'content' }), 'logs/keep.log:1:alpha kept');
      assert.equal(await grep({ pattern: 'alpha', glob: 'dist/*' }), 'No matches found.');
    });

    test('head_limit cuts the output and says how much is missing', async () => {
      assert.equal(await grep({ pattern: 'alpha', output_mode: 'content', head_limit: 2 }), '.hidden/h.ts:1:alpha hidden\na.ts:1:const alpha = 1;\n\n[8 more lines not shown. Narrow the pattern or raise head_limit.]');
    });

    test('multiline patterns span lines and show every line of the match', async () => {
      assert.equal(await grep({ pattern: 'foo\\nba', output_mode: 'content', multiline: true }), 'multi.txt:2:foo\nmulti.txt:3:bar\nmulti.txt:5:foo\nmulti.txt:6:baz');
      assert.equal(await grep({ pattern: 'foo\\nba', multiline: true }), 'multi.txt');
      // With multiline, a count is the number of matches, however many lines each spans.
      assert.equal(await grep({ pattern: 'start.*end', multiline: true, output_mode: 'count' }), 'multi.txt:1');
      assert.equal(await grep({ pattern: 'foo\\nba', multiline: true, output_mode: 'count' }), 'multi.txt:2');
      // A pattern that names a newline is allowed to cross lines without being told to...
      assert.equal(await grep({ pattern: 'foo\\nba', output_mode: 'content' }), 'multi.txt:2:foo\nmulti.txt:3:bar\nmulti.txt:5:foo\nmulti.txt:6:baz');
      // ...but "." only crosses lines when multiline is asked for.
      assert.equal(await grep({ pattern: 'start.*end', output_mode: 'content' }), 'No matches found.');
      assert.equal(await grep({ pattern: 'foo\\n.*z', output_mode: 'content' }), 'multi.txt:5:foo\nmulti.txt:6:baz');
    });

    test('a single file, and a subdirectory, as the search path', async () => {
      assert.equal(await grep({ pattern: 'alpha', path: 'src/b.ts', output_mode: 'content' }), 'src/b.ts:1:export function alpha() {}');
      assert.equal(await grep({ pattern: 'alpha', path: 'src/b.ts' }), 'src/b.ts');
      assert.equal(await grep({ pattern: 'let', path: path.join(dir, 'src/b.ts'), output_mode: 'count' }), 'src/b.ts:3');
      assert.equal(await grep({ pattern: 'alpha', path: 'src/deep', output_mode: 'content' }), 'src/deep/c.ts:1:alpha\nsrc/deep/d.js:1:alpha in js');
      assert.equal(await grep({ pattern: 'alpha', path: 'logs', output_mode: 'content' }), 'logs/keep.log:1:alpha kept');
    });

    test('CRLF files match without a stray carriage return', async () => {
      assert.equal(await grep({ pattern: 'one$', path: 'crlf.txt', output_mode: 'content' }), 'crlf.txt:1:alpha one');
    });

    test('special characters in the pattern are regex syntax', async () => {
      assert.equal(await grep({ pattern: 'alpha\\(\\)', output_mode: 'content' }), 'src/b.ts:1:export function alpha() {}\nsrc/e.py:1:def alpha():');
      assert.equal(await grep({ pattern: '^let [xz] = \\d;$', output_mode: 'content' }), 'src/b.ts:2:let x = 1;\nsrc/b.ts:5:let z = 3;');
      assert.equal(await grep({ pattern: '-TODO|// TODO', output_mode: 'content' }), 'a.ts:3:// TODO fix');
    });

    test('the short flags models reach for are understood', async () => {
      assert.equal(await grep({ pattern: 'BETA', '-i': true, '-n': true }), 'a.ts:2:const Beta = 2;\nsrc/deep/c.ts:2:beta');
      assert.equal(await grep({ pattern: 'gamma', '-C': 1 }), 'src/deep/c.ts-2-beta\nsrc/deep/c.ts:3:gamma');
      assert.equal(await grep({ pattern: 'gamma', ignore_case: true, output_mode: 'count' }), 'src/deep/c.ts:1');
    });

    test('long lines are clipped', async () => {
      const big = tempProject('coco-search-long-');
      writeFiles(big, { 'long.txt': `${'x'.repeat(450)} needle ${'y'.repeat(50)}\n` });
      setRipgrep(rg);
      const res = await grepTool.execute({ pattern: 'needle', output_mode: 'content' }, makeContext(big, {}));
      assert.equal(res.content, `long.txt:1:${'x'.repeat(400)} [... omitted end of long line]`);
    });

    test('no matches, an invalid pattern and a missing path', async () => {
      assert.equal(await grep({ pattern: 'zzzzzz' }), 'No matches found.');
      setRipgrep(rg);
      const invalid = await grepTool.execute({ pattern: '(unclosed' }, ctx);
      assert.equal(invalid.isError, true);
      assert.match(invalid.content, /^Invalid regular expression/);
      const missing = await grepTool.execute({ pattern: 'x', path: 'nope' }, ctx);
      assert.equal(missing.isError, true);
      assert.match(missing.content, /Path does not exist/);
    });

    test('summaries, label and permission', async () => {
      setRipgrep(rg);
      assert.equal((await grepTool.execute({ pattern: 'let' }, ctx)).summary, 'Found 1 file');
      assert.equal((await grepTool.execute({ pattern: 'let', output_mode: 'content' }, ctx)).summary, 'Found 3 lines');
      assert.equal((await grepTool.execute({ pattern: 'TODO', output_mode: 'content', context: 1 }, ctx)).summary, 'Found 5 lines');
      assert.equal((await grepTool.execute({ pattern: 'alpha', output_mode: 'count', glob: '*.md' }, ctx)).summary, 'Counted matches in 1 file');
      assert.equal(grepTool.label!({ pattern: 'a b', path: 'src', glob: '*.ts' }, ctx), '"a b" in src (*.ts)');
      assert.equal(grepTool.permission!({ pattern: 'x' }, ctx)?.target, dir);
      assert.equal(grepTool.isReadOnly({ pattern: 'x' }), true);
    });

    test('the lower-level API and the project file listing', async () => {
      setRipgrep(rg);
      const res = await grepFiles({ pattern: 'alpha', root: path.join(dir, 'src', 'deep'), mode: 'files_with_matches' });
      assert.deepEqual(res, { lines: ['d.js', 'c.ts'], base: path.join(dir, 'src', 'deep') });
      assert.deepEqual(await globFiles(path.join(dir, 'docs'), '*'), ['readme.md']);
      const listed = record(backend, 'listing', (await listProjectFiles(dir)).join('\n')).split('\n');
      assert.ok(listed.includes('src/deep/c.ts') && listed.includes('.env') && listed.includes('logs/keep.log'));
      assert.ok(!listed.some((f) => f.startsWith('node_modules/') || f.startsWith('.git/') || f.startsWith('dist/') || f === 'logs/a.log' || f === 'link.ts'));
      assert.deepEqual((await listProjectFiles(dir, 3)).length, 3);
    });
  });
}

describe('ripgrep and the built-in search agree', { skip: !hasRipgrep && 'ripgrep is not installed' }, () => {
  test('every query above gave the same answer from both', () => {
    let compared = 0;
    for (const [key, byBackend] of results) {
      if (byBackend.size < 2) continue;
      assert.equal(byBackend.get('built-in search'), byBackend.get('ripgrep'), key);
      compared++;
    }
    assert.ok(compared > 50, `only ${compared} queries were compared`);
  });
});

describe('walkFiles and comparePaths', () => {
  test('walks in path order, honours the limit, and can ignore .gitignore', () => {
    const { dir } = project();
    const files = walkFiles(dir);
    assert.deepEqual(files, [...files].sort(comparePaths));
    assert.ok(files.includes('src/build/y.ts') && !files.includes('build/x.ts'));
    assert.equal(walkFiles(dir, { limit: 4 }).length, 4);
    const everything = walkFiles(dir, { respectIgnore: false });
    assert.ok(everything.includes('build/x.ts') && everything.includes('logs/a.log') && everything.includes('src/gen/z.ts'));
    assert.ok(!everything.some((f) => f.startsWith('.git/') || f.startsWith('node_modules/')));
    assert.deepEqual(walkFiles(path.join(dir, 'does-not-exist')), []);
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(walkFiles(dir, { signal: aborted.signal }), []);
  });

  test('comparePaths orders by path component', () => {
    assert.deepEqual(['b', 'a/z', 'a.ts', 'a/b/c', 'a'].sort(comparePaths), ['a', 'a/b/c', 'a/z', 'a.ts', 'b']);
  });
});

// ---------------------------------------------------------------- meta tools

function fakeRuntime(overrides: Partial<RuntimeHandle> = {}): RuntimeHandle & { subagentCalls: SubagentRequest[]; todoChanges: number } {
  const runtime = {
    subagentCalls: [] as SubagentRequest[],
    todoChanges: 0,
    async runSubagent(req: SubagentRequest) {
      runtime.subagentCalls.push(req);
      req.onProgress?.('Read(a.ts)');
      return { text: `report for ${req.description}`, toolUses: 3, tokens: 4321 };
    },
    agentTypes: () => [
      { name: 'general-purpose', description: 'anything' },
      { name: 'explore', description: 'search' },
    ],
    skills: () => [{ name: 'deploy', description: 'ship it' }],
    invokeSkill: async (name: string, args: string) =>
      name.toLowerCase() === 'deploy'
        ? { name: 'deploy', baseDir: '/skills/deploy', content: renderSkill('deploy', '/skills/deploy', `\nRun the deploy script.\n${args.trim() ? `\nARGUMENTS: ${args.trim()}` : ''}`) }
        : undefined,
    todosChanged: () => {
      runtime.todoChanges++;
    },
    ...overrides,
  };
  return runtime;
}

function contextWith(runtime?: RuntimeHandle, depth = 0): ToolContext {
  const base = makeContext(tempProject('coco-meta-'), {});
  const session = base.session;
  return {
    get cwd() {
      return session.cwd;
    },
    signal: base.signal,
    settings: base.settings,
    session,
    toolCallId: 't',
    depth,
    runtime,
  };
}

describe('TodoWrite', () => {
  test('replaces the list, notifies the UI and summarises it', async () => {
    const runtime = fakeRuntime();
    const ctx = contextWith(runtime);
    const res = await todoWriteTool.execute(
      {
        todos: [
          { content: '  Write tests ', status: 'completed' },
          { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
          { content: 'Ship', status: 'pending' },
        ],
      },
      ctx,
    );
    assert.equal(res.content, 'Todo list updated (2 remaining). Continue with the current task.');
    assert.equal(res.summary, '[x] Write tests\n[~] Fix bug\n[ ] Ship');
    assert.deepEqual(ctx.session.todos, [
      { content: 'Write tests', status: 'completed', activeForm: undefined },
      { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
      { content: 'Ship', status: 'pending', activeForm: undefined },
    ]);
    assert.equal(runtime.todoChanges, 1);
    await todoWriteTool.execute({ todos: [] }, ctx);
    assert.deepEqual(ctx.session.todos, []);
    assert.equal(renderTodos([]), '(no todos)');
  });

  test('tolerates sloppy input and works without a runtime', async () => {
    const ctx = contextWith(undefined);
    const res = await todoWriteTool.execute({ todos: [{ content: 'ok' }, { content: '   ', status: 'pending' }, null, { status: 'pending' }] as never }, ctx);
    assert.equal(res.isError, undefined);
    assert.deepEqual(ctx.session.todos, [{ content: 'ok', status: 'pending', activeForm: undefined }]);
    assert.equal((await todoWriteTool.execute({} as never, ctx)).isError, undefined);
    assert.equal(todoWriteTool.label!({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }, ctx), '1/2 done');
    assert.equal(todoWriteTool.label!({} as never, ctx), '0/0 done');
    assert.equal(todoWriteTool.permission, undefined);
  });
});

describe('AskUserQuestion', () => {
  const question: AskQuestion = { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }] };

  test('without anyone to ask, tells the model to decide for itself', async () => {
    const res = await askUserTool.execute({ questions: [question] }, contextWith(fakeRuntime()));
    assert.equal(res.isError, undefined);
    assert.match(res.content, /No user is available/);
    assert.match((await askUserTool.execute({ questions: [question] }, contextWith(undefined))).content, /No user is available/);
  });

  test('returns the answers', async () => {
    let asked: AskQuestion[] = [];
    const runtime = fakeRuntime({
      askUser: async (questions) => {
        asked = questions;
        return { 'Which database?': 'SQLite', 'And the port?': '5432' };
      },
    });
    const res = await askUserTool.execute({ questions: [question, { question: 'And the port?', options: [] }] }, contextWith(runtime));
    assert.equal(res.content, 'The user answered:\nQ: Which database?\nA: SQLite\n\nQ: And the port?\nA: 5432');
    assert.equal(res.summary, 'SQLite · 5432');
    assert.equal(asked.length, 2);
  });

  test('options given as plain strings are accepted; empty ones are dropped', async () => {
    let asked: AskQuestion[] = [];
    const runtime = fakeRuntime({
      askUser: async (questions) => {
        asked = questions;
        return { q: 'a' };
      },
    });
    await askUserTool.execute({ questions: [{ question: 'q', options: ['a', { label: 'b' }, { label: '' }, null] as never }] }, contextWith(runtime));
    assert.deepEqual(asked[0]!.options, [{ label: 'a' }, { label: 'b' }]);
  });

  test('a dismissed dialog and an empty question list', async () => {
    const dismissed = await askUserTool.execute({ questions: [question] }, contextWith(fakeRuntime({ askUser: async () => null })));
    assert.match(dismissed.content, /dismissed the question/);
    const none = await askUserTool.execute({ questions: [] }, contextWith(fakeRuntime({ askUser: async () => ({}) })));
    assert.equal(none.isError, true);
    assert.equal((await askUserTool.execute({} as never, contextWith(fakeRuntime()))).isError, true);
    assert.equal(askUserTool.isReadOnly({ questions: [] }), true);
    assert.equal(askUserTool.label!({ questions: [question] }, contextWith()), 'Which database?');
  });
});

describe('ExitPlanMode', () => {
  test('approved, rejected with feedback, and with nobody to approve', async () => {
    const approved = await exitPlanModeTool.execute({ plan: '1. do it' }, contextWith(fakeRuntime({ approvePlan: async () => ({ approved: true }) })));
    assert.match(approved.content, /approved the plan/);
    assert.equal(approved.summary, 'Plan approved');

    let seenPlan = '';
    const rejected = await exitPlanModeTool.execute(
      { plan: '1. do it' },
      contextWith(
        fakeRuntime({
          approvePlan: async (plan) => {
            seenPlan = plan;
            return { approved: false, feedback: 'add tests first' };
          },
        }),
      ),
    );
    assert.equal(seenPlan, '1. do it');
    assert.match(rejected.content, /did not approve the plan\. Their feedback: add tests first/);
    assert.equal(rejected.summary, 'Plan rejected');
    const silent = await exitPlanModeTool.execute({ plan: 'p' }, contextWith(fakeRuntime({ approvePlan: async () => ({ approved: false }) })));
    assert.doesNotMatch(silent.content, /feedback/);

    const headless = await exitPlanModeTool.execute({ plan: '1. do it' }, contextWith(fakeRuntime()));
    assert.match(headless.content, /No user is available to approve/);
    assert.equal(headless.isError, undefined);
  });

  test('an empty plan is refused', async () => {
    for (const plan of ['', '   \n']) {
      const res = await exitPlanModeTool.execute({ plan }, contextWith(fakeRuntime({ approvePlan: async () => ({ approved: true }) })));
      assert.equal(res.isError, true);
    }
    assert.equal((await exitPlanModeTool.execute({} as never, contextWith(fakeRuntime()))).isError, true);
  });
});

describe('Agent', () => {
  test('runs a subagent one level down and returns its report', async () => {
    const runtime = fakeRuntime();
    const progress: string[] = [];
    const ctx = { ...contextWith(runtime), onProgress: (t: string) => progress.push(t) };
    const res = await agentTool.execute({ description: 'find usages', prompt: 'Find all usages of foo', subagent_type: 'explore' }, ctx);
    assert.equal(res.content, 'report for find usages');
    assert.equal(res.summary, 'Done (3 tool uses · 4.3k tokens)');
    assert.equal(runtime.subagentCalls.length, 1);
    assert.equal(runtime.subagentCalls[0]!.type, 'explore');
    assert.equal(runtime.subagentCalls[0]!.depth, 1);
    assert.equal(runtime.subagentCalls[0]!.prompt, 'Find all usages of foo');
    assert.deepEqual(progress, ['Read(a.ts)']);
  });

  test('defaults to the general-purpose agent', async () => {
    const runtime = fakeRuntime();
    await agentTool.execute({ description: 'd', prompt: 'p' }, contextWith(runtime));
    await agentTool.execute({ description: 'd', prompt: 'p', subagent_type: '  ' }, contextWith(runtime));
    assert.deepEqual(runtime.subagentCalls.map((c) => c.type), ['general-purpose', 'general-purpose']);
  });

  test('refuses an unknown type, nesting, and a missing runtime', async () => {
    const runtime = fakeRuntime();
    const unknown = await agentTool.execute({ description: 'd', prompt: 'p', subagent_type: 'wizard' }, contextWith(runtime));
    assert.equal(unknown.isError, true);
    assert.match(unknown.content, /Unknown subagent_type "wizard"\. Available: general-purpose, explore\./);
    const nested = await agentTool.execute({ description: 'd', prompt: 'p' }, contextWith(runtime, 1));
    assert.equal(nested.isError, true);
    assert.match(nested.content, /cannot start further subagents/);
    assert.equal((await agentTool.execute({ description: 'd', prompt: 'p' }, contextWith(undefined))).isError, true);
    assert.equal(runtime.subagentCalls.length, 0);
  });

  test('an empty or failed report is passed on honestly', async () => {
    const empty = await agentTool.execute({ description: 'd', prompt: 'p' }, contextWith(fakeRuntime({ runSubagent: async () => ({ text: '', toolUses: 1, tokens: 10 }) })));
    assert.equal(empty.content, '(The subagent returned no text.)');
    assert.equal(empty.summary, 'Done (1 tool use · 0k tokens)');
    const failed = await agentTool.execute({ description: 'd', prompt: 'p' }, contextWith(fakeRuntime({ runSubagent: async () => ({ text: 'it broke', toolUses: 0, tokens: 0, isError: true }) })));
    assert.equal(failed.isError, true);
    assert.equal(agentTool.label!({ description: 'find things', prompt: '', subagent_type: 'explore' }, contextWith()), 'explore: find things');
    assert.equal(agentTool.label!({ description: 'find things', prompt: '' }, contextWith()), 'find things');
  });
});

describe('Skill', () => {
  test('loads a skill by name, case-insensitively and with a leading slash', async () => {
    const ctx = contextWith(fakeRuntime());
    const res = await skillTool.execute({ skill: 'deploy' }, ctx);
    assert.equal(res.content, 'Skill "deploy" (files are in /skills/deploy):\n\nRun the deploy script.');
    assert.equal(res.summary, 'Loaded skill deploy');
    assert.equal((await skillTool.execute({ skill: '/Deploy', args: ' to staging ' }, ctx)).content, 'Skill "deploy" (files are in /skills/deploy):\n\nRun the deploy script.\n\nARGUMENTS: to staging');
    assert.equal(renderSkill('x', '/d', 'body\n'), 'Skill "x" (files are in /d):\n\nbody');
  });

  test('a skill marked to fork runs in a subagent and returns its report', async () => {
    const runtime = fakeRuntime({ invokeSkill: async () => ({ name: 'audit', baseDir: '/s/audit', content: 'Audit the repo.', forkAgent: 'explore' }) });
    const res = await skillTool.execute({ skill: 'audit' }, contextWith(runtime));
    assert.equal(res.content, 'report for Skill audit');
    assert.equal(res.summary, 'Ran skill audit in a subagent');
    assert.deepEqual(runtime.subagentCalls.map((c) => [c.type, c.prompt, c.depth]), [['explore', 'Audit the repo.', 1]]);
    // Inside a subagent there is no further nesting: the instructions are returned instead.
    const nested = await skillTool.execute({ skill: 'audit' }, { ...contextWith(runtime), depth: 1 });
    assert.equal(nested.content, 'Audit the repo.');
  });

  test('an unknown skill lists what exists', async () => {
    const res = await skillTool.execute({ skill: 'nope' }, contextWith(fakeRuntime()));
    assert.equal(res.isError, true);
    assert.match(res.content, /No skill named "nope"\. Available: deploy\./);
    const none = await skillTool.execute({ skill: 'x' }, contextWith(fakeRuntime({ skills: () => [], invokeSkill: async () => undefined })));
    assert.match(none.content, /No skills are installed/);
    assert.equal((await skillTool.execute({ skill: 'x' }, contextWith(undefined))).isError, true);
    assert.equal((await skillTool.execute({} as never, contextWith(fakeRuntime()))).isError, true);
  });
});

describe('tool registry', () => {
  test('built-in tools have unique names, descriptions and object schemas', () => {
    const tools = builtinTools();
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'Agent', 'WebFetch', 'WebSearch', 'BashOutput', 'KillShell', 'NotebookEdit', 'AskUserQuestion', 'ExitPlanMode', 'Skill']) {
      assert.ok(names.includes(name), name);
    }
    for (const spec of toolSpecs(tools)) {
      assert.ok(spec.description.length > 20, spec.name);
      assert.equal(spec.parameters.type, 'object', spec.name);
      for (const required of spec.parameters.required ?? []) assert.ok(required in (spec.parameters.properties ?? {}), `${spec.name}.${required}`);
    }
    for (const name of READ_ONLY_TOOLS) assert.ok(names.includes(name), name);
  });

  test('filterTools keeps the named tools, case-insensitively and through aliases', () => {
    const tools = builtinTools();
    const names = (filter?: string[]) => filterTools(tools, filter).map((t) => t.name);
    assert.equal(names(undefined).length, tools.length);
    assert.equal(names([]).length, tools.length);
    assert.equal(names(['*']).length, tools.length);
    assert.deepEqual(names(['Read', 'bash']), ['Read', 'Bash']);
    assert.deepEqual(names(['Task', 'LS', 'MultiEdit']), ['Edit', 'Glob', 'Agent']);
    assert.deepEqual(names(['Nonexistent']), []);
    const mcp = { ...tools[0]!, name: 'mcp__github__create_issue' };
    const other = { ...tools[0]!, name: 'mcp__gitlab__x' };
    assert.deepEqual(filterTools([...tools, mcp, other], ['Read', 'mcp__github']).map((t) => t.name), ['Read', 'mcp__github__create_issue']);
    assert.deepEqual(filterTools([mcp, other], ['mcp__github__create_issue']).map((t) => t.name), ['mcp__github__create_issue']);
  });
});
