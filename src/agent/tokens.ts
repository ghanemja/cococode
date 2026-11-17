import type { Message, ToolSpec } from '../types.ts';

/**
 * Rough token estimate. Tokenizers differ between models and none is available
 * offline for all of them, so we estimate from characters and then calibrate
 * against the prompt sizes the server reports.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

const IMAGE_TOKENS = 1000;
const MESSAGE_OVERHEAD = 4;

export function messageTokens(msg: Message): number {
  let n = MESSAGE_OVERHEAD;
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') n += estimateTokens(msg.content);
    else for (const part of msg.content) n += part.type === 'text' ? estimateTokens(part.text) : IMAGE_TOKENS;
  } else if (msg.role === 'assistant') {
    n += estimateTokens(msg.content);
    for (const call of msg.toolCalls ?? []) n += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments)) + 8;
  } else {
    n += estimateTokens(msg.content) + (msg.images?.length ?? 0) * IMAGE_TOKENS;
  }
  return n;
}

export function messagesTokens(messages: Message[]): number {
  let n = 0;
  for (const m of messages) n += messageTokens(m);
  return n;
}

export function toolSpecTokens(tools: ToolSpec[]): number {
  let n = 0;
  for (const t of tools) n += estimateTokens(t.name) + estimateTokens(t.description) + estimateTokens(JSON.stringify(t.parameters)) + 10;
  return n;
}

/** Learns the ratio between our estimates and what the server actually counted. */
export class TokenCalibrator {
  ratio = 1;
  private samples = 0;

  observe(estimated: number, actual: number): void {
    if (estimated < 200 || actual <= 0) return;
    const observed = Math.min(2.5, Math.max(0.4, actual / estimated));
    this.samples++;
    // Weighted toward recent requests, which contain the current mix of content.
    this.ratio = this.samples === 1 ? observed : this.ratio * 0.6 + observed * 0.4;
  }

  apply(estimated: number): number {
    return Math.ceil(estimated * this.ratio);
  }
}
