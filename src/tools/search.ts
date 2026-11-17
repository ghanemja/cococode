/**
 * File discovery and content search shared by Glob, Grep and @-mention
 * completion. Uses ripgrep when it is installed and a pure JS walker when
 * it is not, so the tools work on a bare machine.
 *
 * Both paths are meant to return the same results: hidden files included,
 * .gitignore files honoured (the search root's, its parents' and nested
 * ones), symlinks not followed, and VCS/dependency directories skipped.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { globToRegExp } from '../permissions/rules.ts';
import { looksBinary } from './fsutil.ts';

let rgPath: string | null | undefined;

export function findRipgrep(): string | null {
  if (rgPath !== undefined) return rgPath;
  if (process.env.COCO_NO_RG) return (rgPath = null);
  const probe = spawnSync('rg', ['--version'], { stdio: 'ignore' });
  rgPath = probe.status === 0 ? 'rg' : null;
  return rgPath;
}

/** For tests: force the JS fallback (null), a specific binary, or re-detect (undefined). */
export function setRipgrep(value: string | null | undefined): void {
  rgPath = value;
}

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', '.DS_Store']);

/**
 * ripgrep arguments that make it see the same files as the built-in walker.
 * The exclusion globs must come after any include glob: the last match wins.
 */
const RG_BASE = ['--hidden', '--no-require-git', '--no-ignore-global', '--no-ignore-exclude', '--no-ignore-dot', '--no-messages', '--crlf'];

function rgExclusions(): string[] {
  return [...ALWAYS_SKIP].flatMap((name) => ['--glob', `!**/${name}`, '--glob', `!**/${name}/**`]);
}

/** Order paths the way a sorted depth-first walk visits them (and `rg --sort path` prints them). */
export function comparePaths(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

const MAX_LINE = 400;

function clipLine(line: string): string {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} [... omitted end of long line]` : line;
}

// ------------------------------------------------------------------ ignore files

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

interface IgnoreFile {
  /** Directory the patterns are relative to. */
  dir: string;
  rules: IgnoreRule[];
}

const ignoreCache = new Map<string, { mtimeMs: number; file: IgnoreFile | null }>();

/** Enough of .gitignore to keep build output and dependencies out of results. */
function loadIgnoreFile(dir: string): IgnoreFile | null {
  const file = path.join(dir, '.gitignore');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const cached = ignoreCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.file;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const rules: IgnoreRule[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    try {
      rules.push({ re: globToRegExp(anchored ? line : `**/${line}`), negate, dirOnly });
    } catch {
      // skip patterns we cannot translate
    }
  }
  const loaded = rules.length ? { dir, rules } : null;
  if (ignoreCache.size > 500) ignoreCache.clear();
  ignoreCache.set(file, { mtimeMs, file: loaded });
  return loaded;
}

/** .gitignore files above `root`, outermost first. */
function ancestorIgnores(root: string): IgnoreFile[] {
  const out: IgnoreFile[] = [];
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    const file = loadIgnoreFile(dir);
    if (file) out.unshift(file);
    if (path.dirname(dir) === dir) break;
  }
  return out;
}

/** Later (deeper) files and later rules win, as in git. */
function ignoredBy(files: IgnoreFile[], abs: string, isDir: boolean): boolean {
  let ignored = false;
  for (const file of files) {
    const rel = path.relative(file.dir, abs).split(path.sep).join('/');
    if (rel === '' || rel.startsWith('../') || rel === '..') continue;
    for (const rule of file.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(rel)) ignored = !rule.negate;
    }
  }
  return ignored;
}

/**
 * Is `rel` (below `root`) excluded by a .gitignore? A file inside an ignored
 * directory is ignored whatever else matches it.
 */
function isPathIgnored(root: string, rel: string, base: IgnoreFile[]): boolean {
  const parts = rel.split('/');
  const files = [...base];
  let dir = root;
  const here = loadIgnoreFile(root);
  if (here) files.push(here);
  for (let i = 0; i < parts.length; i++) {
    const abs = path.join(dir, parts[i]!);
    const isDir = i < parts.length - 1;
    if (ALWAYS_SKIP.has(parts[i]!) || ignoredBy(files, abs, isDir)) return true;
    if (isDir) {
      const nested = loadIgnoreFile(abs);
      if (nested) files.push(nested);
      dir = abs;
    }
  }
  return false;
}

export interface WalkOptions {
  signal?: AbortSignal;
  /** Stop after this many files. */
  limit?: number;
  respectIgnore?: boolean;
}

/** Sorted depth-first walk yielding paths relative to `root`, using forward slashes. */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const out: string[] = [];
  const limit = opts.limit ?? 50_000;
  const respect = opts.respectIgnore !== false;
  const visit = (relDir: string, ignores: IgnoreFile[]): void => {
    if (opts.signal?.aborted || out.length >= limit) return;
    const absDir = path.join(root, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    let active = ignores;
    if (respect) {
      const own = loadIgnoreFile(absDir);
      if (own) active = [...ignores, own];
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (ALWAYS_SKIP.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      // Symlinks are not followed (and not listed), as with ripgrep.
      if (entry.isDirectory()) {
        if (!ignoredBy(active, abs, true)) visit(rel, active);
      } else if (entry.isFile()) {
        if (!ignoredBy(active, abs, false)) out.push(rel);
      }
    }
  };
  visit('', respect ? ancestorIgnores(root) : []);
  return out;
}

function runRg(args: string[], cwd: string, signal?: AbortSignal, maxBytes = 2_000_000): Promise<{ stdout: string; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(findRipgrep()!, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxBytes) stdout += d.toString('utf8');
      else proc.kill('SIGKILL');
    });
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, code, stderr });
    };
    proc.on('error', () => done(2));
    proc.on('close', done);
  });
}

function sortByMtime(root: string, files: string[]): string[] {
  const withTime = files.map((f) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(root, f)).mtimeMs;
    } catch {
      // deleted between listing and stat
    }
    return { f, mtime };
  });
  withTime.sort((a, b) => b.mtime - a.mtime || comparePaths(a.f, b.f));
  return withTime.map((x) => x.f);
}

/** Every file below `root` that is not ignored, in path order. */
async function listFiles(root: string, signal?: AbortSignal, limit = 200_000): Promise<string[]> {
  if (findRipgrep()) {
    const res = await runRg([...RG_BASE, '--files', ...rgExclusions()], root, signal, 64_000_000);
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((f) => f.split(path.sep).join('/').replace(/^\.\//, ''))
      .sort(comparePaths)
      .slice(0, limit);
  }
  return walkFiles(root, { signal, limit });
}

/** A file-name pattern as a matcher: "*.ts" means any depth, the way people use it. */
function globMatcher(pattern: string): RegExp {
  const clean = pattern.replace(/^\.\//, '');
  return globToRegExp(clean.includes('/') ? clean : `**/${clean}`);
}

/** Files under `root` matching a glob, most recently modified first. */
export async function globFiles(root: string, pattern: string, signal?: AbortSignal): Promise<string[]> {
  // The listing is filtered here rather than by ripgrep, whose --glob would
  // override .gitignore for the files it names.
  const re = globMatcher(pattern);
  const files = (await listFiles(root, signal)).filter((f) => re.test(f));
  return sortByMtime(root, files);
}

export interface GrepOptions {
  pattern: string;
  root: string;
  /** Restrict to files matching this glob. */
  glob?: string;
  mode: 'files_with_matches' | 'content' | 'count';
  caseInsensitive?: boolean;
  context?: number;
  /** Let a match span lines. */
  multiline?: boolean;
  /** With multiline: `.` also matches newlines. Defaults to the value of `multiline`. */
  dotAll?: boolean;
  signal?: AbortSignal;
}

export interface GrepResult {
  lines: string[];
  /** Directory the paths in `lines` are relative to. */
  base: string;
  error?: string;
}

/** Parse ripgrep's --null output into the plain `path:line:text` forms, dropping ignored files. */
function parseRgOutput(stdout: string, mode: GrepOptions['mode'], keep: (file: string) => boolean): string[] {
  if (mode === 'files_with_matches') {
    return stdout
      .split('\0')
      .map((f) => f.replace(/^\n/, '').replace(/^\.\//, ''))
      .filter((f) => f !== '' && keep(f));
  }
  const out: string[] = [];
  let pendingSeparator = false;
  for (const line of stdout.split('\n')) {
    const raw = line.replace(/\r$/, ''); // CRLF files: the carriage return is not content
    if (raw === '') continue;
    if (raw === '--') {
      pendingSeparator = out.length > 0;
      continue;
    }
    const nul = raw.indexOf('\0');
    if (nul < 0) continue;
    const file = raw.slice(0, nul).replace(/^\.\//, '');
    if (!keep(file)) continue;
    if (pendingSeparator) out.push('--');
    pendingSeparator = false;
    const rest = raw.slice(nul + 1);
    // Count mode prints "count"; content mode prints "12:text" or "12-text".
    out.push(mode === 'count' ? `${file}:${rest}` : `${file}${/^\d+-/.test(rest) ? '-' : ':'}${rest}`);
  }
  return out;
}

export async function grepFiles(opts: GrepOptions): Promise<GrepResult> {
  let cwd = opts.root;
  let single: string | undefined;
  try {
    if (fs.statSync(opts.root).isFile()) {
      single = path.basename(opts.root);
      cwd = path.dirname(opts.root);
    }
  } catch {
    return { lines: [], base: cwd, error: `Path does not exist: ${opts.root}` };
  }
  const ctx = opts.mode === 'content' ? (opts.context ?? 0) : 0;

  if (findRipgrep()) {
    const args = [...RG_BASE, '--null', '--max-columns', String(MAX_LINE), '--max-columns-preview', '--no-heading', '--with-filename', '--color', 'never'];
    if (opts.mode === 'files_with_matches') args.push('-l');
    else if (opts.mode === 'count') args.push('-c', '--sort', 'path');
    else {
      args.push('-n', '--sort', 'path');
      if (ctx) args.push('-C', String(ctx));
    }
    if (opts.caseInsensitive) args.push('-i');
    if (opts.multiline) args.push('-U');
    if (opts.multiline && (opts.dotAll ?? true)) args.push('--multiline-dotall');
    if (opts.glob && !single) args.push('--glob', opts.glob);
    args.push(...rgExclusions(), '-e', opts.pattern, '--', single ?? '.');
    const res = await runRg(args, cwd, opts.signal);
    if (res.code !== null && res.code > 1) {
      // --no-messages hides per-file noise; ask again without it to learn what is wrong with the pattern.
      const loud = await runRg(args.filter((a) => a !== '--no-messages'), cwd, opts.signal);
      const message = loud.stderr.trim().split('\n').slice(0, 6).join('\n') || 'ripgrep failed';
      return { lines: [], base: cwd, error: /regex parse error|error parsing/i.test(message) ? `Invalid regular expression: ${message}` : message };
    }
    // An explicit --glob makes ripgrep search ignored files it names; take those out again.
    const base = opts.glob && !single ? ancestorIgnores(cwd) : null;
    const lines = parseRgOutput(res.stdout, opts.mode, (file) => base === null || !isPathIgnored(cwd, file, base));
    return { lines: opts.mode === 'files_with_matches' ? sortByMtime(cwd, lines) : lines, base: cwd };
  }

  // Built-in search
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, `${opts.caseInsensitive ? 'i' : ''}${opts.multiline ? ((opts.dotAll ?? true) ? 'gms' : 'gm') : ''}`);
  } catch (err) {
    const message = (err as Error).message;
    return { lines: [], base: cwd, error: message.startsWith('Invalid regular expression') ? message : `Invalid regular expression: ${message}` };
  }
  const globRe = opts.glob ? globMatcher(opts.glob) : null;
  const files = single ? [single] : walkFiles(cwd, { signal: opts.signal }).filter((f) => !globRe || globRe.test(f));
  const lines: string[] = [];
  for (const rel of files) {
    if (opts.signal?.aborted || lines.length > 5000) break;
    let buf: Buffer;
    try {
      const abs = path.join(cwd, rel);
      if (fs.statSync(abs).size > 2_000_000) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const text = buf.toString('utf8');
    const fileLines = text.split('\n');
    if (fileLines[fileLines.length - 1] === '') fileLines.pop(); // the final newline does not start a line

    // Line numbers (0-based) that take part in a match.
    const hits = new Set<number>();
    let matches = 0;
    if (opts.multiline) {
      for (const m of text.matchAll(re)) {
        matches++;
        const first = text.slice(0, m.index).split('\n').length - 1;
        const span = m[0].replace(/\n$/, '').split('\n').length;
        for (let i = first; i < first + span && i < fileLines.length; i++) hits.add(i);
      }
    } else {
      for (let i = 0; i < fileLines.length; i++) if (re.test(fileLines[i]!.replace(/\r$/, ''))) hits.add(i);
    }
    if (hits.size === 0) continue;
    if (opts.mode === 'files_with_matches') {
      lines.push(rel);
      continue;
    }
    if (opts.mode === 'count') {
      // Matching lines, or whole matches when a match can span lines (as ripgrep counts).
      lines.push(`${rel}:${opts.multiline ? matches : hits.size}`);
      continue;
    }
    let last = -2;
    for (let i = 0; i < fileLines.length; i++) {
      let near = hits.has(i);
      for (let d = 1; !near && d <= ctx; d++) near = hits.has(i - d) || hits.has(i + d);
      if (!near) continue;
      // Like grep: "--" between groups of lines that are not adjacent.
      if (ctx > 0 && lines.length > 0 && i !== last + 1) lines.push('--');
      last = i;
      const sep = hits.has(i) ? ':' : '-';
      lines.push(`${rel}${sep}${i + 1}${sep}${clipLine(fileLines[i]!.replace(/\r$/, ''))}`);
    }
  }
  if (opts.mode === 'files_with_matches') return { lines: sortByMtime(cwd, lines), base: cwd };
  return { lines, base: cwd };
}

/** Project files for @-mention completion (cached briefly by the caller). */
export async function listProjectFiles(root: string, limit = 20_000): Promise<string[]> {
  return listFiles(root, undefined, limit);
}
