import { spawn } from 'node:child_process';
import type { HookCommand, HookEvent, HooksConfig } from '../config/settings.ts';
import { isRecord } from '../util/json.ts';
import { commandEnv, killTree, shellPath } from '../tools/shell.ts';

export interface HookOutcome {
  /** The hook vetoed the action (exit code 2 or decision "block"). */
  blocked: boolean;
  /** Feedback for the model when blocked. */
  reason?: string;
  /** Extra context to add to the conversation. */
  additionalContext?: string;
  /** PreToolUse only: overrides the normal permission check. */
  permissionDecision?: 'allow' | 'deny' | 'ask';
  updatedInput?: Record<string, unknown>;
  /** The hook asked the agent to stop entirely (`continue: false`). */
  stop?: boolean;
  stopReason?: string;
  /** Messages for the user: warnings, hook stderr, systemMessage output. */
  messages: string[];
}

interface RawResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Killed because the turn was interrupted; not a hook failure. */
  aborted: boolean;
}

export interface HookBase {
  sessionId: string;
  transcriptPath?: string;
  projectRoot: string;
  cwd: () => string;
  permissionMode?: () => string;
}

/** Seconds a command hook may run when it sets no timeout of its own. */
const DEFAULT_TIMEOUT = 600;
const PROMPT_TIMEOUT = 30;
/** Hook output added to the conversation is capped so one hook cannot flood the context. */
const OUTPUT_CAP = 10_000;

function capOutput(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return `${text.slice(0, OUTPUT_CAP)}\n… [hook output truncated: ${text.length - OUTPUT_CAP} more characters]`;
}

function runHookCommand(hook: HookCommand, stdin: string, cwd: string, projectRoot: string, signal?: AbortSignal, defaultSeconds = DEFAULT_TIMEOUT): Promise<RawResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true });
      return;
    }
    const { shell, args } = shellPath();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let done = false;
    const proc = spawn(shell, args(hook.command), {
      cwd,
      env: commandEnv({ COCO_PROJECT_DIR: projectRoot, CLAUDE_PROJECT_DIR: projectRoot }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    };
    const seconds = typeof hook.timeout === 'number' && hook.timeout > 0 ? hook.timeout : defaultSeconds;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc, 'SIGKILL');
    }, seconds * 1000);
    const onAbort = () => {
      aborted = true;
      killTree(proc, 'SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Decode as streams so a multi-byte character split across chunks survives.
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => (stdout += d));
    proc.stderr.on('data', (d: string) => (stderr += d));
    proc.on('error', (err) => {
      stderr += err.message;
      finish(1);
    });
    proc.on('close', (code) => finish(code));
    proc.stdin.on('error', () => {}); // hook may exit without reading stdin
    proc.stdin.end(stdin);
  });
}

/**
 * A matcher made only of letters, digits, `_`, `-`, spaces, `,` and `|` is an
 * exact name or a list of names. Anything else is an unanchored regular expression.
 */
export function matcherApplies(matcher: string | undefined, subject: string | undefined): boolean {
  if (!matcher || matcher === '*' || matcher === '') return true;
  if (subject === undefined) return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher
      .split(/[,|]/)
      .map((name) => name.trim())
      .filter(Boolean)
      .includes(subject);
  }
  try {
    return new RegExp(matcher).test(subject);
  } catch {
    return matcher === subject;
  }
}

/** Events whose plain stdout is added to the model's context (for PreCompact: to the summary instructions). */
const CONTEXT_EVENTS = new Set<HookEvent>(['UserPromptSubmit', 'SessionStart', 'PreCompact']);

export class HookRunner {
  private readonly getConfig: () => HooksConfig | undefined;
  private readonly base: HookBase;

  constructor(getConfig: () => HooksConfig | undefined, base: HookBase) {
    this.getConfig = getConfig;
    this.base = base;
  }

  /** Matchers for an event, tolerating hand-written settings of the wrong shape. */
  private matchers(event: HookEvent): { matcher?: string; commands: HookCommand[] }[] {
    const raw: unknown = this.getConfig()?.[event];
    if (!Array.isArray(raw)) return [];
    const out: { matcher?: string; commands: HookCommand[] }[] = [];
    for (const entry of raw as unknown[]) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
      const commands = (entry.hooks as unknown[]).filter(
        (h): h is HookCommand => isRecord(h) && h.type === 'command' && typeof h.command === 'string' && h.command.trim() !== '',
      );
      if (commands.length) out.push({ matcher: typeof entry.matcher === 'string' ? entry.matcher : undefined, commands });
    }
    return out;
  }

  has(event: HookEvent): boolean {
    return this.matchers(event).length > 0;
  }

  /** All configured hooks, for display. */
  list(): { event: HookEvent; matcher: string; command: string }[] {
    const out: { event: HookEvent; matcher: string; command: string }[] = [];
    for (const event of Object.keys(this.getConfig() ?? {}) as HookEvent[]) {
      for (const m of this.matchers(event)) {
        for (const h of m.commands) out.push({ event, matcher: m.matcher || '*', command: h.command });
      }
    }
    return out;
  }

  /**
   * Run every hook registered for `event`. `subject` is what matchers test:
   * the tool name for tool events, the trigger for SessionStart/PreCompact.
   */
  async run(event: HookEvent, payload: Record<string, unknown>, subject?: string, signal?: AbortSignal): Promise<HookOutcome> {
    const outcome: HookOutcome = { blocked: false, messages: [] };
    const commands: HookCommand[] = [];
    const seen = new Set<string>();
    for (const m of this.matchers(event)) {
      if (!matcherApplies(m.matcher, subject)) continue;
      for (const h of m.commands) {
        if (seen.has(h.command)) continue;
        seen.add(h.command);
        commands.push(h);
      }
    }
    if (commands.length === 0) return outcome;

    const cwd = this.base.cwd();
    const stdin = JSON.stringify({
      session_id: this.base.sessionId,
      transcript_path: this.base.transcriptPath,
      cwd,
      permission_mode: this.base.permissionMode?.(),
      hook_event_name: event,
      ...payload,
    });

    // Prompt hooks hold up the user's message, so they get a short default. Hooks at
    // exit share a small budget, raised to the largest timeout any of them asks for.
    let defaultSeconds = event === 'UserPromptSubmit' ? PROMPT_TIMEOUT : DEFAULT_TIMEOUT;
    let hooksToRun = commands;
    if (event === 'SessionEnd') {
      const largest = Math.max(0, ...commands.map((h) => (typeof h.timeout === 'number' && h.timeout > 0 ? h.timeout : 0)));
      defaultSeconds = Math.min(60, Math.max(1.5, largest));
      hooksToRun = commands.map((h) => ({ ...h, timeout: defaultSeconds }));
    }
    const results = await Promise.all(hooksToRun.map((h) => runHookCommand(h, stdin, cwd, this.base.projectRoot, signal, defaultSeconds)));
    const contexts: string[] = [];
    const reasons: string[] = [];

    results.forEach((res, i) => {
      const command = commands[i]!.command;
      if (res.aborted) return; // the user interrupted; nothing to report
      if (res.timedOut) {
        outcome.messages.push(`${event} hook timed out: ${command}`);
        return;
      }
      if (res.code === 2) {
        outcome.blocked = true;
        reasons.push(res.stderr.trim() || `Blocked by ${event} hook.`);
        return;
      }
      if (res.code !== 0) {
        outcome.messages.push(`${event} hook failed (exit ${res.code}): ${command}${res.stderr.trim() ? `\n${res.stderr.trim()}` : ''}`);
        return;
      }
      const out = res.stdout.trim();
      if (!out) return;
      let json: Record<string, unknown> | undefined;
      if (out.startsWith('{')) {
        try {
          const parsed = JSON.parse(out) as unknown;
          if (isRecord(parsed)) json = parsed;
        } catch {
          // plain text output
        }
      }
      if (!json) {
        if (CONTEXT_EVENTS.has(event)) contexts.push(out);
        return;
      }
      if (json.continue === false) {
        outcome.stop = true;
        if (typeof json.stopReason === 'string') outcome.stopReason = json.stopReason;
      }
      if (typeof json.systemMessage === 'string') outcome.messages.push(json.systemMessage);
      if (json.decision === 'block') {
        outcome.blocked = true;
        reasons.push(typeof json.reason === 'string' ? json.reason : `Blocked by ${event} hook.`);
      }
      const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : undefined;
      if (specific) {
        const decision = specific.permissionDecision;
        if (decision === 'allow' || decision === 'deny' || decision === 'ask') {
          // deny beats ask beats allow when several hooks disagree
          const rank = { allow: 0, ask: 1, deny: 2 } as const;
          if (!outcome.permissionDecision || rank[decision] > rank[outcome.permissionDecision]) outcome.permissionDecision = decision;
          if (decision === 'deny') {
            outcome.blocked = true;
            reasons.push(typeof specific.permissionDecisionReason === 'string' ? specific.permissionDecisionReason : 'Denied by PreToolUse hook.');
          }
        }
        // PermissionRequest hooks answer the approval prompt: { decision: { behavior: "allow" | "deny" } }.
        const answer = isRecord(specific.decision) ? specific.decision : undefined;
        if (answer && (answer.behavior === 'allow' || answer.behavior === 'deny')) {
          if (answer.behavior === 'deny' || outcome.permissionDecision !== 'deny') outcome.permissionDecision = answer.behavior;
          if (answer.behavior === 'deny') {
            outcome.blocked = true;
            reasons.push(typeof answer.message === 'string' ? answer.message : 'Denied by PermissionRequest hook.');
          }
        }
        if (isRecord(specific.updatedInput)) outcome.updatedInput = specific.updatedInput;
        if (typeof specific.additionalContext === 'string') contexts.push(specific.additionalContext);
      }
    });

    if (reasons.length) outcome.reason = capOutput(reasons.join('\n'));
    if (contexts.length) outcome.additionalContext = capOutput(contexts.join('\n\n'));
    outcome.messages = outcome.messages.map(capOutput);
    return outcome;
  }
}
