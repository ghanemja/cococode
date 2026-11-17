/**
 * Behaviour added to match what Claude Code documents: wrapper-aware shell
 * rules, rules for subagents and skills, model-initiated plan mode, a tool
 * output limit scaled to the context window, and the newer slash commands.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { AgentEvent } from '../src/agent/loop.ts';
import type { CommandIO } from '../src/commands/builtin.ts';
import { runSlash } from '../src/commands/builtin.ts';
import { Controller, type ControllerOptions } from '../src/core/controller.ts';
import { stripWrappers } from '../src/permissions/bash.ts';
import { PermissionManager } from '../src/permissions/manager.ts';
import { listSessions, loadSession } from '../src/session/store.ts';
import { bashTool } from '../src/tools/bash.ts';
import { agentTool, skillTool } from '../src/tools/meta.ts';
import { stripAnsi } from '../src/ui/ansi.ts';
import { makeContext, tempProject, writeFiles } from './helpers.ts';
import { lastMessage, startMockServer, type MockServer, type MockServerOptions, type Script } from './mock-server.ts';

let servers: MockServer[] = [];
let controllers: Controller[] = [];

afterEach(async () => {
  for (const c of controllers) await c.shutdown();
  for (const s of servers) await s.close();
  servers = [];
  controllers = [];
});

async function setup(script: Script, opts: Partial<ControllerOptions> & { files?: Record<string, string>; server?: MockServerOptions; ollama?: boolean } = {}) {
  const dir = tempProject();
  if (opts.files) writeFiles(dir, opts.files);
  const server = await startMockServer(script, opts.server);
  servers.push(server);
  const { files: _f, server: _s, ollama, ...rest } = opts;
  const ctl = new Controller({
    cwd: dir,
    interactive: false,
    ...rest,
    overrides: ollama
      ? { provider: 'ollama', baseUrl: server.root, model: opts.server?.models?.[0] ?? 'mock-model', ...(rest.overrides ?? {}) }
      : { baseUrl: server.url, model: 'mock-model', ...(rest.overrides ?? {}) },
  });
  controllers.push(ctl);
  await ctl.connect();
  return { ctl, server, dir };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function fakeIO(): CommandIO & { out: string[] } {
  const io = {
    out: [] as string[],
    print: (text: string) => void io.out.push(stripAnsi(text)),
    width: () => 100,
    select: async () => undefined as never,
    editFile: async () => {},
    clearScreen: () => {},
    exit: () => {},
    showHistory: () => {},
    toggleVerbose: () => true,
    setInput: () => {},
  };
  return io;
}

describe('wrapper commands in permission rules', () => {
  test('stripWrappers removes commands that only run another command', () => {
    assert.equal(stripWrappers('timeout 60 npm test'), 'npm test');
    assert.equal(stripWrappers('timeout -k 5 --signal=KILL 2m npm run build'), 'npm run build');
    assert.equal(stripWrappers('time -p make'), 'make');
    assert.equal(stripWrappers('nice -n 10 cargo build'), 'cargo build');
    assert.equal(stripWrappers('nohup ./server.sh'), './server.sh');
    assert.equal(stripWrappers('stdbuf -oL -eL pytest -x'), 'pytest -x');
    assert.equal(stripWrappers('command git status'), 'git status');
    assert.equal(stripWrappers('nohup timeout 10 nice make'), 'make', 'nested wrappers');
    // Not wrappers, or not in wrapper form: left alone.
    assert.equal(stripWrappers('command -v git'), 'command -v git');
    assert.equal(stripWrappers('npx jest'), 'npx jest');
    assert.equal(stripWrappers('timeout'), 'timeout');
    assert.equal(stripWrappers('xargs rm'), 'xargs rm');
    assert.equal(stripWrappers('xargs rm', { xargs: true }), 'rm');
    assert.equal(stripWrappers('xargs -0 rm', { xargs: true }), 'xargs -0 rm');
  });

  function evaluate(command: string, permissions: { allow?: string[]; deny?: string[]; ask?: string[] } = {}) {
    const ctx = makeContext(tempProject());
    writeFiles(ctx.cwd, { 'a.txt': 'a\n' });
    const manager = new PermissionManager(ctx.session, { settings: permissions });
    return manager.evaluate(bashTool, { command }, ctx);
  }

  test('an allow rule covers its command behind a wrapper', () => {
    assert.equal(evaluate('timeout 60 npm test', { allow: ['Bash(npm test:*)'] }).behavior, 'allow');
    assert.equal(evaluate('nice npm test -- --watch', { allow: ['Bash(npm test:*)'] }).behavior, 'allow');
    assert.equal(evaluate('timeout 60 npm publish', { allow: ['Bash(npm test:*)'] }).behavior, 'ask');
  });

  test('a wrapper cannot hide a command from a deny or ask rule', () => {
    assert.equal(evaluate('nohup rm -rf build', { deny: ['Bash(rm:*)'] }).behavior, 'deny');
    assert.equal(evaluate('timeout 5 rm -rf build', { deny: ['Bash(rm:*)'], allow: ['Bash'] }).behavior, 'deny');
    assert.equal(evaluate('ls | xargs rm', { deny: ['Bash(rm:*)'], allow: ['Bash'] }).behavior, 'deny');
    assert.equal(evaluate('time git push origin main', { ask: ['Bash(git push:*)'], allow: ['Bash(git:*)'] }).behavior, 'ask');
  });

  test('read-only commands stay read-only behind a wrapper, but xargs is not looked through', () => {
    assert.equal(evaluate('timeout 5 cat a.txt').behavior, 'allow');
    assert.equal(evaluate('time ls').behavior, 'allow');
    assert.equal(evaluate('timeout 5 rm a.txt').behavior, 'ask');
    assert.equal(evaluate('ls | xargs cat').behavior, 'ask');
  });
});

describe('rules for subagents and skills', () => {
  function manager(deny: string[]) {
    const ctx = makeContext(tempProject());
    return { ctx, manager: new PermissionManager(ctx.session, { settings: { deny } }) };
  }

  test('Agent(type) denies one subagent type, whatever its capitalisation', () => {
    const { ctx, manager: m } = manager(['Agent(Explore)']);
    assert.equal(m.evaluate(agentTool, { description: 'x', prompt: 'y', subagent_type: 'explore' }, ctx).behavior, 'deny');
    assert.equal(m.evaluate(agentTool, { description: 'x', prompt: 'y', subagent_type: 'plan' }, ctx).behavior, 'allow');
    assert.equal(m.evaluate(agentTool, { description: 'x', prompt: 'y' }, ctx).behavior, 'allow');
    assert.equal(m.isToolDisabled('Agent'), false, 'the tool itself stays available');
  });

  test('Skill(name) and Skill(name *) deny one skill', () => {
    const { ctx, manager: m } = manager(['Skill(deploy)', 'Skill(release *)']);
    assert.equal(m.evaluate(skillTool, { skill: 'deploy' }, ctx).behavior, 'deny');
    assert.equal(m.evaluate(skillTool, { skill: '/Deploy' }, ctx).behavior, 'deny');
    assert.equal(m.evaluate(skillTool, { skill: 'release', args: 'v2 --force' }, ctx).behavior, 'deny');
    assert.equal(m.evaluate(skillTool, { skill: 'release' }, ctx).behavior, 'deny');
    assert.equal(m.evaluate(skillTool, { skill: 'lint' }, ctx).behavior, 'allow');
    assert.equal(m.evaluate(skillTool, { skill: 'deployment' }, ctx).behavior, 'allow');
  });

  test('a bare deny still removes the tool entirely', () => {
    const { manager: m } = manager(['Agent']);
    assert.equal(m.isToolDisabled('Agent'), true);
  });
});

describe('plan mode entered by the model', () => {
  const names = (server: MockServer, i: number) => (server.requests[i]!.body.tools as { function: { name: string } }[]).map((t) => t.function.name);

  test('EnterPlanMode switches the session to plan mode and swaps the plan tools', async () => {
    const { ctl, server, dir } = await setup([
      { toolCalls: [{ name: 'EnterPlanMode', arguments: {} }] },
      { toolCalls: [{ name: 'Write', arguments: { file_path: 'x.txt', content: 'x' } }] },
      { text: 'Here is my plan.' },
    ]);
    await collect(ctl.submit('refactor the whole thing'));
    assert.equal(ctl.permissions.mode, 'plan');
    assert.ok(names(server, 0).includes('EnterPlanMode') && !names(server, 0).includes('ExitPlanMode'));
    assert.ok(names(server, 1).includes('ExitPlanMode') && !names(server, 1).includes('EnterPlanMode'));
    assert.match(lastMessage(server.requests[1]!, 'tool').content, /Plan mode is on/);
    // And plan mode is real: the write that followed was refused.
    assert.match(lastMessage(server.requests[2]!, 'tool').content, /Plan mode is active/);
    assert.ok(!fs.existsSync(path.join(dir, 'x.txt')));
    assert.match(String(server.requests[1]!.body.messages[0].content), /Plan mode is active/);
  });

  test('it is not offered when the session never asks for approval', async () => {
    const { ctl, server } = await setup([{ text: 'ok' }], { overrides: { permissions: { defaultMode: 'bypassPermissions' } } });
    await collect(ctl.submit('hi'));
    assert.ok(!names(server, 0).includes('EnterPlanMode'));
    assert.equal(ctl.enterPlanMode(), false);
  });
});

describe('tool output limit scaled to the context window', () => {
  test('a small window gets a proportionally small limit', async () => {
    const { ctl } = await setup([{ text: 'ok' }], { overrides: { contextWindow: 8192 } });
    assert.equal(ctl.settings.maxToolOutputChars, Math.floor(8192 * 3.5 * 0.2));
  });

  test('a large window keeps the 30,000-character default', async () => {
    const { ctl } = await setup([{ text: 'ok' }], { overrides: { contextWindow: 131072 } });
    assert.equal(ctl.settings.maxToolOutputChars, 30_000);
  });

  test('a limit the user set is left alone', async () => {
    const { ctl } = await setup([{ text: 'ok' }], { overrides: { contextWindow: 8192, maxToolOutputChars: 50_000 } });
    assert.equal(ctl.settings.maxToolOutputChars, 50_000);
  });

  test('the limit follows a model switch', async () => {
    const { ctl } = await setup([{ text: 'ok' }], { ollama: true, server: { models: ['small', 'big'], contextLength: 131072 }, overrides: { contextWindow: 8192 } });
    const before = ctl.settings.maxToolOutputChars;
    ctl.settings.contextWindow = 65536;
    await ctl.setModel('big');
    assert.ok(ctl.settings.maxToolOutputChars! > before!);
  });
});

describe('slash commands added for parity', () => {
  test('/rename names the session and it can be found by that name', async () => {
    const { ctl, dir } = await setup([{ text: 'ok' }]);
    await collect(ctl.submit('start'));
    const io = fakeIO();
    await runSlash('/rename payment refactor', ctl, io);
    assert.match(io.out[0]!, /Session named payment refactor/);
    assert.equal(listSessions(dir)[0]!.title, 'payment refactor');
    assert.equal(loadSession(ctl.transcript.path).title, 'payment refactor');
  });

  test('a name given before the first message is kept once the transcript exists', async () => {
    const { ctl, dir } = await setup([{ text: 'ok' }], { sessionName: 'early' });
    assert.equal(listSessions(dir).length, 0);
    await collect(ctl.submit('start'));
    assert.equal(listSessions(dir)[0]!.title, 'early');
  });

  test('/branch continues in a new session and leaves the original resumable', async () => {
    const { ctl, server, dir } = await setup([{ text: 'one' }, { text: 'two' }]);
    await collect(ctl.submit('first'));
    const original = ctl.session.id;
    const io = fakeIO();
    await runSlash('/branch experiment', ctl, io);
    assert.notEqual(ctl.session.id, original);
    assert.match(io.out[0]!, new RegExp(`--resume ${original}`));
    await collect(ctl.submit('second'));
    assert.deepEqual((server.requests[1]!.body.messages as { content: string }[]).map((m) => m.content).slice(1), ['first', 'one', 'second']);
    const sessions = listSessions(dir);
    assert.equal(sessions.length, 2);
    assert.equal(sessions.find((s) => s.id === original)!.messageCount, 2, 'the original did not grow');
    assert.equal(sessions.find((s) => s.id !== original)!.title, 'experiment');
  });

  test('/cd moves the working directory, adding it when outside the project', async () => {
    const { ctl, dir } = await setup([], { files: { 'pkg/a.txt': '' } });
    const io = fakeIO();
    await runSlash('/cd pkg', ctl, io);
    assert.equal(ctl.session.cwd, path.join(dir, 'pkg'));
    const outside = tempProject();
    await runSlash(`/cd ${outside}`, ctl, io);
    assert.equal(ctl.session.cwd, outside);
    assert.ok(ctl.session.inWorkingDirs(path.join(outside, 'x.txt')));
    await runSlash('/cd does-not-exist', ctl, io);
    assert.match(io.out.at(-1)!, /is not a directory/);
    assert.equal(ctl.session.cwd, outside);
  });

  test('/copy <file> saves the last reply', async () => {
    const { ctl, dir } = await setup([{ text: 'The answer is 42.' }]);
    const io = fakeIO();
    await runSlash('/copy out.md', ctl, io);
    assert.match(io.out[0]!, /no reply to copy/);
    await collect(ctl.submit('q'));
    await runSlash('/copy out.md', ctl, io);
    assert.equal(fs.readFileSync(path.join(dir, 'out.md'), 'utf8'), 'The answer is 42.\n');
  });

  test('/diff shows uncommitted changes and new files', async () => {
    const { ctl, dir } = await setup([], { files: { 'a.txt': 'one\n' } });
    const io = fakeIO();
    await runSlash('/diff', ctl, io);
    assert.match(io.out[0]!, /Not a git repository/);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', 'a.txt');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'init');
    await runSlash('/diff', ctl, io);
    assert.match(io.out.at(-1)!, /No uncommitted changes/);
    writeFiles(dir, { 'a.txt': 'two\n', 'new.txt': 'n\n' });
    await runSlash('/diff', ctl, io);
    assert.match(io.out.at(-1)!, /Uncommitted changes[\s\S]*a\.txt[\s\S]*New files\n {2}new\.txt[\s\S]*-one\n\+two/);
  });

  test('/btw answers from the session without adding to it', async () => {
    const { ctl, server } = await setup([{ text: 'We are fixing the parser.' }, { text: 'The parser, in src/parser.ts.' }]);
    await collect(ctl.submit('fix the parser in src/parser.ts'));
    const before = ctl.agent.messages.length;
    const io = fakeIO();
    await runSlash('/btw which file are we changing?', ctl, io);
    assert.equal(io.out[0], 'The parser, in src/parser.ts.');
    assert.equal(ctl.agent.messages.length, before, 'the side question is not part of the conversation');
    const side = server.requests[1]!.body;
    assert.equal(side.tools, undefined);
    assert.match(lastMessage(server.requests[1]!, 'user').content, /fix the parser in src\/parser\.ts[\s\S]*Side question: which file are we changing\?/);
  });

  test('/recap summarises without changing the conversation', async () => {
    const { ctl } = await setup([{ text: 'Done.' }, { text: '- Asked to fix the parser\n- Done' }]);
    const io = fakeIO();
    await runSlash('/recap', ctl, io);
    assert.match(io.out[0]!, /Nothing has happened yet/);
    await collect(ctl.submit('fix the parser'));
    const before = ctl.agent.messages.length;
    await runSlash('/recap', ctl, io);
    assert.match(io.out.at(-1)!, /Asked to fix the parser/);
    assert.equal(ctl.agent.messages.length, before);
  });

  test('/autocompact switches compaction and sets its threshold', async () => {
    const { ctl } = await setup([]);
    const io = fakeIO();
    await runSlash('/autocompact off', ctl, io);
    assert.equal(ctl.settings.autoCompact, false);
    await runSlash('/autocompact 60%', ctl, io);
    assert.equal(ctl.settings.autoCompact, true);
    assert.equal(ctl.settings.compactThreshold, 0.6);
    assert.match(io.out.at(-1)!, /on \(at 60% of the usable context\)/);
    await runSlash('/autocompact sometimes', ctl, io);
    assert.match(io.out.at(-1)!, /Usage: \/autocompact/);
  });

  test('/reload-skills picks up files created during the session', async () => {
    const { ctl, dir } = await setup([]);
    assert.equal(ctl.skillDefs.length, 0);
    writeFiles(dir, { '.coco/skills/lint/SKILL.md': '---\ndescription: Lint the code\n---\nRun the linter.' });
    const io = fakeIO();
    await runSlash('/reload-skills', ctl, io);
    assert.equal(ctl.skillDefs.length, 1);
    assert.match(io.out[0]!, /Reloaded: 1 skill/);
  });

  test('/security-review and /effort', async () => {
    const { ctl } = await setup([]);
    const review = await runSlash('/security-review', ctl, fakeIO());
    assert.ok(review && review.type === 'prompt' && /security problems/.test(review.prompt));
    await runSlash('/effort high', ctl, fakeIO());
    assert.equal(ctl.settings.thinking, 'high');
  });
});

describe('instruction files beyond the project root file', () => {
  test('nested instruction files and path-scoped rules arrive when a matching file is touched, once', async () => {
    const { ctl, server } = await setup(
      [
        { toolCalls: [{ name: 'Read', arguments: { file_path: 'api/handlers/user.ts' } }] },
        { toolCalls: [{ name: 'Read', arguments: { file_path: 'api/handlers/order.ts' } }] },
        { toolCalls: [{ name: 'Read', arguments: { file_path: 'README.md' } }] },
        { text: 'done' },
      ],
      {
        files: {
          'COCO.md': 'Root instructions.',
          'api/COCO.md': 'API code never logs request bodies.',
          '.coco/rules/style.md': 'Always-on rule: use tabs.',
          '.coco/rules/handlers.md': '---\npaths:\n  - "api/handlers/**"\n---\nHandlers must validate input with zod.',
          'api/handlers/user.ts': 'export const user = 1;\n',
          'api/handlers/order.ts': 'export const order = 1;\n',
          'README.md': '# Readme\n',
          'node_modules/dep/AGENTS.md': 'Instructions from a dependency.',
        },
      },
    );
    await collect(ctl.submit('look around'));
    const system = String(server.requests[0]!.body.messages[0].content);
    assert.match(system, /Root instructions\./);
    assert.match(system, /Always-on rule: use tabs\./);
    assert.ok(!system.includes('never logs request bodies'), 'nested files are not loaded up front');
    assert.ok(!system.includes('validate input with zod'), 'path-scoped rules are not loaded up front');

    const results = (i: number) => (server.requests[i]!.body.messages as { role: string; content: string }[]).filter((m) => m.role === 'tool').map((m) => m.content);
    const first = results(1)[0]!;
    assert.match(first, /export const user = 1;[\s\S]*API code never logs request bodies\.[\s\S]*Handlers must validate input with zod\./);
    // The same instructions are not repeated for the next file in that directory, nor for unrelated files.
    const second = results(2)[1]!;
    assert.ok(!second.includes('never logs') && !second.includes('zod'));
    assert.ok(!results(3)[2]!.includes('never logs'));
    // The system prompt did not change mid-session (a local server would have to re-read all of it).
    assert.equal(String(server.requests[3]!.body.messages[0].content), system);
  });

  test('instruction files inside dependencies are never delivered, and claudeMdExcludes adds to that', async () => {
    const { ctl, server } = await setup([{ toolCalls: [{ name: 'Read', arguments: { file_path: 'node_modules/dep/index.js' } }, { name: 'Read', arguments: { file_path: 'legacy/old.js' } }] }, { text: 'ok' }], {
      files: {
        'node_modules/dep/AGENTS.md': 'Instructions from a dependency.',
        'node_modules/dep/index.js': 'module.exports = 1;\n',
        'legacy/COCO.md': 'Legacy instructions nobody wants.',
        'legacy/old.js': 'var x;\n',
      },
      overrides: { claudeMdExcludes: ['**/legacy/**'] },
    });
    await collect(ctl.submit('read'));
    const tool = (server.requests[1]!.body.messages as { role: string; content: string }[]).filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
    assert.ok(!tool.includes('Instructions from a dependency'));
    assert.ok(!tool.includes('Legacy instructions'));
  });

  test('auto memory: the index is in the prompt, and its directory is editable without approval', async () => {
    const dir = tempProject();
    const { autoMemoryDir } = await import('../src/memory/autoMemory.ts');
    const memDir = autoMemoryDir(dir);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- The test command is make check\n');
    const server = await startMockServer([
      { toolCalls: [{ name: 'Read', arguments: { file_path: path.join(memDir, 'MEMORY.md') } }] },
      { toolCalls: [{ name: 'Edit', arguments: { file_path: path.join(memDir, 'MEMORY.md'), old_string: 'make check', new_string: 'make test' } }, { name: 'Write', arguments: { file_path: path.join(dir, 'project.txt'), content: 'x' } }] },
      { text: 'noted' },
    ]);
    servers.push(server);
    const ctl = new Controller({ cwd: dir, interactive: false, overrides: { baseUrl: server.url, model: 'mock-model' } });
    controllers.push(ctl);
    await ctl.connect();
    await collect(ctl.submit('remember that'));
    assert.match(String(server.requests[0]!.body.messages[0].content), /The test command is make check/);
    // Headless, nobody can approve anything: the memory edit went through, the project write did not.
    assert.equal(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8'), '- The test command is make test\n');
    assert.ok(!fs.existsSync(path.join(dir, 'project.txt')));
  });

  test('auto memory can be switched off, and old-session cleanup never deletes it', async () => {
    const { ctl, dir } = await setup([{ text: 'ok' }], { overrides: { autoMemoryEnabled: false } });
    assert.ok(!/persistent notes|MEMORY\.md/.test(ctl.systemPrompt()));
    assert.equal(ctl.permissions.autoMemory, false);

    const { autoMemoryDir } = await import('../src/memory/autoMemory.ts');
    const { cleanupOldSessions } = await import('../src/session/store.ts');
    const memDir = autoMemoryDir(dir);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- keep me\n');
    const old = new Date(Date.now() - 90 * 86_400_000);
    fs.utimesSync(path.join(memDir, 'MEMORY.md'), old, old);
    fs.utimesSync(memDir, old, old);
    cleanupOldSessions(30);
    assert.equal(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8'), '- keep me\n');
  });
});

describe('bare mode and session options on the controller', () => {
  test('bare ignores everything user- or project-defined', async () => {
    const { ctl } = await setup([], {
      bare: true,
      files: {
        'COCO.md': 'Always answer in French.',
        '.coco/skills/x/SKILL.md': '---\ndescription: X\n---\nx',
        '.coco/commands/hi.md': 'Say hi',
        '.coco/agents/a.md': '---\nname: custom\ndescription: c\n---\nprompt',
        '.coco/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }),
      },
    });
    assert.equal(ctl.memory.length, 0);
    assert.equal(ctl.skillDefs.length, 0);
    assert.equal(ctl.commands.length, 0);
    assert.deepEqual(ctl.agentDefs.map((a) => a.name).sort(), ['explore', 'general-purpose', 'plan']);
    assert.equal(ctl.hooks.has('Stop'), false);
    assert.ok(!ctl.systemPrompt().includes('French'));
  });

  test('disableAllHooks turns hooks off without removing them', async () => {
    const { ctl } = await setup([], {
      files: { '.coco/settings.json': JSON.stringify({ disableAllHooks: true, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }) },
    });
    assert.equal(ctl.hooks.has('Stop'), false);
    assert.equal(ctl.settings.hooks?.Stop?.length, 1);
  });

  test('a session can be given a specific id', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const { ctl } = await setup([{ text: 'ok' }], { sessionId: id });
    await collect(ctl.submit('hi'));
    assert.equal(ctl.session.id, id);
    assert.equal(path.basename(ctl.transcript.path), `${id}.jsonl`);
  });
});

describe('headless structured output and streamed input', () => {
  const CLI = path.join(import.meta.dirname, '..', 'bin', 'coco.js');
  const SCHEMA = JSON.stringify({ type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, count: { type: 'number' } }, required: ['files', 'count'] });

  /** Run the real CLI against a mock server. */
  function cli(dir: string, server: MockServer, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const env = { ...process.env, COCO_CONFIG_DIR: path.join(dir, '.coco-home'), CLAUDE_CONFIG_DIR: path.join(dir, '.claude-home'), NO_COLOR: '1' };
      const child = spawn('node', [CLI, ...args, '--base-url', server.url, '--model', 'mock-model'], { cwd: dir, env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (d) => (stdout += d));
      child.stderr!.on('data', (d) => (stderr += d));
      if (stdin !== undefined) child.stdin!.end(stdin);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  async function mock(script: Script): Promise<MockServer> {
    const server = await startMockServer(script);
    servers.push(server);
    return server;
  }

  test('--json-schema sends a reply of the wrong shape back until it matches', async () => {
    const server = await mock([{ text: 'I found two files.' }, { text: '```json\n{"files": ["a.ts", "b.ts"], "count": "2"}\n```' }]);
    const res = await cli(tempProject(), server, ['-p', 'list files', '--output-format', 'json', '--json-schema', SCHEMA]);
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.structured_output, { files: ['a.ts', 'b.ts'], count: 2 });
    assert.equal(out.result, '{"files":["a.ts","b.ts"],"count":2}');
    // The schema is in the system prompt, and the correction names what was wrong.
    assert.match(String(server.requests[0]!.body.messages[0].content), /final message must be a single JSON value[\s\S]*"required":\["files","count"\]/);
    assert.match(lastMessage(server.requests[1]!, 'user').content, /Problem: the reply is not valid JSON/);
  });

  test('--json-schema gives up with an error when the model never complies', async () => {
    const server = await mock([{ text: '{"files": []}' }, { text: '{"files": []}' }, { text: '{"files": []}' }]);
    const res = await cli(tempProject(), server, ['-p', 'list files', '--json-schema', SCHEMA]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /did not match --json-schema: .*count/);
    assert.equal(server.requests.length, 3);
    assert.equal(res.stdout, '');
  });

  test('--input-format stream-json runs one turn per user message in the same session', async () => {
    const server = await mock([{ text: 'first answer' }, { text: 'second answer' }]);
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'question one' } }),
      'not json',
      JSON.stringify({ type: 'control_request', request: {} }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'question two' }] } }),
    ];
    const res = await cli(tempProject(), server, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'], `${lines.join('\n')}\n`);
    assert.equal(res.code, 0, res.stderr);
    const events = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.type === 'system' && e.subtype === 'init').length, 1);
    assert.deepEqual(events.filter((e) => e.type === 'result').map((e) => e.result), ['first answer', 'second answer']);
    assert.equal(new Set(events.filter((e) => e.type === 'result').map((e) => e.session_id)).size, 1);
    // The second turn carries the first as history.
    const second = (server.requests[1]!.body.messages as { role: string; content: string }[]).filter((m) => m.role !== 'system').map((m) => m.content);
    assert.deepEqual(second, ['question one', 'first answer', 'question two']);
    assert.match(res.stderr, /Ignored input line: not valid JSON/);
    const mismatch = await cli(tempProject(), server, ['-p', '--input-format', 'stream-json'], '');
    assert.match(mismatch.stderr, /needs --output-format stream-json/);
  });

  test('--setting-sources chooses which settings files apply', async () => {
    const dir = tempProject();
    writeFiles(dir, {
      '.coco/settings.json': JSON.stringify({ outputStyle: 'explanatory' }),
      '.coco/settings.local.json': JSON.stringify({ maxRetries: 3 }),
    });
    const all = new Controller({ cwd: dir, interactive: false });
    const projectOnly = new Controller({ cwd: dir, interactive: false, settingSources: ['project'] });
    const none = new Controller({ cwd: dir, interactive: false, settingSources: [] });
    controllers.push(all, projectOnly, none);
    assert.deepEqual([all.settings.outputStyle, all.settings.maxRetries], ['explanatory', 3]);
    assert.deepEqual([projectOnly.settings.outputStyle, projectOnly.settings.maxRetries], ['explanatory', undefined]);
    assert.deepEqual([none.settings.outputStyle, none.settings.maxRetries], [undefined, undefined]);
    const server = await mock([]);
    assert.match((await cli(dir, server, ['-p', 'x', '--setting-sources', 'user,everything'])).stderr, /--setting-sources takes user, project and local/);
  });

  test('--agents defines an agent and --agent runs the session as it', async () => {
    const server = await mock([{ text: 'sorted' }]);
    const agents = JSON.stringify({ triage: { description: 'Sorts issues', prompt: 'You sort issues.', tools: ['Read', 'Grep'] } });
    const res = await cli(tempProject(), server, ['-p', 'go', '--agents', agents, '--agent', 'triage']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(String(server.requests[0]!.body.messages[0].content), /^You sort issues\./);
    assert.deepEqual((server.requests[0]!.body.tools as { function: { name: string } }[]).map((t) => t.function.name).sort(), ['Grep', 'Read']);
    assert.match((await cli(tempProject(), server, ['-p', 'go', '--agents', '{not json'])).stderr, /--agents: /);
    assert.match((await cli(tempProject(), server, ['-p', 'go', '--agent', 'ghost'])).stderr, /No agent named "ghost"/);
  });
});
