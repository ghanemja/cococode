import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULTS } from '../config/settings.ts';
import { plural } from '../ui/ansi.ts';
import { stripBom } from '../util/frontmatter.ts';
import {
  checkFresh,
  decodeUtf8,
  detectEol,
  editPermission,
  encodingProblem,
  examineFile,
  looksBinary,
  looksUtf16,
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
const BOM = String.fromCodePoint(0xfeff);
const REPLACEMENT = String.fromCodePoint(0xfffd);
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
    if (looksBinary(buf)) {
      const utf16 = looksUtf16(buf) ? ' It looks like UTF-16 text: convert it with Bash, for example iconv -f UTF-16 -t UTF-8, and read the result.' : '';
      return errorResult(`${shortPath(ctx, abs)} is a binary file (${stat.size} bytes) and cannot be shown as text.${utf16}`);
    }
    const maxChars = ctx.settings.maxToolOutputChars ?? DEFAULTS.maxToolOutputChars;

    if (ext === '.ipynb') {
      recordRead(ctx, abs, false, buf);
      try {
        return { content: clampOutput(renderNotebook(buf.toString('utf8')), maxChars), summary: 'Read notebook' };
      } catch (err) {
        return errorResult(`Could not parse notebook: ${(err as Error).message}`);
      }
    }

    // A file in another encoding is still shown, with the bytes that do not decode replaced,
    // but the model is told: text read this way cannot be written back without damage.
    const problem = encodingProblem(buf);
    const encodingNote = problem
      ? `\n\n[${shortPath(ctx, abs)} ${problem}. Bytes that do not decode are shown as ${REPLACEMENT}, and Edit will refuse this file: change it with a shell tool such as sed, or convert it to UTF-8 with iconv first.]`
      : '';
    const text = stripBom(buf.toString('utf8'));
    if (text.length === 0) {
      recordRead(ctx, abs, false, buf);
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
    recordRead(ctx, abs, partial, buf);

    let content = numberLines(selected, start);
    if (end < total) {
      content += `\n\n[Showing lines ${start}-${end} of ${total}${clipped ? ' (output size limit reached)' : ''}. Call Read with offset=${end + 1} to continue.]`;
    }
    content += encodingNote;
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

export interface FuzzyRegion {
  /** Index of the first matched line in the file. */
  startLine: number;
  lineCount: number;
  /** Exact text in the file that corresponds to old_string. */
  actual: string;
  /** new_string adjusted to the file's indentation at this place. */
  replacement: string;
}

export interface FuzzyMatch extends Omit<FuzzyRegion, 'startLine' | 'lineCount'> {
  /** Every place that matched; `actual` and `replacement` describe the first. */
  regions: FuzzyRegion[];
  count: number;
  how: string;
}

const onlyTabs = (s: string) => s !== '' && /^\t+$/.test(s);
const onlySpaces = (s: string) => s !== '' && /^ +$/.test(s);

/**
 * Work out how the model's indentation maps onto the file's from the lines
 * that matched, then apply the same mapping to the replacement text. Returns
 * null when the mapping is contradictory (the same indentation in old_string
 * stands for different indentation in the file) and the replacement adds or
 * removes lines: then there is no telling how the new lines should be
 * indented, and guessing would corrupt the code.
 */
function reindent(oldLines: string[], fileLines: string[], replacement: string[]): string[] | null {
  const map = new Map<string, string>();
  let contradictory = false;
  for (let j = 0; j < oldLines.length; j++) {
    if (oldLines[j]!.trim() === '') continue;
    const from = leadingWhitespace(oldLines[j]!);
    const to = leadingWhitespace(fileLines[j]!);
    if (map.has(from) && map.get(from) !== to) contradictory = true;
    map.set(from, to);
  }
  if (contradictory) {
    // Still safe when the replacement has the same shape as old_string: each new
    // line then simply keeps the indentation of the file line it replaces.
    const sameShape =
      replacement.length === oldLines.length &&
      replacement.every((line, j) => (line.trim() === '') === (oldLines[j]!.trim() === '') && leadingWhitespace(line) === leadingWhitespace(oldLines[j]!));
    if (!sameShape) return null;
    return replacement.map((line, j) => (line.trim() === '' ? line : leadingWhitespace(fileLines[j]!) + line.trimStart()));
  }
  if ([...map].every(([from, to]) => from === to)) return replacement;

  // Spaces in old_string standing for tabs in the file (or the reverse): learn the width.
  let spacesPerTab = 0;
  let tabsToSpaces = 0;
  for (const [from, to] of map) {
    if (onlySpaces(from) && onlyTabs(to) && from.length % to.length === 0) spacesPerTab = from.length / to.length;
    if (onlyTabs(from) && onlySpaces(to) && to.length % from.length === 0) tabsToSpaces = to.length / from.length;
  }
  const convert = (extra: string): string => {
    if (spacesPerTab && onlySpaces(extra)) return '\t'.repeat(Math.floor(extra.length / spacesPerTab)) + ' '.repeat(extra.length % spacesPerTab);
    if (tabsToSpaces && onlyTabs(extra)) return ' '.repeat(extra.length * tabsToSpaces);
    return extra;
  };
  const known = [...map.keys()].sort((x, y) => y.length - x.length);

  return replacement.map((line) => {
    if (line.trim() === '') return line;
    const indent = leadingWhitespace(line);
    const body = line.slice(indent.length);
    const exact = map.get(indent);
    if (exact !== undefined) return exact + body;
    // Deeper than a known level: that level's indentation plus the extra.
    const base = known.find((k) => indent.startsWith(k));
    if (base !== undefined) return map.get(base)! + convert(indent.slice(base.length)) + body;
    // Shallower than every known level: remove the same amount from the shallowest.
    const shallowest = known[known.length - 1]!;
    const target = map.get(shallowest)!;
    const removed = convert(shallowest.slice(indent.length));
    return (target.endsWith(removed) ? target.slice(0, target.length - removed.length) : '') + body;
  });
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
  const trimmedNew = newString.replace(/^\n+|\n+$/g, '');
  // An empty replacement removes the lines rather than leaving a blank one.
  const newLines = trimmedNew === '' ? [] : trimmedNew.split('\n');

  const strategies: { how: string; norm: (s: string) => string }[] = [
    { how: 'ignoring trailing whitespace', norm: (s) => s.replace(/[ \t]+$/, '') },
    { how: 'ignoring indentation', norm: (s) => s.trim() },
    { how: 'ignoring whitespace differences', norm: (s) => s.replace(/\s+/g, ' ').trim() },
  ];

  for (const { how, norm } of strategies) {
    const want = oldLines.map(norm);
    const regions: FuzzyRegion[] = [];
    let contradictory = false;
    for (let i = 0; i + want.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (norm(fileLines[i + j]!) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const matched = fileLines.slice(i, i + want.length);
      const lines = reindent(oldLines, matched, newLines);
      if (lines === null) contradictory = true;
      else regions.push({ startLine: i, lineCount: want.length, actual: matched.join('\n'), replacement: lines.join('\n') });
      i += want.length - 1; // matches do not overlap
    }
    // A place that matched but cannot be re-indented safely makes the whole attempt unsafe.
    if (contradictory) return null;
    if (regions.length === 0) continue;
    return { actual: regions[0]!.actual, replacement: regions[0]!.replacement, regions, count: regions.length, how };
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

/**
 * Work out what an Edit call would do, without touching the file.
 *
 * A file that changed on disk after the model read it is not refused outright:
 * when old_string still matches the current content exactly, in one place (or
 * anywhere, with replace_all), the edit means the same thing it meant before
 * the change. Only then; the whitespace-tolerant matching is for files whose
 * content the model has seen.
 */
export function planEdit(input: EditInput, ctx: ToolContext): EditPlan {
  const abs = resolvePath(ctx, input.file_path);
  const name = shortPath(ctx, abs);
  const inputOld = String(input.old_string ?? '');
  const inputNew = String(input.new_string ?? '');

  if (!fs.existsSync(abs)) {
    if (inputOld !== '') return { error: `File does not exist: ${abs}. Use Write to create it, or Glob to find the right path.` };
    return { abs, before: null, after: inputNew, output: inputNew, summary: 'Created file', message: `Created ${name}.` };
  }
  let bytes: Buffer | undefined;
  let readError = '';
  try {
    bytes = fs.readFileSync(abs);
  } catch (err) {
    readError = (err as Error).message; // a directory, or unreadable
  }
  const check = examineFile(ctx, abs, bytes);
  if (check.state === 'directory' || check.state === 'unread') return { error: check.message! };
  if (!bytes) return { error: `Could not read ${abs}: ${readError}` };
  const changed = check.state === 'changed';

  const problem = encodingProblem(bytes);
  if (problem) {
    return {
      error:
        `${name} ${problem}, and Edit only works on UTF-8 text: decoding the file would replace the bytes that do not fit and corrupt it. ` +
        'Change it with a shell tool such as sed, or convert it to UTF-8 with iconv first.',
    };
  }
  const decoded = decodeUtf8(bytes)!;
  // A byte-order mark is not text to match against; it is put back when the file is written.
  const bom = decoded.startsWith(BOM) ? BOM : '';
  const raw = decoded.slice(bom.length);
  const eol = detectEol(raw);
  const content = raw.replace(/\r\n/g, '\n');
  let oldString = inputOld.replace(/\r\n/g, '\n');
  let newString = inputNew.replace(/\r\n/g, '\n');
  if (bom) {
    oldString = stripBom(oldString);
    newString = stripBom(newString);
  }

  if (oldString === newString) return { error: 'old_string and new_string are identical; nothing to change.' };
  if (oldString === '') {
    if (content.trim() !== '') {
      return { error: 'old_string is empty but the file has content. Provide the text to replace, or use Write to replace the whole file.' };
    }
    // Filling the file replaces all of it, which like Write needs a current read.
    if (changed) return { error: check.message! };
    return { abs, before: raw, after: newString, output: bom + newString, summary: 'Wrote file', message: `Wrote ${name}.` };
  }

  let count = countOccurrences(content, oldString);
  if (count === 0) {
    // The text may have been pasted from Read output, line-number prefixes and all. Only
    // assume so when it does not match as written: a TSV row really can start "12<tab>".
    const bare = stripLineNumbers(oldString);
    if (bare !== oldString && (countOccurrences(content, bare) > 0 || (!changed && fuzzyFind(content, bare, '') !== null))) {
      oldString = bare;
      newString = stripLineNumbers(newString);
      if (oldString === newString) return { error: 'old_string and new_string are identical; nothing to change.' };
      count = countOccurrences(content, oldString);
    }
  }
  if (count === 0) {
    // No exact match in a file the model has not seen in its current state: a looser match could land anywhere.
    if (changed) return { error: check.message! };
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
    // Whole lines matched, so splice lines; each place gets its own re-indented replacement.
    const lines = content.split('\n');
    for (const region of [...fuzzy.regions].reverse()) {
      const replacement = newString.replace(/^\n+|\n+$/g, '') === '' ? [] : region.replacement.split('\n');
      lines.splice(region.startLine, region.lineCount, ...replacement);
    }
    const first = fuzzy.regions[0]!;
    const offset = content.split('\n').slice(0, first.startLine).join('\n').length + (first.startLine > 0 ? 1 : 0);
    return finishEdit({ abs, name, before: content, updated: lines.join('\n'), eol, bom, replaced: fuzzy.count, at: offset, length: first.replacement.length, how: ` (matched ${fuzzy.how})`, changed });
  }
  if (count > 1 && !input.replace_all) {
    const lineNos: number[] = [];
    for (let i = content.indexOf(oldString); i >= 0 && lineNos.length < 8; i = content.indexOf(oldString, i + oldString.length)) {
      lineNos.push(content.slice(0, i).split('\n').length);
    }
    return {
      error:
        `old_string appears ${count} times in ${name} (lines ${lineNos.join(', ')}). ` +
        'Add surrounding lines to make it unique, or set replace_all to true.' +
        (changed ? ' The file also changed on disk since you last read it, so Read it again to see what is there now.' : ''),
    };
  }

  const firstIndex = content.indexOf(oldString);
  const updated = input.replace_all
    ? content.split(oldString).join(newString)
    : content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length);
  return finishEdit({ abs, name, before: content, updated, eol, bom, replaced: input.replace_all ? count : 1, at: firstIndex, length: newString.length, how: '', changed });
}

interface EditOutcome {
  abs: string;
  name: string;
  before: string;
  updated: string;
  eol: string;
  /** The file's byte-order mark, or '' when it has none. */
  bom: string;
  replaced: number;
  /** Where the (first) replacement starts in `updated`, and how long it is. */
  at: number;
  length: number;
  /** How a whitespace-tolerant match was made, for the summary. */
  how: string;
  /** The file was edited although it had changed since the model read it. */
  changed: boolean;
}

function finishEdit(e: EditOutcome): EditPlan {
  const count = `${plural(e.replaced, 'occurrence')}${e.how}`;
  const outside = e.changed
    ? `Note: ${e.name} had changed on disk since you last read it. old_string still matched it exactly, so the edit was applied; Read the file again if you need to see what else is different. `
    : '';
  return {
    abs: e.abs,
    before: e.before,
    after: e.updated,
    output: e.bom + (e.eol === '\r\n' ? e.updated.replace(/\n/g, '\r\n') : e.updated),
    summary: `Replaced ${count}`,
    message: `Edited ${e.name}: replaced ${count}. ${outside}The file now reads:\n` + snippetAround(e.updated, e.at, e.length),
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
    recordRead(ctx, absPath, buf.length > maxChars, buf);
    const text = buf.toString('utf8');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated, ${text.length - maxChars} more characters]` : text;
  } catch {
    return null;
  }
}
