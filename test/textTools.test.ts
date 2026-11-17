import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  TextStreamParser,
  parseToolPayload,
  renderToolCall,
  renderTranscript,
  textProtocolInstructions,
  toTextProtocol,
} from '../src/providers/textTools.ts';
import type { ChatRequest } from '../src/providers/types.ts';
import type { ImagePart, Message, ToolSpec } from '../src/types.ts';

const TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep'];

interface Outcome {
  text: string;
  thinking: string;
  calls: { name: string; arguments: Record<string, unknown>; parseError?: true }[];
}

function feed(chunks: string[], tools: string[] = TOOLS): Outcome {
  const parser = new TextStreamParser(tools);
  const out: Outcome = { text: '', thinking: '', calls: [] };
  const take = (events: ReturnType<TextStreamParser['push']>) => {
    for (const ev of events) {
      if (ev.type === 'text') out.text += ev.text;
      else if (ev.type === 'thinking') out.thinking += ev.text;
      else {
        const call: Outcome['calls'][number] = { name: ev.call.name, arguments: ev.call.arguments };
        if (ev.call.parseError) call.parseError = true;
        out.calls.push(call);
      }
    }
  };
  for (const chunk of chunks) take(parser.push(chunk));
  take(parser.flush());
  assert.equal(parser.callCount, out.calls.length, 'callCount matches the calls emitted');
  return out;
}

/** Small deterministic PRNG so the random chunkings are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChunks(text: string, rand: () => number, maxLen: number): string[] {
  const points = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < points.length; ) {
    const n = 1 + Math.floor(rand() * maxLen);
    chunks.push(points.slice(i, i + n).join(''));
    i += n;
  }
  return chunks;
}

/**
 * Assert the outcome for the whole input in one chunk, then that feeding the
 * same input one character at a time and in random pieces gives the same.
 */
function check(input: string, expected: Partial<Outcome>, tools: string[] = TOOLS): void {
  const want: Outcome = { text: '', thinking: '', calls: [], ...expected };
  assert.deepEqual(feed([input], tools), want, 'single chunk');
  assert.deepEqual(feed(Array.from(input), tools), want, 'one character at a time');
  const rand = mulberry32(input.length * 7919 + 13);
  for (let round = 0; round < 30; round++) {
    const chunks = randomChunks(input, rand, round % 3 === 0 ? 3 : round % 3 === 1 ? 9 : 40);
    assert.deepEqual(feed(chunks, tools), want, `random chunking: ${JSON.stringify(chunks)}`);
  }
}

const READ_A = { name: 'Read', arguments: { file_path: 'a.txt' } };

describe('TextStreamParser: plain text', () => {
  test('ordinary prose passes through unchanged', () => {
    check('Hello, world. This is a test.\n\nSecond paragraph.', { text: 'Hello, world. This is a test.\n\nSecond paragraph.' });
  });

  test('an empty message produces nothing', () => {
    check('', {});
  });

  test('whitespace-only output is preserved', () => {
    check('  \n ', { text: '  \n ' });
  });

  test('text that only resembles markup passes through unchanged', () => {
    for (const text of [
      'a < b and c > d',
      'ends with a lone <',
      '<',
      'Use the <thinking',
      'The <tool_callback> hook and <tool_calls> list',
      'a <function> without a name, and <functional> too',
      '<thinker> and <thinks> are not reasoning tags',
      '[TODO] fix this, [TOOL] too, and a list [1, 2, 3]',
      '<div class="x">hi</div>',
      'const m: Map<string, Array<number>> = new Map();',
      'if (a <= b && c >= d) { return x << 2; }',
      '<|im_end|> and <|other_tag|>',
      'An <invoke> tag with no name',
      '[',
      '`inline code` first',
      '``` is three backticks',
    ]) {
      check(text, { text });
    }
  });

  test('code fences that are not JSON pass through unchanged', () => {
    const text = '```python\nprint("hi")\n```\nThat prints hi.';
    check(text, { text });
    const js = '```js\nconst name = "x";\n```';
    check(js, { text: js });
  });
});

describe('TextStreamParser: reasoning blocks', () => {
  test('<think> becomes thinking and the blank line after it is dropped', () => {
    check('<think>Let me think.\nStep 2.</think>\n\nThe answer is 4.', { thinking: 'Let me think.\nStep 2.', text: 'The answer is 4.' });
  });

  test('<thinking> works the same way', () => {
    check('<thinking>hmm</thinking>Answer', { thinking: 'hmm', text: 'Answer' });
  });

  test('indentation after the dropped blank line is kept', () => {
    check('<think>x</think>\n\n    indented code', { thinking: 'x', text: '    indented code' });
  });

  test('spaces without a newline after the block are kept', () => {
    check('Intro <think>x</think> outro', { thinking: 'x', text: 'Intro  outro' });
  });

  test('a message that is only reasoning has no text', () => {
    check('<think>just thinking</think>\n', { thinking: 'just thinking' });
    check('<think>just thinking</think>', { thinking: 'just thinking' });
  });

  test('an unterminated block is all reasoning', () => {
    check('<think>never ends, the budget ran out', { thinking: 'never ends, the budget ran out' });
  });

  test('angle brackets inside reasoning do not end it early', () => {
    check('<think>if a < b then </thin is not the end</think>ok', { thinking: 'if a < b then </thin is not the end', text: 'ok' });
  });

  test('two reasoning blocks are both captured', () => {
    check('<think>one</think>\nA\n<think>two</think>\nB', { thinking: 'onetwo', text: 'A\nB' });
  });
});

describe('TextStreamParser: tool calls in explicit blocks', () => {
  test('<tool_call> with JSON', () => {
    check('I will read it.\n<tool_call>\n{"name": "Read", "arguments": {"file_path": "a.txt"}}\n</tool_call>', {
      text: 'I will read it.\n',
      calls: [READ_A],
    });
  });

  test('several <tool_call> blocks with text after them', () => {
    check(
      '<tool_call>{"name":"Read","arguments":{"file_path":"a.txt"}}</tool_call>\n<tool_call>{"name":"Bash","arguments":{"command":"ls -la"}}</tool_call>\nDone.',
      { text: '\n\nDone.', calls: [READ_A, { name: 'Bash', arguments: { command: 'ls -la' } }] },
    );
  });

  test('an unknown tool name in an explicit block is still a call', () => {
    // The agent loop answers with "unknown tool", which lets the model correct itself.
    check('<tool_call>{"name":"Dance","arguments":{}}</tool_call>', { calls: [{ name: 'Dance', arguments: {} }] });
  });

  test('Qwen-coder XML parameters', () => {
    check(
      '<tool_call>\n<function=Read>\n<parameter=file_path>\n/tmp/a.txt\n</parameter>\n<parameter=limit>\n20\n</parameter>\n</function>\n</tool_call>',
      { calls: [{ name: 'Read', arguments: { file_path: '/tmp/a.txt', limit: '20' } }] },
    );
  });

  test('XML parameter values keep inner newlines and indentation', () => {
    check(
      '<tool_call>\n<function=Write>\n<parameter=file_path>\na.py\n</parameter>\n<parameter=content>\ndef f():\n    return 1\n\nprint(f())\n</parameter>\n</function>\n</tool_call>',
      { calls: [{ name: 'Write', arguments: { file_path: 'a.py', content: 'def f():\n    return 1\n\nprint(f())' } }] },
    );
  });

  test('a bare <function=name> block with XML parameters', () => {
    check('<function=Read>\n<parameter=file_path>a.txt</parameter>\n</function>', { calls: [READ_A] });
  });

  test('a bare <function=name> block with JSON arguments', () => {
    check('Listing.\n<function=Bash>{"command": "ls -la"}</function>', { text: 'Listing.\n', calls: [{ name: 'Bash', arguments: { command: 'ls -la' } }] });
  });

  test('<function_calls> with <invoke> and named parameters', () => {
    check(
      '<function_calls>\n<invoke name="Grep">\n<parameter name="pattern">TODO</parameter>\n<parameter name="path">src</parameter>\n</invoke>\n</function_calls>',
      { calls: [{ name: 'Grep', arguments: { pattern: 'TODO', path: 'src' } }] },
    );
  });

  test('two <invoke> blocks inside one <function_calls>', () => {
    check(
      '<function_calls><invoke name="Read"><parameter name="file_path">a.txt</parameter></invoke><invoke name="Read"><parameter name="file_path">b.txt</parameter></invoke></function_calls>',
      { calls: [READ_A, { name: 'Read', arguments: { file_path: 'b.txt' } }] },
    );
  });

  test('a bare <invoke> block', () => {
    check('<invoke name="Read"><parameter name="file_path">a.txt</parameter></invoke>', { calls: [READ_A] });
  });

  test('[TOOL_CALLS] with a JSON list', () => {
    check('[TOOL_CALLS] [{"name": "Read", "arguments": {"file_path": "a.txt"}}]', { calls: [READ_A] });
    check('Sure.[TOOL_CALLS][{"name": "Read", "arguments": {"file_path": "a.txt"}}, {"name": "Bash", "arguments": {"command": "pwd"}}]', {
      text: 'Sure.',
      calls: [READ_A, { name: 'Bash', arguments: { command: 'pwd' } }],
    });
  });

  test('[TOOL_CALLS] in the name-then-arguments form', () => {
    check('[TOOL_CALLS]Read[ARGS]{"file_path": "a.txt"}', { calls: [READ_A] });
    check('[TOOL_CALLS]Read{"file_path": "a.txt"}', { calls: [READ_A] });
  });

  test('<|python_tag|> with llama-style "parameters"', () => {
    check('<|python_tag|>{"name": "Read", "parameters": {"file_path": "a.txt"}}', { calls: [READ_A] });
  });

  test('<|tool_call|> delimiters', () => {
    check('<|tool_call|>{"name": "Read", "arguments": {"file_path": "a.txt"}}<|/tool_call|>', { calls: [READ_A] });
  });

  test('arguments given as a JSON string are decoded', () => {
    check('<tool_call>{"name": "Read", "arguments": "{\\"file_path\\": \\"a.txt\\"}"}</tool_call>', { calls: [READ_A] });
  });

  test('the OpenAI wire shape inside a block', () => {
    check('<tool_call>{"type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"a.txt\\"}"}}</tool_call>', { calls: [READ_A] });
  });

  test('python-dict syntax inside a block', () => {
    check("<tool_call>\n{'name': 'Read', 'arguments': {'file_path': 'a.txt'}}\n</tool_call>", { calls: [READ_A] });
  });

  test('repairable JSON is repaired: trailing comma and raw newline in a string', () => {
    check('<tool_call>{"name": "Write", "arguments": {"file_path": "a.txt", "content": "one\ntwo",},}</tool_call>', {
      calls: [{ name: 'Write', arguments: { file_path: 'a.txt', content: 'one\ntwo' } }],
    });
  });

  test('a block missing its close tag is parsed at the end of the message', () => {
    check('<tool_call>\n{"name": "Read", "arguments": {"file_path": "a.txt"}}\n', { calls: [READ_A] });
    check('<function=Read>{"file_path": "a.txt"}', { calls: [READ_A] });
  });

  test('a new <tool_call> before the previous one closed yields both calls', () => {
    check('<tool_call>{"name":"Read","arguments":{"file_path":"a.txt"}}\n<tool_call>{"name":"Read","arguments":{"file_path":"b.txt"}}</tool_call>', {
      calls: [READ_A, { name: 'Read', arguments: { file_path: 'b.txt' } }],
    });
  });

  test('several JSON objects in one block, one per line', () => {
    check('<tool_call>\n{"name":"Read","arguments":{"file_path":"a.txt"}}\n{"name":"Bash","arguments":{"command":"pwd"}}\n</tool_call>', {
      calls: [READ_A, { name: 'Bash', arguments: { command: 'pwd' } }],
    });
  });

  test('a call cut off mid-arguments is flagged, never run with partial content', () => {
    const out = feed(['<tool_call>{"name": "Write", "arguments": {"file_path": "a.txt", "content": "partial conte']);
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0]!.name, 'Write');
    assert.equal(out.calls[0]!.parseError, true);
    check('<tool_call>{"name": "Write", "arguments": {"file_path": "a.txt", "content": "partial conte', { calls: out.calls });
  });

  test('a block that is not a call is given back as text, tags included', () => {
    check('<tool_call>this is not a call</tool_call> ok', { text: '<tool_call>this is not a call</tool_call> ok' });
    check('<tool_call>unfinished prose', { text: '<tool_call>unfinished prose' });
    check('<|python_tag|>print("hello")', { text: '<|python_tag|>print("hello")' });
  });

  test('reasoning followed by a call', () => {
    check('<think>I should read the file first.</think>\n\n<tool_call>\n{"name": "Read", "arguments": {"file_path": "a.txt"}}\n</tool_call>', {
      thinking: 'I should read the file first.',
      calls: [READ_A],
    });
  });

  test('characters outside the BMP survive chunking', () => {
    const rocket = String.fromCodePoint(0x1f680);
    check(`Launch ${rocket}!\n<tool_call>{"name":"Bash","arguments":{"command":"echo ${rocket}"}}</tool_call>`, {
      text: `Launch ${rocket}!\n`,
      calls: [{ name: 'Bash', arguments: { command: `echo ${rocket}` } }],
    });
  });
});

describe('TextStreamParser: bare JSON calls', () => {
  test('a whole-message JSON object naming a known tool is a call', () => {
    check('{"name": "Read", "arguments": {"file_path": "a.txt"}}', { calls: [READ_A] });
    check('\n  {"name": "Read", "arguments": {"file_path": "a.txt"}}\n', { calls: [READ_A] });
  });

  test('llama-style "parameters"', () => {
    check('{"name": "Read", "parameters": {"file_path": "a.txt"}}', { calls: [READ_A] });
  });

  test('a JSON list of calls', () => {
    check('[{"name": "Read", "arguments": {"file_path": "a.txt"}}, {"name": "Bash", "arguments": {"command": "pwd"}}]', {
      calls: [READ_A, { name: 'Bash', arguments: { command: 'pwd' } }],
    });
    check('[ {"name": "Read", "arguments": {"file_path": "a.txt"}} ]', { calls: [READ_A] });
  });

  test('a ```json fenced call', () => {
    check('```json\n{"name": "Read", "arguments": {"file_path": "a.txt"}}\n```', { calls: [READ_A] });
    check('```\n{"name": "Read", "arguments": {"file_path": "a.txt"}}\n```', { calls: [READ_A] });
  });

  test('reasoning followed by a bare JSON call', () => {
    check('<think>I should read it.</think>\n{"name": "Read", "arguments": {"file_path": "a.txt"}}', { thinking: 'I should read it.', calls: [READ_A] });
  });

  test('a bare JSON call cut off mid-arguments is flagged, not run', () => {
    const out = feed(['{"name": "Write", "arguments": {"file_path": "a.txt", "content": "half a fi']);
    assert.equal(out.text, '');
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0]!.name, 'Write');
    assert.equal(out.calls[0]!.parseError, true);
  });

  test('an unknown tool name is left as text', () => {
    const text = '{"name": "Dance", "arguments": {"style": "tango"}}';
    check(text, { text });
  });

  test('a JSON answer that is not a call is left as text', () => {
    for (const text of [
      '{"result": 42, "items": [1, 2, 3]}',
      '[1, 2, 3]',
      '[ ]',
      '{"name": "Alice", "age": 30}',
      '```json\n{"a": 1}\n```\nThat is the config.',
      `{"data": "${'x'.repeat(400)}", "more": [${'1,'.repeat(50)}1]}`,
      '{ not really json',
    ]) {
      check(text, { text });
    }
  });

  test('JSON after ordinary text is never treated as a call', () => {
    const text = 'The call would be {"name": "Read", "arguments": {"file_path": "a.txt"}}';
    check(text, { text });
  });

  test('without known tools nothing is held back', () => {
    const parser = new TextStreamParser([]);
    assert.deepEqual(parser.push('{"name": "Read"'), [{ type: 'text', text: '{"name": "Read"' }]);
    check('{"name": "Read", "arguments": {}}', { text: '{"name": "Read", "arguments": {}}' }, []);
  });
});

describe('TextStreamParser: streaming latency', () => {
  test('prose is emitted as it arrives', () => {
    const parser = new TextStreamParser(TOOLS);
    assert.deepEqual(parser.push('Hello'), [{ type: 'text', text: 'Hello' }]);
    assert.deepEqual(parser.push(' wor'), [{ type: 'text', text: ' wor' }]);
    assert.deepEqual(parser.push('ld.\n'), [{ type: 'text', text: 'ld.\n' }]);
  });

  test('only a possible tag prefix is held, and released as soon as it is ruled out', () => {
    const parser = new TextStreamParser(TOOLS);
    parser.push('a ');
    assert.deepEqual(parser.push('<'), []);
    assert.deepEqual(parser.push('b'), [{ type: 'text', text: '<b' }]);
    assert.deepEqual(parser.push(' x <too'), [{ type: 'text', text: ' x ' }]);
    assert.deepEqual(parser.push('l_box>'), [{ type: 'text', text: '<tool_box>' }]);
  });

  test('leading whitespace waits for the first real character', () => {
    const parser = new TextStreamParser(TOOLS);
    assert.deepEqual(parser.push('\n'), []);
    assert.deepEqual(parser.push('Hi'), [{ type: 'text', text: '\nHi' }]);
  });

  test('reasoning streams incrementally', () => {
    const parser = new TextStreamParser(TOOLS);
    assert.deepEqual(parser.push('<think>abc'), [{ type: 'thinking', text: 'abc' }]);
    assert.deepEqual(parser.push('def</thi'), [{ type: 'thinking', text: 'def' }]);
    assert.deepEqual(parser.push('nk>X'), [{ type: 'text', text: 'X' }]);
  });

  test('a fence that turns out not to be JSON is released without waiting for the end', () => {
    const parser = new TextStreamParser(TOOLS);
    assert.deepEqual(parser.push('```'), []);
    assert.deepEqual(parser.push('py'), [{ type: 'text', text: '```py' }]);
    assert.deepEqual(parser.push('thon\n'), [{ type: 'text', text: 'thon\n' }]);
  });

  test('a long JSON answer is released once it clearly is not a call', () => {
    const parser = new TextStreamParser(TOOLS);
    const events = parser.push(`{"data": "${'x'.repeat(300)}`);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'text');
    assert.deepEqual(parser.push('more"}'), [{ type: 'text', text: 'more"}' }]);
  });

  test('a tool call is emitted when its block closes, not at the end of the message', () => {
    const parser = new TextStreamParser(TOOLS);
    const events = parser.push('<tool_call>{"name":"Read","arguments":{"file_path":"a.txt"}}</tool_call>');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'tool_call');
    assert.equal(parser.callCount, 1);
  });

  test('each call gets a distinct id', () => {
    const parser = new TextStreamParser(TOOLS);
    const events = [...parser.push('<tool_call>{"name":"Read","arguments":{}}</tool_call><tool_call>{"name":"Read","arguments":{}}</tool_call>'), ...parser.flush()];
    const ids = events.filter((e) => e.type === 'tool_call').map((e) => (e.type === 'tool_call' ? e.call.id : ''));
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.ok(ids.every((id) => id.length > 4));
  });

  test('an id supplied by the model is kept', () => {
    const [call] = parseToolPayload('{"id": "abc123", "name": "Read", "arguments": {}}');
    assert.equal(call!.id, 'abc123');
  });
});

describe('parseToolPayload', () => {
  const names = (raw: string) => parseToolPayload(raw).map((c) => [c.name, c.arguments]);

  test('accepts the alternative key names models use', () => {
    assert.deepEqual(names('{"tool": "Read", "args": {"file_path": "a"}}'), [['Read', { file_path: 'a' }]]);
    assert.deepEqual(names('{"tool_name": "Read", "input": {"file_path": "a"}}'), [['Read', { file_path: 'a' }]]);
    assert.deepEqual(names('{"function": "Read", "params": {"file_path": "a"}}'), [['Read', { file_path: 'a' }]]);
  });

  test('a call without arguments has an empty object', () => {
    assert.deepEqual(names('{"name": "Read"}'), [['Read', {}]]);
    assert.deepEqual(names('{"name": "Read", "arguments": null}'), [['Read', {}]]);
    assert.deepEqual(names('{"name": "Read", "arguments": ""}'), [['Read', {}]]);
  });

  test('arguments that are not an object set parseError', () => {
    const [call] = parseToolPayload('{"name": "Read", "arguments": [1, 2]}');
    assert.equal(call!.name, 'Read');
    assert.ok(call!.parseError);
    const [str] = parseToolPayload('{"name": "Read", "arguments": "not json"}');
    assert.ok(str!.parseError);
  });

  test('returns nothing for text without a call', () => {
    assert.deepEqual(parseToolPayload(''), []);
    assert.deepEqual(parseToolPayload('just words'), []);
    assert.deepEqual(parseToolPayload('{"result": 1}'), []);
    assert.deepEqual(parseToolPayload('[1, 2, 3]'), []);
  });

  test('prose around the JSON is ignored', () => {
    assert.deepEqual(names('Here is the call:\n{"name": "Read", "arguments": {"file_path": "a"}}\nThanks'), [['Read', { file_path: 'a' }]]);
  });

  test('XML parameters with quotes around names', () => {
    assert.deepEqual(names(`<invoke name='Read'><parameter name='file_path'>a b.txt</parameter></invoke>`), [['Read', { file_path: 'a b.txt' }]]);
  });

  test('a truncated XML parameter is not silently accepted', () => {
    const calls = parseToolPayload('<function=Write>\n<parameter=file_path>\na.txt\n</parameter>\n<parameter=content>\npartial conte');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, 'Write');
    assert.ok(calls[0]!.parseError, 'the unterminated parameter must be reported');
  });
});

const SPECS: ToolSpec[] = [
  { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'Bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

const IMAGE: ImagePart = { type: 'image', mediaType: 'image/png', data: 'AAAA' };

function request(messages: Message[], tools: ToolSpec[] = SPECS): ChatRequest {
  return { model: 'm', system: 'SYSTEM', messages, tools };
}

describe('toTextProtocol', () => {
  test('is a no-op when there are no tools', () => {
    const req = request([{ role: 'user', content: 'hi' }], []);
    assert.equal(toTextProtocol(req), req);
  });

  test('moves tool definitions into the system prompt', () => {
    const out = toTextProtocol(request([{ role: 'user', content: 'hi' }]));
    assert.deepEqual(out.tools, []);
    assert.ok(out.system.startsWith('SYSTEM\n\n'));
    assert.match(out.system, /<tool_call>/);
    assert.match(out.system, /"name":"Read"/);
    assert.match(out.system, /"name":"Bash"/);
    assert.match(out.system, /"required":\["command"\]/);
    assert.equal(textProtocolInstructions(SPECS), out.system.slice('SYSTEM\n\n'.length));
  });

  test('rewrites assistant tool calls and tool results as text', () => {
    const out = toTextProtocol(
      request([
        { role: 'user', content: 'read a.txt' },
        { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'c1', name: 'Read', arguments: { file_path: 'a.txt' } }] },
        { role: 'tool', toolCallId: 'c1', name: 'Read', content: '     1\thello' },
        { role: 'assistant', content: 'It says hello.' },
      ]),
    );
    assert.deepEqual(
      out.messages.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant'],
    );
    assert.equal(out.messages[1]!.content, 'Reading.\n\n<tool_call>\n{"name":"Read","arguments":{"file_path":"a.txt"}}\n</tool_call>');
    assert.equal((out.messages[1] as { toolCalls?: unknown }).toolCalls, undefined);
    assert.equal(out.messages[2]!.content, '<tool_response name="Read">\n     1\thello\n</tool_response>');
    assert.equal(out.messages[3]!.content, 'It says hello.');
  });

  test('an assistant message with only tool calls has no stray blank lines', () => {
    const out = toTextProtocol(request([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Bash', arguments: { command: 'ls' } }] }]));
    assert.equal(out.messages[1]!.content, '<tool_call>\n{"name":"Bash","arguments":{"command":"ls"}}\n</tool_call>');
  });

  test('consecutive tool results merge into one user message, with errors marked', () => {
    const out = toTextProtocol(
      request([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c1', name: 'Read', arguments: { file_path: 'a' } },
            { id: 'c2', name: 'Bash', arguments: { command: 'false' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', name: 'Read', content: 'A' },
        { role: 'tool', toolCallId: 'c2', name: 'Bash', content: 'Exit code 1', isError: true },
      ]),
    );
    assert.equal(out.messages.length, 3);
    assert.equal(out.messages[2]!.role, 'user');
    assert.equal(out.messages[2]!.content, '<tool_response name="Read">\nA\n</tool_response>\n\n<tool_response name="Bash" status="error">\nExit code 1\n</tool_response>');
  });

  test('roles alternate even when user messages follow tool results or each other', () => {
    const out = toTextProtocol(
      request([
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second', isMeta: true },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: { file_path: 'a' } }] },
        { role: 'tool', toolCallId: 'c1', name: 'Read', content: 'A' },
        { role: 'user', content: '[Request interrupted by user]', isMeta: true },
        { role: 'user', content: 'now do b' },
      ]),
    );
    const roles = out.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user']);
    assert.equal(out.messages[0]!.content, 'first\n\nsecond');
    assert.equal(out.messages[2]!.content, '<tool_response name="Read">\nA\n</tool_response>\n\n[Request interrupted by user]\n\nnow do b');
  });

  test('images from tools and users are preserved, in a single user turn', () => {
    const out = toTextProtocol(
      request([
        { role: 'user', content: [{ type: 'text', text: 'look' }, IMAGE] },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: { file_path: 'shot.png' } }] },
        { role: 'tool', toolCallId: 'c1', name: 'Read', content: 'Image shot.png attached.', images: [IMAGE] },
        { role: 'user', content: 'what is it?' },
      ]),
    );
    assert.deepEqual(
      out.messages.map((m) => m.role),
      ['user', 'assistant', 'user'],
    );
    assert.deepEqual(out.messages[0]!.content, [{ type: 'text', text: 'look' }, IMAGE]);
    const last = out.messages[2]!.content;
    assert.ok(Array.isArray(last));
    const parts = last as { type: string; text?: string }[];
    assert.equal(parts.filter((p) => p.type === 'image').length, 1);
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    assert.match(text, /<tool_response name="Read">\nImage shot\.png attached\.\n<\/tool_response>/);
    assert.match(text, /what is it\?/);
  });

  test('the original request and its messages are not modified', () => {
    const messages: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'ok', toolCalls: [{ id: 'c1', name: 'Read', arguments: { file_path: 'a' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'Read', content: 'A' },
      { role: 'user', content: 'third' },
    ];
    const snapshot = structuredClone(messages);
    const req = request(messages);
    toTextProtocol(req);
    toTextProtocol(req);
    assert.deepEqual(messages, snapshot);
    assert.equal(req.system, 'SYSTEM');
    assert.equal(req.tools.length, 2);
  });

  test('what we ask the model to write is what the parser reads back', () => {
    const call = { id: 'x', name: 'Bash', arguments: { command: 'echo "a < b" && printf \'%s\\n\' done', description: 'multi\nline' } };
    const parser = new TextStreamParser(['Bash']);
    const events = [...parser.push(`Running.\n${renderToolCall(call)}`), ...parser.flush()];
    const calls = events.filter((e) => e.type === 'tool_call');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.type === 'tool_call' && calls[0]!.call.arguments, call.arguments);
  });
});

describe('renderTranscript', () => {
  test('renders each role, tool calls and error results', () => {
    const text = renderTranscript([
      { role: 'user', content: [{ type: 'text', text: 'fix the bug' }, IMAGE] },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c1', name: 'Read', arguments: { file_path: 'a.ts' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'Read', content: 'contents' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'Bash', arguments: { command: 'npm test' } }] },
      { role: 'tool', toolCallId: 'c2', name: 'Bash', content: 'Exit code 1', isError: true },
      { role: 'assistant', content: 'Done.' },
    ]);
    assert.equal(
      text,
      [
        '## User\nfix the bug',
        '## Assistant\nLooking.\n[tool call] Read({"file_path":"a.ts"})',
        '## Tool result (Read)\ncontents',
        '## Assistant\n[tool call] Bash({"command":"npm test"})',
        '## Tool result (Bash, error)\nExit code 1',
        '## Assistant\nDone.',
      ].join('\n\n'),
    );
  });

  test('long tool results are truncated to the limit', () => {
    const text = renderTranscript([{ role: 'tool', toolCallId: 'c', name: 'Read', content: 'x'.repeat(5000) }], 100);
    assert.ok(text.includes(`${'x'.repeat(100)}\n... [truncated]`));
    assert.ok(text.length < 200);
  });

  test('an empty conversation renders as an empty string', () => {
    assert.equal(renderTranscript([]), '');
  });
});
