import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from '../src/agent/loop.ts';
import { Agent } from '../src/agent/loop.ts';
import { CLEARED_RESULT, fitTranscript, microcompact, recentTail } from '../src/agent/compact.ts';
import { TokenCalibrator, estimateTokens, messagesTokens } from '../src/agent/tokens.ts';
import { buildSystemPrompt } from '../src/agent/systemPrompt.ts';
import type { HooksConfig, Settings } from '../src/config/settings.ts';
import { HookRunner } from '../src/hooks/hooks.ts';
import { PermissionManager } from '../src/permissions/manager.ts';
import { ModelClient, ProviderError } from '../src/providers/index.ts';
import type { ChatRequest, ModelProfile, Provider, StreamEvent } from '../src/providers/index.ts';
import { SessionState } from '../src/session/state.ts';
import { builtinTools } from '../src/tools/registry.ts';
import type { RuntimeHandle } from '../src/tools/types.ts';
import type { Message, PermissionMode, ToolCall, UserMessage } from '../src/types.ts';
import { tempProject, writeFiles } from './helpers.ts';

interface Turn {
  text?: string;
  thinking?: string;
  calls?: { name: string; args: Record<string, unknown>; parseError?: string }[];
  stop?: 'stop' | 'tool_calls' | 'length';
  throw?: Error;
  usage?: { input: number; output: number };
  /** Wait before finishing, so aborts can land mid-stream. */
  hangMs?: number;
}

class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly type = 'openai' as const;
  readonly baseUrl = 'fake://';
  requests: ChatRequest[] = [];
  private readonly script: Turn[] | ((req: ChatRequest, i: number) => Turn);

  constructor(script: Turn[] | ((req: ChatRequest, i: number) => Turn)) {
    this.script = script;
  }

  async *chat(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const i = this.requests.length;
    // Snapshot: the agent mutates its message array after the request.
    this.requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) as Message[] });
    const turn = typeof this.script === 'function' ? this.script(req, i) : (this.script[i] ?? { text: 'script exhausted' });
    if (turn.throw) throw turn.throw;
    if (turn.thinking) yield { type: 'thinking', text: turn.thinking };
    if (turn.text) {
      const half = Math.ceil(turn.text.length / 2);
      yield { type: 'text', text: turn.text.slice(0, half) };
      if (turn.hangMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, turn.hangMs);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new ProviderError('aborted', 'Request aborted'));
          });
        });
      }
      yield { type: 'text', text: turn.text.slice(half) };
    }
    let n = 0;
    for (const call of turn.calls ?? []) {
      const toolCall: ToolCall = { id: `call_${i}_${n++}`, name: call.name, arguments: call.args };
      if (call.parseError) toolCall.parseError = call.parseError;
      yield { type: 'tool_call', call: toolCall };
    }
    if (turn.usage) yield { type: 'usage', usage: { inputTokens: turn.usage.input, outputTokens: turn.usage.output } };
    yield { type: 'done', stopReason: turn.stop ?? (turn.calls?.length ? 'tool_calls' : 'stop') };
  }

  async listModels() {
    return [{ id: 'fake-model' }];
  }

  async modelInfo() {
    return { id: 'fake-model' };
  }
}

interface Harness {
  agent: Agent;
  provider: FakeProvider;
  session: SessionState;
  permissions: PermissionManager;
  dir: string;
  prompts: PermissionPrompt[];
  run(text: string, signal?: AbortSignal): Promise<AgentEvent[]>;
  toolResults(): Extract<Message, { role: 'tool' }>[];
}

interface HarnessOptions {
  mode?: PermissionMode;
  settings?: Settings;
  hooks?: HooksConfig;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** undefined = headless (no prompting possible). */
  answer?: (prompt: PermissionPrompt) => PermissionAnswer | Promise<PermissionAnswer>;
  maxTurns?: number;
  queued?: UserMessage[];
  files?: Record<string, string>;
  runtime?: Partial<RuntimeHandle>;
}

function harness(script: Turn[] | ((req: ChatRequest, i: number) => Turn), opts: HarnessOptions = {}): Harness {
  const dir = tempProject();
  writeFiles(dir, { 'a.txt': 'alpha\nbeta\ngamma\n', 'b.txt': 'one\ntwo\n', ...(opts.files ?? {}) });
  const settings: Settings = { ...(opts.settings ?? {}), hooks: opts.hooks };
  const session = new SessionState({ cwd: dir, settings });
  const permissions = new PermissionManager(session, { mode: opts.mode, settings: settings.permissions });
  const hooks = new HookRunner(() => settings.hooks, { sessionId: session.id, projectRoot: dir, cwd: () => session.cwd });
  const provider = new FakeProvider(script);
  const profile: ModelProfile = {
    contextWindow: opts.contextWindow ?? 32768,
    maxOutputTokens: opts.maxOutputTokens ?? 4096,
    toolMode: 'native',
    vision: false,
    notes: [],
  };
  const client = new ModelClient(provider, 'fake-model', profile, settings);
  const prompts: PermissionPrompt[] = [];
  const queued = [...(opts.queued ?? [])];
  const runtime: RuntimeHandle = {
    runSubagent: async () => ({ text: 'sub done', toolUses: 0, tokens: 0 }),
    agentTypes: () => [{ name: 'general-purpose', description: 'general' }],
    skills: () => [],
    loadSkill: () => undefined,
    ...opts.runtime,
  };
  const tools = builtinTools();
  const agent = new Agent({
    client,
    tools: () => tools,
    system: () => 'You are a test agent.',
    session,
    permissions,
    hooks,
    runtime,
    settings,
    depth: 0,
    maxTurns: opts.maxTurns,
    requestPermission: opts.answer
      ? async (p) => {
          prompts.push(p);
          return opts.answer!(p);
        }
      : undefined,
    drainQueued: () => queued.splice(0),
  });
  return {
    agent,
    provider,
    session,
    permissions,
    dir,
    prompts,
    async run(text, signal = new AbortController().signal) {
      const events: AgentEvent[] = [];
      for await (const ev of agent.run(text, signal)) events.push(ev);
      return events;
    },
    toolResults: () => agent.messages.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool'),
  };
}

const done = (events: AgentEvent[]) => events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done');
const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe('agent loop: basics', () => {
  test('a plain answer streams text and ends the turn', async () => {
    const h = harness([{ text: 'Hello there.' }]);
    const events = await h.run('hi');
    assert.equal(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), 'Hello there.');
    assert.equal(done(events)?.reason, 'stop');
    assert.deepEqual(h.agent.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(h.provider.requests[0]!.system, 'You are a test agent.');
    assert.ok(h.provider.requests[0]!.tools.some((t) => t.name === 'Read'));
  });

  test('a tool call is executed and its result is sent back', async () => {
    const h = harness([{ calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'It has three lines.' }]);
    const events = await h.run('read a.txt');
    assert.deepEqual(types(events).filter((t) => t.startsWith('tool_')), ['tool_start', 'tool_end']);
    const second = h.provider.requests[1]!.messages;
    const tool = second[second.length - 1] as Extract<Message, { role: 'tool' }>;
    assert.equal(tool.role, 'tool');
    assert.match(tool.content, /1\talpha/);
    assert.equal(tool.toolCallId, 'call_0_0');
    assert.equal(h.agent.lastAssistantText(), 'It has three lines.');
    assert.equal(h.agent.totals.toolUses, 1);
  });

  test('thinking is kept on the message but text is what counts', async () => {
    const h = harness([{ thinking: 'let me think', text: 'Answer.' }]);
    const events = await h.run('q');
    assert.ok(events.some((e) => e.type === 'thinking'));
    const assistant = h.agent.messages[1] as Extract<Message, { role: 'assistant' }>;
    assert.equal(assistant.thinking, 'let me think');
    assert.equal(assistant.content, 'Answer.');
  });

  test('stops at maxTurns', async () => {
    const h = harness(() => ({ calls: [{ name: 'Glob', args: { pattern: `*.${Math.random()}` } }] }), { maxTurns: 3 });
    const events = await h.run('loop');
    assert.equal(done(events)?.reason, 'max_turns');
    assert.equal(h.provider.requests.length, 3);
  });

  test('provider errors end the turn with the message', async () => {
    const h = harness([{ throw: new ProviderError('http', 'model exploded', 500) }]);
    const events = await h.run('hi');
    assert.equal(done(events)?.reason, 'error');
    assert.equal(done(events)?.error, 'model exploded');
  });
});

describe('agent loop: tool calls from weaker models', () => {
  test('unknown tools get an error naming the real ones', async () => {
    const h = harness([{ calls: [{ name: 'open_sesame', args: {} }] }, { text: 'ok' }]);
    await h.run('x');
    const result = h.toolResults()[0]!;
    assert.equal(result.isError, true);
    assert.match(result.content, /Unknown tool "open_sesame"/);
    assert.match(result.content, /Read/);
  });

  test('common aliases and wrong casing resolve to the right tool', async () => {
    const h = harness([
      { calls: [{ name: 'read_file', args: { file_path: 'a.txt' } }, { name: 'glob', args: { pattern: '*.txt' } }] },
      { text: 'ok' },
    ]);
    await h.run('x');
    const [read, glob] = h.toolResults();
    assert.match(read!.content, /alpha/);
    assert.equal(read!.name, 'Read');
    assert.match(glob!.content, /a\.txt/);
  });

  test('wrongly typed arguments are coerced', async () => {
    const h = harness([{ calls: [{ name: 'Read', args: { file_path: 'a.txt', offset: '2', limit: '1' } }] }, { text: 'ok' }]);
    await h.run('x');
    assert.match(h.toolResults()[0]!.content, /^\s+2\tbeta/);
  });

  test('missing required arguments come back as a fixable error', async () => {
    const h = harness([{ calls: [{ name: 'Read', args: { path: 'a.txt' } }] }, { text: 'ok' }]);
    await h.run('x');
    const result = h.toolResults()[0]!;
    assert.equal(result.isError, true);
    assert.match(result.content, /file_path/);
  });

  test('a tool can repair near-miss arguments before validation', async () => {
    let asked: unknown;
    const h = harness([{ calls: [{ name: 'AskUserQuestion', args: { questions: [{ question: 'Which DB?', options: ['Postgres', 'SQLite'] }] } }] }, { text: 'ok' }], {
      runtime: {
        askUser: async (questions) => {
          asked = questions;
          return { 'Which DB?': 'SQLite' };
        },
      },
    });
    await h.run('x');
    assert.deepEqual(asked, [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]);
    assert.match(h.toolResults()[0]!.content, /A: SQLite/);
  });

  test('shell output keeps multi-byte characters that straddle a read boundary', async () => {
    const h = harness([{ calls: [{ name: 'Bash', args: { command: "yes '€' | head -n 60000 | tr -d '\\n'" } }] }, { text: 'ok' }], {
      mode: 'bypassPermissions',
      settings: { maxToolOutputChars: 200_000 },
    });
    await h.run('x');
    const out = h.toolResults()[0]!.content;
    assert.ok(out.length >= 60_000, `expected the full output, got ${out.length} characters`);
    assert.ok(!out.includes(String.fromCodePoint(0xfffd)), 'no replacement characters');
  });

  test('unparseable arguments are reported, not executed', async () => {
    const h = harness([{ calls: [{ name: 'Bash', args: {}, parseError: 'arguments were not valid JSON: {"command": "ls' }] }, { text: 'ok' }]);
    await h.run('x');
    assert.match(h.toolResults()[0]!.content, /not valid JSON/);
  });

  test('the third identical call in a row is refused', async () => {
    let executed = 0;
    const h = harness((_, i) => (i < 4 ? { calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] } : { text: 'giving up' }));
    const events = await h.run('x');
    for (const r of h.toolResults()) if (/alpha/.test(r.content)) executed++;
    assert.equal(executed, 2);
    assert.match(h.toolResults()[2]!.content, /exact Read call 3 times in a row/);
    assert.equal(done(events)?.reason, 'stop');
  });

  test('an empty reply is retried once with a nudge, then reported', async () => {
    const h = harness([{ text: '' }, { text: '' }]);
    const events = await h.run('x');
    assert.equal(h.provider.requests.length, 2);
    const nudge = h.provider.requests[1]!.messages.at(-1) as UserMessage;
    assert.match(String(nudge.content), /last reply was empty/);
    assert.equal(done(events)?.reason, 'error');
  });

  test('a reply cut off before any answer is retried with a larger budget', async () => {
    const h = harness([{ thinking: 'thinking forever', stop: 'length' }, { text: 'Answer.' }], { maxOutputTokens: 1000 });
    const events = await h.run('x');
    assert.equal(h.provider.requests[1]!.maxTokens, 2000);
    assert.equal(done(events)?.reason, 'stop');
    assert.ok(events.some((e) => e.type === 'notice' && /output budget/.test(e.text)));
  });

  test('a truncated answer is kept and flagged', async () => {
    const h = harness([{ text: 'partial answ', stop: 'length' }]);
    const events = await h.run('x');
    assert.equal(h.agent.lastAssistantText(), 'partial answ');
    assert.ok(events.some((e) => e.type === 'notice' && /cut off/.test(e.text)));
  });
});

describe('agent loop: permissions', () => {
  test('headless: edits are refused, reads are not', async () => {
    const h = harness([
      { calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] },
      { calls: [{ name: 'Edit', args: { file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' } }] },
      { text: 'could not edit' },
    ]);
    await h.run('x');
    const [read, edit] = h.toolResults();
    assert.ok(!read!.isError);
    assert.equal(edit!.isError, true);
    assert.match(edit!.content, /Permission is required/);
    assert.equal(fs.readFileSync(path.join(h.dir, 'a.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
  });

  test('asking shows a diff preview and applies the edit when allowed', async () => {
    const h = harness(
      [
        { calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] },
        { calls: [{ name: 'Edit', args: { file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' } }] },
        { text: 'done' },
      ],
      { answer: () => ({ allow: true }) },
    );
    await h.run('x');
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0]!.request.kind, 'edit');
    assert.equal(h.prompts[0]!.diff?.after, 'ALPHA\nbeta\ngamma\n');
    assert.equal(fs.readFileSync(path.join(h.dir, 'a.txt'), 'utf8'), 'ALPHA\nbeta\ngamma\n');
  });

  test('declining with feedback tells the model and continues', async () => {
    const h = harness([{ calls: [{ name: 'Bash', args: { command: 'touch made.txt' } }] }, { text: 'understood' }], {
      answer: () => ({ allow: false, feedback: 'use mkdir instead' }),
    });
    const events = await h.run('x');
    assert.match(h.toolResults()[0]!.content, /use mkdir instead/);
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.provider.requests.length, 2);
    assert.ok(!fs.existsSync(path.join(h.dir, 'made.txt')));
  });

  test('declining without feedback stops the turn and skips later calls', async () => {
    const h = harness(
      [{ calls: [{ name: 'Bash', args: { command: 'touch one.txt' } }, { name: 'Bash', args: { command: 'touch two.txt' } }] }, { text: 'never reached' }],
      { answer: () => ({ allow: false }) },
    );
    const events = await h.run('x');
    assert.equal(done(events)?.reason, 'rejected');
    assert.equal(h.prompts.length, 1);
    assert.equal(h.provider.requests.length, 1);
    assert.match(h.toolResults()[1]!.content, /rejected an earlier action/);
    assert.ok(!fs.existsSync(path.join(h.dir, 'one.txt')) && !fs.existsSync(path.join(h.dir, 'two.txt')));
    // Every call still has a result, so the history stays valid for the next request.
    assert.equal(h.toolResults().length, 2);
  });

  test('"don\'t ask again" covers the next matching command', async () => {
    const h = harness(
      [{ calls: [{ name: 'Bash', args: { command: 'touch one.txt' } }] }, { calls: [{ name: 'Bash', args: { command: 'touch two.txt' } }] }, { text: 'done' }],
      { answer: (p) => ({ allow: true, suggestion: p.suggestions[0] }) },
    );
    await h.run('x');
    assert.equal(h.prompts.length, 1);
    assert.match(h.prompts[0]!.suggestions[0]!.rules![0]!, /^Bash\(touch/);
    assert.ok(fs.existsSync(path.join(h.dir, 'one.txt')) && fs.existsSync(path.join(h.dir, 'two.txt')));
  });

  test('acceptEdits mode edits without asking but still asks for commands', async () => {
    const h = harness(
      [
        { calls: [{ name: 'Write', args: { file_path: 'new.txt', content: 'hi\n' } }] },
        { calls: [{ name: 'Bash', args: { command: 'node -e "1"' } }] },
        { text: 'done' },
      ],
      { mode: 'acceptEdits', answer: () => ({ allow: true }) },
    );
    await h.run('x');
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0]!.request.kind, 'bash');
    assert.equal(fs.readFileSync(path.join(h.dir, 'new.txt'), 'utf8'), 'hi\n');
  });

  test('plan mode refuses changes and explains why', async () => {
    const h = harness([{ calls: [{ name: 'Write', args: { file_path: 'new.txt', content: 'hi' } }, { name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'planning' }], {
      mode: 'plan',
      answer: () => ({ allow: true }),
    });
    await h.run('x');
    const [write, read] = h.toolResults();
    assert.match(write!.content, /Plan mode is active/);
    assert.match(read!.content, /alpha/);
    assert.equal(h.prompts.length, 0);
    assert.ok(!fs.existsSync(path.join(h.dir, 'new.txt')));
  });

  test('an approved plan leaves plan mode', async () => {
    const h = harness([{ calls: [{ name: 'ExitPlanMode', args: { plan: '1. do it' } }] }, { text: 'starting' }], {
      mode: 'plan',
      runtime: {
        approvePlan: async () => {
          h.permissions.mode = 'acceptEdits';
          return { approved: true };
        },
      },
    });
    await h.run('x');
    assert.match(h.toolResults()[0]!.content, /approved the plan/);
    assert.equal(h.permissions.mode, 'acceptEdits');
  });

  test('disabled tools are not offered to the model', async () => {
    const h = harness([{ text: 'ok' }], { settings: { permissions: { deny: ['WebFetch', 'Bash'] } } });
    await h.run('x');
    const names = h.provider.requests[0]!.tools.map((t) => t.name);
    assert.ok(!names.includes('WebFetch') && !names.includes('Bash'));
    assert.ok(names.includes('Read'));
  });
});

describe('agent loop: concurrency and control', () => {
  test('read-only calls run in parallel, others in order', async () => {
    const h = harness(
      [
        { calls: [{ name: 'Bash', args: { command: 'sleep 0.4' } }, { name: 'Bash', args: { command: 'sleep 0.4' } }, { name: 'Bash', args: { command: 'sleep 0.4' } }] },
        { calls: [{ name: 'Bash', args: { command: 'echo 1 >> order.txt' } }, { name: 'Bash', args: { command: 'echo 2 >> order.txt' } }] },
        { text: 'done' },
      ],
      { mode: 'bypassPermissions' },
    );
    const started = Date.now();
    await h.run('x');
    assert.ok(Date.now() - started < 1100, `parallel sleeps took ${Date.now() - started}ms`);
    assert.equal(fs.readFileSync(path.join(h.dir, 'order.txt'), 'utf8'), '1\n2\n');
  });

  test('aborting mid-stream keeps the partial text and marks the interruption', async () => {
    const h = harness([{ text: 'This answer is long and gets cut.', hangMs: 5000 }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const events = await h.run('x', controller.signal);
    assert.equal(done(events)?.reason, 'aborted');
    const roles = h.agent.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user']);
    assert.match(String((h.agent.messages[2] as UserMessage).content), /interrupted by user/);
  });

  test('aborting during a tool kills it and still records a result', async () => {
    const h = harness([{ calls: [{ name: 'Bash', args: { command: 'sleep 5; touch late.txt' } }] }, { text: 'never' }], { mode: 'bypassPermissions' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const events = await h.run('x', controller.signal);
    assert.ok(Date.now() - started < 3000);
    assert.equal(done(events)?.reason, 'aborted');
    assert.equal(h.toolResults().length, 1);
    assert.match(h.toolResults()[0]!.content, /interrupted/i);
    assert.equal(h.provider.requests.length, 1);
  });

  test('messages typed during a turn are delivered after the tool results', async () => {
    const h = harness([{ calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'done' }], {
      queued: [{ role: 'user', content: 'also check b.txt' }],
    });
    const events = await h.run('x');
    assert.ok(events.some((e) => e.type === 'user_message'));
    const second = h.provider.requests[1]!.messages;
    assert.equal(second.at(-1)!.role, 'user');
    assert.equal((second.at(-1) as UserMessage).content, 'also check b.txt');
    assert.equal(second.at(-2)!.role, 'tool');
  });
});

describe('agent loop: hooks', () => {
  test('a PreToolUse hook can block a call', async () => {
    const h = harness([{ calls: [{ name: 'Bash', args: { command: 'touch hooked.txt' } }] }, { text: 'ok' }], {
      mode: 'bypassPermissions',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "no shell today" >&2; exit 2' }] }] },
    });
    await h.run('x');
    assert.match(h.toolResults()[0]!.content, /Blocked by a PreToolUse hook: no shell today/);
    assert.ok(!fs.existsSync(path.join(h.dir, 'hooked.txt')));
  });

  test('a PreToolUse hook only fires for matching tools', async () => {
    const h = harness([{ calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'ok' }], {
      hooks: { PreToolUse: [{ matcher: 'Bash|Edit', hooks: [{ type: 'command', command: 'exit 2' }] }] },
    });
    await h.run('x');
    assert.match(h.toolResults()[0]!.content, /alpha/);
  });

  test('PostToolUse feedback is appended to the result', async () => {
    const h = harness([{ calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'ok' }], {
      hooks: { PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo "lint: 2 warnings" >&2; exit 2' }] }] },
    });
    await h.run('x');
    assert.match(h.toolResults()[0]!.content, /alpha[\s\S]*PostToolUse hook feedback: lint: 2 warnings/);
  });

  test('a Stop hook can send the agent back to work', async () => {
    const flag = path.join(tempProject(), 'flag');
    const h = harness([{ text: 'I am done.' }, { text: 'Now really done.' }], {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `if [ ! -f ${flag} ]; then touch ${flag}; echo "tests are not passing" >&2; exit 2; fi` }] }] },
    });
    const events = await h.run('x');
    assert.equal(h.provider.requests.length, 2);
    assert.match(String((h.provider.requests[1]!.messages.at(-1) as UserMessage).content), /tests are not passing/);
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.agent.lastAssistantText(), 'Now really done.');
  });

  test('a hook can rewrite tool input', async () => {
    const h = harness([{ calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'ok' }], {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"file_path":"b.txt"}}}'` }],
          },
        ],
      },
    });
    await h.run('x');
    assert.match(h.toolResults()[0]!.content, /one/);
  });
});

describe('context management', () => {
  test('microcompact clears old tool results but keeps recent ones', () => {
    const big = 'x'.repeat(5000);
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'Read', arguments: {} }] });
      messages.push({ role: 'tool', toolCallId: `c${i}`, name: 'Read', content: big });
    }
    const freed = microcompact(messages, 4);
    assert.ok(freed > 5000);
    const results = messages.filter((m) => m.role === 'tool') as Extract<Message, { role: 'tool' }>[];
    assert.equal(results.filter((r) => r.content === CLEARED_RESULT).length, 6);
    assert.equal(results.slice(-4).every((r) => r.content === big), true);
    assert.equal(microcompact(messages, 4), 0);
  });

  test('recentTail starts at a real user message and respects the budget', () => {
    const messages: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'meta', isMeta: true },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'Read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c', name: 'Read', content: 'data' },
    ];
    assert.deepEqual(recentTail(messages, 1000).map((m) => m.role), ['user', 'assistant', 'tool']);
    assert.deepEqual(recentTail(messages, 1), []);
  });

  test('fitTranscript drops the middle', () => {
    const text = `${'a'.repeat(5000)}MIDDLE${'z'.repeat(5000)}`;
    const fitted = fitTranscript(text, 1000);
    assert.ok(fitted.length < 4000);
    assert.ok(fitted.startsWith('aaa') && fitted.endsWith('zzz'));
    assert.ok(!fitted.includes('MIDDLE'));
  });

  test('token estimates calibrate toward what the server reports', () => {
    const cal = new TokenCalibrator();
    assert.equal(cal.apply(1000), 1000);
    cal.observe(1000, 1500);
    assert.equal(cal.apply(1000), 1500);
    cal.observe(1000, 1500);
    assert.equal(cal.apply(1000), 1500);
    cal.observe(50, 5000); // too small a sample to trust
    assert.equal(cal.apply(1000), 1500);
    assert.ok(estimateTokens('hello world') > 0);
    assert.ok(messagesTokens([{ role: 'user', content: 'x'.repeat(350) }]) >= 100);
  });

  test('a full context is summarised automatically and the work continues', async () => {
    const filler = `${'lorem ipsum dolor sit amet '.repeat(120)}\n`;
    const h = harness(
      (req, i) => {
        if (req.tools.length === 0) return { text: 'SUMMARY: the user asked to read files; a.txt and big.txt were read.' };
        if (i < 6) return { calls: [{ name: 'Bash', args: { command: `cat big.txt; echo ${i}` } }] };
        return { text: 'All done.' };
      },
      { mode: 'bypassPermissions', contextWindow: 6000, maxOutputTokens: 500, files: { 'big.txt': filler } },
    );
    const events = await h.run('read things');
    const compactions = events.filter((e) => e.type === 'compact' && e.phase === 'end');
    assert.ok(compactions.length >= 1, 'expected at least one compaction');
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.agent.lastAssistantText(), 'All done.');
    // The request after compaction is well inside the window.
    const last = h.provider.requests.at(-1)!;
    assert.ok(messagesTokens(last.messages) < 6000);
    // Tool calls and results stay paired in every request the model saw.
    for (const req of h.provider.requests) {
      const ids = new Set(req.messages.filter((m) => m.role === 'tool').map((m) => (m as { toolCallId: string }).toolCallId));
      for (const m of req.messages) {
        if (m.role === 'assistant') for (const call of m.toolCalls ?? []) assert.ok(ids.has(call.id), `unanswered call ${call.id}`);
      }
    }
  });

  test('a window too small for the prompt itself warns once instead of compacting forever', async () => {
    let summaries = 0;
    const h = harness(
      (req, i) => {
        if (req.tools.length === 0) {
          summaries++;
          return { text: 'SUMMARY' };
        }
        return i < 4 ? { calls: [{ name: 'Glob', args: { pattern: `*.x${i}` } }] } : { text: 'done' };
      },
      { contextWindow: 1500, maxOutputTokens: 300 },
    );
    const events = await h.run('go');
    assert.equal(summaries, 0, 'no summarisation calls: there is nothing to gain');
    assert.equal(events.filter((e) => e.type === 'notice' && /nearly filled by the system prompt/.test(e.text)).length, 1);
    assert.equal(done(events)?.reason, 'stop');
  });

  test('a context-overflow error triggers compaction and a retry', async () => {
    let failed = false;
    const h = harness((req) => {
      if (req.tools.length === 0) return { text: 'SUMMARY of earlier work.' };
      if (!failed) {
        failed = true;
        return { throw: new ProviderError('context_overflow', 'prompt is too long', 400) };
      }
      return { text: 'Recovered.' };
    });
    h.agent.messages.push({ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' });
    const events = await h.run('next');
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.agent.lastAssistantText(), 'Recovered.');
    assert.ok(events.some((e) => e.type === 'compact'));
  });

  test('manual compaction replaces history with a summary', async () => {
    const h = harness((req) => (req.tools.length === 0 ? { text: 'SUMMARY: discussed alpha.' } : { text: 'ok' }));
    await h.run('tell me about alpha');
    const events: AgentEvent[] = [];
    for await (const ev of h.agent.compact(new AbortController().signal, { auto: false, force: true, instructions: 'focus on alpha' })) events.push(ev);
    assert.ok(events.some((e) => e.type === 'compact' && e.phase === 'end'));
    assert.match(String((h.agent.messages[0] as UserMessage).content), /SUMMARY: discussed alpha/);
    assert.match(String((h.provider.requests.at(-1)!.messages[0] as UserMessage).content), /focus on: focus on alpha/);
  });
});

describe('system prompt', () => {
  const env = { cwd: '/proj', projectRoot: '/proj', additionalDirs: [], model: 'm', isGit: true, gitBranch: 'main' };

  test('includes environment, memory, skills and plan mode when relevant', () => {
    const prompt = buildSystemPrompt({
      env,
      mode: 'plan',
      memory: '# Instructions from the user\nAlways use tabs.',
      skills: [{ name: 'deploy', description: 'Ship it' }],
      agents: [{ name: 'explore', description: 'Search' }],
      append: 'EXTRA RULE',
    });
    assert.match(prompt, /Working directory: \/proj/);
    assert.match(prompt, /branch main/);
    assert.match(prompt, /Always use tabs/);
    assert.match(prompt, /- deploy: Ship it/);
    assert.match(prompt, /- explore: Search/);
    assert.match(prompt, /Plan mode is active/);
    assert.ok(prompt.trimEnd().endsWith('EXTRA RULE'));
  });

  test('stays small enough for a local context window', () => {
    const prompt = buildSystemPrompt({ env, mode: 'default' });
    assert.ok(estimateTokens(prompt) < 1100, `system prompt is ${estimateTokens(prompt)} tokens`);
    assert.ok(!/Plan mode is active/.test(prompt));
  });

  test('--system-prompt replaces the built-in text but keeps the environment', () => {
    const prompt = buildSystemPrompt({ env, mode: 'default', override: 'You are a pirate.' });
    assert.ok(prompt.startsWith('You are a pirate.'));
    assert.ok(!prompt.includes('You are coco'));
    assert.match(prompt, /Working directory/);
  });
});
