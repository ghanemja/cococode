import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  claudeDir,
  configDir,
  expandHome,
  findProjectRoot,
  LOCAL_MEMORY_FILE,
  MEMORY_FILE,
  PROJECT_DIR,
  projectConfigDirs,
  userConfigDirs,
} from '../config/paths.ts';
import { globToRegExp } from '../permissions/rules.ts';
import { asList, parseFrontmatter } from '../util/frontmatter.ts';

export type MemoryScope = 'user' | 'project' | 'local';

export interface MemoryFile {
  path: string;
  scope: MemoryScope;
  content: string;
  /** Path of the file that imported this one with @path, if any. */
  importedBy?: string;
  /** For a path-scoped rule: the globs from its `paths` front matter. */
  paths?: string[];
}

const MAX_IMPORT_DEPTH = 5;
const MAX_FILE_CHARS = 40_000;
const RULES_DIR = 'rules';
/** How far below a rules directory topic files are looked for. */
const MAX_RULES_DEPTH = 12;

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

function realPath(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

function toPosix(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
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

/** Every `*.md` below a rules directory, sorted by path. Symlinks are followed; a directory is entered once. */
function ruleFiles(dir: string): string[] {
  const out: string[] = [];
  const entered = new Set<string>();
  const walk = (current: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      const real = fs.realpathSync(current);
      if (entered.has(real)) return;
      entered.add(real);
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (depth < MAX_RULES_DEPTH) walk(full, depth + 1);
      } else if (isFile && /\.md$/i.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function userRuleFiles(claudeCompat: boolean): string[] {
  return userConfigDirs(claudeCompat).flatMap((dir) => ruleFiles(path.join(dir, RULES_DIR)));
}

function projectRuleFiles(root: string, claudeCompat: boolean): string[] {
  return projectConfigDirs(root, claudeCompat).flatMap((dir) => ruleFiles(path.join(dir, RULES_DIR)));
}

/**
 * Does one of a rule's `paths` globs cover `target`, a slash-separated path
 * relative to the project root? A pattern without a slash matches at any
 * depth, and a pattern that names a directory covers what is inside it.
 */
function matchesRulePaths(globs: string[], target: string): boolean {
  return globs.some((raw) => {
    const anchored = /^\.?\//.test(raw);
    let glob = raw.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (glob === '') return false;
    if (!anchored && !glob.includes('/')) glob = `**/${glob}`;
    try {
      return globToRegExp(glob).test(target) || globToRegExp(`${glob}/**`).test(target);
    } catch {
      // A pattern that is not a valid glob matches nothing.
      return false;
    }
  });
}

/** Matcher for `claudeMdExcludes`: globs against the absolute path, or the file name when the pattern has no slash. */
function excludeMatcher(patterns: string[] | undefined): (file: string, real: string) => boolean {
  const tests: ((absPath: string) => boolean)[] = [];
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    let glob = toPosix(expandHome(raw.trim()));
    // "dir/" can never name a file; read it as everything inside that directory.
    if (glob.endsWith('/')) glob += '**';
    let re: RegExp;
    try {
      re = globToRegExp(glob);
    } catch {
      continue;
    }
    tests.push(glob.includes('/') ? (p) => re.test(p) : (p) => re.test(p) || re.test(path.posix.basename(p)));
  }
  if (tests.length === 0) return () => false;
  // The path as it was reached and the path it resolves to both count.
  return (file, real) => [toPosix(path.resolve(file)), toPosix(real)].some((p) => tests.some((matches) => matches(p)));
}

interface Collector {
  files: MemoryFile[];
  /** An instruction file, followed by what it imports. */
  add(file: string, scope: MemoryScope): void;
  /** A rules file. `want` sees its `paths` globs (empty for a rule that always applies) and decides whether it loads now. */
  addRule(file: string, scope: MemoryScope, want: (globs: string[]) => boolean): void;
}

/**
 * Gathers files in the order they are added, each at most once. `seenPaths`
 * holds real paths that were already delivered and receives the new ones.
 */
function createCollector(seenPaths: Set<string>, excludes: string[] | undefined, skipReal?: string): Collector {
  const files: MemoryFile[] = [];
  const seenContent = new Set<string>();
  const excluded = excludeMatcher(excludes);

  /** Real path of a file that may still be loaded. */
  const pending = (file: string): string | undefined => {
    const real = realPath(file);
    if (real === undefined || real === skipReal || seenPaths.has(real) || excluded(file, real)) return undefined;
    return real;
  };

  const take = (entry: MemoryFile, real: string, depth: number): void => {
    seenPaths.add(real);
    // AGENTS.md and CLAUDE.md are often copies of each other.
    if (seenContent.has(entry.content)) return;
    seenContent.add(entry.content);
    files.push(entry);
    if (depth >= MAX_IMPORT_DEPTH) return;
    for (const ref of findImports(entry.content)) {
      addFile(path.resolve(path.dirname(real), expandHome(ref)), entry.scope, depth + 1, entry.path);
    }
  };

  const addFile = (file: string, scope: MemoryScope, depth: number, importedBy?: string): void => {
    const real = pending(file);
    if (real === undefined) return;
    const content = readText(real);
    if (content === undefined || content.trim() === '') return;
    take({ path: file, scope, content, importedBy }, real, depth);
  };

  const addRule = (file: string, scope: MemoryScope, want: (globs: string[]) => boolean): void => {
    const real = pending(file);
    if (real === undefined) return;
    const text = readText(real);
    if (text === undefined) return;
    let body = text;
    let globs: string[] = [];
    try {
      const doc = parseFrontmatter(text);
      body = doc.body;
      globs = asList(doc.data.paths) ?? [];
    } catch {
      // Front matter that cannot be parsed: treat the whole file as a rule that always applies.
    }
    if (!want(globs) || body.trim() === '') return;
    const entry: MemoryFile = { path: file, scope, content: body, importedBy: undefined };
    if (globs.length > 0) entry.paths = globs;
    take(entry, real, 0);
  };

  return { files, add: (file, scope) => addFile(file, scope, 0), addRule };
}

/**
 * Load the instruction files that apply from the start of a session.
 * User-level files and rules come first, then every directory from the
 * filesystem root down to `cwd`, so more specific files come later and win.
 * The project root's rules load with that directory, before its local file.
 * Rules scoped to paths are left for `onDemandInstructions`.
 * `excludes` are globs for files to skip (the `claudeMdExcludes` setting).
 */
export function loadMemory(cwd: string, claudeCompat = true, excludes?: string[]): MemoryFile[] {
  const collect = createCollector(new Set<string>(), excludes);
  const alwaysApplies = (globs: string[]) => globs.length === 0;

  collect.add(path.join(configDir(), MEMORY_FILE), 'user');
  if (claudeCompat) collect.add(path.join(claudeDir(), 'CLAUDE.md'), 'user');
  for (const file of userRuleFiles(claudeCompat)) collect.addRule(file, 'user', alwaysApplies);

  const start = path.resolve(cwd);
  const root = findProjectRoot(start);
  const dirs: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of dirs) {
    const names = candidates(dir, claudeCompat);
    for (const { file, scope } of names) if (scope !== 'local') collect.add(file, scope);
    if (dir === root) for (const file of projectRuleFiles(root, claudeCompat)) collect.addRule(file, 'project', alwaysApplies);
    for (const { file, scope } of names) if (scope === 'local') collect.add(file, scope);
  }
  return collect.files;
}

/** Real paths of files that were delivered, to seed the `loaded` set of `onDemandInstructions`. */
export function loadedPaths(files: MemoryFile[]): Set<string> {
  return new Set(files.map((f) => realPath(f.path) ?? path.resolve(f.path)));
}

/** `target` as a slash-separated path below `base`; undefined when it is not below it. */
function below(base: string, target: string): string | undefined {
  const rel = path.relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

/** Real path of the part of `p` that exists, with the rest appended. */
function realPrefix(p: string): string {
  const rest: string[] = [];
  for (let cur = p; ; ) {
    const real = realPath(cur);
    if (real !== undefined) return path.join(real, ...rest);
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

/** Like `below`, but two spellings of one place (/tmp and /private/tmp) also count. */
function belowResolved(base: string, target: string): string | undefined {
  return below(base, target) ?? below(realPrefix(base), realPrefix(target));
}

/**
 * Instructions that start to apply because the model read or edited
 * `absFilePath`: instruction files in the directories below `cwd` that lead
 * to it (outermost first), then rules whose `paths` globs match it (user
 * rules, then the project's). For a file outside `cwd` only user rules are
 * considered. `loaded` holds the real paths delivered so far in the session;
 * those are skipped and the ones returned here are added to it.
 */
export function onDemandInstructions(cwd: string, absFilePath: string, claudeCompat: boolean, loaded: Set<string>, excludes?: string[]): MemoryFile[] {
  const base = path.resolve(cwd);
  const file = path.resolve(base, absFilePath);
  // Reading an instruction file is not a reason to repeat it under its own content.
  const collect = createCollector(loaded, excludes, realPath(file));

  const inCwd = belowResolved(base, file);
  if (inCwd !== undefined) {
    let dir = base;
    for (const part of inCwd.split('/').slice(0, -1)) {
      dir = path.join(dir, part);
      for (const candidate of candidates(dir, claudeCompat)) collect.add(candidate.file, candidate.scope);
    }
  }

  const root = findProjectRoot(base);
  const inProject = belowResolved(root, file);
  // Outside the project only patterns such as "**/*.sql" can match, against the whole path.
  const target = inProject ?? toPosix(file).replace(/^\/+/, '');
  const matches = (globs: string[]) => matchesRulePaths(globs, target);
  for (const rule of userRuleFiles(claudeCompat)) collect.addRule(rule, 'user', matches);
  if (inCwd !== undefined && inProject !== undefined) {
    for (const rule of projectRuleFiles(root, claudeCompat)) collect.addRule(rule, 'project', matches);
  }
  return collect.files;
}

function renderBlock(f: MemoryFile): string {
  const label = f.scope === 'user' ? 'user instructions' : f.scope === 'local' ? 'local project instructions' : 'project instructions';
  const scope = f.paths?.length ? ` applies-to="${f.paths.join(', ')}"` : '';
  return `<instructions source="${f.path}" kind="${label}"${scope}>\n${f.content.trim()}\n</instructions>`;
}

export function renderMemory(files: MemoryFile[]): string {
  if (files.length === 0) return '';
  return [
    '# Instructions from the user',
    'These files were written by the user for you. Follow them; more specific files (later ones) take precedence.',
    '',
    files.map(renderBlock).join('\n\n'),
  ].join('\n');
}

/** Block appended to a tool result when touching a file brought more instructions into play. */
export function renderOnDemand(files: MemoryFile[]): string {
  if (files.length === 0) return '';
  return [
    '<loaded-instructions>',
    'Instruction files for the part of the project you just touched. They are not part of the tool output above; follow them when you work on the files they cover.',
    files.map(renderBlock).join('\n'),
    '</loaded-instructions>',
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
