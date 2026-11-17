import * as os from 'node:os';
import * as path from 'node:path';
import { PROJECT_DIR, configDir, displayPath, expandHome } from '../config/paths.ts';
import type { PermissionSettings, SettingsScope } from '../config/settings.ts';
import { updateSettingsFile } from '../config/settings.ts';
import type { SessionState } from '../session/state.ts';
import { isInside } from '../session/state.ts';
import type { PermissionRequest, Tool, ToolContext } from '../tools/types.ts';
import type { PermissionMode } from '../types.ts';
import {
  analyzeCommand,
  dangerWarning,
  isFileSystemCommand,
  isReadOnlyCommand,
  pathArguments,
  suggestBashRule,
} from './bash.ts';
import type { Rule } from './rules.ts';
import { family, matchBashSpec, matchPathSpec, parseRule, parseRules, ruleMatches } from './rules.ts';

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

  private matchCtx() {
    return { cwd: this.session.cwd, projectRoot: this.session.projectRoot };
  }

  private allowRules(): Rule[] {
    return [...this.allow, ...this.sessionAllow];
  }

  /** A deny rule without a specifier removes the tool from the model's view entirely. */
  isToolDisabled(name: string): boolean {
    return this.deny.some((r) => r.spec === undefined && (r.tool === name || (name.startsWith('mcp__') && ruleMatches(r, name, null, this.matchCtx()))));
  }

  rules(): { allow: Rule[]; ask: Rule[]; deny: Rule[]; session: Rule[] } {
    return { allow: this.allow, ask: this.ask, deny: this.deny, session: this.sessionAllow };
  }

  addRule(behavior: 'allow' | 'ask' | 'deny', raw: string, scope?: SettingsScope): boolean {
    const rule = parseRule(raw, scope ?? 'session');
    if (!rule) return false;
    if (behavior === 'allow') (scope ? this.allow : this.sessionAllow).push(rule);
    else if (behavior === 'ask') this.ask.push(rule);
    else this.deny.push(rule);
    if (scope) {
      updateSettingsFile(scope, this.session.projectRoot, (s) => {
        s.permissions ??= {};
        const list = (s.permissions[behavior] ??= []);
        if (!list.includes(rule.raw)) list.push(rule.raw);
      });
    }
    return true;
  }

  removeRule(raw: string): boolean {
    let removed = false;
    for (const key of ['allow', 'ask', 'deny', 'sessionAllow'] as const) {
      const before = this[key].length;
      this[key] = this[key].filter((r) => r.raw !== raw.trim());
      if (this[key].length !== before) removed = true;
    }
    for (const scope of ['local', 'project', 'user'] as const) {
      try {
        updateSettingsFile(scope, this.session.projectRoot, (s) => {
          for (const behavior of ['allow', 'ask', 'deny'] as const) {
            const list = s.permissions?.[behavior];
            if (list?.includes(raw.trim())) {
              s.permissions![behavior] = list.filter((r) => r !== raw.trim());
              removed = true;
            }
          }
        });
      } catch {
        // unreadable settings file: nothing to remove there
      }
    }
    return removed;
  }

  /** Apply the option the user picked in an approval dialog. */
  applySuggestion(s: Suggestion): void {
    if (s.mode) this.mode = s.mode;
    if (s.addDir) this.session.addDir(s.addDir);
    for (const raw of s.rules ?? []) this.addRule('allow', raw, s.scope);
  }

  evaluate(tool: Tool, input: unknown, ctx: ToolContext): PermissionOutcome {
    const mctx = this.matchCtx();
    const req = tool.permission?.(input, ctx) ?? null;
    const readOnly = tool.isReadOnly(input);

    const denied = this.deny.find((r) => ruleMatches(r, tool.name, req, mctx));
    if (denied) return { behavior: 'deny', message: `Permission denied by rule ${denied.raw}. Do not retry; choose a different approach or ask the user.` };

    if (req?.kind === 'bash' && req.target) {
      const blocked = this.bashDeniedByRule(req.target);
      if (blocked) return { behavior: 'deny', message: `Permission denied by rule ${blocked}. Do not retry; choose a different approach or ask the user.` };
    }

    if (this.mode === 'plan' && !readOnly && !PLAN_MODE_TOOLS.has(tool.name)) {
      const bashReadOnly = req?.kind === 'bash' && req.target ? this.bashIsReadOnly(req.target) : false;
      if (!bashReadOnly) {
        return {
          behavior: 'deny',
          message:
            'Plan mode is active: you may only read and research, not change anything. ' +
            'Finish investigating, then call ExitPlanMode with your plan and wait for approval.',
        };
      }
    }

    if (!req) return { behavior: 'allow' };

    const asked = this.ask.find((r) => ruleMatches(r, tool.name, req, mctx));
    let outcome: PermissionOutcome;
    if (asked && this.mode !== 'bypassPermissions') {
      outcome = this.askOutcome(req, `Rule ${asked.raw} requires confirmation.`);
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
    const mctx = this.matchCtx();
    const rules = this.allowRules();

    if (req.kind === 'bash' && req.target !== undefined) return this.evaluateBash(req, req.target);

    const allowed = rules.find((r) => ruleMatches(r, tool.name, req, mctx));
    if (allowed) return { behavior: 'allow', reason: `rule ${allowed.raw}` };

    switch (req.kind) {
      case 'read':
        if (!req.target || this.session.inWorkingDirs(req.target)) return { behavior: 'allow' };
        return this.askOutcome(req);
      case 'edit':
        if (req.target && this.isProtectedPath(req.target)) {
          return this.askOutcome(req, 'This file controls how coco or your shell behaves.');
        }
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

  private evaluateBash(req: PermissionRequest, command: string): PermissionOutcome {
    const rules = this.allowRules().filter((r) => family(r.tool) === 'Bash');
    if (rules.some((r) => r.spec === undefined)) return { behavior: 'allow', reason: 'rule Bash' };
    // An exact rule for the whole line covers it regardless of structure.
    if (rules.some((r) => r.spec !== undefined && !r.spec.includes('*') && r.spec.trim() === command.trim())) {
      return { behavior: 'allow', reason: 'exact rule' };
    }

    const analysis = analyzeCommand(command);
    const warning = dangerWarning(command);
    const opaque = analysis.hasSubstitution || analysis.complex;

    if (!opaque && analysis.commands.length > 0) {
      const uncovered = analysis.commands.filter((simple) => !this.simpleCommandAllowed(simple, rules, analysis.hasWriteRedirect));
      if (uncovered.length === 0) return { behavior: 'allow' };
    }
    const reason = analysis.hasSubstitution
      ? 'The command uses substitution, so what it runs cannot be checked in advance.'
      : undefined;
    return this.askOutcome(req, reason, warning);
  }

  private simpleCommandAllowed(simple: string, rules: Rule[], hasWriteRedirect: boolean): boolean {
    if (rules.some((r) => r.spec !== undefined && matchBashSpec(r.spec, simple))) return true;
    if (hasWriteRedirect) return false;
    const pathsOk = pathArguments(simple).every((p) => this.session.inWorkingDirs(this.resolve(p)) || p === '/dev/null');
    if (isReadOnlyCommand(simple)) return pathsOk;
    if (this.mode === 'acceptEdits' && isFileSystemCommand(simple)) return pathsOk;
    return false;
  }

  private bashIsReadOnly(command: string): boolean {
    const analysis = analyzeCommand(command);
    if (analysis.hasSubstitution || analysis.complex || analysis.hasWriteRedirect) return false;
    return analysis.commands.length > 0 && analysis.commands.every(isReadOnlyCommand);
  }

  /** Best effort: Read/Edit deny rules also block shell commands that name the same paths. */
  private bashDeniedByRule(command: string): string | undefined {
    const fileDeny = this.deny.filter((r) => r.spec !== undefined && (family(r.tool) === 'Read' || family(r.tool) === 'Edit'));
    const bashDeny = this.deny.filter((r) => r.spec !== undefined && family(r.tool) === 'Bash');
    if (fileDeny.length === 0 && bashDeny.length === 0) return undefined;
    const mctx = this.matchCtx();
    for (const simple of analyzeCommand(command).commands) {
      const hit = bashDeny.find((r) => matchBashSpec(r.spec!, simple));
      if (hit) return hit.raw;
      for (const p of pathArguments(simple)) {
        const abs = this.resolve(p);
        const rule = fileDeny.find((r) => matchPathSpec(r.spec!, abs, mctx));
        if (rule) return rule.raw;
      }
    }
    return undefined;
  }

  private resolve(p: string): string {
    return path.resolve(this.session.cwd, expandHome(p));
  }

  /** Files that change what runs on this machine; edits always need a human. */
  private isProtectedPath(absPath: string): boolean {
    const home = os.homedir();
    const base = path.basename(absPath);
    if (isInside(absPath, configDir()) && /settings.*\.json$|mcp\.json$/.test(base)) return true;
    if (absPath.includes(`${path.sep}${PROJECT_DIR}${path.sep}`) && /^settings.*\.json$/.test(base)) return true;
    if (absPath.includes(`${path.sep}.git${path.sep}`)) return true;
    if (path.dirname(absPath) === home && /^\.(bashrc|bash_profile|zshrc|zprofile|profile|gitconfig|npmrc)$/.test(base)) return true;
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
        const rules = this.allowRules().filter((r) => family(r.tool) === 'Bash');
        const needed = [
          ...new Set(
            analysis.commands
              .filter((simple) => !this.simpleCommandAllowed(simple, rules, false))
              .map((simple) => suggestBashRule(simple)),
          ),
        ];
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
