import * as fs from 'node:fs';
import * as path from 'node:path';
import { toolResultsDir } from '../config/paths.ts';
import { clampOutput } from './shell.ts';

/**
 * Keep an oversized tool result usable. The model gets the head and tail in
 * context; the whole thing is saved to a file it can Grep or Read in pieces,
 * so it does not have to run the command again to see the middle.
 */
export function spillOutput(sessionId: string, callId: string, content: string, max: number): string {
  if (content.length <= max) return content;
  let saved: string | undefined;
  try {
    const dir = toolResultsDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    saved = path.join(dir, `${callId.replace(/[^A-Za-z0-9_-]/g, '_') || 'output'}.txt`);
    fs.writeFileSync(saved, content);
  } catch {
    saved = undefined; // a read-only config directory: fall back to plain truncation
  }
  const clamped = clampOutput(content, max);
  if (!saved) return clamped;
  return (
    `${clamped}\n\n[The output was ${content.length} characters, so the middle is omitted above. ` +
    `All of it is saved at ${saved}. Use Grep on that file to find what you need, or Read it with offset and limit.]`
  );
}
