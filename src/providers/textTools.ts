/**
 * Tool calling over plain text.
 *
 * Two jobs:
 *  1. `toTextProtocol` rewrites a request for models/servers without native
 *     tool calling: tools are described in the system prompt and the model
 *     answers with <tool_call> blocks.
 *  2. `TextStreamParser` watches streamed text for tool calls and reasoning
 *     that arrive as text. It runs in native mode too, because local models
 *     often leak a tool call into the content instead of the structured field,
 *     which otherwise looks like the model "said it did it" and stopped.
 */
import type { Message, ToolCall, ToolSpec } from '../types.ts';
import { messageText } from '../types.ts';
import { isRecord, parseJsonLoose, stripCodeFence } from '../util/json.ts';
import type { ChatRequest, StreamEvent } from './types.ts';
import { newCallId } from './types.ts';

type ParserEvent = Extract<StreamEvent, { type: 'text' | 'thinking' | 'tool_call' }>;

interface Block {
  open: string;
  close: string | null; // null = runs to the end of the message
  kind: 'think' | 'call';
}

const BLOCKS: Block[] = [
  { open: '<think>', close: '</think>', kind: 'think' },
  { open: '<thinking>', close: '</thinking>', kind: 'think' },
  { open: '<tool_call>', close: '</tool_call>', kind: 'call' },
  { open: '<|tool_call|>', close: '<|/tool_call|>', kind: 'call' },
  { open: '<function_calls>', close: '</function_calls>', kind: 'call' },
  { open: '<function=', close: '</function>', kind: 'call' },
  { open: '<invoke name=', close: '</invoke>', kind: 'call' },
  { open: '[TOOL_CALLS]', close: null, kind: 'call' },
  { open: '<|python_tag|>', close: null, kind: 'call' },
];

const OPENERS = BLOCKS.map((b) => b.open);

/** Openers that include the tool name, so they must stay part of the payload. */
function carriesName(block: Block): boolean {
  return block.open === '<function=' || block.open === '<invoke name=';
}

/** Length of the longest suffix of `text` that is a proper prefix of any marker. */
function partialMarkerSuffix(text: string, markers: string[]): number {
  const maxLen = Math.min(text.length, Math.max(...markers.map((m) => m.length)) - 1);
  for (let len = maxLen; len > 0; len--) {
    const tail = text.slice(text.length - len);
    if (markers.some((m) => m.startsWith(tail))) return len;
  }
  return 0;
}

function normalizeArgs(raw: unknown): { args: Record<string, unknown>; error?: string } {
  if (isRecord(raw)) return { args: raw };
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { args: {} };
    const parsed = parseJsonLoose(raw);
    if (parsed.ok && isRecord(parsed.value)) return { args: parsed.value };
    return { args: {}, error: `arguments were not a JSON object: ${raw.slice(0, 200)}` };
  }
  if (raw === undefined || raw === null) return { args: {} };
  return { args: {}, error: 'arguments were not a JSON object' };
}

function callFromObject(obj: Record<string, unknown>): ToolCall | null {
  // OpenAI shape: {type:"function", function:{name, arguments}}
  const fn = isRecord(obj.function) ? obj.function : obj;
  const name = fn.name ?? fn.tool ?? fn.tool_name ?? (typeof obj.function === 'string' ? obj.function : undefined);
  if (typeof name !== 'string' || !name) return null;
  const rawArgs = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? fn.params;
  const { args, error } = normalizeArgs(rawArgs);
  const call: ToolCall = { id: typeof obj.id === 'string' && obj.id ? obj.id : newCallId(), name, arguments: args };
  if (error) call.parseError = error;
  return call;
}

function parseXmlParams(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const re = /<parameter(?:=|\s+name=)["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/parameter>/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    let value = m[2]!;
    // One leading and one trailing newline are formatting, not content.
    value = value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    args[m[1]!] = value;
  }
  return args;
}

/**
 * Parse the inside of a tool-call block. Accepts JSON (one call or a list)
 * and the XML-ish forms several model families use.
 */
export function parseToolPayload(raw: string): ToolCall[] {
  const text = stripCodeFence(raw.trim());
  if (!text) return [];
  const calls: ToolCall[] = [];

  // <function=name>...</function> and <invoke name="...">...</invoke>
  const xmlRe = /<(?:function=|invoke\s+name=)["']?([\w.:-]+)["']?\s*>([\s\S]*?)(?:<\/(?:function|invoke)>|$)/g;
  for (let m = xmlRe.exec(text); m; m = xmlRe.exec(text)) {
    const body = m[2]!;
    if (/<parameter/.test(body)) {
      calls.push({ id: newCallId(), name: m[1]!, arguments: parseXmlParams(body) });
    } else {
      const { args, error } = normalizeArgs(body.trim());
      const call: ToolCall = { id: newCallId(), name: m[1]!, arguments: args };
      if (error) call.parseError = error;
      calls.push(call);
    }
  }
  if (calls.length) return calls;

  const parsed = parseJsonLoose(text);
  if (parsed.ok) {
    const items = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const call = callFromObject(item);
      if (call) calls.push(call);
    }
    if (calls.length) return calls;
  }

  // Several JSON objects one after another (one per line).
  for (const line of text.split('\n')) {
    const p = parseJsonLoose(line);
    if (p.ok && isRecord(p.value)) {
      const call = callFromObject(p.value);
      if (call) calls.push(call);
    }
  }
  return calls;
}

export class TextStreamParser {
  private buffer = '';
  private block: Block | null = null;
  /** Text held back because the message might turn out to be a bare JSON tool call. */
  private jsonCandidate: string | null = null;
  private sawContent = false;
  private readonly known: Set<string>;
  callCount = 0;

  constructor(toolNames: Iterable<string>) {
    this.known = new Set(toolNames);
  }

  push(delta: string): ParserEvent[] {
    const out: ParserEvent[] = [];
    if (this.jsonCandidate !== null) {
      this.jsonCandidate += delta;
      // Give up early when it clearly is not a tool call, so normal text keeps streaming.
      if (this.jsonCandidate.length > 240 && !/"(name|tool|function)"\s*:/.test(this.jsonCandidate)) {
        this.buffer = this.jsonCandidate;
        this.jsonCandidate = null;
        this.sawContent = true;
        this.drain(out);
      }
      return out;
    }
    this.buffer += delta;
    if (!this.sawContent && this.block === null) {
      const lead = this.buffer.trimStart();
      if (lead === '') return out;
      if (this.known.size > 0 && (/^(\{|\[\s*\{)/.test(lead) || /^```(json)?\s*[{[]/.test(lead) || '```json'.startsWith(lead))) {
        this.jsonCandidate = this.buffer;
        this.buffer = '';
        return out;
      }
    }
    this.drain(out);
    return out;
  }

  /** Call at the end of the message. */
  flush(): ParserEvent[] {
    const out: ParserEvent[] = [];
    if (this.jsonCandidate !== null) {
      const text = this.jsonCandidate;
      this.jsonCandidate = null;
      const calls = parseToolPayload(text).filter((call) => this.known.has(call.name));
      if (calls.length) {
        for (const call of calls) this.emitCall(out, call);
      } else {
        this.buffer = text;
        this.sawContent = true;
        this.drain(out);
      }
    }
    if (this.block) {
      const block = this.block;
      this.block = null;
      if (block.kind === 'think') {
        if (this.buffer) out.push({ type: 'thinking', text: this.buffer });
      } else {
        this.finishCall(out, block, this.buffer, false);
      }
      this.buffer = '';
    } else if (this.buffer) {
      out.push({ type: 'text', text: this.buffer });
      this.buffer = '';
    }
    return out;
  }

  private drain(out: ParserEvent[]): void {
    for (;;) {
      if (this.block) {
        const block = this.block;
        if (block.close === null) return; // wait for flush
        const end = this.buffer.indexOf(block.close);
        if (end < 0) {
          if (block.kind === 'think') {
            const hold = partialMarkerSuffix(this.buffer, [block.close]);
            const text = this.buffer.slice(0, this.buffer.length - hold);
            if (text) out.push({ type: 'thinking', text });
            this.buffer = this.buffer.slice(this.buffer.length - hold);
          }
          return;
        }
        const inner = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + block.close.length);
        this.block = null;
        if (block.kind === 'think') {
          if (inner) out.push({ type: 'thinking', text: inner });
          // Drop the blank line that usually follows the closing tag.
          this.buffer = this.buffer.replace(/^\s*\n/, '');
        } else {
          this.finishCall(out, block, inner);
        }
        continue;
      }

      let first = -1;
      let found: Block | null = null;
      for (const block of BLOCKS) {
        const idx = this.buffer.indexOf(block.open);
        if (idx >= 0 && (first < 0 || idx < first)) {
          first = idx;
          found = block;
        }
      }
      if (found) {
        const before = this.buffer.slice(0, first);
        this.emitText(out, before);
        // Keep the opener for forms where it carries the tool name.
        this.buffer = this.buffer.slice(first + (carriesName(found) ? 0 : found.open.length));
        this.block = found;
        continue;
      }
      const hold = partialMarkerSuffix(this.buffer, OPENERS);
      this.emitText(out, this.buffer.slice(0, this.buffer.length - hold));
      this.buffer = this.buffer.slice(this.buffer.length - hold);
      return;
    }
  }

  private emitText(out: ParserEvent[], text: string): void {
    if (!text) return;
    if (text.trim()) this.sawContent = true;
    out.push({ type: 'text', text });
  }

  private emitCall(out: ParserEvent[], call: ToolCall): void {
    this.callCount++;
    this.sawContent = true;
    out.push({ type: 'tool_call', call });
  }

  private finishCall(out: ParserEvent[], block: Block, inner: string, closed = true): void {
    const calls = parseToolPayload(inner);
    if (calls.length === 0) {
      // Not a call after all: give the text back untouched.
      const close = closed ? (block.close ?? '') : '';
      this.emitText(out, (carriesName(block) ? '' : block.open) + inner + close);
      return;
    }
    for (const call of calls) this.emitCall(out, call);
  }
}

function describeTool(tool: ToolSpec): string {
  return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
}

export function textProtocolInstructions(tools: ToolSpec[]): string {
  return [
    '# Tools',
    '',
    'You can call tools. To call one, output a block in exactly this form:',
    '',
    '<tool_call>',
    '{"name": "<tool name>", "arguments": {<arguments as JSON>}}',
    '</tool_call>',
    '',
    'Rules:',
    '- The JSON must be valid and must match the tool\'s parameter schema.',
    '- You may output several <tool_call> blocks in one reply.',
    '- After your tool calls, stop and wait. Results arrive in <tool_response> blocks.',
    '- Never write a <tool_response> block yourself and never describe a call instead of making it.',
    '',
    'Available tools (JSON schema):',
    ...tools.map(describeTool),
  ].join('\n');
}

/** Render a tool call the way we ask the model to write it. */
export function renderToolCall(call: ToolCall): string {
  return `<tool_call>\n${JSON.stringify({ name: call.name, arguments: call.arguments })}\n</tool_call>`;
}

/**
 * Rewrite a request so tool use travels as text: tool definitions move into
 * the system prompt, assistant tool calls become <tool_call> blocks and tool
 * results become a user message of <tool_response> blocks.
 */
export function toTextProtocol(req: ChatRequest): ChatRequest {
  if (req.tools.length === 0) return req;
  const messages: Message[] = [];
  let pending: string[] = [];
  const flushResults = () => {
    if (pending.length) {
      messages.push({ role: 'user', content: pending.join('\n\n'), isMeta: true });
      pending = [];
    }
  };
  for (const msg of req.messages) {
    if (msg.role === 'tool') {
      const status = msg.isError ? ' status="error"' : '';
      pending.push(`<tool_response name="${msg.name}"${status}>\n${msg.content}\n</tool_response>`);
      if (msg.images?.length) {
        flushResults();
        messages.push({ role: 'user', content: [{ type: 'text', text: `Image returned by ${msg.name}:` }, ...msg.images], isMeta: true });
      }
      continue;
    }
    flushResults();
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const calls = msg.toolCalls.map(renderToolCall).join('\n');
      messages.push({ role: 'assistant', content: msg.content ? `${msg.content}\n\n${calls}` : calls });
    } else if (msg.role === 'user' && messages.length > 0 && messages[messages.length - 1]!.role === 'user') {
      // Keep roles alternating; some chat templates reject two user turns in a row.
      const prev = messages[messages.length - 1] as Extract<Message, { role: 'user' }>;
      if (typeof prev.content === 'string' && typeof msg.content === 'string') {
        prev.content = `${prev.content}\n\n${msg.content}`;
      } else {
        messages.push(msg);
      }
    } else {
      messages.push(msg);
    }
  }
  flushResults();
  return {
    ...req,
    system: `${req.system}\n\n${textProtocolInstructions(req.tools)}`,
    messages,
    tools: [],
  };
}

/** Plain-text rendering of a conversation, used for summaries and exports. */
export function renderTranscript(messages: Message[], maxToolChars = 1500): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      parts.push(`## User\n${messageText(msg.content)}`);
    } else if (msg.role === 'assistant') {
      const calls = (msg.toolCalls ?? []).map((c) => `[tool call] ${c.name}(${JSON.stringify(c.arguments)})`).join('\n');
      parts.push(`## Assistant\n${[msg.content, calls].filter(Boolean).join('\n')}`);
    } else {
      const body = msg.content.length > maxToolChars ? `${msg.content.slice(0, maxToolChars)}\n... [truncated]` : msg.content;
      parts.push(`## Tool result (${msg.name}${msg.isError ? ', error' : ''})\n${body}`);
    }
  }
  return parts.join('\n\n');
}
