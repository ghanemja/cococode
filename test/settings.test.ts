import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import {
  configDir,
  displayPath,
  expandHome,
  findProjectRoot,
  projectConfigDirs,
  projectSlug,
  readJsonFile,
  sessionsDir,
  userConfigDirs,
  writeJsonFile,
} from '../src/config/paths.ts';
import type { Settings } from '../src/config/settings.ts';
import {
  getByPath,
  loadSettings,
  mergeSettings,
  parseSettingValue,
  setByPath,
  settingsPath,
  updateSettingsFile,
} from '../src/config/settings.ts';
import { tempProject, writeFiles } from './helpers.ts';

const COCO_ENV = [
  'COCO_PROVIDER',
  'COCO_MODEL',
  'COCO_BASE_URL',
  'COCO_API_KEY',
  'COCO_SMALL_MODEL',
  'COCO_CONTEXT_WINDOW',
  'COCO_MAX_OUTPUT_TOKENS',
  'COCO_TOOL_MODE',
];

/** Run `fn` with the given variables set (undefined = unset), restoring the environment afterwards. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of [...COCO_ENV, ...Object.keys(vars)]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function load(root: string, opts: { extra?: string; overrides?: Settings; env?: Record<string, string> } = {}) {
  return withEnv(opts.env ?? {}, () => loadSettings({ projectRoot: root, extra: opts.extra, overrides: opts.overrides }));
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe('mergeSettings', () => {
  test('later scalars win and undefined does not overwrite', () => {
    const merged = mergeSettings({ model: 'a', temperature: 0.2 }, { model: 'b' }, { model: undefined, verbose: true });
    assert.deepEqual(merged, { model: 'b', temperature: 0.2, verbose: true });
  });

  test('skips missing sources', () => {
    assert.deepEqual(mergeSettings(undefined, { model: 'a' }, undefined), { model: 'a' });
    assert.deepEqual(mergeSettings(), {});
  });

  test('nested objects are merged key by key', () => {
    const merged = mergeSettings(
      { env: { A: '1', B: '2' }, providers: { one: { type: 'openai', baseUrl: 'http://one' } } },
      { env: { B: '3', C: '4' }, providers: { two: { type: 'ollama', baseUrl: 'http://two' } } },
    );
    assert.deepEqual(merged.env, { A: '1', B: '3', C: '4' });
    assert.deepEqual(Object.keys(merged.providers ?? {}), ['one', 'two']);
  });

  test('a scalar replaces an object and the other way round', () => {
    assert.equal(mergeSettings({ thinking: 'high' }, { thinking: false }).thinking, false);
    const s = mergeSettings({ webSearch: { provider: 'duckduckgo' } }, { webSearch: { url: 'http://x' } });
    assert.deepEqual(s.webSearch, { provider: 'duckduckgo', url: 'http://x' });
  });

  test('arrays outside permissions and hooks are replaced, not concatenated', () => {
    const merged = mergeSettings({ disabledMcpServers: ['a', 'b'] }, { disabledMcpServers: ['c'] });
    assert.deepEqual(merged.disabledMcpServers, ['c']);
  });

  test('permission lists accumulate and are de-duplicated; the mode is last-wins', () => {
    const merged = mergeSettings(
      { permissions: { allow: ['Bash(ls:*)', 'Read'], deny: ['WebFetch'], defaultMode: 'plan', additionalDirectories: ['/a'] } },
      { permissions: { allow: ['Read', 'Edit'], ask: ['Bash(git push:*)'], additionalDirectories: ['/a', '/b'] } },
      { permissions: { defaultMode: 'acceptEdits' } },
    );
    assert.deepEqual(merged.permissions, {
      allow: ['Bash(ls:*)', 'Read', 'Edit'],
      ask: ['Bash(git push:*)'],
      deny: ['WebFetch'],
      defaultMode: 'acceptEdits',
      additionalDirectories: ['/a', '/b'],
    });
  });

  test('a later source without a mode keeps the earlier mode', () => {
    const merged = mergeSettings({ permissions: { defaultMode: 'plan' } }, { permissions: { allow: ['Read'] } });
    assert.equal(merged.permissions?.defaultMode, 'plan');
  });

  test('hooks are concatenated per event in source order', () => {
    const merged = mergeSettings(
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'one' }] }] } },
      {
        hooks: {
          PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'two' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'three' }] }],
        },
      },
    );
    assert.deepEqual(merged.hooks?.PreToolUse?.map((m) => m.hooks[0]!.command), ['one', 'two']);
    assert.deepEqual(merged.hooks?.Stop?.map((m) => m.hooks[0]!.command), ['three']);
  });

  test('a hook event that is not a list is ignored', () => {
    const merged = mergeSettings({ hooks: { PreToolUse: { matcher: 'Bash' } } as never });
    assert.deepEqual(merged.hooks, {});
  });

  test('the result does not alias its inputs', () => {
    const user: Settings = {
      env: { A: '1' },
      permissions: { allow: ['Read'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      providers: { p: { type: 'openai', baseUrl: 'http://p' } },
    };
    const before = structuredClone(user);
    const merged = mergeSettings(user);
    merged.env!.B = '2';
    merged.permissions!.allow!.push('Edit');
    merged.hooks!.Stop![0]!.hooks[0]!.command = 'changed';
    merged.providers!.p!.baseUrl = 'http://changed';
    assert.deepEqual(user, before);
  });
});

describe('loadSettings', () => {
  test('returns empty settings when no files exist', () => {
    const root = tempProject();
    const loaded = load(root);
    assert.deepEqual(loaded.merged, {});
    assert.deepEqual(loaded.sources, []);
    assert.deepEqual(loaded.errors, []);
  });

  test('precedence: user < claude < project < local < --settings < env < overrides', () => {
    const root = tempProject();
    const extra = path.join(root, 'extra.json');
    writeFiles(root, {
      '.coco-home/settings.json': json({ model: 'user', smallModel: 'user', temperature: 1, keepAlive: 'user', outputStyle: 'user', bell: true }),
      '.claude/settings.json': json({ env: { FROM: 'claude', CLAUDE_ONLY: '1' } }),
      '.coco/settings.json': json({ model: 'project', smallModel: 'project', temperature: 2, keepAlive: 'project', env: { FROM: 'project' } }),
      '.coco/settings.local.json': json({ model: 'local', smallModel: 'local', temperature: 3 }),
      'extra.json': json({ model: 'flag', smallModel: 'flag' }),
    });
    const loaded = load(root, { extra, env: { COCO_MODEL: 'env' }, overrides: {} });
    assert.equal(loaded.merged.model, 'env');
    assert.equal(loaded.merged.smallModel, 'flag');
    assert.equal(loaded.merged.temperature, 3);
    assert.equal(loaded.merged.keepAlive, 'project');
    assert.equal(loaded.merged.outputStyle, 'user');
    assert.equal(loaded.merged.bell, true);
    assert.deepEqual(loaded.merged.env, { FROM: 'project', CLAUDE_ONLY: '1' });
    assert.deepEqual(
      loaded.sources.map((s) => s.scope),
      ['user', 'claude-project', 'project', 'local', 'flag', 'env'],
    );

    const withCli = load(root, { extra, env: { COCO_MODEL: 'env' }, overrides: { model: 'cli' } });
    assert.equal(withCli.merged.model, 'cli');
    assert.equal(withCli.sources.at(-1)!.scope, 'cli');
  });

  test('--settings accepts inline JSON', () => {
    const root = tempProject();
    writeFiles(root, { '.coco/settings.local.json': json({ model: 'local', verbose: true }) });
    const loaded = load(root, { extra: ' {"model": "inline", "permissions": {"allow": ["Read"]}} ' });
    assert.equal(loaded.merged.model, 'inline');
    assert.equal(loaded.merged.verbose, true);
    assert.deepEqual(loaded.merged.permissions?.allow, ['Read']);
    assert.equal(loaded.sources.find((s) => s.scope === 'flag')?.path, undefined);
  });

  test('--settings problems are reported, not thrown', () => {
    const root = tempProject();
    assert.match(load(root, { extra: '{"model": ' }).errors[0]!, /--settings is not valid JSON/);
    assert.match(load(root, { extra: path.join(root, 'missing.json') }).errors[0]!, /not found/);
    writeFiles(root, { 'list.json': '[1, 2]' });
    assert.match(load(root, { extra: path.join(root, 'list.json') }).errors[0]!, /JSON object/);
  });

  test('only permissions, hooks and env are taken from .claude settings', () => {
    const root = tempProject();
    writeFiles(root, {
      '.claude/settings.json': json({
        model: 'claude-opus',
        outputStyle: 'explanatory',
        statusLine: { type: 'command', command: 'x' },
        permissions: { allow: ['Bash(npm test:*)'], defaultMode: 'acceptEdits' },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
        env: { FOO: 'bar' },
      }),
      '.claude/settings.local.json': json({ model: 'claude-local', permissions: { deny: ['WebFetch'] } }),
    });
    const loaded = load(root);
    assert.equal(loaded.merged.model, undefined);
    assert.equal(loaded.merged.outputStyle, undefined);
    assert.equal(loaded.merged.statusLine, undefined);
    assert.deepEqual(loaded.merged.permissions?.allow, ['Bash(npm test:*)']);
    assert.deepEqual(loaded.merged.permissions?.deny, ['WebFetch']);
    assert.equal(loaded.merged.permissions?.defaultMode, 'acceptEdits');
    assert.equal(loaded.merged.hooks?.Stop?.length, 1);
    assert.deepEqual(loaded.merged.env, { FOO: 'bar' });
    assert.deepEqual(
      loaded.sources.map((s) => s.scope),
      ['claude-project', 'claude-local'],
    );
  });

  test('.coco rules are added to .claude rules, and .coco wins for the mode', () => {
    const root = tempProject();
    writeFiles(root, {
      '.claude/settings.json': json({ permissions: { allow: ['Read'], defaultMode: 'plan' } }),
      '.coco/settings.json': json({ permissions: { allow: ['Edit'], defaultMode: 'default' } }),
    });
    const loaded = load(root);
    assert.deepEqual(loaded.merged.permissions?.allow, ['Read', 'Edit']);
    assert.equal(loaded.merged.permissions?.defaultMode, 'default');
  });

  for (const where of ['.coco-home/settings.json', '.coco/settings.json', '.coco/settings.local.json']) {
    test(`claudeCompat: false in ${where} turns .claude settings off`, () => {
      const root = tempProject();
      writeFiles(root, {
        '.claude/settings.json': json({ permissions: { allow: ['Bash'] }, env: { X: '1' } }),
        '.claude/settings.local.json': json({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }),
        [where]: json({ claudeCompat: false }),
      });
      const loaded = load(root);
      assert.equal(loaded.merged.permissions, undefined);
      assert.equal(loaded.merged.env, undefined);
      assert.equal(loaded.merged.hooks, undefined);
      assert.ok(!loaded.sources.some((s) => s.scope.startsWith('claude')));
    });
  }

  test('a more specific file can turn compat back on', () => {
    const root = tempProject();
    writeFiles(root, {
      '.claude/settings.json': json({ env: { X: '1' } }),
      '.coco-home/settings.json': json({ claudeCompat: false }),
      '.coco/settings.json': json({ claudeCompat: true }),
    });
    assert.deepEqual(load(root).merged.env, { X: '1' });
  });

  test('malformed files are reported and the rest still loads', () => {
    const root = tempProject();
    writeFiles(root, {
      '.coco-home/settings.json': '{ "model": "user", }',
      '.claude/settings.json': 'not json',
      '.coco/settings.json': json({ model: 'project' }),
      '.coco/settings.local.json': '"just a string"',
    });
    const loaded = load(root);
    assert.equal(loaded.merged.model, 'project');
    assert.equal(loaded.errors.length, 3);
    assert.ok(loaded.errors.some((e) => e.includes(path.join('.coco-home', 'settings.json'))));
    assert.ok(loaded.errors.some((e) => e.includes(path.join('.claude', 'settings.json'))));
    assert.ok(loaded.errors.some((e) => e.includes('settings.local.json') && /JSON object/.test(e)));
  });

  test('an empty settings file is not an error', () => {
    const root = tempProject();
    writeFiles(root, { '.coco/settings.json': '', '.coco/settings.local.json': '  \n' });
    const loaded = load(root);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.merged, {});
  });

  test('environment variables map onto settings', () => {
    const root = tempProject();
    const loaded = load(root, {
      env: {
        COCO_PROVIDER: 'lmstudio',
        COCO_MODEL: 'qwen',
        COCO_BASE_URL: 'http://localhost:9/v1',
        COCO_API_KEY: 'k',
        COCO_SMALL_MODEL: 'tiny',
        COCO_CONTEXT_WINDOW: '16384',
        COCO_MAX_OUTPUT_TOKENS: '2048',
        COCO_TOOL_MODE: 'prompt',
      },
    });
    assert.deepEqual(loaded.merged, {
      provider: 'lmstudio',
      model: 'qwen',
      baseUrl: 'http://localhost:9/v1',
      apiKey: 'k',
      smallModel: 'tiny',
      contextWindow: 16384,
      maxOutputTokens: 2048,
      toolMode: 'prompt',
    });
  });

  test('invalid numeric and enum environment values are ignored', () => {
    const root = tempProject();
    const loaded = load(root, { env: { COCO_CONTEXT_WINDOW: 'lots', COCO_MAX_OUTPUT_TOKENS: '-5', COCO_TOOL_MODE: 'magic' } });
    assert.deepEqual(loaded.merged, {});
    assert.deepEqual(loaded.sources, []);
  });

  test('sources keep their own values so the origin of a setting can be shown', () => {
    const root = tempProject();
    writeFiles(root, { '.coco-home/settings.json': json({ model: 'user' }), '.coco/settings.json': json({ model: 'project' }) });
    const loaded = load(root);
    assert.deepEqual(
      loaded.sources.map((s) => [s.scope, s.settings.model, s.path && path.basename(s.path)]),
      [
        ['user', 'user', 'settings.json'],
        ['project', 'project', 'settings.json'],
      ],
    );
  });

  test('changing the merged settings does not change a source', () => {
    const root = tempProject();
    writeFiles(root, { '.coco/settings.json': json({ env: { A: '1' }, permissions: { allow: ['Read'] } }) });
    const loaded = load(root);
    loaded.merged.env!.B = '2';
    loaded.merged.permissions!.allow!.push('Edit');
    assert.deepEqual(loaded.sources[0]!.settings, { env: { A: '1' }, permissions: { allow: ['Read'] } });
  });
});

describe('settings files', () => {
  test('settingsPath for each scope', () => {
    const root = tempProject();
    assert.equal(settingsPath('user', root), path.join(configDir(), 'settings.json'));
    assert.equal(settingsPath('project', root), path.join(root, '.coco', 'settings.json'));
    assert.equal(settingsPath('local', root), path.join(root, '.coco', 'settings.local.json'));
  });

  test('updateSettingsFile creates the file and keeps existing keys', () => {
    const root = tempProject();
    const file = updateSettingsFile('local', root, (s) => {
      s.model = 'a';
    });
    assert.equal(file, settingsPath('local', root));
    updateSettingsFile('local', root, (s) => {
      s.permissions ??= {};
      (s.permissions.allow ??= []).push('Read');
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'a', permissions: { allow: ['Read'] } });
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  });

  test('updateSettingsFile keeps a copy of a file it cannot parse', () => {
    const root = tempProject();
    const file = settingsPath('project', root);
    const broken = '{ "model": "mine", // my notes\n}';
    writeFiles(root, { '.coco/settings.json': broken });
    updateSettingsFile('project', root, (s) => {
      s.verbose = true;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { verbose: true });
    assert.equal(fs.readFileSync(`${file}.invalid`, 'utf8'), broken);
  });

  test('updateSettingsFile treats a non-object file like an unparseable one', () => {
    const root = tempProject();
    const file = settingsPath('project', root);
    writeFiles(root, { '.coco/settings.json': '[1, 2, 3]' });
    updateSettingsFile('project', root, (s) => {
      s.model = 'x';
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'x' });
    assert.equal(fs.readFileSync(`${file}.invalid`, 'utf8'), '[1, 2, 3]');
  });

  test('a valid file is updated without leaving a backup or temp file', () => {
    const root = tempProject();
    writeFiles(root, { '.coco/settings.json': json({ model: 'a' }) });
    updateSettingsFile('project', root, (s) => {
      s.model = 'b';
    });
    assert.deepEqual(fs.readdirSync(path.join(root, '.coco')), ['settings.json']);
  });
});

describe('setByPath / getByPath', () => {
  test('sets and reads nested keys, creating objects on the way', () => {
    const target: Record<string, unknown> = { model: 'a' };
    setByPath(target, 'permissions.defaultMode', 'plan');
    setByPath(target, 'webSearch.url', 'http://x');
    setByPath(target, 'model', 'b');
    assert.deepEqual(target, { model: 'b', permissions: { defaultMode: 'plan' }, webSearch: { url: 'http://x' } });
    assert.equal(getByPath(target, 'permissions.defaultMode'), 'plan');
    assert.equal(getByPath(target, 'model'), 'b');
    assert.deepEqual(getByPath(target, 'permissions'), { defaultMode: 'plan' });
  });

  test('undefined removes the key', () => {
    const target: Record<string, unknown> = { a: { b: 1, c: 2 } };
    setByPath(target, 'a.b', undefined);
    assert.deepEqual(target, { a: { c: 2 } });
  });

  test('a scalar in the way is replaced by an object', () => {
    const target: Record<string, unknown> = { thinking: true };
    setByPath(target, 'thinking.level', 'high');
    assert.deepEqual(target, { thinking: { level: 'high' } });
  });

  test('missing paths read as undefined', () => {
    assert.equal(getByPath({ a: { b: 1 } }, 'a.x'), undefined);
    assert.equal(getByPath({ a: 1 }, 'a.b.c'), undefined);
    assert.equal(getByPath(undefined, 'a'), undefined);
    assert.equal(getByPath({ a: [1, 2] }, 'a.0'), undefined);
  });

  test('inherited properties are not settings', () => {
    assert.equal(getByPath({}, 'toString'), undefined);
    assert.equal(getByPath({ a: {} }, 'a.constructor'), undefined);
  });

  test('keys that would reach the prototype are rejected', () => {
    for (const key of ['__proto__.polluted', 'a.__proto__.polluted', 'constructor.prototype.polluted', 'a..b', '']) {
      assert.throws(() => setByPath({}, key, true), /Invalid settings key/, key);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe('parseSettingValue', () => {
  test('booleans, numbers and null', () => {
    assert.equal(parseSettingValue('true'), true);
    assert.equal(parseSettingValue(' false '), false);
    assert.equal(parseSettingValue('null'), undefined);
    assert.equal(parseSettingValue('undefined'), undefined);
    assert.equal(parseSettingValue('32768'), 32768);
    assert.equal(parseSettingValue('-1'), -1);
    assert.equal(parseSettingValue('0.7'), 0.7);
  });

  test('JSON values', () => {
    assert.deepEqual(parseSettingValue('["a", "b"]'), ['a', 'b']);
    assert.deepEqual(parseSettingValue('{"type": "command", "command": "x"}'), { type: 'command', command: 'x' });
    assert.equal(parseSettingValue('"true"'), 'true');
    assert.equal(parseSettingValue('"123"'), '123');
  });

  test('everything else is a string', () => {
    assert.equal(parseSettingValue('qwen3-coder:30b'), 'qwen3-coder:30b');
    assert.equal(parseSettingValue('http://localhost:11434'), 'http://localhost:11434');
    assert.equal(parseSettingValue('1.2.3'), '1.2.3');
    assert.equal(parseSettingValue('30m'), '30m');
    assert.equal(parseSettingValue('{not json'), '{not json');
    assert.equal(parseSettingValue('True'), 'True');
  });
});

describe('paths', () => {
  test('projectSlug is stable and filesystem-safe', () => {
    assert.equal(projectSlug('/home/me/my project/v1.2'), '-home-me-my-project-v1-2');
    assert.equal(projectSlug('/a/b/'), projectSlug('/a/b'));
    assert.equal(projectSlug('/a/b/../b'), projectSlug('/a/b'));
    assert.match(projectSlug(path.join(os.tmpdir(), 'x y', 'z')), /^[A-Za-z0-9-]+$/);
    assert.notEqual(projectSlug('/a/b'), projectSlug('/a/c'));
  });

  test('sessionsDir lives under the config directory', () => {
    const root = tempProject();
    assert.equal(sessionsDir(root), path.join(configDir(), 'projects', projectSlug(root)));
  });

  test('configDir follows COCO_CONFIG_DIR', () => {
    const root = tempProject();
    assert.equal(configDir(), path.join(root, '.coco-home'));
  });

  test('findProjectRoot finds the nearest .git', () => {
    const root = tempProject();
    writeFiles(root, { '.git/HEAD': 'ref', 'pkg/sub/deep/file.txt': 'x', 'pkg/.git/HEAD': 'ref' });
    assert.equal(findProjectRoot(path.join(root, 'pkg', 'sub', 'deep')), path.join(root, 'pkg'));
    assert.equal(findProjectRoot(path.join(root, 'pkg')), path.join(root, 'pkg'));
    assert.equal(findProjectRoot(root), root);
  });

  test('findProjectRoot accepts a .git file (worktrees and submodules)', () => {
    const root = tempProject();
    writeFiles(root, { '.git': 'gitdir: elsewhere', 'a/b/c.txt': 'x' });
    assert.equal(findProjectRoot(path.join(root, 'a', 'b')), root);
  });

  test('findProjectRoot treats a directory with .coco/settings.json as a root', () => {
    const root = tempProject();
    writeFiles(root, { 'proj/.coco/settings.json': '{}', 'proj/src/x.ts': '' });
    assert.equal(findProjectRoot(path.join(root, 'proj', 'src')), path.join(root, 'proj'));
  });

  test('findProjectRoot falls back to the directory itself', () => {
    const root = tempProject();
    writeFiles(root, { 'a/b/c.txt': 'x' });
    // No marker anywhere above (unless the temp dir sits inside a repository).
    const found = findProjectRoot(path.join(root, 'a', 'b'));
    const enclosing = findProjectRoot(os.tmpdir());
    assert.ok(found === path.join(root, 'a', 'b') || found === enclosing);
  });

  test('displayPath is relative inside cwd and absolute outside', () => {
    assert.equal(displayPath('/w/proj/src/a.ts', '/w/proj'), path.join('src', 'a.ts'));
    assert.equal(displayPath('src/a.ts', '/w/proj'), path.join('src', 'a.ts'));
    assert.equal(displayPath('/w/proj', '/w/proj'), '.');
    assert.equal(displayPath('/w/other/a.ts', '/w/proj'), '/w/other/a.ts');
    assert.equal(displayPath('/w/proj-two/a.ts', '/w/proj'), '/w/proj-two/a.ts');
    assert.equal(displayPath('../x', '/w/proj'), '/w/x');
  });

  test('displayPath keeps names that merely start with two dots relative', () => {
    assert.equal(displayPath('/w/proj/..cache/x', '/w/proj'), path.join('..cache', 'x'));
    assert.equal(displayPath('/w/proj/...', '/w/proj'), '...');
  });

  test('displayPath shortens the home directory', () => {
    const home = os.homedir();
    assert.equal(displayPath(home, '/somewhere/else'), '~');
    assert.equal(displayPath(path.join(home, 'notes', 'a.md'), '/somewhere/else'), `~${path.sep}${path.join('notes', 'a.md')}`);
    assert.equal(displayPath(`${home}-other/a`, '/somewhere/else'), `${home}-other/a`);
  });

  test('expandHome', () => {
    const home = os.homedir();
    assert.equal(expandHome('~'), home);
    assert.equal(expandHome('~/a/b'), path.join(home, 'a', 'b'));
    assert.equal(expandHome('~user/a'), '~user/a');
    assert.equal(expandHome('/abs/~'), '/abs/~');
    assert.equal(expandHome('rel/path'), 'rel/path');
  });

  test('config directory lists put .coco before .claude', () => {
    const root = tempProject();
    assert.deepEqual(projectConfigDirs(root, true), [path.join(root, '.coco'), path.join(root, '.claude')]);
    assert.deepEqual(projectConfigDirs(root, false), [path.join(root, '.coco')]);
    assert.deepEqual(userConfigDirs(false), [configDir()]);
    assert.deepEqual(userConfigDirs(true), [configDir(), path.join(os.homedir(), '.claude')]);
  });

  test('writeJsonFile creates directories, replaces atomically and leaves no temp file', () => {
    const root = tempProject();
    const file = path.join(root, 'deep', 'er', 'data.json');
    writeJsonFile(file, { a: 1 });
    writeJsonFile(file, { a: 2, b: [1, 2] });
    assert.deepEqual(readJsonFile(file), { a: 2, b: [1, 2] });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['data.json']);
    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 2,\n  "b": [\n    1,\n    2\n  ]\n}\n');
  });

  test('writeJsonFile does not leave a temp file behind when the write fails', () => {
    const root = tempProject();
    const dir = path.join(root, 'target');
    fs.mkdirSync(path.join(dir, 'data.json'), { recursive: true }); // a directory where the file should go
    assert.throws(() => writeJsonFile(path.join(dir, 'data.json'), { a: 1 }));
    assert.deepEqual(fs.readdirSync(dir), ['data.json']);
  });

  test('readJsonFile: missing and empty are undefined, malformed throws with the path', () => {
    const root = tempProject();
    assert.equal(readJsonFile(path.join(root, 'nope.json')), undefined);
    writeFiles(root, { 'empty.json': '', 'bad.json': '{oops' });
    assert.equal(readJsonFile(path.join(root, 'empty.json')), undefined);
    assert.throws(() => readJsonFile(path.join(root, 'bad.json')), (err: Error) => err.message.includes('bad.json'));
  });
});
