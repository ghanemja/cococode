import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionRequest } from '../tools/types.ts';
import { analyzeCommand } from './bash.ts';

export interface Rule {
  /** Tool name as written. */
  tool: string;
  /** Text inside the parentheses, if any. */
  spec?: string;
  raw: string;
  source?: string;
}

/** Rules written for one tool also govern the others in its family. */
const FAMILY: Record<string, string> = {
  Write: 'Edit',
  NotebookEdit: 'Edit',
  MultiEdit: 'Edit',
  Glob: 'Read',
  Grep: 'Read',
  LS: 'Read',
  Task: 'Agent',
};

export function family(tool: string): string {
  return FAMILY[tool] ?? tool;
}

export function parseRule(raw: string, source?: string): Rule | null {
  const text = raw.trim();
  const m = /^([A-Za-z0-9_*.-]+)(?:\(([\s\S]*)\))?$/.exec(text);
  if (!m) return null;
  const rule: Rule = { tool: m[1]!, raw: text, source };
  if (m[2] !== undefined && m[2] !== '' && m[2] !== '*') rule.spec = m[2];
  return rule;
}

export function parseRules(list: string[] | undefined, source?: string): Rule[] {
  return (list ?? []).map((r) => parseRule(r, source)).filter((r): r is Rule => r !== null);
}

/** Convert a glob to a regex. `**` crosses directories, `*` does not. */
export function globToRegExp(glob: string, opts: { pathMode?: boolean } = {}): RegExp {
  const pathMode = opts.pathMode ?? true;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += pathMode ? '[^/]*' : '.*';
      }
    } else if (ch === '?') {
      re += pathMode ? '[^/]' : '.';
    } else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close < 0) re += '\\[';
      else {
        const body = glob.slice(i + 1, close);
        re += `[${body.startsWith('!') ? '^' + body.slice(1) : body}]`;
        i = close;
      }
    } else if (ch === '{') {
      const close = glob.indexOf('}', i + 1);
      if (close < 0) re += '\\{';
      else {
        const alts = glob.slice(i + 1, close).split(',');
        re += `(?:${alts.map((a) => globToRegExp(a, opts).source.slice(1, -1)).join('|')})`;
        i = close;
      }
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 's');
}

export interface MatchContext {
  cwd: string;
  projectRoot: string;
}

/** Bash specs: `prefix:*`, globs with `*`, or an exact command. */
export function matchBashSpec(spec: string, command: string): boolean {
  const cmd = command.trim();
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim();
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  if (spec.includes('*')) {
    // "npm run *" should also match "npm run" with nothing after it.
    const re = globToRegExp(spec, { pathMode: false });
    return re.test(cmd) || (spec.endsWith(' *') && cmd === spec.slice(0, -2).trim());
  }
  return cmd === spec.trim();
}

/**
 * Path specs follow gitignore conventions:
 *   //abs/path   absolute
 *   ~/path       home directory
 *   /path        relative to the project root
 *   path, ./path relative to the current directory
 * A spec naming a directory also covers everything beneath it.
 */
export function matchPathSpec(spec: string, absPath: string, ctx: MatchContext): boolean {
  let pattern: string;
  if (spec.startsWith('//')) pattern = spec.slice(1);
  else if (spec === '~' || spec.startsWith('~/')) pattern = path.join(os.homedir(), spec.slice(1));
  else if (spec.startsWith('/')) pattern = path.join(ctx.projectRoot, spec);
  else if (spec.startsWith('./')) pattern = path.join(ctx.cwd, spec.slice(2));
  else if (spec.includes('/') || /[*?[{]/.test(spec) === false) pattern = path.join(ctx.cwd, spec);
  else pattern = path.join(ctx.cwd, '**', spec); // bare glob like *.env matches at any depth

  const normalized = pattern.split(path.sep).join('/').replace(/\/+$/, '');
  const target = absPath.split(path.sep).join('/');
  if (globToRegExp(normalized).test(target)) return true;
  if (globToRegExp(`${normalized}/**`).test(target)) return true;
  // A bare filename such as ".env" also matches at any depth below cwd.
  if (!spec.includes('/') && !/[*?[{]/.test(spec)) {
    return globToRegExp(path.join(ctx.cwd, '**', spec).split(path.sep).join('/')).test(target);
  }
  return false;
}

export function matchDomainSpec(spec: string, target: string): boolean {
  const want = spec.replace(/^domain:/, '').toLowerCase();
  const host = target.replace(/^domain:/, '').toLowerCase();
  if (want.startsWith('*.')) return host.endsWith(want.slice(1)) || host === want.slice(2);
  return host === want || host.endsWith(`.${want}`);
}

/**
 * Does `rule` cover this request? `actualTool` is the tool being called;
 * `req.tool` is the rule family it asks permission under.
 */
export function ruleMatches(rule: Rule, actualTool: string, req: PermissionRequest | null, ctx: MatchContext): boolean {
  const ruleFamily = family(rule.tool);
  const reqFamily = req ? family(req.tool) : family(actualTool);

  // MCP: "mcp__server" covers every tool of that server; globs are allowed.
  if (rule.tool.startsWith('mcp__')) {
    if (!actualTool.startsWith('mcp__')) return false;
    if (rule.tool === actualTool) return true;
    if (rule.tool.includes('*')) return globToRegExp(rule.tool, { pathMode: false }).test(actualTool);
    return actualTool.startsWith(`${rule.tool}__`);
  }

  if (rule.spec === undefined) {
    return rule.tool === actualTool || ruleFamily === reqFamily || rule.tool === '*';
  }
  if (!req || ruleFamily !== reqFamily || req.target === undefined) return false;

  switch (req.kind) {
    case 'bash':
      return matchBashSpec(rule.spec, req.target);
    case 'read':
    case 'edit':
      return matchPathSpec(rule.spec, req.target, ctx);
    case 'web':
      return rule.spec.startsWith('domain:') ? matchDomainSpec(rule.spec, req.target) : rule.spec === req.target;
    default:
      return rule.spec === req.target;
  }
}

/**
 * For Bash, a rule set allows a command line only if every simple command in
 * it is covered. `matchOne` decides coverage for a single simple command.
 */
export function everyCommand(command: string, matchOne: (simple: string) => boolean): boolean {
  const analysis = analyzeCommand(command);
  if (analysis.commands.length === 0) return false;
  return analysis.commands.every(matchOne);
}
