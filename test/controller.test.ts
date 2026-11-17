import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { AgentEvent } from '../src/agent/loop.ts';
import type { CommandIO } from '../src/commands/builtin.ts';
import { allCommands, runSlash } from '../src/commands/builtin.ts';
import { Controller, matchModel, type ControllerOptions } from '../src/core/controller.ts';
import { listSessions, loadSession } from '../src/session/store.ts';
import { stripAnsi } from '../src/ui/ansi.ts';
import { tempProject, writeFiles } from './helpers.ts';
import { lastMessage, startMockServer, type MockServer, type Script } from './mock-server.ts';

let servers: MockServer[] = [];
let controllers: Controller[] = [];

afterEach(async () => {
  for (const c of controllers) await c.shutdown();
  for (const s of servers) await s.close();
  servers = [];
  controllers = [];
});

async function setup(script: Script, opts: Partial<ControllerOptions> & { files?: Record<string, string>; dir?: string; connect?: boolean } = {}) {
  const dir = opts.dir ?? tempProject();
  if (opts.files) writeFiles(dir, opts.files);
  const server = await startMockServer(script);
  servers.push(server);
  const { files: _f, dir: _d, connect, ...rest } = opts;
  const ctl = new Controller({
    cwd: dir,
    interactive: false,
    ...rest,
    overrides: { baseUrl: server.url, model: 'mock-model', ...(rest.overrides ?? {}) },
  });
  controllers.push(ctl);
  if (connect !== false) await ctl.connect();
  return { ctl, server, dir };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function fakeIO(answers: unknown[] = []): CommandIO & { out: string[]; input: string } {
  const io = {
    out: [] as string[],
    input: '',
    print: (text: string) => void io.out.push(stripAnsi(text)),
    width: () => 100,
    select: async () => answers.shift() as never,
    editFile: async () => {},
    clearScreen: () => {},
    exit: () => {},
    showHistory: () => {},
    toggleVerbose: () => true,
    setInput: (text: string) => void (io.input = text),
  };
  return io;
}

describe('connecting', () => {
  test('uses the configured model and reports its profile', async () => {
    const { ctl } = await setup([{ text: 'hi' }]);
    assert.equal(ctl.client.model, 'mock-model');
    assert.equal(ctl.client.profile.toolMode, 'native');
    assert.ok(ctl.client.profile.contextWindow >= 8192);
  });

  test('a model the server does not have is rejected with the alternatives', async () => {
    const { ctl } = await setup([], { overrides: { model: 'nope' }, connect: false });
    await assert.rejects(() => ctl.connect(), /Model "nope" was not found[\s\S]*mock-model/);
  });

  test('with no model configured, the picker is asked when there is a choice', async () => {
    const dir = tempProject();
    const server = await startMockServer([{ text: 'hi' }], { models: ['alpha', 'beta'] });
    servers.push(server);
    const ctl = new Controller({ cwd: dir, interactive: true, overrides: { baseUrl: server.url } });
    controllers.push(ctl);
    let offered: string[] = [];
    await ctl.connect(async (models) => {
      offered = models.map((m) => m.id);
      return 'beta';
    });
    assert.deepEqual(offered.sort(), ['alpha', 'beta']);
    assert.equal(ctl.client.model, 'beta');
  });

  test('matchModel understands Ollama tags and case', () => {
    const available = [{ id: 'qwen3:latest' }, { id: 'Llama-3' }];
    assert.equal(matchModel('qwen3', available), 'qwen3:latest');
    assert.equal(matchModel('llama-3', available), 'Llama-3');
    assert.equal(matchModel('other', available), undefined);
  });
});

describe('prompts', () => {
  test('@mentions attach file contents and mark the file as read', async () => {
    const { ctl, server, dir } = await setup([{ text: 'seen' }], { files: { 'notes.md': '# Notes\nremember the milk\n', 'src/x.ts': 'x' } });
    await collect(ctl.submit('summarise @notes.md and list @src please'));
    const sent = lastMessage(server.requests[0]!, 'user').content as string;
    assert.match(sent, /<file path="notes\.md">\n# Notes\nremember the milk/);
    assert.match(sent, /<directory path="src">\nx\.ts/);
    assert.ok(ctl.session.readFiles.has(path.join(dir, 'notes.md')));
    const stored = ctl.agent.messages[0] as { display?: string; turn?: number };
    assert.equal(stored.display, 'summarise @notes.md and list @src please');
    assert.equal(stored.turn, 1);
  });

  test('an @word that is not a path is left alone', async () => {
    const { ctl, server } = await setup([{ text: 'ok' }]);
    await collect(ctl.submit('ping @alice about it'));
    assert.equal(lastMessage(server.requests[0]!, 'user').content, 'ping @alice about it');
  });

  test('a UserPromptSubmit hook can add context or block the prompt', async () => {
    const dir = tempProject();
    writeFiles(dir, {
      '.coco/settings.json': JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'grep -q forbidden && { echo "not allowed" >&2; exit 2; } || echo "branch is main"' }] }] },
      }),
    });
    const { ctl, server } = await setup([{ text: 'ok' }], { dir });
    await collect(ctl.submit('hello'));
    assert.match(lastMessage(server.requests[0]!, 'user').content, /hello\n\n<hook-context>\nbranch is main/);
    const events = await collect(ctl.submit('something forbidden'));
    assert.ok(events.some((e) => e.type === 'notice' && /not allowed/.test(e.text)));
    assert.equal(server.requests.length, 1);
  });

  test('memory files reach the system prompt', async () => {
    const { ctl, server } = await setup([{ text: 'ok' }], { files: { 'COCO.md': 'Always answer in French.', 'CLAUDE.md': 'Use pnpm.' } });
    await collect(ctl.submit('hi'));
    const system = server.requests[0]!.body.messages[0].content as string;
    assert.match(system, /Always answer in French/);
    assert.match(system, /Use pnpm/);
    assert.equal(ctl.memory.length, 2);
  });
});

describe('tool set', () => {
  const names = (server: MockServer, i = 0) => (server.requests[i]!.body.tools as { function: { name: string } }[]).map((t) => t.function.name);

  test('tools that cannot apply are not sent, saving context', async () => {
    // Compat off so skills in the developer's own ~/.claude do not count as installed here.
    const { ctl, server } = await setup([{ text: 'a' }, { text: 'b' }], { overrides: { claudeCompat: false } });
    await collect(ctl.submit('hi'));
    assert.ok(!names(server).includes('ExitPlanMode'));
    assert.ok(!names(server).includes('Skill'));
    assert.ok(!names(server).includes('NotebookEdit'));
    assert.ok(names(server).includes('Edit') && names(server).includes('Agent'));
    // Entering plan mode brings the plan tool in.
    ctl.setMode('plan');
    await collect(ctl.submit('plan something'));
    assert.ok(names(server, 1).includes('ExitPlanMode'));
  });

  test('skills and notebooks bring their tools with them', async () => {
    const { ctl, server } = await setup([{ text: 'a' }], {
      files: { 'analysis.ipynb': '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}', '.coco/skills/x/SKILL.md': '---\ndescription: X\n---\nDo x.' },
    });
    await collect(ctl.submit('hi'));
    assert.ok(names(server).includes('Skill'));
    assert.ok(names(server).includes('NotebookEdit'));
  });

  test('--tools restricts the set', async () => {
    const { ctl, server } = await setup([{ text: 'a' }], { toolFilter: ['Read', 'grep'] });
    await collect(ctl.submit('hi'));
    assert.deepEqual(names(server).sort(), ['Grep', 'Read']);
  });
});

describe('subagents', () => {
  test('the Agent tool runs a nested agent with its own context and returns its report', async () => {
    const { ctl, server } = await setup(
      (req) => {
        const system = String(req.body.messages[0].content);
        const isSub = /read-only search subagent/.test(system);
        const toolResults = (req.body.messages as { role: string }[]).filter((m) => m.role === 'tool').length;
        if (isSub) return toolResults === 0 ? { toolCalls: [{ name: 'Grep', arguments: { pattern: 'needle' } }] } : { text: 'Found needle in hay.txt:1' };
        return toolResults === 0
          ? { toolCalls: [{ name: 'Agent', arguments: { description: 'find needle', prompt: 'Find the needle.', subagent_type: 'explore' } }] }
          : { text: 'The needle is in hay.txt.' };
      },
      { files: { 'hay.txt': 'needle here\n' } },
    );
    const events = await collect(ctl.submit('where is the needle?'));
    assert.equal(ctl.agent.lastAssistantText(), 'The needle is in hay.txt.');
    const sub = server.requests.filter((r) => /read-only search subagent/.test(String(r.body.messages[0].content)));
    assert.equal(sub.length, 2);
    // The subagent sees only its prompt, has no Agent tool, and only the tools its definition allows.
    assert.equal(sub[0]!.body.messages[1].content, 'Find the needle.');
    const subTools = (sub[0]!.body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    assert.ok(!subTools.includes('Agent') && !subTools.includes('Edit') && subTools.includes('Grep'));
    const agentResult = events.find((e) => e.type === 'tool_end' && e.call.name === 'Agent') as Extract<AgentEvent, { type: 'tool_end' }>;
    assert.match(agentResult.result.content, /Found needle in hay\.txt:1/);
    assert.ok(events.some((e) => e.type === 'tool_progress' && /Grep/.test(e.text)));
  });

  test('custom agents are loaded from .coco/agents and .claude/agents', async () => {
    const { ctl } = await setup([], {
      files: {
        '.coco/agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\n---\nYou review code.',
        '.claude/agents/legacy.md': '---\ndescription: From Claude Code\nmodel: sonnet\n---\nLegacy prompt.',
      },
    });
    const reviewer = ctl.agentDefs.find((a) => a.name === 'reviewer')!;
    assert.deepEqual(reviewer.tools, ['Read', 'Grep']);
    const legacy = ctl.agentDefs.find((a) => a.name === 'legacy')!;
    assert.equal(legacy.model, undefined);
    assert.ok(ctl.agentTypes().some((a) => a.name === 'general-purpose'));
  });
});

describe('sessions', () => {
  test('a conversation can be resumed in a new process', async () => {
    const first = await setup([{ toolCalls: [{ name: 'Read', arguments: { file_path: 'a.txt' } }] }, { text: 'It says alpha.' }], { files: { 'a.txt': 'alpha\n' } });
    await collect(first.ctl.submit('what is in a.txt?'));
    const sessions = listSessions(first.dir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.firstPrompt, 'what is in a.txt?');

    const second = await setup([{ text: 'As I said: alpha.' }], { dir: first.dir, connect: false });
    second.ctl.resume(sessions[0]!);
    await second.ctl.connect();
    assert.equal(second.ctl.session.id, first.ctl.session.id);
    assert.equal(second.ctl.agent.messages.length, 4);
    await collect(second.ctl.submit('repeat that'));
    const roles = (second.server.requests[0]!.body.messages as { role: string }[]).map((m) => m.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    assert.equal(loadSession(sessions[0]!.path).messages.length, 6);
    assert.equal(second.ctl.session.turn, 2);
  });

  test('/clear starts a new session and keeps the old transcript', async () => {
    const { ctl, dir } = await setup([{ text: 'one' }, { text: 'two' }]);
    await collect(ctl.submit('first'));
    const oldId = ctl.session.id;
    await runSlash('/clear', ctl, fakeIO());
    assert.notEqual(ctl.session.id, oldId);
    assert.equal(ctl.agent.messages.length, 0);
    await collect(ctl.submit('second'));
    assert.equal(listSessions(dir).length, 2);
  });

  test('--no-session-persistence writes nothing', async () => {
    const { ctl, dir } = await setup([{ text: 'one' }], { persist: false });
    await collect(ctl.submit('first'));
    assert.equal(listSessions(dir).length, 0);
  });

  test('rewind restores files and drops later messages', async () => {
    const { ctl, dir } = await setup(
      [
        { toolCalls: [{ name: 'Write', arguments: { file_path: 'new.txt', content: 'v1\n' } }] },
        { text: 'created' },
        { toolCalls: [{ name: 'Read', arguments: { file_path: 'keep.txt' } }] },
        { toolCalls: [{ name: 'Edit', arguments: { file_path: 'keep.txt', old_string: 'original', new_string: 'changed' } }, { name: 'Write', arguments: { file_path: 'second.txt', content: 'x' } }] },
        { text: 'edited' },
      ],
      { files: { 'keep.txt': 'original\n' }, overrides: { permissions: { defaultMode: 'acceptEdits' } } },
    );
    await collect(ctl.submit('make new.txt'));
    await collect(ctl.submit('now change keep.txt'));
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'changed\n');
    const points = ctl.rewindPoints();
    assert.deepEqual(points.map((p) => p.text), ['make new.txt', 'now change keep.txt']);
    assert.equal(points[1]!.filesChanged, 2);

    const res = ctl.rewind(points[1]!.turn, { conversation: true, code: true });
    assert.equal(res.prompt, 'now change keep.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'original\n');
    assert.ok(!fs.existsSync(path.join(dir, 'second.txt')));
    assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'v1\n');
    assert.equal(ctl.agent.messages.length, 4);
    // The rewind survives a reload of the transcript.
    assert.equal(loadSession(ctl.transcript.path).messages.length, 4);

    ctl.rewind(points[0]!.turn, { conversation: false, code: true });
    assert.ok(!fs.existsSync(path.join(dir, 'new.txt')));
    assert.equal(ctl.agent.messages.length, 4);
  });
});

describe('slash commands', () => {
  test('custom commands expand arguments and permitted inline shell', async () => {
    const { ctl, server } = await setup([{ text: 'reviewed' }], {
      files: {
        '.coco/commands/greet.md': '---\ndescription: Say hi\nargument-hint: <name>\nallowed-tools: Bash(echo:*)\n---\nGreet $1 warmly. Today: !`echo sunny`. Secret: !`cat /etc/hostname`.',
        '.claude/commands/git/sync.md': 'Sync the branch.',
      },
    });
    const names = allCommands(ctl).map((c) => c.name);
    assert.ok(names.includes('greet') && names.includes('git:sync') && names.includes('help'));
    const outcome = await runSlash('/greet "Ada Lovelace"', ctl, fakeIO());
    assert.ok(outcome && outcome.type === 'prompt');
    assert.equal(outcome.prompt, 'Greet Ada Lovelace warmly. Today: sunny. Secret: [command not permitted: cat /etc/hostname].');
    assert.deepEqual(outcome.allowedTools, ['Bash(echo:*)']);
    await collect(ctl.submit(outcome.prompt, { display: outcome.display }));
    assert.match(lastMessage(server.requests[0]!, 'user').content, /Greet Ada Lovelace/);
  });

  test('skills are listed to the model, loadable by tool and usable as commands', async () => {
    const { ctl, server } = await setup([{ toolCalls: [{ name: 'Skill', arguments: { skill: 'deploy' } }] }, { text: 'deployed' }], {
      files: { '.coco/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ship to production\n---\nRun make deploy, then check the logs.' },
    });
    await collect(ctl.submit('ship it'));
    assert.match(String(server.requests[0]!.body.messages[0].content), /- deploy: Ship to production/);
    assert.match(lastMessage(server.requests[1]!, 'tool').content, /Run make deploy, then check the logs/);
    const outcome = await runSlash('/deploy now', ctl, fakeIO());
    assert.ok(outcome && outcome.type === 'prompt');
    assert.match(outcome.prompt, /Run make deploy[\s\S]*Arguments: now/);
  });

  test('unknown commands are reported as unknown', async () => {
    const { ctl } = await setup([]);
    assert.deepEqual(await runSlash('/definitely-not-a-command', ctl, fakeIO()), { type: 'unknown', name: 'definitely-not-a-command' });
  });

  test('informational commands print something sensible', async () => {
    const { ctl } = await setup([{ text: 'hello', usage: { prompt: 1200, completion: 30 } }]);
    await collect(ctl.submit('hi'));
    for (const [command, pattern] of [
      ['/help', /Commands[\s\S]*\/compact[\s\S]*shift\+tab/],
      ['/context', /Context window[\s\S]*System prompt[\s\S]*Tool definitions[\s\S]*Messages/],
      ['/usage', /Requests\s+1[\s\S]*free/],
      ['/status', /mock-model[\s\S]*Permission mode\s+ask before edits/],
      ['/doctor', /coco doctor[\s\S]*✓ custom at http/],
      ['/agents', /general-purpose[\s\S]*explore/],
      ['/permissions', /Mode\s+ask before edits/],
      ['/todos', /No tasks/],
      ['/hooks', /No hooks configured/],
      ['/mcp', /No MCP servers configured/],
      ['/config', /Settings \(merged\)[\s\S]*"model": "mock-model"/],
    ] as const) {
      const io = fakeIO();
      await runSlash(command, ctl, io);
      assert.match(io.out.join('\n'), pattern, command);
    }
  });

  test('/permissions adds and removes rules that take effect', async () => {
    const { ctl, dir } = await setup([]);
    const io = fakeIO();
    await runSlash('/permissions allow Bash(npm test:*)', ctl, io);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.coco/settings.local.json'), 'utf8')).permissions.allow, ['Bash(npm test:*)']);
    assert.ok(ctl.permissions.rules().allow.some((r) => r.raw === 'Bash(npm test:*)'));
    await runSlash('/permissions remove Bash(npm test:*)', ctl, io);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.coco/settings.local.json'), 'utf8')).permissions.allow, []);
    await runSlash('/permissions allow not a rule!!', ctl, io);
    assert.match(io.out.at(-1)!, /Give a rule such as/);
  });

  test('/mode, /plan and /think change session state', async () => {
    const { ctl } = await setup([]);
    await runSlash('/mode acceptEdits', ctl, fakeIO());
    assert.equal(ctl.permissions.mode, 'acceptEdits');
    await runSlash('/plan', ctl, fakeIO());
    assert.equal(ctl.permissions.mode, 'plan');
    await runSlash('/plan', ctl, fakeIO());
    assert.equal(ctl.permissions.mode, 'default');
    const io = fakeIO();
    await runSlash('/mode nonsense', ctl, io);
    assert.match(io.out[0]!, /Unknown mode/);
    await runSlash('/think off', ctl, fakeIO());
    assert.equal(ctl.settings.thinking, false);
  });

  test('/export writes the conversation as Markdown', async () => {
    const { ctl, dir } = await setup([{ text: 'The answer is 42.' }]);
    await collect(ctl.submit('what is the answer?'));
    await runSlash('/export out.md', ctl, fakeIO());
    const md = fs.readFileSync(path.join(dir, 'out.md'), 'utf8');
    assert.match(md, /## User\n\nwhat is the answer\?[\s\S]*## Assistant\n\nThe answer is 42\./);
  });

  test('/compact and /init hand work back to the caller', async () => {
    const { ctl } = await setup([{ text: 'x' }]);
    assert.equal(await runSlash('/compact', ctl, fakeIO()), undefined);
    await collect(ctl.submit('hi'));
    assert.deepEqual(await runSlash('/compact keep the names', ctl, fakeIO()), { type: 'compact', instructions: 'keep the names' });
    const init = await runSlash('/init', ctl, fakeIO());
    assert.ok(init && init.type === 'prompt' && /COCO\.md/.test(init.prompt));
  });

  test('/model switches models and remembers the choice', async () => {
    const dir = tempProject();
    const server = await startMockServer([{ text: 'hi' }], { models: ['alpha', 'beta'] });
    servers.push(server);
    const ctl = new Controller({ cwd: dir, interactive: false, overrides: { baseUrl: server.url, model: 'alpha' } });
    controllers.push(ctl);
    await ctl.connect();
    const io = fakeIO();
    await runSlash('/model beta', ctl, io);
    assert.equal(ctl.client.model, 'beta');
    assert.match(io.out[0]!, /Model set to beta/);
    await collect(ctl.submit('hi'));
    assert.equal(server.requests[0]!.body.model, 'beta');
    assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.COCO_CONFIG_DIR!, 'settings.json'), 'utf8')).model, 'beta');
  });
});

describe('workspace trust', () => {
  test('project hooks and MCP servers count as running code, and can be switched off', async () => {
    const { ctl } = await setup([], {
      files: {
        '.coco/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] }, permissions: { deny: ['WebFetch'] } }),
        '.mcp.json': JSON.stringify({ mcpServers: { x: { command: 'true' } } }),
      },
      connect: false,
    });
    assert.equal(ctl.projectRunsCode(), true);
    assert.equal(ctl.isTrusted(), false);
    ctl.distrustProject();
    assert.equal(ctl.hooks.has('Stop'), false);
    // Restrictions from the project are still honoured.
    assert.deepEqual(ctl.settings.permissions?.deny, ['WebFetch']);
    await ctl.connectMcp();
    assert.equal(ctl.mcp, undefined);
    ctl.trustProject();
    assert.equal(ctl.isTrusted(), true);
  });

  test('a plain project needs no trust decision', async () => {
    const { ctl } = await setup([], { files: { 'COCO.md': 'hi' }, connect: false });
    assert.equal(ctl.projectRunsCode(), false);
  });
});
