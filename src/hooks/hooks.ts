import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { HookCommand, HookEvent, HookHandler, HookHttp, HookPrompt, HooksConfig } from '../config/settings.ts';
import { matchBashSpec, matchDomainSpec, matchPathSpec, parseRule, everyCommand } from '../permissions/rules.ts';
import { isRecord, parseJsonLoose } from '../util/json.ts';
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
  /** Ask the model a question, for prompt hooks. Absent before a model is connected. */
  complete?: (system: string, prompt: string, opts: { signal?: AbortSignal; model?: string }) => Promise<string>;
}

/** Seconds a command hook may run when it sets no timeout of its own. */
const DEFAULT_TIMEOUT = 600;
const PROMPT_TIMEOUT = 30;
/** Seconds a prompt hook (a model call) may take by default. */
const MODEL_HOOK_TIMEOUT = 30;
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

const seconds = (hook: HookHandler, fallback: number): number => (typeof hook.timeout === 'number' && hook.timeout > 0 ? hook.timeout : fallback);

/** Abort when the turn is interrupted or the hook's time is up; `timedOut` tells which. */
function deadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean; clear: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** POST the event to a URL. Only a 2xx reply counts: its body is treated like a command's stdout. */
async function runHookHttp(hook: HookHttp, stdin: string, signal: AbortSignal | undefined, defaultSeconds: number): Promise<RawResult> {
  if (signal?.aborted) return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true };
  const allowed = new Set(hook.allowedEnvVars ?? []);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(hook.headers ?? {})) {
    // Only variables the settings name explicitly are filled in; others become empty.
    headers[name] = String(value).replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a: string | undefined, b: string | undefined) => (allowed.has(a ?? b ?? '') ? (process.env[a ?? b ?? ''] ?? '') : ''));
  }
  const limit = deadline(signal, seconds(hook, defaultSeconds) * 1000);
  try {
    const res = await fetch(hook.url, { method: 'POST', headers, body: stdin, signal: limit.signal });
    const body = await res.text();
    if (!res.ok) return { code: 1, stdout: '', stderr: `HTTP ${res.status}${body.trim() ? `: ${body.trim().slice(0, 300)}` : ''}`, timedOut: false, aborted: false };
    return { code: 0, stdout: body, stderr: '', timedOut: false, aborted: false };
  } catch (err) {
    if (limit.timedOut()) return { code: null, stdout: '', stderr: '', timedOut: true, aborted: false };
    if (signal?.aborted) return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true };
    return { code: 1, stdout: '', stderr: (err as Error).message, timedOut: false, aborted: false };
  } finally {
    limit.clear();
  }
}

const PROMPT_HOOK_SYSTEM =
  'You are a policy check inside a coding agent. Judge the event described by the user message against the instruction given with it. ' +
  'Answer with only a JSON object: {"ok": true} to let it proceed, or {"ok": false, "reason": "<one sentence>"} to stop it.';

/** Let the model judge the event. A "not ok" verdict blocks, like a command hook printing decision "block". */
async function runHookPrompt(hook: HookPrompt, stdin: string, base: HookBase, signal: AbortSignal | undefined): Promise<RawResult> {
  if (signal?.aborted) return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true };
  if (!base.complete) return { code: 1, stdout: '', stderr: 'no model is connected yet', timedOut: false, aborted: false };
  const prompt = hook.prompt.includes('$ARGUMENTS') ? hook.prompt.split('$ARGUMENTS').join(stdin) : `${hook.prompt}\n\nEvent:\n${stdin}`;
  const limit = deadline(signal, seconds(hook, MODEL_HOOK_TIMEOUT) * 1000);
  try {
    const reply = await base.complete(PROMPT_HOOK_SYSTEM, prompt, { signal: limit.signal, model: hook.model });
    const start = reply.indexOf('{');
    const parsed = start >= 0 ? parseJsonLoose(reply.slice(start)) : { ok: false as const };
    const verdict = parsed.ok && isRecord(parsed.value) ? parsed.value : undefined;
    if (!verdict || typeof verdict.ok !== 'boolean') return { code: 1, stdout: '', stderr: `the model did not answer with {"ok": ...}: ${reply.trim().slice(0, 200)}`, timedOut: false, aborted: false };
    if (verdict.ok) return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    return { code: 0, stdout: JSON.stringify({ decision: 'block', reason: typeof verdict.reason === 'string' ? verdict.reason : 'Stopped by a prompt hook.' }), stderr: '', timedOut: false, aborted: false };
  } catch (err) {
    if (limit.timedOut()) return { code: null, stdout: '', stderr: '', timedOut: true, aborted: false };
    if (signal?.aborted) return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true };
    return { code: 1, stdout: '', stderr: (err as Error).message, timedOut: false, aborted: false };
  } finally {
    limit.clear();
  }
}

/** What a hook is, for messages and for dropping duplicates. */
function describeHook(hook: HookHandler): string {
  if (hook.type === 'http') return `POST ${hook.url}`;
  if (hook.type === 'prompt') return `prompt: ${hook.prompt.replace(/\s+/g, ' ').slice(0, 80)}`;
  return hook.command;
}

/**
 * The `if` field narrows a tool hook with permission-rule syntax: "Bash(git push *)",
 * "Edit(*.ts)", "WebFetch(domain:example.com)" or a bare tool name. A condition
 * that cannot be read never matches, so a typo does not run a hook on everything.
 */
export function conditionApplies(condition: string | undefined, payload: Record<string, unknown>, ctx: { cwd: string; projectRoot: string }): boolean {
  if (condition === undefined || condition.trim() === '') return true;
  const rule = parseRule(condition);
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : undefined;
  if (!rule || !tool) return false;
  const edits = ['edit', 'write', 'notebookedit'];
  const reads = ['read', 'grep', 'glob'];
  const want = rule.tool.toLowerCase();
  const have = tool.toLowerCase();
  // As in permission rules, Edit(...) covers every editing tool and Read(...) every reading one.
  const sameTool = want === have || (rule.spec !== undefined && ((want === 'edit' && edits.includes(have)) || (want === 'read' && reads.includes(have))));
  if (!sameTool) return false;
  if (rule.spec === undefined || rule.spec === '*') return true;
  const input = isRecord(payload.tool_input) ? payload.tool_input : {};
  if (have === 'bash') return typeof input.command === 'string' && everyCommand(input.command, (simple) => matchBashSpec(rule.spec!, simple));
  if (have === 'webfetch') {
    try {
      return matchDomainSpec(rule.spec, new URL(String(input.url)).hostname);
    } catch {
      return false;
    }
  }
  const file = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof file === 'string') return matchPathSpec(rule.spec, path.resolve(ctx.cwd, file), ctx);
  return false;
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
  private matchers(event: HookEvent): { matcher?: string; commands: HookHandler[] }[] {
    const raw: unknown = this.getConfig()?.[event];
    if (!Array.isArray(raw)) return [];
    const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
    const out: { matcher?: string; commands: HookHandler[] }[] = [];
    for (const entry of raw as unknown[]) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
      const commands = (entry.hooks as unknown[]).filter(
        (h): h is HookHandler =>
          isRecord(h) && ((h.type === 'command' && filled(h.command)) || (h.type === 'http' && filled(h.url) && /^https?:\/\//.test(String(h.url))) || (h.type === 'prompt' && filled(h.prompt))),
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
        for (const h of m.commands) out.push({ event, matcher: m.matcher || '*', command: describeHook(h) });
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
    const commands: HookHandler[] = [];
    const seen = new Set<string>();
    const cwd = this.base.cwd();
    for (const m of this.matchers(event)) {
      if (!matcherApplies(m.matcher, subject)) continue;
      for (const h of m.commands) {
        if (!conditionApplies(h.if, payload, { cwd, projectRoot: this.base.projectRoot })) continue;
        const id = `${h.type}:${describeHook(h)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        commands.push(h);
      }
    }
    if (commands.length === 0) return outcome;

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
    const results = await Promise.all(
      hooksToRun.map((h) => {
        if (h.type === 'http') return runHookHttp(h, stdin, signal, defaultSeconds);
        if (h.type === 'prompt') return runHookPrompt(h, stdin, this.base, signal);
        return runHookCommand(h, stdin, cwd, this.base.projectRoot, signal, defaultSeconds);
      }),
    );
    const contexts: string[] = [];
    const reasons: string[] = [];

    results.forEach((res, i) => {
      const command = describeHook(commands[i]!);
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
