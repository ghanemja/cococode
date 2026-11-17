import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import type { HookEvent, HooksConfig } from '../src/config/settings.ts';
import { HookRunner } from '../src/hooks/hooks.ts';
import { tempProject } from './helpers.ts';

const skip = process.platform === 'win32';
const REPLACEMENT = String.fromCodePoint(0xfffd);

let root: string;

beforeEach(() => {
  root = tempProject();
});

function runner(config: HooksConfig | undefined, cwd?: string): HookRunner {
  return new HookRunner(() => config, {
    sessionId: 'session-123',
    transcriptPath: '/tmp/transcript.jsonl',
    projectRoot: root,
    cwd: () => cwd ?? root,
    permissionMode: () => 'acceptEdits',
  });
}

/** A config with one matcher-less entry per command for a single event. */
function on(event: HookEvent, ...commands: string[]): HooksConfig {
  return { [event]: commands.map((command) => ({ hooks: [{ type: 'command' as const, command }] })) };
}

function emit(json: unknown): string {
  return `printf '%s' '${JSON.stringify(json).replace(/'/g, `'\\''`)}'`;
}

function read(name: string): string {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function lines(name: string): string[] {
  try {
    return read(name).split('\n').filter(Boolean).sort();
  } catch {
    return [];
  }
}

describe('HookRunner configuration', { skip }, () => {
  test('has() and list()', () => {
    const hooks = runner({
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'one' }] },
        { hooks: [{ type: 'command', command: 'two' }, { type: 'command', command: 'three', timeout: 5 }] },
      ],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'four' }] }],
      PostToolUse: [],
    });
    assert.equal(hooks.has('PreToolUse'), true);
    assert.equal(hooks.has('Stop'), true);
    assert.equal(hooks.has('PostToolUse'), false);
    assert.equal(hooks.has('SessionStart'), false);
    assert.deepEqual(hooks.list(), [
      { event: 'PreToolUse', matcher: 'Bash', command: 'one' },
      { event: 'PreToolUse', matcher: '*', command: 'two' },
      { event: 'PreToolUse', matcher: '*', command: 'three' },
      { event: 'Stop', matcher: '*', command: 'four' },
    ]);
  });

  test('no configuration at all', async () => {
    const hooks = runner(undefined);
    assert.equal(hooks.has('Stop'), false);
    assert.deepEqual(hooks.list(), []);
    assert.deepEqual(await hooks.run('Stop', {}), { blocked: false, messages: [] });
  });

  test('the configuration is read each time, so changes take effect', async () => {
    let config: HooksConfig = {};
    const hooks = new HookRunner(() => config, { sessionId: 's', projectRoot: root, cwd: () => root });
    assert.equal(hooks.has('Stop'), false);
    config = on('Stop', 'echo ran >> ran.txt');
    assert.equal(hooks.has('Stop'), true);
    await hooks.run('Stop', {});
    assert.deepEqual(lines('ran.txt'), ['ran']);
  });

  test('entries of the wrong shape are ignored instead of crashing', async () => {
    const malformed = {
      PreToolUse: { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a >> ran.txt' }] },
      PostToolUse: [null, 'string', 42, { matcher: 'Bash' }, { hooks: 'nope' }, { hooks: [null, { type: 'other', command: 'x' }, { type: 'command' }, { type: 'command', command: '  ' }] }],
      Stop: [{ matcher: 7, hooks: [{ type: 'command', command: 'echo stop >> ran.txt' }] }],
    } as unknown as HooksConfig;
    const hooks = runner(malformed);
    assert.equal(hooks.has('PreToolUse'), false);
    assert.equal(hooks.has('PostToolUse'), false);
    assert.equal(hooks.has('Stop'), true);
    assert.deepEqual(hooks.list(), [{ event: 'Stop', matcher: '*', command: 'echo stop >> ran.txt' }]);
    assert.deepEqual(await hooks.run('PreToolUse', {}, 'Bash'), { blocked: false, messages: [] });
    assert.deepEqual(await hooks.run('PostToolUse', {}, 'Bash'), { blocked: false, messages: [] });
    await hooks.run('Stop', {});
    assert.deepEqual(lines('ran.txt'), ['stop']);
  });
});

describe('HookRunner input', { skip }, () => {
  test('the hook receives the event as JSON on stdin', async () => {
    const hooks = runner(on('PreToolUse', 'cat > "$COCO_PROJECT_DIR/stdin.json"'));
    const outcome = await hooks.run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls -la', description: 'say "hi"' } }, 'Bash');
    assert.deepEqual(outcome, { blocked: false, messages: [] });
    assert.deepEqual(JSON.parse(read('stdin.json')), {
      session_id: 'session-123',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: root,
      permission_mode: 'acceptEdits',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la', description: 'say "hi"' },
    });
  });

  test('project directory variables are set and the hook runs in the session directory', async () => {
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    const hooks = runner(on('Stop', 'printf "%s|%s|%s|%s" "$COCO_PROJECT_DIR" "$CLAUDE_PROJECT_DIR" "$COCO" "$(pwd -P)" > "$COCO_PROJECT_DIR/env.txt"'), sub);
    await hooks.run('Stop', {});
    assert.equal(read('env.txt'), `${root}|${root}|1|${sub}`);
  });

  test('a hook that never reads stdin still completes, even with a large payload', async () => {
    const hooks = runner(on('PostToolUse', 'exit 0', 'true'));
    const outcome = await hooks.run('PostToolUse', { tool_response: 'x'.repeat(400_000) }, 'Read');
    assert.deepEqual(outcome, { blocked: false, messages: [] });
  });
});

describe('HookRunner matchers', { skip }, () => {
  const mark = (name: string) => `echo ${name} >> "$COCO_PROJECT_DIR/ran.txt"`;

  function matcherConfig(): HooksConfig {
    const entry = (matcher: string | undefined, name: string) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command' as const, command: mark(name) }] });
    return {
      PreToolUse: [
        entry('Bash', 'bash'),
        entry('Edit|Write', 'edits'),
        entry('*', 'star'),
        entry('', 'empty'),
        entry(undefined, 'none'),
        entry('mcp__.*', 'mcp'),
        entry('Notebook.*', 'notebook'),
        entry('Writ', 'partial'),
        entry('(unclosed', 'invalid'),
      ],
    };
  }

  for (const [tool, expected] of [
    ['Bash', ['bash', 'empty', 'none', 'star']],
    ['Write', ['edits', 'empty', 'none', 'star']],
    ['Edit', ['edits', 'empty', 'none', 'star']],
    ['mcp__github__create_issue', ['empty', 'mcp', 'none', 'star']],
    ['NotebookEdit', ['empty', 'none', 'notebook', 'star']],
    ['Read', ['empty', 'none', 'star']],
    ['(unclosed', ['empty', 'invalid', 'none', 'star']],
  ] as const) {
    test(`tool ${tool} runs ${expected.join(', ')}`, async () => {
      await runner(matcherConfig()).run('PreToolUse', { tool_name: tool }, tool);
      assert.deepEqual(lines('ran.txt'), [...expected]);
    });
  }

  test('matchers test the trigger for session events', async () => {
    const config: HooksConfig = {
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: mark('startup') }] },
        { matcher: 'resume|clear', hooks: [{ type: 'command', command: mark('resume-or-clear') }] },
        { hooks: [{ type: 'command', command: mark('always') }] },
      ],
    };
    await runner(config).run('SessionStart', { source: 'resume' }, 'resume');
    assert.deepEqual(lines('ran.txt'), ['always', 'resume-or-clear']);
  });

  test('without a subject every matcher applies', async () => {
    const config: HooksConfig = { Stop: [{ matcher: 'anything', hooks: [{ type: 'command', command: mark('stop') }] }] };
    await runner(config).run('Stop', {});
    assert.deepEqual(lines('ran.txt'), ['stop']);
  });

  test('the same command listed twice runs once', async () => {
    const config: HooksConfig = {
      PostToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: mark('fmt') }, { type: 'command', command: mark('fmt') }] },
        { matcher: '*', hooks: [{ type: 'command', command: mark('fmt') }, { type: 'command', command: mark('other') }] },
      ],
    };
    await runner(config).run('PostToolUse', {}, 'Edit');
    assert.deepEqual(lines('ran.txt'), ['fmt', 'other']);
  });

  test('no matching hook means nothing runs', async () => {
    const config: HooksConfig = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: mark('bash') }] }] };
    assert.deepEqual(await runner(config).run('PreToolUse', {}, 'Read'), { blocked: false, messages: [] });
    assert.deepEqual(lines('ran.txt'), []);
  });
});

describe('HookRunner exit codes', { skip }, () => {
  test('exit 0 is silent, whatever the hook printed', async () => {
    const outcome = await runner(on('PreToolUse', 'echo "some log line"; echo "to stderr" >&2')).run('PreToolUse', {}, 'Bash');
    assert.deepEqual(outcome, { blocked: false, messages: [] });
  });

  test('exit 2 blocks, with stderr as the reason', async () => {
    const outcome = await runner(on('PreToolUse', 'echo "ignored stdout"; echo "rm is not allowed here" >&2; exit 2')).run('PreToolUse', {}, 'Bash');
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reason, 'rm is not allowed here');
    assert.deepEqual(outcome.messages, []);
  });

  test('exit 2 without stderr still gives a reason', async () => {
    const outcome = await runner(on('Stop', 'exit 2')).run('Stop', {});
    assert.equal(outcome.blocked, true);
    assert.match(outcome.reason!, /Stop hook/);
  });

  test('other exit codes are reported but do not block', async () => {
    const outcome = await runner(on('PostToolUse', 'echo "lint crashed" >&2; exit 1', 'exit 7')).run('PostToolUse', {}, 'Edit');
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.reason, undefined);
    assert.equal(outcome.messages.length, 2);
    assert.match(outcome.messages[0]!, /PostToolUse hook failed \(exit 1\)/);
    assert.match(outcome.messages[0]!, /lint crashed/);
    assert.match(outcome.messages[1]!, /exit 7/);
  });

  test('a command that does not exist is a failure, not a crash', async () => {
    const outcome = await runner(on('Stop', 'definitely-not-a-real-command-xyz')).run('Stop', {});
    assert.equal(outcome.blocked, false);
    assert.match(outcome.messages[0]!, /exit 127/);
  });

  test('a working directory that no longer exists is a failure, not a crash', async () => {
    const outcome = await runner(on('Stop', 'true'), path.join(root, 'gone')).run('Stop', {});
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.messages.length, 1);
  });

  test('reasons from several blocking hooks are combined', async () => {
    const outcome = await runner(on('PreToolUse', 'echo first >&2; exit 2', 'exit 0', 'echo second >&2; exit 2')).run('PreToolUse', {}, 'Bash');
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reason, 'first\nsecond');
  });

  test('a hook that runs past its timeout is killed and reported', async () => {
    const config: HooksConfig = { Stop: [{ hooks: [{ type: 'command', command: 'sleep 20; echo late >> late.txt', timeout: 0.3 }] }] };
    const started = Date.now();
    const outcome = await runner(config).run('Stop', {});
    assert.ok(Date.now() - started < 5000, 'should not wait for the hook to finish');
    assert.equal(outcome.blocked, false);
    assert.match(outcome.messages[0]!, /Stop hook timed out: sleep 20/);
    assert.deepEqual(lines('late.txt'), []);
  });

  test('an interrupted hook is killed without being reported as a failure', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const started = Date.now();
    const outcome = await runner(on('PreToolUse', 'sleep 20')).run('PreToolUse', {}, 'Bash', abort.signal);
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(outcome, { blocked: false, messages: [] });
  });

  test('nothing runs when the turn was already interrupted', async () => {
    const abort = new AbortController();
    abort.abort();
    const outcome = await runner(on('PreToolUse', 'echo ran >> ran.txt')).run('PreToolUse', {}, 'Bash', abort.signal);
    assert.deepEqual(outcome, { blocked: false, messages: [] });
    assert.deepEqual(lines('ran.txt'), []);
  });

  test('hooks for one event run concurrently', async () => {
    // Each hook waits for the other's flag, so both succeed only if they overlap.
    const waitFor = (mine: string, theirs: string) =>
      `touch ${mine}.flag; i=0; while [ $i -lt 200 ]; do [ -f ${theirs}.flag ] && exit 0; sleep 0.02; i=$((i+1)); done; echo "${mine} never saw ${theirs}" >&2; exit 3`;
    const outcome = await runner(on('PostToolUse', waitFor('a', 'b'), waitFor('b', 'a'))).run('PostToolUse', {}, 'Edit');
    assert.deepEqual(outcome, { blocked: false, messages: [] });
  });
});

describe('HookRunner output', { skip }, () => {
  test('plain stdout becomes context for UserPromptSubmit and SessionStart only', async () => {
    const say = 'echo "Today is Tuesday."';
    assert.equal((await runner(on('UserPromptSubmit', say)).run('UserPromptSubmit', { prompt: 'hi' })).additionalContext, 'Today is Tuesday.');
    assert.equal((await runner(on('SessionStart', say)).run('SessionStart', {}, 'startup')).additionalContext, 'Today is Tuesday.');
    for (const event of ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'PreCompact', 'Notification', 'SessionEnd'] as const) {
      assert.equal((await runner(on(event, say)).run(event, {}, 'Bash')).additionalContext, undefined, event);
    }
  });

  test('context from several hooks is joined in configuration order', async () => {
    const outcome = await runner(on('SessionStart', 'sleep 0.1; echo first', 'echo second')).run('SessionStart', {}, 'startup');
    assert.equal(outcome.additionalContext, 'first\n\nsecond');
  });

  test('text that only looks like JSON is still plain context', async () => {
    const outcome = await runner(on('SessionStart', 'echo "{ not json at all"')).run('SessionStart', {}, 'startup');
    assert.equal(outcome.additionalContext, '{ not json at all');
  });

  test('decision: block', async () => {
    const outcome = await runner(on('PostToolUse', emit({ decision: 'block', reason: "tests don't pass" }))).run('PostToolUse', {}, 'Edit');
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reason, "tests don't pass");
  });

  test('decision: block without a reason', async () => {
    const outcome = await runner(on('Stop', emit({ decision: 'block' }))).run('Stop', {});
    assert.equal(outcome.blocked, true);
    assert.match(outcome.reason!, /Stop hook/);
  });

  test('continue: false stops the agent, with a reason', async () => {
    const outcome = await runner(on('PostToolUse', emit({ continue: false, stopReason: 'budget exhausted' }))).run('PostToolUse', {}, 'Bash');
    assert.equal(outcome.stop, true);
    assert.equal(outcome.stopReason, 'budget exhausted');
    assert.equal(outcome.blocked, false);
  });

  test('systemMessage is shown to the user', async () => {
    const outcome = await runner(on('PreToolUse', emit({ systemMessage: 'Formatting skipped: no prettier config' }))).run('PreToolUse', {}, 'Edit');
    assert.deepEqual(outcome.messages, ['Formatting skipped: no prettier config']);
    assert.equal(outcome.blocked, false);
  });

  test('permissionDecision allow', async () => {
    const outcome = await runner(on('PreToolUse', emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))).run('PreToolUse', {}, 'Bash');
    assert.equal(outcome.permissionDecision, 'allow');
    assert.equal(outcome.blocked, false);
  });

  test('permissionDecision ask', async () => {
    const outcome = await runner(on('PreToolUse', emit({ hookSpecificOutput: { permissionDecision: 'ask' } }))).run('PreToolUse', {}, 'Bash');
    assert.equal(outcome.permissionDecision, 'ask');
    assert.equal(outcome.blocked, false);
  });

  test('permissionDecision deny blocks with its reason', async () => {
    const outcome = await runner(on('PreToolUse', emit({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'production database' } }))).run('PreToolUse', {}, 'Bash');
    assert.equal(outcome.permissionDecision, 'deny');
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reason, 'production database');
  });

  test('deny beats ask beats allow, whatever the order', async () => {
    const decide = (d: string) => emit({ hookSpecificOutput: { permissionDecision: d, permissionDecisionReason: `because ${d}` } });
    for (const order of [
      ['allow', 'deny', 'ask'],
      ['deny', 'ask', 'allow'],
      ['ask', 'allow', 'deny'],
    ]) {
      // Distinct commands (a trailing comment) so de-duplication does not merge them.
      const outcome = await runner(on('PreToolUse', ...order.map((d, i) => `${decide(d)} # ${i}`))).run('PreToolUse', {}, 'Bash');
      assert.equal(outcome.permissionDecision, 'deny', order.join(','));
      assert.equal(outcome.blocked, true);
      assert.equal(outcome.reason, 'because deny');
    }
    const askAllow = await runner(on('PreToolUse', decide('allow'), decide('ask'))).run('PreToolUse', {}, 'Bash');
    assert.equal(askAllow.permissionDecision, 'ask');
    assert.equal(askAllow.blocked, false);
  });

  test('an unknown permissionDecision is ignored', async () => {
    const outcome = await runner(on('PreToolUse', emit({ hookSpecificOutput: { permissionDecision: 'maybe' } }))).run('PreToolUse', {}, 'Bash');
    assert.equal(outcome.permissionDecision, undefined);
    assert.equal(outcome.blocked, false);
  });

  test('updatedInput and additionalContext', async () => {
    const outcome = await runner(
      on('PreToolUse', emit({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'ls -la --color=never' }, additionalContext: 'Colour was disabled.' } })),
    ).run('PreToolUse', {}, 'Bash');
    assert.deepEqual(outcome.updatedInput, { command: 'ls -la --color=never' });
    assert.equal(outcome.additionalContext, 'Colour was disabled.');
  });

  test('JSON additionalContext works for any event', async () => {
    const outcome = await runner(on('PostToolUse', emit({ hookSpecificOutput: { additionalContext: 'Lint: 2 warnings' } }))).run('PostToolUse', {}, 'Edit');
    assert.equal(outcome.additionalContext, 'Lint: 2 warnings');
  });

  test('everything in one JSON object', async () => {
    const outcome = await runner(
      on('UserPromptSubmit', emit({ continue: false, stopReason: 'stop', systemMessage: 'note', decision: 'block', reason: 'why', hookSpecificOutput: { additionalContext: 'ctx' } })),
    ).run('UserPromptSubmit', { prompt: 'x' });
    assert.deepEqual(outcome, { blocked: true, messages: ['note'], stop: true, stopReason: 'stop', reason: 'why', additionalContext: 'ctx' });
  });

  test('JSON output is only read when the hook exits 0', async () => {
    const outcome = await runner(on('PreToolUse', `${emit({ decision: 'block', reason: 'from json' })}; exit 1`)).run('PreToolUse', {}, 'Bash');
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.messages.length, 1);
  });

  test('multi-byte output survives being split across pipe reads', async () => {
    // 60,000 three-byte characters: the 64 KiB pipe buffer splits one of them.
    const outcome = await runner(on('SessionStart', "yes '€' | head -n 60000 | tr -d '\\n'")).run('SessionStart', {}, 'startup');
    const text = outcome.additionalContext ?? '';
    assert.equal(text.length, 60000);
    assert.ok(!text.includes(REPLACEMENT));
    assert.ok(/^€+$/.test(text));
  });
});
