/** Rendering of transcript items: user prompts, tool calls and their results. */
import type { TodoItem } from '../session/state.ts';
import type { ToolResult } from '../tools/types.ts';
import type { Message } from '../types.ts';
import { messageText } from '../types.ts';
import { diffLines, diffStats, renderDiff } from '../util/diff.ts';
import { c, expandTabs, formatContext, formatCount, plural, truncate, wrapText } from './ansi.ts';
import { renderMarkdown } from './markdown.ts';

export const BULLET = '●';
const BRANCH = '└';

export function renderUserPrompt(text: string, width: number): string[] {
  const body = text.split('\n<attached-files>')[0]!.trimEnd();
  const lines = wrapText(body, width, { indent: '> ', hangingIndent: '  ' });
  return lines.map((l) => c.dim(l));
}

export function renderTodos(todos: TodoItem[], width: number, indent = '  '): string[] {
  return todos.map((t) => {
    if (t.status === 'completed') return truncate(`${indent}${c.green('☑')} ${c.dim(c.strike(t.content))}`, width);
    if (t.status === 'in_progress') return truncate(`${indent}${c.cyan('◼')} ${c.bold(t.activeForm || t.content)}`, width);
    return truncate(`${indent}☐ ${t.content}`, width);
  });
}

export function toolHeader(name: string, label: string, width: number, state: 'ok' | 'error' | 'running' = 'ok'): string {
  const bullet = state === 'error' ? c.red(BULLET) : state === 'running' ? c.yellow(BULLET) : c.green(BULLET);
  const shownName = name.startsWith('mcp__') ? name.split('__').slice(1).join(' › ') : name;
  const text = label ? `${c.bold(shownName)}(${label})` : c.bold(shownName);
  return truncate(`${bullet} ${text}`, width);
}

function branch(text: string, width: number, color: (s: string) => string = (s) => s): string[] {
  const lines = wrapText(text, width, { indent: `  ${BRANCH} `, hangingIndent: '    ' });
  return lines.map((l) => color(l));
}

function previewLines(content: string, max: number): { shown: string[]; hidden: number } {
  const lines = content.replace(/\s+$/, '').split('\n');
  if (lines.length <= max) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, max), hidden: lines.length - max };
}

export interface RenderOptions {
  width: number;
  verbose: boolean;
  todos?: TodoItem[];
}

/** Lines for a finished tool call: header, one-line outcome, and any detail worth showing. */
export function renderToolResult(name: string, label: string, result: ToolResult, opts: RenderOptions): string[] {
  const { width, verbose } = opts;
  const out: string[] = [toolHeader(name, label, width, result.isError ? 'error' : 'ok')];

  if (result.isError) {
    const { shown, hidden } = previewLines(result.content, verbose ? 40 : 6);
    const body = shown.map((l) => expandTabs(l)).join('\n') + (hidden ? `\n… +${plural(hidden, 'line')}` : '');
    out.push(...branch(body, width, c.red));
    return out;
  }

  if (name === 'TodoWrite' && opts.todos) {
    out.push(...renderTodos(opts.todos, width, `  ${BRANCH} `).map((l, i) => (i === 0 ? l : `    ${l.slice(4)}`)));
    return out;
  }

  const summary = result.summary ?? result.content.split('\n')[0] ?? '';
  if (result.diff) {
    const hunks = diffLines(result.diff.before ?? '', result.diff.after);
    const stats = diffStats(hunks);
    const delta = [stats.added ? c.green(`+${stats.added}`) : '', stats.removed ? c.red(`-${stats.removed}`) : ''].filter(Boolean).join(' ');
    out.push(...branch(`${summary}${delta ? ` (${delta})` : ''}`, width));
    out.push(...renderDiff(hunks, width, { indent: '    ', maxLines: verbose ? 400 : 30 }));
    return out;
  }

  out.push(...branch(summary, width, c.dim));
  // Shell output is worth a glance even when it succeeded.
  const showBody = verbose || name === 'Bash' || name === 'BashOutput';
  if (showBody && result.content.trim() && result.content.trim() !== '(no output)') {
    const { shown, hidden } = previewLines(result.content, verbose ? 60 : 5);
    for (const l of shown) out.push(c.dim(truncate(`    ${expandTabs(l)}`, width)));
    if (hidden) out.push(c.dim(`    … +${plural(hidden, 'line')}${verbose ? '' : ' (ctrl+o to show more)'}`));
  }
  return out;
}

/** First line of an assistant message gets the bullet; the renderer indents the rest. */
export function withBullet(lines: string[], color: (s: string) => string = (s) => s): string[] {
  const out = [...lines];
  const first = out.findIndex((l) => l.trim() !== '');
  if (first >= 0 && out[first]!.startsWith('  ')) out[first] = `${color(BULLET)} ${out[first]!.slice(2)}`;
  return out;
}

export function renderAssistantText(text: string, width: number): string[] {
  return withBullet(renderMarkdown(text, width, '  '));
}

/** Replay an existing conversation into the scrollback (on resume). */
export function renderHistory(messages: Message[], width: number, maxMessages = 40): string[] {
  const out: string[] = [];
  const start = Math.max(0, messages.length - maxMessages);
  if (start > 0) out.push(c.dim(`… ${plural(start, 'earlier message')} not shown`));
  const labels = new Map<string, { name: string; label: string }>();
  for (const msg of messages.slice(start)) {
    if (msg.role === 'user') {
      if (msg.isMeta) continue;
      out.push(...renderUserPrompt(msg.display ?? messageText(msg.content), width), '');
    } else if (msg.role === 'assistant') {
      if (msg.content.trim()) out.push(...renderAssistantText(msg.content, width), '');
      for (const call of msg.toolCalls ?? []) {
        const arg = call.arguments.file_path ?? call.arguments.command ?? call.arguments.pattern ?? call.arguments.url ?? call.arguments.description ?? '';
        labels.set(call.id, { name: call.name, label: truncate(String(arg).replace(/\s+/g, ' '), 80) });
      }
    } else {
      const info = labels.get(msg.toolCallId) ?? { name: msg.name, label: '' };
      out.push(toolHeader(info.name, info.label, width, msg.isError ? 'error' : 'ok'));
    }
  }
  return out;
}

export function contextBar(used: number, window: number, width = 30): string {
  const ratio = Math.min(1, used / Math.max(1, window));
  const filled = Math.round(ratio * width);
  const color = ratio > 0.85 ? c.red : ratio > 0.65 ? c.yellow : c.green;
  return `${color('█'.repeat(filled))}${c.dim('░'.repeat(width - filled))} ${formatCount(used)} / ${formatContext(window)} (${Math.round(ratio * 100)}%)`;
}
