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
import type { ContentPart, ImagePart, Message, ToolCall, ToolSpec } from '../types.ts';
import { messageText } from '../types.ts';
import { findBalancedEnd, isRecord, parseJsonLoose, stripCodeFence } from '../util/json.ts';
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

/** Told to the model when its arguments stopped mid-value; running them could write half a file. */
export const TRUNCATED_ARGS = 'the arguments were cut off before they were complete (the reply probably hit the output token limit)';

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
    if (parsed.ok && isRecord(parsed.value)) {
      return parsed.truncated ? { args: parsed.value, error: TRUNCATED_ARGS } : { args: parsed.value };
    }
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

const PARAM_RE = /<parameter(?:=|\s+name=)["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/parameter>/g;

function parseXmlParams(body: string): { args: Record<string, unknown>; truncated: boolean } {
  const args: Record<string, unknown> = {};
  PARAM_RE.lastIndex = 0;
  for (let m = PARAM_RE.exec(body); m; m = PARAM_RE.exec(body)) {
    let value = m[2]!;
    // One leading and one trailing newline are formatting, not content.
    value = value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    args[m[1]!] = value;
  }
  // An opening tag left over once the complete parameters are removed was never closed.
  const truncated = /<parameter[=\s]/.test(body.replace(PARAM_RE, ''));
  return { args, truncated };
}

/** Every top-level JSON value in `text`, skipping the prose between them. */
function scanJsonValues(text: string): { value: unknown; truncated: boolean }[] {
  const out: { value: unknown; truncated: boolean }[] = [];
  const opener = /[{[]/g;
  let pos = 0;
  while (pos < text.length) {
    opener.lastIndex = pos;
    const m = opener.exec(text);
    if (!m) break;
    const start = m.index;
    const end = findBalancedEnd(text, start);
    const parsed = parseJsonLoose(end < 0 ? text.slice(start) : text.slice(start, end + 1));
    if (parsed.ok) out.push({ value: parsed.value, truncated: Boolean(parsed.truncated) });
    if (end < 0) break;
    // A bracket that did not parse may just be prose ("[see below]"): keep looking after it.
    pos = end + 1;
  }
  return out;
}

/**
 * Parse the inside of a tool-call block. Accepts JSON (one call, a list, or
 * several objects in a row) and the XML-ish forms several model families use.
 */
export function parseToolPayload(raw: string): ToolCall[] {
  const text = stripCodeFence(raw.trim());
  if (!text) return [];

  // A model that forgot a closing tag before opening the next block.
  if (/<\/?tool_call>/.test(text)) return text.split(/<\/?tool_call>/).flatMap((part) => parseToolPayload(part));

  const calls: ToolCall[] = [];

  // <function=name>...</function> and <invoke name="...">...</invoke>
  const xmlRe = /<(?:function=|invoke\s+name=)["']?([\w.:-]+)["']?\s*>([\s\S]*?)(?:<\/(?:function|invoke)>|$)/g;
  for (let m = xmlRe.exec(text); m; m = xmlRe.exec(text)) {
    const body = m[2]!;
    if (/<parameter[=\s]/.test(body)) {
      const { args, truncated } = parseXmlParams(body);
      const call: ToolCall = { id: newCallId(), name: m[1]!, arguments: args };
      if (truncated) call.parseError = TRUNCATED_ARGS;
      calls.push(call);
    } else {
      const { args, error } = normalizeArgs(body.trim());
      const call: ToolCall = { id: newCallId(), name: m[1]!, arguments: args };
      if (error) call.parseError = error;
      calls.push(call);
    }
  }
  if (calls.length) return calls;

  // Name followed directly by its arguments: Read{"file_path": ...} or Read[ARGS]{...}
  const named = /^([A-Za-z_][\w.-]*)\s*(?:\[ARGS\])?\s*(\{[\s\S]*)$/.exec(text);
  if (named) {
    const { args, error } = normalizeArgs(named[2]!);
    if (!error || error === TRUNCATED_ARGS) {
      const call: ToolCall = { id: newCallId(), name: named[1]!, arguments: args };
      if (error) call.parseError = error;
      return [call];
    }
  }

  for (const { value, truncated } of scanJsonValues(text)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!isRecord(item)) continue;
      const call = callFromObject(item);
      if (!call) continue;
      if (truncated && !call.parseError) call.parseError = TRUNCATED_ARGS;
      calls.push(call);
    }
  }
  return calls;
}

/**
 * Could a message that starts like this be a bare JSON tool call?
 * "maybe" means too little has arrived to tell.
 */
function jsonStart(lead: string): 'yes' | 'maybe' | 'no' {
  if (/^(?:\{|\[\s*\{)/.test(lead)) return 'yes';
  if (/^```(?:json)?\s*[{[]/.test(lead)) return 'yes';
  if (/^\[\s*$/.test(lead)) return 'maybe';
  if (/^`{1,2}$/.test(lead) || /^```(?:j(?:s(?:o(?:n)?)?)?)?\s*$/.test(lead)) return 'maybe';
  return 'no';
}

/** How much of a possible bare-JSON call is buffered before giving up on text that names no tool. */
const JSON_HOLD_LIMIT = 240;

export class TextStreamParser {
  private buffer = '';
  private block: Block | null = null;
  /** The buffer is being held because the message may be one bare JSON tool call. */
  private jsonHold = false;
  private jsonRuledOut = false;
  /** Whether any text or call has been emitted (reasoning does not count). */
  private sawContent = false;
  /** A reasoning block just closed: the blank line after it is formatting, not content. */
  private trimLead = false;
  private readonly known: Set<string>;
  callCount = 0;

  constructor(toolNames: Iterable<string>) {
    this.known = new Set(toolNames);
  }

  push(delta: string): ParserEvent[] {
    const out: ParserEvent[] = [];
    this.buffer += delta;
    this.drain(out, false);
    return out;
  }

  /** Call at the end of the message. */
  flush(): ParserEvent[] {
    const out: ParserEvent[] = [];
    this.drain(out, true);
    return out;
  }

  private drain(out: ParserEvent[], final: boolean): void {
    for (;;) {
      if (this.block) {
        const block = this.block;
        const end = block.close === null ? -1 : this.buffer.indexOf(block.close);
        if (end < 0) {
          if (final) {
            // The message ended inside the block: use what there is.
            const inner = this.buffer;
            this.buffer = '';
            this.block = null;
            if (block.kind === 'think') {
              if (inner) out.push({ type: 'thinking', text: inner });
            } else {
              this.finishCall(out, block, inner, false);
            }
            continue;
          }
          if (block.kind === 'think' && block.close !== null) {
            const hold = partialMarkerSuffix(this.buffer, [block.close]);
            const text = this.buffer.slice(0, this.buffer.length - hold);
            if (text) out.push({ type: 'thinking', text });
            this.buffer = this.buffer.slice(this.buffer.length - hold);
          }
          return;
        }
        const inner = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + block.close!.length);
        this.block = null;
        if (block.kind === 'think') {
          if (inner) out.push({ type: 'thinking', text: inner });
          this.trimLead = true;
        } else {
          this.finishCall(out, block, inner);
        }
        continue;
      }

      if (this.jsonHold) {
        if (final) {
          const calls = parseToolPayload(this.buffer).filter((call) => this.known.has(call.name));
          this.jsonHold = false;
          this.jsonRuledOut = true;
          if (calls.length === 0) continue; // not a call: fall through and treat it as text
          this.buffer = '';
          for (const call of calls) this.emitCall(out, call);
          return;
        }
        const tooLong = this.buffer.length > JSON_HOLD_LIMIT && !/["'](?:name|tool|tool_name|function)["']\s*:/.test(this.buffer);
        if (tooLong || jsonStart(this.buffer.trimStart()) === 'no') {
          // Clearly not a call after all: let it stream as ordinary text.
          this.jsonHold = false;
          this.jsonRuledOut = true;
          continue;
        }
        return;
      }

      if (this.trimLead) {
        // Wait until something other than whitespace arrives, so the result
        // does not depend on where the stream happened to be split.
        if (!final && /^\s*$/.test(this.buffer)) return;
        this.buffer = this.buffer.replace(/^\s*\n/, '');
        this.trimLead = false;
      }

      if (!this.sawContent && !this.jsonRuledOut) {
        const lead = this.buffer.trimStart();
        if (lead === '') {
          // Leading whitespace is held until we know what follows it.
          if (final && this.buffer) {
            out.push({ type: 'text', text: this.buffer });
            this.buffer = '';
          }
          return;
        }
        if (this.known.size > 0 && jsonStart(lead) !== 'no') {
          this.jsonHold = true;
          continue;
        }
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
        this.emitText(out, this.buffer.slice(0, first));
        // Keep the opener for forms where it carries the tool name.
        this.buffer = this.buffer.slice(first + (carriesName(found) ? 0 : found.open.length));
        this.block = found;
        continue;
      }
      const hold = final ? 0 : partialMarkerSuffix(this.buffer, OPENERS);
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
      const text = (carriesName(block) ? '' : block.open) + inner + close;
      if (text) {
        this.sawContent = true;
        out.push({ type: 'text', text });
      }
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

/** Join two user contents into one, keeping any images. */
function mergeContent(a: string | ContentPart[], b: string | ContentPart[]): string | ContentPart[] {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n\n${b}`;
  const parts: ContentPart[] = [...(typeof a === 'string' ? [{ type: 'text' as const, text: a }] : a), ...(typeof b === 'string' ? [{ type: 'text' as const, text: b }] : b)];
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n\n');
  const images = parts.filter((p): p is ImagePart => p.type === 'image');
  return [{ type: 'text', text }, ...images];
}

/**
 * Rewrite a request so tool use travels as text: tool definitions move into
 * the system prompt, assistant tool calls become <tool_call> blocks and tool
 * results become a user message of <tool_response> blocks. Neighbouring user
 * turns are merged, since many chat templates reject two in a row. The
 * request and its messages are left untouched.
 */
export function toTextProtocol(req: ChatRequest): ChatRequest {
  if (req.tools.length === 0) return req;
  const messages: Message[] = [];

  const appendUser = (content: string | ContentPart[], isMeta: boolean) => {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === 'user') {
      // Replace rather than edit: `prev` may be one of the caller's own message objects.
      const merged: Message = { role: 'user', content: mergeContent(prev.content, content) };
      if (prev.isMeta && isMeta) merged.isMeta = true;
      messages[messages.length - 1] = merged;
      return;
    }
    const msg: Message = { role: 'user', content };
    if (isMeta) msg.isMeta = true;
    messages.push(msg);
  };

  for (const msg of req.messages) {
    if (msg.role === 'tool') {
      const status = msg.isError ? ' status="error"' : '';
      const text = `<tool_response name="${msg.name}"${status}>\n${msg.content}\n</tool_response>`;
      appendUser(msg.images?.length ? [{ type: 'text', text }, ...msg.images] : text, true);
    } else if (msg.role === 'user') {
      appendUser(msg.content, Boolean(msg.isMeta));
    } else if (msg.toolCalls?.length) {
      const calls = msg.toolCalls.map(renderToolCall).join('\n');
      messages.push({ role: 'assistant', content: msg.content ? `${msg.content}\n\n${calls}` : calls });
    } else {
      messages.push({ role: 'assistant', content: msg.content });
    }
  }
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
