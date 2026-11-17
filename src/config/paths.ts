import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Name of the per-project config directory and of the memory file. */
export const PROJECT_DIR = '.coco';
export const MEMORY_FILE = 'COCO.md';
export const LOCAL_MEMORY_FILE = 'COCO.local.md';

/** User-level config directory (~/.coco unless COCO_CONFIG_DIR is set). */
export function configDir(): string {
  return process.env.COCO_CONFIG_DIR || path.join(os.homedir(), PROJECT_DIR);
}

/** Claude Code's user directory, read for compatibility (~/.claude unless CLAUDE_CONFIG_DIR is set). */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Stable, filesystem-safe name for a working directory. The readable part
 * alone is ambiguous ("/a/b-c" and "/a/b/c" flatten to the same text), so a
 * short hash of the path keeps two projects from sharing their sessions.
 */
export function projectSlug(cwd: string): string {
  const abs = path.resolve(cwd);
  const readable = abs.replace(/[^a-zA-Z0-9]/g, '-').slice(-150);
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return `${readable}-${hash}`;
}

/** Where transcripts for a given working directory live. */
export function sessionsDir(cwd: string): string {
  return path.join(configDir(), 'projects', projectSlug(cwd));
}

export function fileHistoryDir(sessionId: string): string {
  return path.join(configDir(), 'file-history', sessionId);
}

/** Where tool output too large for the context is kept so the model can search it. */
export function toolResultsDir(sessionId: string): string {
  return path.join(configDir(), 'tool-results', sessionId);
}

/**
 * Nearest ancestor that looks like a project root (has .git or .coco).
 * Falls back to the directory itself.
 */
export function findProjectRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  const home = os.homedir();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (dir !== home && fs.existsSync(path.join(dir, PROJECT_DIR, 'settings.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

/**
 * Project-level directories searched for commands, agents, skills and output
 * styles. `.claude` is included so an existing Claude Code setup keeps working.
 */
export function projectConfigDirs(root: string, claudeCompat: boolean): string[] {
  const dirs = [path.join(root, PROJECT_DIR)];
  if (claudeCompat) dirs.push(path.join(root, '.claude'));
  return dirs;
}

export function userConfigDirs(claudeCompat: boolean): string[] {
  const dirs = [configDir()];
  if (claudeCompat) dirs.push(claudeDir());
  return dirs;
}

/** Shorten a path for display: relative to cwd when inside it, ~ for home. */
export function displayPath(p: string, cwd: string): string {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel === '') return '.';
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (!outside) return rel;
  const home = os.homedir();
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep)) return '~' + abs.slice(home.length);
  return abs;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function readJsonFile<T>(file: string): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  // An empty file (freshly created, or truncated) holds no settings; it is not an error.
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
