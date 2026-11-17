/**
 * File discovery and content search shared by Glob, Grep and @-mention
 * completion. Uses ripgrep when it is installed and a pure JS walker when
 * it is not, so the tools work on a bare machine.
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

/** For tests: force the JS fallback or re-detect. */
export function setRipgrep(value: string | null | undefined): void {
  rgPath = value;
}

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', '.DS_Store']);

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** Enough of .gitignore to keep build output and dependencies out of results. */
function loadIgnoreRules(root: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return rules;
  }
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    line = line.replace(/^\//, '');
    const glob = anchored ? line : `**/${line}`;
    try {
      rules.push({ re: globToRegExp(glob), negate, dirOnly });
    } catch {
      // skip patterns we cannot translate
    }
  }
  return rules;
}

function isIgnored(rel: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.re.test(rel)) ignored = !rule.negate;
  }
  return ignored;
}

export interface WalkOptions {
  signal?: AbortSignal;
  /** Stop after this many files. */
  limit?: number;
  respectIgnore?: boolean;
}

/** Depth-first walk yielding paths relative to `root`, using forward slashes. */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const out: string[] = [];
  const limit = opts.limit ?? 50_000;
  const rules = opts.respectIgnore === false ? [] : loadIgnoreRules(root);
  const stack: string[] = [''];
  while (stack.length) {
    if (opts.signal?.aborted || out.length >= limit) break;
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1)); // reversed: the stack pops in order
    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isIgnored(rel, true, rules)) stack.push(rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!isIgnored(rel, false, rules)) out.push(rel);
        if (out.length >= limit) break;
      }
    }
  }
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
  withTime.sort((a, b) => b.mtime - a.mtime || a.f.localeCompare(b.f));
  return withTime.map((x) => x.f);
}

/** Files under `root` matching a glob, most recently modified first. */
export async function globFiles(root: string, pattern: string, signal?: AbortSignal): Promise<string[]> {
  // "*.ts" means any depth, the way people use it.
  const effective = pattern.includes('/') ? pattern : `**/${pattern}`;
  let files: string[];
  if (findRipgrep()) {
    const res = await runRg(['--files', '--hidden', '--glob', '!.git', '--glob', effective], root, signal);
    files = res.stdout.split('\n').filter(Boolean).map((f) => f.split(path.sep).join('/'));
  } else {
    const re = globToRegExp(effective.replace(/^\.\//, ''));
    files = walkFiles(root, { signal }).filter((f) => re.test(f));
  }
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
  multiline?: boolean;
  signal?: AbortSignal;
}

export interface GrepResult {
  lines: string[];
  error?: string;
}

export async function grepFiles(opts: GrepOptions): Promise<GrepResult> {
  let target = opts.root;
  let cwd = opts.root;
  let single: string | undefined;
  try {
    if (fs.statSync(opts.root).isFile()) {
      single = path.basename(opts.root);
      cwd = path.dirname(opts.root);
      target = single;
    }
  } catch {
    return { lines: [], error: `Path does not exist: ${opts.root}` };
  }

  if (findRipgrep()) {
    const args = ['--hidden', '--glob', '!.git', '--max-columns', '400', '--max-columns-preview', '--no-heading', '--color', 'never'];
    if (opts.mode === 'files_with_matches') args.push('-l', '--sortr', 'modified');
    else if (opts.mode === 'count') args.push('-c');
    else {
      args.push('-n', '--with-filename');
      if (opts.context) args.push('-C', String(opts.context));
    }
    if (opts.caseInsensitive) args.push('-i');
    if (opts.multiline) args.push('-U', '--multiline-dotall');
    if (opts.glob) args.push('--glob', opts.glob);
    args.push('-e', opts.pattern, '--', single ?? '.');
    const res = await runRg(args, cwd, opts.signal);
    if (res.code !== null && res.code > 1) {
      return { lines: [], error: res.stderr.trim().split('\n')[0] || 'ripgrep failed' };
    }
    return { lines: res.stdout.split('\n').filter((l) => l !== '').map((l) => l.replace(/^\.\//, '')) };
  }

  // JS fallback
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, `${opts.caseInsensitive ? 'i' : ''}${opts.multiline ? 'gms' : ''}`);
  } catch (err) {
    return { lines: [], error: `Invalid regular expression: ${(err as Error).message}` };
  }
  const globRe = opts.glob ? globToRegExp(opts.glob.includes('/') ? opts.glob : `**/${opts.glob}`) : null;
  const files = single ? [single] : walkFiles(cwd, { signal: opts.signal }).filter((f) => !globRe || globRe.test(f));
  const lines: string[] = [];
  const ctx = opts.context ?? 0;
  void target;
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
    if (opts.multiline) {
      const matches = [...text.matchAll(re)];
      if (!matches.length) continue;
      if (opts.mode === 'files_with_matches') lines.push(rel);
      else if (opts.mode === 'count') lines.push(`${rel}:${matches.length}`);
      else {
        for (const m of matches) {
          const lineNo = text.slice(0, m.index).split('\n').length;
          lines.push(`${rel}:${lineNo}:${m[0].split('\n')[0]!.slice(0, 400)}`);
        }
      }
      continue;
    }
    const fileLines = text.split('\n');
    const hits: number[] = [];
    for (let i = 0; i < fileLines.length; i++) if (re.test(fileLines[i]!)) hits.push(i);
    if (!hits.length) continue;
    if (opts.mode === 'files_with_matches') lines.push(rel);
    else if (opts.mode === 'count') lines.push(`${rel}:${hits.length}`);
    else {
      const shown = new Set<number>();
      let last = -2;
      for (const h of hits) {
        for (let i = Math.max(0, h - ctx); i <= Math.min(fileLines.length - 1, h + ctx); i++) {
          if (shown.has(i)) continue;
          if (ctx > 0 && last >= 0 && i > last + 1) lines.push('--');
          shown.add(i);
          last = i;
          const sep = hits.includes(i) ? ':' : '-';
          lines.push(`${rel}${sep}${i + 1}${sep}${fileLines[i]!.slice(0, 400)}`);
        }
      }
    }
  }
  if (opts.mode === 'files_with_matches') return { lines: sortByMtime(cwd, lines) };
  return { lines };
}

/** Project files for @-mention completion (cached briefly by the caller). */
export async function listProjectFiles(root: string, limit = 20_000): Promise<string[]> {
  if (findRipgrep()) {
    const res = await runRg(['--files', '--hidden', '--glob', '!.git'], root, undefined, 4_000_000);
    return res.stdout.split('\n').filter(Boolean).slice(0, limit);
  }
  return walkFiles(root, { limit });
}
