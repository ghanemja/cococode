/**
 * Interactive UI tests. The real CLI runs in a pseudo-terminal, keystrokes are
 * sent to it, and assertions are made on the screen a terminal emulator would
 * show. Needs python3 with the `pyte` package; the suite is skipped without it.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { tempProject, writeFiles } from './helpers.ts';
import { startMockServer, type MockServer, type MockServerOptions, type Script } from './mock-server.ts';
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
}

async function tui(s: Scenario): Promise<TuiResult & { dir: string; server: MockServer }> {
  const dir = s.dir ?? tempProject();
  writeFiles(dir, { 'hello.txt': 'hello world\nsecond line\n', ...(s.files ?? {}) });
  const server = await startMockServer(s.script, s.server);
  servers.push(server);
  const res = await runTui({
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
  if (res.timedOut) assert.fail(`Timed out waiting for ${JSON.stringify(res.timedOut.waitingFor)}. Screen was:\n${res.timedOut.screen}`);
  return { ...res, dir, server };
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
});
