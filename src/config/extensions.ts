/**
 * User-defined extensions that live as Markdown files with front matter:
 * slash commands, subagents, skills and output styles. They are read from
 * the project's .coco directory and the user's ~/.coco, and from the matching
 * .claude directories when Claude compatibility is on. File layout, front
 * matter fields and placeholders follow what Claude Code documents for them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedDocument } from '../util/frontmatter.ts';
import { asList, asString, parseFrontmatter, stripBom } from '../util/frontmatter.ts';
import { expandHome, projectConfigDirs, userConfigDirs } from './paths.ts';

/** `flag` marks agents defined for one session with `--agents`. */
export type ExtensionSource = 'builtin' | 'user' | 'project' | 'flag';

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

/** How many levels of subfolders below a commands/ or agents/ directory are searched. */
const MAX_DEPTH = 4;

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
        if (recursive && depth < MAX_DEPTH) walk(full, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        out.push(full);
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** Read and parse one extension file. Undefined when it cannot be read, so one bad file never stops a loader. */
function readDocument(file: string): ParsedDocument | undefined {
  try {
    return parseFrontmatter(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ field values

type Fields = Record<string, unknown>;

/**
 * A field under any of its spellings. Claude Code writes skill fields with
 * hyphens (`allowed-tools`), agent fields in camel case (`disallowedTools`)
 * and one with underscores (`when_to_use`); every field accepts all three.
 */
function field(data: Fields, name: string): unknown {
  const words = name.split('-');
  const camel = words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  for (const key of [name, words.join('_'), camel]) {
    if (Object.hasOwn(data, key) && data[key] !== undefined && data[key] !== null) return data[key];
  }
  return undefined;
}

/** The trimmed text of a scalar; undefined when it is missing or blank. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  return String(value).trim() || undefined;
}

function boolOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (/^(true|yes|on)$/i.test(value.trim())) return true;
  if (/^(false|no|off)$/i.test(value.trim())) return false;
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Names or patterns from a list, or from a comma-separated string. */
function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return typeof value === 'string' || typeof value === 'number' ? asList(String(value)) : undefined;
}

function unquote(item: string): string {
  const first = item.charAt(0);
  return item.length >= 2 && (first === '"' || first === "'") && item.endsWith(first) ? item.slice(1, -1) : item;
}

/**
 * Tool names or permission rules. Claude Code documents both `Read, Grep`
 * and `Bash(git add *) Bash(git commit *)`, so commas and spaces both
 * separate entries, except inside the brackets of a rule.
 */
function toolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((v) => unquote(String(v).trim())).filter(Boolean);
  const raw = textOf(value);
  if (raw === undefined) return undefined;
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of raw) {
    if (depth === 0 && /[\s,]/.test(ch)) {
      out.push(cur);
      cur = '';
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth--;
    cur += ch;
  }
  out.push(cur);
  return out.map(unquote).filter(Boolean);
}

/** The names in `arguments: issue branch` or `arguments: [issue, branch]`, in order. */
function nameList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value.map(String) : (textOf(value)?.split(/[\s,]+/) ?? []);
  const names = raw.map((n) => n.trim()).filter(Boolean);
  return names.length > 0 ? names : undefined;
}

/** `argument-hint: [file] [format]` reads as a YAML list; put the brackets back. */
function hintText(value: unknown): string | undefined {
  return Array.isArray(value) ? `[${value.join(', ')}]` : textOf(value);
}

/** Claude Code's model aliases name no local model; they mean "whatever the session uses". */
const CLAUDE_MODEL_ALIAS = /^(inherit|sonnet|opus|haiku|fable)(\[1m\])?$/i;

function localModel(value: unknown): string | undefined {
  const model = textOf(value);
  return model && !CLAUDE_MODEL_ALIAS.test(model) ? model : undefined;
}

/** Drop keys whose value is undefined, so definitions compare and print cleanly. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      const doc = readDocument(file);
      if (!doc) continue;
      const { data, body } = doc;
      const firstLine = body.trim().split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 100) ?? '';
      commands.set(name, {
        name,
        description: asString(data.description) ?? firstLine,
        argumentHint: hintText(field(data, 'argument-hint')),
        allowedTools: toolList(field(data, 'allowed-tools')),
        model: localModel(data.model),
        body,
        path: file,
        source,
      });
    }
  }
  return [...commands.values()];
}

// --------------------------------------------------------------- expansion

/** Split an argument string the way a shell would, honouring quotes. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(args); m; m = re.exec(args)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** What a command or skill body may refer to besides its arguments. */
export interface ExpansionContext {
  /** Replaces `${COCO_SESSION_ID}` and `${CLAUDE_SESSION_ID}`. */
  sessionId?: string;
  /** Replaces `${COCO_PROJECT_DIR}` and `${CLAUDE_PROJECT_DIR}`. */
  projectDir?: string;
  /** Runs a `!` command and resolves to its output, or to null when the command is not permitted. Without it nothing runs. */
  runBash?: (cmd: string) => Promise<string | null>;
}

/*
 * Placeholders in a command or skill body
 *
 *   $ARGUMENTS      everything typed after the name
 *   $ARGUMENTS[N]   one argument, counted from 0 in commands and skills alike
 *   $N              one argument, and THE NUMBERING DEPENDS ON THE KIND OF FILE:
 *                     command files (commands/*.md) keep the older Claude Code
 *                       convention that existing files rely on: $1 is the first
 *                       argument, only $1..$9 exist, and $0 is ordinary text;
 *                     skills (SKILL.md) follow the current documentation: $N is
 *                       short for $ARGUMENTS[N], so $0 is the first argument
 *                       and $1 the second, with any number of digits. A number
 *                       that runs into a word (`$5k`) is ordinary text.
 *   $name           skills only: an argument named in the `arguments` field;
 *                   `$names` and `$name[0]` are ordinary text
 *   ${COCO_SESSION_ID}  ${COCO_SKILL_DIR}  ${COCO_PROJECT_DIR}
 *                   also spelled with CLAUDE_; left as typed when the value is unknown
 *   \$...           a backslash keeps a placeholder as text: `\$1.00` stays `$1.00`
 *   !`command`      replaced by the output of the command
 *   ```!            a fenced block opened this way runs as one script and is
 *                   replaced by its output
 *
 * If no placeholder received any of the arguments (the body has none, or
 * each one names an argument that was not given), what was typed is appended
 * as `ARGUMENTS: <value>` so that it is never lost.
 *
 * The body is cut into literal text and commands first, and every piece is
 * then substituted in a single pass. So only commands written in the file
 * run, and nothing that arrives through an argument, a variable or a
 * command's output is ever read as a placeholder or as a command.
 */

interface TemplateOptions {
  /** Decides how `$N` is read: `$1`..`$9` counted from 1 in a command file, any `$N` counted from 0 in a skill. */
  kind: 'command' | 'skill';
  argumentNames?: string[];
  variables: Record<string, string | undefined>;
  runBash?: (cmd: string) => Promise<string | null>;
}

/** A fenced block opened with ```! on its own line, or an inline !`command`. */
const COMMAND_SYNTAX = /^(?<indent>[ \t]*)```![ \t]*\r?\n(?<block>[\s\S]*?)\r?\n[ \t]*```(?=[ \t]*\r?$)|!`(?<inline>[^`\n]+)`/gm;

const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

async function expandTemplate(body: string, args: string, opts: TemplateOptions): Promise<string> {
  const positional = splitArgs(args);
  const trimmedArgs = args.trim();
  const firstNumber = opts.kind === 'skill' ? 0 : 1;

  // Names keep the position they were declared at, even when an earlier one is unusable.
  const positionOf = new Map<string, number>();
  (opts.argumentNames ?? []).forEach((name, i) => {
    if (ARGUMENT_NAME.test(name) && name !== 'ARGUMENTS' && !positionOf.has(name)) positionOf.set(name, i);
  });
  // Longest first, so `$filename` is never read as `$file` followed by "name".
  const names = [...positionOf.keys()].sort((a, b) => b.length - a.length);

  const placeholder = new RegExp(
    '(?<escaped>\\\\)?(?:' +
      [
        ...(names.length > 0 ? [`\\$(?<name>${names.join('|')})(?![\\[A-Za-z0-9_])`] : []),
        '\\$ARGUMENTS\\[(?<index>\\d+)\\]',
        '\\$(?<all>ARGUMENTS)',
        '\\$\\{(?:COCO|CLAUDE)_(?<variable>SESSION_ID|SKILL_DIR|PROJECT_DIR)\\}',
        opts.kind === 'skill' ? '\\$(?<number>\\d+)(?![A-Za-z0-9_])' : '\\$(?<number>[1-9])',
      ].join('|') +
      ')',
    'g',
  );

  let consumed = false;
  const argument = (value: string | undefined): string => {
    if (value) consumed = true;
    return value ?? '';
  };
  const substitute = (template: string): string =>
    template.replace(placeholder, (...found: unknown[]) => {
      const match = found[0] as string;
      const groups = found[found.length - 1] as Record<string, string | undefined>;
      if (groups.escaped !== undefined) return match.slice(1);
      if (groups.name !== undefined) return argument(positional[positionOf.get(groups.name)!]);
      if (groups.index !== undefined) return argument(positional[Number(groups.index)]);
      if (groups.all !== undefined) return argument(trimmedArgs);
      if (groups.variable !== undefined) return opts.variables[groups.variable] || match;
      return argument(positional[Number(groups.number) - firstNumber]);
    });

  const pieces: { text: string; kind: 'text' | 'inline' | 'block' }[] = [];
  let last = 0;
  for (const m of body.matchAll(COMMAND_SYNTAX)) {
    const { indent, block, inline } = m.groups ?? {};
    if (block !== undefined && !block.trim()) continue; // an empty block is not a command
    pieces.push({ text: body.slice(last, m.index) + (indent ?? ''), kind: 'text' });
    pieces.push(block !== undefined ? { text: block.replace(/\r\n/g, '\n'), kind: 'block' } : { text: inline ?? '', kind: 'inline' });
    last = m.index + m[0].length;
  }
  pieces.push({ text: body.slice(last), kind: 'text' });

  const rendered = await Promise.all(
    pieces.map(async (piece) => {
      const expanded = substitute(piece.text);
      if (piece.kind === 'text') return expanded;
      if (!opts.runBash) return `[command not run: ${expanded}]`;
      let out: string | null;
      try {
        out = await opts.runBash(expanded);
      } catch (err) {
        return `[command failed: ${expanded}: ${errorText(err)}]`;
      }
      if (out === null) return `[command not permitted: ${expanded}]`;
      // A block's output keeps the indentation of its first line (think `git status --short`).
      return piece.kind === 'block' ? out.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd() : out.trim();
    }),
  );
  let result = rendered.join('');
  if (!consumed && trimmedArgs) result = `${result.trimEnd()}\n\nARGUMENTS: ${trimmedArgs}`;
  return result.trim();
}

/**
 * Expand the body of a legacy command file (commands/*.md). `$1`..`$9` count
 * from 1 here; see the placeholder table above for the rest.
 *
 * `runBash` decides whether a `!` command may run; `context` supplies the
 * session id and project directory. `${COCO_SKILL_DIR}` is the directory of
 * the command file when its path is known.
 */
export function expandCommand(
  command: Pick<CustomCommand, 'body'> & Partial<Pick<CustomCommand, 'path'>>,
  args: string,
  runBash?: (cmd: string) => Promise<string | null>,
  context: ExpansionContext = {},
): Promise<string> {
  return expandTemplate(command.body, args, {
    kind: 'command',
    variables: { SESSION_ID: context.sessionId, SKILL_DIR: command.path ? path.dirname(command.path) : undefined, PROJECT_DIR: context.projectDir },
    runBash: runBash ?? context.runBash,
  });
}

/**
 * Expand the body of a skill (SKILL.md). `$N` counts from 0 here, as Claude
 * Code documents for skills, and the names in the skill's `arguments` field
 * can be used as `$name`; see the placeholder table above for the rest.
 */
export function expandSkill(
  skill: Pick<SkillDefinition, 'body'> & Partial<Pick<SkillDefinition, 'baseDir' | 'argumentNames'>>,
  args: string,
  ctx: ExpansionContext = {},
): Promise<string> {
  return expandTemplate(skill.body, args, {
    kind: 'skill',
    argumentNames: skill.argumentNames,
    variables: { SESSION_ID: ctx.sessionId, SKILL_DIR: skill.baseDir, PROJECT_DIR: ctx.projectDir },
    runBash: ctx.runBash,
  });
}

// ------------------------------------------------------------------ agents

export interface AgentDefinition {
  name: string;
  description: string;
  /** Tool names the agent may use. Undefined means all tools. */
  tools?: string[];
  /** Tool names taken away from whatever `tools` grants. */
  disallowedTools?: string[];
  /** Undefined means the session model; Claude's own aliases (sonnet, opus, ...) are read that way too. */
  model?: string;
  /** Permission mode the agent runs in, as written (`default`, `acceptEdits`, `plan`, ...). */
  permissionMode?: string;
  /** Most turns the agent may take before it is stopped. */
  maxTurns?: number;
  /** Names of skills whose content is loaded into the agent's context at start. */
  skills?: string[];
  /** From `omitClaudeMd`: leave the project memory files out of the agent's prompt. */
  omitMemory?: boolean;
  effort?: string;
  /** Sent as the first user turn when the agent runs as the main session agent. */
  initialPrompt?: string;
  /** Always run this agent as a background task. */
  background?: boolean;
  color?: string;
  prompt: string;
  source: ExtensionSource;
  path?: string;
}

const READ_ONLY = ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'];

/** Claude Code calls two of these `Explore` and `Plan`; `findAgent` matches names whatever their case. */
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

/** The optional agent fields, shared by agent files and `--agents` JSON. */
function agentOptions(data: Fields): Partial<AgentDefinition> {
  return {
    tools: toolList(field(data, 'tools')),
    disallowedTools: toolList(field(data, 'disallowed-tools')),
    model: localModel(field(data, 'model')),
    permissionMode: textOf(field(data, 'permission-mode')),
    maxTurns: positiveInt(field(data, 'max-turns')),
    skills: stringList(field(data, 'skills')),
    omitMemory: boolOf(field(data, 'omit-claude-md')),
    effort: textOf(field(data, 'effort')),
    initialPrompt: textOf(field(data, 'initial-prompt')),
    background: boolOf(field(data, 'background')),
    color: textOf(field(data, 'color')),
  };
}

/**
 * Agents from the agents/ directories, searched with their subfolders, plus
 * the built-ins. An agent is identified by its name alone (the `name` field,
 * else the file name), compared without regard to case: the first definition
 * of a name wins, in the order session agents (`--agents`), project, user,
 * built-in, and within one directory the file nearest the top.
 */
export function loadAgents(projectRoot: string, claudeCompat: boolean, sessionAgents: AgentDefinition[] = []): AgentDefinition[] {
  const agents = new Map<string, AgentDefinition>();
  const add = (agent: AgentDefinition) => {
    const key = agent.name.toLowerCase();
    if (!agents.has(key)) agents.set(key, agent);
  };
  for (const agent of sessionAgents) add(agent);
  for (const { dir, source } of sourceDirs(projectRoot, claudeCompat, 'agents')) {
    const depth = (file: string) => path.relative(dir, file).split(path.sep).length;
    for (const file of markdownFiles(dir, true).sort((a, b) => depth(a) - depth(b))) {
      const doc = readDocument(file);
      if (!doc || !doc.body.trim()) continue;
      const { data, body } = doc;
      add(
        compact({
          name: textOf(data.name) ?? path.basename(file, '.md'),
          description: asString(data.description) ?? '',
          ...agentOptions(data),
          prompt: body.trim(),
          source,
          path: file,
        }),
      );
    }
  }
  for (const builtin of BUILTIN_AGENTS) add(builtin);
  return [...agents.values()];
}

/** Look an agent up by name. An exact match wins; otherwise case is ignored, so `Explore` finds `explore`. */
export function findAgent(defs: AgentDefinition[], name: string): AgentDefinition | undefined {
  const wanted = String(name ?? '').trim();
  if (!wanted) return undefined;
  return defs.find((a) => a.name === wanted) ?? defs.find((a) => a.name.toLowerCase() === wanted.toLowerCase());
}

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const AGENTS_JSON_SHAPE = 'a JSON object keyed by agent name, such as {"reviewer": {"description": "Reviews code", "prompt": "You review code."}}';

/**
 * Read the value of `--agents`: agents that exist for one session only. The
 * input is JSON when it starts with `{`, otherwise the path of a JSON file.
 * Each key names an agent whose value holds a `prompt` (required) and any of
 * the agent file fields: `description`, `tools`, `model` and so on.
 *
 * Never throws. Agents that are well formed are returned even when others
 * are not; `error` then says what was wrong with the rest.
 */
export function parseAgentsJson(input: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): { agents: AgentDefinition[]; error?: string } {
  const given = stripBom(String(input ?? '')).trim();
  if (!given) return { agents: [], error: `No agents were given. Expected ${AGENTS_JSON_SHAPE}, or the path of a file holding one.` };

  let json = given;
  let label = 'The agents JSON';
  if (!given.startsWith('{')) {
    label = `The agents file ${given}`;
    try {
      json = stripBom(String(readFile(expandHome(given))));
    } catch (err) {
      return { agents: [], error: `Could not read the agents file ${given}: ${errorText(err)}. Expected ${AGENTS_JSON_SHAPE}, or the path of a file holding one.` };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { agents: [], error: `${label} is not valid JSON: ${errorText(err)}` };
  }
  if (!isRecord(parsed)) return { agents: [], error: `${label} must be ${AGENTS_JSON_SHAPE}.` };

  const agents: AgentDefinition[] = [];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    const name = key.trim();
    if (!name) {
      problems.push('an agent has an empty name');
      continue;
    }
    if (!isRecord(value)) {
      problems.push(`agent "${name}" must be an object with a "prompt"`);
      continue;
    }
    if (typeof value.prompt !== 'string' || !value.prompt.trim()) {
      problems.push(`agent "${name}" needs a non-empty "prompt"`);
      continue;
    }
    // A tool list that cannot be read must not quietly become "all tools".
    const badList = ['tools', 'disallowed-tools'].find((k) => {
      const list = field(value, k);
      return list !== undefined && typeof list !== 'string' && !(Array.isArray(list) && list.every((item) => typeof item === 'string'));
    });
    if (badList) {
      problems.push(`agent "${name}": "${badList === 'tools' ? 'tools' : 'disallowedTools'}" must be a list of tool names or a comma-separated string`);
      continue;
    }
    agents.push(
      compact({
        name,
        description: textOf(value.description) ?? '',
        ...agentOptions(value),
        prompt: value.prompt.trim(),
        source: 'flag' as const,
      }),
    );
  }
  if (problems.length === 0) return { agents };
  return { agents, error: `${label} has ${problems.length === 1 ? 'an invalid definition' : 'invalid definitions'}: ${problems.join('; ')}.` };
}

// ------------------------------------------------------------------ skills

export interface SkillDefinition {
  name: string;
  description: string;
  /** `when_to_use`: extra trigger phrases, shown to the model after the description. */
  whenToUse?: string;
  /** `argument-hint`: shown after the name when completing `/name`. */
  argumentHint?: string;
  /** `arguments`: names for the positional arguments, usable in the body as `$name`. */
  argumentNames?: string[];
  /** `disable-model-invocation`: only the user may start the skill; it is not listed to the model. */
  disableModelInvocation: boolean;
  /** `user-invocable`: false hides the skill from the `/` menu; only the model may start it. */
  userInvocable: boolean;
  /** `allowed-tools`: permission rules granted while the skill is active. */
  allowedTools?: string[];
  /** `disallowed-tools`: tools taken away while the skill is active. */
  disallowedTools?: string[];
  /** Undefined means the session model; Claude's own aliases (sonnet, opus, ...) are read that way too. */
  model?: string;
  effort?: string;
  /** `context: fork`: run the skill in a subagent instead of the current conversation. */
  fork: boolean;
  /** `agent`: which subagent a forked skill runs in. */
  agent?: string;
  /** `paths`: glob patterns; the skill is offered only when working with matching files. */
  paths?: string[];
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
      const doc = readDocument(path.join(baseDir, 'SKILL.md'));
      if (!doc) continue;
      const { data, body } = doc;
      const name = textOf(data.name) ?? entry.name;
      if (skills.has(name)) continue;
      skills.set(
        name,
        compact({
          name,
          description: asString(data.description) ?? '',
          whenToUse: textOf(field(data, 'when-to-use')),
          argumentHint: hintText(field(data, 'argument-hint')),
          argumentNames: nameList(field(data, 'arguments')),
          disableModelInvocation: boolOf(field(data, 'disable-model-invocation')) ?? false,
          userInvocable: boolOf(field(data, 'user-invocable')) ?? true,
          allowedTools: toolList(field(data, 'allowed-tools')),
          disallowedTools: toolList(field(data, 'disallowed-tools')),
          model: localModel(data.model),
          effort: textOf(data.effort),
          fork: textOf(data.context)?.toLowerCase() === 'fork',
          agent: textOf(data.agent),
          paths: stringList(data.paths),
          baseDir,
          body,
          source,
        }),
      );
    }
  }
  return [...skills.values()];
}

/** Skills the model may start itself: everything except `disable-model-invocation: true`. */
export function modelVisibleSkills(skills: SkillDefinition[]): SkillDefinition[] {
  return skills.filter((s) => !s.disableModelInvocation);
}

/** Skills the user may start with `/name`: everything except `user-invocable: false`. */
export function userInvocableSkills(skills: SkillDefinition[]): SkillDefinition[] {
  return skills.filter((s) => s.userInvocable !== false);
}

const ELLIPSIS = String.fromCodePoint(0x2026);

/**
 * The one line that tells the model what a skill is for: its description,
 * then `when_to_use`, cut to `maxChars`. A skill that has neither is
 * described by the first line of its body.
 */
export function skillListing(skill: Pick<SkillDefinition, 'description'> & Partial<Pick<SkillDefinition, 'whenToUse' | 'body'>>, maxChars = 250): string {
  const oneLine = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const description = oneLine(skill.description);
  const whenToUse = oneLine(skill.whenToUse);
  let line = description && whenToUse ? `${description} - ${whenToUse}` : description || whenToUse;
  if (!line) line = oneLine((skill.body ?? '').trim().split('\n')[0]?.replace(/^#+\s*/, ''));
  if (line.length <= maxChars) return line;
  if (maxChars < 1) return '';
  let kept = line.slice(0, maxChars - 1);
  // Do not leave half of a surrogate pair behind.
  const lastUnit = kept.charCodeAt(kept.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) kept = kept.slice(0, -1);
  return kept.trimEnd() + ELLIPSIS;
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
      const doc = readDocument(file);
      if (!doc) continue;
      const { data, body } = doc;
      const name = (asString(data.name) ?? path.basename(file, '.md')).toLowerCase();
      if (styles.has(name) || !body.trim()) continue;
      styles.set(name, { name, description: asString(data.description) ?? '', prompt: body.trim(), source });
    }
  }
  for (const builtin of BUILTIN_STYLES) if (!styles.has(builtin.name)) styles.set(builtin.name, builtin);
  return [...styles.values()];
}
