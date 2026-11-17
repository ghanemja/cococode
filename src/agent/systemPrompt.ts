import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import type { PermissionMode } from '../types.ts';

export interface EnvInfo {
  cwd: string;
  projectRoot: string;
  additionalDirs: string[];
  model: string;
  isGit: boolean;
  gitBranch?: string;
  gitStatus?: string;
  recentCommits?: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return res.status === 0 ? res.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot of the repository taken once at session start. */
export function gatherEnv(cwd: string, projectRoot: string, additionalDirs: string[], model: string): EnvInfo {
  const info: EnvInfo = { cwd, projectRoot, additionalDirs, model, isGit: false };
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true') {
    info.isGit = true;
    info.gitBranch = git(cwd, ['branch', '--show-current']) || undefined;
    const status = git(cwd, ['status', '--short']);
    if (status) {
      const lines = status.split('\n');
      info.gitStatus = lines.length > 15 ? `${lines.slice(0, 15).join('\n')}\n… (${lines.length - 15} more)` : status;
    }
    info.recentCommits = git(cwd, ['log', '--oneline', '-n', '3']);
  }
  return info;
}

export function renderEnv(env: EnvInfo): string {
  const lines = [
    '# Environment',
    `Working directory: ${env.cwd}`,
    ...(env.additionalDirs.length ? [`Additional directories: ${env.additionalDirs.join(', ')}`] : []),
    `Platform: ${process.platform} (${os.release()})`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Model: ${env.model}`,
    `Git repository: ${env.isGit ? `yes${env.gitBranch ? `, branch ${env.gitBranch}` : ''}` : 'no'}`,
  ];
  if (env.isGit) {
    lines.push(`Git status at session start: ${env.gitStatus ? `\n${env.gitStatus}` : 'clean'}`);
    if (env.recentCommits) lines.push(`Recent commits:\n${env.recentCommits}`);
  }
  return lines.join('\n');
}

const BASE_PROMPT = `You are coco, a coding agent running in the user's terminal. You work directly in their project: you read and edit files, run commands and check the results using the tools provided.

# How to work
- Act instead of describing. When a task needs a file changed or a command run, call the tool. Never say you did something unless a tool call did it, and never invent file contents or command output.
- Look before you change anything. Read the relevant files first, and find things with Glob and Grep instead of guessing paths.
- Make the smallest change that fully solves the task, in the style of the surrounding code. Do not add features, files or comments that were not asked for.
- After changing code, verify it: run the tests, the build or the linter if the project has them. When something fails, read the error and fix the cause.
- When a tool call fails, read the message and change your approach. Do not repeat the same call unchanged.
- For work with several steps, keep a task list with TodoWrite and update it as you go.
- Stop when the task is done. If you are blocked, or the request is ambiguous in a way that changes what you would build, ask a short question.

# Tools
- Use Read, Edit and Write for files, Glob and Grep to search, and Bash for everything else (git, tests, builds, package managers).
- A file must be Read before you Edit or overwrite it. Edit needs old_string to match the file exactly; copy it from the Read output without the line-number prefix.
- Paths may be absolute or relative to the working directory.
- Call several tools in one reply when they do not depend on each other.
- Do not run destructive commands (deleting outside the project, force-pushing, rewriting git history) unless the user asked for exactly that. Commit only when asked.
- If the user denies a tool call, do not retry it; adjust or ask what they would prefer.

# Communication
- Be concise and direct. Output is shown in a terminal and rendered as Markdown.
- Refer to code as path:line.
- When you finish, say briefly what you changed and how you verified it. If you could not verify something, say so plainly.`;

const SUBAGENT_RULES = `# Rules
- Use the tools to do the work; never claim results you did not get from a tool.
- Paths may be absolute or relative to the working directory. A file must be Read before it is edited.
- When a tool call fails, read the message and change your approach.
- Your final message is returned to the caller as the result. Make it complete and self-contained.`;

export interface PromptParts {
  env: EnvInfo;
  /** Rendered memory files (COCO.md and friends). */
  memory?: string;
  mode: PermissionMode;
  outputStyle?: string;
  skills?: { name: string; description: string }[];
  agents?: { name: string; description: string }[];
  mcpInstructions?: { server: string; text: string }[];
  /** Replaces the built-in prompt (--system-prompt). */
  override?: string;
  /** Appended after everything else (--append-system-prompt). */
  append?: string;
}

export const PLAN_MODE_PROMPT = `# Plan mode is active
The user wants a plan before any changes are made. You may only read and research: do not edit files or run commands that change state. Investigate until you understand what needs to happen, then call ExitPlanMode with a concise plan (what will change, in which files, and how it will be verified) and wait for approval.`;

export function buildSystemPrompt(parts: PromptParts): string {
  const sections: string[] = [parts.override?.trim() || BASE_PROMPT];
  if (parts.outputStyle?.trim()) sections.push(parts.outputStyle.trim());
  if (parts.mode === 'plan') sections.push(PLAN_MODE_PROMPT);
  if (parts.agents?.length) {
    sections.push(['# Subagents', 'Available subagent_type values for the Agent tool:', ...parts.agents.map((a) => `- ${a.name}: ${a.description}`)].join('\n'));
  }
  if (parts.skills?.length) {
    sections.push(
      ['# Skills', 'Load one with the Skill tool when it matches the task:', ...parts.skills.map((s) => `- ${s.name}: ${s.description}`)].join('\n'),
    );
  }
  for (const mcp of parts.mcpInstructions ?? []) {
    if (mcp.text.trim()) sections.push(`# Instructions from MCP server "${mcp.server}"\n${mcp.text.trim().slice(0, 2000)}`);
  }
  sections.push(renderEnv(parts.env));
  if (parts.memory?.trim()) sections.push(parts.memory.trim());
  if (parts.append?.trim()) sections.push(parts.append.trim());
  return sections.join('\n\n');
}

export function buildSubagentPrompt(agentPrompt: string, env: EnvInfo, memory?: string): string {
  return [agentPrompt.trim(), SUBAGENT_RULES, renderEnv(env), memory?.trim()].filter(Boolean).join('\n\n');
}
