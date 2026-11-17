/**
 * Static analysis of shell commands for the permission system. This is not a
 * shell parser: it splits a command line into simple commands, notices the
 * constructs that make static reasoning unsafe (substitution, write
 * redirection, heredocs) and errs toward asking the user.
 *
 * The invariant that matters: whenever the shell would run something this
 * code did not see as its own simple command, the analysis must say so
 * (`hasSubstitution` or `complex`), so nothing is auto-approved on the
 * strength of a command name the shell never actually executes that way.
 */

/** One element of a command line: a simple command, or the operator between two of them. */
export type BashStep = { cmd: string; op?: undefined } | { op: string; cmd?: undefined };

export interface BashAnalysis {
  /** Simple commands, split on && || ; | & ( ) and newlines. */
  commands: string[];
  /** The same commands in order, with the operators that separate them. */
  sequence: BashStep[];
  /** $(...), backticks or process substitution: the real command is not visible. */
  hasSubstitution: boolean;
  /** Output redirected to a file other than /dev/null. */
  hasWriteRedirect: boolean;
  /** Heredocs, unbalanced quotes, $'..' quoting, control characters: not safely splittable. */
  complex: boolean;
}

function isBlank(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n';
}

export function analyzeCommand(command: string): BashAnalysis {
  const commands: string[] = [];
  const sequence: BashStep[] = [];
  let hasSubstitution = false;
  let hasWriteRedirect = false;
  let complex = false;
  let cur = '';
  let quote: '"' | "'" | null = null;
  // True where a `#` would start a comment: at the start of a word.
  let wordStart = true;
  const src = command;

  const push = () => {
    let c = cur.trim();
    // `{ cmd; }` groups: the braces are punctuation, not part of the command.
    if (c === '{' || c === '}') c = '';
    else if (/^\{\s/.test(c)) c = c.slice(1).trim();
    if (c) {
      commands.push(c);
      sequence.push({ cmd: c });
    }
    cur = '';
    wordStart = true;
  };
  const operator = (op: string) => {
    push();
    sequence.push({ op });
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1];
    const code = ch.charCodeAt(0);

    // Carriage returns, escapes and friends are not separators to the shell but
    // look like whitespace to a reader; refuse to reason about such lines.
    if ((code < 32 && ch !== '\n' && ch !== '\t') || code === 127) complex = true;

    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      cur += ch + next;
      i++;
      wordStart = false;
      continue;
    }
    if (ch === '`' || (ch === '$' && next === '(')) hasSubstitution = true;
    if (quote === '"') {
      cur += ch;
      if (ch === '"') quote = null;
      continue;
    }
    // $'...' and $"..." have their own escape rules (\' does not end the string).
    if (ch === '$' && (next === "'" || next === '"')) complex = true;
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      wordStart = false;
      continue;
    }
    if (ch === '#' && wordStart) {
      // A comment runs to the end of the line; the shell never sees it.
      const end = src.indexOf('\n', i);
      i = (end < 0 ? src.length : end) - 1;
      continue;
    }
    if ((ch === '<' || ch === '>') && next === '(') hasSubstitution = true;

    if (ch === '<' && next === '<') {
      complex = true; // heredoc or here-string: body lines are not commands
      cur += src.slice(i);
      break;
    }
    if (ch === '>') {
      // Find the redirect target to tell real writes from fd plumbing.
      let op = '>';
      let j = i + 1;
      if (src[j] === '>' || src[j] === '|') op += src[j++];
      let amp = false;
      if (src[j] === '&') {
        amp = true;
        op += '&';
        j++;
      }
      let k = j;
      while (src[k] === ' ' || src[k] === '\t') k++;
      let target = '';
      while (k < src.length && !/[\s;|&<>()]/.test(src[k]!)) target += src[k++];
      const isDup = amp && /^(\d+|-)$/.test(target);
      if (!isDup && target !== '/dev/null') hasWriteRedirect = true;
      cur += op;
      i = j - 1;
      wordStart = false;
      continue;
    }
    if (ch === '&' && next === '>') {
      cur += ch;
      wordStart = false;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      operator(';');
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      operator(ch + next);
      i++;
      continue;
    }
    if (ch === '|') {
      operator('|');
      if (next === '&') i++;
      continue;
    }
    if (ch === '&' || ch === '(' || ch === ')') {
      operator(ch);
      continue;
    }
    cur += ch;
    wordStart = isBlank(ch);
  }
  if (quote) complex = true;
  push();
  return { commands, sequence, hasSubstitution, hasWriteRedirect, complex };
}

/** Split a simple command into words, removing quotes. */
export function tokenize(command: string): string[] {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) words.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) words.push(cur);
  return words;
}

interface Lexed {
  /** Command name and arguments, with redirections removed. */
  words: string[];
  /** Files opened for reading by `<`. */
  inputs: string[];
  /** Files opened for writing by `>`, `>>`, `&>`, `<>` and so on. */
  outputs: string[];
}

/**
 * Tokenize a simple command, separating redirections from arguments. Unlike
 * `tokenize`, operators are recognised even when glued to a word (`cat<f`).
 */
function lexSimple(command: string): Lexed {
  const words: string[] = [];
  const inputs: string[] = [];
  const outputs: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  let pending: '<' | '>' | null = null;
  let dup = false;

  const flush = () => {
    if (!has && cur === '') return;
    if (pending) {
      // `2>&1`, `>&-`: file-descriptor plumbing, not a file.
      if (!(dup && /^(\d+|-)$/.test(cur))) (pending === '<' ? inputs : outputs).push(cur);
      pending = null;
      dup = false;
    } else {
      words.push(cur);
    }
    cur = '';
    has = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      flush();
    } else if (ch === '<' || ch === '>') {
      // Digits (or `&`) glued to the operator are a file descriptor, not an argument.
      if (!has && /^(\d+|&)$/.test(cur)) cur = '';
      else flush();
      let op: '<' | '>' = ch;
      if (ch === '>' && (command[i + 1] === '>' || command[i + 1] === '|')) i++;
      else if (ch === '<' && command[i + 1] === '>') {
        i++;
        op = '>'; // read-write opens (and creates) the file
      }
      dup = false;
      if (command[i + 1] === '&') {
        i++;
        dup = true;
      }
      pending = op;
    } else {
      cur += ch;
    }
  }
  flush();
  return { words, inputs, outputs };
}

const READ_ONLY = new Set([
  'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'type', 'whoami', 'uname', 'stat',
  'df', 'cut', 'tr', 'diff', 'cmp', 'basename', 'dirname',
  'realpath', 'readlink', 'id', 'true', 'false', 'test', '[', 'cd', 'nl', 'column', 'jq', 'seq', 'tac', 'rev',
  'fold', 'comm', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum', 'arch', 'nproc', 'uptime', 'ps', 'printenv',
  'sleep', 'wait', 'command', 'hash', 'groups', 'locale', 'tty', 'pgrep', 'lsof', 'free',
]);

/**
 * Commands whose arguments are never opened as files, so they need no path
 * check: `echo /etc/passwd` prints a string, it does not read the file.
 */
const PATH_FREE = new Set([
  'echo', 'printf', 'true', 'false', 'sleep', 'seq', 'which', 'type', 'hash', 'command', 'whoami', 'uname', 'id',
  'arch', 'nproc', 'uptime', 'free', 'groups', 'locale', 'tty', 'wait', 'printenv', 'pgrep', 'ps', 'hostname',
  'basename', 'dirname', 'pwd',
]);

/** A short-option cluster containing the given letter, e.g. `-uo` for `o`. */
function shortFlag(letter: string): RegExp {
  return new RegExp(`^-[A-Za-z0-9]*${letter}`);
}

const FOLLOWS_LINKS = [shortFlag('L'), /^--(follow|dereference)/];

/**
 * Commands that are read-only unless one of these arguments is present:
 * options that write a file, run a program, or follow symlinks out of the
 * directories being searched.
 */
const GUARDED: Record<string, RegExp[]> = {
  find: [/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|L|H|follow)$/],
  sort: [shortFlag('o'), /^--output/, /^--compress-program/],
  tree: [shortFlag('o'), /^--output/, shortFlag('l')],
  date: [shortFlag('s'), /^--set/],
  file: [shortFlag('C'), /^--compile/],
  rg: [/^--pre/, /^--hostname-bin/, ...FOLLOWS_LINKS],
  fd: [shortFlag('x'), shortFlag('X'), /^--exec/, ...FOLLOWS_LINKS],
  ag: [/^--pager/, shortFlag('f'), /^--follow/],
  grep: [shortFlag('R'), /^--dereference-recursive/],
  egrep: [shortFlag('R'), /^--dereference-recursive/],
  fgrep: [shortFlag('R'), /^--dereference-recursive/],
  du: FOLLOWS_LINKS,
  ls: FOLLOWS_LINKS,
};

const HOSTNAME_FLAGS = /^(-f|-s|-i|-I|-d|-A|-y|--fqdn|--short|--ip-address|--all-ip-addresses|--domain|--long|--all-fqdns)$/;

const GIT_READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog',
  'grep', 'cat-file', 'merge-base', 'name-rev', 'for-each-ref', 'count-objects', 'whatchanged', 'check-ignore',
  'rev-list', 'show-ref', 'diff-tree', 'show-branch', 'var', 'version',
]);

/** Arguments that make an otherwise read-only git command write a file or run a program. */
const GIT_UNSAFE_ARG = /^(--output|--ext-diff|--textconv|--filters|--open-files-in-pager|-O|--upload-pack|--exec|--receive-pack)/;

/**
 * Tools whose `--version` runs nothing from the project. Package managers
 * that delegate to a project-pinned copy of themselves (yarn, pnpm via
 * corepack, composer plugins) are deliberately absent.
 */
const VERSION_TOOLS = new Set([
  'node', 'npm', 'npx', 'bun', 'deno', 'python', 'python3', 'pip', 'pip3', 'uv', 'cargo', 'rustc',
  'go', 'java', 'javac', 'ruby', 'gem', 'php', 'dotnet', 'tsc', 'gcc', 'g++', 'clang', 'make', 'cmake',
  'docker', 'kubectl', 'git', 'gh', 'ollama', 'terraform', 'swift', 'zig', 'perl',
]);

/** Global git options up to the subcommand. Returns null when one of them is unsafe. */
function gitSplit(args: string[]): { sub: string | undefined; rest: string[]; dirs: string[] } | null {
  const dirs: string[] = [];
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const flag = args[i]!;
    if (flag === '--version' || flag === '--help') return { sub: 'version', rest: [], dirs };
    if (flag === '-C') {
      if (args[i + 1] === undefined) return null;
      dirs.push(args[i + 1]!);
      i += 2;
    } else if (flag === '--no-pager' || flag === '-P') i += 1;
    // -c, --git-dir, --work-tree, --exec-path and friends change what git reads or runs.
    else return null;
  }
  return { sub: args[i], rest: args.slice(i + 1), dirs };
}

function gitIsReadOnly(args: string[]): boolean {
  const parsed = gitSplit(args);
  if (!parsed) return false;
  const { sub, rest } = parsed;
  if (!sub) return false;
  if (rest.some((a) => GIT_UNSAFE_ARG.test(a))) return false;
  if (GIT_READ_ONLY.has(sub)) return true;
  const flags = rest.filter((a) => a.startsWith('-'));
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (sub === 'branch') {
    const listFlag = /^(-a|-r|-v|-vv|-l|--all|--remotes|--list|--show-current|--verbose|--contains|--merged|--no-merged|--no-color|--color)$/;
    if (!flags.every((a) => listFlag.test(a))) return false;
    // A bare name creates a branch; names are only patterns/commits after a listing flag.
    return positional.length === 0 || flags.some((a) => /^(-l|--list|--contains|--merged|--no-merged)$/.test(a));
  }
  if (sub === 'tag') {
    const listFlag = /^(-l|--list|-n\d*|-i|--sort=.*|--contains|--no-contains|--merged|--no-merged|--points-at|--column|--no-column)$/;
    if (!flags.every((a) => listFlag.test(a))) return false;
    return positional.length === 0 || flags.some((a) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(a));
  }
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose')) || rest[0] === 'get-url';
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (sub === 'config') {
    if (rest.some((a) => /^(--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|--edit|-e)$/.test(a))) return false;
    return rest[0] === '--get' || rest[0] === '--list' || rest[0] === '-l' || rest[0] === '--get-all';
  }
  if (sub === 'reflog') return rest.length === 0 || rest[0] === 'show';
  if (sub === 'worktree') return rest[0] === 'list';
  return false;
}

/** Directories named by `git -C <dir>`; git runs there instead of the current directory. */
export function gitDirectories(simple: string): string[] {
  const { words } = lexSimple(simple);
  if (words[0] !== 'git') return [];
  return gitSplit(words.slice(1))?.dirs ?? [];
}

/** `sed -n '10,20p' file` and nothing fancier: sed scripts can write files and run commands. */
function sedIsReadOnly(args: string[]): boolean {
  const flags = args.filter((a) => a.startsWith('-'));
  const rest = args.filter((a) => !a.startsWith('-'));
  if (flags.length !== 1 || flags[0] !== '-n' || rest.length === 0) return false;
  return /^(\d+|\$)(,(\d+|\$))?p$/.test(rest[0]!);
}

/** True when a simple command only reads state. Unknown commands are not read-only. */
export function isReadOnlyCommand(simple: string): boolean {
  const { words, outputs } = lexSimple(simple);
  if (outputs.some((target) => target !== '/dev/null')) return false;
  const name = words[0];
  if (!name) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return false; // env assignments can change behaviour
  const args = words.slice(1);
  if (READ_ONLY.has(name)) {
    if (name === 'command') return (args[0] === '-v' || args[0] === '-V') && args.slice(1).every((a) => /^[\w.+-]+$/.test(a));
    if (name === 'type' || name === 'hash') return args.every((a) => /^[\w.+-]+$/.test(a));
    return true;
  }
  if (name in GUARDED) return !args.some((a) => GUARDED[name]!.some((re) => re.test(a)));
  if (name === 'hostname') return args.every((a) => HOSTNAME_FLAGS.test(a));
  // `uniq in out` writes its second operand.
  if (name === 'uniq') return args.filter((a) => !a.startsWith('-')).length <= 1;
  if (name === 'sed') return sedIsReadOnly(args);
  if (name === 'git') return gitIsReadOnly(args);
  if (name === 'npm') {
    if (['ls', 'list', 'view', 'outdated', 'root', 'prefix', 'why'].includes(args[0] ?? '')) return true;
    if (args[0] === 'config' && (args[1] === 'get' || args[1] === 'list')) return true;
  }
  if (name === 'go') {
    if (args[0] === 'version') return true;
    if (args[0] === 'env') return !args.slice(1).some((a) => a.startsWith('-') && a !== '-json');
    if (args[0] === 'list') return args.slice(1).every((a) => !a.startsWith('-') || /^(-m|-json|-deps|-e|-find|-versions)$/.test(a));
  }
  if (name === 'docker' && ['ps', 'images', 'version', 'info'].includes(args[0] ?? '') && args.length <= 2) return true;
  if (name === 'ollama' && ['list', 'ps', 'show'].includes(args[0] ?? '')) return true;
  if (VERSION_TOOLS.has(name) && args.length === 1 && /^(--version|-V|version)$/.test(args[0]!)) return true;
  return false;
}

/** File-system commands that acceptEdits mode lets through inside the working directories. */
export function isFileSystemCommand(simple: string): boolean {
  const { words, outputs } = lexSimple(simple);
  if (outputs.some((target) => target !== '/dev/null')) return false;
  const name = words[0];
  return name === 'mkdir' || name === 'touch' || name === 'mv' || name === 'cp';
}

/** The command name of a simple command, or undefined for an empty one. */
export function commandName(simple: string): string | undefined {
  return lexSimple(simple).words[0];
}

export interface PathCandidates {
  /** Arguments that the command may open as files (as written, unresolved). */
  paths: string[];
  /** True when an argument cannot be resolved statically (variables, brace expansion, ~user). */
  opaque: boolean;
  /** True when the command's arguments are strings, not files (echo, printf, ...). */
  pathFree: boolean;
}

/** Text that the shell would rewrite before the command sees it. */
function isOpaqueWord(word: string): boolean {
  if (/[$`]/.test(word)) return true;
  if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(word)) return true; // brace expansion
  if (word.startsWith('~') && word !== '~' && !word.startsWith('~/')) return true; // ~user, ~+, ~-
  // A glob such as ".*" can match ".." in older shells.
  if (word.split('/').some((part) => /^\.[*?[]/.test(part))) return true;
  return false;
}

/**
 * Every argument of a simple command that could name a file, including the
 * targets of `<` redirections and values glued to options (`--file=x`, `-fx`).
 */
export function pathCandidates(simple: string): PathCandidates {
  const { words, inputs } = lexSimple(simple);
  const name = words[0] ?? '';
  const pathFree = PATH_FREE.has(name) || (VERSION_TOOLS.has(name) && words.length === 2 && /^(--version|-V|version)$/.test(words[1]!));
  const paths: string[] = [];
  let opaque = false;
  const consider = (word: string) => {
    if (word === '') return;
    if (isOpaqueWord(word)) opaque = true;
    else paths.push(word);
  };
  for (const input of inputs) consider(input);
  if (name === 'cd') {
    const targets = words.slice(1).filter((w) => !/^-[LPe@]+$/.test(w) && w !== '--');
    if (targets.length === 0) consider('~'); // bare `cd` goes home
    else if (targets.includes('-')) opaque = true; // previous directory: unknown
    else for (const t of targets) consider(t);
    return { paths, opaque, pathFree: false };
  }
  if (!pathFree) {
    for (const word of words.slice(1)) {
      if (word.startsWith('-')) {
        const eq = word.indexOf('=');
        if (eq > 0) consider(word.slice(eq + 1));
        else if (!word.startsWith('--') && word.length > 2 && /[/~.]/.test(word.slice(2))) {
          // -f/etc/passwd, -t.git: an option with its value attached.
          consider(word.slice(2 + word.slice(2).search(/[/~.]/)));
        } else if (isOpaqueWord(word)) opaque = true;
        continue;
      }
      consider(word);
    }
  }
  return { paths, opaque, pathFree };
}

/** Arguments of a simple command that look like paths. */
export function pathArguments(simple: string): string[] {
  return pathCandidates(simple).paths.filter((t) => !t.includes('://') && (t.startsWith('/') || t.startsWith('~') || t.startsWith('.') || t.includes('/')));
}

const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl', 'pip', 'pip3', 'uv', 'gh', 'apt',
  'apt-get', 'brew', 'dotnet', 'mvn', 'gradle', 'poetry', 'composer', 'terraform', 'deno', 'make', 'ollama', 'npx',
  'systemctl', 'conda', 'bundle', 'rails', 'mix', 'swift', 'zig', 'just', 'task', 'nx', 'turbo',
]);

/** A reusable allow rule for a simple command, e.g. "npm run test:*". */
export function suggestBashRule(simple: string): string {
  const tokens = lexSimple(simple).words;
  const [first, second, third] = tokens;
  if (!first) return simple.trim();
  if (tokens.length === 1) return first;
  if (SUBCOMMAND_TOOLS.has(first) && second && !second.startsWith('-')) {
    if (second === 'run' && third && !third.startsWith('-')) return `${first} run ${third}:*`;
    return `${first} ${second}:*`;
  }
  if ((first === 'python' || first === 'python3') && second === '-m' && third) return `${first} -m ${third}:*`;
  return `${first}:*`;
}

const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])[a-zA-Z]*\s+(\/|~|\$HOME|\/\*|~\/\*|\*)(\s|$)/, 'recursively deletes a top-level directory'],
  [/\bsudo\b/, 'runs with elevated privileges'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'pipes a download straight into a shell'],
  [/\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease)/, 'force-pushes, which can overwrite remote history'],
  [/\bgit\s+reset\s+--hard\b/, 'discards uncommitted changes'],
  [/\bgit\s+clean\b.*-[a-zA-Z]*f/, 'deletes untracked files'],
  [/\bmkfs(\.\w+)?\b|\bdd\b.*\bof=\/dev\//, 'writes directly to a disk device'],
  [/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, 'is a fork bomb'],
  [/\bchmod\s+-R\s+777\b/, 'makes files world-writable recursively'],
  [/>\s*\/dev\/(sd|nvme|disk)/, 'writes directly to a disk device'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, 'shuts down or restarts the machine'],
  [/\bDROP\s+(TABLE|DATABASE)\b/i, 'drops database objects'],
];

/** A plain-language warning for commands that are easy to regret. */
export function dangerWarning(command: string): string | undefined {
  for (const [re, reason] of DANGEROUS) {
    if (re.test(command)) return `This command ${reason}.`;
  }
  return undefined;
}

/**
 * Wrapper commands that run another command unchanged. Rules are written for
 * the command that does the work, so `timeout 60 npm test` should be judged
 * as `npm test`. `xargs` is included for rule matching only: its real
 * arguments come from stdin and cannot be checked.
 */
const WRAPPERS: RegExp[] = [
  /^timeout(?:\s+(?:-s\s*\S+|--signal=\S+|-k\s*\S+|--kill-after=\S+|--preserve-status|--foreground|-v|--verbose))*\s+\d+(?:\.\d+)?[smhd]?\s+/,
  /^time(?:\s+-p)?\s+/,
  /^nice(?:\s+(?:-n\s*-?\d+|--adjustment=-?\d+|-\d+))?\s+/,
  /^nohup\s+/,
  /^stdbuf(?:\s+(?:-[ioe]\s*\S+|--(?:input|output|error)=\S+))+\s+/,
  /^command\s+(?!-)/,
  /^builtin\s+/,
  /^noglob\s+/,
];
const XARGS = /^xargs\s+(?!-)/;

/** The command with any leading wrapper commands removed. */
export function stripWrappers(simple: string, opts: { xargs?: boolean } = {}): string {
  let cmd = simple.trim();
  for (let i = 0; i < 6; i++) {
    const before = cmd;
    for (const re of WRAPPERS) cmd = cmd.replace(re, '');
    if (opts.xargs) cmd = cmd.replace(XARGS, '');
    if (cmd === before) break;
  }
  return cmd;
}
