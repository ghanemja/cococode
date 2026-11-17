/**
 * Debug log (`--debug`, `--debug-file`). When a local model misbehaves the
 * useful question is "what exactly was sent and what came back", so the log
 * records requests, responses, tool calls and retries, one line each.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

let sink: ((line: string) => void) | null = null;
let filter: string[] | null = null;

export function debugEnabled(): boolean {
  return sink !== null;
}

/** Start logging to a file, or to stderr when no file is given. `categories` limits what is logged ("api,tools"). */
export function enableDebug(file?: string, categories?: string): string | undefined {
  filter = categories ? categories.split(',').map((c) => c.trim()).filter(Boolean) : null;
  if (!file) {
    sink = (line) => process.stderr.write(`${line}\n`);
    return undefined;
  }
  const target = path.resolve(file);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, '');
  } catch {
    sink = (line) => process.stderr.write(`${line}\n`);
    return undefined;
  }
  sink = (line) => {
    try {
      fs.appendFileSync(target, `${line}\n`);
    } catch {
      // a full disk must not take the session down with it
    }
  };
  return target;
}

export function disableDebug(): void {
  sink = null;
  filter = null;
}

function compact(value: unknown, limit: number): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit)}… [+${text.length - limit} chars]` : text;
}

/** Record one event. `data` is serialised and cut to `limit` characters. */
export function debug(category: string, message: string, data?: unknown, limit = 4000): void {
  if (!sink) return;
  if (filter && !filter.includes(category)) return;
  const stamp = new Date().toISOString();
  sink(`${stamp} [${category}] ${message}${data === undefined ? '' : ` ${compact(data, limit)}`}`);
}
