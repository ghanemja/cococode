/**
 * Static analysis of shell commands for the permission system. This is not a
 * shell parser: it splits a command line into simple commands, notices the
 * constructs that make static reasoning unsafe (substitution, write
 * redirection, heredocs) and errs toward asking the user.
 */

export interface BashAnalysis {
  /** Simple commands, split on && || ; | & and newlines. */
  commands: string[];
  /** $(...), backticks or process substitution: the real command is not visible. */
  hasSubstitution: boolean;
  /** Output redirected to a file other than /dev/null. */
  hasWriteRedirect: boolean;
  /** Heredocs, unbalanced quotes: not safely splittable. */
  complex: boolean;
}

export function analyzeCommand(command: string): BashAnalysis {
  const commands: string[] = [];
  let hasSubstitution = false;
  let hasWriteRedirect = false;
  let complex = false;
  let cur = '';
  let quote: '"' | "'" | null = null;
  const src = command;

  const push = () => {
    let c = cur.trim();
    // Subshell and group punctuation is not part of the command name.
    c = c.replace(/^[({]\s*/, '').replace(/\s*[)}]$/, '').trim();
    if (c) commands.push(c);
    cur = '';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1];

    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      cur += ch + next;
      i++;
      continue;
    }
    if (ch === '`' || (ch === '$' && next === '(')) hasSubstitution = true;
    if (quote === '"') {
      cur += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
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
      let j = i + 1;
      if (src[j] === '>') j++;
      if (src[j] === '|') j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      let target = '';
      while (j < src.length && !/[\s;|&<>()]/.test(src[j]!)) target += src[j++];
      const isDup = src[i + 1] === '&' && /^\d+$|^-$/.test(src.slice(i + 2).match(/^[\d-]+/)?.[0] ?? '');
      if (!isDup && target !== '/dev/null' && !/^&\d+$/.test(target)) hasWriteRedirect = true;
      cur += ch;
      if (src[i + 1] === '&') {
        cur += '&';
        i++;
      }
      continue;
    }
    if (ch === '&' && next === '>') {
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      push();
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      push();
      i++;
      continue;
    }
    if (ch === '|') {
      push();
      if (next === '&') i++;
      continue;
    }
    if (ch === '&') {
      push();
      continue;
    }
    cur += ch;
  }
  if (quote) complex = true;
  push();
  return { commands, hasSubstitution, hasWriteRedirect, complex };
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

/** Drop redirections (2>&1, >/dev/null, < file) from a token list. */
function stripRedirects(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d*(>>?|<)&?\d*$/.test(t)) {
      if (!/&\d+$/.test(t)) i++; // operator followed by a separate target word
      continue;
    }
    if (/^\d*(>>?|<|&>)/.test(t)) continue;
    out.push(t);
  }
  return out;
}

const READ_ONLY = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'type', 'whoami', 'uname', 'file', 'stat',
  'du', 'df', 'grep', 'egrep', 'fgrep', 'rg', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename', 'dirname',
  'realpath', 'readlink', 'id', 'true', 'false', 'test', '[', 'cd', 'nl', 'column', 'jq', 'seq', 'tac', 'rev',
  'fold', 'comm', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum', 'arch', 'nproc', 'uptime', 'ps', 'printenv',
  'sleep', 'fd', 'ag', 'wait', 'command', 'hash', 'groups', 'locale', 'tty', 'pgrep', 'lsof', 'free',
]);

/** Commands that are read-only unless one of these flags is present. */
const GUARDED: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-o|--output)/,
  tree: /^-o$/,
  date: /^(-s|--set)/,
  hostname: /^[^-]/,
  sed: /^(-i|--in-place)/,
};

const GIT_READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog',
  'grep', 'cat-file', 'merge-base', 'name-rev', 'for-each-ref', 'count-objects', 'whatchanged', 'check-ignore',
  'rev-list', 'show-ref', 'ls-remote', 'diff-tree', 'show-branch', 'var', 'version',
]);

const VERSION_TOOLS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'pip', 'pip3', 'uv', 'cargo', 'rustc',
  'go', 'java', 'javac', 'ruby', 'gem', 'php', 'composer', 'dotnet', 'tsc', 'gcc', 'g++', 'clang', 'make', 'cmake',
  'docker', 'kubectl', 'git', 'gh', 'ollama', 'terraform', 'swift', 'zig', 'perl',
]);

function gitIsReadOnly(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const flag = args[i]!;
    if (flag === '--version' || flag === '--help') return true;
    if (flag === '-C' || flag === '--git-dir' || flag === '--work-tree') i += 2;
    else if (flag === '--no-pager' || flag === '-P' || flag.startsWith('--git-dir=')) i += 1;
    else return false; // -c and friends can change what git executes
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return false;
  if (rest.some((a) => a === '--output' || a.startsWith('--output=') || a === '--ext-diff' || a === '--textconv')) return false;
  if (GIT_READ_ONLY.has(sub)) return true;
  if (sub === 'branch') {
    const listFlag = /^(-a|-r|-v|-vv|-l|--all|--remotes|--list|--show-current|--verbose|--contains|--merged|--no-merged|--no-color|--color)$/;
    const flags = rest.filter((a) => a.startsWith('-'));
    const positional = rest.filter((a) => !a.startsWith('-'));
    if (!flags.every((a) => listFlag.test(a))) return false;
    // A bare name creates a branch; names are only patterns/commits after a listing flag.
    return positional.length === 0 || flags.some((a) => /^(-l|--list|--contains|--merged|--no-merged)$/.test(a));
  }
  if (sub === 'tag') return rest.length === 0 || rest[0] === '-l' || rest[0] === '--list' || rest[0] === '-n';
  if (sub === 'remote') return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url';
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (sub === 'config') return rest[0] === '--get' || rest[0] === '--list' || rest[0] === '-l' || rest[0] === '--get-all';
  if (sub === 'reflog') return rest.length === 0 || rest[0] === 'show';
  if (sub === 'worktree') return rest[0] === 'list';
  return false;
}

/** True when a simple command only reads state. Unknown commands are not read-only. */
export function isReadOnlyCommand(simple: string): boolean {
  const tokens = stripRedirects(tokenize(simple));
  const name = tokens[0];
  if (!name) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return false; // env assignments can change behaviour
  const args = tokens.slice(1);
  if (READ_ONLY.has(name)) {
    if (name === 'command' || name === 'type' || name === 'hash') return args.every((a) => a.startsWith('-') || /^[\w.+-]+$/.test(a)) && (name !== 'command' || args[0] === '-v' || args[0] === '-V');
    if (name === 'rg' && args.some((a) => a === '--pre' || a.startsWith('--pre='))) return false;
    return true;
  }
  if (name in GUARDED) return !args.some((a) => GUARDED[name]!.test(a));
  if (name === 'git') return gitIsReadOnly(args);
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') {
    if (['ls', 'list', 'view', 'outdated', 'root', 'prefix', 'why', 'bin'].includes(args[0] ?? '')) return true;
    if (args[0] === 'config' && (args[1] === 'get' || args[1] === 'list')) return true;
  }
  if (name === 'go' && (args[0] === 'version' || args[0] === 'env' || args[0] === 'list')) return true;
  if (name === 'cargo' && ['tree', 'metadata', 'version'].includes(args[0] ?? '')) return true;
  if (name === 'docker' && ['ps', 'images', 'version', 'info'].includes(args[0] ?? '') && args.length <= 2) return true;
  if (name === 'ollama' && ['list', 'ps', 'show'].includes(args[0] ?? '')) return true;
  if (VERSION_TOOLS.has(name) && args.length === 1 && /^(--version|-V|version)$/.test(args[0]!)) return true;
  return false;
}

/** File-system commands that acceptEdits mode lets through inside the working directories. */
export function isFileSystemCommand(simple: string): boolean {
  const name = stripRedirects(tokenize(simple))[0];
  return name === 'mkdir' || name === 'touch' || name === 'mv' || name === 'cp';
}

/** Arguments of a simple command that look like paths. */
export function pathArguments(simple: string): string[] {
  const tokens = stripRedirects(tokenize(simple)).slice(1);
  const paths: string[] = [];
  for (const raw of tokens) {
    let t = raw;
    if (t.startsWith('-')) {
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      t = t.slice(eq + 1);
    }
    if (t === '' || t.includes('://')) continue;
    if (t.startsWith('/') || t.startsWith('~') || t.startsWith('.') || t.includes('/')) paths.push(t);
  }
  return paths;
}

const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl', 'pip', 'pip3', 'uv', 'gh', 'apt',
  'apt-get', 'brew', 'dotnet', 'mvn', 'gradle', 'poetry', 'composer', 'terraform', 'deno', 'make', 'ollama', 'npx',
  'systemctl', 'conda', 'bundle', 'rails', 'mix', 'swift', 'zig', 'just', 'task', 'nx', 'turbo',
]);

/** A reusable allow rule for a simple command, e.g. "npm run test:*". */
export function suggestBashRule(simple: string): string {
  const tokens = stripRedirects(tokenize(simple));
  const [first, second, third] = tokens;
  if (!first) return simple;
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
