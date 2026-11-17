import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeDir, configDir, expandHome, findProjectRoot, LOCAL_MEMORY_FILE, MEMORY_FILE, PROJECT_DIR } from '../config/paths.ts';

export type MemoryScope = 'user' | 'project' | 'local';

export interface MemoryFile {
  path: string;
  scope: MemoryScope;
  content: string;
  /** Path of the file that imported this one with @path, if any. */
  importedBy?: string;
}

const MAX_IMPORT_DEPTH = 5;
const MAX_FILE_CHARS = 40_000;

function readText(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const text = fs.readFileSync(file, 'utf8');
    return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n… [truncated]` : text;
  } catch {
    return undefined;
  }
}

/** `@path` references outside code spans and fenced blocks. */
export function findImports(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const withoutCode = line.replace(/`[^`]*`/g, '');
    const re = /(?:^|[\s(])@((?:~\/|\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)*)/g;
    for (let m = re.exec(withoutCode); m; m = re.exec(withoutCode)) {
      // A full stop after the path ends the sentence; it is not part of the name.
      const ref = m[1]!.replace(/\.+$/, '');
      // Require something path-like so "@username" in prose is not an import.
      if (ref.includes('/') || /\.[a-zA-Z0-9]+$/.test(ref)) out.push(ref);
    }
  }
  return out;
}

/** Candidate memory file names for one directory, in load order. */
function candidates(dir: string, claudeCompat: boolean): { file: string; scope: MemoryScope }[] {
  const list: { file: string; scope: MemoryScope }[] = [
    { file: path.join(dir, MEMORY_FILE), scope: 'project' },
    { file: path.join(dir, PROJECT_DIR, MEMORY_FILE), scope: 'project' },
    { file: path.join(dir, 'AGENTS.md'), scope: 'project' },
  ];
  if (claudeCompat) {
    list.push({ file: path.join(dir, 'CLAUDE.md'), scope: 'project' }, { file: path.join(dir, '.claude', 'CLAUDE.md'), scope: 'project' });
  }
  list.push({ file: path.join(dir, LOCAL_MEMORY_FILE), scope: 'local' });
  if (claudeCompat) list.push({ file: path.join(dir, 'CLAUDE.local.md'), scope: 'local' });
  return list;
}

/**
 * Load instruction files: user-level first, then every directory from the
 * project root down to `cwd`, so more specific files come later and win.
 */
export function loadMemory(cwd: string, claudeCompat = true): MemoryFile[] {
  const files: MemoryFile[] = [];
  const seenPaths = new Set<string>();
  const seenContent = new Set<string>();

  const add = (file: string, scope: MemoryScope, depth: number, importedBy?: string) => {
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      return;
    }
    if (seenPaths.has(real)) return;
    const content = readText(real);
    if (content === undefined || content.trim() === '') return;
    seenPaths.add(real);
    // AGENTS.md and CLAUDE.md are often copies of each other.
    if (seenContent.has(content)) return;
    seenContent.add(content);
    files.push({ path: file, scope, content, importedBy });
    if (depth >= MAX_IMPORT_DEPTH) return;
    for (const ref of findImports(content)) {
      const target = path.resolve(path.dirname(real), expandHome(ref));
      add(target, scope, depth + 1, file);
    }
  };

  add(path.join(configDir(), MEMORY_FILE), 'user', 0);
  if (claudeCompat) add(path.join(claudeDir(), 'CLAUDE.md'), 'user', 0);

  const root = findProjectRoot(cwd);
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (dir === root || path.dirname(dir) === dir) break;
  }
  for (const dir of dirs) {
    for (const { file, scope } of candidates(dir, claudeCompat)) add(file, scope, 0);
  }
  return files;
}

export function renderMemory(files: MemoryFile[]): string {
  if (files.length === 0) return '';
  const blocks = files.map((f) => {
    const label = f.scope === 'user' ? 'user instructions' : f.scope === 'local' ? 'local project instructions' : 'project instructions';
    return `<instructions source="${f.path}" kind="${label}">\n${f.content.trim()}\n</instructions>`;
  });
  return [
    '# Instructions from the user',
    'These files were written by the user for you. Follow them; more specific files (later ones) take precedence.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/** Where `#` notes and /memory edits go for each scope. */
export function memoryTargets(cwd: string): Record<MemoryScope, string> {
  const root = findProjectRoot(cwd);
  return {
    user: path.join(configDir(), MEMORY_FILE),
    project: path.join(root, MEMORY_FILE),
    local: path.join(root, LOCAL_MEMORY_FILE),
  };
}

export function appendMemory(file: string, note: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  const line = `- ${note.trim()}`;
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${existing}${sep}${line}\n`);
}
