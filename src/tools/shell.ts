import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onData?: (chunk: string) => void;
  /** Maximum characters of output kept. The middle is dropped when exceeded. */
  maxOutput?: number;
  /** How long to wait after SIGTERM before SIGKILL. */
  killGraceMs?: number;
}

export interface RunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  /** Working directory after the command, when it could be determined. */
  cwd?: string;
}

export function shellPath(): { shell: string; args: (cmd: string) => string[] } {
  if (process.platform === 'win32') {
    const bash = process.env.COCO_SHELL;
    if (bash) return { shell: bash, args: (cmd) => ['-c', cmd] };
    return { shell: process.env.ComSpec || 'cmd.exe', args: (cmd) => ['/d', '/s', '/c', cmd] };
  }
  const candidates = [process.env.COCO_SHELL, process.env.SHELL, '/bin/bash', '/bin/sh'];
  for (const sh of candidates) {
    if (!sh) continue;
    const base = path.basename(sh);
    if ((base === 'bash' || base === 'zsh' || base === 'sh') && fs.existsSync(sh)) {
      return { shell: sh, args: (cmd) => ['-c', cmd] };
    }
  }
  return { shell: '/bin/sh', args: (cmd) => ['-c', cmd] };
}

/** Environment for child commands: non-interactive, no pagers. */
export function commandEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    COCO: '1',
    ...extra,
  };
}

/**
 * Kill a process and everything it started. With `evenIfExited`, the process
 * group is signalled although its leader is gone, to reach children that
 * outlived the shell.
 */
export function killTree(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', evenIfExited = false): void {
  if (proc.pid === undefined) return;
  if (!evenIfExited && (proc.exitCode !== null || proc.signalCode !== null)) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      // Negative pid targets the process group created by `detached: true`.
      process.kill(-proc.pid, signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Keep the head and tail of long output; the middle is rarely what matters. */
export function clampOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const dropped = text.length - max;
  return `${text.slice(0, head)}\n\n... [${dropped} characters truncated] ...\n\n${text.slice(text.length - tail)}`;
}

class OutputBuffer {
  private head = '';
  private tail = '';
  private total = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(chunk: string): void {
    this.total += chunk.length;
    const headRoom = Math.floor(this.max * 0.4) - this.head.length;
    if (headRoom > 0) {
      this.head += chunk.slice(0, headRoom);
      chunk = chunk.slice(headRoom);
    }
    if (chunk) {
      const tailMax = this.max - Math.floor(this.max * 0.4);
      this.tail = (this.tail + chunk).slice(-tailMax);
    }
  }

  toString(): string {
    const kept = this.head.length + this.tail.length;
    if (this.total <= kept) return this.head + this.tail;
    return `${this.head}\n\n... [${this.total - kept} characters truncated] ...\n\n${this.tail}`;
  }
}

/**
 * Run a shell command to completion. The session's working directory is
 * tracked by recording `pwd` when the shell exits, so `cd` persists between
 * calls even though each command runs in a fresh shell.
 */
export function runCommand(command: string, opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const { shell, args } = shellPath();
    const posix = process.platform !== 'win32' || Boolean(process.env.COCO_SHELL);
    let cwdFile: string | undefined;
    let script = command;
    if (posix) {
      cwdFile = path.join(os.tmpdir(), `coco-cwd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      script = `trap 'pwd -P > ${shellQuote(cwdFile)} 2>/dev/null' EXIT\n${command}`;
    }

    const buffer = new OutputBuffer(opts.maxOutput ?? 30_000);
    let timedOut = false;
    let interrupted = false;
    let settled = false;

    let proc: ChildProcess;
    try {
      proc = spawn(shell, args(script), {
        cwd: opts.cwd,
        env: commandEnv(opts.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ output: `Failed to start shell: ${(err as Error).message}`, exitCode: 127, timedOut: false, interrupted: false });
      return;
    }

    // Decoding per stream (not per chunk) keeps a multi-byte character intact when it is split across reads.
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    const onChunk = (text: string) => {
      buffer.push(text);
      opts.onData?.(text);
    };
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);

    let exitTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      killTree(proc, 'SIGTERM');
      // Not cancelled when the shell exits: a child that ignores SIGTERM must still go.
      const killTimer = setTimeout(() => killTree(proc, 'SIGKILL', true), opts.killGraceMs ?? 2000);
      killTimer.unref();
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, opts.timeoutMs)
      : undefined;

    const onAbort = () => {
      interrupted = true;
      terminate();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      // Stop listening to pipes a background child may still hold open.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      let cwd: string | undefined;
      if (cwdFile) {
        try {
          const recorded = fs.readFileSync(cwdFile, 'utf8').trim();
          if (recorded && fs.existsSync(recorded)) cwd = recorded;
        } catch {
          // shell died before the trap ran
        }
        fs.rmSync(cwdFile, { force: true });
      }
      resolve({ output: buffer.toString(), exitCode, timedOut, interrupted, cwd });
    };

    proc.on('error', (err) => {
      buffer.push(`\n${err.message}`);
      finish(127);
    });
    proc.on('close', (code) => finish(code));
    // `close` waits for every holder of the output pipes. A command that leaves
    // something running (`server &`) would otherwise hang until the timeout.
    proc.on('exit', (code) => {
      exitTimer = setTimeout(() => finish(code), 250);
    });
  });
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type ShellStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface BackgroundShell {
  id: string;
  command: string;
  startedAt: number;
  status: ShellStatus;
  exitCode: number | null;
}

interface ShellEntry extends BackgroundShell {
  proc: ChildProcess;
  output: string;
  /** How much of `output` has already been returned to the model. */
  readOffset: number;
  dropped: number;
}

const MAX_BACKGROUND_BUFFER = 1_000_000;

/** Long-running commands started with `run_in_background`. */
export class ShellManager {
  private shells = new Map<string, ShellEntry>();
  private counter = 0;
  /** How long a killed shell gets to exit before its process group is SIGKILLed. */
  killGraceMs = 2000;

  start(command: string, cwd: string, env?: Record<string, string>): BackgroundShell {
    const { shell, args } = shellPath();
    const id = `bash_${++this.counter}`;
    const proc = spawn(shell, args(command), {
      cwd,
      env: commandEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const entry: ShellEntry = {
      id,
      command,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      proc,
      output: '',
      readOffset: 0,
      dropped: 0,
    };
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    const onChunk = (text: string) => {
      entry.output += text;
      if (entry.output.length > MAX_BACKGROUND_BUFFER) {
        const cut = entry.output.length - MAX_BACKGROUND_BUFFER;
        entry.output = entry.output.slice(cut);
        entry.readOffset = Math.max(0, entry.readOffset - cut);
        entry.dropped += cut;
      }
    };
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.on('error', (err) => {
      entry.output += `\n${err.message}`;
      entry.status = 'failed';
      entry.exitCode = 127;
    });
    proc.on('close', (code) => {
      if (entry.status === 'running') entry.status = code === 0 ? 'completed' : 'failed';
      entry.exitCode = code;
    });
    this.shells.set(id, entry);
    return entry;
  }

  list(): BackgroundShell[] {
    return [...this.shells.values()].map(({ id, command, startedAt, status, exitCode }) => ({
      id,
      command,
      startedAt,
      status,
      exitCode,
    }));
  }

  has(id: string): boolean {
    return this.shells.has(id);
  }

  /** Output produced since the previous call, optionally filtered to matching lines. */
  read(id: string, filter?: RegExp): { output: string; status: ShellStatus; exitCode: number | null } | undefined {
    const entry = this.shells.get(id);
    if (!entry) return undefined;
    let fresh = entry.output.slice(entry.readOffset);
    entry.readOffset = entry.output.length;
    if (filter) {
      fresh = fresh
        .split('\n')
        .filter((line) => filter.test(line))
        .join('\n');
    }
    return { output: fresh, status: entry.status, exitCode: entry.exitCode };
  }

  kill(id: string): boolean {
    const entry = this.shells.get(id);
    if (!entry) return false;
    if (entry.status === 'running') {
      entry.status = 'killed';
      killTree(entry.proc, 'SIGTERM');
      const t = setTimeout(() => killTree(entry.proc, 'SIGKILL', true), this.killGraceMs);
      t.unref();
    }
    return true;
  }

  killAll(): void {
    for (const id of this.shells.keys()) this.kill(id);
  }

  running(): number {
    return [...this.shells.values()].filter((s) => s.status === 'running').length;
  }
}
