import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from '../src/agent/loop.ts';
import { Agent, announcesAction } from '../src/agent/loop.ts';
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
  /** Fail with this error after half of the text has been sent. */
  dropWith?: Error;
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
      if (turn.dropWith) throw turn.dropWith;
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
  /** Backoff delays the agent asked for (the harness does not actually wait). */
  delays: number[];
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
  const delays: number[] = [];
  const queued = [...(opts.queued ?? [])];
  const runtime: RuntimeHandle = {
    runSubagent: async () => ({ text: 'sub done', toolUses: 0, tokens: 0 }),
    agentTypes: () => [{ name: 'general-purpose', description: 'general' }],
    skills: () => [],
    invokeSkill: async () => undefined,
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
    sleep: async (ms) => void delays.push(ms),
  });
  return {
    agent,
    provider,
    session,
    permissions,
    dir,
    prompts,
    delays,
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

  test('an error that retrying cannot fix ends the turn at once', async () => {
    const h = harness([{ throw: new ProviderError('http', 'invalid request: bad schema', 400) }, { text: 'never' }]);
    const events = await h.run('hi');
    assert.equal(done(events)?.reason, 'error');
    assert.equal(done(events)?.error, 'invalid request: bad schema');
    assert.equal(h.provider.requests.length, 1);
    assert.deepEqual(h.delays, []);
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

  test('an empty reply is asked for again without streaming, then nudged, then reported', async () => {
    const h = harness(() => ({ text: '' }));
    const events = await h.run('x');
    // Each empty stream is retried once as a plain (non-streaming) request before it counts as empty.
    assert.deepEqual(h.provider.requests.map((r) => r.stream !== false), [true, false, true, false]);
    const nudge = h.provider.requests[2]!.messages.at(-1) as UserMessage;
    assert.match(String(nudge.content), /last reply was empty/);
    assert.equal(done(events)?.reason, 'error');
  });

  test('a server whose stream comes back empty is served by the non-streaming retry', async () => {
    const h = harness((req) => (req.stream === false ? { text: 'The whole answer in one piece.' } : { text: '' }));
    const events = await h.run('x');
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.agent.lastAssistantText(), 'The whole answer in one piece.');
    assert.equal(h.provider.requests.length, 2);
    // No nudge was needed, so the conversation holds just the question and the answer.
    assert.deepEqual(h.agent.messages.map((m) => m.role), ['user', 'assistant']);
  });

  test('a reply cut off before any answer is retried with a larger budget', async () => {
    const h = harness([{ thinking: 'thinking forever', stop: 'length' }, { text: 'Answer.' }], { maxOutputTokens: 1000 });
    const events = await h.run('x');
    assert.equal(h.provider.requests[1]!.maxTokens, 2000);
    assert.equal(done(events)?.reason, 'stop');
    assert.ok(events.some((e) => e.type === 'notice' && /output budget/.test(e.text)));
  });

  test('a reply cut off at the output limit is continued automatically', async () => {
    const h = harness([{ text: 'The first half of the ans', stop: 'length' }, { text: 'wer, now complete.' }]);
    const events = await h.run('x');
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.provider.requests.length, 2);
    const second = h.provider.requests[1]!.messages;
    assert.equal((second.at(-2) as { content: string }).content, 'The first half of the ans');
    assert.match(String((second.at(-1) as UserMessage).content), /cut off at the output limit\. Continue exactly where it stopped/);
    assert.equal(h.agent.lastAssistantText(), 'wer, now complete.');
  });

  test('continuation stops after two tries and says so', async () => {
    const h = harness(() => ({ text: 'more text ', stop: 'length' }));
    const events = await h.run('x');
    assert.equal(h.provider.requests.length, 3);
    assert.equal(done(events)?.reason, 'stop');
    assert.ok(events.some((e) => e.type === 'notice' && e.level === 'warn' && /cut off at the output token limit again/.test(e.text)));
  });

  test('a tool call cut off mid-arguments is not run, and the model is told how to recover', async () => {
    const h = harness([
      { calls: [{ name: 'Write', args: { file_path: 'big.txt', content: 'half a fi' }, parseError: 'the arguments were cut off before they were complete (the reply probably hit the output token limit)' }] },
      { text: 'ok' },
    ]);
    await h.run('x');
    assert.ok(!fs.existsSync(path.join(h.dir, 'big.txt')), 'a half-written file must not appear');
    assert.match(h.toolResults()[0]!.content, /cut off before its arguments were complete[\s\S]*Write the first part and add the rest with Edit/);
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

describe('agent loop: resilience to server trouble', () => {
  test('a transient failure is retried with growing delays, then the turn completes', async () => {
    const h = harness([
      { throw: new ProviderError('connection', 'Could not reach http://x (ECONNREFUSED). Is the model server running?') },
      { throw: new ProviderError('http', 'model is loading', 503) },
      { text: 'Back online.' },
    ]);
    const events = await h.run('hi');
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.agent.lastAssistantText(), 'Back online.');
    assert.deepEqual(h.delays, [500, 1000]);
    const notices = events.filter((e) => e.type === 'notice').map((e) => (e as { text: string }).text);
    assert.match(notices[0]!, /Could not reach http:\/\/x[\s\S]*Retrying in 500ms \(attempt 1 of 10\)/);
    assert.match(notices[1]!, /model is loading Retrying in 1s \(attempt 2 of 10\)/);
    // The failed attempts leave nothing behind in the conversation.
    assert.deepEqual(h.agent.messages.map((m) => m.role), ['user', 'assistant']);
  });

  test('retries stop at the limit and report the last error', async () => {
    const h = harness(() => ({ throw: new ProviderError('http', 'upstream overloaded', 529) }), { settings: { maxRetries: 2 } });
    const events = await h.run('hi');
    assert.equal(h.provider.requests.length, 3);
    assert.deepEqual(h.delays, [500, 1000]);
    assert.equal(done(events)?.reason, 'error');
    assert.equal(done(events)?.error, 'upstream overloaded');
  });

  test('maxRetries 0 turns retrying off', async () => {
    const h = harness([{ throw: new ProviderError('http', 'boom', 500) }, { text: 'never' }], { settings: { maxRetries: 0 } });
    const events = await h.run('hi');
    assert.equal(h.provider.requests.length, 1);
    assert.equal(done(events)?.error, 'boom');
  });

  test('the retry count starts again after a request succeeds', async () => {
    const fail = () => ({ throw: new ProviderError('http', 'busy', 503) });
    const h = harness([fail(), fail(), { calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, fail(), fail(), { text: 'done' }], { settings: { maxRetries: 2 } });
    const events = await h.run('hi');
    assert.equal(done(events)?.reason, 'stop');
    assert.deepEqual(h.delays, [500, 1000, 500, 1000]);
  });

  test('a connection that drops mid-reply keeps what was shown and asks the model to carry on', async () => {
    const h = harness([{ text: 'Here is the first part and', dropWith: new ProviderError('connection', 'The connection to the model server was lost.') }, { text: ' here is the rest.' }]);
    const events = await h.run('hi');
    assert.equal(done(events)?.reason, 'stop');
    const second = h.provider.requests[1]!.messages;
    // The fake sends half of the text before failing; exactly that half is kept.
    assert.equal((second.at(-2) as { content: string }).content, 'Here is the f');
    assert.match(String((second.at(-1) as UserMessage).content), /connection dropped while you were replying[\s\S]*Continue exactly where it stopped/);
    assert.equal(h.agent.lastAssistantText(), ' here is the rest.');
  });

  test('a server that goes silent is abandoned after the timeout and retried once', async () => {
    const h = harness([{ text: 'this never finishes', hangMs: 60_000 }, { text: 'this never finishes', hangMs: 60_000 }, { text: 'never' }], {
      settings: { requestTimeoutMs: 80 },
    });
    const started = Date.now();
    const events = await h.run('hi');
    assert.ok(Date.now() - started < 3000, 'must not wait for the hung request');
    assert.equal(h.provider.requests.length, 2, 'one retry for a stall, not the full retry budget');
    assert.equal(done(events)?.reason, 'error');
    assert.match(done(events)!.error!, /sent nothing for [\d.]+ minutes?[\s\S]*raise requestTimeoutMs/);
  });

  test('interrupting during a retry wait stops cleanly', async () => {
    const controller = new AbortController();
    const h = harness(() => ({ throw: new ProviderError('http', 'busy', 503) }));
    // Abort as soon as the agent starts waiting.
    (h.agent as unknown as { deps: { sleep: (ms: number) => Promise<void> } }).deps.sleep = async () => controller.abort();
    const events = await h.run('hi', controller.signal);
    assert.equal(done(events)?.reason, 'aborted');
    assert.equal(h.provider.requests.length, 1);
  });

  test('output too large for the context is saved in full and can be read back without asking', async () => {
    const h = harness(
      (_req, i) => {
        if (i === 0) return { calls: [{ name: 'Bash', args: { command: 'seq 1 20000' } }] };
        if (i === 1) {
          const saved = /All of it is saved at (\S+)\. Use Grep/.exec(h.toolResults()[0]!.content)![1]!;
          return { calls: [{ name: 'Grep', args: { pattern: '^12345$', path: saved, output_mode: 'content' } }] };
        }
        return { text: 'found it' };
      },
      { settings: { maxToolOutputChars: 2000 }, answer: () => ({ allow: false }) },
    );
    await h.run('count');
    const [bash, grep] = h.toolResults();
    assert.ok(bash!.content.length < 3000, 'the model sees a trimmed result');
    assert.ok(bash!.content.startsWith('1\n2\n3\n'));
    assert.match(bash!.content, /19999\n20000\n\n\[The output was \d+ characters/);
    // The middle, absent from context, is still reachable; and reading it needed no approval.
    assert.match(grep!.content, /12345/);
    assert.equal(h.prompts.length, 0);
  });
});

describe('agent loop: giving up sensibly', () => {
  test('three rounds of unusable tool calls in a row end the turn with advice', async () => {
    const h = harness((_req, i) => ({ calls: [{ name: i % 2 ? 'no_such_tool' : 'Read', args: i % 2 ? {} : { wrong: i } }] }));
    const events = await h.run('x');
    assert.equal(h.provider.requests.length, 3);
    assert.equal(done(events)?.reason, 'error');
    assert.match(done(events)!.error!, /could not be run 3 times in a row[\s\S]*--tool-mode prompt/);
    // Each failed call still got a result, so the history is valid.
    assert.equal(h.toolResults().length, 3);
  });

  test('one usable call resets that count', async () => {
    const h = harness((_req, i) => {
      if (i === 5) return { text: 'finished' };
      return i === 2 ? { calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] } : { calls: [{ name: 'nope', args: { n: i } }] };
    });
    const events = await h.run('x');
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.agent.lastAssistantText(), 'finished');
  });

  test('tool calls that arrived before the connection dropped are still run', async () => {
    const provider = {
      name: 'fake',
      type: 'openai' as const,
      baseUrl: 'fake://',
      n: 0,
      async *chat(): AsyncGenerator<StreamEvent> {
        if (this.n++ === 0) {
          yield { type: 'text', text: 'Reading the file.' };
          yield { type: 'tool_call', call: { id: 'c1', name: 'Read', arguments: { file_path: 'a.txt' } } };
          throw new ProviderError('connection', 'The connection to the model server was lost.');
        }
        yield { type: 'text', text: 'It has three lines.' };
        yield { type: 'done', stopReason: 'stop' };
      },
      async listModels() {
        return [{ id: 'fake-model' }];
      },
      async modelInfo() {
        return { id: 'fake-model' };
      },
    };
    const h = harness([]);
    h.agent.setClient(new ModelClient(provider, 'fake-model', { contextWindow: 32768, maxOutputTokens: 4096, toolMode: 'native', vision: false, notes: [] }, {}));
    const events = await h.run('read a.txt');
    assert.equal(done(events)?.reason, 'stop');
    assert.match(h.toolResults()[0]!.content, /alpha/);
    assert.ok(events.some((e) => e.type === 'notice' && /connection dropped after the model had requested tools/.test(e.text)));
    assert.deepEqual(h.delays, [], 'nothing was retried: the work already done was used');
  });

  test('a failing model falls back to the next configured model for the rest of the turn', async () => {
    const h = harness([{ throw: new ProviderError('http', 'model requires more system memory than is available', 400) }]);
    const backup = new FakeProvider([{ calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'Answered by the backup.' }]);
    const asked: number[] = [];
    (h.agent as unknown as { deps: { fallback: (i: number) => Promise<ModelClient | undefined> } }).deps.fallback = async (i) => {
      asked.push(i);
      return i === 0 ? new ModelClient(backup, 'backup-model', { contextWindow: 32768, maxOutputTokens: 4096, toolMode: 'native', vision: false, notes: [] }, {}) : undefined;
    };
    const events = await h.run('hi');
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.agent.lastAssistantText(), 'Answered by the backup.');
    assert.deepEqual(asked, [0]);
    assert.equal(backup.requests.length, 2, 'the backup model is used for every remaining request of the turn');
    assert.ok(events.some((e) => e.type === 'notice' && /Switching to the fallback model backup-model/.test(e.text)));
    assert.equal((h.agent.messages.at(-1) as { model?: string }).model, 'backup-model');
  });

  test('no fallback is tried for a server that cannot be reached', async () => {
    const h = harness(() => ({ throw: new ProviderError('connection', 'Could not reach http://x.') }), { settings: { maxRetries: 1 } });
    let asked = 0;
    (h.agent as unknown as { deps: { fallback: () => Promise<undefined> } }).deps.fallback = async () => {
      asked++;
      return undefined;
    };
    const events = await h.run('hi');
    assert.equal(done(events)?.reason, 'error');
    assert.equal(asked, 0);
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

  test('PostToolUse runs after success and PostToolUseFailure after failure, each with the call id', async () => {
    const dir = tempProject();
    // One file per event: the two calls run in parallel, and appends to a shared file can interleave.
    const record = `cat > ${dir}/event-$$.json`;
    const h = harness([{ calls: [{ name: 'Read', args: { file_path: 'a.txt' } }, { name: 'Read', args: { file_path: 'missing.txt' } }] }, { text: 'ok' }], {
      hooks: {
        PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: record }] }],
        PostToolUseFailure: [{ matcher: 'Read', hooks: [{ type: 'command', command: record }] }],
      },
    });
    await h.run('x');
    const seen = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('event-'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>);
    const success = seen.find((e) => e.hook_event_name === 'PostToolUse')!;
    const failure = seen.find((e) => e.hook_event_name === 'PostToolUseFailure')!;
    assert.equal(seen.length, 2);
    assert.match(String(success.tool_response), /alpha/);
    assert.equal(success.tool_use_id, 'call_0_0');
    assert.equal(typeof success.duration_ms, 'number');
    assert.match(String(failure.error), /does not exist/);
    assert.equal(failure.tool_use_id, 'call_0_1');
    assert.equal(failure.tool_response, undefined);
  });

  test('a PermissionRequest hook answers the approval prompt, even with no user present', async () => {
    const allow = `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`;
    const h = harness([{ calls: [{ name: 'Bash', args: { command: 'touch approved.txt' } }] }, { text: 'ok' }], {
      hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: allow }] }] },
    });
    await h.run('x');
    assert.ok(fs.existsSync(path.join(h.dir, 'approved.txt')));

    const deny = `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"not on Fridays"}}}'`;
    const refused = harness([{ calls: [{ name: 'Bash', args: { command: 'touch refused.txt' } }] }, { text: 'ok' }], {
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: deny }] }] },
      answer: () => ({ allow: true }),
    });
    await refused.run('x');
    assert.ok(!fs.existsSync(path.join(refused.dir, 'refused.txt')));
    assert.match(refused.toolResults()[0]!.content, /Denied by a PermissionRequest hook: not on Fridays/);
    assert.equal(refused.prompts.length, 0, 'the user is not asked once a hook has refused');
  });

  test('a Stop hook that never relents is cut off after eight rounds', async () => {
    const h = harness(() => ({ text: 'Done, I think.' }), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo "keep going" >&2; exit 2' }] }] } });
    const events = await h.run('x');
    assert.equal(h.provider.requests.length, 9);
    assert.equal(done(events)?.reason, 'stop');
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

  test('compaction restates the task list and the files in play', async () => {
    const h = harness((req, i) => {
      if (req.tools.length === 0) return { text: 'SUMMARY: working on the parser.' };
      if (i === 0) return { calls: [{ name: 'Read', args: { file_path: 'a.txt' } }, { name: 'TodoWrite', args: { todos: [{ content: 'Fix the parser', status: 'in_progress' }, { content: 'Add tests', status: 'pending' }] } }] };
      return { text: 'ok' };
    });
    await h.run('start');
    for await (const _ of h.agent.compact(new AbortController().signal, { auto: false, force: true })) void _;
    const summary = String((h.agent.messages[0] as UserMessage).content);
    assert.match(summary, /SUMMARY: working on the parser\./);
    assert.match(summary, /Your task list at this point:\n\[~\] Fix the parser\n\[ \] Add tests/);
    // A small, recently read file comes back in full, and stays editable without another Read.
    assert.match(summary, /<file path="a\.txt" note="current content, re-attached after compaction">\nalpha\nbeta\ngamma\n\n<\/file>/);
    assert.ok(h.session.readFiles.has(path.join(h.dir, 'a.txt')));
  });

  test('after compaction, large files are named rather than re-attached and must be read again', async () => {
    // 40k characters: over the per-file budget (6% of the window) but small enough that
    // reading it does not itself trigger a compaction in a 64k window.
    const big = `${'x'.repeat(200)}\n`.repeat(200);
    const h = harness(
      (req, i) => {
        if (req.tools.length === 0) return { text: 'SUMMARY' };
        if (i === 0) return { calls: [{ name: 'Read', args: { file_path: 'big.txt' } }, { name: 'Read', args: { file_path: 'b.txt' } }] };
        return { text: 'ok' };
      },
      { files: { 'big.txt': big }, contextWindow: 64_000 },
    );
    await h.run('start');
    for await (const _ of h.agent.compact(new AbortController().signal, { auto: false, force: true })) void _;
    const summary = String((h.agent.messages[0] as UserMessage).content);
    assert.match(summary, /Other files you had open[^\n]*: big\.txt/);
    assert.ok(!summary.includes('xxxxxxxxxx'));
    assert.match(summary, /<file path="b\.txt"/);
    assert.ok(!h.session.readFiles.has(path.join(h.dir, 'big.txt')), 'its content is gone, so it must be Read again before editing');
    assert.ok(h.session.readFiles.has(path.join(h.dir, 'b.txt')));
  });

  test('compaction restates invoked skills and the approved plan, within a budget', async () => {
    const h = harness((req) => (req.tools.length === 0 ? { text: 'SUMMARY' } : { text: 'ok' }), { contextWindow: 16_000 });
    (h.agent as unknown as { deps: { carryOver: () => unknown } }).deps.carryOver = () => ({
      plan: '1. Rename the module\n2. Update imports',
      skills: [
        { name: 'old', content: 'OLD '.repeat(4000) },
        { name: 'deploy', content: 'Run make deploy, then check the logs.' },
      ],
    });
    await h.run('start');
    for await (const _ of h.agent.compact(new AbortController().signal, { auto: false, force: true })) void _;
    const summary = String((h.agent.messages[0] as UserMessage).content);
    assert.match(summary, /The plan the user approved:\n1\. Rename the module\n2\. Update imports/);
    assert.match(summary, /Skill "deploy" \(loaded earlier, still in effect\):\nRun make deploy, then check the logs\./);
    // The newest skill is kept whole; the oldest is cut to the per-skill budget or dropped.
    assert.ok(summary.length < 16_000 * 3.5 * 0.3, `carry-over must stay a fraction of the window, got ${summary.length} chars`);
  });

  test('a summary that comes back empty is requested once more', async () => {
    let summaries = 0;
    const h = harness((req) => {
      if (req.tools.length > 0) return { text: 'ok' };
      return ++summaries === 1 ? { text: '   ' } : { text: 'SUMMARY on the second try' };
    });
    await h.run('start');
    for await (const _ of h.agent.compact(new AbortController().signal, { auto: false, force: true })) void _;
    assert.equal(summaries, 2);
    assert.match(String((h.agent.messages[0] as UserMessage).content), /SUMMARY on the second try/);
  });

  test('compaction that cannot get under the limit stops after three tries instead of looping', async () => {
    let summaries = 0;
    // Every "summary" is itself enormous, so compaction never frees anything.
    const huge = 'summary word '.repeat(3000);
    const h = harness(
      (req, i) => {
        if (req.tools.length === 0) {
          summaries++;
          return { text: huge };
        }
        return i < 50 ? { calls: [{ name: 'Bash', args: { command: `cat big.txt; echo ${i}` } }] } : { text: 'done' };
      },
      { mode: 'bypassPermissions', contextWindow: 6000, maxOutputTokens: 500, files: { 'big.txt': `${'lorem ipsum dolor sit amet '.repeat(150)}\n` } },
    );
    const events = await h.run('go');
    assert.equal(done(events)?.reason, 'error');
    assert.match(done(events)!.error!, /Compaction is thrashing/);
    assert.equal(summaries, 3);
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

describe('agent loop: a reply that announces a step without taking it', () => {
  test('the model is told once that nothing happened, and can then act', async () => {
    const h = harness([{ text: 'I found the problem. Let me read a.txt to confirm.' }, { calls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'Confirmed: three lines.' }]);
    const events = await h.run('check a.txt');
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.toolResults().length, 1);
    assert.equal(h.agent.lastAssistantText(), 'Confirmed: three lines.');
    const note = h.provider.requests[1]!.messages.at(-1) as UserMessage;
    assert.equal(note.isMeta, true);
    assert.match(String(note.content), /contained no tool call, so nothing happened/);
    assert.ok(events.some((e) => e.type === 'notice' && /without doing it/.test(e.text)));
  });

  test('it happens once per turn: a second announcement ends the turn as written', async () => {
    const h = harness([{ text: 'Let me check the tests.' }, { text: "I'll run the tests now." }, { text: 'never requested' }]);
    const events = await h.run('go');
    assert.equal(done(events)?.reason, 'stop');
    assert.equal(h.provider.requests.length, 2);
    assert.equal(h.agent.lastAssistantText(), "I'll run the tests now.");
  });

  test('answers, questions and offers are left alone', async () => {
    for (const text of ['Done. The tests pass.', 'Let me know if you want anything else.', "I'll create the file once you confirm the name.", 'Should I go ahead and run the migration?']) {
      const h = harness([{ text }, { text: 'never requested' }]);
      await h.run('go');
      assert.equal(h.provider.requests.length, 1, text);
    }
  });

  test('announcesAction reads only the closing sentence', () => {
    for (const text of ['Let me read the file.', "I've updated the parser. Now I'll run the tests to verify.", "I'll start by exploring the repository structure:", '**Next, I will update the README.**', "The bug is in auth.ts.\n\nLet's fix it."]) {
      assert.equal(announcesAction(text), true, text);
    }
    for (const text of ['', "I'll be happy to help with that!", 'Let me explain how this works. The loop runs until the queue is empty.', 'Here is the plan:\n1. Read the config\n2. Update the parser', 'I fixed the bug. Would you like me to run the tests?']) {
      assert.equal(announcesAction(text), false, text);
    }
  });

  test('the setting turns it off', async () => {
    const h = harness([{ text: 'Let me read the file.' }, { text: 'never requested' }], { settings: { nudgeAnnouncedActions: false } });
    await h.run('go');
    assert.equal(h.provider.requests.length, 1);
  });
});
