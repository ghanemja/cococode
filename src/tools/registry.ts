import type { ToolSpec } from '../types.ts';
import { bashOutputTool, bashTool, killShellTool } from './bash.ts';
import { editTool, readTool, writeTool } from './files.ts';
import { agentTool, askUserTool, enterPlanModeTool, exitPlanModeTool, skillTool, todoWriteTool } from './meta.ts';
import { notebookEditTool } from './notebook.ts';
import { globTool, grepTool } from './searchTools.ts';
import type { Tool } from './types.ts';
import { webFetchTool } from './webfetch.ts';
import { webSearchTool } from './websearch.ts';

/** Every built-in tool, in the order they are presented to the model. */
export function builtinTools(): Tool[] {
  return [
    readTool,
    editTool,
    writeTool,
    bashTool,
    globTool,
    grepTool,
    todoWriteTool,
    agentTool,
    webFetchTool,
    webSearchTool,
    bashOutputTool,
    killShellTool,
    notebookEditTool,
    askUserTool,
    enterPlanModeTool,
    exitPlanModeTool,
    skillTool,
  ];
}

/** Tools that only ever read; used for the Explore and Plan subagents. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite', 'BashOutput'];

export function toolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/**
 * Apply a --tools / agent `tools:` filter. Names are matched case-insensitively,
 * `*` keeps everything, and a couple of historical aliases are understood.
 */
export function filterTools(tools: Tool[], names: string[] | undefined): Tool[] {
  if (!names || names.length === 0 || names.includes('*')) return tools;
  const alias: Record<string, string> = { task: 'agent', ls: 'glob', multiedit: 'edit', todoread: 'todowrite' };
  const wanted = new Set(names.map((n) => alias[n.toLowerCase()] ?? n.toLowerCase()));
  return tools.filter((t) => wanted.has(t.name.toLowerCase()) || [...wanted].some((w) => w.startsWith('mcp__') && t.name.toLowerCase().startsWith(w)));
}

/** Apply an agent's `disallowedTools`: drop tools named there. Entries with a spec, such as Bash(rm *), are permission rules and are ignored here. */
export function withoutTools(tools: Tool[], names: string[] | undefined): Tool[] {
  if (!names || names.length === 0) return tools;
  const alias: Record<string, string> = { task: 'agent', ls: 'glob', multiedit: 'edit', todoread: 'todowrite' };
  const banned = new Set(names.filter((n) => !n.includes('(')).map((n) => alias[n.toLowerCase()] ?? n.toLowerCase()));
  return tools.filter((t) => !banned.has(t.name.toLowerCase()));
}
