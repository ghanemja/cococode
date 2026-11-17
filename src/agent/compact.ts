import type { ModelClient } from '../providers/index.ts';
import { renderTranscript } from '../providers/textTools.ts';
import type { Message } from '../types.ts';
import { estimateTokens, messagesTokens } from './tokens.ts';

export const CLEARED_RESULT = '[Old tool result cleared to save context. Run the tool again if you need it.]';

/**
 * Cheap first step before summarising: blank out the bodies of old tool
 * results. They are usually the bulk of the context and the least needed.
 * Returns the estimated number of tokens freed.
 */
export function microcompact(messages: Message[], keepRecent = 6): number {
  const toolIndexes = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const clearable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent));
  let freed = 0;
  for (const i of clearable) {
    const msg = messages[i] as Extract<Message, { role: 'tool' }>;
    if (msg.content === CLEARED_RESULT || msg.content.length < 400) continue;
    freed += estimateTokens(msg.content) - estimateTokens(CLEARED_RESULT);
    msg.content = CLEARED_RESULT;
    delete msg.images;
  }
  return freed;
}

const SUMMARY_SYSTEM =
  'You write handoff summaries of coding sessions. The summary replaces the conversation, so whoever continues must be able to pick up the work from it alone. ' +
  'Be specific and accurate; do not invent anything that is not in the transcript.';

const SUMMARY_INSTRUCTIONS = `Summarize the session above so the work can continue without the original conversation. Cover:

1. Goal: what the user asked for, quoting their wording where precision matters, and any constraints or preferences they stated.
2. Key facts and decisions: technical details, commands, configuration and conclusions reached.
3. Files: each file read, created or changed, what was done to it, and any code that must be remembered exactly.
4. Problems: errors encountered and how they were resolved (or that they are unresolved).
5. Current state: what was being worked on at the very end.
6. Next steps: what remains to be done, in order, if the task is unfinished.

Write only the summary.`;

/** Fit a transcript into a token budget by dropping the middle. */
export function fitTranscript(text: string, budgetTokens: number): string {
  const budgetChars = Math.max(2000, Math.floor(budgetTokens * 3.2));
  if (text.length <= budgetChars) return text;
  const head = Math.floor(budgetChars * 0.3);
  const tail = budgetChars - head;
  return `${text.slice(0, head)}\n\n[... middle of the session omitted to fit the context window ...]\n\n${text.slice(text.length - tail)}`;
}

export interface SummarizeOptions {
  /** Extra focus from the user: /compact <instructions>. */
  instructions?: string;
  signal?: AbortSignal;
}

export async function summarize(client: ModelClient, messages: Message[], opts: SummarizeOptions = {}): Promise<string> {
  const window = client.profile.contextWindow;
  const outputBudget = Math.min(client.profile.maxOutputTokens, Math.max(1024, Math.floor(window / 5)));
  const promptBudget = window - outputBudget - estimateTokens(SUMMARY_SYSTEM) - estimateTokens(SUMMARY_INSTRUCTIONS) - 500;
  const transcript = fitTranscript(renderTranscript(messages, 1200), Math.max(1000, promptBudget));
  const focus = opts.instructions?.trim() ? `\n\nThe user asked that the summary focus on: ${opts.instructions.trim()}` : '';
  const prompt = `<session>\n${transcript}\n</session>\n\n${SUMMARY_INSTRUCTIONS}${focus}`;
  return client.complete(SUMMARY_SYSTEM, prompt, { signal: opts.signal, maxTokens: outputBudget });
}

/**
 * Messages to keep verbatim after a summary: the most recent exchange, as long
 * as it starts at a real user message (so tool calls stay paired with their
 * results) and is small enough to be worth keeping.
 */
export function recentTail(messages: Message[], maxTokens: number): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.isMeta) {
      const tail = messages.slice(i);
      return messagesTokens(tail) <= maxTokens ? tail : [];
    }
  }
  return [];
}

export function summaryMessage(summary: string, hasTail: boolean): Message {
  return {
    role: 'user',
    isMeta: true,
    content:
      'This session is continuing from an earlier conversation that was compacted to save context. Summary of what happened so far:\n\n' +
      summary.trim() +
      (hasTail
        ? '\n\nThe most recent messages follow unchanged.'
        : '\n\nContinue the work from where it left off. Do not ask the user to repeat anything; files may need to be Read again before editing.'),
  };
}
