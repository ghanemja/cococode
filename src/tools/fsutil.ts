import * as fs from 'node:fs';
import * as path from 'node:path';
import { displayPath, expandHome } from '../config/paths.ts';
import type { PermissionRequest, ToolContext } from './types.ts';

/** Resolve a model-supplied path against the session's working directory. */
export function resolvePath(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.cwd, expandHome(String(p).trim()));
}

export function shortPath(ctx: ToolContext, p: string): string {
  return displayPath(p, ctx.cwd);
}

/** Remember that the model has seen this file's current content. */
export function recordRead(ctx: ToolContext, absPath: string, partial = false): void {
  try {
    ctx.session.readFiles.set(absPath, { mtimeMs: fs.statSync(absPath).mtimeMs, partial });
  } catch {
    // file vanished; nothing to record
  }
}

/**
 * Guard for modifying an existing file: the model must have read it, and it
 * must not have changed on disk since. Returns an error message, or null.
 */
export function checkFresh(ctx: ToolContext, absPath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null; // new file
  }
  if (stat.isDirectory()) return `${absPath} is a directory.`;
  const record = ctx.session.readFiles.get(absPath);
  if (!record) {
    return `You must Read ${shortPath(ctx, absPath)} before changing it, so the edit is based on its current content.`;
  }
  if (stat.mtimeMs > record.mtimeMs + 1) {
    return `${shortPath(ctx, absPath)} changed on disk since you last read it. Read it again before editing.`;
  }
  return null;
}

/** Save a checkpoint of the file before a tool modifies it. */
export function beforeWrite(ctx: ToolContext, absPath: string): void {
  ctx.session.checkpoints.track(absPath, ctx.session.turn);
}

/** Write a file, creating parent directories, and mark it as read. */
export function writeFileTracked(ctx: ToolContext, absPath: string, content: string): void {
  beforeWrite(ctx, absPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
  recordRead(ctx, absPath);
}

export function editPermission(ctx: ToolContext, tool: string, absPath: string, verb = 'Edit'): PermissionRequest {
  return { tool, kind: 'edit', target: absPath, description: `${verb} ${shortPath(ctx, absPath)}` };
}

export function readPermission(ctx: ToolContext, tool: string, absPath: string, verb = 'Read'): PermissionRequest {
  return { tool, kind: 'read', target: absPath, description: `${verb} ${shortPath(ctx, absPath)}` };
}

/** Heuristic binary check on the first chunk of a file. */
export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i]!;
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32 && b !== 27)) suspicious++;
  }
  return len > 0 && suspicious / len > 0.3;
}

/** Preserve the file's line-ending style when writing edited content. */
export function detectEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}
