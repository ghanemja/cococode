import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PROJECT_DIR, configDir, displayPath, expandHome, readJsonFile } from '../config/paths.ts';
import type { PermissionSettings, Settings, SettingsScope } from '../config/settings.ts';
import { settingsPath, updateSettingsFile } from '../config/settings.ts';
import type { SessionState } from '../session/state.ts';
import { isInside, realpathSafe } from '../session/state.ts';
import type { PermissionRequest, Tool, ToolContext } from '../tools/types.ts';
import type { PermissionMode } from '../types.ts';
import type { BashAnalysis } from './bash.ts';
import {
  analyzeCommand,
  commandName,
  dangerWarning,
  gitDirectories,
  isFileSystemCommand,
  isReadOnlyCommand,
  pathCandidates,
  suggestBashRule,
} from './bash.ts';
import type { MatchContext, Rule } from './rules.ts';
import { family, matchAbsoluteGlob, matchBashSpec, parseRule, parseRules, resolvePathSpec, ruleMatches } from './rules.ts';

export interface Suggestion {
  /** Text of the "yes, and don't ask again" option. */
  label: string;
  rules?: string[];
  mode?: PermissionMode;
  addDir?: string;
  /** Where the rules are saved. Session-only when undefined. */
  scope?: SettingsScope;
}

export type PermissionOutcome =
  | { behavior: 'allow'; reason?: string }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; request: PermissionRequest; suggestions: Suggestion[]; warning?: string; reason?: string };

export interface PermissionInit {
  settings?: PermissionSettings;
  mode?: PermissionMode;
  /** --allowedTools */
  allow?: string[];
  /** --disallowedTools */
  deny?: string[];
}

/** Tools that stay usable in plan mode even though they are not read-only. */
const PLAN_MODE_TOOLS = new Set(['ExitPlanMode', 'TodoWrite', 'AskUserQuestion', 'Agent', 'Skill', 'BashOutput', 'KillShell']);

const DENIED = 'Do not retry; choose a different approach or ask the user.';

/** The part of an absolute glob before its first wildcard segment. */
function staticPrefix(pattern: string): { prefix: string; rest: string } {
  const segments = pattern.split('/');
  const firstGlob = segments.findIndex((s) => /[*?[{]/.test(s));
  if (firstGlob < 0) return { prefix: pattern, rest: '' };
  return { prefix: segments.slice(0, firstGlob).join('/') || '/', rest: segments.slice(firstGlob).join('/') };
}

/** Where the shell may be at some point of a command line. */
interface Location {
  dirs: string[];
  /** A `cd` whose destination could not be worked out came before. */
  unknown: boolean;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A directory that git would treat as a repository without a `.git` entry
 * (a bare repository layout). Its `config` file can name programs for git to
 * run, so git commands there are never auto-approved.
 */
function looksLikeBareRepository(dir: string): boolean {
  let current = dir;
  for (let depth = 0; depth < 40; depth++) {
    if (fs.existsSync(path.join(current, '.git'))) return false;
    if (fs.existsSync(path.join(current, 'HEAD')) && fs.existsSync(path.join(current, 'objects')) && fs.existsSync(path.join(current, 'refs'))) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

export class PermissionManager {
  mode: PermissionMode;
  private allow: Rule[];
  private ask: Rule[];
  private deny: Rule[];
  private sessionAllow: Rule[] = [];
  private readonly session: SessionState;

  constructor(session: SessionState, init: PermissionInit = {}) {
    this.session = session;
    this.mode = init.mode ?? init.settings?.defaultMode ?? 'default';
    this.allow = [...parseRules(init.settings?.allow, 'settings'), ...parseRules(init.allow, 'cli')];
    this.ask = parseRules(init.settings?.ask, 'settings');
    this.deny = [...parseRules(init.settings?.deny, 'settings'), ...parseRules(init.deny, 'cli')];
  }

  private matchCtx(): MatchContext {
    return { cwd: this.session.cwd, projectRoot: this.session.projectRoot };
  }

  private allowRules(): Rule[] {
    return [...this.allow, ...this.sessionAllow];
  }

  /** A deny rule without a specifier removes the tool from the model's view entirely. */
  isToolDisabled(name: string): boolean {
    return this.deny.some((r) => r.spec === undefined && ruleMatches(r, name, null, this.matchCtx()));
  }

  rules(): { allow: Rule[]; ask: Rule[]; deny: Rule[]; session: Rule[] } {
    return { allow: this.allow, ask: this.ask, deny: this.deny, session: this.sessionAllow };
  }

  addRule(behavior: 'allow' | 'ask' | 'deny', raw: string, scope?: SettingsScope): boolean {
    const rule = parseRule(raw, scope ?? 'session');
    if (!rule) return false;
    const list = behavior === 'allow' ? (scope ? this.allow : this.sessionAllow) : behavior === 'ask' ? this.ask : this.deny;
    if (!list.some((r) => r.raw === rule.raw)) list.push(rule);
    if (scope) {
      updateSettingsFile(scope, this.session.projectRoot, (s) => {
        s.permissions ??= {};
        const saved = (s.permissions[behavior] ??= []);
        if (!saved.includes(rule.raw)) saved.push(rule.raw);
      });
    }
    return true;
  }

  removeRule(raw: string): boolean {
    const wanted = raw.trim();
    let removed = false;
    for (const key of ['allow', 'ask', 'deny', 'sessionAllow'] as const) {
      const before = this[key].length;
      this[key] = this[key].filter((r) => r.raw !== wanted);
      if (this[key].length !== before) removed = true;
    }
    for (const scope of ['local', 'project', 'user'] as const) {
      // Only touch files that actually hold the rule; never create one just to look.
      let saved: Settings | undefined;
      try {
        saved = readJsonFile<Settings>(settingsPath(scope, this.session.projectRoot));
      } catch {
        continue;
      }
      const holds = (['allow', 'ask', 'deny'] as const).some((b) => saved?.permissions?.[b]?.includes(wanted));
      if (!holds) continue;
      updateSettingsFile(scope, this.session.projectRoot, (s) => {
        for (const behavior of ['allow', 'ask', 'deny'] as const) {
          const list = s.permissions?.[behavior];
          if (list?.includes(wanted)) s.permissions![behavior] = list.filter((r) => r !== wanted);
        }
      });
      removed = true;
    }
    return removed;
  }

  /** Apply the option the user picked in an approval dialog. */
  applySuggestion(s: Suggestion): void {
    if (s.mode) this.mode = s.mode;
    if (s.addDir) this.session.addDir(s.addDir);
    for (const raw of s.rules ?? []) this.addRule('allow', raw, s.scope);
  }

  /**
   * Rule matching that sees through symlinks. A deny or ask rule applies if it
   * matches the path as written or the file it really points at; an allow
   * rule applies only if it matches both, so a link cannot smuggle an edit
   * out from under `Edit(src/**)`.
   */
  private matches(rule: Rule, toolName: string, req: PermissionRequest | null, strict: boolean): boolean {
    const ctx = this.matchCtx();
    const lexical = ruleMatches(rule, toolName, req, ctx);
    if (!req || rule.spec === undefined || req.target === undefined || (req.kind !== 'read' && req.kind !== 'edit')) return lexical;
    if (rule.tool.startsWith('mcp__') || family(rule.tool) !== family(req.tool)) return lexical;
    // The spec's own base may be reached through a link, so compare under both spellings.
    const written = lexical || this.realPathMatches(rule.spec, path.resolve(req.target), ctx);
    const real = this.realPathMatches(rule.spec, realpathSafe(req.target), ctx);
    return strict ? written && real : written || real;
  }

  /** Match a resolved path against a spec, resolving symlinks in the spec's own fixed part too. */
  private realPathMatches(spec: string, realTarget: string, ctx: MatchContext): boolean {
    const variants = [ctx, { cwd: realpathSafe(ctx.cwd), projectRoot: realpathSafe(ctx.projectRoot) }];
    for (const variant of variants) {
      const patterns = [resolvePathSpec(spec, variant)];
      if (!spec.includes('/') && !/[*?[{]/.test(spec) && spec !== '~') patterns.push(`${variant.cwd.split(path.sep).join('/')}/**/${spec}`);
      for (const pattern of patterns) {
        if (matchAbsoluteGlob(pattern, realTarget)) return true;
        const { prefix, rest } = staticPrefix(pattern);
        const realPrefix = realpathSafe(prefix).split(path.sep).join('/');
        if (realPrefix !== prefix && matchAbsoluteGlob(rest ? `${realPrefix}/${rest}` : realPrefix, realTarget)) return true;
      }
    }
    return false;
  }

  evaluate(tool: Tool, input: unknown, ctx: ToolContext): PermissionOutcome {
    const req = tool.permission?.(input, ctx) ?? null;
    const readOnly = tool.isReadOnly(input);
    const isBash = req?.kind === 'bash' && req.target !== undefined;

    const denied = this.deny.find((r) => this.matches(r, tool.name, req, false));
    if (denied) return { behavior: 'deny', message: `Permission denied by rule ${denied.raw}. ${DENIED}` };
    if (isBash) {
      const blocked = this.bashRuleHit(this.deny, req!.target!, true);
      if (blocked) return { behavior: 'deny', message: `Permission denied by rule ${blocked}. ${DENIED}` };
    }

    if (this.mode === 'plan' && !readOnly && !PLAN_MODE_TOOLS.has(tool.name)) {
      return {
        behavior: 'deny',
        message:
          'Plan mode is active: you may only read and research, not change anything. ' +
          'Finish investigating, then call ExitPlanMode with your plan and wait for approval.',
      };
    }

    if (!req) return { behavior: 'allow' };

    let asked = this.ask.find((r) => this.matches(r, tool.name, req, false))?.raw;
    // An ask rule for one part of a compound command covers the whole line.
    if (!asked && isBash) asked = this.bashRuleHit(this.ask, req.target!, false);
    let outcome: PermissionOutcome;
    if (asked && this.mode !== 'bypassPermissions') {
      outcome = this.askOutcome(req, `Rule ${asked} requires confirmation.`);
    } else if (this.mode === 'bypassPermissions') {
      outcome = { behavior: 'allow', reason: 'bypassPermissions mode' };
    } else {
      outcome = this.evaluateDefault(tool, req);
    }

    if (outcome.behavior === 'ask' && this.mode === 'dontAsk') {
      return { behavior: 'deny', message: `${req.description} was not pre-approved and the session is in dontAsk mode.` };
    }
    return outcome;
  }

  private evaluateDefault(tool: Tool, req: PermissionRequest): PermissionOutcome {
    const rules = this.allowRules();

    if (req.kind === 'bash' && req.target !== undefined) return this.evaluateBash(req, req.target);

    const isProtected = req.kind === 'edit' && req.target !== undefined && this.isProtectedPath(req.target);
    // Files that decide what runs on this machine need a rule that names them; a blanket "Edit" is not enough.
    const allowed = rules.find((r) => (!isProtected || r.spec !== undefined) && this.matches(r, tool.name, req, true));
    if (allowed) return { behavior: 'allow', reason: `rule ${allowed.raw}` };

    switch (req.kind) {
      case 'read':
        if (!req.target || this.session.inWorkingDirs(req.target)) return { behavior: 'allow' };
        return this.askOutcome(req);
      case 'edit':
        if (isProtected) return this.askOutcome(req, 'This file controls how coco, git or your shell behaves.');
        if (this.mode === 'acceptEdits' && req.target && this.session.inWorkingDirs(req.target)) {
          return { behavior: 'allow', reason: 'acceptEdits mode' };
        }
        return this.askOutcome(req);
      case 'web':
      case 'mcp':
        return this.askOutcome(req);
      default:
        return { behavior: 'allow' };
    }
  }

  private bashAllowRules(): Rule[] {
    return this.allowRules().filter((r) => family(r.tool) === 'Bash');
  }

  private evaluateBash(req: PermissionRequest, command: string): PermissionOutcome {
    const rules = this.bashAllowRules();
    if (rules.some((r) => r.spec === undefined)) return { behavior: 'allow', reason: 'rule Bash' };
    // An exact rule for the whole line covers it regardless of structure.
    if (rules.some((r) => r.spec !== undefined && !r.spec.includes('*') && r.spec.trim() === command.trim())) {
      return { behavior: 'allow', reason: 'exact rule' };
    }

    const analysis = analyzeCommand(command);
    const warning = dangerWarning(command);
    const opaque = analysis.hasSubstitution || analysis.complex;

    if (!opaque && analysis.commands.length > 0 && this.uncovered(analysis, rules).length === 0) {
      return { behavior: 'allow' };
    }
    const reason = analysis.hasSubstitution
      ? 'The command uses substitution, so what it runs cannot be checked in advance.'
      : analysis.complex
        ? 'The command uses shell syntax that cannot be checked in advance.'
        : undefined;
    return this.askOutcome(req, reason, warning);
  }

  /**
   * The simple commands of a line that nothing approves yet. Directory
   * changes are followed, so `cd sub && cat ../x` is judged from where each
   * command would really run.
   */
  private uncovered(analysis: BashAnalysis, rules: Rule[]): string[] {
    const missing: string[] = [];
    const steps = analysis.sequence;
    // Directories the shell may be in when the next command runs.
    let where: Location = { dirs: [this.session.cwd], unknown: false };
    const saved: Location[] = [];
    let prevOp = '';
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.op !== undefined) {
        // A subshell's directory changes end with it.
        if (step.op === '(') saved.push(where);
        else if (step.op === ')') where = saved.pop() ?? where;
        prevOp = step.op;
        continue;
      }
      const simple = step.cmd;
      if (!this.simpleCommandAllowed(simple, rules, analysis.hasWriteRedirect, where)) missing.push(simple);
      if (commandName(simple) !== 'cd') continue;

      const found = pathCandidates(simple);
      if (found.opaque) {
        where = { dirs: where.dirs, unknown: true };
        continue;
      }
      const targets = [...new Set(where.dirs.flatMap((dir) => found.paths.map((p) => path.resolve(dir, expandHome(p)))))];
      const nextOp = steps.slice(i + 1).find((s) => s.op !== undefined)?.op;
      // The move is certain only if the directory exists and `cd` runs in this
      // shell: in a pipeline or in the background it happens in a subshell.
      const certain = targets.length > 0 && targets.every(isDirectory) && prevOp !== '|' && (nextOp === undefined || nextOp === '&&' || nextOp === ';' || nextOp === ')');
      where = { dirs: certain ? targets : [...new Set([...where.dirs, ...targets])], unknown: where.unknown };
    }
    return missing;
  }

  private simpleCommandAllowed(simple: string, rules: Rule[], hasWriteRedirect: boolean, where: Location): boolean {
    if (rules.some((r) => r.spec !== undefined && matchBashSpec(r.spec, simple))) return true;
    if (hasWriteRedirect) return false;
    if (isReadOnlyCommand(simple)) return this.pathsAllowed(simple, where, false);
    if (this.mode === 'acceptEdits' && isFileSystemCommand(simple)) return this.pathsAllowed(simple, where, true);
    return false;
  }

  /** Is every file this command could touch inside the working directories? */
  private pathsAllowed(simple: string, where: Location, writes: boolean): boolean {
    const found = pathCandidates(simple);
    if (found.opaque) return false;
    const name = commandName(simple);
    let bases = where.dirs;
    if (name === 'git') {
      const dirs = gitDirectories(simple);
      if (dirs.length) bases = bases.flatMap((cwd) => dirs.map((d) => path.resolve(cwd, expandHome(d))));
      if (where.unknown || bases.some(looksLikeBareRepository)) return false;
    }
    // Commands that read files default to the current directory, so it must be allowed too.
    // (`cd` only names where it is going, and that is checked below.)
    if (!found.pathFree && name !== 'cd') {
      if (where.unknown || !bases.every((cwd) => this.session.inWorkingDirs(cwd))) return false;
    }
    if (where.unknown && found.paths.some((p) => !path.isAbsolute(expandHome(p)))) return false;
    for (const base of bases) {
      for (const candidate of found.paths) {
        if (candidate === '/dev/null') continue;
        const abs = path.resolve(base, expandHome(candidate));
        if (!this.session.inWorkingDirs(abs)) return false;
        if (writes && (this.isProtectedPath(abs) || this.isProtectedPath(realpathSafe(abs)))) return false;
      }
    }
    return true;
  }

  /**
   * A deny or ask rule that applies to any part of a command line. With
   * `files`, Read/Edit rules also apply to shell commands that name those
   * paths (best effort: only paths visible in the command text).
   */
  private bashRuleHit(list: Rule[], command: string, files: boolean): string | undefined {
    const bashRules = list.filter((r) => r.spec !== undefined && family(r.tool) === 'Bash');
    const fileRules = files ? list.filter((r) => r.spec !== undefined && (family(r.tool) === 'Read' || family(r.tool) === 'Edit')) : [];
    if (bashRules.length === 0 && fileRules.length === 0) return undefined;
    const ctx = this.matchCtx();
    for (const simple of analyzeCommand(command).commands) {
      const hit = bashRules.find((r) => matchBashSpec(r.spec!, simple));
      if (hit) return hit.raw;
      if (fileRules.length === 0) continue;
      for (const candidate of pathCandidates(simple).paths) {
        const abs = path.resolve(this.session.cwd, expandHome(candidate));
        const real = realpathSafe(abs);
        const rule = fileRules.find(
          (r) => ruleMatches({ ...r, tool: 'Read' }, 'Read', { tool: 'Read', kind: 'read', target: abs, description: '' }, ctx) || this.realPathMatches(r.spec!, real, ctx),
        );
        if (rule) return rule.raw;
      }
    }
    return undefined;
  }

  /** Files that change what runs on this machine; edits always need a human. */
  private isProtectedPath(absPath: string): boolean {
    const home = os.homedir();
    const base = path.basename(absPath);
    const segments = absPath.split(path.sep);
    // Settings and MCP definitions, for coco and for the Claude-compatible directory.
    if (isInside(absPath, configDir()) && /^(settings.*|mcp.*|state)\.json$/.test(base)) return true;
    const parent = segments[segments.length - 2];
    if ((parent === PROJECT_DIR || parent === '.claude') && /^(settings.*|mcp.*)\.json$/.test(base)) return true;
    if (base === '.mcp.json') return true;
    // Anything inside a .git directory, and the .git entry itself.
    if (segments.includes('.git')) return true;
    if (path.dirname(absPath) === home && /^\.(bashrc|bash_profile|bash_login|bash_logout|zshrc|zprofile|zshenv|zlogin|profile|gitconfig|npmrc|inputrc)$/.test(base)) return true;
    if (isInside(absPath, path.join(home, '.ssh'))) return true;
    return false;
  }

  private askOutcome(req: PermissionRequest, reason?: string, warning?: string): PermissionOutcome {
    return { behavior: 'ask', request: req, suggestions: this.suggest(req), warning, reason };
  }

  private suggest(req: PermissionRequest): Suggestion[] {
    const cwd = this.session.cwd;
    switch (req.kind) {
      case 'bash': {
        if (!req.target) return [];
        const analysis = analyzeCommand(req.target);
        if (analysis.hasSubstitution || analysis.complex) return [];
        const needed = [...new Set(this.uncovered(analysis, this.bashAllowRules()).map((simple) => suggestBashRule(simple)))];
        if (needed.length === 0 || needed.length > 4) return [];
        return [
          {
            label: `Yes, and don't ask again for ${needed.map((r) => r.replace(/:\*$/, '')).join(', ')} commands in this project`,
            rules: needed.map((r) => `Bash(${r})`),
            scope: 'local',
          },
        ];
      }
      case 'edit': {
        if (req.target && this.isProtectedPath(req.target)) return [];
        if (req.target && !this.session.inWorkingDirs(req.target)) {
          const dir = path.dirname(req.target);
          return [{ label: `Yes, and allow edits in ${displayPath(dir, cwd)} this session`, addDir: dir, mode: 'acceptEdits' }];
        }
        return [{ label: 'Yes, and allow all edits this session', mode: 'acceptEdits' }];
      }
      case 'read': {
        if (!req.target) return [];
        const dir = path.dirname(req.target);
        return [{ label: `Yes, and allow reading from ${displayPath(dir, cwd)} this session`, rules: [`Read(/${dir}/**)`] }];
      }
      case 'web': {
        if (req.target?.startsWith('domain:')) {
          return [{ label: `Yes, and don't ask again for ${req.target.slice(7)}`, rules: [`${req.tool}(${req.target})`], scope: 'local' }];
        }
        return [{ label: `Yes, and don't ask again for ${req.tool}`, rules: [req.tool], scope: 'local' }];
      }
      case 'mcp': {
        const server = req.tool.split('__').slice(0, 2).join('__');
        return [
          { label: "Yes, and don't ask again for this tool in this project", rules: [req.tool], scope: 'local' },
          { label: `Yes, and don't ask again for any ${server.replace('mcp__', '')} tool`, rules: [server], scope: 'local' },
        ];
      }
      default:
        return [{ label: `Yes, and don't ask again for ${req.tool} this session`, rules: [req.tool] }];
    }
  }
}

/** Order used when cycling modes with shift+tab. */
export const MODE_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan'];

export function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'default':
      return 'ask before edits';
    case 'acceptEdits':
      return 'accept edits';
    case 'plan':
      return 'plan mode';
    case 'bypassPermissions':
      return 'bypass permissions';
    case 'dontAsk':
      return "don't ask";
  }
}
