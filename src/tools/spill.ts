import * as fs from 'node:fs';
import * as path from 'node:path';
import { toolResultsDir } from '../config/paths.ts';
import { clampOutput } from './shell.ts';

/** How much of an oversized successful result is shown from its start. */
const PREVIEW_HEAD = 2000;
/** How much is shown from its end, where commands put their summary. */
const PREVIEW_TAIL = 500;
/** Most of a failed result that is shown: its beginning and end, which is where the error is. */
const FAILED_EXCERPT = 10_000;

export interface SpillOptions {
  /**
   * The result is of a failed call (a non-zero exit, a timeout, an interrupt).
   * Its head and tail are kept inline, more generously than for a success,
   * because the text itself is what has to be acted on.
   */
  failed?: boolean;
}

/** Where the full text of an oversized result of this call is kept. */
function savedPath(sessionId: string, callId: string): string {
  return path.join(toolResultsDir(sessionId), `${callId.replace(/[^A-Za-z0-9_-]/g, '_') || 'output'}.txt`);
}

function countLines(text: string): number {
  let breaks = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) breaks++;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** The start of the text, ended at a line break when one is close to the cut. */
function headOf(content: string, max: number): string {
  const head = content.slice(0, max);
  const lineEnd = head.lastIndexOf('\n');
  return lineEnd >= max * 0.75 ? head.slice(0, lineEnd) : head;
}

/** The last whole lines that fit in `max` characters (or the last `max` characters of one long line). */
function tailOf(content: string, max: number): string {
  if (max <= 0) return '';
  const tail = content.slice(-max);
  const lineStart = tail.indexOf('\n');
  // The first line of the slice is usually cut off in the middle: leave it out.
  return lineStart >= 0 && lineStart < tail.length - 1 ? tail.slice(lineStart + 1) : tail;
}

/** The head and tail of the text with the marker for what is missing between them: `max` characters at most, all told. */
function excerptOf(content: string, max: number): string {
  const marker = `\n\n... [${content.length} characters truncated] ...\n\n`.length;
  return clampOutput(content, Math.max(0, max - marker));
}

/**
 * Keep an oversized tool result usable. Text within `max` characters is
 * returned as it is. Beyond that the whole text is saved to a file the model
 * can Grep or Read in pieces, so it need not run the command again, and the
 * context gets only a short view of it: for a success the first 2,000
 * characters and the last few lines, for a failure its head and tail up to
 * 10,000 characters. If the file cannot be written the text is simply cut to
 * `max`.
 */
export function spillOutput(sessionId: string, callId: string, content: string, max: number, options: SpillOptions = {}): string {
  if (content.length <= max) return content;
  const file = savedPath(sessionId, callId);
  // A result that already went through here for this call carries its own note; trimming it
  // again would save the trimmed text over the full one.
  if (content.includes(`All of it is saved at ${file}.`)) return content;
  let saved = true;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  } catch {
    saved = false; // a read-only config directory: fall back to plain truncation
  }
  if (!saved) return clampOutput(content, max);

  const lines = countLines(content);
  let shown: string;
  let what: string;
  if (options.failed) {
    shown = excerptOf(content, Math.min(max, FAILED_EXCERPT));
    what = 'only its beginning and end are shown above';
  } else {
    const tailMax = Math.min(PREVIEW_TAIL, Math.floor(max * 0.2));
    const head = headOf(content, Math.min(PREVIEW_HEAD, max - tailMax));
    const tail = tailOf(content, tailMax);
    const omitted = content.length - head.length - tail.length;
    shown = `${head}\n\n... [${omitted} characters truncated] ...\n\n${tail}`;
    const tailLines = countLines(tail);
    what = `only its first ${head.length} characters and its last ${tailLines === 1 ? 'line' : `${tailLines} lines`} are shown above`;
  }
  return (
    `${shown}\n\n[The output was ${content.length} characters (${lines} line${lines === 1 ? '' : 's'}), so ${what}. ` +
    `All of it is saved at ${file}. Use Grep on that file to find what you need, or Read it with offset and limit.]`
  );
}
