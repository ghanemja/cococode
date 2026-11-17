/**
 * Interactive UI tests. The real CLI runs in a pseudo-terminal, keystrokes are
 * sent to it, and assertions are made on the screen a terminal emulator would
 * show. Needs python3 with the `pyte` package; the suite is skipped without it.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempProject, writeFiles } from './helpers.ts';
import { lastMessage, startMockServer, type MockServer, type MockServerOptions, type Script } from './mock-server.ts';
import { runTui, tuiAvailable, type Step, type TuiResult } from './tui/harness.ts';

const available = tuiAvailable();
const ESC = '\x1b';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const SHIFT_TAB = `${ESC}[Z`;

let servers: MockServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

interface Scenario {
  script: Script;
  steps: Step[];
  files?: Record<string, string>;
  dir?: string;
  cols?: number;
  rows?: number;
  server?: MockServerOptions;
  /** Auto-detect through OLLAMA_HOST instead of passing --base-url. */
  ollama?: boolean;
  args?: string[];
  env?: Record<string, string>;
  /** Text that marks the UI as ready. */
  ready?: string;
  /** Prompts from earlier sessions in this project, oldest first. */
  history?: string[];
  /** Runs alongside the UI, for what keystrokes cannot do (sending signals). */
  during?: (ctx: { dir: string; server: MockServer }) => Promise<void>;
}

async function tui(s: Scenario): Promise<TuiResult & { dir: string; server: MockServer }> {
  const dir = s.dir ?? tempProject();
  writeFiles(dir, { 'hello.txt': 'hello world\nsecond line\n', ...(s.files ?? {}) });
  if (s.history) writeFiles(dir, { '.coco-home/history.jsonl': s.history.map((text) => `${JSON.stringify({ project: dir, text })}\n`).join('') });
  const server = await startMockServer(s.script, s.server);
  servers.push(server);
  const run = runTui({
    cwd: dir,
    env: {
      COCO_CONFIG_DIR: path.join(dir, '.coco-home'),
      CLAUDE_CONFIG_DIR: path.join(dir, '.claude-home'),
      OLLAMA_HOST: s.ollama ? server.root.replace('http://', '') : '127.0.0.1:1',
      EDITOR: 'true',
      ...(s.env ?? {}),
    },
    args: [...(s.ollama ? [] : ['--base-url', server.url, '--model', 'mock-model']), ...(s.args ?? [])],
    cols: s.cols ?? 90,
    rows: s.rows ?? 32,
    steps: [{ wait: s.ready ?? 'coco v', timeout: 20 }, ...s.steps],
  });
  // Let the UI run to its end even when the side task fails, so no pty is left behind.
  const [ui, side] = await Promise.allSettled([run, s.during?.({ dir, server })]);
  if (ui.status === 'rejected') throw ui.reason;
  const res = ui.value;
  if (res.timedOut) assert.fail(`Timed out waiting for ${JSON.stringify(res.timedOut.waitingFor)}. Screen was:\n${res.timedOut.screen}`);
  if (side.status === 'rejected') throw side.reason;
  return { ...res, dir, server };
}

/** The live region from the prompt box down: what is under the scrollback. */
function belowPrompt(screen: string): string[] {
  const rows = screen.split('\n');
  const rules = rows.map((row, i) => (/^─{20,}$/.test(row) ? i : -1)).filter((i) => i >= 0);
  assert.ok(rules.length >= 2, `expected a prompt box on screen:\n${screen}`);
  // Trailing blank rows are the unused part of the terminal.
  return rows.slice(rules[rules.length - 1]! + 1).join('\n').trimEnd().split('\n');
}

/** The text in the prompt box (between its two rules), without the "> " margin. */
function promptText(screen: string): string {
  const rows = screen.split('\n');
  const rules = rows.map((row, i) => (/^─{20,}$/.test(row) ? i : -1)).filter((i) => i >= 0);
  assert.ok(rules.length >= 2, `expected a prompt box on screen:\n${screen}`);
  return rows
    .slice(rules[rules.length - 2]! + 1, rules[rules.length - 1]!)
    .map((row) => row.slice(2))
    .join('\n');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Process id and state of the UI started for this mock server ("T..." when stopped). */
function uiProcess(server: MockServer): { pid: number; state: string } | undefined {
  const rows = execFileSync('ps', ['-eo', 'pid=,stat=,args='], { encoding: 'utf8' }).split('\n');
  const row = rows.find((r) => r.includes('coco.js') && r.includes(`--base-url ${server.url} `));
  const m = row ? /^\s*(\d+)\s+(\S+)/.exec(row) : null;
  return m ? { pid: Number(m[1]), state: m[2]! } : undefined;
}

async function until<T>(what: string, probe: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Index of the first line containing `needle`, failing with the screen when absent. */
function lineOf(screen: string, needle: string): number {
  const index = screen.split('\n').findIndex((l) => l.includes(needle));
  assert.ok(index >= 0, `expected ${JSON.stringify(needle)} on screen:\n${screen}`);
  return index;
}

describe('interactive UI', { skip: available ? false : 'python3 with pyte is not installed' }, () => {
  test('startup banner, completion menus and an approved edit', async () => {
    const res = await tui({
      script: [
        { toolCalls: [{ name: 'Read', arguments: { file_path: 'hello.txt' } }] },
        { text: 'Updating the greeting.', toolCalls: [{ name: 'Edit', arguments: { file_path: 'hello.txt', old_string: 'hello world', new_string: 'goodbye world' } }] },
        { text: '## Done\n\n- Changed `hello` to **goodbye**\n\n| File | Lines |\n|------|-------|\n| hello.txt | 1 |\n' },
      ],
      steps: [
        { snapshot: 'start' },
        { send: '/he', after: 0.3 },
        { snapshot: 'commands' },
        { send: '\x7f\x7f\x7f' },
        { send: 'change the greeting in @hel', after: 0.6 },
        { snapshot: 'files' },
        { send: '\t', after: 0.2 },
        { snapshot: 'accepted' },
        { send: '\r' },
        { wait: 'Do you want to proceed', timeout: 15 },
        { snapshot: 'approval' },
        { send: '\r' },
        { wait: 'hello.txt │ 1', timeout: 15 },
        { sleep: 0.4 },
        { snapshot: 'end' },
      ],
    });
    const { snapshots: s, cursors } = res;

    assert.match(s.start!, /✻ coco v\d/);
    assert.match(s.start!, /mock-model · custom · 32k context/);
    assert.match(s.start!, /> Ask coco to do something/);
    // The cursor sits in the prompt box, right after "> ".
    assert.deepEqual(cursors.start, [lineOf(s.start!, '> Ask coco'), 2]);

    assert.match(s.commands!, /\/help\s+Show commands and keyboard shortcuts/);
    assert.match(s.files!, /^\s+hello\.txt$/m);
    assert.match(s.accepted!, /> change the greeting in @hello\.txt$/m);
    // Accepting a completion leaves a space after it, ready for more typing.
    assert.equal(cursors.accepted![1], '> change the greeting in @hello.txt '.length);

    // The dialog shows what will change before anything is written.
    assert.match(s.approval!, /Edit hello\.txt/);
    assert.match(s.approval!, /1 - hello world/);
    assert.match(s.approval!, /1 \+ goodbye world/);
    assert.match(s.approval!, /❯ 1\. Yes/);
    assert.match(s.approval!, /2\. Yes, and allow all edits this session/);
    assert.ok(!/Thinking…|Running/.test(s.approval!), 'no spinner while waiting for the user');

    assert.equal(fs.readFileSync(path.join(res.dir, 'hello.txt'), 'utf8'), 'goodbye world\nsecond line\n');
    assert.match(s.end!, /● Read\(hello\.txt\)\n\s+└ Read 2 lines/);
    assert.match(s.end!, /● Edit\(hello\.txt\)\n\s+└ Replaced 1 occurrence \(\+1 -1\)/);
    assert.match(s.end!, /• Changed hello to goodbye/);
    assert.match(s.end!, /│ hello\.txt │ 1\s+│/);
    // The attached file went to the model along with the prompt.
    const firstUser = (res.server.requests[0]!.body.messages as { role: string; content: string }[]).find((m) => m.role === 'user')!;
    assert.match(firstUser.content, /<file path="hello\.txt">\nhello world/);
  });

  test('"don\'t ask again" saves a rule and stops asking', async () => {
    const res = await tui({
      script: [
        { toolCalls: [{ name: 'Bash', arguments: { command: 'touch one.txt', description: 'Create a file' } }] },
        { toolCalls: [{ name: 'Bash', arguments: { command: 'touch two.txt' } }] },
        { text: 'Both exist.' },
      ],
      steps: [
        { send: 'make two files\r' },
        { wait: 'Do you want to proceed', timeout: 15 },
        { snapshot: 'dialog' },
        { send: '2' },
        { wait: 'Both exist.', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'end' },
      ],
    });
    assert.match(res.snapshots.dialog!, /Bash command\n\s+touch one\.txt\n\s+Create a file/);
    assert.match(res.snapshots.dialog!, /2\. Yes, and don't ask again for touch commands in this project/);
    assert.ok(fs.existsSync(path.join(res.dir, 'one.txt')) && fs.existsSync(path.join(res.dir, 'two.txt')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(res.dir, '.coco/settings.local.json'), 'utf8')), { permissions: { allow: ['Bash(touch:*)'] } });
    assert.equal((res.snapshots.end!.match(/Do you want to proceed/g) ?? []).length, 0);
  });

  test('declining with an explanation sends it to the model', async () => {
    const res = await tui({
      script: [{ toolCalls: [{ name: 'Bash', arguments: { command: 'rm -rf build' } }] }, { text: 'Understood, leaving it.' }],
      steps: [
        { send: 'clean up\r' },
        { wait: 'Do you want to proceed', timeout: 15 },
        { send: `${DOWN}${DOWN}keep the build dir`, after: 0.3 },
        { snapshot: 'typing' },
        { send: '\r' },
        { wait: 'Understood', timeout: 15 },
      ],
    });
    assert.match(res.snapshots.typing!, /❯ 3\. No, and tell coco what to do differently: keep the build dir/);
    const toolMessage = (res.server.requests[1]!.body.messages as { role: string; content: string }[]).find((m) => m.role === 'tool')!;
    assert.match(toolMessage.content, /declined this action and said: keep the build dir/);
  });

  test('escape interrupts, and messages typed while busy are queued', async () => {
    const res = await tui({
      script: [{ text: 'Slow answer.', delayMs: 5000 }, { text: 'Second answer.', delayMs: 1500 }, { text: 'Answer to the queued one.' }],
      steps: [
        { send: 'first\r', after: 0.8 },
        { snapshot: 'busy' },
        { send: ESC, after: 0.6 },
        { snapshot: 'interrupted' },
        { send: 'second\r', after: 0.4 },
        { send: 'queued follow-up\r', after: 0.3 },
        { snapshot: 'queued' },
        { wait: 'Answer to the queued one.', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'end' },
      ],
    });
    assert.match(res.snapshots.busy!, /Thinking… \(\d+s · esc to interrupt\)/);
    assert.match(res.snapshots.interrupted!, /Interrupted\. Tell coco what to do instead\./);
    assert.ok(!res.snapshots.interrupted!.includes('Slow answer'));
    assert.match(res.snapshots.queued!, /↳ queued: queued follow-up/);
    const end = res.snapshots.end!;
    assert.ok(lineOf(end, '● Second answer.') < lineOf(end, '> queued follow-up'));
    assert.ok(lineOf(end, '> queued follow-up') < lineOf(end, '● Answer to the queued one.'));
  });

  test('multi-line input, mode cycling, shell mode and history', async () => {
    const res = await tui({
      script: [{ text: 'Three lines received.' }],
      steps: [
        { send: 'line one\\\r' },
        { send: `line two${ESC}\r` },
        { send: 'line three', after: 0.2 },
        { snapshot: 'typed' },
        { send: `${UP}${UP}`, after: 0.2 },
        { snapshot: 'moved' },
        { send: '\r' },
        { wait: 'Three lines received.', timeout: 15 },
        { send: SHIFT_TAB, after: 0.2 },
        { snapshot: 'accept' },
        { send: SHIFT_TAB, after: 0.2 },
        { snapshot: 'plan' },
        { send: '!echo from-the-shell\r' },
        { wait: 'from-the-shell\n', timeout: 15 },
        { sleep: 0.3 },
        { send: UP, after: 0.2 },
        { snapshot: 'history' },
      ],
    });
    const typed = res.snapshots.typed!;
    const row = lineOf(typed, '> line one');
    assert.match(typed, /> line one\n {2}line two\n {2}line three/);
    assert.deepEqual(res.cursors.typed, [row + 2, 12]);
    // Up twice lands on the first line, keeping the column (clamped to that line's length).
    assert.deepEqual(res.cursors.moved, [row, 10]);
    const sent = (res.server.requests[0]!.body.messages as { role: string; content: string }[]).at(-1)!;
    assert.equal(sent.content, 'line one\nline two\nline three');
    assert.match(res.snapshots.accept!, /⏵⏵ accept edits \(shift\+tab to cycle\)/);
    assert.match(res.snapshots.plan!, /⏵⏵ plan mode \(shift\+tab to cycle\)/);
    assert.match(res.snapshots.history!, /! echo from-the-shell\n {2}from-the-shell/);
    assert.match(res.snapshots.history!, /> !echo from-the-shell$/m);
  });

  test('plan mode: the plan is shown for approval before anything changes', async () => {
    const res = await tui({
      script: [
        { toolCalls: [{ name: 'Read', arguments: { file_path: 'hello.txt' } }, { name: 'Write', arguments: { file_path: 'sneaky.txt', content: 'x' } }] },
        { toolCalls: [{ name: 'ExitPlanMode', arguments: { plan: '## Plan\n\n1. Change the greeting\n2. Run the tests\n' } }] },
        { toolCalls: [{ name: 'Edit', arguments: { file_path: 'hello.txt', old_string: 'hello world', new_string: 'hi world' } }] },
        { text: 'Plan carried out.' },
      ],
      steps: [
        { send: `${SHIFT_TAB}${SHIFT_TAB}`, after: 0.2 },
        { send: 'plan a change\r' },
        { wait: 'Go ahead with this plan?', timeout: 15 },
        { snapshot: 'plan' },
        { send: '\r' },
        { wait: 'Plan carried out.', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'end' },
      ],
    });
    assert.match(res.snapshots.plan!, /Proposed plan/);
    assert.match(res.snapshots.plan!, /1\. Change the greeting\n\s+2\. Run the tests/);
    assert.match(res.snapshots.plan!, /● Write\(sneaky\.txt\)\n\s+└ Plan mode is active/);
    assert.ok(!fs.existsSync(path.join(res.dir, 'sneaky.txt')));
    assert.equal(fs.readFileSync(path.join(res.dir, 'hello.txt'), 'utf8'), 'hi world\nsecond line\n');
    assert.match(res.snapshots.end!, /⏵⏵ accept edits/);
  });

  test('questions from the model and the live task list', async () => {
    const res = await tui({
      script: [
        {
          toolCalls: [
            { name: 'AskUserQuestion', arguments: { questions: [{ question: 'Which database?', header: 'Database', options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres', description: 'a server' }] }] } },
          ],
        },
        {
          toolCalls: [
            { name: 'TodoWrite', arguments: { todos: [{ content: 'Create schema', status: 'completed' }, { content: 'Write queries', status: 'in_progress', activeForm: 'Writing queries' }, { content: 'Add tests', status: 'pending' }] } },
          ],
        },
        { text: 'Using Postgres.', delayMs: 1500 },
      ],
      steps: [
        { send: 'set up storage\r' },
        { wait: 'Which database?', timeout: 15 },
        { snapshot: 'question' },
        { send: `${DOWN}\r`, after: 0.8 },
        { snapshot: 'working' },
        { wait: 'Using Postgres.', timeout: 15 },
      ],
    });
    assert.match(res.snapshots.question!, /Database\n Which database\?\n ❯ 1\. SQLite {2}one file\n {3}2\. Postgres {2}a server\n {3}3\. Other/);
    const answer = (res.server.requests[1]!.body.messages as { role: string; content: string }[]).find((m) => m.role === 'tool')!;
    assert.match(answer.content, /Q: Which database\?\nA: Postgres/);
    // While the model works, the task list stays visible under the spinner.
    const working = res.snapshots.working!;
    const spinner = lineOf(working, 'esc to interrupt');
    assert.match(working.split('\n').slice(spinner + 1, spinner + 4).join('\n'), /☑ Create schema\n\s+◼ Writing queries\n\s+☐ Add tests/);
  });

  test('/rewind restores files and puts the prompt back', async () => {
    const res = await tui({
      script: [
        { toolCalls: [{ name: 'Read', arguments: { file_path: 'hello.txt' } }] },
        { toolCalls: [{ name: 'Edit', arguments: { file_path: 'hello.txt', old_string: 'hello world', new_string: 'changed world' } }] },
        { text: 'Edited.' },
      ],
      args: ['--permission-mode', 'acceptEdits'],
      steps: [
        { send: 'change the file\r' },
        { wait: '● Edited.', timeout: 15 },
        { sleep: 0.3 },
        { send: '/rewind\r' },
        { wait: 'Rewind to just before which message?', timeout: 10 },
        { snapshot: 'points' },
        { send: '\r' },
        { wait: 'What should be restored?', timeout: 10 },
        { send: '\r' },
        { wait: 'Rewind: conversation rewound, 1 file restored.', timeout: 10 },
        { sleep: 0.3 },
        { snapshot: 'end' },
      ],
    });
    assert.match(res.snapshots.points!, /❯ 1\. change the file {2}1 file changed since/);
    assert.equal(fs.readFileSync(path.join(res.dir, 'hello.txt'), 'utf8'), 'hello world\nsecond line\n');
    assert.match(res.snapshots.end!, /^> change the file$/m);
    assert.ok(!res.snapshots.end!.includes('● Edited.'), 'later messages are gone from the screen');
  });

  test('a # note is saved to the chosen memory file and loaded', async () => {
    const res = await tui({
      script: [{ text: 'ok' }],
      steps: [
        { send: '#always run the linter before committing\r' },
        { wait: 'Save this note to', timeout: 10 },
        { snapshot: 'targets' },
        { send: '\r' },
        { wait: 'Saved to COCO.md.', timeout: 10 },
        { send: 'hi\r' },
        { wait: '● ok', timeout: 15 },
      ],
    });
    assert.match(res.snapshots.targets!, /❯ 1\. Project memory {2}COCO\.md/);
    assert.equal(fs.readFileSync(path.join(res.dir, 'COCO.md'), 'utf8'), '- always run the linter before committing\n');
    assert.match(String(res.server.requests[0]!.body.messages[0].content), /always run the linter before committing/);
  });

  test('a reply much taller than the terminal lands in the scrollback intact', async () => {
    const items = Array.from({ length: 70 }, (_, i) => `- item number ${i + 1} with some words after it`).join('\n');
    const code = `\`\`\`js\n${Array.from({ length: 30 }, (_, i) => `const v${i + 1} = compute(${i + 1}); // code line ${i + 1}`).join('\n')}\n\`\`\``;
    const res = await tui({
      script: [{ text: `A long list:\n\n${items}\n\nAnd code:\n\n${code}\n\nEND OF REPLY` }, { text: 'short second reply' }],
      cols: 70,
      rows: 20,
      steps: [
        { send: 'long answer please\r' },
        { wait: 'END OF REPLY', timeout: 20 },
        { sleep: 0.5 },
        { send: 'again\r' },
        { wait: 'short second reply', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'all', full: true },
      ],
    });
    const rows = res.snapshots.all!.split('\n');
    // Every line exactly once and in order: nothing redrawn twice, nothing lost.
    const seen = rows.map((l) => /item number (\d+) with/.exec(l)?.[1]).filter((v): v is string => v !== undefined).map(Number);
    assert.deepEqual(seen, Array.from({ length: 70 }, (_, i) => i + 1));
    const codeSeen = rows.map((l) => /\/\/ code line (\d+)$/.exec(l)?.[1]).filter((v): v is string => v !== undefined).map(Number);
    assert.deepEqual(codeSeen, Array.from({ length: 30 }, (_, i) => i + 1));
    // Only the current prompt box exists; earlier ones were erased, not left behind.
    assert.equal(rows.filter((l) => /^─{20,}$/.test(l)).length, 2);
    assert.equal(rows.filter((l) => l.includes('Ask coco to do something')).length, 1);
    for (const row of rows) assert.ok(row.length <= 70, `row too wide: ${JSON.stringify(row)}`);
  });

  test('/memory opens the chosen file in the editor and reloads it', async () => {
    const dir = tempProject();
    // Stands in for an editor: appends a line and exits.
    writeFiles(dir, { 'fake-editor.sh': '#!/bin/sh\necho "Prefer tabs." >> "$1"\n' });
    fs.chmodSync(path.join(dir, 'fake-editor.sh'), 0o755);
    const res = await tui({
      dir,
      script: [{ text: 'ok' }],
      env: { EDITOR: path.join(dir, 'fake-editor.sh') },
      steps: [
        { send: '/memory\r' },
        { wait: 'Which memory file?', timeout: 10 },
        { send: '\r' },
        { wait: 'Reloaded memory (1 file).', timeout: 10 },
        { sleep: 0.3 },
        { snapshot: 'after' },
        { send: 'hi\r' },
        { wait: '● ok', timeout: 15 },
      ],
    });
    assert.equal(fs.readFileSync(path.join(dir, 'COCO.md'), 'utf8'), 'Prefer tabs.\n');
    // The UI is intact after handing the terminal to the editor and back.
    assert.match(res.snapshots.after!, /> Ask coco to do something/);
    assert.match(String(res.server.requests[0]!.body.messages[0].content), /Prefer tabs\./);
  });

  test('reasoning is summarised, and shown in full with ctrl+o', async () => {
    const res = await tui({
      script: [
        { thinking: 'The user greets me. I should answer politely.', text: 'Hello!', delayMs: 2200 },
        { thinking: 'Second round of careful thought.', text: 'Hello again!', delayMs: 2200 },
      ],
      steps: [
        { send: 'hi\r' },
        { wait: '● Hello!', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'quiet' },
        { send: '\x0f', after: 0.2 },
        { send: 'hi again\r' },
        { wait: '● Hello again!', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'verbose' },
      ],
    });
    assert.match(res.snapshots.quiet!, /✻ Thought for \d+s/);
    assert.ok(!res.snapshots.quiet!.includes('answer politely'));
    assert.match(res.snapshots.verbose!, /✻ Thinking \(\d+s\)\n\s+Second round of careful thought\./);
  });

  test('--resume with no id offers earlier conversations', async () => {
    const dir = tempProject();
    writeFiles(dir, { 'hello.txt': 'hello\n' });
    // First conversation.
    await tui({ dir, script: [{ text: 'Your favourite colour is teal.' }], steps: [{ send: 'my favourite colour is teal\r' }, { wait: 'colour is teal.', timeout: 15 }, { sleep: 0.3 }] });
    const res = await tui({
      dir,
      script: [{ text: 'Teal, as you said.' }],
      args: ['--resume'],
      ready: 'Resume a conversation',
      steps: [
        { snapshot: 'picker' },
        { send: '\r' },
        { wait: 'Resumed session', timeout: 10 },
        { snapshot: 'resumed' },
        { send: 'which colour?\r' },
        { wait: 'Teal, as you said.', timeout: 15 },
      ],
    });
    assert.match(res.snapshots.picker!, /❯ 1\. my favourite colour is teal {2}\d+s ago · 2 messages/);
    assert.match(res.snapshots.resumed!, /> my favourite colour is teal\n\n● Your favourite colour is teal\./);
    const contents = (res.server.requests[0]!.body.messages as { content: string }[]).map((m) => m.content).slice(1);
    assert.deepEqual(contents, ['my favourite colour is teal', 'Your favourite colour is teal.', 'which colour?']);
  });

  test('a project that runs code asks for trust first, and a status line command is shown', async () => {
    const settings = JSON.stringify({ statusLine: { type: 'command', command: 'echo "branch: main"' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'touch hook-ran.txt' }] }] } });
    const declined = await tui({
      script: [{ text: 'hello' }],
      files: { '.coco/settings.json': settings },
      ready: 'Trust the files in',
      steps: [
        { snapshot: 'trust' },
        { send: `${DOWN}\r` },
        { wait: 'coco v', timeout: 15 },
        { send: 'hi\r' },
        { wait: '● hello', timeout: 15 },
        { sleep: 0.4 },
        { snapshot: 'end' },
      ],
    });
    assert.match(declined.snapshots.trust!, /hooks, MCP servers or a status line command/);
    assert.ok(!fs.existsSync(path.join(declined.dir, 'hook-ran.txt')), 'hooks must not run in an untrusted project');
    assert.ok(!declined.snapshots.end!.includes('branch: main'));

    const trusted = await tui({
      script: [{ text: 'hello' }],
      files: { '.coco/settings.json': settings },
      ready: 'Trust the files in',
      steps: [{ send: '\r' }, { wait: 'coco v', timeout: 15 }, { send: 'hi\r' }, { wait: '● hello', timeout: 15 }, { sleep: 0.6 }, { snapshot: 'end' }],
    });
    assert.ok(fs.existsSync(path.join(trusted.dir, 'hook-ran.txt')));
    assert.match(trusted.snapshots.end!, /^ {2}branch: main\s+mock-model · \d+% context$/m);
  });

  test('first run with several models asks which to use and remembers it', async () => {
    const res = await tui({
      script: [{ text: 'A reply long enough that it has to wrap inside a narrow terminal without disturbing the prompt box underneath it.' }],
      ollama: true,
      server: { models: ['alpha-model', 'beta-model'] },
      ready: 'Which model should coco use?',
      cols: 52,
      rows: 26,
      steps: [
        { snapshot: 'picker' },
        { send: `${DOWN}\r` },
        { wait: 'Ask coco', timeout: 15 },
        { send: 'hello\r' },
        { wait: 'underneath it.', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'narrow' },
        { send: '\x03', after: 0.3 },
        { snapshot: 'ctrlc' },
        { send: '\x03' },
        { wait: 'Resume this session with: coco --resume', timeout: 10 },
      ],
    });
    assert.match(res.snapshots.picker!, /❯ 1\. beta-model/);
    assert.equal(res.server.requests[0]!.body.model, 'alpha-model');
    assert.equal(res.server.requests[0]!.path, '/api/chat');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(res.dir, '.coco-home/settings.json'), 'utf8')), { model: 'alpha-model', provider: 'ollama' });
    // Every row fits the terminal: nothing was left to the terminal to wrap.
    for (const line of res.snapshots.narrow!.split('\n')) assert.ok(line.length <= 52, `row too wide: ${JSON.stringify(line)}`);
    assert.match(res.snapshots.narrow!, /● A reply long enough that it has to wrap inside a\n {2}narrow terminal/);
    assert.match(res.snapshots.ctrlc!, /Press ctrl\+c again to exit/);
  });

  test('ctrl+g and ctrl+x ctrl+e edit the prompt in $EDITOR', async () => {
    const dir = tempProject();
    // Stands in for an editor and, like a real one, reads the keyboard: "fail" makes it exit with
    // an error, an empty line leaves the file alone, anything else is added to the file as a line.
    writeFiles(dir, {
      'line-editor.sh': [
        '#!/bin/sh',
        'here=$(dirname "$0")',
        'cp "$1" "$here/seen.txt"',
        'echo "$1" > "$here/path.txt"',
        'runs=$(($(cat "$here/runs" 2>/dev/null || echo 0) + 1))',
        'echo "$runs" > "$here/runs"',
        'printf "edit %s> " "$runs"',
        'read -r line',
        'case "$line" in',
        '  fail) echo garbage > "$1"; exit 3 ;;',
        '  "") exit 0 ;;',
        '  *) echo "$line" >> "$1" ;;',
        'esac',
        '',
      ].join('\n'),
    });
    fs.chmodSync(path.join(dir, 'line-editor.sh'), 0o755);
    const pasted = Array.from({ length: 8 }, (_, i) => `pasted line ${i + 1}`).join('\n');
    const res = await tui({
      dir,
      script: [{ text: 'ok' }],
      env: { EDITOR: path.join(dir, 'line-editor.sh') },
      steps: [
        { send: 'look at this: ' },
        { send: `${ESC}[200~${pasted}${ESC}[201~`, after: 0.3 },
        { snapshot: 'typed' },
        { send: '\x07' },
        { wait: 'edit 1> ', timeout: 10 },
        { snapshot: 'editing' },
        { send: 'fail\r' },
        { wait: 'exited with status 3', timeout: 10 },
        { snapshot: 'failed' },
        { send: '\x18\x05' },
        { wait: 'edit 2> ', timeout: 10 },
        { send: '\r' },
        // The footer is back once the editor has gone.
        { wait: '% context', timeout: 10 },
        { snapshot: 'unchanged' },
        { send: '\x07' },
        { wait: 'edit 3> ', timeout: 10 },
        { send: 'and a line added in the editor\r' },
        { wait: '% context', timeout: 10 },
        { snapshot: 'edited' },
        { send: '\x1f', after: 0.3 },
        { snapshot: 'undone' },
        { send: '\x07' },
        { wait: 'edit 4> ', timeout: 10 },
        { send: 'the line, again\r' },
        { wait: '% context', timeout: 10 },
        { send: '\r' },
        { wait: '● ok', timeout: 15 },
      ],
    });
    const s = res.snapshots;
    const placeholder = 'look at this: [Pasted text #1 +8 lines]';
    assert.equal(promptText(s.typed!), placeholder);
    // The editor has the terminal to itself: no prompt box while it runs.
    assert.ok(!s.editing!.includes('─────'), s.editing);
    // A failing editor changes nothing, whatever it left in the file.
    assert.equal(promptText(s.failed!), placeholder);
    assert.match(s.failed!, /The editor exited with status 3: prompt left as it was/);
    assert.equal(promptText(s.unchanged!), placeholder);
    // The keystrokes went to the editor, every one of them, and none into the prompt.
    assert.match(s.edited!, /^edit 3> and a line added in the editor$/m);
    assert.equal(promptText(s.edited!), `${placeholder}\nand a line added in the editor`);
    assert.equal(promptText(s.undone!), placeholder);
    // The editor was given the real text, pastes written out, in a file that is gone again.
    assert.equal(fs.readFileSync(path.join(dir, 'seen.txt'), 'utf8'), `look at this: ${pasted}\n`);
    const tempFile = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
    assert.match(path.basename(tempFile), /^prompt\.md$/);
    assert.ok(!fs.existsSync(tempFile) && !fs.existsSync(path.dirname(tempFile)), 'the temp file is deleted');
    assert.equal(res.server.requests.length, 1);
    assert.equal(lastMessage(res.server.requests[0]!, 'user').content, `look at this: ${pasted}\nthe line, again`);
  });

  test('ctrl+r searches the prompt history', async () => {
    const res = await tui({
      script: [{ text: 'ok' }],
      history: ['fix the login bug in auth.ts', 'add tests for the parser', 'explain how login works', 'refactor the screen module'],
      steps: [
        { send: 'my draft', after: 0.2 },
        { send: '\x12', after: 0.3 },
        { snapshot: 'open' },
        { send: 'LOG', after: 0.3 },
        { snapshot: 'found' },
        { send: '\x12', after: 0.3 },
        { snapshot: 'older' },
        { send: '\x12', after: 0.3 },
        { snapshot: 'oldest' },
        { send: 'zz', after: 0.3 },
        { snapshot: 'nomatch' },
        { send: '\x7f\x7f', after: 0.3 },
        { snapshot: 'backspaced' },
        { send: ESC, after: 0.4 },
        { snapshot: 'cancelled' },
        { send: '\x12', after: 0.2 },
        { send: 'parser', after: 0.3 },
        { send: '\r', after: 0.4 },
        { snapshot: 'accepted' },
        { send: ' too\r' },
        { wait: '● ok', timeout: 15 },
      ],
    });
    const { snapshots: s, cursors } = res;
    const label = "(reverse-i-search)'";
    // The search line takes the footer's place, and typing goes into it.
    assert.deepEqual(belowPrompt(s.open!), [`${label}': type to search history · enter accepts · esc cancels`]);
    assert.equal(promptText(s.open!), 'my draft');
    assert.deepEqual(cursors.open, [lineOf(s.open!, label), label.length]);
    // The most recent entry containing the query, whatever its case; the prompt box previews it.
    assert.deepEqual(belowPrompt(s.found!), [`${label}LOG': explain how login works`]);
    assert.equal(promptText(s.found!), 'explain how login works');
    assert.deepEqual(cursors.found, [lineOf(s.found!, label), label.length + 3]);
    assert.deepEqual(belowPrompt(s.older!), [`${label}LOG': fix the login bug in auth.ts`]);
    assert.deepEqual(belowPrompt(s.oldest!), ["(reverse-i-search: no older match)'LOG': fix the login bug in auth.ts"]);
    assert.deepEqual(belowPrompt(s.nomatch!), [`${label}LOGzz': no match`]);
    assert.equal(promptText(s.nomatch!), 'my draft');
    assert.deepEqual(belowPrompt(s.backspaced!), [`${label}LOG': explain how login works`]);
    // Escape puts back what was being written, cursor and footer included.
    assert.equal(promptText(s.cancelled!), 'my draft');
    assert.match(belowPrompt(s.cancelled!)[0]!, /^ {2}\? for shortcuts · shift\+tab to change mode\s+mock-model · \d+% context$/);
    assert.deepEqual(cursors.cancelled, [lineOf(s.cancelled!, '> my draft'), '> my draft'.length]);
    // Enter takes the match into the prompt without sending it.
    assert.equal(promptText(s.accepted!), 'add tests for the parser');
    assert.ok(!s.accepted!.includes('reverse-i-search'));
    assert.ok(!s.accepted!.includes('Thinking'), 'nothing was submitted');
    assert.equal(res.server.requests.length, 1);
    assert.equal(lastMessage(res.server.requests[0]!, 'user').content, 'add tests for the parser too');
  });

  test('ctrl+_ undoes edits step by step, and alt+d deletes the next word', async () => {
    const res = await tui({
      script: [{ text: 'ok' }],
      steps: [
        { send: 'one two three', after: 0.2 },
        { send: '\x17', after: 0.2 },
        { snapshot: 'killed' },
        { send: '\x1f', after: 0.2 },
        { snapshot: 'unkilled' },
        { send: '\x01', after: 0.1 },
        { send: `${ESC}d`, after: 0.2 },
        { snapshot: 'worddeleted' },
        { send: '\x05\x19', after: 0.2 },
        { snapshot: 'yanked' },
        { send: '\x1f\x1f', after: 0.2 },
        { snapshot: 'back' },
        { send: '\x03', after: 0.2 },
        { snapshot: 'cleared' },
        { send: '\x1f', after: 0.2 },
        { snapshot: 'uncleared' },
        { send: '\x1f\x1f', after: 0.2 },
        { snapshot: 'bottom' },
        { send: '/he', after: 0.3 },
        { send: '\t', after: 0.2 },
        { snapshot: 'completed' },
        { send: '\x1f', after: 0.3 },
        { snapshot: 'uncompleted' },
        { send: `${ESC}`, after: 0.3 },
        { send: '\x15hello\r' },
        { wait: '● ok', timeout: 15 },
        { send: '\x1f', after: 0.3 },
        { snapshot: 'sent' },
      ],
    });
    const { snapshots: s, cursors } = res;
    assert.equal(promptText(s.killed!), 'one two');
    assert.equal(promptText(s.unkilled!), 'one two three');
    // alt+d at the start of the line takes the first word; ctrl+y gives it back elsewhere.
    assert.equal(promptText(s.worddeleted!), ' two three');
    assert.equal(cursors.worddeleted![1], 2);
    assert.equal(promptText(s.yanked!), ' two threeone');
    assert.equal(promptText(s.back!), 'one two three');
    // ctrl+c empties the prompt; undo is the way back.
    assert.match(s.cleared!, /> Ask coco to do something/);
    assert.equal(promptText(s.uncleared!), 'one two three');
    // What was typed in one go is one step; past it there is nothing left.
    assert.match(s.bottom!, /> Ask coco to do something/);
    assert.match(s.bottom!, /Nothing to undo/);
    assert.equal(promptText(s.completed!), '/help');
    assert.equal(promptText(s.uncompleted!), '/he');
    assert.match(s.uncompleted!, /\/help\s+Show commands and keyboard shortcuts/);
    // A prompt that was sent is out of undo's reach.
    assert.match(s.sent!, /> Ask coco to do something/);
    assert.match(s.sent!, /Nothing to undo/);
    assert.equal(lastMessage(res.server.requests[0]!, 'user').content, 'hello');
  });

  test('ctrl+s stashes the prompt and brings it back', async () => {
    const res = await tui({
      script: [{ text: 'ok' }],
      steps: [
        { send: 'half-written thought', after: 0.2 },
        { send: '\x13', after: 0.3 },
        { snapshot: 'stashed' },
        { send: 'quick question\r' },
        { wait: '● ok', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'answered' },
        { send: '\x13', after: 0.3 },
        { snapshot: 'restored' },
        { send: '\x15', after: 0.1 },
        { send: '\x13', after: 0.3 },
        { snapshot: 'nothing' },
      ],
    });
    const s = res.snapshots;
    assert.match(s.stashed!, /> Ask coco to do something/);
    assert.match(belowPrompt(s.stashed!)[0]!, /^ {2}Prompt stashed · ctrl\+s restores it\s+1 stashed · mock-model · \d+% context$/);
    // The stash waits while another prompt goes out.
    assert.equal(res.server.requests.length, 1);
    assert.equal(lastMessage(res.server.requests[0]!, 'user').content, 'quick question');
    assert.match(belowPrompt(s.answered!)[0]!, /1 stashed · mock-model/);
    assert.equal(promptText(s.restored!), 'half-written thought');
    assert.match(belowPrompt(s.restored!)[0]!, /^ {2}Stashed prompt restored\s+mock-model · \d+% context$/);
    assert.match(belowPrompt(s.nothing!)[0]!, /^ {2}Nothing to stash\s/);
  });

  test('ctrl+t pins the task list under the prompt', async () => {
    const todos = [
      { content: 'Create schema', status: 'completed' },
      { content: 'Write queries', status: 'in_progress', activeForm: 'Writing queries' },
      { content: 'Add tests', status: 'pending' },
    ];
    const res = await tui({
      script: [{ toolCalls: [{ name: 'TodoWrite', arguments: { todos } }] }, { text: 'Schema is in.' }, { text: 'Still going.', delayMs: 2000 }],
      steps: [
        { send: '\x14', after: 0.3 },
        { snapshot: 'empty' },
        { send: '\x14', after: 0.2 },
        { send: 'set up storage\r' },
        { wait: '● Schema is in.', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'idle' },
        { send: '\x14', after: 0.3 },
        { snapshot: 'pinned' },
        { send: 'carry on\r', after: 0.8 },
        { snapshot: 'working' },
        { wait: '● Still going.', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'done' },
        { send: '\x14', after: 0.3 },
        { snapshot: 'hidden' },
      ],
    });
    const s = res.snapshots;
    const list = ['  Tasks · 1 of 3 done · ctrl+t to hide', '  ☑ Create schema', '  ◼ Writing queries', '  ☐ Add tests'];
    assert.deepEqual(belowPrompt(s.empty!).slice(1), ['  No tasks yet · ctrl+t to hide']);
    // Not pinned: once the model is done there is only the footer under the prompt.
    assert.equal(belowPrompt(s.idle!).length, 1);
    assert.deepEqual(belowPrompt(s.pinned!).slice(1), list);
    // While the model works the list is under the spinner, as always, and not repeated below.
    const working = s.working!.split('\n');
    const spinner = lineOf(s.working!, 'esc to interrupt');
    assert.deepEqual(working.slice(spinner + 1, spinner + 4), list.slice(1));
    assert.equal(belowPrompt(s.working!).length, 1);
    assert.deepEqual(belowPrompt(s.done!).slice(1), list);
    assert.equal(belowPrompt(s.hidden!).length, 1);
  });

  test('alt+t toggles thinking and alt+p opens the model picker', async () => {
    const res = await tui({
      script: [{ text: 'first' }, { text: 'second' }, { text: 'third', delayMs: 2000 }],
      server: { models: ['mock-model', 'other-model'] },
      steps: [
        { send: `${ESC}t`, after: 0.3 },
        { snapshot: 'off' },
        { send: 'one\r' },
        { wait: '● first', timeout: 15 },
        { send: `${ESC}t`, after: 0.3 },
        { snapshot: 'on' },
        { send: 'two\r' },
        { wait: '● second', timeout: 15 },
        { send: `${ESC}p` },
        { wait: 'Select a model', timeout: 10 },
        { snapshot: 'picker' },
        { send: `${DOWN}\r` },
        { wait: 'Model set to other-model', timeout: 10 },
        { send: 'three\r', after: 0.8 },
        { send: `${ESC}p`, after: 0.3 },
        { snapshot: 'busy' },
        { wait: '● third', timeout: 15 },
      ],
    });
    const s = res.snapshots;
    assert.match(belowPrompt(s.off!)[0]!, /^ {2}Thinking off for this session\s/);
    assert.match(belowPrompt(s.on!)[0]!, /^ {2}Thinking on for this session\s/);
    const requests = res.server.requests;
    assert.equal(requests[0]!.body.reasoning_effort, 'none');
    assert.equal(requests[1]!.body.reasoning_effort, undefined);
    // The picker is the one /model shows.
    assert.match(s.picker!, /> \/model\n\n Select a model\n ❯ 1\. mock-model {2}custom · current\n {3}2\. other-model {2}custom\n/);
    assert.equal(requests[1]!.body.model, 'mock-model');
    assert.equal(requests[2]!.body.model, 'other-model');
    // Like a typed command, it has to wait for the model to finish.
    assert.match(s.busy!, /Commands are unavailable while the model is working/);
    assert.ok(!s.busy!.includes('Select a model'));
  });

  test('"?" on an empty prompt shows the shortcuts until the next key', async () => {
    const res = await tui({
      script: [{ text: 'ok' }],
      steps: [
        { send: '?', after: 0.3 },
        { snapshot: 'help' },
        { send: 'h', after: 0.3 },
        { snapshot: 'typed' },
        { send: '?', after: 0.3 },
        { snapshot: 'literal' },
        { send: '\x7f\x7f', after: 0.2 },
        { send: '?', after: 0.3 },
        { send: '?', after: 0.3 },
        { snapshot: 'toggled' },
        { send: '?', after: 0.3 },
        { send: ESC, after: 0.4 },
        { snapshot: 'escaped' },
        { send: '?', after: 0.3 },
        { send: 'why?\r' },
        { wait: '● ok', timeout: 15 },
        { sleep: 0.3 },
        { snapshot: 'all', full: true },
      ],
    });
    const { snapshots: s, cursors } = res;
    const panel = belowPrompt(s.help!);
    // Two columns at this width, under the prompt where the footer was.
    assert.match(panel[0]!, /^ {2}!\s+run a shell command\s+ctrl\+g\s+edit in \$EDITOR$/);
    for (const [key, what] of [['ctrl+r', 'search history'], ['ctrl+s', 'stash or restore the prompt'], ['ctrl+_', 'undo'], ['alt+d', 'delete the next word'], ['ctrl+t', 'show or hide the task list'], ['alt+p', 'switch model'], ['alt+t', 'thinking on or off'], ['ctrl+z', 'suspend'], ['up', 'history, or a queued message']] as const) {
      assert.ok(panel.some((row) => new RegExp(`(^| {2})${key.replace('+', '\\+')}\\s+${what}( {2}|$)`).test(row)), `${key} is listed:\n${s.help}`);
    }
    assert.ok(!panel.some((row) => row.includes('% context')), 'the panel replaces the footer');
    for (const row of s.help!.split('\n')) assert.ok(row.length < 90, `row too wide: ${JSON.stringify(row)}`);
    // The "?" itself is not typed, and the cursor stays in the prompt.
    assert.match(s.help!, /> Ask coco to do something/);
    assert.deepEqual(cursors.help, [lineOf(s.help!, '> Ask coco'), 2]);
    // The next key closes the panel and is typed as usual; a "?" after text is just a character.
    assert.equal(promptText(s.typed!), 'h');
    assert.equal(belowPrompt(s.typed!).length, 1);
    assert.equal(promptText(s.literal!), 'h?');
    assert.equal(belowPrompt(s.literal!).length, 1);
    // "?" again and escape only close it.
    for (const name of ['toggled', 'escaped']) {
      assert.match(s[name]!, /> Ask coco to do something/);
      assert.match(belowPrompt(s[name]!).join('\n'), /^ {2}\? for shortcuts · shift\+tab to change mode\s+mock-model · \d+% context$/);
    }
    // It was drawn in the live region only: nothing of it is left in the scrollback.
    assert.ok(!s.all!.includes('search history'), s.all);
    assert.equal(lastMessage(res.server.requests[0]!, 'user').content, 'why?');
  });

  test('the shortcuts panel leaves the prompt on screen in a small terminal', async () => {
    const res = await tui({
      script: [{ text: 'ok' }],
      cols: 46,
      rows: 14,
      steps: [{ send: '?', after: 0.4 }, { snapshot: 'help' }, { send: 'x', after: 0.3 }, { snapshot: 'typed' }],
    });
    const rows = res.snapshots.help!.split('\n');
    for (const row of rows) assert.ok(row.length < 46, `row too wide: ${JSON.stringify(row)}`);
    assert.match(res.snapshots.help!, /> Ask coco to do something/);
    const panel = belowPrompt(res.snapshots.help!);
    assert.match(panel[0]!, /^ {2}!\s+run a shell command$/);
    assert.equal(panel[panel.length - 1], '  … /help has the rest');
    assert.equal(promptText(res.snapshots.typed!), 'x');
  });

  test('up takes the last queued message back into the prompt', async () => {
    const res = await tui({
      script: [{ text: 'Slow answer.', delayMs: 4000 }, { text: 'Answer to the queue.' }],
      steps: [
        { send: 'first\r', after: 0.8 },
        { send: 'queued one\r', after: 0.3 },
        { send: 'queued two\r', after: 0.3 },
        { snapshot: 'queued' },
        { send: UP, after: 0.3 },
        { snapshot: 'taken' },
        { send: ' (edited)\r', after: 0.3 },
        { snapshot: 'requeued' },
        { wait: 'Answer to the queue.', timeout: 15 },
        { sleep: 0.3 },
        { send: UP, after: 0.3 },
        { snapshot: 'idle' },
      ],
    });
    const s = res.snapshots;
    assert.match(s.queued!, /↳ queued: queued one\n {2}↳ queued: queued two\n─+\n> Press up to edit the queued message/);
    // The newest queued message is in the prompt again and no longer waiting.
    assert.equal(promptText(s.taken!), 'queued two');
    assert.match(s.taken!, /↳ queued: queued one\n─/);
    assert.ok(!s.taken!.includes('↳ queued: queued two'));
    assert.match(s.requeued!, /↳ queued: queued one\n {2}↳ queued: queued two \(edited\)\n─/);
    // Both reached the model, the second as edited and only once.
    const users = (res.server.requests[1]!.body.messages as { role: string; content: string }[]).filter((m) => m.role === 'user').map((m) => m.content);
    assert.deepEqual(users, ['first', 'queued one', 'queued two (edited)']);
    assert.equal(res.server.requests.length, 2);
    // With the model idle, up is history again.
    assert.equal(promptText(s.idle!), 'queued two (edited)');
  });

  test('ctrl+z where nothing can resume it, and stops sent from outside', async () => {
    let stoppedState = '';
    const res = await tui({
      script: [{ text: 'pong' }, { text: 'pong again' }],
      steps: [
        { send: 'before', after: 0.2 },
        // No shell above the program here, so the stop is discarded: it has to carry on by itself.
        { send: '\x1a', after: 0.6 },
        { snapshot: 'ctrlz' },
        { send: ' and after\r' },
        { wait: '● pong', timeout: 15 },
        { send: 'kept', after: 0.2 },
        // The side task stops and continues the process meanwhile.
        { sleep: 3 },
        { snapshot: 'continued' },
        { send: ' typing\r' },
        { wait: '● pong again', timeout: 15 },
      ],
      during: async ({ server }) => {
        await until('the first reply', () => server.requests.length >= 1);
        await sleep(700);
        const ui = uiProcess(server);
        assert.ok(ui, 'the UI process is running');
        process.kill(ui.pid, 'SIGTSTP');
        await sleep(150);
        process.kill(ui.pid, 'SIGCONT');
        await sleep(150);
        process.kill(ui.pid, 'SIGSTOP');
        stoppedState = await until('the process to stop', () => {
          const state = uiProcess(server)?.state ?? '';
          return state.startsWith('T') && state;
        });
        // What a shell does with the terminal of a stopped job: back to line mode with echo.
        if (process.platform === 'linux') execFileSync('stty', ['-F', fs.readlinkSync(`/proc/${ui.pid}/fd/0`), 'sane']);
        process.kill(ui.pid, 'SIGCONT');
      },
    });
    const s = res.snapshots;
    assert.equal(promptText(s.ctrlz!), 'before');
    assert.match(stoppedState, /^T/);
    assert.equal(promptText(s.continued!), 'kept');
    // Keys are read one by one again: enter submits instead of ending a line of terminal input.
    assert.deepEqual(res.server.requests.map((r) => lastMessage(r, 'user').content), ['before and after', 'kept typing']);
  });

  test('ctrl+z under a shell stops the program, and fg brings it back', { skip: spawnSync('bash', ['--version']).status === 0 ? false : 'bash is not installed' }, async () => {
    const dir = tempProject();
    const server = await startMockServer([{ text: 'pong' }]);
    servers.push(server);
    const launcher = fileURLToPath(new URL('../bin/coco.js', import.meta.url));
    // The shared pty driver starts the program with nothing above it. Job control needs a shell,
    // so this one starts bash and types the command; it checks the raw output for what is expected.
    const driver = String.raw`
import json, os, pty, select, sys, time
spec = json.load(open(sys.argv[1]))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec["cwd"])
    os.execvpe("bash", ["bash", "--norc", "--noprofile", "-i"], {**os.environ, **spec["env"]})
out = b""
mark = 0
failed = None
def pump(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            out += data
for step in spec["steps"]:
    if "send" in step:
        os.write(fd, step["send"].encode())
        pump(0.3)
        continue
    want = step["expect"].encode()
    deadline = time.time() + 20
    while want not in out[mark:] and time.time() < deadline:
        pump(0.1)
    at = out.find(want, mark)
    if at < 0:
        failed = step["expect"]
        break
    mark = at + len(want)
os.kill(pid, 9)
print(json.dumps({"failed": failed, "output": out.decode("utf-8", "replace")}))
`;
    writeFiles(dir, {
      'jobs.py': driver,
      'jobs.json': JSON.stringify({
        cwd: dir,
        env: { TERM: 'xterm-256color', PS1: 'READY$ ', COCO_CONFIG_DIR: path.join(dir, '.coco-home'), CLAUDE_CONFIG_DIR: path.join(dir, '.claude-home'), OLLAMA_HOST: '127.0.0.1:1' },
        steps: [
          { expect: 'READY$ ' },
          { send: `node ${launcher} --base-url ${server.url} --model mock-model\r` },
          { expect: 'coco v' },
          { send: 'hello' },
          { expect: 'hello' },
          { send: '\x1a' },
          // The shell reports the stopped job and prompts again: the terminal is its own.
          { expect: 'Stopped' },
          { expect: 'READY$ ' },
          { send: 'echo back-in-the-shell\r' },
          { expect: 'back-in-the-shell\r\nREADY$ ' },
          { send: 'fg\r' },
          // Redrawn after the stop, with the text that was being typed.
          { expect: 'hello' },
          { send: ' world\r' },
          { expect: 'pong' },
        ],
      }),
    });
    const child = spawn('python3', [path.join(dir, 'jobs.py'), path.join(dir, 'jobs.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    await new Promise((resolve) => child.on('close', resolve));
    clearTimeout(timer);
    assert.ok(stdout.trim(), `the driver printed nothing: ${stderr}`);
    const result = JSON.parse(stdout) as { failed: string | null; output: string };
    assert.equal(result.failed, null, `never saw ${JSON.stringify(result.failed)} in:\n${result.output}`);
    assert.equal(server.requests.length, 1);
    assert.equal(lastMessage(server.requests[0]!, 'user').content, 'hello world');
  });
});
