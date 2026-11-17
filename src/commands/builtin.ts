/** Built-in slash commands. They talk to the UI only through CommandIO, so they are testable without a terminal. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fitTranscript } from '../agent/compact.ts';
import { renderTranscript } from '../providers/textTools.ts';
import { highlight } from '../ui/highlight.ts';
import type { Controller } from '../core/controller.ts';
import { expandCommand, userInvocableSkills } from '../config/extensions.ts';
import { MEMORY_FILE, displayPath } from '../config/paths.ts';
import type { SettingsScope } from '../config/settings.ts';
import { getByPath, parseSettingValue, setByPath, updateSettingsFile } from '../config/settings.ts';
import { appendMemory, memoryTargets } from '../memory/memory.ts';
import { MODE_CYCLE, modeLabel } from '../permissions/manager.ts';
import { exportMarkdown, findSession, listSessions } from '../session/store.ts';
import { findRipgrep } from '../tools/search.ts';
import { parseRule } from '../permissions/rules.ts';
import { inlineBashRunner } from './inline.ts';
import { PERMISSION_MODES, type PermissionMode } from '../types.ts';
import { c, formatBytes, formatContext, formatCount, formatDuration, padEnd, plural } from '../ui/ansi.ts';
import { contextBar, renderTodos } from '../ui/render.ts';
import { APP_NAME, VERSION } from '../version.ts';

export interface SelectOption<T> {
  label: string;
  value: T;
  hint?: string;
}

/** What a command may ask of the front end. */
export interface CommandIO {
  print(text: string): void;
  width(): number;
  select<T>(spec: { question: string; options: SelectOption<T>[]; filterable?: boolean }): Promise<T | undefined>;
  /** Open a file in the user's editor and wait for it to close. */
  editFile(file: string): Promise<void>;
  clearScreen(): void;
  exit(): void;
  /** Re-render previous messages after the conversation was replaced. */
  showHistory(): void;
  /** Flip verbose output and return the new state. */
  toggleVerbose(): boolean;
  /** Put text in the prompt box (used by /rewind to restore the prompt). */
  setInput(text: string): void;
}

export type CommandOutcome =
  | void
  | { type: 'prompt'; prompt: string; display: string; allowedTools?: string[] }
  | { type: 'compact'; instructions?: string };

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  argumentHint?: string;
  run(args: string, ctl: Controller, io: CommandIO): Promise<CommandOutcome> | CommandOutcome;
}

const heading = (s: string) => c.bold(s);
const kv = (k: string, v: string) => `  ${c.dim(padEnd(k, 18))}${v}`;

const INIT_PROMPT = `Analyze this codebase and create a ${MEMORY_FILE} file in the project root. It is loaded into your context at the start of every session, so it should hold what a new contributor needs and cannot quickly work out alone:

1. The commands for building, linting and testing, including how to run a single test.
2. The high-level architecture: the main parts and how they fit together, at the level that takes reading several files to understand.
3. Conventions that are specific to this project and that the code itself does not make obvious.

Read the README and any existing agent instruction files (AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md) and carry over what matters. If ${MEMORY_FILE} already exists, improve it instead of replacing it.

Keep it short and specific. Do not list every file, repeat generic advice, or invent sections for things you did not find.`;

const SECURITY_REVIEW_PROMPT = `Review the changes on this branch for security problems, as a security engineer would before a merge.

1. Find what changed: use git (status, diff against the default branch, log) and read the changed code and enough of its surroundings to follow the data flow.
2. Look for real, exploitable issues introduced by these changes: injection (SQL, shell, template, path traversal), broken authentication or authorization, secrets or credentials in code or logs, unsafe deserialization, missing input validation at trust boundaries, unsafe use of cryptography, and data exposure.
3. Ignore style, hypothetical issues with no path to exploitation, and problems that existed before these changes.

For each finding give: file:line, what an attacker could do, how confident you are, and a concrete fix. If you find nothing significant, say so plainly. Do not modify any files.`;

function copyToClipboard(text: string): boolean {
  const candidates: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']], ['clip.exe', []]];
  for (const [cmd, cmdArgs] of candidates) {
    try {
      const res = spawnSync(cmd, cmdArgs, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
      if (res.status === 0) return true;
    } catch {
      // not installed: try the next one
    }
  }
  return false;
}

const REVIEW_PROMPT = `Review the code changes described below as a careful senior engineer would.

1. Work out what changed: use git (status, diff, log) to read the changes in full, and read the surrounding code where needed to judge them.
2. Look for real problems first: bugs, broken edge cases, security issues, data loss, race conditions, missing error handling, and tests that no longer cover the behaviour.
3. Then note anything that makes the code harder to maintain.

Report findings in order of severity, each with file:line, what is wrong, and a concrete fix. Say so plainly if you find nothing significant. Do not modify any files.`;

function scopeFlag(args: string[]): { scope: SettingsScope; rest: string[] } {
  let scope: SettingsScope = 'user';
  const rest: string[] = [];
  for (const a of args) {
    if (a === '--user' || a === '-u') scope = 'user';
    else if (a === '--project' || a === '-p') scope = 'project';
    else if (a === '--local' || a === '-l') scope = 'local';
    else rest.push(a);
  }
  return { scope, rest };
}

export function usageReport(ctl: Controller): string[] {
  const t = ctl.agent.totals;
  const tps = t.evalMs > 0 ? t.outputTokens / (t.evalMs / 1000) : 0;
  return [
    heading('Session usage'),
    kv('Model', `${ctl.client.model} (${ctl.provider.name})`),
    kv('Requests', String(t.requests)),
    kv('Tool calls', String(t.toolUses)),
    kv('Input tokens', formatCount(t.inputTokens)),
    kv('Output tokens', formatCount(t.outputTokens)),
    kv('Speed', tps ? `${tps.toFixed(1)} tokens/s` : 'n/a'),
    kv('Compactions', String(t.compactions)),
    kv('Duration', formatDuration(Date.now() - ctl.startedAt)),
    kv('Cost', 'free (runs on your hardware)'),
  ];
}

export function contextReport(ctl: Controller): string[] {
  const b = ctl.agent.contextBreakdown();
  const memoryChars = ctl.memory.reduce((n, f) => n + f.content.length, 0);
  const profile = ctl.client.profile;
  const reserve = Math.min(profile.maxOutputTokens, Math.floor(profile.contextWindow / 4));
  return [
    heading('Context window'),
    `  ${contextBar(b.total, b.window)}`,
    kv('System prompt', `${formatCount(b.system)} tokens${memoryChars ? c.dim(` (includes ~${formatCount(Math.ceil(memoryChars / 3.5))} of memory files)`) : ''}`),
    kv('Tool definitions', `${formatCount(b.tools)} tokens (${ctl.tools().length} tools, ${profile.toolMode} mode)`),
    kv('Messages', `${formatCount(b.messages)} tokens (${ctl.agent.messages.length} messages)`),
    kv('Free', `${formatCount(Math.max(0, b.window - b.total))} tokens`),
    kv('Output reserve', `${formatCount(reserve)} tokens`),
    kv('Auto-compact', (ctl.settings.autoCompact ?? true) ? `at ~${formatCount(Math.floor((b.window - reserve) * (ctl.settings.compactThreshold ?? 0.8)))} tokens` : 'off'),
  ];
}

export async function doctorReport(ctl: Controller): Promise<string[]> {
  const ok = c.green('✓');
  const bad = c.red('✗');
  const warn = c.yellow('!');
  const out: string[] = [heading(`${APP_NAME} doctor`), kv('Version', `${VERSION} (node ${process.version}, ${process.platform})`)];

  let reachable = false;
  let modelCount = 0;
  try {
    const models = await ctl.provider.listModels();
    reachable = true;
    modelCount = models.length;
  } catch (err) {
    out.push(`  ${bad} Cannot reach ${ctl.provider.name} at ${ctl.provider.baseUrl}: ${(err as Error).message}`);
  }
  if (reachable) out.push(`  ${ok} ${ctl.provider.name} at ${ctl.provider.baseUrl} (${plural(modelCount, 'model')})`);

  const p = ctl.client.profile;
  out.push(`  ${ok} Model ${ctl.client.model}: ${formatContext(p.contextWindow)} context, ${formatContext(p.maxOutputTokens)} max output, ${p.toolMode} tool calling${p.vision ? ', vision' : ''}`);
  if (p.info?.capabilities) out.push(`    ${c.dim(`capabilities: ${p.info.capabilities.join(', ') || 'none reported'}`)}`);
  if (p.contextWindow < 16_000) out.push(`  ${warn} Context below 16k tokens: long tasks will compact often and tool calling may be unreliable.`);
  for (const note of p.notes) out.push(`  ${warn} ${note}`);

  out.push(findRipgrep() ? `  ${ok} ripgrep found (fast search)` : `  ${warn} ripgrep not found: Grep and Glob use a slower built-in search. Install "rg" for large repositories.`);
  out.push(ctl.env.isGit ? `  ${ok} Git repository${ctl.env.gitBranch ? ` (branch ${ctl.env.gitBranch})` : ''}` : `  ${warn} Not a git repository: /review and change tracking are limited.`);

  for (const e of ctl.loaded.errors) out.push(`  ${bad} Settings: ${e}`);
  for (const e of ctl.mcpErrors) out.push(`  ${warn} MCP config: ${e}`);
  for (const s of ctl.mcp?.status() ?? []) {
    out.push(s.status === 'connected' ? `  ${ok} MCP ${s.name}: ${plural(s.toolCount, 'tool')}` : `  ${bad} MCP ${s.name}: ${s.error ?? s.status}`);
  }
  out.push(ctl.memory.length ? `  ${ok} Memory: ${ctl.memory.map((m) => displayPath(m.path, ctl.session.cwd)).join(', ')}` : `  ${c.dim('·')} No ${MEMORY_FILE} yet. Run /init to create one.`);
  const hooks = ctl.hooks.list();
  if (hooks.length) out.push(`  ${ok} ${plural(hooks.length, 'hook')} configured`);

  const others = ctl.detected.filter((d) => d.name !== ctl.provider.name);
  if (others.length) out.push(`  ${c.dim('·')} Other servers running: ${others.map((d) => `${d.name} (${plural(d.models.length, 'model')})`).join(', ')}`);
  return out;
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show commands and keyboard shortcuts',
    run(_args, ctl, io) {
      const lines = [heading(`${APP_NAME} ${VERSION}`), '', heading('Commands')];
      const all = [...BUILTIN_COMMANDS].sort((a, b) => a.name.localeCompare(b.name));
      for (const cmd of all) lines.push(`  ${c.cyan(padEnd(`/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`, 28))}${cmd.description}`);
      if (ctl.commands.length) {
        lines.push('', heading('Custom commands'));
        for (const cmd of ctl.commands) lines.push(`  ${c.cyan(padEnd(`/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`, 28))}${cmd.description} ${c.dim(`(${cmd.source})`)}`);
      }
      const skills = userInvocableSkills(ctl.skillDefs);
      if (skills.length) {
        lines.push('', heading('Skills'));
        for (const s of skills) lines.push(`  ${c.cyan(padEnd(`/${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ''}`, 28))}${s.description}`);
      }
      lines.push(
        '',
        heading('Input'),
        `  ${padEnd('@path', 28)}attach a file or directory`,
        `  ${padEnd('!command', 28)}run a shell command yourself; the output is shared with the model`,
        `  ${padEnd('#note', 28)}save a note to ${MEMORY_FILE}`,
        `  ${padEnd('\\ + enter, alt+enter', 28)}new line`,
        '',
        heading('Keys'),
        `  ${padEnd('esc', 28)}interrupt the model; twice on an empty prompt to rewind`,
        `  ${padEnd('shift+tab', 28)}cycle permission mode (ask → accept edits → plan)`,
        `  ${padEnd('ctrl+o', 28)}toggle verbose tool output`,
        `  ${padEnd('ctrl+c', 28)}cancel input or interrupt; twice to exit`,
        `  ${padEnd('up / down', 28)}prompt history`,
        `  ${padEnd('ctrl+l', 28)}clear the screen`,
      );
      io.print(lines.join('\n'));
    },
  },
  {
    name: 'clear',
    aliases: ['reset', 'new'],
    description: 'Start a new conversation',
    async run(_args, ctl, io) {
      await ctl.clear();
      io.clearScreen();
      io.print(c.dim('Started a new conversation.'));
    },
  },
  {
    name: 'compact',
    description: 'Summarize the conversation to free context',
    argumentHint: '[what to focus on]',
    run(args, ctl, io) {
      if (ctl.agent.messages.length === 0) {
        io.print(c.dim('Nothing to compact yet.'));
        return;
      }
      return { type: 'compact', instructions: args.trim() || undefined };
    },
  },
  {
    name: 'context',
    description: 'Show what is using the context window',
    run(_args, ctl, io) {
      io.print(contextReport(ctl).join('\n'));
    },
  },
  {
    name: 'usage',
    aliases: ['cost', 'stats'],
    description: 'Show token usage and speed for this session',
    run(_args, ctl, io) {
      io.print(usageReport(ctl).join('\n'));
    },
  },
  {
    name: 'status',
    description: 'Show the model, session and configuration in use',
    run(_args, ctl, io) {
      const p = ctl.client.profile;
      const lines = [
        heading('Status'),
        kv('Version', VERSION),
        kv('Model', ctl.client.model),
        kv('Provider', `${ctl.provider.name} (${ctl.provider.type} API) at ${ctl.provider.baseUrl}`),
        kv('Context', `${formatContext(p.contextWindow)} tokens, ${formatContext(p.maxOutputTokens)} max output`),
        kv('Tool calling', p.toolMode === 'native' ? 'native' : 'text protocol'),
        kv('Images', p.vision ? 'supported' : 'not supported'),
        kv('Permission mode', modeLabel(ctl.permissions.mode)),
        kv('Working dir', ctl.session.cwd),
        kv('Session', ctl.session.id),
        kv('Transcript', displayPath(ctl.transcript.path, ctl.session.cwd)),
        kv('Memory files', ctl.memory.length ? ctl.memory.map((m) => displayPath(m.path, ctl.session.cwd)).join(', ') : 'none'),
        kv('MCP servers', (ctl.mcp?.status() ?? []).map((s) => `${s.name} (${s.status})`).join(', ') || 'none'),
        kv('Settings', ctl.loaded.sources.filter((s) => s.path).map((s) => displayPath(s.path!, ctl.session.cwd)).join(', ') || 'defaults'),
      ];
      for (const note of p.notes) lines.push(`  ${c.yellow('!')} ${note}`);
      io.print(lines.join('\n'));
    },
  },
  {
    name: 'doctor',
    description: 'Check the model server, tools and configuration',
    async run(_args, ctl, io) {
      io.print((await doctorReport(ctl)).join('\n'));
    },
  },
  {
    name: 'model',
    description: 'Switch model',
    argumentHint: '[name]',
    async run(args, ctl, io) {
      let model = args.trim();
      let provider: string | undefined;
      if (!model) {
        const all = await ctl.allModels();
        if (all.length === 0) {
          io.print(c.yellow('No models found on any local server.'));
          return;
        }
        const pick = await io.select({
          question: 'Select a model',
          filterable: all.length > 10,
          options: all.map(({ provider: prov, model: m }) => ({
            label: m.id,
            value: { provider: prov, id: m.id },
            hint: [prov, m.parameterSize, m.quantization, m.sizeBytes ? formatBytes(m.sizeBytes) : '', m.loaded ? 'loaded' : '', m.id === ctl.client.model && prov === ctl.provider.name ? 'current' : '']
              .filter(Boolean)
              .join(' · '),
          })),
        });
        if (!pick) return;
        model = pick.id;
        provider = pick.provider;
      }
      try {
        await ctl.setModel(model, provider);
      } catch (err) {
        io.print(c.red(`Could not switch model: ${(err as Error).message}`));
        return;
      }
      ctl.saveModelChoice();
      const p = ctl.client.profile;
      io.print(`Model set to ${c.bold(ctl.client.model)} ${c.dim(`(${ctl.provider.name} · ${formatContext(p.contextWindow)} context · ${p.toolMode} tools)`)}`);
      for (const note of p.notes) io.print(c.yellow(`! ${note}`));
    },
  },
  {
    name: 'mode',
    description: 'Set the permission mode',
    argumentHint: `[${MODE_CYCLE.join('|')}|bypassPermissions]`,
    async run(args, ctl, io) {
      let mode = args.trim() as PermissionMode;
      if (!mode) {
        const pick = await io.select<PermissionMode>({
          question: 'Permission mode',
          options: [
            { label: 'Ask before edits', value: 'default', hint: 'approve each edit and command' },
            { label: 'Accept edits', value: 'acceptEdits', hint: 'file edits are applied without asking' },
            { label: 'Plan mode', value: 'plan', hint: 'read-only until you approve a plan' },
            { label: 'Bypass permissions', value: 'bypassPermissions', hint: 'never ask (use only in a sandbox)' },
          ],
        });
        if (!pick) return;
        mode = pick;
      }
      if (!PERMISSION_MODES.includes(mode)) {
        io.print(c.red(`Unknown mode "${mode}". Choose one of: ${PERMISSION_MODES.join(', ')}.`));
        return;
      }
      ctl.setMode(mode);
      io.print(`Permission mode: ${c.bold(modeLabel(mode))}`);
    },
  },
  {
    name: 'plan',
    description: 'Toggle plan mode (research first, change nothing)',
    run(_args, ctl, io) {
      ctl.setMode(ctl.permissions.mode === 'plan' ? 'default' : 'plan');
      io.print(`Permission mode: ${c.bold(modeLabel(ctl.permissions.mode))}`);
    },
  },
  {
    name: 'permissions',
    aliases: ['allowed-tools'],
    description: 'View or change permission rules',
    argumentHint: '[allow|deny|ask|remove <rule>]',
    run(args, ctl, io) {
      const [verb, ...restParts] = args.trim().split(/\s+/);
      const rest = restParts.join(' ').trim();
      if (verb === 'allow' || verb === 'deny' || verb === 'ask') {
        if (!rest || !parseRule(rest)) {
          io.print(c.red('Give a rule such as Bash(npm test:*), Edit(src/**), WebFetch(domain:example.com) or mcp__server.'));
          return;
        }
        ctl.permissions.addRule(verb, rest, 'local');
        io.print(`Added ${verb} rule ${c.bold(rest)} ${c.dim('(saved to .coco/settings.local.json)')}`);
        return;
      }
      if (verb === 'remove' || verb === 'rm') {
        io.print(ctl.permissions.removeRule(rest) ? `Removed rule ${c.bold(rest)}` : c.yellow(`No rule "${rest}" found.`));
        return;
      }
      const rules = ctl.permissions.rules();
      const section = (title: string, list: { raw: string; source?: string }[]) =>
        list.length ? [heading(title), ...list.map((r) => `  ${r.raw} ${c.dim(r.source ? `(${r.source})` : '')}`)] : [];
      const lines = [
        heading('Permissions'),
        kv('Mode', modeLabel(ctl.permissions.mode)),
        kv('Directories', ctl.session.workingDirs().join(', ')),
        ...section('Allow', [...rules.allow, ...rules.session]),
        ...section('Ask', rules.ask),
        ...section('Deny', rules.deny),
      ];
      if (rules.allow.length + rules.session.length + rules.ask.length + rules.deny.length === 0) {
        lines.push(c.dim('  No rules yet. Add one with /permissions allow <rule>, or choose "don\'t ask again" in an approval prompt.'));
      }
      io.print(lines.join('\n'));
    },
  },
  {
    name: 'add-dir',
    description: 'Allow file access in another directory',
    argumentHint: '<path>',
    run(args, ctl, io) {
      const dir = args.trim();
      if (!dir) {
        io.print(c.red('Usage: /add-dir <path>'));
        return;
      }
      const abs = path.resolve(ctl.session.cwd, dir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        io.print(c.red(`${abs} is not a directory.`));
        return;
      }
      ctl.session.addDir(abs);
      io.print(`Added ${c.bold(abs)} as a working directory for this session.`);
    },
  },
  {
    name: 'memory',
    description: `Edit ${MEMORY_FILE} instruction files`,
    async run(_args, ctl, io) {
      const targets = memoryTargets(ctl.session.cwd);
      const exists = (f: string) => (fs.existsSync(f) ? '' : 'new');
      const pick = await io.select<string>({
        question: 'Which memory file?',
        options: [
          { label: 'Project', value: targets.project, hint: `${displayPath(targets.project, ctl.session.cwd)} · shared with the team ${exists(targets.project)}` },
          { label: 'Project (local)', value: targets.local, hint: `${displayPath(targets.local, ctl.session.cwd)} · just you, keep out of git ${exists(targets.local)}` },
          { label: 'User', value: targets.user, hint: `${displayPath(targets.user, ctl.session.cwd)} · all your projects ${exists(targets.user)}` },
        ],
      });
      if (!pick) return;
      if (!fs.existsSync(pick)) {
        fs.mkdirSync(path.dirname(pick), { recursive: true });
        fs.writeFileSync(pick, '');
      }
      await io.editFile(pick);
      ctl.reloadExtensions();
      io.print(c.dim(`Reloaded memory (${plural(ctl.memory.length, 'file')}).`));
    },
  },
  {
    name: 'init',
    description: `Create a ${MEMORY_FILE} describing this project`,
    run() {
      return { type: 'prompt', prompt: INIT_PROMPT, display: '/init' };
    },
  },
  {
    name: 'review',
    description: 'Review uncommitted changes, a branch or a commit range',
    argumentHint: '[what to review]',
    run(args) {
      const target = args.trim() || 'the uncommitted changes in the working tree (or, if there are none, the commits on this branch that are not on the default branch)';
      return { type: 'prompt', prompt: `${REVIEW_PROMPT}\n\nWhat to review: ${target}`, display: `/review ${args}`.trim() };
    },
  },
  {
    name: 'resume',
    aliases: ['continue'],
    description: 'Resume an earlier conversation',
    argumentHint: '[session id]',
    async run(args, ctl, io) {
      let target = args.trim() ? findSession(ctl.session.projectRoot, args.trim()) : undefined;
      if (args.trim() && !target) {
        io.print(c.red(`No session matching "${args.trim()}".`));
        return;
      }
      if (!target) {
        const sessions = listSessions(ctl.session.projectRoot).filter((s) => s.id !== ctl.session.id);
        if (sessions.length === 0) {
          io.print(c.dim('No earlier conversations in this directory.'));
          return;
        }
        target = await io.select({
          question: 'Resume a conversation',
          filterable: sessions.length > 10,
          options: sessions.map((s) => ({
            label: s.firstPrompt.slice(0, 70) || '(no prompt)',
            value: s,
            hint: `${formatDuration(Date.now() - s.modifiedAt.getTime())} ago · ${plural(s.messageCount, 'message')}`,
          })),
        });
        if (!target) return;
      }
      ctl.resume(target);
      io.clearScreen();
      io.showHistory();
      io.print(c.dim(`Resumed session ${target.id.slice(0, 8)}.`));
    },
  },
  {
    name: 'rewind',
    aliases: ['checkpoint', 'undo'],
    description: 'Go back to an earlier point in the conversation and/or restore files',
    async run(_args, ctl, io) {
      const points = ctl.rewindPoints();
      if (points.length === 0) {
        io.print(c.dim('Nothing to rewind to yet.'));
        return;
      }
      const point = await io.select({
        question: 'Rewind to just before which message?',
        options: [...points].reverse().map((p) => ({
          label: p.text.slice(0, 70),
          value: p,
          hint: p.filesChanged ? `${plural(p.filesChanged, 'file')} changed since` : 'no file changes since',
        })),
      });
      if (!point) return;
      const what = await io.select<{ conversation: boolean; code: boolean }>({
        question: 'What should be restored?',
        options: [
          { label: 'Conversation and code', value: { conversation: true, code: true }, hint: 'drop later messages and undo file edits' },
          { label: 'Conversation only', value: { conversation: true, code: false }, hint: 'keep files as they are' },
          { label: 'Code only', value: { conversation: false, code: true }, hint: 'undo file edits, keep the conversation' },
        ],
      });
      if (!what) return;
      const res = ctl.rewind(point.turn, what);
      if (what.conversation) {
        io.clearScreen();
        io.showHistory();
        if (res.prompt) io.setInput(res.prompt);
      }
      const parts: string[] = [];
      if (what.conversation) parts.push('conversation rewound');
      if (what.code) parts.push(`${plural(res.restored.length, 'file')} restored`);
      io.print(c.dim(`Rewind: ${parts.join(', ')}.`));
      if (res.failed.length) io.print(c.red(`Could not restore: ${res.failed.join(', ')}`));
      if (what.code) io.print(c.dim('Only edits made with the file tools are restored; changes made by shell commands are not.'));
    },
  },
  {
    name: 'export',
    description: 'Save the conversation as Markdown',
    argumentHint: '[file]',
    run(args, ctl, io) {
      const name = args.trim() || `coco-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
      const file = path.resolve(ctl.session.cwd, name);
      fs.writeFileSync(file, exportMarkdown(ctl.agent.messages, `coco session ${ctl.session.id.slice(0, 8)}`));
      io.print(`Conversation exported to ${c.bold(displayPath(file, ctl.session.cwd))}`);
    },
  },
  {
    name: 'config',
    aliases: ['settings'],
    description: 'View or change settings',
    argumentHint: '[get <key> | set <key> <value> [--user|--project|--local]]',
    run(args, ctl, io) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const verb = parts[0];
      if (verb === 'set') {
        const { scope, rest } = scopeFlag(parts.slice(1));
        const [key, ...valueParts] = rest;
        if (!key || valueParts.length === 0) {
          io.print(c.red('Usage: /config set <key> <value> [--user|--project|--local]'));
          return;
        }
        const value = parseSettingValue(valueParts.join(' '));
        const file = updateSettingsFile(scope, ctl.session.projectRoot, (s) => setByPath(s as Record<string, unknown>, key, value));
        setByPath(ctl.settings as Record<string, unknown>, key, value);
        io.print(`Set ${c.bold(key)} = ${JSON.stringify(value)} ${c.dim(`in ${displayPath(file, ctl.session.cwd)}`)}`);
        if (/^(model|provider|baseUrl|contextWindow|toolMode|maxOutputTokens)$/.test(key)) io.print(c.dim('Takes effect in the next session, or after /model.'));
        return;
      }
      if (verb === 'get' && parts[1]) {
        io.print(`${parts[1]} = ${JSON.stringify(getByPath(ctl.settings, parts[1]), null, 2)}`);
        return;
      }
      const lines = [heading('Settings (merged)'), JSON.stringify(ctl.settings, null, 2), '', heading('Sources (later wins)')];
      for (const s of ctl.loaded.sources) lines.push(`  ${padEnd(s.scope, 16)}${s.path ? displayPath(s.path, ctl.session.cwd) : c.dim('(flags or environment)')}`);
      lines.push('', c.dim('Change a value with /config set <key> <value>. Keys may be dotted, e.g. permissions.defaultMode.'));
      io.print(lines.join('\n'));
    },
  },
  {
    name: 'rename',
    description: 'Name this session so it can be resumed by name',
    argumentHint: '<name>',
    run(args, ctl, io) {
      const name = args.trim();
      if (!name) {
        io.print(ctl.sessionName ? `This session is named ${c.bold(ctl.sessionName)}.` : c.dim('This session has no name. Usage: /rename <name>'));
        return;
      }
      ctl.rename(name);
      io.print(`Session named ${c.bold(name)}. Resume it later with: ${APP_NAME} --resume=${JSON.stringify(name)}`);
    },
  },
  {
    name: 'branch',
    aliases: ['fork'],
    description: 'Continue this conversation as a new session, keeping the original',
    argumentHint: '[name]',
    run(args, ctl, io) {
      if (ctl.agent.messages.length === 0) {
        io.print(c.dim('Nothing to branch from yet.'));
        return;
      }
      const previous = ctl.branch(args.trim() || undefined);
      io.print(`Branched. This is now session ${ctl.session.id.slice(0, 8)}; the original is still available with: ${APP_NAME} --resume ${previous}`);
    },
  },
  {
    name: 'cd',
    description: 'Change the working directory for the session',
    argumentHint: '<path>',
    run(args, ctl, io) {
      const target = args.trim();
      if (!target) {
        io.print(`Working directory: ${c.bold(ctl.session.cwd)}`);
        return;
      }
      const abs = path.resolve(ctl.session.cwd, target.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        io.print(c.red(`${abs} is not a directory.`));
        return;
      }
      // Moving outside the project also makes that directory one coco may work in.
      if (!ctl.session.inWorkingDirs(abs)) ctl.session.addDir(abs);
      ctl.session.cwd = abs;
      io.print(`Working directory: ${c.bold(abs)}`);
    },
  },
  {
    name: 'copy',
    description: 'Copy the last reply to the clipboard, or save it to a file',
    argumentHint: '[file]',
    run(args, ctl, io) {
      const text = ctl.agent.lastAssistantText();
      if (!text) {
        io.print(c.dim('There is no reply to copy yet.'));
        return;
      }
      const file = args.trim();
      if (file) {
        const target = path.resolve(ctl.session.cwd, file);
        fs.writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`);
        io.print(`Saved the last reply to ${c.bold(displayPath(target, ctl.session.cwd))}`);
        return;
      }
      io.print(copyToClipboard(text) ? c.dim(`Copied the last reply (${plural(text.length, 'character')}).`) : c.yellow('No clipboard tool found (pbcopy, wl-copy, xclip, xsel or clip). Use /copy <file> to save it instead.'));
    },
  },
  {
    name: 'diff',
    description: 'Show uncommitted changes in the working tree',
    run(_args, ctl, io) {
      const run = (gitArgs: string[]) => spawnSync('git', gitArgs, { cwd: ctl.session.cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      if (run(['rev-parse', '--is-inside-work-tree']).stdout?.trim() !== 'true') {
        io.print(c.dim('Not a git repository. Use /rewind to see or undo changes coco made.'));
        return;
      }
      const base = run(['rev-parse', '--verify', 'HEAD']).status === 0 ? ['HEAD'] : [];
      const stat = run(['diff', '--stat', ...base]).stdout?.trimEnd() ?? '';
      const untracked = (run(['ls-files', '--others', '--exclude-standard']).stdout ?? '').split('\n').filter(Boolean);
      if (!stat && untracked.length === 0) {
        io.print(c.dim('No uncommitted changes.'));
        return;
      }
      const diff = (run(['diff', ...base]).stdout ?? '').trimEnd().split('\n');
      const shown = diff.slice(0, 400);
      const lines = [heading('Uncommitted changes'), stat, ''];
      if (untracked.length) lines.push(heading('New files'), ...untracked.slice(0, 40).map((f) => `  ${f}`), '');
      if (diff[0]) lines.push(highlight(shown.join('\n'), 'diff'));
      if (diff.length > shown.length) lines.push(c.dim(`… ${plural(diff.length - shown.length, 'more line')}; run git diff to see everything.`));
      io.print(lines.join('\n'));
    },
  },
  {
    name: 'btw',
    description: 'Ask a side question without adding it to the conversation',
    argumentHint: '<question>',
    async run(args, ctl, io) {
      const question = args.trim();
      if (!question) {
        io.print(c.red('Usage: /btw <question>'));
        return;
      }
      const window = ctl.client.profile.contextWindow;
      const context = fitTranscript(renderTranscript(ctl.agent.messages, 800), Math.floor(window * 0.6));
      try {
        const answer = await ctl.client.complete(
          'You are answering a brief side question about an ongoing coding session. Use the session transcript for context. Answer directly and concisely; you cannot use tools here.',
          `<session>\n${context || '(nothing yet)'}\n</session>\n\nSide question: ${question}`,
          { maxTokens: Math.min(ctl.client.profile.maxOutputTokens, 1500) },
        );
        io.print(answer || c.dim('(no answer)'));
      } catch (err) {
        io.print(c.red(`Could not answer: ${(err as Error).message}`));
      }
    },
  },
  {
    name: 'recap',
    description: 'Summarize what has happened in this session so far',
    async run(_args, ctl, io) {
      if (ctl.agent.messages.length === 0) {
        io.print(c.dim('Nothing has happened yet.'));
        return;
      }
      const window = ctl.client.profile.contextWindow;
      const context = fitTranscript(renderTranscript(ctl.agent.messages, 600), Math.floor(window * 0.6));
      try {
        const recap = await ctl.client.complete(
          'You write short recaps of coding sessions for the person who was in them. Be accurate and specific; do not invent anything.',
          `<session>\n${context}\n</session>\n\nIn at most six short bullet points: what was asked, what has been done (name the files), and what is still open.`,
          { maxTokens: Math.min(ctl.client.profile.maxOutputTokens, 800) },
        );
        io.print(recap || c.dim('(no recap)'));
      } catch (err) {
        io.print(c.red(`Could not produce a recap: ${(err as Error).message}`));
      }
    },
  },
  {
    name: 'autocompact',
    description: 'Turn automatic compaction on or off, or set when it triggers',
    argumentHint: '[on|off|<percent>]',
    run(args, ctl, io) {
      const arg = args.trim().toLowerCase();
      if (arg === 'on' || arg === 'off') ctl.settings.autoCompact = arg === 'on';
      else if (/^\d{1,3}%?$/.test(arg)) {
        const pct = Math.min(95, Math.max(20, Number(arg.replace('%', ''))));
        ctl.settings.autoCompact = true;
        ctl.settings.compactThreshold = pct / 100;
      } else if (arg) {
        io.print(c.red('Usage: /autocompact [on|off|<percent of the context window>]'));
        return;
      }
      const on = ctl.settings.autoCompact ?? true;
      io.print(`Automatic compaction is ${c.bold(on ? 'on' : 'off')}${on ? ` (at ${Math.round((ctl.settings.compactThreshold ?? 0.8) * 100)}% of the usable context)` : ''}.`);
    },
  },
  {
    name: 'reload-skills',
    aliases: ['reload'],
    description: 'Re-read skills, commands, agents and memory files from disk',
    run(_args, ctl, io) {
      ctl.reloadExtensions();
      io.print(c.dim(`Reloaded: ${plural(ctl.skillDefs.length, 'skill')}, ${plural(ctl.commands.length, 'command')}, ${plural(ctl.agentDefs.length, 'agent')}, ${plural(ctl.memory.length, 'memory file')}.`));
    },
  },
  {
    name: 'security-review',
    description: 'Review the pending changes for security problems',
    run() {
      return { type: 'prompt', prompt: SECURITY_REVIEW_PROMPT, display: '/security-review' };
    },
  },
  {
    name: 'think',
    aliases: ['effort'],
    description: 'Turn model reasoning on or off, or set its level',
    argumentHint: '[on|off|low|medium|high]',
    run(args, ctl, io) {
      const arg = args.trim().toLowerCase();
      if (!arg) {
        io.print(`Reasoning: ${c.bold(ctl.settings.thinking === undefined ? 'model default' : String(ctl.settings.thinking))}`);
        return;
      }
      const value = arg === 'on' ? true : arg === 'off' ? false : arg === 'default' ? undefined : arg;
      ctl.settings.thinking = value;
      io.print(`Reasoning set to ${c.bold(value === undefined ? 'model default' : String(value))} for this session.`);
    },
  },
  {
    name: 'output-style',
    description: 'Choose how the assistant communicates',
    argumentHint: '[name]',
    async run(args, ctl, io) {
      let name = args.trim().toLowerCase();
      if (!name) {
        const pick = await io.select<string>({
          question: 'Output style',
          options: ctl.styles.map((s) => ({ label: s.name, value: s.name, hint: s.description })),
        });
        if (!pick) return;
        name = pick;
      }
      if (!ctl.styles.some((s) => s.name === name)) {
        io.print(c.red(`Unknown output style "${name}". Available: ${ctl.styles.map((s) => s.name).join(', ')}.`));
        return;
      }
      ctl.settings.outputStyle = name;
      updateSettingsFile('local', ctl.session.projectRoot, (s) => (s.outputStyle = name));
      io.print(`Output style: ${c.bold(name)}`);
    },
  },
  {
    name: 'verbose',
    description: 'Toggle full tool output and reasoning text',
    run(_args, _ctl, io) {
      io.print(`Verbose output ${io.toggleVerbose() ? 'on' : 'off'}.`);
    },
  },
  {
    name: 'todos',
    description: 'Show the current task list',
    run(_args, ctl, io) {
      io.print(ctl.session.todos.length ? [heading('Tasks'), ...renderTodos(ctl.session.todos, io.width())].join('\n') : c.dim('No tasks.'));
    },
  },
  {
    name: 'bashes',
    aliases: ['tasks'],
    description: 'List or stop background shell commands',
    argumentHint: '[kill <id>]',
    run(args, ctl, io) {
      const [verb, id] = args.trim().split(/\s+/);
      if (verb === 'kill' && id) {
        io.print(ctl.session.shells.kill(id) ? `Stopped ${id}.` : c.red(`No background shell ${id}.`));
        return;
      }
      const shells = ctl.session.shells.list();
      if (shells.length === 0) {
        io.print(c.dim('No background shells.'));
        return;
      }
      io.print(
        [heading('Background shells'), ...shells.map((s) => `  ${c.cyan(padEnd(s.id, 10))}${padEnd(s.status, 11)}${c.dim(formatDuration(Date.now() - s.startedAt))}  ${s.command.slice(0, 80)}`)].join('\n'),
      );
    },
  },
  {
    name: 'agents',
    description: 'List available subagents',
    run(_args, ctl, io) {
      const lines = [heading('Subagents')];
      for (const a of ctl.agentDefs) {
        lines.push(`  ${c.cyan(padEnd(a.name, 20))}${a.description} ${c.dim(`(${a.source}${a.tools ? ` · tools: ${a.tools.join(', ')}` : ''}${a.model ? ` · ${a.model}` : ''})`)}`);
      }
      lines.push('', c.dim('Add your own as Markdown files in .coco/agents/ (project) or ~/.coco/agents/ (user).'));
      io.print(lines.join('\n'));
    },
  },
  {
    name: 'skills',
    description: 'List available skills',
    run(_args, ctl, io) {
      if (ctl.skillDefs.length === 0) {
        io.print(c.dim('No skills installed. Add one at .coco/skills/<name>/SKILL.md.'));
        return;
      }
      io.print([heading('Skills'), ...ctl.skillDefs.map((s) => `  ${c.cyan(padEnd(s.name, 24))}${s.description} ${c.dim(`(${s.source})`)}`)].join('\n'));
    },
  },
  {
    name: 'hooks',
    description: 'List configured hooks',
    run(_args, ctl, io) {
      const hooks = ctl.hooks.list();
      if (hooks.length === 0) {
        io.print(c.dim('No hooks configured. Add them under "hooks" in a settings.json file.'));
        return;
      }
      io.print([heading('Hooks'), ...hooks.map((h) => `  ${c.cyan(padEnd(h.event, 18))}${padEnd(h.matcher, 14)}${h.command}`)].join('\n'));
    },
  },
  {
    name: 'mcp',
    description: 'Show MCP servers and their tools',
    argumentHint: '[reconnect <name>]',
    async run(args, ctl, io) {
      const [verb, name] = args.trim().split(/\s+/);
      if (verb === 'reconnect' && name) {
        if (!ctl.mcp) {
          io.print(c.red('No MCP servers are configured.'));
          return;
        }
        try {
          await ctl.mcp.reconnect(name);
        } catch (err) {
          io.print(c.red((err as Error).message));
          return;
        }
      }
      const statuses = ctl.mcp?.status() ?? [];
      if (statuses.length === 0) {
        io.print(c.dim(`No MCP servers configured. Add one with: ${APP_NAME} mcp add <name> -- <command> [args...]`));
        return;
      }
      const tools = ctl.mcp!.tools();
      const lines = [heading('MCP servers')];
      for (const s of statuses) {
        const mark = s.status === 'connected' ? c.green('✓') : s.status === 'failed' ? c.red('✗') : c.yellow('…');
        lines.push(`  ${mark} ${c.bold(s.name)} ${c.dim(`(${s.scope})`)} ${s.status === 'connected' ? plural(s.toolCount, 'tool') : (s.error ?? s.status)}`);
        const prefix = `mcp__${s.name.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
        for (const t of tools.filter((tool) => tool.name.startsWith(prefix)).slice(0, 30)) {
          lines.push(`      ${c.cyan(t.name.slice(prefix.length))} ${c.dim(t.description.split('\n')[0]!.slice(0, 70))}`);
        }
      }
      for (const e of ctl.mcpErrors) lines.push(c.yellow(`  ! ${e}`));
      io.print(lines.join('\n'));
    },
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Quit',
    run(_args, _ctl, io) {
      io.exit();
    },
  },
];

export interface ResolvedCommand {
  name: string;
  description: string;
  argumentHint?: string;
  kind: 'builtin' | 'custom' | 'skill' | 'mcp';
}

/** Everything that can follow a slash, for completion and /help. */
export function allCommands(ctl: Controller): ResolvedCommand[] {
  const out: ResolvedCommand[] = BUILTIN_COMMANDS.map((b) => ({ name: b.name, description: b.description, argumentHint: b.argumentHint, kind: 'builtin' as const }));
  const taken = new Set(BUILTIN_COMMANDS.flatMap((b) => [b.name, ...(b.aliases ?? [])]));
  for (const cmd of ctl.commands) {
    if (!taken.has(cmd.name)) out.push({ name: cmd.name, description: cmd.description, argumentHint: cmd.argumentHint, kind: 'custom' });
    taken.add(cmd.name);
  }
  for (const s of userInvocableSkills(ctl.skillDefs)) {
    if (!taken.has(s.name)) out.push({ name: s.name, description: s.description, argumentHint: s.argumentHint, kind: 'skill' });
    taken.add(s.name);
  }
  for (const p of ctl.mcp?.prompts() ?? []) {
    const name = `mcp__${p.server}__${p.name}`;
    out.push({ name, description: p.description ?? 'MCP prompt', argumentHint: p.arguments?.map((a) => `<${a.name}>`).join(' '), kind: 'mcp' });
  }
  return out;
}

export function parseSlash(input: string): { name: string; args: string } | null {
  const m = /^\/([^\s]+)\s*([\s\S]*)$/.exec(input.trim());
  return m ? { name: m[1]!, args: m[2] ?? '' } : null;
}

/**
 * Turn a slash input into what to do. Returns undefined when the name is
 * not a command at all (so it can be sent to the model as ordinary text).
 */
export async function runSlash(input: string, ctl: Controller, io: CommandIO): Promise<CommandOutcome | { type: 'unknown'; name: string }> {
  const parsed = parseSlash(input);
  if (!parsed) return { type: 'unknown', name: input };
  const { name, args } = parsed;

  const builtin = BUILTIN_COMMANDS.find((b) => b.name === name || b.aliases?.includes(name));
  if (builtin) return builtin.run(args, ctl, io);

  const custom = ctl.commands.find((cmd) => cmd.name === name);
  if (custom) {
    const prompt = await expandCommand(custom, args, inlineBashRunner(ctl, custom.allowedTools), { sessionId: ctl.session.id, projectDir: ctl.session.projectRoot });
    return { type: 'prompt', prompt, display: input.trim(), allowedTools: custom.allowedTools };
  }

  const skill = await ctl.invokeSkill(name, args, 'user');
  if (skill?.forkAgent) return runForkedSkill(skill.name, skill.forkAgent, skill.content, input.trim(), ctl, io);
  if (skill) return { type: 'prompt', prompt: skill.content, display: input.trim() };

  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp && ctl.mcp) {
    const prompt = ctl.mcp.prompts().find((p) => p.server === mcp[1] && p.name === mcp[2]);
    if (prompt) {
      const values = args.trim().split(/\s+/).filter(Boolean);
      const named: Record<string, string> = {};
      (prompt.arguments ?? []).forEach((a, i) => {
        if (values[i] !== undefined) named[a.name] = i === (prompt.arguments!.length - 1) ? values.slice(i).join(' ') : values[i]!;
      });
      try {
        return { type: 'prompt', prompt: await ctl.mcp.getPrompt(prompt.server, prompt.name, named), display: input.trim() };
      } catch (err) {
        io.print(c.red(`MCP prompt failed: ${(err as Error).message}`));
        return;
      }
    }
  }
  return { type: 'unknown', name };
}

/**
 * A skill marked `context: fork` runs in a subagent. Its report is shown and
 * added to the conversation, so later prompts can refer to it.
 */
async function runForkedSkill(name: string, agent: string, content: string, typed: string, ctl: Controller, io: CommandIO): Promise<CommandOutcome> {
  if (!ctl.client) {
    io.print(c.red('Not connected to a model yet.'));
    return;
  }
  io.print(c.dim(`Running /${name} in a ${agent} subagent…`));
  const abort = new AbortController();
  const res = await ctl.runSubagent({ type: agent, description: `Skill ${name}`, prompt: content, signal: abort.signal, depth: 1 });
  io.print(res.isError ? c.red(res.text) : res.text || c.dim('(The skill returned no text.)'));
  const message = {
    role: 'user' as const,
    isMeta: true,
    content: `The user ran the skill ${typed} in a subagent. Its report:\n<skill-result>\n${res.text || '(no text)'}\n</skill-result>`,
  };
  ctl.agent.messages.push(message);
  ctl.transcript.message(message);
}

/** Save a `#` note to a memory file chosen by the user. */
export async function saveMemoryNote(note: string, ctl: Controller, io: CommandIO): Promise<void> {
  const targets = memoryTargets(ctl.session.cwd);
  const pick = await io.select<string>({
    question: 'Save this note to',
    options: [
      { label: 'Project memory', value: targets.project, hint: displayPath(targets.project, ctl.session.cwd) },
      { label: 'Project memory (local)', value: targets.local, hint: displayPath(targets.local, ctl.session.cwd) },
      { label: 'User memory', value: targets.user, hint: displayPath(targets.user, ctl.session.cwd) },
    ],
  });
  if (!pick) return;
  appendMemory(pick, note);
  ctl.reloadExtensions();
  io.print(c.dim(`Saved to ${displayPath(pick, ctl.session.cwd)}.`));
}
