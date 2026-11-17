import * as fs from 'node:fs';
import { DEFAULTS } from '../config/settings.ts';
import { analyzeCommand, isReadOnlyCommand } from '../permissions/bash.ts';
import { formatDuration, truncate } from '../ui/ansi.ts';
import { runCommand } from './shell.ts';
import type { Tool, ToolResult } from './types.ts';
import { errorResult } from './types.ts';

interface BashInput {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

export const bashTool: Tool<BashInput> = {
  name: 'Bash',
  description:
    'Run a shell command and return its combined stdout and stderr. The working directory persists between calls. ' +
    'Commands must not wait for input. Use run_in_background for servers and other long-running processes, then BashOutput to read their output. ' +
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
    let tail = '';
    const res = await runCommand(command, {
      cwd: ctx.cwd,
      env,
      timeoutMs,
      signal: ctx.signal,
      maxOutput,
      onData: (chunk) => {
        tail = (tail + chunk).slice(-2000);
        ctx.onProgress?.(tail);
      },
    });

    const notes: string[] = [];
    if (res.cwd && res.cwd !== ctx.session.cwd && fs.existsSync(res.cwd)) {
      ctx.session.cwd = res.cwd;
      notes.push(`Working directory is now ${res.cwd}`);
    }
    let output = res.output.replace(/\s+$/, '');
    if (res.interrupted) notes.push('Command was interrupted by the user.');
    else if (res.timedOut) {
      notes.push(`Command timed out after ${formatDuration(timeoutMs)} and was killed. For long-running processes use run_in_background.`);
    } else if (res.exitCode !== 0) notes.push(`Exit code ${res.exitCode}`);

    if (!output && notes.length === 0) output = '(no output)';
    const content = [output, ...notes].filter(Boolean).join('\n');
    const failed = res.interrupted || res.timedOut || res.exitCode !== 0;
    const elapsed = Date.now() - started;
    const lineCount = output ? output.split('\n').length : 0;
    let summary: string;
    if (res.interrupted) summary = 'Interrupted';
    else if (res.timedOut) summary = `Timed out after ${formatDuration(timeoutMs)}`;
    else if (res.exitCode !== 0) summary = `Exit code ${res.exitCode}`;
    else summary = lineCount ? `${lineCount} line${lineCount === 1 ? '' : 's'} of output` : 'Done';
    if (elapsed > 5000) summary += ` (${formatDuration(elapsed)})`;
    return { content, isError: failed, summary };
  },
};

interface BashOutputInput {
  bash_id: string;
  filter?: string;
}

export const bashOutputTool: Tool<BashOutputInput> = {
  name: 'BashOutput',
  description: 'Read new output from a background shell started with Bash run_in_background. Returns only output produced since the last call.',
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
  description: 'Stop a background shell started with Bash run_in_background.',
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
