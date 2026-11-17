import { DEFAULTS, type Settings } from '../config/settings.ts';
import type { HookRunner } from '../hooks/hooks.ts';
import type { PermissionManager, Suggestion } from '../permissions/manager.ts';
import type { ModelClient } from '../providers/index.ts';
import { TRUNCATED_ARGS } from '../providers/textTools.ts';
import { ProviderError, isTransientError } from '../providers/types.ts';
import type { SessionState } from '../session/state.ts';
import * as fs from 'node:fs';
import { displayPath } from '../config/paths.ts';
import { renderTodos } from '../tools/meta.ts';
import { spillOutput } from '../tools/spill.ts';
import { toolSpecs } from '../tools/registry.ts';
import type { FileDiff, PermissionRequest, RuntimeHandle, Tool, ToolContext, ToolResult } from '../tools/types.ts';
import type { AssistantMessage, ContentPart, Message, ToolCall, ToolResultMessage, Usage, UserMessage } from '../types.ts';
import { debug } from '../util/debug.ts';
import { validateInput } from '../util/schema.ts';
import { carryBudget, fitSkills, microcompact, recentTail, summarize, summaryMessage } from './compact.ts';
import { TokenCalibrator, estimateTokens, messagesTokens, toolSpecTokens } from './tokens.ts';

export type DoneReason = 'stop' | 'aborted' | 'max_turns' | 'error' | 'rejected' | 'hook_stop';

export type AgentEvent =
  | { type: 'stream_start' }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'assistant'; message: AssistantMessage }
  /** A queued user message was delivered to the model mid-turn. */
  | { type: 'user_message'; message: UserMessage }
  | { type: 'tool_start'; call: ToolCall; label: string }
  | { type: 'tool_progress'; id: string; text: string }
  | { type: 'tool_end'; call: ToolCall; result: ToolResult; durationMs: number }
  | { type: 'usage'; usage: Usage }
  /** Output is being generated that is not displayed yet (tool-call arguments). */
  | { type: 'progress'; chars: number }
  /** A failed request is about to be tried again. */
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string; status?: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'compact'; phase: 'start' | 'end'; before?: number; after?: number; auto: boolean }
  | { type: 'done'; reason: DoneReason; error?: string };

export interface PermissionPrompt {
  toolName: string;
  call: ToolCall;
  request: PermissionRequest;
  suggestions: Suggestion[];
  warning?: string;
  reason?: string;
  diff?: FileDiff | null;
}

export interface PermissionAnswer {
  allow: boolean;
  suggestion?: Suggestion;
  /** What the user wants done instead, when they said no. */
  feedback?: string;
}

/** Sink for anything that should be persisted to the transcript. */
export interface TranscriptSink {
  message(msg: Message): void;
  compacted(messages: Message[]): void;
}

export interface AgentDeps {
  client: ModelClient;
  tools: () => Tool[];
  system: () => string;
  session: SessionState;
  permissions: PermissionManager;
  hooks: HookRunner;
  runtime: RuntimeHandle;
  settings: Settings;
  depth: number;
  /** Absent in headless runs: anything that would prompt is denied instead. */
  requestPermission?: (prompt: PermissionPrompt) => Promise<PermissionAnswer>;
  transcript?: TranscriptSink;
  maxTurns?: number;
  /** Messages the user typed while the agent was busy. */
  drainQueued?: () => UserMessage[];
  /** Wait between retries. Replaceable so tests do not actually wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The nth model to fall back to when the session model fails for a reason retrying will not fix. */
  fallback?: (index: number) => Promise<ModelClient | undefined>;
  /** Session state to restate after compaction: skills invoked so far and the approved plan. */
  carryOver?: () => { skills?: { name: string; content: string }[]; plan?: string };
  /** Called after compaction replaced the conversation. */
  onCompacted?: () => void;
  /** Extra text for the model after a successful tool call (instructions that apply to the file just touched). */
  afterTool?: (toolName: string, input: Record<string, unknown>) => string | undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** A push/pull bridge so concurrent tool runs can emit events through one generator. */
class EventQueue<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

/** Names models reach for when they have seen other agents' tool sets. */
const TOOL_ALIASES: Record<string, string> = {
  read_file: 'Read',
  view_file: 'Read',
  cat: 'Read',
  write_file: 'Write',
  create_file: 'Write',
  edit_file: 'Edit',
  str_replace: 'Edit',
  str_replace_editor: 'Edit',
  replace_in_file: 'Edit',
  run_shell_command: 'Bash',
  execute_command: 'Bash',
  run_command: 'Bash',
  shell: 'Bash',
  run_terminal_cmd: 'Bash',
  list_files: 'Glob',
  find_files: 'Glob',
  search_files: 'Grep',
  grep_search: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  task: 'Agent',
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const INTERRUPT_NOTE = '[Request interrupted by user]';
const CUT_OFF_NOTE =
  'Your reply was cut off at the output limit. Continue exactly where it stopped, without repeating anything. If you were about to call a tool, call it now.';
const DROPPED_NOTE =
  'The connection dropped while you were replying, so your last message is incomplete. Continue exactly where it stopped, without repeating what you already wrote. If you were about to call a tool, call it now.';
const ANNOUNCED_NOTE =
  'Your last message says what you are about to do, but it contained no tool call, so nothing happened. If there is more to do, call the tool now. If the task is finished, or you need something from the user, say so plainly instead.';

const ACTION_VERBS =
  'read|check|look|open|search|find|run|execute|create|write|edit|update|modify|change|fix|add|remove|delete|implement|start|begin|examine|inspect|explore|review|verify|test|list|view|see|try|install|build|make|apply|call|use|grep|fetch|analy[sz]e|investigate|proceed|continue|take|go|do|get|gather|scan|locate|refactor|rename|move|replace|rewrite|debug|compile|commit|set up|dig';
const ANNOUNCES = new RegExp(
  `^(?:(?:ok(?:ay)?|alright|great|good|perfect|sure|now|next|first|then|so|finally|after that)[,.!]?\\s+)*` +
    `(?:let me|let's|let us|i'll|i will|i am going to|i'm going to|i need to|i should|i'm now going to|now i'll|now i will|going to|time to)\\s+` +
    `(?:(?:now|first|also|then|just|quickly|go ahead and|start by|begin by|try to|need to)\\s+)*(?:${ACTION_VERBS})\\b`,
  'i',
);
/** Signs that the model is waiting for the user rather than about to act. */
const WAITS_FOR_USER = /\?|\b(?:let me know|if you|once you|when you|after you|would you like|do you want|should i|shall i|please (?:confirm|provide|tell|let|share|specify)|your (?:confirmation|approval|input|permission|go-ahead))\b/i;

/**
 * Does a reply without tool calls end by announcing an action ("Let me read
 * the file.")? Small local models do this often: they describe the next step
 * and stop, and the turn ends with nothing done. Only the closing sentence
 * counts, and anything that reads as waiting for the user does not.
 */
export function announcesAction(text: string): boolean {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last || last.length > 300) return false;
  // The closing sentence of the last line, without list markers or emphasis.
  const plain = last.replace(/^(?:[-*>#]+|\d+[.)])\s*/, '').replace(/[*_`]/g, '');
  const sentences = plain.split(/(?<=[.!?])\s+/).filter(Boolean);
  const closing = sentences[sentences.length - 1] ?? plain;
  if (WAITS_FOR_USER.test(plain)) return false;
  return ANNOUNCES.test(closing);
}

/** How many times a reply cut off at the output limit is continued automatically. */
const MAX_CONTINUATIONS = 2;
/** How many times in a row a reply cut off by a dropped connection is continued. */
const MAX_DROP_CONTINUATIONS = 3;
/** Rounds in a row where no tool call could be run before the turn is ended. */
const MAX_UNUSABLE_ROUNDS = 3;
/** Times in a row a Stop hook may send the model back to work. */
const STOP_HOOK_BLOCK_CAP = 8;
/** Compactions in a row that fail to get under the limit before giving up. */
const MAX_INEFFECTIVE_COMPACTIONS = 3;
const REPEAT_LIMIT = 3;
/** Polling tools legitimately repeat with identical arguments. */
const REPEAT_EXEMPT = new Set(['BashOutput']);

export class Agent {
  messages: Message[] = [];
  /** Totals across the session, for /usage. */
  totals = { inputTokens: 0, outputTokens: 0, requests: 0, toolUses: 0, evalMs: 0, compactions: 0 };
  lastUsage?: Usage;
  private readonly deps: AgentDeps;
  private readonly calibrator = new TokenCalibrator();
  /** messages.length at the point `lastUsage` was measured. */
  private usageIndex = 0;
  private permissionLock: Promise<void> = Promise.resolve();
  private lastFingerprint = '';
  private repeatCount = 0;
  private warnedTooSmall = false;
  private unusableRounds = 0;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  get client(): ModelClient {
    return this.deps.client;
  }

  setClient(client: ModelClient): void {
    this.deps.client = client;
    this.lastUsage = undefined;
    this.usageIndex = 0;
  }

  private push(msg: Message): void {
    this.messages.push(msg);
    this.deps.transcript?.message(msg);
  }

  /** Replace the conversation (resume, rewind, clear). */
  load(messages: Message[]): void {
    this.messages = messages;
    this.lastUsage = undefined;
    this.usageIndex = 0;
  }

  private activeTools(): Tool[] {
    return this.deps.tools().filter((t) => !this.deps.permissions.isToolDisabled(t.name));
  }

  /** Estimated tokens the next request will occupy. */
  contextTokens(): number {
    if (this.lastUsage && this.usageIndex > 0 && this.usageIndex <= this.messages.length) {
      const added = this.calibrator.apply(messagesTokens(this.messages.slice(this.usageIndex)));
      return this.lastUsage.inputTokens + this.lastUsage.outputTokens + added;
    }
    return this.calibrator.apply(this.estimateRequest());
  }

  private estimateRequest(): number {
    return estimateTokens(this.deps.system()) + toolSpecTokens(toolSpecs(this.activeTools())) + messagesTokens(this.messages);
  }

  /** Breakdown for /context. */
  contextBreakdown(): { system: number; tools: number; messages: number; total: number; window: number } {
    const system = this.calibrator.apply(estimateTokens(this.deps.system()));
    const tools = this.calibrator.apply(toolSpecTokens(toolSpecs(this.activeTools())));
    const total = this.contextTokens();
    return { system, tools, messages: Math.max(0, total - system - tools), total, window: this.client.profile.contextWindow };
  }

  private compactLimit(): number {
    const profile = this.client.profile;
    const reserve = Math.min(profile.maxOutputTokens, Math.floor(profile.contextWindow / 4));
    const threshold = this.deps.settings.compactThreshold ?? DEFAULTS.compactThreshold;
    return Math.floor((profile.contextWindow - reserve) * threshold);
  }

  /** Start a turn with a new user message. */
  async *run(content: string | ContentPart[], signal: AbortSignal, opts: { isMeta?: boolean } = {}): AsyncGenerator<AgentEvent> {
    const msg: UserMessage = { role: 'user', content };
    if (opts.isMeta) msg.isMeta = true;
    this.push(msg);
    yield* this.loop(signal);
  }

  /** Continue from the current messages without adding a user turn. */
  async *resume(signal: AbortSignal): AsyncGenerator<AgentEvent> {
    yield* this.loop(signal);
  }

  private async *loop(signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const { deps } = this;
    let turns = 0;
    let lengthRetried = false;
    let emptyRetried = false;
    let announcedNudged = false;
    let overflowRetried = false;
    let stopHookBlocks = 0;
    let maxTokens: number | undefined;
    let transientRetries = 0;
    let continuations = 0;
    let dropContinuations = 0;
    let ineffectiveCompactions = 0;
    let fallbackIndex = 0;
    // The model for this turn: the session model, or a fallback after it failed.
    let client = deps.client;
    this.unusableRounds = 0;
    const maxRetries = deps.settings.maxRetries ?? DEFAULTS.maxRetries;

    for (;;) {
      if (signal.aborted) {
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      if (deps.maxTurns !== undefined && turns >= deps.maxTurns) {
        yield { type: 'notice', level: 'warn', text: `Stopped after ${deps.maxTurns} turns (max-turns limit).` };
        yield { type: 'done', reason: 'max_turns' };
        return;
      }
      turns++;

      if ((deps.settings.autoCompact ?? true) && this.contextTokens() > this.compactLimit()) {
        // Summarising only helps when the conversation is what fills the window. If the
        // system prompt and tool definitions alone are too big, compacting every turn
        // would burn a model call each time and free nothing.
        const conversation = this.calibrator.apply(messagesTokens(this.messages));
        if (conversation > deps.client.profile.contextWindow * 0.15) {
          yield* this.compact(signal, { auto: true });
          if (signal.aborted) {
            yield { type: 'done', reason: 'aborted' };
            return;
          }
          // Compaction that leaves the context over the limit will not do better by repeating.
          if (this.contextTokens() > this.compactLimit()) {
            if (++ineffectiveCompactions >= MAX_INEFFECTIVE_COMPACTIONS) {
              yield {
                type: 'done',
                reason: 'error',
                error:
                  'Compaction is thrashing: the context was still over the limit after compacting three times in a row. ' +
                  'A single file or tool result is probably too large for this context window. Use a larger context (--context), read large files in pieces, or /clear and restate the task.',
              };
              return;
            }
          } else {
            ineffectiveCompactions = 0;
          }
        } else if (!this.warnedTooSmall) {
          this.warnedTooSmall = true;
          yield {
            type: 'notice',
            level: 'warn',
            text:
              `The context window (${deps.client.profile.contextWindow} tokens) is nearly filled by the system prompt and tool definitions alone. ` +
              'Use a larger context (--context, or reload the model with more), limit tools with --tools, or shorten your memory files.',
          };
        }
      }

      const tools = this.activeTools();
      const specs = toolSpecs(tools);
      const system = deps.system();
      const estimated = estimateTokens(system) + toolSpecTokens(specs) + messagesTokens(this.messages);
      yield { type: 'stream_start' };

      let text = '';
      let thinking = '';
      const calls: ToolCall[] = [];
      let usage: Usage | undefined;
      let stopReason: AssistantMessage['stopReason'] = 'stop';
      const started = Date.now();
      let firstTokenAt = 0;

      try {
        try {
        for await (const ev of client.chat({ system, messages: this.messages, tools: specs, signal, maxTokens })) {
          if (ev.type === 'text') {
            firstTokenAt ||= Date.now();
            text += ev.text;
            yield { type: 'text', text: ev.text };
          } else if (ev.type === 'thinking') {
            firstTokenAt ||= Date.now();
            thinking += ev.text;
            yield { type: 'thinking', text: ev.text };
          } else if (ev.type === 'tool_call') {
            firstTokenAt ||= Date.now();
            calls.push(ev.call);
          } else if (ev.type === 'usage') {
            usage = ev.usage;
          } else if (ev.type === 'progress') {
            firstTokenAt ||= Date.now();
            yield { type: 'progress', chars: ev.chars };
          } else if (ev.type === 'done') {
            stopReason = ev.stopReason;
          }
        }
        } catch (dropped) {
          // Tool calls that arrived whole before the connection failed are still good: run them.
          if (signal.aborted || !isTransientError(dropped) || calls.length === 0) throw dropped;
          stopReason = 'tool_calls';
          yield { type: 'notice', level: 'warn', text: 'The connection dropped after the model had requested tools. Running those; the reply above may be incomplete.' };
        }
        transientRetries = 0;
        dropContinuations = 0;
      } catch (err) {
        const aborted = signal.aborted || (err instanceof ProviderError && err.kind === 'aborted');
        if (aborted) {
          if (text.trim()) this.push({ role: 'assistant', content: text, stopReason: 'aborted' });
          this.push({ role: 'user', content: INTERRUPT_NOTE, isMeta: true });
          yield { type: 'done', reason: 'aborted' };
          return;
        }
        if (err instanceof ProviderError && err.kind === 'context_overflow' && !overflowRetried) {
          overflowRetried = true;
          yield { type: 'notice', level: 'warn', text: 'The request did not fit in the context window. Compacting and retrying.' };
          yield* this.compact(signal, { auto: true, force: true });
          turns--;
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        // Transient failures (server restarting, model loading, a dropped connection, a stall)
        // are retried with backoff. A stall already cost a long wait, so it gets one more try.
        const allowed = err instanceof ProviderError && err.kind === 'timeout' ? Math.min(1, maxRetries) : maxRetries;
        if (isTransientError(err) && transientRetries < allowed && (!text.trim() || dropContinuations < MAX_DROP_CONTINUATIONS)) {
          transientRetries++;
          if (text.trim()) {
            dropContinuations++;
            // What was already shown is kept, and the model is asked to carry on from it.
            const partial: AssistantMessage = { role: 'assistant', content: text, model: client.model, stopReason: 'error' };
            this.push(partial);
            yield { type: 'assistant', message: partial };
            this.push({ role: 'user', isMeta: true, content: DROPPED_NOTE });
          }
          const delay = Math.min(32_000, 500 * 2 ** (transientRetries - 1));
          debug('api', `retry ${transientRetries}/${allowed} in ${delay}ms`, message);
          yield { type: 'retry', attempt: transientRetries, maxRetries: allowed, delayMs: delay, error: message.split('\n')[0]!, status: err instanceof ProviderError ? err.status : undefined };
          yield {
            type: 'notice',
            level: 'warn',
            text: `${message.split('\n')[0]} Retrying in ${delay < 1000 ? `${delay}ms` : `${Math.round(delay / 1000)}s`} (attempt ${transientRetries} of ${allowed}).`,
          };
          await (deps.sleep ?? sleep)(delay, signal);
          if (signal.aborted) {
            this.push({ role: 'user', content: INTERRUPT_NOTE, isMeta: true });
            yield { type: 'done', reason: 'aborted' };
            return;
          }
          turns--;
          continue;
        }
        // Not something a retry fixes (or retries ran out): try the next fallback model, if any.
        // Transport and request-size problems would fail the same way on another model.
        const kind = err instanceof ProviderError ? err.kind : 'other';
        if (deps.fallback && kind !== 'connection' && kind !== 'timeout' && kind !== 'context_overflow') {
          const next = await deps.fallback(fallbackIndex++).catch(() => undefined);
          if (next) {
            client = next;
            transientRetries = 0;
            yield { type: 'notice', level: 'warn', text: `${message.split('\n')[0]} Switching to the fallback model ${next.model} for the rest of this turn.` };
            turns--;
            continue;
          }
        }
        yield { type: 'done', reason: 'error', error: message };
        return;
      }

      // Fill in speed when the server did not report it.
      const elapsed = Date.now() - (firstTokenAt || started);
      if (!usage) usage = { inputTokens: 0, outputTokens: this.calibrator.apply(estimateTokens(text + thinking)) };
      else if (usage.inputTokens > 0) this.calibrator.observe(estimated, usage.inputTokens);
      if (usage.tokensPerSecond === undefined && usage.outputTokens > 0 && elapsed > 200) {
        usage.tokensPerSecond = usage.outputTokens / (elapsed / 1000);
        usage.evalMs ??= elapsed;
      }
      this.totals.requests++;
      this.totals.inputTokens += usage.inputTokens;
      this.totals.outputTokens += usage.outputTokens;
      this.totals.evalMs += usage.evalMs ?? 0;
      yield { type: 'usage', usage };

      const assistant: AssistantMessage = { role: 'assistant', content: text, usage, model: client.model, stopReason };
      if (thinking) assistant.thinking = thinking;
      if (calls.length) assistant.toolCalls = calls;

      const recordUsage = () => {
        if (usage!.inputTokens > 0) {
          this.lastUsage = usage;
          this.usageIndex = this.messages.length;
        }
      };

      if (calls.length === 0) {
        if (stopReason === 'length' && !text.trim()) {
          // Typical of reasoning models: the budget went on thinking and nothing was answered.
          if (!lengthRetried) {
            lengthRetried = true;
            const current = maxTokens ?? client.profile.maxOutputTokens;
            maxTokens = Math.min(current * 2, Math.floor(client.profile.contextWindow / 2));
            yield { type: 'notice', level: 'warn', text: `The model used its whole output budget before answering (often on reasoning). Retrying with ${maxTokens} tokens.` };
            continue;
          }
          yield {
            type: 'done',
            reason: 'error',
            error: 'The model ran out of output tokens before producing an answer. Raise maxOutputTokens, or turn reasoning off with /think off.',
          };
          return;
        }
        if (!text.trim()) {
          if (!emptyRetried) {
            emptyRetried = true;
            this.push({ role: 'user', isMeta: true, content: 'Your last reply was empty. Continue the task: call a tool, or give your answer.' });
            continue;
          }
          yield { type: 'done', reason: 'error', error: 'The model returned an empty response twice. Try rephrasing, or check that the context window is large enough (/context).' };
          return;
        }
        this.push(assistant);
        recordUsage();
        yield { type: 'assistant', message: assistant };
        if (stopReason === 'length') {
          if (continuations < MAX_CONTINUATIONS) {
            continuations++;
            this.push({ role: 'user', isMeta: true, content: CUT_OFF_NOTE });
            yield { type: 'notice', level: 'info', text: 'The reply hit the output limit; continuing it.' };
            continue;
          }
          yield { type: 'notice', level: 'warn', text: 'The reply was cut off at the output token limit again. Say "continue" to carry on, or raise maxOutputTokens.' };
        }

        // A reply that ends by announcing a step, with no tool call, would end the turn with
        // nothing done. Point it out once; a second time the reply stands.
        if (stopReason !== 'length' && !announcedNudged && tools.length > 0 && deps.settings.nudgeAnnouncedActions !== false && announcesAction(text)) {
          announcedNudged = true;
          this.push({ role: 'user', isMeta: true, content: ANNOUNCED_NOTE });
          yield { type: 'notice', level: 'info', text: 'The model said what it would do next without doing it; asking it to go on.' };
          continue;
        }

        const hookEvent = deps.depth > 0 ? 'SubagentStop' : 'Stop';
        if (deps.hooks.has(hookEvent)) {
          const outcome = await deps.hooks.run(hookEvent, { stop_hook_active: stopHookBlocks > 0 }, undefined, signal);
          for (const m of outcome.messages) yield { type: 'notice', level: 'info', text: m };
          if (outcome.blocked && outcome.reason && stopHookBlocks < STOP_HOOK_BLOCK_CAP) {
            stopHookBlocks++;
            this.push({ role: 'user', isMeta: true, content: `A Stop hook asked you to keep going:\n${outcome.reason}` });
            continue;
          }
        }
        const queued = deps.drainQueued?.() ?? [];
        if (queued.length) {
          for (const q of queued) {
            this.push(q);
            yield { type: 'user_message', message: q };
          }
          continue;
        }
        yield { type: 'done', reason: 'stop' };
        return;
      }

      this.push(assistant);
      recordUsage();
      yield { type: 'assistant', message: assistant };

      const state = { rejected: false, hookStop: undefined as string | undefined };
      const results = yield* this.executeTools(calls, tools, signal, state);
      for (const r of results) this.push(r);
      this.totals.toolUses += calls.length;
      if (this.unusableRounds >= MAX_UNUSABLE_ROUNDS) {
        yield {
          type: 'done',
          reason: 'error',
          error:
            `The model produced tool calls that could not be run ${MAX_UNUSABLE_ROUNDS} times in a row (malformed arguments or unknown tools). ` +
            'This model may not handle tool calling reliably: try a larger context, --tool-mode prompt, or a model trained for tool use.',
        };
        return;
      }

      if (signal.aborted) {
        this.push({ role: 'user', content: INTERRUPT_NOTE, isMeta: true });
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      if (state.hookStop !== undefined) {
        yield { type: 'notice', level: 'info', text: state.hookStop || 'A hook stopped the session.' };
        yield { type: 'done', reason: 'hook_stop' };
        return;
      }
      if (state.rejected) {
        yield { type: 'done', reason: 'rejected' };
        return;
      }
      for (const q of deps.drainQueued?.() ?? []) {
        this.push(q);
        yield { type: 'user_message', message: q };
      }
    }
  }

  private resolveTool(name: string, tools: Tool[]): Tool | undefined {
    const exact = tools.find((t) => t.name === name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    const insensitive = tools.find((t) => t.name.toLowerCase() === lower);
    if (insensitive) return insensitive;
    const alias = TOOL_ALIASES[lower];
    if (alias) return tools.find((t) => t.name === alias);
    const squashed = lower.replace(/[_\-\s]/g, '');
    return tools.find((t) => t.name.toLowerCase().replace(/[_\-\s]/g, '') === squashed);
  }

  private async *executeTools(
    calls: ToolCall[],
    tools: Tool[],
    signal: AbortSignal,
    state: { rejected: boolean; hookStop: string | undefined },
  ): AsyncGenerator<AgentEvent, ToolResultMessage[]> {
    const queue = new EventQueue<AgentEvent>();
    const results = new Array<ToolResultMessage>(calls.length);

    // Validate up front so we know which calls may share a batch.
    const prepared = calls.map((call) => {
      const tool = this.resolveTool(call.name, tools);
      if (!tool) return { call, tool: undefined, input: undefined, error: `Unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(', ')}.` };
      if (call.parseError === TRUNCATED_ARGS) {
        return {
          call,
          tool,
          input: undefined,
          error:
            `Your ${tool.name} call was cut off before its arguments were complete (the reply hit the output limit), so it was not run. ` +
            'Send it again with less content in one call: for a large file, Write the first part and add the rest with Edit.',
        };
      }
      if (call.parseError) {
        return { call, tool, input: undefined, error: `The arguments for ${tool.name} were not valid JSON (${call.parseError}). Call the tool again with a valid JSON object.` };
      }
      let raw = call.arguments;
      if (tool.normalize) {
        try {
          raw = tool.normalize(raw);
        } catch {
          raw = call.arguments; // validation will report what is wrong
        }
      }
      const check = validateInput(tool.parameters, raw);
      if (!check.ok) return { call, tool, input: undefined, error: check.error };
      return { call, tool, input: check.value, error: undefined };
    });

    // A round where nothing could even be attempted counts toward giving up on the turn.
    this.unusableRounds = prepared.every((p) => !p.tool || p.error) ? this.unusableRounds + 1 : 0;

    // Consecutive read-only calls run together; anything else runs alone, in order.
    const batches: number[][] = [];
    let lastSafe = false;
    prepared.forEach((p, i) => {
      const safe = Boolean(p.tool && !p.error && p.tool.isReadOnly(p.input));
      if (safe && lastSafe) batches[batches.length - 1]!.push(i);
      else batches.push([i]);
      lastSafe = safe;
    });

    const runAll = (async () => {
      for (const batch of batches) {
        await Promise.all(
          batch.map(async (i) => {
            const p = prepared[i]!;
            let result: ToolResult;
            const started = Date.now();
            let announced = false;
            try {
              if (signal.aborted) result = { content: 'Not run: the user interrupted.', isError: true };
              else if (state.rejected) result = { content: 'Not run: the user rejected an earlier action in this turn.', isError: true };
              else if (!p.tool || p.error) result = { content: p.error ?? 'Unknown tool.', isError: true };
              else {
                announced = true; // runOne emits tool_start itself, with a label
                result = await this.runOne(p.tool, p.call, p.input!, signal, queue, state);
              }
            } catch (err) {
              result = { content: `Tool crashed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
            if (!announced) queue.push({ type: 'tool_start', call: p.call, label: '' });
            queue.push({ type: 'tool_end', call: p.call, result, durationMs: Date.now() - started });
            const msg: ToolResultMessage = { role: 'tool', toolCallId: p.call.id, name: p.tool?.name ?? p.call.name, content: result.content };
            if (result.isError) msg.isError = true;
            if (result.images?.length) msg.images = result.images;
            results[i] = msg;
          }),
        );
      }
    })().finally(() => queue.close());

    for await (const ev of queue) yield ev;
    await runAll;
    return results;
  }

  private async runOne(
    tool: Tool,
    call: ToolCall,
    initialInput: Record<string, unknown>,
    signal: AbortSignal,
    queue: EventQueue<AgentEvent>,
    state: { rejected: boolean; hookStop: string | undefined },
  ): Promise<ToolResult> {
    const { deps } = this;
    let input = initialInput;
    const session = deps.session;
    const ctx: ToolContext = {
      get cwd() {
        return session.cwd;
      },
      signal,
      settings: deps.settings,
      session,
      toolCallId: call.id,
      depth: deps.depth,
      runtime: deps.runtime,
      onProgress: (text) => queue.push({ type: 'tool_progress', id: call.id, text }),
    };

    let label = '';
    try {
      label = tool.label?.(input, ctx) ?? '';
    } catch {
      label = '';
    }
    queue.push({ type: 'tool_start', call: { ...call, name: tool.name }, label });

    // Identical calls in a row mean the model is stuck; break the loop before it burns the context.
    const fingerprint = `${tool.name}:${stableStringify(input)}`;
    if (fingerprint === this.lastFingerprint) this.repeatCount++;
    else {
      this.lastFingerprint = fingerprint;
      this.repeatCount = 1;
    }
    if (this.repeatCount >= REPEAT_LIMIT && !REPEAT_EXEMPT.has(tool.name)) {
      return {
        content:
          `You have made this exact ${tool.name} call ${this.repeatCount} times in a row; it was not run again because the result will not change. ` +
          'Use what you already have, try a different approach, or tell the user what is blocking you.',
        isError: true,
        summary: 'Skipped: repeated identical call',
      };
    }

    let hookDecision: 'allow' | 'ask' | undefined;
    if (deps.hooks.has('PreToolUse')) {
      const pre = await deps.hooks.run('PreToolUse', { tool_name: tool.name, tool_input: input, tool_use_id: call.id }, tool.name, signal);
      for (const m of pre.messages) queue.push({ type: 'notice', level: 'info', text: m });
      if (pre.stop) state.hookStop = pre.stopReason ?? '';
      if (pre.blocked) return { content: `Blocked by a PreToolUse hook: ${pre.reason ?? 'no reason given'}`, isError: true, summary: 'Blocked by hook' };
      if (pre.updatedInput) {
        const recheck = validateInput(tool.parameters, pre.updatedInput);
        if (recheck.ok) input = recheck.value;
      }
      if (pre.permissionDecision === 'allow' || pre.permissionDecision === 'ask') hookDecision = pre.permissionDecision;
    }

    const outcome = deps.permissions.evaluate(tool, input, ctx);
    if (outcome.behavior === 'deny') return { content: outcome.message, isError: true, summary: 'Denied', denied: true };
    const mustAsk = outcome.behavior === 'ask' && hookDecision !== 'allow';
    const hookForcesAsk = hookDecision === 'ask' && outcome.behavior === 'allow' && deps.permissions.mode !== 'bypassPermissions';
    if (mustAsk || hookForcesAsk) {
      const request: PermissionRequest =
        outcome.behavior === 'ask' ? outcome.request : (tool.permission?.(input, ctx) ?? { tool: tool.name, kind: 'other', description: tool.name });
      // A PermissionRequest hook may answer in place of the user (useful in unattended runs).
      let hookAnswer: 'allow' | 'deny' | 'ask' | undefined;
      if (deps.hooks.has('PermissionRequest')) {
        const asked = await deps.hooks.run(
          'PermissionRequest',
          { tool_name: tool.name, tool_input: input, permission_suggestions: outcome.behavior === 'ask' ? outcome.suggestions.map((s) => s.label) : [] },
          tool.name,
          signal,
        );
        for (const m of asked.messages) queue.push({ type: 'notice', level: 'info', text: m });
        hookAnswer = asked.permissionDecision;
        if (hookAnswer === 'deny') return { content: `Denied by a PermissionRequest hook: ${asked.reason ?? 'no reason given'}`, isError: true, summary: 'Denied by hook', denied: true };
      }
      if (hookAnswer === 'allow') {
        // approved by the hook: fall through to execution
      } else if (!deps.requestPermission) {
        return {
          content:
            `Permission is required to ${request.description}, and this session cannot ask the user. ` +
            'Continue without it if you can; otherwise explain what you needed.',
          isError: true,
          summary: 'Permission required',
          denied: true,
        };
      } else {
      let diff: FileDiff | null | undefined;
      try {
        diff = tool.preview?.(input, ctx);
      } catch {
        diff = undefined;
      }
      const answer = await this.askPermission({
        toolName: tool.name,
        call,
        request,
        suggestions: outcome.behavior === 'ask' ? outcome.suggestions : [],
        warning: outcome.behavior === 'ask' ? outcome.warning : undefined,
        reason: outcome.behavior === 'ask' ? outcome.reason : 'A hook asked for confirmation.',
        diff,
      });
      if (signal.aborted) return { content: 'Not run: the user interrupted.', isError: true, summary: 'Interrupted' };
      if (!answer.allow) {
        if (answer.feedback?.trim()) {
          return { content: `The user declined this action and said: ${answer.feedback.trim()}`, isError: true, summary: 'Declined', denied: true };
        }
        state.rejected = true;
        return { content: 'The user declined this action. Stop and wait for their instructions.', isError: true, summary: 'Declined', denied: true };
      }
      if (answer.suggestion) deps.permissions.applySuggestion(answer.suggestion);
      }
    }

    let result: ToolResult;
    const executionStarted = Date.now();
    debug('tools', `call ${tool.name}`, input, 2000);
    try {
      result = await tool.execute(input, ctx);
    } catch (err) {
      result = { content: `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const max = deps.settings.maxToolOutputChars ?? DEFAULTS.maxToolOutputChars;
    // Anything still too large for the context is saved in full and shown trimmed.
    if (result.content.length > max * 1.2) result = { ...result, content: spillOutput(session.id, call.id, result.content, max) };

    debug('tools', `result ${tool.name}${result.isError ? ' (error)' : ''} ${Date.now() - executionStarted}ms`, result.content, 2000);
    if (!result.isError && deps.afterTool) {
      let extra: string | undefined;
      try {
        extra = deps.afterTool(tool.name, input);
      } catch {
        extra = undefined;
      }
      if (extra) result = { ...result, content: `${result.content}\n\n${extra}` };
    }
    // Success and failure are separate events, so a formatter hook does not run on a failed edit.
    const postEvent = result.isError ? 'PostToolUseFailure' : 'PostToolUse';
    if (deps.hooks.has(postEvent)) {
      const payload = {
        tool_name: tool.name,
        tool_input: input,
        tool_use_id: call.id,
        duration_ms: Date.now() - executionStarted,
        ...(result.isError ? { error: result.content, is_interrupt: signal.aborted } : { tool_response: result.content }),
      };
      const post = await deps.hooks.run(postEvent, payload, tool.name, signal);
      for (const m of post.messages) queue.push({ type: 'notice', level: 'info', text: m });
      if (post.stop) state.hookStop = post.stopReason ?? '';
      const extra = [post.blocked && post.reason ? `${postEvent} hook feedback: ${post.reason}` : '', post.additionalContext ?? ''].filter(Boolean);
      if (extra.length) result = { ...result, content: `${result.content}\n\n${extra.join('\n')}` };
    }
    return result;
  }

  /** Approval dialogs are shown one at a time even when tools run concurrently. */
  private askPermission(prompt: PermissionPrompt): Promise<PermissionAnswer> {
    const run = this.permissionLock.then(async () => {
      // A rule added by an earlier answer in this batch may already cover this call.
      const tool = this.deps.tools().find((t) => t.name === prompt.toolName);
      if (tool) {
        const session = this.deps.session;
        const again = this.deps.permissions.evaluate(tool, prompt.call.arguments, {
          get cwd() {
            return session.cwd;
          },
          signal: new AbortController().signal,
          settings: this.deps.settings,
          session,
          toolCallId: prompt.call.id,
          depth: this.deps.depth,
        });
        if (again.behavior === 'allow' && !prompt.reason?.startsWith('A hook')) return { allow: true };
      }
      if (this.deps.hooks.has('Notification')) {
        void this.deps.hooks.run('Notification', { message: `coco needs your permission to ${prompt.request.description}`, notification_type: 'permission_prompt' });
      }
      return this.deps.requestPermission!(prompt);
    });
    this.permissionLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Shrink the conversation. Clears old tool output first; if that is not
   * enough (or `force`), replaces history with a model-written summary.
   */
  async *compact(signal: AbortSignal, opts: { auto: boolean; force?: boolean; instructions?: string }): AsyncGenerator<AgentEvent> {
    const { deps } = this;
    const before = this.contextTokens();
    if (this.messages.length === 0) return;

    if (opts.auto && !opts.force) {
      const freed = this.calibrator.apply(microcompact(this.messages));
      if (freed > 0) {
        // Usage numbers no longer describe the current messages.
        this.lastUsage = undefined;
        this.usageIndex = 0;
        if (this.contextTokens() <= this.compactLimit() * 0.85) {
          yield { type: 'compact', phase: 'end', before, after: this.contextTokens(), auto: true };
          return;
        }
      }
    }

    const trigger = opts.auto ? 'auto' : 'manual';
    let instructions = opts.instructions;
    if (deps.hooks.has('PreCompact')) {
      const outcome = await deps.hooks.run('PreCompact', { trigger, custom_instructions: opts.instructions ?? '' }, trigger, signal);
      for (const m of outcome.messages) yield { type: 'notice', level: 'info', text: m };
      // What a PreCompact hook prints is extra guidance for the summary.
      if (outcome.additionalContext) instructions = [instructions, outcome.additionalContext].filter(Boolean).join('\n');
    }
    yield { type: 'compact', phase: 'start', before, auto: opts.auto };
    let summary: string;
    try {
      summary = await summarize(deps.client, this.messages, { instructions, signal });
      // A reply with no summary in it is worth one more try before giving up.
      if (!summary.trim() && !signal.aborted) summary = await summarize(deps.client, this.messages, { instructions, signal });
    } catch (err) {
      if (signal.aborted) return;
      yield { type: 'notice', level: 'error', text: `Compaction failed: ${err instanceof Error ? err.message : String(err)}` };
      // Fall back to dropping the oldest half so the session can continue at all.
      const keepFrom = this.messages.findIndex((m, i) => i >= Math.floor(this.messages.length / 2) && m.role === 'user' && !m.isMeta);
      if (keepFrom > 0) {
        this.messages = [{ role: 'user', isMeta: true, content: 'Earlier parts of this session were dropped to fit the context window.' }, ...this.messages.slice(keepFrom)];
        deps.transcript?.compacted(this.messages);
      }
      this.lastUsage = undefined;
      this.usageIndex = 0;
      return;
    }
    if (!summary.trim()) {
      yield { type: 'notice', level: 'error', text: 'Compaction produced an empty summary; the conversation was left unchanged.' };
      return;
    }
    const tail = recentTail(this.messages, Math.floor(deps.client.profile.contextWindow * 0.2));
    // The plan and working set are carried over verbatim rather than trusted to the summary.
    const main = deps.depth === 0;
    const budget = carryBudget(deps.client.profile.contextWindow);
    const todos = main && deps.session.todos.some((t) => t.status !== 'completed') ? renderTodos(deps.session.todos) : undefined;

    // The files most recently in play come back in full when they are small enough,
    // so work can continue without a round of re-reading; the rest are named.
    const attached: { path: string; content: string }[] = [];
    const named: string[] = [];
    const kept = new Map<string, NonNullable<ReturnType<typeof deps.session.readFiles.get>>>();
    if (main) {
      const recent = [...deps.session.readFiles.keys()].slice(-12).reverse();
      let used = 0;
      for (const [index, file] of recent.entries()) {
        const shown = displayPath(file, deps.session.cwd);
        let content: string | undefined;
        if (index < 5) {
          try {
            if (fs.statSync(file).size <= budget.perFile * 6) content = fs.readFileSync(file, 'utf8');
          } catch {
            content = undefined;
          }
        }
        const cost = content === undefined ? Infinity : estimateTokens(content);
        if (content !== undefined && cost <= budget.perFile && used + cost <= budget.files && !content.includes('\0')) {
          used += cost;
          attached.unshift({ path: shown, content });
          kept.set(file, deps.session.readFiles.get(file)!);
        } else {
          named.unshift(shown);
        }
      }
    }
    const carried = main ? (deps.carryOver?.() ?? {}) : {};
    const skills = fitSkills(carried.skills ?? [], budget.perSkill, budget.skills);

    // SessionStart hooks for the "compact" source run again, as at the start of a session.
    let hookContext: string | undefined;
    if (main && deps.hooks.has('SessionStart')) {
      const started = await deps.hooks.run('SessionStart', { source: 'compact' }, 'compact', signal);
      for (const m of started.messages) yield { type: 'notice', level: 'info', text: m };
      hookContext = started.additionalContext;
    }

    this.messages = [summaryMessage(summary, tail.length > 0, { todos, files: named, attached, skills, plan: carried.plan, hookContext }), ...tail];
    deps.transcript?.compacted(this.messages);
    this.lastUsage = undefined;
    this.usageIndex = 0;
    this.totals.compactions++;
    // Contents of files that were not re-attached are gone from context, so edits must re-read them first.
    if (main) {
      deps.session.readFiles.clear();
      for (const [file, record] of kept) deps.session.readFiles.set(file, record);
      deps.onCompacted?.();
    }
    if (deps.hooks.has('PostCompact')) {
      const post = await deps.hooks.run('PostCompact', { trigger, compact_summary: summary }, trigger, signal);
      for (const m of post.messages) yield { type: 'notice', level: 'info', text: m };
    }
    yield { type: 'compact', phase: 'end', before, after: this.contextTokens(), auto: opts.auto };
  }

  /** Text of the last assistant message that has any. */
  lastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role === 'assistant' && m.content.trim()) return m.content;
    }
    return '';
  }
}
