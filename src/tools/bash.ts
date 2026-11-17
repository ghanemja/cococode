import * as fs from 'node:fs';
import * as path from 'node:path';
import { expandHome } from '../config/paths.ts';
import { DEFAULTS } from '../config/settings.ts';
import { analyzeCommand, isReadOnlyCommand, tokenize } from '../permissions/bash.ts';
import { formatDuration, truncate } from '../ui/ansi.ts';
import { recordRead } from './fsutil.ts';
import { runCommand } from './shell.ts';
import { spillOutput } from './spill.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { errorResult } from './types.ts';

/** Most output captured from one command. Beyond this the middle is dropped for good. */
const CAPTURE_LIMIT = 2_000_000;

interface BashInput {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

interface FilePrinter {
  /** Short options that take a value, which is therefore not a file. */
  short: string;
  /** Long options that take a value in the next word. */
  long: string[];
  /** The program shows part of a file, not all of it. */
  partial?: boolean;
}

/** Programs that print the files they are given, so that running one shows the model those files. */
const FILE_PRINTERS: Record<string, FilePrinter> = {
  cat: { short: '', long: [] },
  head: { short: 'nc', long: ['lines', 'bytes'], partial: true },
  tail: { short: 'ncs', long: ['lines', 'bytes', 'sleep-interval', 'pid', 'max-unchanged-stats'], partial: true },
  nl: {
    short: 'bdfhilnsvw',
    long: ['body-numbering', 'section-delimiter', 'footer-numbering', 'header-numbering', 'line-increment', 'join-blank-lines', 'number-format', 'number-separator', 'starting-line-number', 'number-width'],
  },
  bat: {
    short: 'lHrm',
    long: [
      'language', 'highlight-line', 'file-name', 'diff-context', 'tabs', 'wrap', 'terminal-width', 'color', 'italic-text', 'decorations', 'paging', 'pager',
      'map-syntax', 'ignored-suffix', 'theme', 'theme-light', 'theme-dark', 'style', 'line-range', 'binary', 'nonprintable-notation', 'strip-ansi', 'squeeze-limit', 'completion',
    ],
  },
  less: {
    short: 'bhjkoOpPtTxyz#',
    long: ['buffers', 'max-back-scroll', 'max-forw-scroll', 'jump-target', 'lesskey-file', 'lesskey-src', 'log-file', 'LOG-FILE', 'pattern', 'prompt', 'tag', 'tag-file', 'tabs', 'window', 'shift', 'quotes', 'rscroll', 'header'],
  },
};

/** True when the command line redirects input or output: an unquoted `<` or `>`. */
function hasRedirection(command: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '\\') i++;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '<' || ch === '>') return true;
  }
  return false;
}

/**
 * The files a command line prints, when it does nothing but print files: one
 * simple command (no pipe, redirection, substitution or chaining) that is
 * `cat`, `head`, `tail`, `nl`, `bat`, `less`, or `sed -n` with a line range.
 * The paths are as written. Returns null for anything else: output that went
 * through another program is not the file.
 */
export function filesShownBy(command: string): { paths: string[]; partial: boolean } | null {
  const a = analyzeCommand(command);
  if (a.hasSubstitution || a.complex || a.sequence.length !== 1 || a.commands.length !== 1 || hasRedirection(command)) return null;
  const words = tokenize(a.commands[0]!);
  const program = words[0] ?? '';
  // Words the shell rewrites before the program sees them name no file that can be known from here.
  const literal = (word: string) => word !== '' && word !== '-' && !/[$`*?[\]{}]/.test(word);

  if (program === 'sed') {
    // `sed -n '10,20p' file` and nothing fancier, as in the permission rules.
    const args = words.slice(1);
    const flags = args.filter((w) => w.startsWith('-'));
    const rest = args.filter((w) => !w.startsWith('-'));
    if (flags.length !== 1 || flags[0] !== '-n' || rest.length < 2 || !/^(\d+|\$)(,(\d+|\$))?p$/.test(rest[0]!)) return null;
    return { paths: rest.slice(1).filter(literal), partial: true };
  }

  const printer = Object.hasOwn(FILE_PRINTERS, program) ? FILE_PRINTERS[program]! : undefined;
  if (!printer) return null;
  const paths: string[] = [];
  let onlyFiles = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (onlyFiles || !word.startsWith('-') || word === '-') {
      // `tail +5` and `less +G` are positions and commands, not files.
      if (!onlyFiles && word.startsWith('+') && (program === 'tail' || program === 'less')) continue;
      if (literal(word)) paths.push(word);
    } else if (word === '--') {
      onlyFiles = true;
    } else if (word.startsWith('--')) {
      if (!word.includes('=') && printer.long.includes(word.slice(2))) i++;
    } else {
      // A short-option cluster: the first letter that takes a value uses the rest of the word, or else the next word.
      const letters = word.slice(1);
      const at = [...letters].findIndex((letter) => printer.short.includes(letter));
      if (at === letters.length - 1) i++;
    }
  }
  return { paths, partial: Boolean(printer.partial) };
}

/**
 * Reading a file through the shell is reading it: after `cat file` has shown
 * the model the content, Edit must not demand a Read of the same file. Records
 * every regular file inside the working directories that the command printed.
 */
function recordShellReads(ctx: ToolContext, command: string, cwd: string): void {
  const shown = filesShownBy(command);
  if (!shown) return;
  for (const p of shown.paths) {
    const abs = path.resolve(cwd, expandHome(p));
    try {
      if (!fs.statSync(abs).isFile() || !ctx.session.inWorkingDirs(abs)) continue;
    } catch {
      continue; // not a file after all
    }
    recordRead(ctx, abs, shown.partial);
  }
}

export const bashTool: Tool<BashInput> = {
  name: 'Bash',
  description:
    'Run a shell command and return its combined stdout and stderr. The working directory persists between calls. ' +
    'Commands must not wait for input. Use run_in_background for servers and other long-running processes, then BashOutput to read their output. ' +
    'A command still running at its timeout is moved to the background, not killed. ' +
    'Prefer Read, Edit, Glob and Grep over cat, sed, find and grep.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      description: { type: 'string', description: 'What the command does, in a few words' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds (default 120000, max 600000)' },
      run_in_background: { type: 'boolean', description: 'Start the command and return immediately' },
    },
    required: ['command'],
  },
  isReadOnly(input) {
    if (input.run_in_background) return false;
    const a = analyzeCommand(String(input.command ?? ''));
    return !a.hasSubstitution && !a.hasWriteRedirect && !a.complex && a.commands.length > 0 && a.commands.every(isReadOnlyCommand);
  },
  permission: (input) => ({ tool: 'Bash', kind: 'bash', target: input.command, description: input.command }),
  label: (input) => truncate(input.command.replace(/\s*\n\s*/g, ' ⏎ '), 100),
  async execute(input, ctx): Promise<ToolResult> {
    const command = input.command.trim();
    if (!command) return errorResult('command is empty.');
    const env = ctx.settings.env;

    if (input.run_in_background) {
      const shell = ctx.session.shells.start(command, ctx.cwd, env);
      return {
        content: `Started in the background as ${shell.id}. Use BashOutput with bash_id "${shell.id}" to read its output and KillShell to stop it.`,
        summary: `Running in background (${shell.id})`,
      };
    }

    const maxTimeout = ctx.settings.bashMaxTimeoutMs ?? DEFAULTS.bashMaxTimeoutMs;
    const timeoutMs = Math.min(Math.max(1000, input.timeout ?? ctx.settings.bashTimeoutMs ?? DEFAULTS.bashTimeoutMs), maxTimeout);
    const maxOutput = ctx.settings.maxToolOutputChars ?? DEFAULTS.maxToolOutputChars;
    const started = Date.now();
    const cwd = ctx.cwd;
    let tail = '';
    const res = await runCommand(command, {
      cwd,
      env,
      timeoutMs,
      signal: ctx.signal,
      // Capture far more than the model will be shown: the rest is saved to a file it can search.
      maxOutput: Math.max(maxOutput, CAPTURE_LIMIT),
      onData: (chunk) => {
        tail = (tail + chunk).slice(-2000);
        ctx.onProgress?.(tail);
      },
      // A command that outlives its timeout is usually a build, a test run or a server that
      // is still doing its job: it carries on in the background. Waiting was all a `sleep`
      // was for, so that is simply ended.
      shells: ctx.session.shells,
      onTimeout: /^sleep(\s|$)/.test(command) ? 'kill' : 'background',
    });

    const notes: string[] = [];
    if (res.cwd && res.cwd !== ctx.session.cwd && fs.existsSync(res.cwd)) {
      ctx.session.cwd = res.cwd;
      notes.push(`Working directory is now ${res.cwd}`);
    }
    const full = res.output.replace(/\s+$/, '');
    const background = res.backgroundId;
    const failed = background === undefined && (res.interrupted || res.timedOut || res.exitCode !== 0);
    // An unfinished or failed command is judged by how it starts and where it stopped.
    let output = spillOutput(ctx.session.id, ctx.toolCallId, full, maxOutput, { failed: failed || background !== undefined });
    if (background !== undefined) {
      const why = res.timedOut ? `Command did not finish within its ${formatDuration(timeoutMs)} timeout` : 'The user moved this command to the background';
      notes.push(
        `${why}. It is still running in the background as ${background}; ${full ? 'its output so far is above' : 'it has printed nothing so far'}. ` +
          `Use BashOutput with bash_id "${background}" to follow it and KillShell to stop it.`,
      );
    } else if (res.interrupted) notes.push('Command was interrupted by the user.');
    else if (res.timedOut) {
      notes.push(`Command timed out after ${formatDuration(timeoutMs)} and was killed. For long-running processes use run_in_background.`);
    } else if (res.exitCode !== 0) notes.push(`Exit code ${res.exitCode}`);
    // What a plain `cat` printed, the model has read.
    else if (full) recordShellReads(ctx, command, cwd);

    const lineCount = output ? output.split('\n').length : 0;
    if (!output && notes.length === 0) output = '(no output)';
    const content = [output, ...notes].filter(Boolean).join('\n');
    const elapsed = Date.now() - started;
    let summary: string;
    if (background !== undefined) summary = res.timedOut ? `Still running after ${formatDuration(timeoutMs)}, moved to background (${background})` : `Moved to background (${background})`;
    else if (res.interrupted) summary = 'Interrupted';
    else if (res.timedOut) summary = `Timed out after ${formatDuration(timeoutMs)}`;
    else if (res.exitCode !== 0) summary = `Exit code ${res.exitCode}`;
    else summary = lineCount ? `${lineCount} line${lineCount === 1 ? '' : 's'} of output` : 'Done';
    if (elapsed > 5000 && background === undefined) summary += ` (${formatDuration(elapsed)})`;
    return { content, isError: failed, summary };
  },
};

interface BashOutputInput {
  bash_id: string;
  filter?: string;
}

export const bashOutputTool: Tool<BashOutputInput> = {
  name: 'BashOutput',
  description:
    'Read new output from a background shell: one started with Bash run_in_background, or a command moved to the background at its timeout. ' +
    'Returns only output produced since the last call.',
  parameters: {
    type: 'object',
    properties: {
      bash_id: { type: 'string', description: 'Id of the background shell, e.g. bash_1' },
      filter: { type: 'string', description: 'Optional regex; only matching lines are returned' },
    },
    required: ['bash_id'],
  },
  isReadOnly: () => true,
  label: (input) => input.bash_id,
  async execute(input, ctx): Promise<ToolResult> {
    let filter: RegExp | undefined;
    if (input.filter) {
      try {
        filter = new RegExp(input.filter);
      } catch (err) {
        return errorResult(`Invalid filter regex: ${(err as Error).message}`);
      }
    }
    const res = ctx.session.shells.read(input.bash_id, filter);
    if (!res) {
      const ids = ctx.session.shells.list().map((s) => s.id);
      return errorResult(`No background shell with id ${input.bash_id}.${ids.length ? ` Known ids: ${ids.join(', ')}.` : ' None are running.'}`);
    }
    const max = ctx.settings.maxToolOutputChars ?? DEFAULTS.maxToolOutputChars;
    const output = res.output.length > max ? `… [earlier output omitted]\n${res.output.slice(-max)}` : res.output;
    const status = res.status === 'running' ? 'running' : `${res.status}${res.exitCode !== null ? ` (exit code ${res.exitCode})` : ''}`;
    return {
      content: `Status: ${status}\n${output.trim() ? output.replace(/\s+$/, '') : '(no new output)'}`,
      summary: status,
    };
  },
};

interface KillShellInput {
  shell_id: string;
}

export const killShellTool: Tool<KillShellInput> = {
  name: 'KillShell',
  description: 'Stop a background shell, whether started with Bash run_in_background or moved to the background at its timeout.',
  parameters: {
    type: 'object',
    properties: { shell_id: { type: 'string', description: 'Id of the background shell, e.g. bash_1' } },
    required: ['shell_id'],
  },
  isReadOnly: () => false,
  label: (input) => input.shell_id,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.session.shells.kill(input.shell_id)) return errorResult(`No background shell with id ${input.shell_id}.`);
    return { content: `Stopped ${input.shell_id}.`, summary: 'Stopped' };
  },
};
