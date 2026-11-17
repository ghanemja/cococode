import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULTS } from '../config/settings.ts';
import { plural } from '../ui/ansi.ts';
import { stripBom } from '../util/frontmatter.ts';
import {
  checkFresh,
  detectEol,
  editPermission,
  looksBinary,
  readPermission,
  recordRead,
  resolvePath,
  shortPath,
  writeFileTracked,
} from './fsutil.ts';
import { renderNotebook } from './notebook.ts';
import { clampOutput } from './shell.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { errorResult } from './types.ts';

const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Number lines the way the Read tool shows them. */
export function numberLines(lines: string[], start: number): string {
  return lines.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join('\n');
}

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export const readTool: Tool<ReadInput> = {
  name: 'Read',
  description:
    'Read a file. Returns up to 2000 lines, each prefixed with its line number and a tab (the prefix is not part of the file). ' +
    'Use offset and limit to page through large files. Also reads images and Jupyter notebooks.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file (absolute, or relative to the working directory)' },
      offset: { type: 'integer', description: 'Line number to start from (1-based)' },
      limit: { type: 'integer', description: 'Maximum number of lines to read' },
    },
    required: ['file_path'],
  },
  isReadOnly: () => true,
  permission: (input, ctx) => readPermission(ctx, 'Read', resolvePath(ctx, input.file_path)),
  label: (input, ctx) => shortPath(ctx, resolvePath(ctx, input.file_path)),
  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolvePath(ctx, input.file_path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return errorResult(`File does not exist: ${abs}. The working directory is ${ctx.cwd}. Use Glob to find the right path.`);
    }
    if (stat.isDirectory()) return errorResult(`${abs} is a directory. Use Glob to list files or Bash with ls.`);

    const ext = path.extname(abs).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      if (!ctx.session.vision) return errorResult(`${shortPath(ctx, abs)} is an image, and the current model does not accept images.`);
      if (stat.size > 5 * 1024 * 1024) return errorResult('Image is larger than 5 MB.');
      const data = fs.readFileSync(abs).toString('base64');
      return {
        content: `Image ${shortPath(ctx, abs)} attached.`,
        images: [{ type: 'image', mediaType: IMAGE_TYPES[ext]!, data }],
        summary: 'Read image',
      };
    }
    if (ext === '.pdf') return errorResult('PDF files cannot be read directly. If pdftotext is installed, run it with Bash and read the output.');

    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return errorResult(`${shortPath(ctx, abs)} is a binary file (${stat.size} bytes) and cannot be shown as text.`);
    const maxChars = ctx.settings.maxToolOutputChars ?? DEFAULTS.maxToolOutputChars;

    if (ext === '.ipynb') {
      recordRead(ctx, abs);
      try {
        return { content: clampOutput(renderNotebook(buf.toString('utf8')), maxChars), summary: 'Read notebook' };
      } catch (err) {
        return errorResult(`Could not parse notebook: ${(err as Error).message}`);
      }
    }

    const text = stripBom(buf.toString('utf8'));
    if (text.length === 0) {
      recordRead(ctx, abs);
      return { content: '(The file exists but is empty.)', summary: 'Read 0 lines' };
    }
    const allLines = text.replace(/\r\n/g, '\n').split('\n');
    if (allLines[allLines.length - 1] === '') allLines.pop();
    const total = allLines.length;
    const start = Math.max(1, Math.floor(input.offset ?? 1));
    if (start > total) return errorResult(`offset ${start} is past the end of the file (${plural(total, 'line')}).`);
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_READ_LINES));

    const selected: string[] = [];
    let chars = 0;
    let clipped = false;
    for (let i = start - 1; i < Math.min(total, start - 1 + limit); i++) {
      let line = allLines[i]!;
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]`;
      if (chars + line.length > maxChars && selected.length > 0) {
        clipped = true;
        break;
      }
      selected.push(line);
      chars += line.length + 8;
    }
    const end = start + selected.length - 1;
    const partial = start > 1 || end < total;
    recordRead(ctx, abs, partial);

    let content = numberLines(selected, start);
    if (end < total) {
      content += `\n\n[Showing lines ${start}-${end} of ${total}${clipped ? ' (output size limit reached)' : ''}. Call Read with offset=${end + 1} to continue.]`;
    }
    return { content, summary: `Read ${plural(selected.length, 'line')}${partial ? ` (${start}-${end} of ${total})` : ''}` };
  },
};

interface WriteInput {
  file_path: string;
  content: string;
}

export const writeTool: Tool<WriteInput> = {
  name: 'Write',
  description:
    'Create a file or replace its entire content. To change part of an existing file use Edit instead. ' +
    'An existing file must be Read first. Parent directories are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to write' },
      content: { type: 'string', description: 'The complete new content of the file' },
    },
    required: ['file_path', 'content'],
  },
  isReadOnly: () => false,
  permission: (input, ctx) => {
    const abs = resolvePath(ctx, input.file_path);
    return editPermission(ctx, 'Edit', abs, fs.existsSync(abs) ? 'Overwrite' : 'Create');
  },
  label: (input, ctx) => shortPath(ctx, resolvePath(ctx, input.file_path)),
  preview(input, ctx) {
    const abs = resolvePath(ctx, input.file_path);
    let before: string | null = null;
    try {
      before = fs.readFileSync(abs, 'utf8');
    } catch {
      before = null;
    }
    return { path: abs, before, after: String(input.content ?? '') };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolvePath(ctx, input.file_path);
    const stale = checkFresh(ctx, abs);
    if (stale) return errorResult(stale);
    let before: string | null = null;
    try {
      before = fs.readFileSync(abs, 'utf8');
    } catch {
      before = null;
    }
    if (before !== null && before === input.content) {
      return { content: `${shortPath(ctx, abs)} already has exactly this content; nothing was written.`, summary: 'No changes' };
    }
    try {
      writeFileTracked(ctx, abs, input.content);
    } catch (err) {
      return errorResult(`Could not write ${abs}: ${(err as Error).message}`);
    }
    const lines = input.content === '' ? 0 : input.content.replace(/\n$/, '').split('\n').length;
    const verb = before === null ? 'Created' : 'Overwrote';
    return {
      content: `${verb} ${shortPath(ctx, abs)} (${plural(lines, 'line')}, ${Buffer.byteLength(input.content)} bytes).`,
      summary: `${before === null ? 'Wrote' : 'Rewrote'} ${plural(lines, 'line')}`,
      diff: { path: abs, before, after: input.content },
    };
  },
};

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Remove "   12\t" prefixes when the model pasted Read output verbatim. */
function stripLineNumbers(text: string): string {
  const lines = text.split('\n');
  const numbered = lines.filter((l) => l.trim() !== '');
  if (numbered.length > 0 && numbered.every((l) => /^\s*\d+\t/.test(l))) {
    return lines.map((l) => l.replace(/^\s*\d+\t/, '')).join('\n');
  }
  return text;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

export interface FuzzyMatch {
  /** Exact text in the file that corresponds to old_string. */
  actual: string;
  /** new_string adjusted to the file's indentation. */
  replacement: string;
  count: number;
  how: string;
}

/**
 * Find old_string allowing for whitespace differences. Models often get the
 * indentation or trailing spaces wrong while the content is right; when there
 * is exactly one such region, editing it is what was meant.
 */
export function fuzzyFind(content: string, oldString: string, newString: string): FuzzyMatch | null {
  const fileLines = content.split('\n');
  const oldLines = oldString.replace(/^\n+|\n+$/g, '').split('\n');
  if (oldLines.length === 0 || oldLines.every((l) => l.trim() === '')) return null;

  const strategies: { how: string; norm: (s: string) => string }[] = [
    { how: 'ignoring trailing whitespace', norm: (s) => s.replace(/[ \t]+$/, '') },
    { how: 'ignoring indentation', norm: (s) => s.trim() },
    { how: 'ignoring whitespace differences', norm: (s) => s.replace(/\s+/g, ' ').trim() },
  ];

  for (const { how, norm } of strategies) {
    const want = oldLines.map(norm);
    const starts: number[] = [];
    for (let i = 0; i + want.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (norm(fileLines[i + j]!) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) starts.push(i);
    }
    if (starts.length === 0) continue;
    const start = starts[0]!;
    const actual = fileLines.slice(start, start + want.length).join('\n');

    // Shift the replacement by the difference between the file's indent and the model's.
    const fileIndent = leadingWhitespace(fileLines[start + oldLines.findIndex((l) => l.trim() !== '')] ?? '');
    const modelIndent = leadingWhitespace(oldLines.find((l) => l.trim() !== '') ?? '');
    let replacement = newString.replace(/^\n+|\n+$/g, '');
    if (fileIndent !== modelIndent) {
      replacement = replacement
        .split('\n')
        .map((line) => {
          if (line.trim() === '') return line;
          if (line.startsWith(modelIndent)) return fileIndent + line.slice(modelIndent.length);
          return fileIndent + line.trimStart();
        })
        .join('\n');
    }
    return { actual, replacement, count: starts.length, how };
  }
  return null;
}

/** Show the model where its old_string most nearly matches, so it can correct itself. */
function nearestContext(content: string, oldString: string): string {
  const probe = oldString.split('\n').map((l) => l.trim()).find((l) => l.length >= 4);
  if (!probe) return '';
  const lines = content.split('\n');
  let best = -1;
  let bestScore = 0;
  const probeWords = new Set(probe.split(/\W+/).filter((w) => w.length > 2));
  if (probeWords.size === 0) return '';
  for (let i = 0; i < lines.length; i++) {
    const words = lines[i]!.split(/\W+/);
    let score = 0;
    for (const w of words) if (probeWords.has(w)) score++;
    const ratio = score / probeWords.size;
    if (ratio > bestScore) {
      bestScore = ratio;
      best = i;
    }
  }
  if (best < 0 || bestScore < 0.5) return '';
  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, best + 3);
  return `\nThe closest text in the file is around line ${best + 1}:\n${numberLines(lines.slice(from, to), from + 1)}`;
}

function snippetAround(content: string, index: number, length: number): string {
  const startLine = content.slice(0, index).split('\n').length;
  const endLine = startLine + content.slice(index, index + length).split('\n').length - 1;
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // a trailing newline is not an extra line
  const from = Math.max(1, startLine - 3);
  const to = Math.min(lines.length, endLine + 3);
  const shown = lines.slice(from - 1, to);
  if (shown.length > 40) return numberLines([...shown.slice(0, 20), '…', ...shown.slice(-15)], from);
  return numberLines(shown, from);
}

type EditPlan =
  | { error: string }
  | { abs: string; before: string | null; after: string; output: string; summary: string; message: string };

/** Work out what an Edit call would do, without touching the file. */
export function planEdit(input: EditInput, ctx: ToolContext): EditPlan {
  const abs = resolvePath(ctx, input.file_path);
  const name = shortPath(ctx, abs);
  const inputOld = String(input.old_string ?? '');
  const inputNew = String(input.new_string ?? '');

  if (!fs.existsSync(abs)) {
    if (inputOld !== '') return { error: `File does not exist: ${abs}. Use Write to create it, or Glob to find the right path.` };
    return { abs, before: null, after: inputNew, output: inputNew, summary: 'Created file', message: `Created ${name}.` };
  }
  const stale = checkFresh(ctx, abs);
  if (stale) return { error: stale };

  const raw = fs.readFileSync(abs, 'utf8');
  const eol = detectEol(raw);
  const content = raw.replace(/\r\n/g, '\n');
  let oldString = stripLineNumbers(inputOld.replace(/\r\n/g, '\n'));
  let newString = stripLineNumbers(inputNew.replace(/\r\n/g, '\n'));

  if (oldString === newString) return { error: 'old_string and new_string are identical; nothing to change.' };
  if (oldString === '') {
    if (content.trim() !== '') {
      return { error: 'old_string is empty but the file has content. Provide the text to replace, or use Write to replace the whole file.' };
    }
    return { abs, before: raw, after: newString, output: newString, summary: 'Wrote file', message: `Wrote ${name}.` };
  }

  let note = '';
  let count = countOccurrences(content, oldString);
  if (count === 0) {
    const fuzzy = fuzzyFind(content, oldString, newString);
    if (!fuzzy) {
      return {
        error:
          `old_string was not found in ${name}. It must match the file exactly, including whitespace and indentation.` +
          nearestContext(content, oldString) +
          '\nRead the file again and copy the text exactly.',
      };
    }
    if (fuzzy.count > 1 && !input.replace_all) {
      return { error: `old_string matches ${fuzzy.count} places in ${name} (${fuzzy.how}). Include more surrounding lines so it matches exactly one.` };
    }
    oldString = fuzzy.actual;
    newString = fuzzy.replacement;
    count = countOccurrences(content, oldString);
    note = ` (matched ${fuzzy.how})`;
  }
  if (count > 1 && !input.replace_all) {
    const lineNos: number[] = [];
    for (let i = content.indexOf(oldString); i >= 0 && lineNos.length < 8; i = content.indexOf(oldString, i + oldString.length)) {
      lineNos.push(content.slice(0, i).split('\n').length);
    }
    return {
      error:
        `old_string appears ${count} times in ${name} (lines ${lineNos.join(', ')}). ` +
        'Add surrounding lines to make it unique, or set replace_all to true.',
    };
  }

  const firstIndex = content.indexOf(oldString);
  const updated = input.replace_all
    ? content.split(oldString).join(newString)
    : content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length);
  const replaced = input.replace_all ? count : 1;
  return {
    abs,
    before: content,
    after: updated,
    output: eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated,
    summary: `Replaced ${plural(replaced, 'occurrence')}${note}`,
    message:
      `Edited ${name}: replaced ${plural(replaced, 'occurrence')}${note}. The file now reads:\n` +
      snippetAround(updated, firstIndex, newString.length),
  };
}

export const editTool: Tool<EditInput> = {
  name: 'Edit',
  description:
    'Replace text in a file. old_string must match the file exactly (including indentation) and identify one location; ' +
    'include enough surrounding lines to make it unique, or set replace_all to change every occurrence. ' +
    'The file must be Read first. Do not include line-number prefixes from Read output.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to edit' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Text to put in its place' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly: () => false,
  permission: (input, ctx) => editPermission(ctx, 'Edit', resolvePath(ctx, input.file_path)),
  label: (input, ctx) => shortPath(ctx, resolvePath(ctx, input.file_path)),
  preview(input, ctx) {
    const plan = planEdit(input, ctx);
    return 'error' in plan ? null : { path: plan.abs, before: plan.before, after: plan.after };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const plan = planEdit(input, ctx);
    if ('error' in plan) return errorResult(plan.error);
    try {
      writeFileTracked(ctx, plan.abs, plan.output);
    } catch (err) {
      return errorResult(`Could not write ${plan.abs}: ${(err as Error).message}`);
    }
    return { content: plan.message, summary: plan.summary, diff: { path: plan.abs, before: plan.before, after: plan.after } };
  },
};

/** Used by tests and by the @-mention expander. */
export function readForContext(ctx: ToolContext, absPath: string, maxChars: number): string | null {
  try {
    const buf = fs.readFileSync(absPath);
    if (looksBinary(buf)) return null;
    recordRead(ctx, absPath, buf.length > maxChars);
    const text = buf.toString('utf8');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated, ${text.length - maxChars} more characters]` : text;
  } catch {
    return null;
  }
}
