import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { displayPath, expandHome } from '../config/paths.ts';
import type { ReadRecord } from '../session/state.ts';
import type { PermissionRequest, ToolContext } from './types.ts';

/** Files larger than this are not hashed; their modification time and size decide whether they changed. */
export const MAX_HASH_BYTES = 16 * 1024 * 1024;

/** Resolve a model-supplied path against the session's working directory. */
export function resolvePath(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.cwd, expandHome(String(p).trim()));
}

export function shortPath(ctx: ToolContext, p: string): string {
  return displayPath(p, ctx.cwd);
}

export function hashContent(content: Uint8Array): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Describe a file as the model has just seen it. Pass the bytes that were
 * shown when they are at hand, so the record is of exactly that content.
 */
export function makeReadRecord(absPath: string, partial = false, content?: Uint8Array): ReadRecord {
  const stat = fs.statSync(absPath);
  const record: ReadRecord = { mtimeMs: stat.mtimeMs, partial, size: content ? content.length : stat.size };
  if (record.size! > MAX_HASH_BYTES) return record;
  try {
    record.hash = hashContent(content ?? fs.readFileSync(absPath));
  } catch {
    // unreadable: the modification time is all there is to go on
  }
  return record;
}

/** Remember that the model has seen this file's current content. */
export function recordRead(ctx: ToolContext, absPath: string, partial = false, content?: Uint8Array): void {
  try {
    ctx.session.readFiles.set(absPath, makeReadRecord(absPath, partial, content));
  } catch {
    // file vanished; nothing to record
  }
}

export interface FileCheck {
  /**
   * `new`: nothing is there yet. `unread`: the model has not seen the file.
   * `changed`: its content is not what the model saw. `fresh`: it is.
   */
  state: 'new' | 'directory' | 'unread' | 'changed' | 'fresh';
  /** Why the file must not be modified as it stands; absent for `new` and `fresh`. */
  message?: string;
}

/**
 * Compare a file with what the model last saw of it. Content decides, not the
 * timestamp: a formatter, `touch` or a checkout that rewrites the same bytes
 * leaves the file fresh, and a change that kept the modification time is
 * still caught. `content` is the file's current bytes when the caller already
 * has them.
 */
export function examineFile(ctx: ToolContext, absPath: string, content?: Uint8Array): FileCheck {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { state: 'new' };
  }
  if (stat.isDirectory()) return { state: 'directory', message: `${absPath} is a directory.` };
  const name = shortPath(ctx, absPath);
  const record = ctx.session.readFiles.get(absPath);
  if (!record) {
    return { state: 'unread', message: `You must Read ${name} before changing it, so the edit is based on its current content.` };
  }
  const changed: FileCheck = { state: 'changed', message: `${name} changed on disk since you last read it. Read it again before editing.` };
  const size = content ? content.length : stat.size;
  if (record.size !== undefined && record.size !== size) return changed;
  if (record.hash === undefined) {
    // Too large to hash, or recorded without one: fall back to the modification time.
    return Math.abs(stat.mtimeMs - record.mtimeMs) > 1 ? changed : { state: 'fresh' };
  }
  try {
    return hashContent(content ?? fs.readFileSync(absPath)) === record.hash ? { state: 'fresh' } : changed;
  } catch {
    return changed; // unreadable now, so certainly not known to be what was read
  }
}

/**
 * Guard for replacing an existing file wholesale: the model must have read it,
 * and its content must not have changed since. Returns an error message, or null.
 */
export function checkFresh(ctx: ToolContext, absPath: string): string | null {
  return examineFile(ctx, absPath).message ?? null;
}

/** Save a checkpoint of the file before a tool modifies it. */
export function beforeWrite(ctx: ToolContext, absPath: string): void {
  ctx.session.checkpoints.track(absPath, ctx.session.turn);
}

/** Write a file, creating parent directories, and mark it as read. */
export function writeFileTracked(ctx: ToolContext, absPath: string, content: string): void {
  beforeWrite(ctx, absPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const bytes = Buffer.from(content, 'utf8');
  fs.writeFileSync(absPath, bytes);
  recordRead(ctx, absPath, false, bytes);
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

/**
 * Decode bytes as UTF-8, or return null when they are not valid UTF-8.
 * Nothing is replaced, so text that decodes can be written back unchanged; a
 * byte-order mark is kept as the first character.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** True for UTF-16 text: its byte-order mark, or a zero in every other byte as plain ASCII has in that encoding. */
export function looksUtf16(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return true;
  const len = Math.min(bytes.length, 8000) & ~1;
  if (len < 4) return false;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < len; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  const pairs = len / 2;
  return (odd > pairs * 0.6 && even < pairs * 0.1) || (even > pairs * 0.6 && odd < pairs * 0.1);
}

/**
 * Why Edit must leave a file alone because of its encoding, or null for
 * UTF-8 text. Decoding anything else replaces the bytes that do not fit, and
 * writing the result back would corrupt the file.
 */
export function encodingProblem(bytes: Uint8Array): string | null {
  if (looksUtf16(bytes)) return 'is UTF-16 text, not UTF-8';
  if (decodeUtf8(bytes) !== null) return null;
  return bytes.includes(0) ? 'is binary data, not UTF-8 text' : 'is not valid UTF-8 (it is probably Latin-1, Windows-1252 or another legacy encoding)';
}

/** Preserve the file's line-ending style when writing edited content. */
export function detectEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}
