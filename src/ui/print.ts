/**
 * Headless mode (`coco -p`). No prompts are possible, so anything that would
 * need approval is denied unless a rule or permission mode already allows it.
 */
import * as readline from 'node:readline';
import type { AgentEvent } from '../agent/loop.ts';
import { runSlash, type CommandIO } from '../commands/builtin.ts';
import type { Controller } from '../core/controller.ts';
import type { ImagePart, JsonSchema } from '../types.ts';
import { checkStructured } from '../util/structured.ts';
import { VERSION } from '../version.ts';
import { c, stripAnsi } from './ansi.ts';
import { renderToolResult } from './render.ts';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface PrintOptions {
  prompt: string;
  format: OutputFormat;
  verbose: boolean;
  images?: ImagePart[];
  /** stream-json only: emit text and reasoning as they stream. */
  includePartial?: boolean;
  /** Send input starting with "/" to the model as written. */
  disableSlashCommands?: boolean;
  /** Further prompts to run in the same session, one turn each (--input-format stream-json). */
  input?: AsyncIterable<string>;
  /** The final answer must be JSON matching this schema (--json-schema). */
  jsonSchema?: JsonSchema;
}

/** How often a reply that does not match --json-schema is sent back for correction. */
const SCHEMA_RETRIES = 2;

/**
 * Prompts from stream-json input: one JSON object per line, of which the
 * user messages are turned into prompts. Anything else is skipped.
 */
export async function* streamJsonPrompts(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const text = promptFromStreamJson(line);
    if (text instanceof Error) process.stderr.write(`Ignored input line: ${text.message}\n`);
    else if (text) yield text;
  }
}

/** The prompt carried by one line of stream-json input, if it is a user message. */
export function promptFromStreamJson(line: string): string | undefined | Error {
  if (!line.trim()) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return new Error('not valid JSON');
  }
  if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== 'user') return undefined;
  const content = (data as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { type: 'text'; text: string } => typeof part === 'object' && part !== null && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    return text || undefined;
  }
  return new Error('a user message needs message.content');
}

/** Run one prompt, or with `input` a series of them, and report the exit code of the last. */
export async function runPrint(ctl: Controller, opts: PrintOptions): Promise<number> {
  const state = { announced: false };
  if (!opts.input) return runOne(ctl, opts, state);
  let code = 0;
  if (opts.prompt.trim()) code = await runOne(ctl, opts, state);
  for await (const prompt of opts.input) {
    if (code === 143) break;
    code = await runOne(ctl, { ...opts, prompt, images: undefined }, state);
  }
  return code;
}

/** Slash commands that only print are routed to stderr in headless mode. */
function headlessIO(): CommandIO {
  const say = (text: string) => process.stderr.write(`${stripAnsi(text)}\n`);
  return {
    print: say,
    width: () => 100,
    select: async () => undefined,
    editFile: async () => {},
    clearScreen: () => {},
    exit: () => {},
    showHistory: () => {},
    toggleVerbose: () => false,
    setInput: () => {},
  };
}

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function runOne(ctl: Controller, opts: PrintOptions, state: { announced: boolean }): Promise<number> {
  const started = Date.now();
  const { format } = opts;
  let prompt = opts.prompt;
  let display: string | undefined;

  if (prompt.trim().startsWith('/') && !opts.disableSlashCommands) {
    const outcome = await runSlash(prompt, ctl, headlessIO());
    if (!outcome) return 0;
    if (outcome.type === 'compact') {
      process.stderr.write('/compact has no effect in a one-shot run.\n');
      return 0;
    }
    if (outcome.type === 'prompt') {
      display = outcome.display;
      prompt = outcome.prompt;
      for (const rule of outcome.allowedTools ?? []) ctl.permissions.addRule('allow', rule);
    }
    // An unknown /name is sent to the model as written.
  }

  if (format === 'stream-json' && !state.announced) {
    state.announced = true;
    emit({
      type: 'system',
      subtype: 'init',
      session_id: ctl.session.id,
      cwd: ctl.session.cwd,
      model: ctl.client.model,
      provider: ctl.provider.name,
      tools: ctl.tools().map((t) => t.name),
      mcp_servers: (ctl.mcp?.status() ?? []).map((s) => ({ name: s.name, status: s.status })),
      permission_mode: ctl.permissions.mode,
      version: VERSION,
    });
  }

  let turns = 0;
  let error: string | undefined;
  let reason = 'stop';
  const labels = new Map<string, { name: string; label: string }>();
  const denials: { tool_name: string; tool_use_id: string; tool_input: unknown }[] = [];
  const partial = format === 'stream-json' && opts.includePartial;

  const onEvent = (ev: AgentEvent): void => {
    switch (ev.type) {
      case 'assistant':
        turns++;
        if (format === 'stream-json') {
          emit({
            type: 'assistant',
            session_id: ctl.session.id,
            message: {
              role: 'assistant',
              model: ev.message.model,
              content: [
                ...(ev.message.thinking ? [{ type: 'thinking', thinking: ev.message.thinking }] : []),
                ...(ev.message.content ? [{ type: 'text', text: ev.message.content }] : []),
                ...(ev.message.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
              ],
              usage: ev.message.usage ? { input_tokens: ev.message.usage.inputTokens, output_tokens: ev.message.usage.outputTokens } : undefined,
            },
          });
        }
        break;
      case 'text':
        if (partial) emit({ type: 'stream_event', session_id: ctl.session.id, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ev.text } } });
        break;
      case 'thinking':
        if (partial) emit({ type: 'stream_event', session_id: ctl.session.id, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: ev.text } } });
        break;
      case 'retry':
        if (format === 'stream-json') {
          emit({
            type: 'system',
            subtype: 'api_retry',
            attempt: ev.attempt,
            max_retries: ev.maxRetries,
            retry_delay_ms: ev.delayMs,
            error_status: ev.status ?? null,
            error: ev.error,
            session_id: ctl.session.id,
          });
        }
        break;
      case 'tool_start':
        labels.set(ev.call.id, { name: ev.call.name, label: ev.label });
        break;
      case 'tool_end': {
        if (ev.result.denied) denials.push({ tool_name: ev.call.name, tool_use_id: ev.call.id, tool_input: ev.call.arguments });
        if (format === 'stream-json') {
          emit({
            type: 'user',
            session_id: ctl.session.id,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ev.call.id, content: ev.result.content, is_error: Boolean(ev.result.isError) }] },
          });
        } else if (opts.verbose) {
          const info = labels.get(ev.call.id) ?? { name: ev.call.name, label: '' };
          const lines = renderToolResult(info.name, info.label, ev.result, { width: 100, verbose: false, todos: ctl.session.todos });
          process.stderr.write(`${lines.join('\n')}\n`);
        }
        break;
      }
      case 'notice':
        if (format === 'stream-json') emit({ type: 'system', subtype: 'notice', level: ev.level, message: ev.text });
        else if (ev.level !== 'info' || opts.verbose) process.stderr.write(`${c.yellow(ev.text)}\n`);
        break;
      case 'compact':
        if (ev.phase === 'end' && format === 'stream-json') emit({ type: 'system', subtype: 'compact', before_tokens: ev.before, after_tokens: ev.after });
        break;
      case 'done':
        reason = ev.reason;
        if (ev.reason === 'error') error = ev.error ?? 'unknown error';
        break;
      default:
        break;
    }
  };

  let terminated = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signal === 'SIGTERM') terminated = true;
    ctl.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const run = async (events: AsyncGenerator<AgentEvent>): Promise<void> => {
    try {
      for await (const ev of events) onEvent(ev);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      reason = 'error';
    }
  };
  let structured: unknown;
  try {
    await run(ctl.submit(prompt, { display, images: opts.images }));
    // A reply of the wrong shape goes back to the model with the reason, a limited number of times.
    for (let attempt = 0; opts.jsonSchema && !error && reason === 'stop'; attempt++) {
      const check = checkStructured(ctl.agent.lastAssistantText(), opts.jsonSchema);
      if (check.ok) {
        structured = check.value;
        break;
      }
      if (attempt >= SCHEMA_RETRIES) {
        error = `The final answer did not match --json-schema: ${check.error}`;
        break;
      }
      await run(ctl.submit(`Your final answer must be a single JSON value matching the required schema, with no other text. Problem: ${check.error}. Reply again with only the corrected JSON.`));
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const result = opts.jsonSchema && structured !== undefined ? JSON.stringify(structured) : ctl.agent.lastAssistantText();
  const totals = ctl.agent.totals;
  const isError = Boolean(error) || reason === 'aborted';
  const subtype = error ? 'error_during_execution' : reason === 'max_turns' ? 'error_max_turns' : reason === 'aborted' ? 'interrupted' : 'success';
  const summary = {
    type: 'result',
    subtype,
    is_error: isError,
    result: error ? undefined : result,
    structured_output: structured,
    error,
    session_id: ctl.session.id,
    num_turns: turns,
    duration_ms: Date.now() - started,
    model: ctl.client.model,
    usage: { input_tokens: totals.inputTokens, output_tokens: totals.outputTokens, requests: totals.requests, tool_uses: totals.toolUses },
    total_cost_usd: 0,
    permission_denials: denials,
  };

  if (format === 'text') {
    if (error) process.stderr.write(`Error: ${error}\n`);
    else if (result) process.stdout.write(result.endsWith('\n') ? result : `${result}\n`);
  } else {
    emit(summary);
  }
  // Like other well-behaved commands, report termination by signal as 128 + 15.
  if (terminated) return 143;
  return isError ? 1 : 0;
}
