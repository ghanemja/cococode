/**
 * User-defined extensions that live as Markdown files with front matter:
 * slash commands, subagents, skills and output styles. They are read from
 * the project's .coco directory and the user's ~/.coco, and from the matching
 * .claude directories when Claude compatibility is on.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { asList, asString, parseFrontmatter } from '../util/frontmatter.ts';
import { projectConfigDirs, userConfigDirs } from './paths.ts';

export type ExtensionSource = 'builtin' | 'user' | 'project';

interface SourceDir {
  dir: string;
  source: ExtensionSource;
}

/** Project directories first so they win name collisions. */
function sourceDirs(projectRoot: string, claudeCompat: boolean, sub: string): SourceDir[] {
  return [
    ...projectConfigDirs(projectRoot, claudeCompat).map((d) => ({ dir: path.join(d, sub), source: 'project' as const })),
    ...userConfigDirs(claudeCompat).map((d) => ({ dir: path.join(d, sub), source: 'user' as const })),
  ];
}

function markdownFiles(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < 4) walk(full, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        out.push(full);
      }
    }
  };
  walk(dir, 0);
  return out;
}

// ---------------------------------------------------------------- commands

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Permission rules granted while the command runs, e.g. "Bash(git status:*)". */
  allowedTools?: string[];
  model?: string;
  body: string;
  path: string;
  source: ExtensionSource;
}

export function loadCommands(projectRoot: string, claudeCompat: boolean): CustomCommand[] {
  const commands = new Map<string, CustomCommand>();
  for (const { dir, source } of sourceDirs(projectRoot, claudeCompat, 'commands')) {
    for (const file of markdownFiles(dir, true)) {
      // Subdirectories become namespaces: commands/git/sync.md -> /git:sync
      const rel = path.relative(dir, file).replace(/\.md$/, '');
      const name = rel.split(path.sep).join(':');
      if (commands.has(name)) continue;
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const firstLine = body.trim().split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 100) ?? '';
      commands.set(name, {
        name,
        description: asString(data.description) ?? firstLine,
        argumentHint: asString(data['argument-hint']),
        allowedTools: asList(data['allowed-tools']),
        model: asString(data.model),
        body,
        path: file,
        source,
      });
    }
  }
  return [...commands.values()];
}

/** Split an argument string the way a shell would, honouring quotes. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(args); m; m = re.exec(args)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * Expand a command body: `$ARGUMENTS`, `$1`..`$9`, and `` !`cmd` `` which is
 * replaced by the command's output when `runBash` permits it.
 *
 * Only inline commands written in the command file run. Arguments are
 * substituted into them (so `` !`git log $1` `` works), but text that merely
 * arrives through an argument is never executed, and placeholders inside an
 * argument are left as typed.
 */
export async function expandCommand(
  command: Pick<CustomCommand, 'body'>,
  args: string,
  runBash?: (cmd: string) => Promise<string | null>,
): Promise<string> {
  const positional = splitArgs(args);
  const trimmedArgs = args.trim();
  const body = command.body;
  const usesArgs = /\$ARGUMENTS|\$[1-9]/.test(body);
  const substitute = (text: string) =>
    text.replace(/\$ARGUMENTS|\$([1-9])/g, (_match, n: string | undefined) => (n === undefined ? trimmedArgs : (positional[Number(n) - 1] ?? '')));

  // Split the template into literal text and inline commands before any
  // argument is substituted, so arguments cannot introduce new commands.
  const inline = /!`([^`\n]+)`/g;
  const pieces: { text: string; command: boolean }[] = [];
  let last = 0;
  for (let m = inline.exec(body); m; m = inline.exec(body)) {
    pieces.push({ text: body.slice(last, m.index), command: false }, { text: m[1]!, command: true });
    last = m.index + m[0].length;
  }
  pieces.push({ text: body.slice(last), command: false });

  const rendered = await Promise.all(
    pieces.map(async (piece) => {
      const text = substitute(piece.text);
      if (!piece.command) return text;
      if (!runBash) return `[command not run: ${text}]`;
      const out = await runBash(text);
      return out === null ? `[command not permitted: ${text}]` : out.trim();
    }),
  );
  let text = rendered.join('');
  if (!usesArgs && trimmedArgs) text = `${text.trimEnd()}\n\nARGUMENTS: ${trimmedArgs}`;
  return text.trim();
}

// ------------------------------------------------------------------ agents

export interface AgentDefinition {
  name: string;
  description: string;
  /** Tool names the agent may use. Undefined means all tools. */
  tools?: string[];
  model?: string;
  prompt: string;
  source: ExtensionSource;
  path?: string;
}

const READ_ONLY = ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'];

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: 'general-purpose',
    description: 'Handles any self-contained multi-step task: research, searching, and making changes.',
    source: 'builtin',
    prompt: [
      'You are a subagent working on one delegated task for a coding agent.',
      'Complete the task fully using the tools available, then reply with a final report.',
      'The report is all the caller will see: state what you found or changed, with file paths and line numbers, and note anything you could not do.',
      'Do not ask questions; make reasonable assumptions and say what they were.',
    ].join('\n'),
  },
  {
    name: 'explore',
    description: 'Read-only codebase search. Use it to find where things are defined or used, or to answer questions about how code works.',
    tools: READ_ONLY,
    source: 'builtin',
    prompt: [
      'You are a read-only search subagent. Find what the caller asked about and report it.',
      'Search efficiently: start with Glob and Grep, read only the relevant parts of files, and run several searches at once when they are independent.',
      'Never modify files or run commands that change state.',
      'Reply with a concise report: the answer first, then the supporting file paths with line numbers.',
    ].join('\n'),
  },
  {
    name: 'plan',
    description: 'Read-only software architect. Use it to design an implementation plan before making a large change.',
    tools: READ_ONLY,
    source: 'builtin',
    prompt: [
      'You are a read-only planning subagent. Investigate the codebase and produce a concrete implementation plan.',
      'Never modify files or run commands that change state.',
      'Reply with: the files to change and why, the steps in order, risks or open questions, and how to verify the result.',
    ].join('\n'),
  },
];

export function loadAgents(projectRoot: string, claudeCompat: boolean): AgentDefinition[] {
  const agents = new Map<string, AgentDefinition>();
  for (const { dir, source } of sourceDirs(projectRoot, claudeCompat, 'agents')) {
    for (const file of markdownFiles(dir, false)) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const name = asString(data.name) ?? path.basename(file, '.md');
      if (agents.has(name) || !body.trim()) continue;
      const model = asString(data.model);
      agents.set(name, {
        name,
        description: asString(data.description) ?? '',
        tools: asList(data.tools),
        // Claude-specific aliases mean "whatever the session uses" here.
        model: model && !/^(inherit|sonnet|opus|haiku)$/i.test(model) ? model : undefined,
        prompt: body.trim(),
        source,
        path: file,
      });
    }
  }
  for (const builtin of BUILTIN_AGENTS) if (!agents.has(builtin.name)) agents.set(builtin.name, builtin);
  return [...agents.values()];
}

// ------------------------------------------------------------------ skills

export interface SkillDefinition {
  name: string;
  description: string;
  baseDir: string;
  body: string;
  source: ExtensionSource;
}

export function loadSkills(projectRoot: string, claudeCompat: boolean): SkillDefinition[] {
  const skills = new Map<string, SkillDefinition>();
  for (const { dir, source } of sourceDirs(projectRoot, claudeCompat, 'skills')) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const baseDir = path.join(dir, entry.name);
      let text: string;
      try {
        text = fs.readFileSync(path.join(baseDir, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const name = asString(data.name) ?? entry.name;
      if (skills.has(name)) continue;
      skills.set(name, { name, description: asString(data.description) ?? '', baseDir, body, source });
    }
  }
  return [...skills.values()];
}

// ----------------------------------------------------------- output styles

export interface OutputStyle {
  name: string;
  description: string;
  prompt: string;
  source: ExtensionSource;
}

export const BUILTIN_STYLES: OutputStyle[] = [
  { name: 'default', description: 'Concise and focused on getting the task done.', prompt: '', source: 'builtin' },
  {
    name: 'explanatory',
    description: 'Explains the reasoning behind implementation choices as it works.',
    source: 'builtin',
    prompt:
      'Output style: explanatory. Besides completing the task, briefly explain why you chose each approach and point out ' +
      'patterns in the codebase worth knowing. Put these in short "Insight:" notes; keep the work itself just as efficient.',
  },
  {
    name: 'learning',
    description: 'Collaborative: asks the user to write small, meaningful pieces themselves.',
    source: 'builtin',
    prompt:
      'Output style: learning. Help the user learn by doing. For small pieces that involve a real design decision (roughly 2-10 lines), ' +
      'leave a TODO(human) marker, explain what is needed and why it matters, and wait for them to write it. Do the routine parts yourself.',
  },
];

export function loadOutputStyles(projectRoot: string, claudeCompat: boolean): OutputStyle[] {
  const styles = new Map<string, OutputStyle>();
  for (const { dir, source } of sourceDirs(projectRoot, claudeCompat, 'output-styles')) {
    for (const file of markdownFiles(dir, false)) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const name = (asString(data.name) ?? path.basename(file, '.md')).toLowerCase();
      if (styles.has(name) || !body.trim()) continue;
      styles.set(name, { name, description: asString(data.description) ?? '', prompt: body.trim(), source });
    }
  }
  for (const builtin of BUILTIN_STYLES) if (!styles.has(builtin.name)) styles.set(builtin.name, builtin);
  return [...styles.values()];
}
