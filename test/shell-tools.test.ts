import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { bashOutputTool, bashTool, filesShownBy, killShellTool } from '../src/tools/bash.ts';
import { editTool, readTool } from '../src/tools/files.ts';
import { ShellManager, clampOutput, commandEnv, runCommand, shellQuote } from '../src/tools/shell.ts';
import type { ToolContext, ToolResult } from '../src/tools/types.ts';
import { makeContext, tempProject } from './helpers.ts';

let dir: string;
let ctx: ToolContext;
const managers: ShellManager[] = [];

beforeEach(() => {
  dir = tempProject('coco-shell-');
  ctx = makeContext(dir, {});
  ctx.session.shells.killGraceMs = 100;
  managers.push(ctx.session.shells);
});
after(() => {
  for (const m of managers) m.killAll();
});

const sh = (command: string, extra: Record<string, unknown> = {}): Promise<ToolResult> => bashTool.execute({ command, ...extra } as never, ctx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is the process still running? A zombie waiting to be reaped counts as gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true; // no /proc on this platform
  }
}

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(20);
  }
  return check();
}

describe('runCommand', () => {
  test('captures output and the exit code', async () => {
    const ok = await runCommand('echo hello', { cwd: dir });
    assert.equal(ok.output, 'hello\n');
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.timedOut, false);
    assert.equal(ok.interrupted, false);
    assert.equal((await runCommand('exit 3', { cwd: dir })).exitCode, 3);
    assert.equal((await runCommand('false', { cwd: dir })).exitCode, 1);
  });

  test('stderr is merged with stdout', async () => {
    const res = await runCommand('echo out; echo err >&2', { cwd: dir });
    assert.deepEqual(res.output.trim().split('\n').sort(), ['err', 'out']);
  });

  test('reports the working directory after the command, also when it fails or exits early', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    assert.equal((await runCommand('true', { cwd: dir })).cwd, dir);
    assert.equal((await runCommand('cd sub', { cwd: dir })).cwd, path.join(dir, 'sub'));
    assert.equal((await runCommand('cd sub && false', { cwd: dir })).cwd, path.join(dir, 'sub'));
    assert.equal((await runCommand('cd sub; exit 7', { cwd: dir })).cwd, path.join(dir, 'sub'));
    const failed = await runCommand('cd /nonexistent-dir-xyz', { cwd: dir });
    assert.equal(failed.cwd, dir);
    assert.notEqual(failed.exitCode, 0);
  });

  test('a directory that vanished is not reported as the working directory', async () => {
    const res = await runCommand('mkdir gone && cd gone && rmdir ../gone', { cwd: dir });
    assert.ok(res.cwd === undefined || fs.existsSync(res.cwd));
  });

  test('stdin is closed, so commands that read it return instead of hanging', async () => {
    const started = Date.now();
    const res = await runCommand('cat; echo done', { cwd: dir, timeoutMs: 5000 });
    assert.equal(res.output, 'done\n');
    assert.ok(Date.now() - started < 2000);
  });

  test('environment: defaults for non-interactive use plus caller additions', async () => {
    const res = await runCommand('echo "$PAGER|$GIT_PAGER|$GIT_TERMINAL_PROMPT|$COCO|$MY_VAR"', { cwd: dir, env: { MY_VAR: 'mine' } });
    assert.equal(res.output.trim(), 'cat|cat|0|1|mine');
    assert.equal(commandEnv({ A: 'b' }).A, 'b');
    assert.equal(commandEnv().PAGER, 'cat');
  });

  test('quotes, heredocs, a trailing backslash and multi-line scripts run as written', async () => {
    assert.equal((await runCommand(`echo "a 'b' c" 'd "e"'`, { cwd: dir })).output, `a 'b' c d "e"\n`);
    assert.equal((await runCommand('cat <<EOF\nline 1\n  line 2\nEOF', { cwd: dir })).output, 'line 1\n  line 2\n');
    assert.equal((await runCommand("cat <<'EOF'\n$HOME `x`\nEOF\necho after", { cwd: dir })).output, '$HOME `x`\nafter\n');
    // A backslash with nothing after it must not swallow anything we append to the script.
    const trailing = await runCommand('echo hi \\', { cwd: dir });
    assert.equal(trailing.exitCode, 0);
    assert.match(trailing.output, /^hi/);
    assert.equal(trailing.cwd, dir);
    assert.equal((await runCommand('x=1\ny=2\necho $((x + y))', { cwd: dir })).output, '3\n');
    assert.equal((await runCommand('echo one # comment\necho two', { cwd: dir })).output, 'one\ntwo\n');
  });

  test("a command's own EXIT trap still runs", async () => {
    const res = await runCommand("trap 'echo bye' EXIT; echo hi", { cwd: dir });
    assert.equal(res.output, 'hi\nbye\n');
    assert.equal(res.exitCode, 0);
  });

  test('a syntax error is reported, not thrown', async () => {
    const res = await runCommand('echo "unterminated', { cwd: dir });
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /unexpected EOF|unterminated|unmatched/i);
  });

  test('a missing working directory is an error result', async () => {
    const res = await runCommand('echo hi', { cwd: path.join(dir, 'does-not-exist') });
    assert.notEqual(res.exitCode, 0);
    assert.ok(res.output.length > 0);
  });

  test('streams output as it arrives', async () => {
    const chunks: string[] = [];
    await runCommand('echo first; sleep 0.2; echo second', { cwd: dir, onData: (c) => chunks.push(c) });
    assert.ok(chunks.length >= 2, `got ${chunks.length} chunk(s)`);
    assert.equal(chunks.join(''), 'first\nsecond\n');
  });

  test('a timeout kills the command and everything it started', async () => {
    const started = Date.now();
    const res = await runCommand('sleep 30 & echo "child=$!"; sleep 30', { cwd: dir, timeoutMs: 300, killGraceMs: 200 });
    assert.equal(res.timedOut, true);
    assert.equal(res.interrupted, false);
    assert.ok(Date.now() - started < 2500, `took ${Date.now() - started}ms`);
    const child = Number(/child=(\d+)/.exec(res.output)?.[1]);
    assert.ok(child > 0, res.output);
    assert.equal(await waitFor(() => !alive(child)), true, 'the background child survived the timeout');
  });

  test('a child that ignores SIGTERM is killed after the grace period', async () => {
    const res = await runCommand(`bash -c 'trap "" TERM; echo "stubborn=$$"; sleep 30' & wait`, { cwd: dir, timeoutMs: 300, killGraceMs: 150 });
    assert.equal(res.timedOut, true);
    const pid = Number(/stubborn=(\d+)/.exec(res.output)?.[1]);
    assert.ok(pid > 0, res.output);
    assert.equal(await waitFor(() => !alive(pid)), true, 'the stubborn child survived');
  });

  test('an abort signal interrupts the command', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const res = await runCommand('echo started; sleep 30', { cwd: dir, signal: controller.signal, killGraceMs: 200 });
    assert.equal(res.interrupted, true);
    assert.equal(res.timedOut, false);
    assert.match(res.output, /started/);
    assert.ok(Date.now() - started < 2500);
    // Already aborted before it starts: returns promptly as interrupted.
    const done = new AbortController();
    done.abort();
    const res2 = await runCommand('sleep 30', { cwd: dir, signal: done.signal, killGraceMs: 200 });
    assert.equal(res2.interrupted, true);
  });

  test('returns when the shell exits even if a background process keeps the output open', async () => {
    const started = Date.now();
    const res = await runCommand('sleep 5 & echo "bg=$!"; echo started', { cwd: dir, timeoutMs: 10_000 });
    assert.ok(Date.now() - started < 2500, `took ${Date.now() - started}ms`);
    assert.match(res.output, /started/);
    assert.equal(res.exitCode, 0);
    assert.equal(res.timedOut, false);
    const pid = Number(/bg=(\d+)/.exec(res.output)?.[1]);
    if (pid > 0) process.kill(pid, 'SIGKILL');
  });

  test('long output keeps its head and tail', async () => {
    const res = await runCommand('for i in $(seq 1 2000); do echo "line $i"; done', { cwd: dir, maxOutput: 1000 });
    assert.ok(res.output.startsWith('line 1\nline 2\n'));
    assert.ok(res.output.trimEnd().endsWith('line 2000'));
    assert.match(res.output, /\.\.\. \[\d+ characters truncated\] \.\.\./);
    assert.ok(res.output.length < 1200, `kept ${res.output.length} characters`);
    const dropped = Number(/\[(\d+) characters truncated\]/.exec(res.output)![1]);
    const total = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}\n`).join('').length;
    assert.equal(dropped, total - 1000);
  });
});

describe('clampOutput and shellQuote', () => {
  test('clampOutput leaves short text alone and cuts the middle of long text', () => {
    assert.equal(clampOutput('short', 100), 'short');
    const long = 'A'.repeat(500) + 'B'.repeat(500);
    const clamped = clampOutput(long, 100);
    assert.ok(clamped.startsWith('A'.repeat(40)));
    assert.ok(clamped.endsWith('B'.repeat(60)));
    assert.match(clamped, /\[900 characters truncated\]/);
  });

  test('shellQuote survives the shell unchanged', async () => {
    for (const value of ['plain', 'with space', "it's", 'a"b', '$HOME `x` $(y)', 'semi;colon && more', '']) {
      const res = await runCommand(`printf '%s' ${shellQuote(value)}`, { cwd: dir });
      assert.equal(res.output, value, value);
    }
  });
});

describe('Bash tool', () => {
  test('returns output with a summary', async () => {
    const res = await sh('echo one; echo two');
    assert.equal(res.content, 'one\ntwo');
    assert.equal(res.isError, false);
    assert.equal(res.summary, '2 lines of output');
    assert.equal((await sh('echo solo')).summary, '1 line of output');
  });

  test('no output and failures are reported plainly', async () => {
    const quiet = await sh('true');
    assert.equal(quiet.content, '(no output)');
    assert.equal(quiet.summary, 'Done');
    const failed = await sh('echo oops >&2; exit 3');
    assert.equal(failed.content, 'oops\nExit code 3');
    assert.equal(failed.isError, true);
    assert.equal(failed.summary, 'Exit code 3');
    const silent = await sh('exit 1');
    assert.equal(silent.content, 'Exit code 1');
    assert.equal((await sh('   ')).isError, true);
  });

  test('the working directory persists between calls', async () => {
    fs.mkdirSync(path.join(dir, 'pkg', 'src'), { recursive: true });
    const first = await sh('cd pkg');
    assert.match(first.content, new RegExp(`Working directory is now ${path.join(dir, 'pkg')}`));
    assert.equal(ctx.cwd, path.join(dir, 'pkg'));
    assert.equal((await sh('pwd')).content, path.join(dir, 'pkg'));
    await sh('cd src && true');
    assert.equal((await sh('pwd')).content, path.join(dir, 'pkg', 'src'));
    // Other tools resolve relative paths against it.
    fs.writeFileSync(path.join(dir, 'pkg', 'src', 'f.txt'), 'x');
    assert.equal((await sh('cat f.txt')).content, 'x');
  });

  test('a failed cd, or a cd into a directory that is then removed, leaves it valid', async () => {
    await sh('cd /nonexistent-dir-xyz');
    assert.equal(ctx.cwd, dir);
    await sh('mkdir gone && cd gone && rmdir ../gone');
    assert.ok(fs.existsSync(ctx.cwd));
    assert.equal((await sh('echo still works')).content, 'still works');
  });

  test('a subshell cd does not move the session', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    await sh('(cd sub && pwd)');
    assert.equal(ctx.cwd, dir);
  });

  test('environment variables from settings reach the command', async () => {
    ctx = makeContext(dir, { env: { DEPLOY_ENV: 'staging' } });
    assert.equal((await sh('echo $DEPLOY_ENV')).content, 'staging');
  });

  test('a sleep that outlives its timeout is killed, with a clear note (timeouts below one second are raised to one)', async () => {
    const started = Date.now();
    const res = await sh('sleep 30 & echo "child=$!"; wait', { timeout: 200 });
    const took = Date.now() - started;
    assert.equal(res.isError, true);
    assert.match(res.content, /^child=\d+\nCommand timed out after 1s and was killed\. For long-running processes use run_in_background\.$/);
    assert.equal(res.summary, 'Timed out after 1s');
    assert.ok(took >= 900 && took < 4000, `took ${took}ms`);
    // Killed, not moved to the background: nothing is left running.
    assert.deepEqual(ctx.session.shells.list(), []);
    const child = Number(/child=(\d+)/.exec(res.content)![1]);
    assert.equal(await waitFor(() => !alive(child)), true, 'the sleep survived the timeout');
  });

  test('the timeout is capped by bashMaxTimeoutMs', async () => {
    ctx = makeContext(dir, { bashMaxTimeoutMs: 1000 });
    const started = Date.now();
    const res = await sh('sleep 30', { timeout: 600_000 });
    assert.match(res.content, /timed out after 1s/);
    assert.ok(Date.now() - started < 4000);
  });

  test('an interrupt is reported as such', async () => {
    const controller = new AbortController();
    const session = ctx.session;
    const aborting: ToolContext = { ...ctx, get cwd() { return session.cwd; }, signal: controller.signal };
    setTimeout(() => controller.abort(), 150);
    const res = await bashTool.execute({ command: 'echo go; sleep 30' }, aborting);
    assert.equal(res.isError, true);
    assert.match(res.content, /Command was interrupted by the user\./);
    assert.equal(res.summary, 'Interrupted');
  });

  test('progress callbacks carry the latest output', async () => {
    const seen: string[] = [];
    const session = ctx.session;
    const watching: ToolContext = { ...ctx, get cwd() { return session.cwd; }, onProgress: (t) => seen.push(t) };
    await bashTool.execute({ command: 'echo a; sleep 0.15; echo b' }, watching);
    assert.equal(seen[seen.length - 1], 'a\nb\n');
  });

  test('output is clamped to maxToolOutputChars', async () => {
    ctx = makeContext(dir, { maxToolOutputChars: 600 });
    const res = await sh('for i in $(seq 1 500); do echo "row $i"; done');
    assert.match(res.content, /characters truncated/);
    assert.ok(res.content.startsWith('row 1\n'));
    const [shown, note] = res.content.split('\n\n[The output was ');
    assert.ok(shown!.endsWith('row 500'));
    assert.ok(shown!.length < 800);
    // Nothing is lost: the whole output is saved where the model can search it.
    const saved = /All of it is saved at (\S+)\. Use Grep/.exec(note!)![1]!;
    const lines = fs.readFileSync(saved, 'utf8').split('\n');
    assert.equal(lines.length, 500);
    assert.equal(lines[249], 'row 250');
  });

  test('output within the limit is returned as is, with nothing saved', async () => {
    const res = await sh('echo short');
    assert.equal(res.content, 'short');
  });

  test('label, read-only detection and the permission request', () => {
    assert.equal(bashTool.label!({ command: 'echo a\n  echo b' }, ctx), 'echo a ⏎ echo b');
    assert.ok(bashTool.label!({ command: 'x'.repeat(300) }, ctx).length <= 100);
    assert.equal(bashTool.isReadOnly({ command: 'ls -la | wc -l' }), true);
    assert.equal(bashTool.isReadOnly({ command: 'git status && git diff' }), true);
    assert.equal(bashTool.isReadOnly({ command: 'rm x' }), false);
    assert.equal(bashTool.isReadOnly({ command: 'ls > out' }), false);
    assert.equal(bashTool.isReadOnly({ command: 'echo $(date)' }), false);
    assert.equal(bashTool.isReadOnly({ command: 'ls', run_in_background: true }), false);
    assert.equal(bashTool.isReadOnly({ command: '' }), false);
    assert.equal(bashTool.isReadOnly({} as never), false);
    assert.deepEqual(bashTool.permission!({ command: 'npm test' }, ctx), { tool: 'Bash', kind: 'bash', target: 'npm test', description: 'npm test' });
  });
});

describe('background shells', () => {
  const output = (id: string, filter?: string) => bashOutputTool.execute({ bash_id: id, filter }, ctx);

  test('start, read incrementally, and see completion', async () => {
    const started = await sh('echo one; sleep 0.4; echo two; exit 0', { run_in_background: true });
    assert.match(started.content, /Started in the background as bash_1\./);
    assert.equal(started.summary, 'Running in background (bash_1)');
    assert.equal(await waitFor(() => (ctx.session.shells.list()[0]?.status ?? '') === 'running'), true);

    let first = '';
    assert.equal(await waitFor(() => first.includes('one') || ((first += ctx.session.shells.read('bash_1')!.output), first.includes('one'))), true);
    const none = await output('bash_1');
    assert.match(none.content, /^Status: (running|completed \(exit code 0\))\n/);

    assert.equal(await waitFor(() => ctx.session.shells.list()[0]!.status === 'completed'), true);
    const rest = await output('bash_1');
    assert.equal(rest.content, 'Status: completed (exit code 0)\ntwo');
    assert.equal(rest.summary, 'completed (exit code 0)');
    const again = await output('bash_1');
    assert.equal(again.content, 'Status: completed (exit code 0)\n(no new output)');
  });

  test('a failing background command reports its exit code', async () => {
    await sh('echo bad >&2; exit 4', { run_in_background: true });
    assert.equal(await waitFor(() => ctx.session.shells.list()[0]!.status === 'failed'), true);
    const res = await output('bash_1');
    assert.equal(res.content, 'Status: failed (exit code 4)\nbad');
  });

  test('a filter keeps only matching lines; a bad filter is an error', async () => {
    await sh('echo "INFO start"; echo "ERROR boom"; echo "INFO end"; echo "ERROR again"', { run_in_background: true });
    assert.equal(await waitFor(() => ctx.session.shells.list()[0]!.status === 'completed'), true);
    const res = await output('bash_1', '^ERROR');
    assert.equal(res.content, 'Status: completed (exit code 0)\nERROR boom\nERROR again');
    const bad = await output('bash_1', '(unclosed');
    assert.equal(bad.isError, true);
    assert.match(bad.content, /Invalid filter regex/);
  });

  test('ids count up and unknown ids are explained', async () => {
    const none = await output('bash_9');
    assert.equal(none.isError, true);
    assert.match(none.content, /No background shell with id bash_9\. None are running\./);
    await sh('sleep 5', { run_in_background: true });
    await sh('sleep 5', { run_in_background: true });
    assert.deepEqual(ctx.session.shells.list().map((s) => s.id), ['bash_1', 'bash_2']);
    assert.match((await output('nope')).content, /Known ids: bash_1, bash_2\./);
    assert.equal(ctx.session.shells.has('bash_2'), true);
    assert.equal(ctx.session.shells.running(), 2);
    assert.equal(ctx.session.shells.read('zzz'), undefined);
  });

  test('KillShell stops the command and what it started', async () => {
    await sh('sleep 30 & echo "child=$!"; sleep 30', { run_in_background: true });
    let text = '';
    assert.equal(await waitFor(() => /child=\d+/.test((text += ctx.session.shells.read('bash_1')!.output))), true);
    const child = Number(/child=(\d+)/.exec(text)![1]);
    assert.equal(alive(child), true);
    const res = await killShellTool.execute({ shell_id: 'bash_1' }, ctx);
    assert.equal(res.content, 'Stopped bash_1.');
    assert.equal(ctx.session.shells.list()[0]!.status, 'killed');
    assert.equal(await waitFor(() => !alive(child)), true, 'the child of the killed shell survived');
    assert.match((await output('bash_1')).content, /^Status: killed/);
    assert.equal(ctx.session.shells.running(), 0);

    const unknown = await killShellTool.execute({ shell_id: 'bash_77' }, ctx);
    assert.equal(unknown.isError, true);
    // Killing a finished shell is harmless and keeps its final status.
    await sh('true', { run_in_background: true });
    assert.equal(await waitFor(() => ctx.session.shells.list()[1]!.status === 'completed'), true);
    assert.equal((await killShellTool.execute({ shell_id: 'bash_2' }, ctx)).isError, undefined);
    assert.equal(ctx.session.shells.list()[1]!.status, 'completed');
  });

  test('killAll stops every running shell', async () => {
    await sh('sleep 30', { run_in_background: true });
    await sh('sleep 30', { run_in_background: true });
    await sh('true', { run_in_background: true });
    assert.equal(await waitFor(() => ctx.session.shells.running() === 2), true);
    ctx.session.shells.killAll();
    assert.equal(ctx.session.shells.running(), 0);
    assert.deepEqual(ctx.session.shells.list().map((s) => s.status).slice(0, 2), ['killed', 'killed']);
  });

  test('a background command runs in the session directory with the settings environment', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    ctx = makeContext(dir, { env: { FLAVOUR: 'mint' } });
    ctx.session.cwd = path.join(dir, 'sub');
    await sh('echo "$PWD $FLAVOUR"', { run_in_background: true });
    assert.equal(await waitFor(() => ctx.session.shells.list()[0]!.status === 'completed'), true);
    assert.match((await bashOutputTool.execute({ bash_id: 'bash_1' }, ctx)).content, new RegExp(`${path.join(dir, 'sub')} mint`));
  });

  test('tool metadata', () => {
    assert.equal(bashOutputTool.isReadOnly({ bash_id: 'x' }), true);
    assert.equal(killShellTool.isReadOnly({ shell_id: 'x' }), false);
    assert.equal(bashOutputTool.label!({ bash_id: 'bash_3' }, ctx), 'bash_3');
  });
});

describe('moving a running command to the background', () => {
  let shells: ShellManager;
  beforeEach(() => {
    shells = ctx.session.shells;
  });

  /** Scratch files in which runCommand records the working directory of this process's commands. */
  const cwdFiles = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`coco-cwd-${process.pid}-`)).sort();
  const pidIn = (text: string, name: string) => Number(new RegExp(`${name}=(\\d+)`).exec(text)?.[1]);

  test('runCommand hands the process over at the timeout and returns with the output so far', async () => {
    const command = 'echo early; echo "pid=$$"; sleep 0.6; echo late; sleep 30 & echo "child=$!"; wait';
    const started = Date.now();
    const res = await runCommand(command, { cwd: dir, timeoutMs: 150, shells, onTimeout: 'background' });
    const took = Date.now() - started;
    assert.ok(took >= 140 && took < 550, `took ${took}ms`);
    assert.match(res.output, /^early\npid=\d+\n$/);
    assert.equal(res.backgroundId, 'bash_1');
    assert.equal(res.timedOut, true);
    assert.equal(res.interrupted, false);
    assert.equal(res.exitCode, null);
    assert.equal(res.cwd, undefined);
    const pid = pidIn(res.output, 'pid');
    assert.equal(alive(pid), true, 'the command was killed');

    // It is a background shell like any other, under the command as it was typed and its real start time.
    const [listed] = shells.list();
    assert.deepEqual([listed!.id, listed!.status, listed!.command, listed!.exitCode], ['bash_1', 'running', command, null]);
    assert.ok(listed!.startedAt >= started && listed!.startedAt < started + 140, 'startedAt is when the command began');
    assert.equal(shells.running(), 1);
    assert.equal(shells.foregroundCount(), 0);

    // The caller already has the output so far; reading returns what comes after it.
    let later = '';
    assert.equal(await waitFor(() => /child=\d+/.test((later += shells.read('bash_1')!.output))), true);
    assert.match(later, /^late\nchild=\d+\n$/);
    const child = pidIn(later, 'child');
    assert.equal(alive(child), true);

    assert.equal(shells.kill('bash_1'), true);
    assert.equal(shells.list()[0]!.status, 'killed');
    assert.equal(await waitFor(() => !alive(pid) && !alive(child)), true, 'a process survived KillShell');
    assert.equal(shells.running(), 0);
  });

  test('a command moved to the background runs to its end and reports its exit code', async () => {
    const before = cwdFiles();
    const res = await runCommand('echo one; sleep 0.4; echo two; exit 3', { cwd: dir, timeoutMs: 150, shells, onTimeout: 'background' });
    assert.equal(res.backgroundId, 'bash_1');
    assert.equal(res.output, 'one\n');
    assert.equal(await waitFor(() => shells.list()[0]!.status === 'failed'), true);
    assert.deepEqual(shells.read('bash_1'), { output: 'two\n', status: 'failed', exitCode: 3 });
    // The scratch file recording its working directory is not left behind.
    assert.deepEqual(cwdFiles(), before);
  });

  test('the timeout still kills when there is no manager to take the command, and by default', async () => {
    const orphan = await runCommand('echo "pid=$$"; sleep 30', { cwd: dir, timeoutMs: 150, killGraceMs: 100, onTimeout: 'background' });
    assert.equal(orphan.timedOut, true);
    assert.equal(orphan.backgroundId, undefined);
    assert.equal(await waitFor(() => !alive(pidIn(orphan.output, 'pid'))), true);

    const plain = await runCommand('echo "pid=$$"; sleep 30', { cwd: dir, timeoutMs: 150, killGraceMs: 100, shells });
    assert.equal(plain.timedOut, true);
    assert.equal(plain.backgroundId, undefined);
    assert.equal(await waitFor(() => !alive(pidIn(plain.output, 'pid'))), true);
    assert.deepEqual(shells.list(), []);
    assert.equal(shells.foregroundCount(), 0);
  });

  test('an abort kills the command even though it could have been moved to the background', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const res = await runCommand('echo "pid=$$"; sleep 30', { cwd: dir, timeoutMs: 5000, killGraceMs: 100, signal: controller.signal, shells, onTimeout: 'background' });
    assert.equal(res.interrupted, true);
    assert.equal(res.timedOut, false);
    assert.equal(res.backgroundId, undefined);
    assert.equal(await waitFor(() => !alive(pidIn(res.output, 'pid'))), true);
    assert.deepEqual(shells.list(), []);
  });

  test('a command that is being killed is not adopted by a timeout or a detach that comes too late', async () => {
    const controller = new AbortController();
    let out = '';
    // Ignoring SIGTERM keeps it alive, dying, until the SIGKILL that follows the grace period.
    const running = runCommand(`trap '' TERM; echo "pid=$$"; sleep 30`, {
      cwd: dir,
      timeoutMs: 250,
      killGraceMs: 400,
      signal: controller.signal,
      shells,
      onTimeout: 'background',
      onData: (chunk) => (out += chunk),
    });
    assert.equal(await waitFor(() => /pid=\d+/.test(out)), true);
    controller.abort();
    assert.deepEqual(shells.detachForeground(), []);
    const res = await running;
    assert.equal(res.interrupted, true);
    assert.equal(res.backgroundId, undefined);
    assert.deepEqual(shells.list(), []);
    assert.equal(await waitFor(() => !alive(pidIn(out, 'pid'))), true);
  });

  test('a command that finishes in time is untouched, and is then no longer in the foreground', async () => {
    const running = runCommand('echo quick', { cwd: dir, timeoutMs: 5000, shells, onTimeout: 'background' });
    assert.equal(shells.foregroundCount(), 1);
    const res = await running;
    assert.deepEqual(res, { output: 'quick\n', exitCode: 0, timedOut: false, interrupted: false, cwd: dir });
    assert.equal(shells.foregroundCount(), 0);
    assert.deepEqual(shells.detachForeground(), []);
    assert.deepEqual(shells.list(), []);
  });

  test('adopt takes over a running process, keeps its earlier output and collects the rest', async () => {
    const proc = spawn('bash', ['-c', 'echo one; sleep 0.4; echo two; sleep 30 & echo "child=$!"; wait'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let early = '';
    const collect = (chunk: Buffer) => (early += chunk.toString());
    proc.stdout!.on('data', collect);
    assert.equal(await waitFor(() => early.includes('one')), true);
    proc.stdout!.off('data', collect);

    const before = Date.now();
    const shell = shells.adopt(proc, 'the command', early);
    assert.equal(shell.id, 'bash_1');
    assert.equal(shells.has('bash_1'), true);
    assert.deepEqual(shells.list().map((s) => [s.id, s.command, s.status, s.exitCode]), [['bash_1', 'the command', 'running', null]]);
    assert.ok(shells.list()[0]!.startedAt >= before);
    assert.equal(shells.running(), 1);
    // Nobody has been given the earlier output yet, so the first read returns it too.
    let text = '';
    assert.equal(await waitFor(() => /child=\d+/.test((text += shells.read('bash_1')!.output))), true);
    assert.match(text, /^one\ntwo\nchild=\d+\n$/);
    assert.equal(shells.read('bash_1', /two/)!.output, '', 'nothing new since');

    const child = pidIn(text, 'child');
    shells.killAll();
    assert.equal(shells.list()[0]!.status, 'killed');
    assert.equal(await waitFor(() => !alive(proc.pid!) && !alive(child)), true, 'a process survived killAll');
  });

  test('adopt: output already passed on is not returned again, and a process that has ended is reported as ended', async () => {
    const proc = spawn('bash', ['-c', 'echo one; sleep 0.3; echo two'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let early = '';
    const collect = (chunk: Buffer) => (early += chunk.toString());
    proc.stdout!.on('data', collect);
    assert.equal(await waitFor(() => early.includes('one')), true);
    proc.stdout!.off('data', collect);
    shells.adopt(proc, 'two steps', early, { delivered: true, startedAt: 1234 });
    assert.equal(shells.list()[0]!.startedAt, 1234);
    assert.equal(await waitFor(() => shells.list()[0]!.status === 'completed'), true);
    assert.deepEqual(shells.read('bash_1'), { output: 'two\n', status: 'completed', exitCode: 0 });

    const gone = spawn('bash', ['-c', 'exit 5'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    await new Promise((done) => gone.on('close', done));
    const ended = shells.adopt(gone, 'exit 5', 'its last words\n');
    assert.equal(ended.id, 'bash_2');
    assert.deepEqual(shells.read('bash_2'), { output: 'its last words\n', status: 'failed', exitCode: 5 });
    assert.equal(shells.running(), 0);
  });

  test('Bash: a command still running at its timeout carries on in the background', async () => {
    // The tool raises timeouts to at least a second; a lower ceiling keeps this test short.
    ctx = makeContext(dir, { bashMaxTimeoutMs: 600 });
    ctx.session.shells.killGraceMs = 100;
    managers.push(ctx.session.shells);
    const started = Date.now();
    const res = await sh('echo begin; echo "pid=$$"; sleep 1; echo later; sleep 30 & echo "child=$!"; wait');
    const took = Date.now() - started;
    assert.ok(took >= 550 && took < 950, `took ${took}ms`);
    const pid = pidIn(res.content, 'pid');
    assert.equal(res.isError, false);
    assert.equal(
      res.content,
      `begin\npid=${pid}\nCommand did not finish within its 1s timeout. It is still running in the background as bash_1; its output so far is above. ` +
        'Use BashOutput with bash_id "bash_1" to follow it and KillShell to stop it.',
    );
    assert.equal(res.summary, 'Still running after 1s, moved to background (bash_1)');
    assert.equal(alive(pid), true, 'the command was killed');

    // More output arrives and is read with BashOutput; what the Bash result showed is not repeated.
    let followed = '';
    for (const end = Date.now() + 3000; !/child=\d+/.test(followed) && Date.now() < end; await sleep(20)) {
      const next = await bashOutputTool.execute({ bash_id: 'bash_1' }, ctx);
      assert.match(next.content, /^Status: running\n/);
      if (!next.content.endsWith('(no new output)')) followed += `${next.content.slice('Status: running\n'.length)}\n`;
    }
    assert.match(followed, /^later\nchild=\d+\n$/);
    const child = pidIn(followed, 'child');

    assert.equal((await killShellTool.execute({ shell_id: 'bash_1' }, ctx)).content, 'Stopped bash_1.');
    assert.equal(await waitFor(() => !alive(pid) && !alive(child)), true, 'a process survived KillShell');
    assert.match((await bashOutputTool.execute({ bash_id: 'bash_1' }, ctx)).content, /^Status: killed/);
    assert.equal(ctx.session.shells.running(), 0);
  });
});

describe('detachForeground', () => {
  const pidIn = (text: string, name: string) => Number(new RegExp(`${name}=(\\d+)`).exec(text)?.[1]);

  test('with nothing running it moves nothing', async () => {
    assert.equal(ctx.session.detachForeground(), 0);
    await sh('echo finished');
    assert.equal(ctx.session.detachForeground(), 0);
    assert.deepEqual(ctx.session.shells.list(), []);
  });

  test('one running command is moved, and its Bash call returns at once', async () => {
    const session = ctx.session;
    let progress = '';
    const watching: ToolContext = { ...ctx, get cwd() { return session.cwd; }, onProgress: (t) => (progress = t) };
    const started = Date.now();
    const call = bashTool.execute({ command: 'echo working; echo "pid=$$"; sleep 30' }, watching);
    assert.equal(await waitFor(() => /pid=\d+\n/.test(progress)), true);
    assert.equal(session.shells.foregroundCount(), 1);

    assert.equal(session.detachForeground(), 1);
    const res = await call;
    assert.ok(Date.now() - started < 2500, 'the call did not return promptly');
    const pid = pidIn(res.content, 'pid');
    assert.equal(res.isError, false);
    assert.equal(
      res.content,
      `working\npid=${pid}\nThe user moved this command to the background. It is still running in the background as bash_1; its output so far is above. ` +
        'Use BashOutput with bash_id "bash_1" to follow it and KillShell to stop it.',
    );
    assert.equal(res.summary, 'Moved to background (bash_1)');
    assert.equal(alive(pid), true, 'the command was killed');
    assert.deepEqual(session.shells.list().map((s) => [s.id, s.status]), [['bash_1', 'running']]);

    // Nothing is left in the foreground to move.
    assert.equal(session.detachForeground(), 0);
    session.shells.killAll();
    assert.equal(await waitFor(() => !alive(pid)), true, 'the command survived killAll');
  });

  test('two running commands are both moved, each to its own shell', async () => {
    const session = ctx.session;
    // Starting with `sleep` only matters at the timeout: the user may move any command.
    const first = sh('sleep 0.3; echo "a=$$"; sleep 30');
    const second = sh('sleep 0.3; echo "b=$$"; sleep 30');
    assert.equal(session.shells.foregroundCount(), 2);
    assert.equal(session.detachForeground(), 2);
    const results = await Promise.all([first, second]);
    for (const [i, res] of results.entries()) {
      const id = `bash_${i + 1}`;
      assert.equal(res.isError, false);
      assert.equal(
        res.content,
        `The user moved this command to the background. It is still running in the background as ${id}; it has printed nothing so far. ` +
          `Use BashOutput with bash_id "${id}" to follow it and KillShell to stop it.`,
      );
    }
    assert.equal(session.shells.running(), 2);
    assert.equal(session.detachForeground(), 0);

    // Each keeps running and is followed on its own.
    let a = '';
    let b = '';
    assert.equal(await waitFor(() => /a=\d+\n/.test((a += session.shells.read('bash_1')!.output)) && /b=\d+\n/.test((b += session.shells.read('bash_2')!.output))), true);
    assert.match(a, /^a=\d+\n$/);
    assert.match(b, /^b=\d+\n$/);
    session.shells.killAll();
    assert.equal(await waitFor(() => !alive(pidIn(a, 'a')) && !alive(pidIn(b, 'b'))), true, 'a command survived killAll');
  });
});

describe('reading a file through the shell counts as reading it', () => {
  const file = (rel: string) => path.join(dir, rel);
  const put = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), content);
  };
  const wasRead = (rel: string) => ctx.session.readFiles.get(file(rel));

  test('cat with output marks the file as read, so Edit needs no separate Read', async () => {
    put('a.txt', 'alpha\nbeta\n');
    const input = { file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' };
    assert.match((await editTool.execute(input, ctx)).content, /You must Read a\.txt before changing it/);
    assert.equal((await sh('cat a.txt')).content, 'alpha\nbeta');
    // The same record the Read tool makes.
    const viaShell = wasRead('a.txt');
    await readTool.execute({ file_path: 'a.txt' }, ctx);
    assert.deepEqual(viaShell, wasRead('a.txt'));
    assert.equal(viaShell?.partial, false);
    assert.match(viaShell!.hash!, /^[0-9a-f]{64}$/);

    ctx.session.readFiles.clear();
    await sh('cat a.txt');
    assert.equal((await editTool.execute(input, ctx)).isError, undefined);
    assert.equal(fs.readFileSync(file('a.txt'), 'utf8'), 'ALPHA\nbeta\n');
  });

  test('a file too long to be shown whole is recorded as read in part', async () => {
    ctx = makeContext(dir, { maxToolOutputChars: 300 });
    put('long.txt', Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join('\n'));
    assert.match((await sh('cat long.txt')).content, /All of it is saved at /);
    assert.equal(wasRead('long.txt')?.partial, true);
  });

  test('cat of an empty file prints nothing, and does not count', async () => {
    put('empty.txt', '');
    put('blank.txt', '\n\n');
    put('a.txt', 'alpha\n');
    assert.equal((await sh('cat empty.txt')).content, '(no output)');
    assert.equal((await sh('cat blank.txt')).content, '(no output)');
    assert.equal((await sh('cat a.txt > /dev/null')).content, '(no output)');
    assert.equal(ctx.session.readFiles.size, 0);
  });

  test('output that went through a pipe, a substitution, a redirect or a chain does not count', async () => {
    put('a.txt', 'alpha\nbeta\n');
    const commands = [
      'cat a.txt | grep alpha',
      'cat $(echo a.txt)',
      'cat `echo a.txt`',
      'cat < a.txt',
      'cat a.txt 2>/dev/null',
      'cat a.txt && true',
      'cat a.txt; echo done',
      'echo first; cat a.txt',
      '(cat a.txt)',
      'F=a.txt; cat $F',
      'cat a.tx?',
      'grep alpha a.txt',
      'wc -l a.txt',
      "sed -n '/alpha/p' a.txt",
      "sed 's/beta/gamma/' a.txt",
    ];
    for (const command of commands) {
      const res = await sh(command);
      assert.equal(res.isError, false, command);
      assert.match(res.content, /alpha|2 a\.txt/, command);
      assert.equal(ctx.session.readFiles.size, 0, command);
    }
  });

  test('a command that failed, or was started in the background, records nothing', async () => {
    put('a.txt', 'alpha\n');
    const res = await sh('cat a.txt missing.txt');
    assert.equal(res.isError, true);
    assert.match(res.content, /^alpha\n/);
    await sh('cat a.txt', { run_in_background: true });
    assert.equal(await waitFor(() => ctx.session.shells.list()[0]!.status === 'completed'), true);
    assert.equal(ctx.session.readFiles.size, 0);
  });

  test('head, tail, nl and sed -n views count, and an option value is not taken for a file', async () => {
    put('a.txt', 'l1\nl2\nl3\nl4\n');
    put('2', 'a file named like a line count\n');
    const views: [string, boolean][] = [
      ['head -n 2 a.txt', true],
      ['head -2 a.txt', true],
      ['tail -n 2 a.txt', true],
      ['tail -n +2 a.txt', true],
      ['tail -c 2 a.txt', true],
      ["sed -n '1,2p' a.txt", true],
      ['sed -n 2p a.txt', true],
      ['nl a.txt', false],
      ['nl -b a a.txt', false],
      ['cat -n a.txt', false],
      ['cat -- a.txt', false],
      ['cat ./a.txt', false],
      [`cat ${file('a.txt')}`, false],
      ["cat 'a.txt'", false],
    ];
    for (const [command, partial] of views) {
      ctx.session.readFiles.clear();
      const res = await sh(command);
      assert.equal(res.isError, false, command);
      assert.deepEqual([...ctx.session.readFiles.keys()], [file('a.txt')], command);
      assert.equal(wasRead('a.txt')!.partial, partial, command);
    }
    // Several files, one with a space in its name.
    put('b c.txt', 'x\n');
    ctx.session.readFiles.clear();
    await sh('cat a.txt "b c.txt"');
    assert.deepEqual([...ctx.session.readFiles.keys()].sort(), [file('a.txt'), file('b c.txt')]);
  });

  test('only regular files inside the working directories are recorded', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-outside-')));
    try {
      fs.writeFileSync(path.join(outside, 'o.txt'), 'outside\n');
      put('a.txt', 'inside\n');
      assert.equal((await sh(`cat ${outside}/o.txt a.txt`)).content, 'outside\ninside');
      assert.deepEqual([...ctx.session.readFiles.keys()], [file('a.txt')]);
      // A link that leads out of the project is outside as well.
      fs.symlinkSync(path.join(outside, 'o.txt'), file('link.txt'));
      assert.equal((await sh('cat link.txt')).content, 'outside');
      assert.equal(wasRead('link.txt'), undefined);
      // A directory the user added is a working directory.
      ctx.session.addDir(outside);
      await sh(`cat ${outside}/o.txt`);
      assert.equal(ctx.session.readFiles.has(path.join(outside, 'o.txt')), true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('paths are resolved against the directory the command ran in', async () => {
    put('sub/f.txt', 'x\n');
    put('f.txt', 'other\n');
    await sh('cd sub');
    assert.equal((await sh('cat f.txt')).content, 'x');
    assert.deepEqual([...ctx.session.readFiles.keys()], [file('sub/f.txt')]);
  });

  test('filesShownBy: which command lines only print files, and which files', () => {
    const full = (...paths: string[]) => ({ paths, partial: false });
    const part = (...paths: string[]) => ({ paths, partial: true });
    assert.deepEqual(filesShownBy('cat a.txt'), full('a.txt'));
    assert.deepEqual(filesShownBy('cat -n a.txt b.txt'), full('a.txt', 'b.txt'));
    assert.deepEqual(filesShownBy('cat "a b.txt" c\\ d.txt'), full('a b.txt', 'c d.txt'));
    assert.deepEqual(filesShownBy('cat -- -n'), full('-n'));
    assert.deepEqual(filesShownBy('cat - x'), full('x'));
    assert.deepEqual(filesShownBy('cat a.txt # just looking'), full('a.txt'));
    // Words the shell rewrites name nothing that can be known in advance.
    assert.deepEqual(filesShownBy('cat "$HOME/x" y*.txt {a,b}.txt z'), full('z'));
    assert.deepEqual(filesShownBy('head -n 20 src/x.ts'), part('src/x.ts'));
    assert.deepEqual(filesShownBy('head -n20 x'), part('x'));
    assert.deepEqual(filesShownBy('head --lines 20 x'), part('x'));
    assert.deepEqual(filesShownBy('head --lines=20 x'), part('x'));
    assert.deepEqual(filesShownBy('head -qn 5 x y'), part('x', 'y'));
    assert.deepEqual(filesShownBy('tail -c 100 x'), part('x'));
    assert.deepEqual(filesShownBy('tail +5 x'), part('x'));
    assert.deepEqual(filesShownBy("sed -n '10,20p' x y"), part('x', 'y'));
    assert.deepEqual(filesShownBy("sed -n '$p' x"), part('x'));
    assert.deepEqual(filesShownBy('nl -ba x'), full('x'));
    assert.deepEqual(filesShownBy('nl -w 3 -s : x'), full('x'));
    assert.deepEqual(filesShownBy('bat -r 1:20 --style plain -pp x.rs'), full('x.rs'));
    assert.deepEqual(filesShownBy('less -N +G -p needle x'), full('x'));
    const not = [
      'cat a | head', 'cat a > b', 'cat a >> b', 'cat < a', 'cat a 2>&1', 'cat $(ls)', 'cat `ls`', 'cat <(echo a)', 'cat a && cat b', 'cat a; cat b', 'cat a\ncat b',
      'cat a &', '(cat a)', '{ cat a; }', 'cat <<EOF\nx\nEOF', 'cat "unclosed', 'grep x a', 'wc -l a', 'ls a', 'echo a', 'FOO=1 cat a', '/bin/cat a', './cat a',
      'sed -n /x/p a', 'sed -i 1p a', 'sed 1p a', "sed -n '1,2p'", "sed -n '1,2p;w out' a", 'toString a', '',
    ];
    for (const command of not) assert.equal(filesShownBy(command), null, JSON.stringify(command));
  });
});

describe('oversized output from Bash', () => {
  test('a successful command shows the first 2,000 characters and the last lines, and saves the rest', async () => {
    const res = await sh('seq 1 20000');
    assert.equal(res.isError, false);
    const [shown, note] = res.content.split('\n\n[The output was ');
    const [head, gap, tail] = shown!.split('\n\n');
    assert.ok(head!.startsWith('1\n2\n3\n'));
    assert.ok(head!.length > 1900 && head!.length <= 2000, `head is ${head!.length} characters`);
    assert.match(head!, /\n\d+$/, 'the head ends with a whole line');
    assert.match(gap!, /^\.\.\. \[\d+ characters truncated\] \.\.\.$/);
    assert.ok(tail!.endsWith('19999\n20000'));
    assert.ok(tail!.length > 400 && tail!.length <= 500, `tail is ${tail!.length} characters`);
    assert.match(note!, /^108893 characters \(20000 lines\), so only its first \d+ characters and its last \d+ lines are shown above\. All of it is saved at /);
    const saved = /All of it is saved at (\S+)\. Use Grep/.exec(note!)![1]!;
    assert.equal(fs.readFileSync(saved, 'utf8'), Array.from({ length: 20000 }, (_, i) => String(i + 1)).join('\n'));
    assert.equal(res.summary!.endsWith('lines of output'), true);
  });

  test('a failed command keeps its head and tail, up to 10,000 characters', async () => {
    const res = await sh('seq 1 20000; exit 2');
    assert.equal(res.isError, true);
    assert.ok(res.content.endsWith(']\nExit code 2'));
    const [shown, note] = res.content.split('\n\n[The output was ');
    assert.ok(shown!.startsWith('1\n2\n3\n'));
    assert.ok(shown!.endsWith('19999\n20000'));
    assert.match(shown!, /\n\n\.\.\. \[\d+ characters truncated\] \.\.\.\n\n/);
    assert.ok(shown!.length > 9_900 && shown!.length <= 10_000, `excerpt is ${shown!.length} characters`);
    assert.match(note!, /^108893 characters \(20000 lines\), so only its beginning and end are shown above\. All of it is saved at /);
  });
});
