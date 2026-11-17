import { DEFAULTS, type Settings } from '../config/settings.ts';
import type { HookRunner } from '../hooks/hooks.ts';
import type { PermissionManager, Suggestion } from '../permissions/manager.ts';
import type { ModelClient } from '../providers/index.ts';
import { ProviderError } from '../providers/types.ts';
import type { SessionState } from '../session/state.ts';
import { clampOutput } from '../tools/shell.ts';
import { toolSpecs } from '../tools/registry.ts';
import type { FileDiff, PermissionRequest, RuntimeHandle, Tool, ToolContext, ToolResult } from '../tools/types.ts';
import type { AssistantMessage, ContentPart, Message, ToolCall, ToolResultMessage, Usage, UserMessage } from '../types.ts';
import { validateInput } from '../util/schema.ts';
import { microcompact, recentTail, summarize, summaryMessage } from './compact.ts';
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
    let overflowRetried = false;
    let stopHookBlocks = 0;
    let maxTokens: number | undefined;

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
        for await (const ev of deps.client.chat({ system, messages: this.messages, tools: specs, signal, maxTokens })) {
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
          } else if (ev.type === 'done') {
            stopReason = ev.stopReason;
          }
        }
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

      const assistant: AssistantMessage = { role: 'assistant', content: text, usage, model: deps.client.model, stopReason };
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
            const current = maxTokens ?? deps.client.profile.maxOutputTokens;
            maxTokens = Math.min(current * 2, Math.floor(deps.client.profile.contextWindow / 2));
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
          yield { type: 'notice', level: 'warn', text: 'The reply was cut off at the output token limit. Say "continue" to carry on.' };
        }

        const hookEvent = deps.depth > 0 ? 'SubagentStop' : 'Stop';
        if (deps.hooks.has(hookEvent)) {
          const outcome = await deps.hooks.run(hookEvent, { stop_hook_active: stopHookBlocks > 0 }, undefined, signal);
          for (const m of outcome.messages) yield { type: 'notice', level: 'info', text: m };
          if (outcome.blocked && outcome.reason && stopHookBlocks < 3) {
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
      const pre = await deps.hooks.run('PreToolUse', { tool_name: tool.name, tool_input: input }, tool.name, signal);
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
    if (outcome.behavior === 'deny') return { content: outcome.message, isError: true, summary: 'Denied' };
    const mustAsk = outcome.behavior === 'ask' && hookDecision !== 'allow';
    const hookForcesAsk = hookDecision === 'ask' && outcome.behavior === 'allow' && deps.permissions.mode !== 'bypassPermissions';
    if (mustAsk || hookForcesAsk) {
      const request: PermissionRequest =
        outcome.behavior === 'ask' ? outcome.request : (tool.permission?.(input, ctx) ?? { tool: tool.name, kind: 'other', description: tool.name });
      if (!deps.requestPermission) {
        return {
          content:
            `Permission is required to ${request.description}, and this session cannot ask the user. ` +
            'Continue without it if you can; otherwise explain what you needed.',
          isError: true,
          summary: 'Permission required',
        };
      }
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
          return { content: `The user declined this action and said: ${answer.feedback.trim()}`, isError: true, summary: 'Declined' };
        }
        state.rejected = true;
        return { content: 'The user declined this action. Stop and wait for their instructions.', isError: true, summary: 'Declined' };
      }
      if (answer.suggestion) deps.permissions.applySuggestion(answer.suggestion);
    }

    let result: ToolResult;
    try {
      result = await tool.execute(input, ctx);
    } catch (err) {
      result = { content: `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const max = deps.settings.maxToolOutputChars ?? DEFAULTS.maxToolOutputChars;
    if (result.content.length > max * 1.2) result = { ...result, content: clampOutput(result.content, max) };

    if (deps.hooks.has('PostToolUse')) {
      const post = await deps.hooks.run('PostToolUse', { tool_name: tool.name, tool_input: input, tool_response: result.content, tool_is_error: Boolean(result.isError) }, tool.name, signal);
      for (const m of post.messages) queue.push({ type: 'notice', level: 'info', text: m });
      if (post.stop) state.hookStop = post.stopReason ?? '';
      const extra = [post.blocked && post.reason ? `PostToolUse hook feedback: ${post.reason}` : '', post.additionalContext ?? ''].filter(Boolean);
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

    if (deps.hooks.has('PreCompact')) {
      const outcome = await deps.hooks.run('PreCompact', { trigger: opts.auto ? 'auto' : 'manual', custom_instructions: opts.instructions ?? '' }, opts.auto ? 'auto' : 'manual', signal);
      for (const m of outcome.messages) yield { type: 'notice', level: 'info', text: m };
    }
    yield { type: 'compact', phase: 'start', before, auto: opts.auto };
    let summary: string;
    try {
      summary = await summarize(deps.client, this.messages, { instructions: opts.instructions, signal });
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
    this.messages = [summaryMessage(summary, tail.length > 0), ...tail];
    deps.transcript?.compacted(this.messages);
    this.lastUsage = undefined;
    this.usageIndex = 0;
    this.totals.compactions++;
    // File contents are gone from context, so edits must re-read first.
    if (deps.depth === 0) deps.session.readFiles.clear();
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
