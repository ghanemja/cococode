/**
 * Headless mode (`coco -p`). No prompts are possible, so anything that would
 * need approval is denied unless a rule or permission mode already allows it.
 */
import type { AgentEvent } from '../agent/loop.ts';
import { runSlash, type CommandIO } from '../commands/builtin.ts';
import type { Controller } from '../core/controller.ts';
import type { ImagePart } from '../types.ts';
import { VERSION } from '../version.ts';
import { c, stripAnsi } from './ansi.ts';
import { renderToolResult } from './render.ts';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface PrintOptions {
  prompt: string;
  format: OutputFormat;
  verbose: boolean;
  images?: ImagePart[];
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

export async function runPrint(ctl: Controller, opts: PrintOptions): Promise<number> {
  const started = Date.now();
  const { format } = opts;
  let prompt = opts.prompt;
  let display: string | undefined;

  if (prompt.trim().startsWith('/')) {
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

  if (format === 'stream-json') {
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
      case 'tool_start':
        labels.set(ev.call.id, { name: ev.call.name, label: ev.label });
        break;
      case 'tool_end': {
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

  const onSignal = () => ctl.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    for await (const ev of ctl.submit(prompt, { display, images: opts.images })) onEvent(ev);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    reason = 'error';
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const result = ctl.agent.lastAssistantText();
  const totals = ctl.agent.totals;
  const isError = Boolean(error) || reason === 'aborted';
  const subtype = error ? 'error_during_execution' : reason === 'max_turns' ? 'error_max_turns' : reason === 'aborted' ? 'interrupted' : 'success';
  const summary = {
    type: 'result',
    subtype,
    is_error: isError,
    result: error ? undefined : result,
    error,
    session_id: ctl.session.id,
    num_turns: turns,
    duration_ms: Date.now() - started,
    model: ctl.client.model,
    usage: { input_tokens: totals.inputTokens, output_tokens: totals.outputTokens, requests: totals.requests, tool_uses: totals.toolUses },
  };

  if (format === 'text') {
    if (error) process.stderr.write(`Error: ${error}\n`);
    else if (result) process.stdout.write(result.endsWith('\n') ? result : `${result}\n`);
  } else {
    emit(summary);
  }
  return isError ? 1 : 0;
}
