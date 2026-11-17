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
}

export interface HookBase {
  sessionId: string;
  transcriptPath?: string;
  projectRoot: string;
  cwd: () => string;
  permissionMode?: () => string;
}

function runHookCommand(hook: HookCommand, stdin: string, cwd: string, projectRoot: string, signal?: AbortSignal): Promise<RawResult> {
  return new Promise((resolve) => {
    const { shell, args } = shellPath();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
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
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc, 'SIGKILL');
    }, (hook.timeout ?? 60) * 1000);
    const onAbort = () => killTree(proc, 'SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    proc.on('error', (err) => {
      stderr += err.message;
      finish(1);
    });
    proc.on('close', (code) => finish(code));
    proc.stdin.on('error', () => {}); // hook may exit without reading stdin
    proc.stdin.end(stdin);
  });
}

function matcherApplies(matcher: string | undefined, subject: string | undefined): boolean {
  if (!matcher || matcher === '*' || matcher === '') return true;
  if (subject === undefined) return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(subject);
  } catch {
    return matcher === subject;
  }
}

/** Events whose plain stdout is added to the model's context. */
const CONTEXT_EVENTS = new Set<HookEvent>(['UserPromptSubmit', 'SessionStart']);

export class HookRunner {
  private readonly getConfig: () => HooksConfig | undefined;
  private readonly base: HookBase;

  constructor(getConfig: () => HooksConfig | undefined, base: HookBase) {
    this.getConfig = getConfig;
    this.base = base;
  }

  has(event: HookEvent): boolean {
    return (this.getConfig()?.[event]?.length ?? 0) > 0;
  }

  /** All configured hooks, for display. */
  list(): { event: HookEvent; matcher: string; command: string }[] {
    const out: { event: HookEvent; matcher: string; command: string }[] = [];
    for (const [event, matchers] of Object.entries(this.getConfig() ?? {})) {
      for (const m of matchers ?? []) {
        for (const h of m.hooks ?? []) out.push({ event: event as HookEvent, matcher: m.matcher || '*', command: h.command });
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
    const matchers = this.getConfig()?.[event];
    if (!matchers?.length) return outcome;

    const commands: HookCommand[] = [];
    const seen = new Set<string>();
    for (const m of matchers) {
      if (!matcherApplies(m.matcher, subject)) continue;
      for (const h of m.hooks ?? []) {
        if (h?.type !== 'command' || !h.command || seen.has(h.command)) continue;
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

    const results = await Promise.all(commands.map((h) => runHookCommand(h, stdin, cwd, this.base.projectRoot, signal)));
    const contexts: string[] = [];
    const reasons: string[] = [];

    results.forEach((res, i) => {
      const command = commands[i]!.command;
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
        if (isRecord(specific.updatedInput)) outcome.updatedInput = specific.updatedInput;
        if (typeof specific.additionalContext === 'string') contexts.push(specific.additionalContext);
      }
    });

    if (reasons.length) outcome.reason = reasons.join('\n');
    if (contexts.length) outcome.additionalContext = contexts.join('\n\n');
    return outcome;
  }
}
