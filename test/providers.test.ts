import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import type { Settings } from '../src/config/settings.ts';
import {
  ModelClient,
  NO_SERVER_HELP,
  PRESETS,
  createProvider,
  detectServers,
  profileModel,
  providerConfigs,
  rankModels,
  resolveProvider,
  type ModelProfile,
} from '../src/providers/index.ts';
import { OllamaProvider, normalizeOllamaHost, toOllamaMessages } from '../src/providers/ollama.ts';
import { OpenAIProvider, toOpenAIMessages } from '../src/providers/openai.ts';
import type { ChatRequest, ModelInfo, Provider, StreamEvent } from '../src/providers/types.ts';
import { ProviderError, classifyError } from '../src/providers/types.ts';
import type { ImagePart, Message, StopReason, ToolCall, ToolSpec, Usage } from '../src/types.ts';

// ------------------------------------------------------------------ helpers

interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

interface TestServer {
  /** http://127.0.0.1:port */
  root: string;
  port: number;
  requests: Recorded[];
  close(): Promise<void>;
}

type Handler = (req: Recorded, res: http.ServerResponse) => void | Promise<void>;

const servers: TestServer[] = [];

async function serve(handler: Handler): Promise<TestServer> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      let body: any;
      try {
        body = data ? JSON.parse(data) : undefined;
      } catch {
        body = data;
      }
      const record: Recorded = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body };
      requests.push(record);
      Promise.resolve(handler(record, res)).catch((err) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const handle: TestServer = {
    root: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(handle);
  return handle;
}

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/** A port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sse(res: http.ServerResponse, events: unknown[], opts: { done?: boolean } = {}): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (opts.done !== false) res.write('data: [DONE]\n\n');
  res.end();
}

function ndjson(res: http.ServerResponse, lines: unknown[]): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const line of lines) res.write(`${JSON.stringify(line)}\n`);
  res.end();
}

/** One OpenAI streaming chunk. */
function delta(d: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] };
}

interface Collected {
  text: string;
  thinking: string;
  calls: ToolCall[];
  usage?: Usage;
  stop?: StopReason;
  types: string[];
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<Collected> {
  const out: Collected = { text: '', thinking: '', calls: [], types: [] };
  for await (const ev of gen) {
    out.types.push(ev.type);
    if (ev.type === 'text') out.text += ev.text;
    else if (ev.type === 'thinking') out.thinking += ev.text;
    else if (ev.type === 'tool_call') out.calls.push(ev.call);
    else if (ev.type === 'usage') out.usage = ev.usage;
    else if (ev.type === 'done') out.stop = ev.stopReason;
  }
  return out;
}

const callShape = (calls: ToolCall[]) => calls.map((c) => ({ name: c.name, arguments: c.arguments, ...(c.parseError ? { parseError: true } : {}) }));

const TOOL: ToolSpec = { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
const BASH: ToolSpec = { name: 'Bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };
const IMAGE: ImagePart = { type: 'image', mediaType: 'image/png', data: 'QUJD' };

function chatReq(over: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'm', system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools: [], ...over };
}

const isKind = (kind: string) => (err: unknown) => {
  assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${String(err)}`);
  assert.equal(err.kind, kind, err.message);
  return true;
};

/** Run with environment variables set (or removed, when undefined), then restore them. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN_ENV = { OLLAMA_HOST: undefined, OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined };

function openai(server: TestServer, over: { apiKey?: string; headers?: Record<string, string> } = {}): OpenAIProvider {
  return new OpenAIProvider({ name: 'test', baseUrl: `${server.root}/v1`, ...over });
}

// --------------------------------------------------------------- classifyError

describe('classifyError', () => {
  test('recognises servers saying the model has no tool support', () => {
    assert.equal(classifyError(400, 'registry.ollama.ai/library/gemma3:4b does not support tools'), 'tools_unsupported');
    assert.equal(classifyError(400, 'Tool calling is not supported for this model'), 'tools_unsupported');
    assert.equal(classifyError(500, 'This model does not support function calling'), 'tools_unsupported');
  });

  test('recognises context overflow in its many spellings', () => {
    for (const message of [
      'the request exceeds the available context size, try increasing it',
      "This model's maximum context length is 8192 tokens",
      'The number of tokens to keep from the initial prompt is greater than the context length',
      'context_length_exceeded',
      'prompt is too long: 9000 tokens',
      'input exceeds n_ctx',
    ]) {
      assert.equal(classifyError(400, message), 'context_overflow', message);
    }
  });

  test('recognises a missing model, but not every 404', () => {
    assert.equal(classifyError(404, 'model "qwen9" not found, try pulling it first'), 'model_not_found');
    assert.equal(classifyError(400, 'No models loaded. Please load a model.'), 'model_not_found');
    assert.equal(classifyError(404, 'The model `x` does not exist'), 'model_not_found');
    assert.equal(classifyError(404, '404 page not found'), 'http');
    assert.equal(classifyError(404, 'Not Found'), 'http');
  });

  test('everything else is a plain HTTP error', () => {
    assert.equal(classifyError(500, 'internal error'), 'http');
    assert.equal(classifyError(401, 'invalid api key'), 'http');
  });
});

// ------------------------------------------------------------ OpenAI provider

describe('toOpenAIMessages', () => {
  test('system prompt comes first and is omitted when empty', () => {
    assert.deepEqual(toOpenAIMessages('SYS', [{ role: 'user', content: 'hi' }]), [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
    ]);
    assert.deepEqual(toOpenAIMessages('', [{ role: 'user', content: 'hi' }]), [{ role: 'user', content: 'hi' }]);
  });

  test('images become data URLs in a content-part list', () => {
    const [msg] = toOpenAIMessages('', [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, IMAGE] }]);
    assert.deepEqual(msg, {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    });
  });

  test('assistant tool calls carry JSON-string arguments and tool results reference them', () => {
    const messages: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: { file_path: 'a.txt' } }], usage: { inputTokens: 1, outputTokens: 2 }, model: 'm' },
      { role: 'tool', toolCallId: 'c1', name: 'Read', content: 'hello', isError: true },
    ];
    assert.deepEqual(toOpenAIMessages('', messages), [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'Read', content: 'hello' },
    ]);
  });

  test('an image returned by a tool moves to a user turn after the result', () => {
    const out = toOpenAIMessages('', [{ role: 'tool', toolCallId: 'c1', name: 'Read', content: 'Image attached.', images: [IMAGE] }]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'tool', tool_call_id: 'c1', name: 'Read', content: 'Image attached.' });
    assert.equal(out[1]!.role, 'user');
    assert.deepEqual((out[1]!.content as unknown[])[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
  });

  test('internal fields never reach the wire', () => {
    const [msg] = toOpenAIMessages('', [{ role: 'user', content: 'hi', isMeta: true, turn: 3, display: 'shown' }]);
    assert.deepEqual(msg, { role: 'user', content: 'hi' });
  });
});

describe('OpenAIProvider.chat: request', () => {
  test('sends a streaming request with usage reporting and no tool fields when there are no tools', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ content: 'ok' }, 'stop')]));
    const provider = new OpenAIProvider({ name: 'test', baseUrl: `${server.root}/v1///`, apiKey: 'sekret', headers: { 'x-extra': '1' } });
    assert.equal(provider.baseUrl, `${server.root}/v1`);
    await collect(provider.chat(chatReq()));
    const req = server.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer sekret');
    assert.equal(req.headers['x-extra'], '1');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.deepEqual(req.body, {
      model: 'm',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  test('no authorization header without an API key', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ content: 'ok' }, 'stop')]));
    await collect(openai(server).chat(chatReq()));
    assert.equal(server.requests[0]!.headers.authorization, undefined);
  });

  test('tools, limits and sampling settings are passed through', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ content: 'ok' }, 'stop')]));
    await collect(openai(server).chat(chatReq({ tools: [TOOL], maxTokens: 512, temperature: 0, thinking: 'low' })));
    const body = server.requests[0]!.body;
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: TOOL.parameters } }]);
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.temperature, 0);
    assert.equal(body.reasoning_effort, 'low');
  });

  test('reasoning off maps to "none"; on or unset sends nothing', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ content: 'ok' }, 'stop')]));
    const provider = openai(server);
    await collect(provider.chat(chatReq({ thinking: false })));
    await collect(provider.chat(chatReq({ thinking: true })));
    await collect(provider.chat(chatReq()));
    assert.equal(server.requests[0]!.body.reasoning_effort, 'none');
    assert.ok(!('reasoning_effort' in server.requests[1]!.body));
    assert.ok(!('reasoning_effort' in server.requests[2]!.body));
  });
});

describe('OpenAIProvider.chat: streaming', () => {
  test('text arrives in order and ends with done', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ role: 'assistant', content: '' }), delta({ content: 'Hel' }), delta({ content: 'lo' }), delta({}, 'stop')]));
    const out = await collect(openai(server).chat(chatReq()));
    assert.equal(out.text, 'Hello');
    assert.equal(out.stop, 'stop');
    assert.deepEqual(out.types, ['text', 'text', 'done']);
  });

  test('reasoning is read from reasoning_content and from reasoning', async () => {
    const server = await serve((_req, res) =>
      sse(res, [delta({ reasoning_content: 'think ' }), delta({ reasoning: 'harder' }), delta({ content: 'answer' }), delta({}, 'stop')]),
    );
    const out = await collect(openai(server).chat(chatReq()));
    assert.equal(out.thinking, 'think harder');
    assert.equal(out.text, 'answer');
  });

  test('tool-call argument fragments are reassembled', async () => {
    const server = await serve((_req, res) =>
      sse(res, [
        delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"file_' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.txt"}' } }] }),
        delta({}, 'tool_calls'),
      ]),
    );
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.deepEqual(out.calls, [{ id: 'call_1', name: 'Read', arguments: { file_path: 'a.txt' } }]);
    assert.equal(out.stop, 'tool_calls');
  });

  test('two parallel calls with interleaved fragments', async () => {
    const server = await serve((_req, res) =>
      sse(res, [
        delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '{"file_path":' } }] }),
        delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'Bash', arguments: '{"comm' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
        delta({ tool_calls: [{ index: 1, function: { arguments: 'and":"ls"}' } }] }),
        delta({}, 'tool_calls'),
      ]),
    );
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL, BASH] })));
    assert.deepEqual(out.calls, [
      { id: 'a', name: 'Read', arguments: { file_path: 'a.txt' } },
      { id: 'b', name: 'Bash', arguments: { command: 'ls' } },
    ]);
  });

  test('several calls in one chunk', async () => {
    const server = await serve((_req, res) =>
      sse(res, [
        delta({
          tool_calls: [
            { index: 0, id: 'a', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } },
            { index: 1, id: 'b', function: { name: 'Read', arguments: '{"file_path":"b.txt"}' } },
          ],
        }),
        delta({}, 'tool_calls'),
      ]),
    );
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.deepEqual(callShape(out.calls), [
      { name: 'Read', arguments: { file_path: 'a.txt' } },
      { name: 'Read', arguments: { file_path: 'b.txt' } },
    ]);
  });

  test('servers that reuse index 0 with a new id for every call', async () => {
    const server = await serve((_req, res) =>
      sse(res, [
        delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] }),
        delta({ tool_calls: [{ index: 0, id: 'call_b', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }),
        delta({}, 'stop'),
      ]),
    );
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL, BASH] })));
    assert.deepEqual(out.calls, [
      { id: 'call_a', name: 'Read', arguments: { file_path: 'a.txt' } },
      { id: 'call_b', name: 'Bash', arguments: { command: 'ls' } },
    ]);
    assert.equal(out.stop, 'tool_calls', 'calls override a "stop" finish reason');
  });

  test('servers that reuse index 0 and send no ids at all', async () => {
    const server = await serve((_req, res) =>
      sse(res, [
        delta({ tool_calls: [{ index: 0, function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] }),
        delta({ tool_calls: [{ index: 0, function: { name: 'Read', arguments: '{"file_path":"b.txt"}' } }] }),
        delta({}, 'tool_calls'),
      ]),
    );
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.deepEqual(callShape(out.calls), [
      { name: 'Read', arguments: { file_path: 'a.txt' } },
      { name: 'Read', arguments: { file_path: 'b.txt' } },
    ]);
    assert.notEqual(out.calls[0]!.id, out.calls[1]!.id);
    assert.ok(out.calls[0]!.id.length > 0);
  });

  test('a server that repeats the same id and name on every fragment is still one call', async () => {
    const server = await serve((_req, res) =>
      sse(res, [
        delta({ tool_calls: [{ index: 0, id: 'x', function: { name: 'Read', arguments: '{"file_' } }] }),
        delta({ tool_calls: [{ index: 0, id: 'x', function: { name: 'Read', arguments: 'path":"a.txt"}' } }] }),
        delta({}, 'tool_calls'),
      ]),
    );
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.deepEqual(out.calls, [{ id: 'x', name: 'Read', arguments: { file_path: 'a.txt' } }]);
  });

  test('arguments delivered as an object instead of a string', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: { file_path: 'a.txt' } } }] }), delta({}, 'tool_calls')]));
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.deepEqual(out.calls, [{ id: 'a', name: 'Read', arguments: { file_path: 'a.txt' } }]);
  });

  test('a call with no arguments has an empty object', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '' } }] }), delta({}, 'tool_calls')]));
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.deepEqual(out.calls, [{ id: 'a', name: 'Read', arguments: {} }]);
  });

  test('slightly malformed argument JSON is repaired', async () => {
    const server = await serve((_req, res) =>
      sse(res, [delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '{"file_path":"a.txt",}' } }] }), delta({}, 'tool_calls')]),
    );
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.deepEqual(out.calls, [{ id: 'a', name: 'Read', arguments: { file_path: 'a.txt' } }]);
  });

  test('unparseable argument JSON sets parseError and keeps the call', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: 'the file a.txt please' } }] }), delta({}, 'tool_calls')]));
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0]!.name, 'Read');
    assert.deepEqual(out.calls[0]!.arguments, {});
    assert.match(out.calls[0]!.parseError ?? '', /not valid JSON/);
    assert.equal(out.stop, 'tool_calls');
  });

  test('arguments cut off by the output limit are flagged, not silently completed', async () => {
    const server = await serve((_req, res) =>
      sse(res, [delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'Write', arguments: '{"file_path":"a.txt","content":"first half of the fi' } }] }), delta({}, 'length')]),
    );
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.equal(out.calls.length, 1);
    assert.match(out.calls[0]!.parseError ?? '', /cut off/);
  });

  test('a fragment without a name never becomes a call', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] }), delta({ content: 'hi' }), delta({}, 'stop')]));
    const out = await collect(openai(server).chat(chatReq()));
    assert.deepEqual(out.calls, []);
    assert.equal(out.stop, 'stop');
  });

  test('usage comes from the final chunk', async () => {
    const server = await serve((_req, res) =>
      sse(res, [delta({ content: 'hi' }), delta({}, 'stop'), { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234 } }]),
    );
    const out = await collect(openai(server).chat(chatReq()));
    assert.deepEqual(out.usage, { inputTokens: 1200, outputTokens: 34 });
    assert.deepEqual(out.types, ['text', 'usage', 'done']);
  });

  test('llama.cpp timings supply speed, and token counts when usage is absent', async () => {
    const server = await serve((_req, res) =>
      sse(res, [delta({ content: 'hi' }), { ...delta({}, 'stop'), timings: { prompt_n: 900, predicted_n: 50, predicted_ms: 2000, predicted_per_second: 25 } }]),
    );
    const out = await collect(openai(server).chat(chatReq()));
    assert.deepEqual(out.usage, { inputTokens: 900, outputTokens: 50, evalMs: 2000, tokensPerSecond: 25 });
  });

  test('usage and timings combine in either order', async () => {
    const timings = { prompt_n: 1, predicted_n: 2, predicted_ms: 1000, predicted_per_second: 40 };
    const usage = { prompt_tokens: 800, completion_tokens: 40 };
    const first = await serve((_req, res) => sse(res, [{ ...delta({ content: 'x' }, 'stop'), timings }, { choices: [], usage }]));
    const second = await serve((_req, res) => sse(res, [{ ...delta({ content: 'x' }, 'stop'), usage }, { choices: [], timings }]));
    const want = { inputTokens: 800, outputTokens: 40, evalMs: 1000, tokensPerSecond: 40 };
    assert.deepEqual((await collect(openai(first).chat(chatReq()))).usage, want);
    assert.deepEqual((await collect(openai(second).chat(chatReq()))).usage, want);
  });

  test('no usage event when the server reports none', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ content: 'hi' }, 'stop')]));
    const out = await collect(openai(server).chat(chatReq()));
    assert.equal(out.usage, undefined);
    assert.deepEqual(out.types, ['text', 'done']);
  });

  test('finish reasons map to stop reasons', async () => {
    const cases: [string | null, StopReason][] = [
      ['stop', 'stop'],
      ['length', 'length'],
      ['max_tokens', 'length'],
      ['eos', 'stop'],
      ['content_filter', 'stop'],
      [null, 'stop'],
    ];
    for (const [finish, want] of cases) {
      const server = await serve((_req, res) => sse(res, [delta({ content: 'x' }), delta({}, finish)]));
      assert.equal((await collect(openai(server).chat(chatReq()))).stop, want, String(finish));
    }
  });

  test('the legacy function_call finish reason counts as tool_calls', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '{}' } }] }), delta({}, 'function_call')]));
    assert.equal((await collect(openai(server).chat(chatReq({ tools: [TOOL] })))).stop, 'tool_calls');
  });

  test('tolerates CRLF, comments, missing space after "data:", junk lines and split writes', async () => {
    const accent = String.fromCodePoint(0xe9);
    const server = await serve(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive\r\n\r\n');
      res.write('event: message\r\n');
      res.write('data: {"choices":[{"index":0,"delta":{"content":"Hel');
      await sleep(15);
      res.write('lo"},"finish_reason":null}]}\r\n\r\n');
      res.write('data:{"choices":[{"index":0,"delta":{"content":" w"},"finish_reason":null}]}\n\n');
      res.write('data: this is not json\n\n');
      res.write('data: 42\n\n');
      // A multi-byte character split across two network writes.
      const line = Buffer.from(`data: {"choices":[{"index":0,"delta":{"content":"${accent}!"},"finish_reason":"stop"}]}\n\n`);
      const cut = line.indexOf(0xc3) + 1;
      res.write(line.subarray(0, cut));
      await sleep(15);
      res.write(line.subarray(cut));
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const out = await collect(openai(server).chat(chatReq()));
    assert.equal(out.text, `Hello w${accent}!`);
    assert.equal(out.stop, 'stop');
  });

  test('a stream that ends without [DONE] or a final newline still completes', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"index":0,"delta":{"content":"tail"},"finish_reason":"stop"}]}');
    });
    const out = await collect(openai(server).chat(chatReq()));
    assert.equal(out.text, 'tail');
    assert.equal(out.stop, 'stop');
  });

  test('a server that ignores stream:true and answers with plain JSON is understood', async () => {
    const server = await serve((_req, res) =>
      json(res, 200, {
        choices: [{ index: 0, message: { role: 'assistant', content: 'whole reply', tool_calls: [{ id: 'a', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const out = await collect(openai(server).chat(chatReq({ tools: [TOOL] })));
    assert.equal(out.text, 'whole reply');
    assert.deepEqual(out.calls, [{ id: 'a', name: 'Read', arguments: { file_path: 'a.txt' } }]);
    assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(out.stop, 'tool_calls');
  });
});

describe('OpenAIProvider.chat: non-streamed replies', () => {
  test('a pretty-printed JSON reply is understood whatever its content type', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'line one\nline two', reasoning_content: 'why' }, finish_reason: 'length' }] }, null, 2));
    });
    const out = await collect(openai(server).chat(chatReq()));
    assert.equal(out.text, 'line one\nline two');
    assert.equal(out.thinking, 'why');
    assert.equal(out.stop, 'length');
  });

  test('an error document sent with status 200 is thrown', async () => {
    const server = await serve((_req, res) => json(res, 200, { error: { message: 'model is still loading' } }));
    await assert.rejects(collect(openai(server).chat(chatReq())), (err: unknown) => err instanceof ProviderError && err.message === 'model is still loading');
  });

  test('an empty 200 reply ends cleanly with nothing', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
    });
    const out = await collect(openai(server).chat(chatReq()));
    assert.deepEqual(out, { text: '', thinking: '', calls: [], types: ['done'], stop: 'stop' });
  });
});

describe('OpenAIProvider.chat: errors', () => {
  test('an error object mid-stream is thrown, after the text before it', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ content: 'partial' }), { error: { message: 'CUDA out of memory' } }], { done: false }));
    const gen = openai(server).chat(chatReq());
    assert.deepEqual((await gen.next()).value, { type: 'text', text: 'partial' });
    await assert.rejects(gen.next(), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'http');
      assert.equal(err.message, 'CUDA out of memory');
      return true;
    });
  });

  test('a mid-stream error is classified, and may be a bare string', async () => {
    const server = await serve((_req, res) => sse(res, [{ error: 'the request exceeds the available context size' }], { done: false }));
    await assert.rejects(collect(openai(server).chat(chatReq())), isKind('context_overflow'));
  });

  test('HTTP errors are classified and carry the server message and status', async () => {
    const cases: [number, unknown, string, RegExp][] = [
      [400, { error: { message: 'gemma3 does not support tools' } }, 'tools_unsupported', /does not support tools/],
      [400, { error: { message: "This model's maximum context length is 4096 tokens" } }, 'context_overflow', /maximum context length/],
      [404, { error: { message: 'model "nope" not found' } }, 'model_not_found', /not found/],
      [500, { error: 'boom as a string' }, 'http', /^boom as a string$/],
      [503, { message: 'loading model' }, 'http', /^loading model$/],
      [401, { detail: 'no recognised field' }, 'http', /no recognised field/],
    ];
    for (const [status, body, kind, pattern] of cases) {
      const server = await serve((_req, res) => json(res, status, body));
      await assert.rejects(collect(openai(server).chat(chatReq({ tools: [TOOL] }))), (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.kind, kind);
        assert.equal(err.status, status);
        assert.match(err.message, pattern);
        return true;
      });
    }
  });

  test('plain-text and empty error bodies still give a message', async () => {
    const text = await serve((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Bad Gateway');
    });
    await assert.rejects(collect(openai(text).chat(chatReq())), (err: unknown) => err instanceof ProviderError && err.message === 'Bad Gateway' && err.status === 502);
    const empty = await serve((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await assert.rejects(collect(openai(empty).chat(chatReq())), (err: unknown) => err instanceof ProviderError && err.message === 'HTTP 500');
  });

  test('a 404 that is not about the model points at the base URL', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404 page not found');
    });
    const provider = new OpenAIProvider({ name: 'test', baseUrl: server.root });
    await assert.rejects(collect(provider.chat(chatReq())), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'http');
      assert.match(err.message, /\/v1/);
      assert.ok(err.message.includes(`${server.root}/chat/completions`));
      return true;
    });
  });

  test('optional fields a server rejects are dropped one at a time and remembered', async () => {
    const server = await serve((req, res) => {
      for (const field of ['stream_options', 'parallel_tool_calls', 'reasoning_effort']) {
        if (field in req.body) return json(res, 400, { error: { message: `Unrecognized request argument supplied: ${field}` } });
      }
      sse(res, [delta({ content: 'ok' }, 'stop')]);
    });
    const provider = openai(server);
    const first = await collect(provider.chat(chatReq({ tools: [TOOL], thinking: 'high' })));
    assert.equal(first.text, 'ok');
    assert.equal(server.requests.length, 4, 'three rejections, then success');
    assert.deepEqual(Object.keys(server.requests[3]!.body).sort(), ['messages', 'model', 'stream', 'tools']);

    await collect(provider.chat(chatReq({ tools: [TOOL], thinking: 'high' })));
    assert.equal(server.requests.length, 5, 'the rejected fields are not tried again');
    assert.deepEqual(Object.keys(server.requests[4]!.body).sort(), ['messages', 'model', 'stream', 'tools']);
  });

  test('a 400 that names no optional field is not retried', async () => {
    const server = await serve((_req, res) => json(res, 400, { error: { message: 'messages: field required' } }));
    await assert.rejects(collect(openai(server).chat(chatReq({ tools: [TOOL] }))), isKind('http'));
    assert.equal(server.requests.length, 1);
  });

  test('a 400 naming a field we did not send is not retried', async () => {
    const server = await serve((_req, res) => json(res, 400, { error: { message: 'reasoning_effort is not allowed' } }));
    await assert.rejects(collect(openai(server).chat(chatReq())), isKind('http'));
    assert.equal(server.requests.length, 1);
  });

  test('connection refused is reported with the URL and a hint', async () => {
    const port = await closedPort();
    const provider = new OpenAIProvider({ name: 'test', baseUrl: `http://127.0.0.1:${port}/v1` });
    await assert.rejects(collect(provider.chat(chatReq())), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'connection');
      assert.ok(err.message.includes(`http://127.0.0.1:${port}/v1`));
      assert.match(err.message, /ECONNREFUSED/);
      assert.match(err.message, /Is the model server running\?/);
      return true;
    });
  });

  test('aborting mid-stream ends with an "aborted" error', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(delta({ content: 'partial' }))}\n\n`);
      // never ends: the client must abort
    });
    const ctrl = new AbortController();
    const gen = openai(server).chat(chatReq({ signal: ctrl.signal }));
    assert.deepEqual((await gen.next()).value, { type: 'text', text: 'partial' });
    ctrl.abort();
    await assert.rejects(gen.next(), isKind('aborted'));
  });

  test('aborting before the server answers ends with an "aborted" error', async () => {
    const server = await serve(() => {
      // never responds
    });
    const ctrl = new AbortController();
    const pending = collect(openai(server).chat(chatReq({ signal: ctrl.signal })));
    setTimeout(() => ctrl.abort(), 20);
    await assert.rejects(pending, isKind('aborted'));
  });

  test('a signal that is already aborted never reaches the server', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ content: 'x' }, 'stop')]));
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(collect(openai(server).chat(chatReq({ signal: ctrl.signal }))), isKind('aborted'));
    assert.equal(server.requests.length, 0);
  });

  test('a connection dropped mid-response is a connection error, not a silent end', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(delta({ content: 'partial' }))}\n\n`);
      setTimeout(() => res.destroy(), 30);
    });
    const gen = openai(server).chat(chatReq());
    assert.deepEqual((await gen.next()).value, { type: 'text', text: 'partial' });
    await assert.rejects(gen.next(), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'connection');
      assert.match(err.message, /lost mid-response/);
      return true;
    });
  });
});

describe('OpenAIProvider.listModels', () => {
  test('reads ids and context sizes from /v1/models', async () => {
    const server = await serve((req, res) => {
      if (req.path === '/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: [{ id: 'plain' }, { id: 'vllm-model', max_model_len: 65536 }, { id: 'with-meta', meta: { n_ctx_train: 131072, size: 4_000_000 } }, { object: 'model' }],
        });
      }
      json(res, 404, { error: 'not found' });
    });
    const models = await openai(server, { apiKey: 'k' }).listModels();
    assert.deepEqual(models, [
      { id: 'plain', contextLength: undefined, sizeBytes: undefined },
      { id: 'vllm-model', contextLength: 65536, sizeBytes: undefined },
      { id: 'with-meta', contextLength: 131072, sizeBytes: 4_000_000 },
    ]);
    assert.equal(server.requests[0]!.headers.authorization, 'Bearer k');
  });

  test('accepts a "models" list keyed by name', async () => {
    const server = await serve((req, res) => (req.path === '/v1/models' ? json(res, 200, { models: [{ name: 'a' }, { model: 'b' }] }) : json(res, 404, {})));
    assert.deepEqual(
      (await openai(server).listModels()).map((m) => m.id),
      ['a', 'b'],
    );
  });

  test('LM Studio: /api/v0/models adds context sizes, load state and capabilities', async () => {
    const server = await serve((req, res) => {
      if (req.path === '/v1/models') return json(res, 200, { data: [{ id: 'qwen/qwen3-coder' }, { id: 'llava' }, { id: 'nomic-embed' }, { id: 'old-llm' }, { id: 'old-vlm' }] });
      if (req.path === '/api/v0/models') {
        return json(res, 200, {
          data: [
            { id: 'qwen/qwen3-coder', type: 'llm', state: 'loaded', max_context_length: 262144, loaded_context_length: 16384, quantization: 'Q4_K_M', capabilities: ['tool_use'] },
            { id: 'llava', type: 'vlm', state: 'not-loaded', max_context_length: 4096, capabilities: [] },
            { id: 'nomic-embed', type: 'embeddings', state: 'not-loaded' },
            { id: 'old-llm', type: 'llm', state: 'not-loaded' },
            { id: 'old-vlm', type: 'vlm', state: 'not-loaded' },
            { id: 'not-in-v1', type: 'llm' },
          ],
        });
      }
      json(res, 404, {});
    });
    const models = await openai(server).listModels();
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    assert.equal(models.length, 5);
    assert.deepEqual(byId['qwen/qwen3-coder'], {
      id: 'qwen/qwen3-coder',
      contextLength: 262144,
      loadedContextLength: 16384,
      sizeBytes: undefined,
      loaded: true,
      quantization: 'Q4_K_M',
      capabilities: ['tools'],
    });
    assert.deepEqual(byId.llava!.capabilities, ['vision'], 'an explicit empty capability list means no tools');
    assert.equal(byId.llava!.vision, true);
    assert.equal(byId.llava!.loaded, false);
    assert.deepEqual(byId['nomic-embed']!.capabilities, ['embedding']);
    assert.equal(byId['old-llm']!.capabilities, undefined, 'tool support is unknown when the server lists no capabilities');
    assert.equal(byId['old-vlm']!.capabilities, undefined, 'a vision model without a capability list must not look tool-less');
    assert.equal(byId['old-vlm']!.vision, true);
  });

  test('llama.cpp: /props describes the single loaded model', async () => {
    const server = await serve((req, res) => {
      if (req.path === '/v1/models') return json(res, 200, { data: [{ id: 'model.gguf', meta: { n_ctx_train: 131072 } }] });
      if (req.path === '/props') {
        return json(res, 200, { default_generation_settings: { n_ctx: 8192 }, chat_template_caps: { supports_tools: true, supports_tool_calls: true }, modalities: { vision: true } });
      }
      json(res, 404, {});
    });
    const [model] = await openai(server).listModels();
    assert.deepEqual(model, { id: 'model.gguf', contextLength: 131072, sizeBytes: undefined, loadedContextLength: 8192, loaded: true, vision: true, capabilities: ['tools', 'vision'] });
  });

  test('llama.cpp: a template without tool support is reported as such', async () => {
    const server = await serve((req, res) => {
      if (req.path === '/v1/models') return json(res, 200, { data: [{ id: 'm' }] });
      if (req.path === '/props') return json(res, 200, { default_generation_settings: { n_ctx: 4096 }, chat_template_caps: { supports_tools: false } });
      json(res, 404, {});
    });
    const [model] = await openai(server).listModels();
    assert.deepEqual(model!.capabilities, []);
    assert.equal(model!.loadedContextLength, 4096);
  });

  test('llama.cpp: without template capabilities tool support stays unknown, vision is kept', async () => {
    const server = await serve((req, res) => {
      if (req.path === '/v1/models') return json(res, 200, { data: [{ id: 'm' }] });
      if (req.path === '/props') return json(res, 200, { default_generation_settings: { n_ctx: 4096 }, modalities: { vision: true } });
      json(res, 404, {});
    });
    const [model] = await openai(server).listModels();
    assert.equal(model!.capabilities, undefined);
    assert.equal(model!.vision, true);
  });

  test('/props is ignored when the server lists several models', async () => {
    const server = await serve((req, res) => {
      if (req.path === '/v1/models') return json(res, 200, { data: [{ id: 'a' }, { id: 'b' }] });
      if (req.path === '/props') return json(res, 200, { default_generation_settings: { n_ctx: 4096 } });
      json(res, 404, {});
    });
    const models = await openai(server).listModels();
    assert.ok(models.every((m) => m.loadedContextLength === undefined));
    assert.ok(!server.requests.some((r) => r.path === '/props'));
  });

  test('failures are reported as provider errors', async () => {
    const broken = await serve((_req, res) => json(res, 500, { error: { message: 'kaput' } }));
    await assert.rejects(openai(broken).listModels(), (err: unknown) => err instanceof ProviderError && err.kind === 'http' && err.message === 'kaput');
    const port = await closedPort();
    await assert.rejects(new OpenAIProvider({ name: 't', baseUrl: `http://127.0.0.1:${port}/v1` }).listModels(), isKind('connection'));
  });

  test('modelInfo finds a model by id and is undefined otherwise', async () => {
    const server = await serve((req, res) => (req.path === '/v1/models' ? json(res, 200, { data: [{ id: 'a', max_model_len: 2048 }] }) : json(res, 404, {})));
    const provider = openai(server);
    assert.equal((await provider.modelInfo('a'))?.contextLength, 2048);
    assert.equal(await provider.modelInfo('missing'), undefined);
    const port = await closedPort();
    assert.equal(await new OpenAIProvider({ name: 't', baseUrl: `http://127.0.0.1:${port}/v1` }).modelInfo('a'), undefined);
  });
});

// ------------------------------------------------------------ Ollama provider

describe('normalizeOllamaHost', () => {
  test('a listen address becomes a loopback URL', () => {
    assert.equal(normalizeOllamaHost('0.0.0.0:11434'), 'http://127.0.0.1:11434');
    assert.equal(normalizeOllamaHost('0.0.0.0'), 'http://127.0.0.1:11434');
    assert.equal(normalizeOllamaHost('[::]:11434'), 'http://127.0.0.1:11434');
    assert.equal(normalizeOllamaHost(':8000'), 'http://127.0.0.1:8000');
  });

  test('a bare host gets http and the default port', () => {
    assert.equal(normalizeOllamaHost('localhost'), 'http://localhost:11434');
    assert.equal(normalizeOllamaHost('gpu-box.local:9999'), 'http://gpu-box.local:9999');
    assert.equal(normalizeOllamaHost('  192.168.1.20  '), 'http://192.168.1.20:11434');
  });

  test('an explicit scheme and port are kept', () => {
    assert.equal(normalizeOllamaHost('http://host:1234'), 'http://host:1234');
    assert.equal(normalizeOllamaHost('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  });

  test('an explicit scheme without a port uses that scheme, as Ollama does', () => {
    assert.equal(normalizeOllamaHost('https://example.com'), 'https://example.com');
    assert.equal(normalizeOllamaHost('http://example.com'), 'http://example.com');
  });

  test('trailing slashes and a trailing /v1 are removed', () => {
    assert.equal(normalizeOllamaHost('http://localhost:11434/'), 'http://localhost:11434');
    assert.equal(normalizeOllamaHost('http://localhost:11434/v1'), 'http://localhost:11434');
    assert.equal(normalizeOllamaHost('http://localhost:11434/v1/'), 'http://localhost:11434');
    assert.equal(normalizeOllamaHost('localhost:11434///'), 'http://localhost:11434');
    assert.equal(normalizeOllamaHost('https://example.com/ollama/'), 'https://example.com/ollama');
  });

  test('garbage throws instead of producing a wrong URL', () => {
    assert.throws(() => normalizeOllamaHost('http://exa mple'));
  });
});

describe('toOllamaMessages', () => {
  test('maps every role to the native shape', () => {
    const messages: Message[] = [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: 'ok', thinking: 'hidden', toolCalls: [{ id: 'c1', name: 'Read', arguments: { file_path: 'a.txt' } }, { id: 'c2', name: 'Bash', arguments: { command: 'ls' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'Read', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ];
    assert.deepEqual(toOllamaMessages('SYS', messages), [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [
          { type: 'function', function: { index: 0, name: 'Read', arguments: { file_path: 'a.txt' } } },
          { type: 'function', function: { index: 1, name: 'Bash', arguments: { command: 'ls' } } },
        ],
      },
      { role: 'tool', content: 'hello', tool_name: 'Read' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  test('images go in the images array as bare base64', () => {
    const out = toOllamaMessages('', [{ role: 'user', content: [{ type: 'text', text: 'a' }, IMAGE, { type: 'text', text: 'b' }] }]);
    assert.deepEqual(out, [{ role: 'user', content: 'a\nb', images: ['QUJD'] }]);
  });

  test('an image returned by a tool follows as a user turn', () => {
    const out = toOllamaMessages('', [{ role: 'tool', toolCallId: 'c', name: 'Read', content: 'Image attached.', images: [IMAGE] }]);
    assert.deepEqual(out, [
      { role: 'tool', content: 'Image attached.', tool_name: 'Read' },
      { role: 'user', content: 'Image returned by Read:', images: ['QUJD'] },
    ]);
  });
});

function ollama(server: TestServer, apiKey?: string): OllamaProvider {
  return new OllamaProvider({ name: 'ollama', baseUrl: server.root, apiKey });
}

const DONE = { model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1000, eval_count: 50, eval_duration: 2_000_000_000 };
const part = (message: Record<string, unknown>) => ({ model: 'm', created_at: 'now', message: { role: 'assistant', content: '', ...message }, done: false });

describe('OllamaProvider.chat', () => {
  test('sends num_ctx, num_predict, keep_alive, think and tools in the native shape', async () => {
    const server = await serve((_req, res) => ndjson(res, [part({ content: 'ok' }), DONE]));
    await collect(ollama(server, 'key').chat(chatReq({ tools: [TOOL], contextWindow: 32768, maxTokens: 4096, temperature: 0.2, keepAlive: '30m', thinking: true })));
    const req = server.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/api/chat');
    assert.equal(req.headers.authorization, 'Bearer key');
    assert.deepEqual(req.body, {
      model: 'm',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      options: { num_ctx: 32768, num_predict: 4096, temperature: 0.2 },
      keep_alive: '30m',
      tools: [{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: TOOL.parameters } }],
      think: true,
    });
  });

  test('num_ctx is inside options, never top-level, and optional fields are omitted when unset', async () => {
    const server = await serve((_req, res) => ndjson(res, [DONE]));
    await collect(ollama(server).chat(chatReq({ contextWindow: 8192 })));
    const body = server.requests[0]!.body;
    assert.deepEqual(body.options, { num_ctx: 8192 });
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'options', 'stream']);
    assert.equal(server.requests[0]!.headers.authorization, undefined);
  });

  test('think accepts false and a level', async () => {
    const server = await serve((_req, res) => ndjson(res, [DONE]));
    const provider = ollama(server);
    await collect(provider.chat(chatReq({ thinking: false })));
    await collect(provider.chat(chatReq({ thinking: 'low' })));
    assert.equal(server.requests[0]!.body.think, false);
    assert.equal(server.requests[1]!.body.think, 'low');
  });

  test('streams thinking, content and tool calls, then usage and done', async () => {
    const server = await serve((_req, res) =>
      ndjson(res, [
        part({ thinking: 'Let me ' }),
        part({ thinking: 'think.' }),
        part({ content: 'Reading ' }),
        part({ content: 'now.' }),
        part({ tool_calls: [{ type: 'function', function: { index: 0, name: 'Read', arguments: { file_path: 'a.txt' } } }, { function: { name: 'Bash', arguments: { command: 'ls' } } }] }),
        DONE,
      ]),
    );
    const out = await collect(ollama(server).chat(chatReq({ tools: [TOOL, BASH] })));
    assert.equal(out.thinking, 'Let me think.');
    assert.equal(out.text, 'Reading now.');
    assert.deepEqual(callShape(out.calls), [
      { name: 'Read', arguments: { file_path: 'a.txt' } },
      { name: 'Bash', arguments: { command: 'ls' } },
    ]);
    assert.ok(out.calls[0]!.id && out.calls[1]!.id && out.calls[0]!.id !== out.calls[1]!.id, 'each call gets its own id');
    assert.equal(out.stop, 'tool_calls');
    assert.deepEqual(out.types, ['thinking', 'thinking', 'text', 'text', 'tool_call', 'tool_call', 'usage', 'done']);
  });

  test('usage converts nanoseconds and derives tokens per second', async () => {
    const server = await serve((_req, res) => ndjson(res, [part({ content: 'x' }), DONE]));
    const out = await collect(ollama(server).chat(chatReq()));
    assert.deepEqual(out.usage, { inputTokens: 1000, outputTokens: 50, evalMs: 2000, tokensPerSecond: 25 });
    assert.equal(out.stop, 'stop');
  });

  test('missing counters default to zero without dividing by zero', async () => {
    const server = await serve((_req, res) => ndjson(res, [part({ content: 'x' }), { done: true }]));
    const out = await collect(ollama(server).chat(chatReq()));
    assert.deepEqual(out.usage, { inputTokens: 0, outputTokens: 0, evalMs: undefined, tokensPerSecond: undefined });
  });

  test('done_reason "length" is reported, unless there are tool calls', async () => {
    const cut = await serve((_req, res) => ndjson(res, [part({ thinking: 'thinking forever' }), { ...DONE, done_reason: 'length' }]));
    const out = await collect(ollama(cut).chat(chatReq()));
    assert.equal(out.stop, 'length');
    assert.equal(out.text, '');
    const withCalls = await serve((_req, res) => ndjson(res, [part({ tool_calls: [{ function: { name: 'Read', arguments: {} } }] }), { ...DONE, done_reason: 'length' }]));
    assert.equal((await collect(ollama(withCalls).chat(chatReq({ tools: [TOOL] })))).stop, 'tool_calls');
  });

  test('a tool-call id from the server is kept; string arguments are parsed', async () => {
    const server = await serve((_req, res) =>
      ndjson(res, [part({ tool_calls: [{ id: 'call_x', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }, { function: { name: 'Read', arguments: 'nonsense' } }, { function: { arguments: {} } }] }), DONE]),
    );
    const out = await collect(ollama(server).chat(chatReq({ tools: [TOOL] })));
    assert.equal(out.calls.length, 2, 'an entry without a name is skipped');
    assert.deepEqual(out.calls[0], { id: 'call_x', name: 'Read', arguments: { file_path: 'a.txt' } });
    assert.match(out.calls[1]!.parseError ?? '', /not valid JSON/);
  });

  test('a mid-stream error line is thrown after the output before it', async () => {
    const server = await serve((_req, res) => ndjson(res, [part({ content: 'partial' }), { error: 'model requires more system memory (12.0 GiB) than is available (8.0 GiB)' }]));
    const gen = ollama(server).chat(chatReq());
    assert.deepEqual((await gen.next()).value, { type: 'text', text: 'partial' });
    await assert.rejects(gen.next(), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /requires more system memory/);
      return true;
    });
  });

  test('HTTP errors are classified from the {"error": "..."} body', async () => {
    const missing = await serve((_req, res) => json(res, 404, { error: 'model "nope" not found, try pulling it first' }));
    await assert.rejects(collect(ollama(missing).chat(chatReq())), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'model_not_found');
      assert.equal(err.status, 404);
      assert.equal(err.message, 'model "nope" not found, try pulling it first');
      return true;
    });
    const noTools = await serve((_req, res) => json(res, 400, { error: 'registry.ollama.ai/library/gemma3:4b does not support tools' }));
    await assert.rejects(collect(ollama(noTools).chat(chatReq({ tools: [TOOL] }))), isKind('tools_unsupported'));
  });

  test('a model that rejects think is retried without it, and remembered per model', async () => {
    const server = await serve((req, res) => {
      if ('think' in req.body && req.body.model === 'plain') return json(res, 400, { error: 'registry.ollama.ai/library/plain does not support thinking' });
      ndjson(res, [part({ content: 'ok' }), DONE]);
    });
    const provider = ollama(server);
    const out = await collect(provider.chat(chatReq({ model: 'plain', thinking: true })));
    assert.equal(out.text, 'ok');
    assert.equal(server.requests.length, 2);
    assert.ok(!('think' in server.requests[1]!.body));

    await collect(provider.chat(chatReq({ model: 'plain', thinking: true })));
    assert.equal(server.requests.length, 3, 'no second failed attempt for the same model');
    assert.ok(!('think' in server.requests[2]!.body));

    await collect(provider.chat(chatReq({ model: 'reasoner', thinking: true })));
    assert.equal(server.requests[3]!.body.think, true, 'other models still get the parameter');
  });

  test('an unrelated 400 is not retried', async () => {
    const server = await serve((_req, res) => json(res, 400, { error: 'invalid options' }));
    await assert.rejects(collect(ollama(server).chat(chatReq({ thinking: true }))), isKind('http'));
    assert.equal(server.requests.length, 1);
  });

  test('tolerates blank lines, junk lines and lines split across writes', async () => {
    const server = await serve(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('\n');
      res.write('{"message":{"role":"assistant","content":"Hel');
      await sleep(15);
      res.write('lo"},"done":false}\r\n');
      res.write('not json\n');
      res.write('[1,2]\n');
      res.end(JSON.stringify(DONE));
    });
    const out = await collect(ollama(server).chat(chatReq()));
    assert.equal(out.text, 'Hello');
    assert.equal(out.usage?.outputTokens, 50, 'the final line counts even without a trailing newline');
  });

  test('connection refused and abort are reported as such', async () => {
    const port = await closedPort();
    await assert.rejects(collect(new OllamaProvider({ name: 'ollama', baseUrl: `http://127.0.0.1:${port}` }).chat(chatReq())), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'connection');
      assert.ok(err.message.includes(`http://127.0.0.1:${port}`));
      return true;
    });
    const hanging = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify(part({ content: 'partial' }))}\n`);
    });
    const ctrl = new AbortController();
    const gen = ollama(hanging).chat(chatReq({ signal: ctrl.signal }));
    assert.deepEqual((await gen.next()).value, { type: 'text', text: 'partial' });
    ctrl.abort();
    await assert.rejects(gen.next(), isKind('aborted'));
  });
});

describe('OllamaProvider models', () => {
  const tags = {
    models: [
      { name: 'qwen3:8b', model: 'qwen3:8b', modified_at: '2026-03-01T00:00:00Z', size: 5_200_000_000, details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M' } },
      { name: 'llama3.2:latest', model: 'llama3.2:latest', modified_at: '2026-01-01T00:00:00Z', size: 2_000_000_000, details: {} },
    ],
  };

  test('listModels merges /api/tags with what /api/ps says is loaded', async () => {
    const server = await serve((req, res) => {
      if (req.path === '/api/tags') return json(res, 200, tags);
      if (req.path === '/api/ps') return json(res, 200, { models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest', context_length: 4096, size_vram: 1 }, { name: 'gone:latest' }] });
      json(res, 404, {});
    });
    assert.deepEqual(await ollama(server).listModels(), [
      { id: 'qwen3:8b', sizeBytes: 5_200_000_000, modifiedAt: '2026-03-01T00:00:00Z', parameterSize: '8.2B', quantization: 'Q4_K_M' },
      { id: 'llama3.2:latest', sizeBytes: 2_000_000_000, modifiedAt: '2026-01-01T00:00:00Z', parameterSize: undefined, quantization: undefined, loaded: true, loadedContextLength: 4096 },
    ]);
  });

  test('listModels works when /api/ps is missing', async () => {
    const server = await serve((req, res) => (req.path === '/api/tags' ? json(res, 200, tags) : json(res, 404, { error: 'not found' })));
    const models = await ollama(server).listModels();
    assert.equal(models.length, 2);
    assert.ok(models.every((m) => m.loaded === undefined));
  });

  test('listModels failures are provider errors', async () => {
    const server = await serve((_req, res) => json(res, 500, { error: 'db locked' }));
    await assert.rejects(ollama(server).listModels(), (err: unknown) => err instanceof ProviderError && err.kind === 'http' && err.message === 'db locked');
    const port = await closedPort();
    await assert.rejects(new OllamaProvider({ name: 'o', baseUrl: `http://127.0.0.1:${port}` }).listModels(), isKind('connection'));
  });

  test('modelInfo reads context length and capabilities from /api/show, and caches', async () => {
    const server = await serve((req, res) => {
      if (req.path === '/api/show') {
        return json(res, 200, {
          capabilities: ['completion', 'tools', 'thinking', 'vision', 7],
          model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960, 'qwen3.embedding_length': 4096 },
          details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
        });
      }
      json(res, 404, {});
    });
    const provider = ollama(server);
    const info = await provider.modelInfo('qwen3:8b');
    assert.deepEqual(info, { id: 'qwen3:8b', contextLength: 40960, capabilities: ['completion', 'tools', 'thinking', 'vision'], parameterSize: '8.2B', quantization: 'Q4_K_M' });
    assert.equal(server.requests[0]!.method, 'POST');
    assert.deepEqual(server.requests[0]!.body, { model: 'qwen3:8b' });
    await provider.modelInfo('qwen3:8b');
    assert.equal(server.requests.length, 1, 'second lookup is served from the cache');
  });

  test('modelInfo is undefined when the model or server is missing, and failures are not cached', async () => {
    let fail = true;
    const server = await serve((_req, res) => (fail ? json(res, 404, { error: 'model not found' }) : json(res, 200, { capabilities: ['completion'], model_info: {} })));
    const provider = ollama(server);
    assert.equal(await provider.modelInfo('x'), undefined);
    fail = false;
    assert.deepEqual(await provider.modelInfo('x'), { id: 'x', capabilities: ['completion'] });
    const port = await closedPort();
    assert.equal(await new OllamaProvider({ name: 'o', baseUrl: `http://127.0.0.1:${port}` }).modelInfo('x'), undefined);
  });
});

// ------------------------------------------------------- provider resolution

/** Settings in which every built-in preset points at a dead port, so no test touches a real server. */
async function isolated(providers: Settings['providers'] = {}, rest: Settings = {}): Promise<Settings> {
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const all: NonNullable<Settings['providers']> = {};
  for (const [name, preset] of Object.entries(PRESETS)) all[name] = { type: preset.type, baseUrl: preset.type === 'ollama' ? dead : `${dead}/v1` };
  return { ...rest, providers: { ...all, ...providers } };
}

async function fakeOllama(models: string[]): Promise<TestServer> {
  return serve((req, res) => {
    if (req.path === '/api/version') return json(res, 200, { version: '0.0.0' });
    if (req.path === '/api/tags') return json(res, 200, { models: models.map((name) => ({ name, model: name, modified_at: '2026-01-01T00:00:00Z' })) });
    if (req.path === '/api/ps') return json(res, 200, { models: [] });
    json(res, 404, { error: 'not found' });
  });
}

async function fakeOpenAI(models: string[]): Promise<TestServer> {
  return serve((req, res) => (req.path === '/v1/models' ? json(res, 200, { data: models.map((id) => ({ id })) }) : json(res, 404, { error: 'not found' })));
}

describe('providerConfigs', () => {
  test('includes the presets and lets settings add or replace them', async () => {
    await withEnv(CLEAN_ENV, () => {
      const configs = providerConfigs({ providers: { lmstudio: { type: 'openai', baseUrl: 'http://box:1234/v1' }, mine: { type: 'openai', baseUrl: 'http://mine/v1' } } });
      assert.deepEqual(configs.ollama, { type: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
      assert.equal(configs.lmstudio!.baseUrl, 'http://box:1234/v1');
      assert.equal(configs.mine!.baseUrl, 'http://mine/v1');
      assert.equal(configs.llamacpp!.baseUrl, 'http://127.0.0.1:8080/v1');
    });
  });

  test('inherited object members are not providers', async () => {
    await withEnv(CLEAN_ENV, () => {
      const configs = providerConfigs({});
      assert.equal(configs.constructor, undefined);
      assert.equal(configs.toString, undefined);
      assert.equal(configs['__proto__'], undefined);
    });
  });

  test('OLLAMA_HOST moves the ollama preset, unless settings define it', async () => {
    await withEnv({ ...CLEAN_ENV, OLLAMA_HOST: '0.0.0.0:11500' }, () => {
      assert.deepEqual(providerConfigs({}).ollama, { type: 'ollama', baseUrl: 'http://127.0.0.1:11500' });
      const custom = providerConfigs({ providers: { ollama: { type: 'ollama', baseUrl: 'http://other:1' } } });
      assert.equal(custom.ollama!.baseUrl, 'http://other:1');
    });
  });

  test('a malformed OLLAMA_HOST is ignored', async () => {
    await withEnv({ ...CLEAN_ENV, OLLAMA_HOST: 'http://exa mple' }, () => {
      assert.equal(providerConfigs({}).ollama!.baseUrl, 'http://127.0.0.1:11434');
    });
  });

  test('OPENAI_BASE_URL moves the openai preset', async () => {
    await withEnv({ ...CLEAN_ENV, OPENAI_BASE_URL: 'http://proxy:4000/v1' }, () => {
      assert.equal(providerConfigs({}).openai!.baseUrl, 'http://proxy:4000/v1');
    });
  });
});

describe('createProvider', () => {
  test('builds the provider for the wire protocol', () => {
    const o = createProvider('ollama', { type: 'ollama', baseUrl: 'localhost' });
    assert.ok(o instanceof OllamaProvider);
    assert.equal(o.baseUrl, 'http://localhost:11434');
    assert.equal(o.type, 'ollama');
    const c = createProvider('lmstudio', { type: 'openai', baseUrl: 'http://127.0.0.1:1234/v1/' });
    assert.ok(c instanceof OpenAIProvider);
    assert.equal(c.name, 'lmstudio');
    assert.equal(c.baseUrl, 'http://127.0.0.1:1234/v1');
  });
});

describe('resolveProvider', () => {
  test('an explicit provider is used without probing', async () => {
    await withEnv(CLEAN_ENV, async () => {
      const res = await resolveProvider({ provider: 'lmstudio', model: 'qwen/qwen3-coder' });
      assert.equal(res.provider.name, 'lmstudio');
      assert.equal(res.provider.type, 'openai');
      assert.equal(res.provider.baseUrl, 'http://127.0.0.1:1234/v1');
      assert.equal(res.model, 'qwen/qwen3-coder');
      assert.equal(res.detected, undefined);
      assert.equal((await resolveProvider({ provider: 'ollama' })).provider.type, 'ollama');
    });
  });

  test('base URL and API key override the preset', async () => {
    await withEnv(CLEAN_ENV, async () => {
      const server = await serve((_req, res) => sse(res, [delta({ content: 'ok' }, 'stop')]));
      const res = await resolveProvider({ provider: 'vllm', baseUrl: `${server.root}/v1`, apiKey: 'abc' });
      assert.equal(res.provider.baseUrl, `${server.root}/v1`);
      await collect(res.provider.chat(chatReq()));
      assert.equal(server.requests[0]!.headers.authorization, 'Bearer abc');
    });
  });

  test('the openai preset takes its key from OPENAI_API_KEY; local presets do not', async () => {
    const server = await serve((_req, res) => sse(res, [delta({ content: 'ok' }, 'stop')]));
    await withEnv({ ...CLEAN_ENV, OPENAI_API_KEY: 'env-key' }, async () => {
      const hosted = await resolveProvider({ provider: 'openai', baseUrl: `${server.root}/v1` });
      await collect(hosted.provider.chat(chatReq()));
      assert.equal(server.requests[0]!.headers.authorization, 'Bearer env-key');
      const local = await resolveProvider({ provider: 'lmstudio', baseUrl: `${server.root}/v1` });
      await collect(local.provider.chat(chatReq()));
      assert.equal(server.requests[1]!.headers.authorization, undefined, 'a hosted API key must not be sent to a local server preset');
    });
  });

  test('an unknown provider is an error that lists the known ones', async () => {
    await withEnv(CLEAN_ENV, async () => {
      await assert.rejects(resolveProvider({ provider: 'nope' }), (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.kind, 'other');
        assert.match(err.message, /Unknown provider "nope"/);
        assert.match(err.message, /ollama, lmstudio, llamacpp/);
        return true;
      });
      await assert.rejects(resolveProvider({ provider: 'constructor' }), /Unknown provider "constructor"/);
      await assert.rejects(resolveProvider({ provider: 'toString' }), /Unknown provider "toString"/);
    });
  });

  test('a bare base URL means an OpenAI-compatible server', async () => {
    await withEnv(CLEAN_ENV, async () => {
      const res = await resolveProvider({ baseUrl: 'http://box:8080/v1/', model: 'm' });
      assert.equal(res.provider.name, 'custom');
      assert.equal(res.provider.type, 'openai');
      assert.equal(res.provider.baseUrl, 'http://box:8080/v1');
      assert.equal(res.model, 'm');
    });
  });

  test('port 11434 means native Ollama, unless the URL targets /v1', async () => {
    await withEnv(CLEAN_ENV, async () => {
      const native = await resolveProvider({ baseUrl: 'http://box:11434/' });
      assert.equal(native.provider.type, 'ollama');
      assert.equal(native.provider.name, 'ollama');
      assert.equal(native.provider.baseUrl, 'http://box:11434');
      const compat = await resolveProvider({ baseUrl: 'http://box:11434/v1' });
      assert.equal(compat.provider.type, 'openai');
      assert.equal(compat.provider.baseUrl, 'http://box:11434/v1');
    });
  });

  test('with a base URL the model id is used exactly as given', async () => {
    await withEnv(CLEAN_ENV, async () => {
      const res = await resolveProvider({ baseUrl: 'http://box:1234/v1', model: 'openai/gpt-oss-20b' });
      assert.equal(res.provider.name, 'custom');
      assert.equal(res.model, 'openai/gpt-oss-20b');
    });
  });

  test('"provider/model" selects a provider when the prefix names one', async () => {
    const settings = await isolated({}, { model: 'lmstudio/qwen/qwen3-coder' });
    const res = await resolveProvider(settings);
    assert.equal(res.provider.name, 'lmstudio');
    assert.equal(res.model, 'qwen/qwen3-coder');
  });

  test('a prefix that is not a provider leaves the model alone and auto-detects', async () => {
    const server = await fakeOpenAI(['qwen/qwen3-coder']);
    const settings = await isolated({ lmstudio: { type: 'openai', baseUrl: `${server.root}/v1` } }, { model: 'qwen/qwen3-coder' });
    const res = await resolveProvider(settings);
    assert.equal(res.provider.name, 'lmstudio');
    assert.equal(res.model, 'qwen/qwen3-coder');
  });

  test('a local model whose id starts with a provider name is not hijacked', async () => {
    // LM Studio lists gpt-oss as "openai/gpt-oss-20b"; that must not be sent to api.openai.com.
    const server = await fakeOpenAI(['openai/gpt-oss-20b']);
    const settings = await isolated({ lmstudio: { type: 'openai', baseUrl: `${server.root}/v1` } }, { model: 'openai/gpt-oss-20b' });
    const res = await resolveProvider(settings);
    assert.equal(res.provider.name, 'lmstudio');
    assert.equal(res.provider.baseUrl, `${server.root}/v1`);
    assert.equal(res.model, 'openai/gpt-oss-20b');
  });

  test('auto-detection fails with setup help when nothing is running', async () => {
    await assert.rejects(resolveProvider(await isolated()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'connection');
      assert.equal(err.message, NO_SERVER_HELP);
      return true;
    });
  });

  test('auto-detection uses the first running server in probe order', async () => {
    const lm = await fakeOpenAI(['a']);
    const oll = await fakeOllama(['b:latest']);
    const settings = await isolated({ lmstudio: { type: 'openai', baseUrl: `${lm.root}/v1` }, ollama: { type: 'ollama', baseUrl: oll.root } });
    const res = await resolveProvider(settings);
    assert.equal(res.provider.name, 'ollama');
    assert.equal(res.model, undefined);
    assert.deepEqual(
      res.detected?.map((d) => d.name),
      ['ollama', 'lmstudio'],
    );
  });

  test('auto-detection prefers the server that has the requested model', async () => {
    const lm = await fakeOpenAI(['wanted-model']);
    const oll = await fakeOllama(['other:latest']);
    const settings = await isolated({ lmstudio: { type: 'openai', baseUrl: `${lm.root}/v1` }, ollama: { type: 'ollama', baseUrl: oll.root } }, { model: 'wanted-model' });
    const res = await resolveProvider(settings);
    assert.equal(res.provider.name, 'lmstudio');
    assert.equal(res.model, 'wanted-model');
  });

  test('an Ollama model named without its tag still finds its server', async () => {
    const lm = await fakeOpenAI(['something-else']);
    const oll = await fakeOllama(['qwen3:latest']);
    // lmstudio is probed before the custom entry, so only the model match can choose "second".
    const settings = await isolated({ lmstudio: { type: 'openai', baseUrl: `${lm.root}/v1` }, second: { type: 'ollama', baseUrl: oll.root } }, { model: 'qwen3' });
    const res = await resolveProvider(settings);
    assert.equal(res.provider.name, 'second');
  });

  test('a server with no models is passed over for one that has some', async () => {
    const empty = await fakeOllama([]);
    const lm = await fakeOpenAI(['a']);
    const settings = await isolated({ ollama: { type: 'ollama', baseUrl: empty.root }, lmstudio: { type: 'openai', baseUrl: `${lm.root}/v1` } });
    assert.equal((await resolveProvider(settings)).provider.name, 'lmstudio');
    const onlyEmpty = await isolated({ ollama: { type: 'ollama', baseUrl: empty.root } });
    assert.equal((await resolveProvider(onlyEmpty)).provider.name, 'ollama', 'an empty server is still better than none');
  });
});

describe('detectServers', () => {
  test('returns only reachable servers, with their models, including custom providers', async () => {
    const oll = await fakeOllama(['a:latest', 'b:latest']);
    const custom = await fakeOpenAI(['c']);
    const settings = await isolated({ ollama: { type: 'ollama', baseUrl: oll.root }, mybox: { type: 'openai', baseUrl: `${custom.root}/v1` } });
    const found = await detectServers(settings, 500);
    assert.deepEqual(
      found.map((d) => [d.name, d.models.map((m) => m.id)]),
      [
        ['ollama', ['a:latest', 'b:latest']],
        ['mybox', ['c']],
      ],
    );
    assert.equal(found[0]!.config.baseUrl, oll.root);
  });

  test('a server that accepts connections but never answers is skipped after the timeout', async () => {
    const hanging = await serve(() => {
      // never responds
    });
    const settings = await isolated({ ollama: { type: 'ollama', baseUrl: hanging.root } });
    const started = Date.now();
    assert.deepEqual(await detectServers(settings, 150), []);
    assert.ok(Date.now() - started < 2000, 'the probe timeout bounds the wait');
  });

  test('a server answering with an error status is not counted', async () => {
    const broken = await serve((_req, res) => json(res, 500, { error: 'nope' }));
    const settings = await isolated({ lmstudio: { type: 'openai', baseUrl: `${broken.root}/v1` } });
    assert.deepEqual(await detectServers(settings, 500), []);
  });

  test('the API key is sent when probing', async () => {
    const server = await fakeOpenAI(['a']);
    const settings = await isolated({ mybox: { type: 'openai', baseUrl: `${server.root}/v1`, apiKey: 'probe-key' } });
    await detectServers(settings, 500);
    assert.ok(server.requests.length > 0);
    assert.ok(server.requests.every((r) => r.headers.authorization === 'Bearer probe-key'));
  });
});

describe('rankModels', () => {
  test('loaded models first, then most recently modified; embedding models removed', () => {
    const models: ModelInfo[] = [
      { id: 'old', modifiedAt: '2025-01-01T00:00:00Z' },
      { id: 'new', modifiedAt: '2026-06-01T00:00:00Z' },
      { id: 'nomic-embed-text:latest', modifiedAt: '2026-07-01T00:00:00Z' },
      { id: 'loaded-old', modifiedAt: '2024-01-01T00:00:00Z', loaded: true },
      { id: 'bge-m3' },
      { id: 'tagged-embedder', capabilities: ['embedding'] },
      { id: 'undated' },
    ];
    assert.deepEqual(
      rankModels(models).map((m) => m.id),
      ['loaded-old', 'new', 'old', 'undated'],
    );
  });

  test('does not reorder the input array', () => {
    const models: ModelInfo[] = [{ id: 'a', modifiedAt: '2025' }, { id: 'b', modifiedAt: '2026' }];
    rankModels(models);
    assert.deepEqual(
      models.map((m) => m.id),
      ['a', 'b'],
    );
  });
});

// ------------------------------------------------------------- model profile

class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly type: 'ollama' | 'openai';
  readonly baseUrl: string;
  requests: ChatRequest[] = [];
  info: ModelInfo | undefined | Error;
  script: (req: ChatRequest, index: number) => (StreamEvent | Error)[];

  constructor(type: 'ollama' | 'openai' = 'openai', baseUrl = 'http://fake/v1') {
    this.type = type;
    this.baseUrl = baseUrl;
    this.info = undefined;
    this.script = () => [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'stop' }];
  }

  async *chat(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const index = this.requests.length;
    this.requests.push(req);
    for (const step of this.script(req, index)) {
      if (step instanceof Error) throw step;
      yield step;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async modelInfo(): Promise<ModelInfo | undefined> {
    if (this.info instanceof Error) throw this.info;
    return this.info;
  }
}

function fake(type: 'ollama' | 'openai', info?: ModelInfo | Error, baseUrl?: string): FakeProvider {
  const p = new FakeProvider(type, baseUrl ?? (type === 'ollama' ? 'http://fake:11434' : 'http://fake:1234/v1'));
  p.info = info;
  return p;
}

describe('profileModel', () => {
  test('Ollama: the context is capped at 32k, or at the model maximum when smaller', async () => {
    assert.equal((await profileModel(fake('ollama', { id: 'm', contextLength: 131072 }), 'm', {})).contextWindow, 32768);
    assert.equal((await profileModel(fake('ollama', { id: 'm', contextLength: 8192 }), 'm', {})).contextWindow, 8192);
    assert.equal((await profileModel(fake('ollama'), 'm', {})).contextWindow, 32768);
  });

  test('Ollama: what the server happens to have loaded does not limit the request', async () => {
    const p = await profileModel(fake('ollama', { id: 'm', contextLength: 131072, loadedContextLength: 4096 }), 'm', {});
    assert.equal(p.contextWindow, 32768, 'num_ctx is set per request, so the loaded size is irrelevant');
  });

  test('an explicit contextWindow wins, up to the model maximum', async () => {
    const big = await profileModel(fake('ollama', { id: 'm', contextLength: 131072 }), 'm', { contextWindow: 65536 });
    assert.equal(big.contextWindow, 65536);
    assert.deepEqual(big.notes, []);
    const capped = await profileModel(fake('ollama', { id: 'm', contextLength: 8192 }), 'm', { contextWindow: 65536 });
    assert.equal(capped.contextWindow, 8192);
    assert.match(capped.notes.join('\n'), /exceeds the model's maximum \(8192\)/);
    const unknown = await profileModel(fake('openai'), 'm', { contextWindow: 100000 });
    assert.equal(unknown.contextWindow, 100000);
  });

  test('OpenAI-compatible: the loaded context is authoritative', async () => {
    const p = await profileModel(fake('openai', { id: 'm', contextLength: 262144, loadedContextLength: 16384 }), 'm', {});
    assert.equal(p.contextWindow, 16384);
    const large = await profileModel(fake('openai', { id: 'm', loadedContextLength: 131072 }), 'm', {});
    assert.equal(large.contextWindow, 131072, 'a server running a large context is used in full');
  });

  test('OpenAI-compatible: without a loaded size, assume up to 32k', async () => {
    assert.equal((await profileModel(fake('openai', { id: 'm', contextLength: 131072 }), 'm', {})).contextWindow, 32768);
    assert.equal((await profileModel(fake('openai', { id: 'm', contextLength: 4096 }), 'm', {})).contextWindow, 4096);
    assert.equal((await profileModel(fake('openai'), 'm', {})).contextWindow, 32768);
  });

  test("Ollama's /v1 endpoint gets a warning about its fixed context", async () => {
    const p = await profileModel(fake('openai', undefined, 'http://127.0.0.1:11434/v1'), 'm', {});
    assert.match(p.notes.join('\n'), /cannot set the context window per request/);
    const other = await profileModel(fake('openai', undefined, 'http://127.0.0.1:1234/v1'), 'm', {});
    assert.deepEqual(other.notes, []);
  });

  test('a small context window is called out', async () => {
    const p = await profileModel(fake('openai', { id: 'm', loadedContextLength: 4096 }), 'm', {});
    assert.match(p.notes.join('\n'), /only 4096 tokens/);
    const fine = await profileModel(fake('openai', { id: 'm', loadedContextLength: 8192 }), 'm', {});
    assert.deepEqual(fine.notes, []);
  });

  test('the output budget is a quarter of the context, between 1024 and 8192', async () => {
    const at = async (ctx: number) => (await profileModel(fake('openai'), 'm', { contextWindow: ctx })).maxOutputTokens;
    assert.equal(await at(32768), 8192);
    assert.equal(await at(131072), 8192);
    assert.equal(await at(16384), 4096);
    assert.equal(await at(8192), 2048);
    assert.equal(await at(2048), 1024);
    assert.equal((await profileModel(fake('openai'), 'm', { contextWindow: 32768, maxOutputTokens: 500 })).maxOutputTokens, 500);
  });

  test('tool mode: native unless the server says the model has no tool support', async () => {
    const native = await profileModel(fake('ollama', { id: 'm', capabilities: ['completion', 'tools'] }), 'm', {});
    assert.equal(native.toolMode, 'native');
    const none = await profileModel(fake('ollama', { id: 'gemma', capabilities: ['completion'] }), 'gemma', {});
    assert.equal(none.toolMode, 'prompt');
    assert.match(none.notes.join('\n'), /gemma does not advertise native tool calling/);
    const unknown = await profileModel(fake('openai', { id: 'm' }), 'm', {});
    assert.equal(unknown.toolMode, 'native', 'unknown capabilities are given the benefit of the doubt');
  });

  test('tool mode can be forced either way', async () => {
    const forcedNative = await profileModel(fake('ollama', { id: 'm', capabilities: ['completion'] }), 'm', { toolMode: 'native' });
    assert.equal(forcedNative.toolMode, 'native');
    assert.deepEqual(forcedNative.notes, []);
    const forcedPrompt = await profileModel(fake('ollama', { id: 'm', capabilities: ['tools'] }), 'm', { toolMode: 'prompt' });
    assert.equal(forcedPrompt.toolMode, 'prompt');
    const auto = await profileModel(fake('ollama', { id: 'm', capabilities: ['completion'] }), 'm', { toolMode: 'auto' });
    assert.equal(auto.toolMode, 'prompt');
  });

  test('vision comes from capabilities or the separate flag', async () => {
    assert.equal((await profileModel(fake('ollama', { id: 'm', capabilities: ['tools', 'vision'] }), 'm', {})).vision, true);
    assert.equal((await profileModel(fake('openai', { id: 'm', vision: true }), 'm', {})).vision, true);
    assert.equal((await profileModel(fake('ollama', { id: 'm', capabilities: ['tools'] }), 'm', {})).vision, false);
    assert.equal((await profileModel(fake('openai'), 'm', {})).vision, false);
  });

  test('a failing model lookup falls back to defaults', async () => {
    const p = await profileModel(fake('ollama', new Error('boom')), 'm', {});
    assert.deepEqual(p, { info: undefined, contextWindow: 32768, maxOutputTokens: 8192, toolMode: 'native', vision: false, notes: [] });
  });
});

// --------------------------------------------------------------- ModelClient

function profile(over: Partial<ModelProfile> = {}): ModelProfile {
  return { contextWindow: 32768, maxOutputTokens: 8192, toolMode: 'native', vision: false, notes: [], ...over };
}

const HISTORY: Message[] = [
  { role: 'user', content: 'read a.txt' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: { file_path: 'a.txt' } }] },
  { role: 'tool', toolCallId: 'c1', name: 'Read', content: 'hello' },
];

describe('ModelClient.chat', () => {
  test('fills in model, context, limits and settings defaults', async () => {
    const provider = new FakeProvider();
    const client = new ModelClient(provider, 'the-model', profile({ contextWindow: 16384, maxOutputTokens: 2048 }), { temperature: 0.3, thinking: 'low', keepAlive: '5m' });
    await collect(client.chat({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] }));
    const req = provider.requests[0]!;
    assert.equal(req.model, 'the-model');
    assert.equal(req.contextWindow, 16384);
    assert.equal(req.maxTokens, 2048);
    assert.equal(req.temperature, 0.3);
    assert.equal(req.thinking, 'low');
    assert.equal(req.keepAlive, '5m');
    assert.deepEqual(req.tools, [TOOL]);
    assert.equal(req.system, 'S');
  });

  test('per-request values override the defaults, including explicit false and zero', async () => {
    const provider = new FakeProvider();
    const client = new ModelClient(provider, 'm', profile(), { temperature: 0.7, thinking: true });
    await collect(client.chat({ system: 'S', messages: [], tools: [], maxTokens: 99, temperature: 0, thinking: false }));
    const req = provider.requests[0]!;
    assert.equal(req.maxTokens, 99);
    assert.equal(req.temperature, 0);
    assert.equal(req.thinking, false);
    assert.equal(req.keepAlive, '30m', 'keep_alive has a default');
  });

  test('native events pass through and tool calls set the stop reason', async () => {
    const provider = new FakeProvider();
    const call: ToolCall = { id: 'c1', name: 'Read', arguments: { file_path: 'a.txt' } };
    provider.script = () => [
      { type: 'thinking', text: 'hm' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool_call', call },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'done', stopReason: 'stop' },
    ];
    const out = await collect(new ModelClient(provider, 'm', profile(), {}).chat({ system: 'S', messages: [], tools: [TOOL] }));
    assert.equal(out.thinking, 'hm');
    assert.equal(out.text, 'Reading.');
    assert.deepEqual(out.calls, [call]);
    assert.deepEqual(out.usage, { inputTokens: 5, outputTokens: 2 });
    assert.equal(out.stop, 'tool_calls');
  });

  test('a tool call leaked into the text becomes a real call', async () => {
    const provider = new FakeProvider();
    provider.script = () => [
      { type: 'text', text: 'I will read it.\n<tool_' },
      { type: 'text', text: 'call>\n{"name": "Read", "arguments": {"file_path": "a.txt"}}\n</tool_call>' },
      { type: 'done', stopReason: 'stop' },
    ];
    const out = await collect(new ModelClient(provider, 'm', profile(), {}).chat({ system: 'S', messages: [], tools: [TOOL] }));
    assert.equal(out.text, 'I will read it.\n');
    assert.deepEqual(callShape(out.calls), [{ name: 'Read', arguments: { file_path: 'a.txt' } }]);
    assert.equal(out.stop, 'tool_calls', 'the turn must continue, not end as if the model were finished');
    assert.equal(provider.requests[0]!.tools.length, 1, 'the request itself stayed native');
  });

  test('a bare JSON reply naming a known tool becomes a call; other JSON stays text', async () => {
    const provider = new FakeProvider();
    provider.script = (_req, i) => [{ type: 'text', text: i === 0 ? '{"name": "Read", "arguments": {"file_path": "a.txt"}}' : '{"name": "Unknown", "arguments": {}}' }, { type: 'done', stopReason: 'stop' }];
    const client = new ModelClient(provider, 'm', profile(), {});
    const first = await collect(client.chat({ system: 'S', messages: [], tools: [TOOL] }));
    assert.deepEqual(callShape(first.calls), [{ name: 'Read', arguments: { file_path: 'a.txt' } }]);
    assert.equal(first.text, '');
    assert.equal(first.stop, 'tool_calls');
    const second = await collect(client.chat({ system: 'S', messages: [], tools: [TOOL] }));
    assert.deepEqual(second.calls, []);
    assert.equal(second.text, '{"name": "Unknown", "arguments": {}}');
    assert.equal(second.stop, 'stop');
  });

  test('a call reported both natively and as leaked text is one call', async () => {
    const provider = new FakeProvider();
    const call: ToolCall = { id: 'native1', name: 'Read', arguments: { file_path: 'a.txt' } };
    provider.script = () => [
      { type: 'text', text: '<tool_call>{"name": "Read", "arguments": {"file_path": "a.txt"}}</tool_call>' },
      { type: 'tool_call', call },
      { type: 'tool_call', call: { id: 'native2', name: 'Read', arguments: { file_path: 'b.txt' } } },
      { type: 'done', stopReason: 'tool_calls' },
    ];
    const out = await collect(new ModelClient(provider, 'm', profile(), {}).chat({ system: 'S', messages: [], tools: [TOOL] }));
    assert.deepEqual(callShape(out.calls), [
      { name: 'Read', arguments: { file_path: 'a.txt' } },
      { name: 'Read', arguments: { file_path: 'b.txt' } },
    ]);
    assert.equal(out.text, '');
  });

  test('the same call made twice by one source is kept twice', async () => {
    const provider = new FakeProvider();
    provider.script = () => [
      { type: 'tool_call', call: { id: 'a', name: 'Bash', arguments: { command: 'npm test' } } },
      { type: 'tool_call', call: { id: 'b', name: 'Bash', arguments: { command: 'npm test' } } },
      { type: 'done', stopReason: 'tool_calls' },
    ];
    const out = await collect(new ModelClient(provider, 'm', profile(), {}).chat({ system: 'S', messages: [], tools: [BASH] }));
    assert.deepEqual(out.calls.map((c) => c.id), ['a', 'b']);
  });

  test('<think> tags in the text become thinking events', async () => {
    const provider = new FakeProvider();
    provider.script = () => [{ type: 'text', text: '<think>plan</think>\n\nAnswer.' }, { type: 'done', stopReason: 'stop' }];
    const out = await collect(new ModelClient(provider, 'm', profile(), {}).chat({ system: 'S', messages: [], tools: [] }));
    assert.equal(out.thinking, 'plan');
    assert.equal(out.text, 'Answer.');
  });

  test('"length" survives when there are no calls', async () => {
    const provider = new FakeProvider();
    provider.script = () => [{ type: 'text', text: 'cut' }, { type: 'done', stopReason: 'length' }];
    assert.equal((await collect(new ModelClient(provider, 'm', profile(), {}).chat({ system: 'S', messages: [], tools: [TOOL] }))).stop, 'length');
  });

  test('prompt mode rewrites the request and parses calls from the reply', async () => {
    const provider = new FakeProvider();
    provider.script = () => [{ type: 'text', text: '<tool_call>\n{"name": "Read", "arguments": {"file_path": "b.txt"}}\n</tool_call>' }, { type: 'done', stopReason: 'stop' }];
    const client = new ModelClient(provider, 'm', profile({ toolMode: 'prompt' }), {});
    const out = await collect(client.chat({ system: 'S', messages: HISTORY, tools: [TOOL] }));
    const req = provider.requests[0]!;
    assert.deepEqual(req.tools, [], 'no native tools are sent');
    assert.ok(req.system.startsWith('S\n\n# Tools'));
    assert.match(req.system, /"name":"Read"/);
    assert.deepEqual(
      req.messages.map((m) => m.role),
      ['user', 'assistant', 'user'],
    );
    assert.match(String(req.messages[1]!.content), /<tool_call>/);
    assert.match(String(req.messages[2]!.content), /<tool_response name="Read">\nhello\n<\/tool_response>/);
    assert.deepEqual(callShape(out.calls), [{ name: 'Read', arguments: { file_path: 'b.txt' } }]);
    assert.equal(out.stop, 'tool_calls');
    assert.equal(HISTORY.length, 3);
    assert.equal(HISTORY[2]!.role, 'tool', 'the caller\'s history is untouched');
  });

  test('falls back to the text protocol when the server says tools are unsupported', async () => {
    const provider = new FakeProvider();
    provider.script = (req) =>
      req.tools.length ? [new ProviderError('tools_unsupported', 'gemma does not support tools', 400)] : [{ type: 'text', text: 'ok in text mode' }, { type: 'done', stopReason: 'stop' }];
    const prof = profile();
    const client = new ModelClient(provider, 'gemma', prof, {});
    const out = await collect(client.chat({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] }));
    assert.equal(out.text, 'ok in text mode');
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[0]!.tools.length, 1);
    assert.deepEqual(provider.requests[1]!.tools, []);
    assert.match(provider.requests[1]!.system, /# Tools/);
    assert.equal(prof.toolMode, 'prompt');
    assert.match(prof.notes.join('\n'), /gemma rejected native tool calling/);

    await collect(client.chat({ system: 'S', messages: [{ role: 'user', content: 'again' }], tools: [TOOL] }));
    assert.equal(provider.requests.length, 3, 'later requests go straight to the text protocol');
    assert.deepEqual(provider.requests[2]!.tools, []);
  });

  test('does not fall back once output has started', async () => {
    const provider = new FakeProvider();
    provider.script = () => [{ type: 'text', text: 'already said something' }, new ProviderError('tools_unsupported', 'late failure')];
    const prof = profile();
    const gen = new ModelClient(provider, 'm', prof, {}).chat({ system: 'S', messages: [], tools: [TOOL] });
    assert.deepEqual((await gen.next()).value, { type: 'text', text: 'already said something' });
    await assert.rejects(gen.next(), isKind('tools_unsupported'));
    assert.equal(provider.requests.length, 1);
    assert.equal(prof.toolMode, 'native');
  });

  test('does not fall back when native tool mode is forced', async () => {
    const provider = new FakeProvider();
    provider.script = () => [new ProviderError('tools_unsupported', 'no tools')];
    const prof = profile();
    await assert.rejects(collect(new ModelClient(provider, 'm', prof, { toolMode: 'native' }).chat({ system: 'S', messages: [], tools: [TOOL] })), isKind('tools_unsupported'));
    assert.equal(provider.requests.length, 1);
    assert.equal(prof.toolMode, 'native');
  });

  test('a failure in text mode is not retried again', async () => {
    const provider = new FakeProvider();
    provider.script = () => [new ProviderError('tools_unsupported', 'still no')];
    await assert.rejects(collect(new ModelClient(provider, 'm', profile(), {}).chat({ system: 'S', messages: [], tools: [TOOL] })), isKind('tools_unsupported'));
    assert.equal(provider.requests.length, 2, 'one native attempt, one text-protocol attempt');
  });

  test('other errors are passed on unchanged', async () => {
    const provider = new FakeProvider();
    const boom = new ProviderError('context_overflow', 'too big', 400);
    provider.script = () => [boom];
    await assert.rejects(collect(new ModelClient(provider, 'm', profile(), {}).chat({ system: 'S', messages: [], tools: [TOOL] })), (err: unknown) => err === boom);
    assert.equal(provider.requests.length, 1);
  });

  test('a stream that ends without "done" still flushes held text and finishes', async () => {
    const provider = new FakeProvider();
    provider.script = () => [{ type: 'text', text: 'tail <' }];
    const out = await collect(new ModelClient(provider, 'm', profile(), {}).chat({ system: 'S', messages: [], tools: [TOOL] }));
    assert.equal(out.text, 'tail <');
    assert.equal(out.stop, 'stop');
  });

  test('end to end over HTTP: an Ollama model without tool support is driven through the text protocol', async () => {
    const server = await serve((req, res) => {
      if (req.path !== '/api/chat') return json(res, 404, {});
      if (Array.isArray(req.body.tools) && req.body.tools.length) return json(res, 400, { error: 'registry.ollama.ai/library/gemma3:4b does not support tools' });
      ndjson(res, [part({ content: '<tool_call>\n{"name": "Read", "arguments": {"file_path": "a.txt"}}\n</tool_call>' }), DONE]);
    });
    const provider = new OllamaProvider({ name: 'ollama', baseUrl: server.root });
    const client = new ModelClient(provider, 'gemma3:4b', profile(), {});
    const out = await collect(client.chat({ system: 'S', messages: [{ role: 'user', content: 'read a.txt' }], tools: [TOOL] }));
    assert.deepEqual(callShape(out.calls), [{ name: 'Read', arguments: { file_path: 'a.txt' } }]);
    assert.equal(out.stop, 'tool_calls');
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[1]!.body.tools, undefined);
    assert.equal(server.requests[1]!.body.options.num_ctx, 32768);
    assert.match(server.requests[1]!.body.messages[0].content, /# Tools/);
  });
});

describe('ModelClient.complete', () => {
  test('returns the trimmed text, without tools, ignoring reasoning', async () => {
    const provider = new FakeProvider();
    provider.script = () => [{ type: 'thinking', text: 'private' }, { type: 'text', text: '  A summary.' }, { type: 'text', text: '\n' }, { type: 'done', stopReason: 'stop' }];
    const client = new ModelClient(provider, 'm', profile({ toolMode: 'prompt' }), {});
    const ctrl = new AbortController();
    const text = await client.complete('SYSTEM', 'Summarise this.', { maxTokens: 300, signal: ctrl.signal });
    assert.equal(text, 'A summary.');
    const req = provider.requests[0]!;
    assert.equal(req.system, 'SYSTEM', 'no tool instructions are added when there are no tools');
    assert.deepEqual(req.messages, [{ role: 'user', content: 'Summarise this.' }]);
    assert.deepEqual(req.tools, []);
    assert.equal(req.maxTokens, 300);
    // The request carries a signal that follows the caller's (combined with the stall guard).
    assert.equal(req.signal!.aborted, false);
    ctrl.abort();
    assert.equal(req.signal!.aborted, true);
  });

  test('errors propagate', async () => {
    const provider = new FakeProvider();
    provider.script = () => [new ProviderError('connection', 'down')];
    await assert.rejects(new ModelClient(provider, 'm', profile(), {}).complete('S', 'p'), isKind('connection'));
  });
});
