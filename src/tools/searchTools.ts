import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULTS } from '../config/settings.ts';
import { plural } from '../ui/ansi.ts';
import { readPermission, resolvePath, shortPath } from './fsutil.ts';
import { globFiles, grepFiles } from './search.ts';
import { clampOutput } from './shell.ts';
import type { Tool, ToolResult } from './types.ts';
import { errorResult } from './types.ts';

const MAX_GLOB_RESULTS = 100;

interface GlobInput {
  pattern: string;
  path?: string;
}

export const globTool: Tool<GlobInput> = {
  name: 'Glob',
  description:
    'Find files by name pattern, e.g. "**/*.ts" or "src/**/test_*.py". Returns matching paths, most recently modified first. ' +
    'Respects .gitignore.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match file paths against' },
      path: { type: 'string', description: 'Directory to search in (default: working directory)' },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  permission: (input, ctx) => readPermission(ctx, 'Read', resolvePath(ctx, input.path ?? '.'), 'Search'),
  label: (input, ctx) => (input.path ? `${input.pattern} in ${shortPath(ctx, resolvePath(ctx, input.path))}` : input.pattern),
  async execute(input, ctx): Promise<ToolResult> {
    let root = resolvePath(ctx, input.path ?? '.');
    let pattern = input.pattern.trim();
    // An absolute pattern carries its own root.
    if (path.isAbsolute(pattern)) {
      const firstGlob = pattern.search(/[*?[{]/);
      const base = firstGlob < 0 ? path.dirname(pattern) : pattern.slice(0, pattern.lastIndexOf('/', firstGlob));
      root = base || '/';
      pattern = pattern.slice(root.length).replace(/^\//, '');
    }
    if (!fs.existsSync(root)) return errorResult(`Directory does not exist: ${root}`);
    if (!fs.statSync(root).isDirectory()) return errorResult(`${root} is not a directory.`);
    const files = await globFiles(root, pattern, ctx.signal);
    if (files.length === 0) return { content: 'No files found.', summary: 'No files found' };
    const prefix = path.relative(ctx.cwd, root);
    const shown = files.slice(0, MAX_GLOB_RESULTS).map((f) => (prefix && !prefix.startsWith('..') ? path.join(prefix, f) : prefix ? path.join(root, f) : f));
    let content = shown.join('\n');
    if (files.length > MAX_GLOB_RESULTS) {
      content += `\n\n[${files.length - MAX_GLOB_RESULTS} more files not shown. Use a narrower pattern.]`;
    }
    return { content, summary: `Found ${plural(files.length, 'file')}` };
  },
};

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'files_with_matches' | 'content' | 'count';
  case_insensitive?: boolean;
  context?: number;
  head_limit?: number;
  multiline?: boolean;
  [alias: string]: unknown;
}

export const grepTool: Tool<GrepInput> = {
  name: 'Grep',
  description:
    'Search file contents with a regular expression. output_mode "files_with_matches" (default) lists files, ' +
    '"content" shows matching lines as path:line:text, "count" shows match counts per file. Respects .gitignore.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search (default: working directory)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.py"' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
      case_insensitive: { type: 'boolean' },
      context: { type: 'integer', description: 'Lines of context around each match (content mode)' },
      head_limit: { type: 'integer', description: 'Maximum number of result lines (default 200)' },
      multiline: { type: 'boolean', description: 'Let patterns span lines' },
    },
    required: ['pattern'],
    additionalProperties: true,
  },
  isReadOnly: () => true,
  permission: (input, ctx) => readPermission(ctx, 'Read', resolvePath(ctx, input.path ?? '.'), 'Search'),
  label: (input, ctx) => {
    const where = input.path ? ` in ${shortPath(ctx, resolvePath(ctx, input.path))}` : '';
    return `${JSON.stringify(input.pattern)}${where}${input.glob ? ` (${input.glob})` : ''}`;
  },
  async execute(input, ctx): Promise<ToolResult> {
    // Accept the short flag names many models reach for.
    const caseInsensitive = Boolean(input.case_insensitive ?? input['-i'] ?? input.ignore_case);
    const contextRaw = input.context ?? input['-C'] ?? input['-A'] ?? input['-B'];
    const context = contextRaw !== undefined ? Math.max(0, Math.min(20, Number(contextRaw) || 0)) : undefined;
    const mode = input.output_mode ?? (context !== undefined || input['-n'] ? 'content' : 'files_with_matches');
    const limit = Math.max(1, Number(input.head_limit) || 200);

    const res = await grepFiles({
      pattern: input.pattern,
      root: resolvePath(ctx, input.path ?? '.'),
      glob: typeof input.glob === 'string' ? input.glob : undefined,
      mode,
      caseInsensitive,
      context,
      multiline: Boolean(input.multiline),
      signal: ctx.signal,
    });
    if (res.error) return errorResult(res.error);
    if (res.lines.length === 0) return { content: 'No matches found.', summary: 'No matches' };

    const shown = res.lines.slice(0, limit);
    let content = shown.join('\n');
    if (res.lines.length > limit) {
      content += `\n\n[${res.lines.length - limit} more lines not shown. Narrow the pattern or raise head_limit.]`;
    }
    content = clampOutput(content, ctx.settings.maxToolOutputChars ?? DEFAULTS.maxToolOutputChars);
    const summary =
      mode === 'files_with_matches'
        ? `Found ${plural(res.lines.length, 'file')}`
        : mode === 'count'
          ? `Counted matches in ${plural(res.lines.length, 'file')}`
          : `Found ${plural(res.lines.filter((l) => l !== '--').length, 'line')}`;
    return { content, summary };
  },
};
