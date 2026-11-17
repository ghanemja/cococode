import * as fs from 'node:fs';
import * as path from 'node:path';
import { configDir, findProjectRoot, projectSlug } from '../config/paths.ts';
import { stripBom } from '../util/frontmatter.ts';

/** The index file of an auto memory directory. */
export const AUTO_MEMORY_INDEX = 'MEMORY.md';
/** How much of the index is loaded at session start: this many lines or bytes, whichever is reached first. */
export const AUTO_MEMORY_MAX_LINES = 200;
export const AUTO_MEMORY_MAX_BYTES = 25_000;

export interface AutoMemory {
  dir: string;
  /** The loaded part of MEMORY.md; undefined when there is no such file. */
  index?: string;
  /** True when MEMORY.md is longer than what was loaded. */
  truncated: boolean;
}

/** The agent's own notes for a repository. Every directory of the repository shares one. */
export function autoMemoryDir(projectRoot: string): string {
  return path.join(configDir(), 'projects', projectSlug(findProjectRoot(projectRoot)), 'memory');
}

/** The first `maxBytes` bytes of a file as text, never ending inside a character. */
function readHead(file: string, maxBytes: number): { text: string; more: boolean } | undefined {
  let fd: number | undefined;
  try {
    // Checked before opening: opening a pipe would wait for a writer.
    if (!fs.statSync(file).isFile()) return undefined;
    fd = fs.openSync(file, 'r');
    // A few bytes extra show whether the file goes on and where the last character ends.
    const buf = Buffer.alloc(maxBytes + 4);
    let length = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, length, buf.length - length, null);
      if (n === 0) break;
      length += n;
      if (length === buf.length) break;
    }
    if (length <= maxBytes) return { text: buf.toString('utf8', 0, length), more: false };
    let end = maxBytes;
    // Bytes of the form 10xxxxxx continue a character; step back to where it starts.
    while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
    return { text: buf.toString('utf8', 0, end), more: true };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing to do about a failed close
      }
    }
  }
}

/** Read the index of the project's auto memory. Never creates anything. */
export function loadAutoMemory(projectRoot: string): AutoMemory {
  const dir = autoMemoryDir(projectRoot);
  const head = readHead(path.join(dir, AUTO_MEMORY_INDEX), AUTO_MEMORY_MAX_BYTES);
  if (head === undefined) return { dir, truncated: false };

  let text = stripBom(head.text);
  let truncated = head.more;
  if (head.more) {
    // Drop the line the byte limit cut through, unless it is the only one.
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak >= 0) text = text.slice(0, lastBreak + 1);
  }
  const lines = text.split('\n');
  // A final line break ends the last line; it does not start another.
  const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (count > AUTO_MEMORY_MAX_LINES) {
    text = `${lines.slice(0, AUTO_MEMORY_MAX_LINES).join('\n')}\n`;
    truncated = true;
  }
  return { dir, index: text, truncated };
}

/** System prompt section that tells the model about its memory and shows the current index. */
export function autoMemoryPrompt(mem: AutoMemory): string {
  const index = mem.index?.trim() ?? '';
  const lines = [
    '# Your memory',
    `${mem.dir} holds your own notes about this project. They persist between sessions; read and write them with the file tools.`,
    `${AUTO_MEMORY_INDEX} there is the index, loaded at the start of every session. Keep it short: one line per entry, with the detail in topic files beside it. Read a topic file when its entry is relevant.`,
    'Save a note when you learn something that will still matter in a later session: a durable fact about the project, a preference of the user, or a correction to a mistake you made. Do not save the state of the current task.',
    '',
  ];
  if (index === '') {
    lines.push(`${AUTO_MEMORY_INDEX} is empty: nothing has been saved yet.`);
  } else {
    lines.push(`Current ${AUTO_MEMORY_INDEX}:`, '<memory-index>', index, '</memory-index>');
    if (mem.truncated) {
      lines.push(`Only the first ${AUTO_MEMORY_MAX_LINES} lines or ${AUTO_MEMORY_MAX_BYTES / 1000} KB are loaded and the rest was cut off. Shorten the index.`);
    }
  }
  return lines.join('\n');
}

/**
 * Where `p` leads once every symbolic link on the way is followed, the way
 * the operating system would resolve it. Names that do not exist yet are
 * kept as written. Undefined when a link cannot be followed (it dangles or
 * loops), because then nothing can be said about where a write would land.
 */
function physicalPath(p: string): string | undefined {
  // An absolute path is taken as written: ".." after a link means the parent of where the link leads.
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  const root = path.parse(abs).root;
  const parts = abs.slice(root.length).split(path.sep === '/' ? /\/+/ : /[\\/]+/);
  let cur = root;
  let exists = true;
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      cur = path.dirname(cur);
      exists = true;
      continue;
    }
    const next = path.join(cur, part);
    if (!exists) {
      cur = next;
      continue;
    }
    try {
      cur = fs.realpathSync(next);
    } catch {
      try {
        if (fs.lstatSync(next).isSymbolicLink()) return undefined;
      } catch {
        // not there at all
      }
      exists = false;
      cur = next;
    }
  }
  return cur;
}

/**
 * Is `absPath` the project's auto memory directory or something inside it?
 * Decided on resolved paths, so a link inside the directory that points
 * elsewhere does not count.
 */
export function isAutoMemoryPath(projectRoot: string, absPath: string): boolean {
  try {
    const dir = physicalPath(autoMemoryDir(projectRoot));
    if (dir === undefined) return false;
    // A path with ".." in it is read two ways: as the system resolves it, and
    // as a tool that tidies the path first would. Both must stay inside.
    return [...new Set([absPath, path.resolve(absPath)])].every((spelling) => {
      const target = physicalPath(spelling);
      if (target === undefined) return false;
      const rel = path.relative(dir, target);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    });
  } catch {
    return false;
  }
}
