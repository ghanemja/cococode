/**
 * A live check of the connected model: does it call tools, read their results
 * and fill in arguments correctly? Three small requests, no project files and
 * no real tools involved. It answers "will this model work as an agent here"
 * before a long task finds out the hard way.
 */
import type { Controller } from '../core/controller.ts';
import { ModelClient } from '../providers/index.ts';
import type { Message, ToolCall, ToolSpec, Usage } from '../types.ts';
import { c, formatDuration } from '../ui/ansi.ts';
import { validateInput } from '../util/schema.ts';

const SYSTEM = 'You are being tested for tool use inside a coding agent. Follow each instruction exactly. When told to call a tool, call it instead of describing it.';

const MAGIC: ToolSpec = {
  name: 'get_magic_number',
  description: 'Returns the magic number. Takes no arguments.',
  parameters: { type: 'object', properties: {} },
};

const ADD: ToolSpec = {
  name: 'add_numbers',
  description: 'Adds two numbers and returns the sum.',
  parameters: { type: 'object', properties: { a: { type: 'number', description: 'First number' }, b: { type: 'number', description: 'Second number' } }, required: ['a', 'b'] },
};

interface Reply {
  text: string;
  calls: ToolCall[];
  usage?: Usage;
  firstMs?: number;
  totalMs: number;
  error?: string;
}

async function ask(client: ModelClient, messages: Message[], tools: ToolSpec[], signal?: AbortSignal): Promise<Reply> {
  const started = Date.now();
  const reply: Reply = { text: '', calls: [], totalMs: 0 };
  try {
    for await (const ev of client.chat({ system: SYSTEM, messages, tools, signal, maxTokens: Math.min(client.profile.maxOutputTokens, 1024) })) {
      if (reply.firstMs === undefined && (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool_call' || ev.type === 'progress')) reply.firstMs = Date.now() - started;
      if (ev.type === 'text') reply.text += ev.text;
      else if (ev.type === 'tool_call') reply.calls.push(ev.call);
      else if (ev.type === 'usage') reply.usage = ev.usage;
    }
  } catch (err) {
    reply.error = (err as Error).message.split('\n')[0];
  }
  reply.totalMs = Date.now() - started;
  return reply;
}

const said = (reply: Reply): string => (reply.error ? `error: ${reply.error}` : reply.text.trim() ? `it replied: "${reply.text.trim().replace(/\s+/g, ' ').slice(0, 120)}"` : 'it replied with nothing');

export interface ProbeResult {
  ok: boolean;
  lines: string[];
  /** The tool mode that worked, when it differs from the one in use. */
  suggestToolMode?: 'native' | 'prompt';
}

/** Run the checks against the session's model. */
export async function probeModel(ctl: Controller, signal?: AbortSignal): Promise<ProbeResult> {
  const pass = c.green('✓');
  const fail = c.red('✗');
  const warn = c.yellow('!');
  const lines: string[] = [];
  let ok = true;
  let client = ctl.client;
  let suggestToolMode: ProbeResult['suggestToolMode'];

  // 1. Does it call a tool when told to?
  const callIt: Message[] = [{ role: 'user', content: 'Call the get_magic_number tool now.' }];
  let first = await ask(client, callIt, [MAGIC], signal);
  const called = (r: Reply): ToolCall | undefined => r.calls.find((call) => call.name === MAGIC.name);
  if (!called(first) && client.profile.toolMode === 'native') {
    // Many local models advertise tool calling but do it badly: the text protocol is the usual fix.
    const textClient = new ModelClient(ctl.provider, client.model, { ...client.profile, toolMode: 'prompt' }, ctl.settings);
    const second = await ask(textClient, callIt, [MAGIC], signal);
    if (called(second)) {
      lines.push(`  ${warn} Native tool calling did not produce a tool call (${said(first)}), but the text tool protocol works.`);
      lines.push(`      Fix: ${c.bold('coco config set toolMode prompt')}`);
      suggestToolMode = 'prompt';
      client = textClient;
      first = second;
    }
  }
  const call = called(first);
  if (!call) {
    lines.push(`  ${fail} The model did not call a tool when told to (${said(first)}).`);
    lines.push('      It cannot work as an agent as configured. Try a model trained for tool use (for example qwen3-coder, devstral or gpt-oss) or a larger quantization.');
    return { ok: false, lines };
  }
  const speed = first.usage?.tokensPerSecond ? `, ${Math.round(first.usage.tokensPerSecond)} tokens/s` : '';
  lines.push(`  ${pass} Tool call (${client.profile.toolMode === 'native' ? 'native' : 'text protocol'}): first output after ${formatDuration(first.firstMs ?? first.totalMs)}, done in ${formatDuration(first.totalMs)}${speed}`);

  // 2. Does it use what the tool returned?
  const withResult: Message[] = [
    ...callIt,
    { role: 'assistant', content: first.text, toolCalls: [call] },
    { role: 'tool', toolCallId: call.id, name: call.name, content: 'The magic number is 7412.' },
    { role: 'user', content: 'What is the magic number? Answer with just the number.' },
  ];
  const second = await ask(client, withResult, [MAGIC], signal);
  if (second.text.includes('7412')) lines.push(`  ${pass} Reads tool results`);
  else {
    ok = false;
    lines.push(`  ${fail} Did not use the tool result (${said(second)}${second.calls.length ? `; it called ${second.calls.map((x) => x.name).join(', ')} again` : ''}).`);
  }

  // 3. Does it fill in arguments of the right type?
  const third = await ask(client, [{ role: 'user', content: 'Call the add_numbers tool with a=17 and b=25.' }], [ADD], signal);
  const add = third.calls.find((x) => x.name === ADD.name);
  const args = add && !add.parseError ? validateInput(ADD.parameters, add.arguments) : undefined;
  if (args?.ok && args.value.a === 17 && args.value.b === 25) lines.push(`  ${pass} Tool arguments`);
  else {
    ok = false;
    lines.push(`  ${fail} Wrong tool arguments (${add ? `got ${JSON.stringify(add.arguments)}${add.parseError ? `, ${add.parseError}` : ''}` : said(third)}).`);
  }

  // 4. Is the context window what we plan around?
  const info = client.profile.info;
  if (info?.loadedContextLength && info.loadedContextLength < client.profile.contextWindow) {
    ok = false;
    lines.push(`  ${fail} The server runs this model with a ${info.loadedContextLength}-token context, below the ${client.profile.contextWindow} coco plans for: long prompts would be cut off silently.`);
    lines.push(`      Fix: reload the model with a larger context, or ${c.bold(`coco config set contextWindow ${info.loadedContextLength}`)}`);
  } else if (first.usage && first.usage.inputTokens > 0) {
    lines.push(`  ${pass} Context: ${client.profile.contextWindow} tokens planned; the server counted ${first.usage.inputTokens} for the test prompt`);
  } else {
    lines.push(`  ${warn} The server does not report token usage, so context use is estimated from text length.`);
  }

  lines.push('', ok ? `  ${pass} ${client.model} passed the tool-use checks.` : `  ${fail} ${client.model} failed a check above: expect unreliable results on real tasks.`);
  return { ok, lines, suggestToolMode };
}
