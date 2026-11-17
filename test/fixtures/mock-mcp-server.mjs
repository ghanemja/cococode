#!/usr/bin/env node
// A tiny MCP server over stdio, used by test/mcp.test.ts.
// It deliberately misbehaves in a few ways real servers do: it logs a
// non-JSON line to stdout, paginates tools/list, and can crash on demand.
// COCO_MOCK_NO_RESOURCES=1 makes it a server without the resources capability.
import * as readline from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  { name: 'fail', description: 'Always returns an error result', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'sleep',
    description: 'Wait for ms milliseconds',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
  { name: 'crash', description: 'Exit the server process' },
  { name: 'image', description: 'Return an image block', inputSchema: { type: 'object', properties: {} } },
  { name: 'structured', description: 'Return only structuredContent', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'big',
    description: 'Return size characters',
    inputSchema: { type: 'object', properties: { size: { type: 'number' } } },
  },
  { name: 'cancelled_count', description: 'How many cancellation notifications arrived', inputSchema: { type: 'object' } },
  { name: 'ping_client', description: 'Send a ping request to the client', inputSchema: { type: 'object' } },
  { name: 'ask_client', description: 'Send an unsupported request to the client', inputSchema: { type: 'object' } },
  {
    name: 'env',
    description: 'Read an environment variable',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
  { name: 'dotted.name', description: 'A tool whose name needs sanitising', inputSchema: { type: 'object' } },
  { name: 'list_roots', description: 'Ask the client for its roots and return them', inputSchema: { type: 'object' } },
];
const PAGE_SIZE = 5;

let cancelled = 0;
let serverRequestId = 0;
let clientCapabilities = {};
const sleeping = new Map(); // request id -> timer
const awaitingClient = new Map(); // server request id -> callback

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function text(value, extra = {}) {
  return { content: [{ type: 'text', text: String(value) }], ...extra };
}

function askClient(method, callback) {
  const id = `srv-${++serverRequestId}`;
  awaitingClient.set(id, callback);
  send({ jsonrpc: '2.0', id, method });
}

function callTool(id, name, args) {
  switch (name) {
    case 'echo':
      return reply(id, text(args.text ?? ''));
    case 'add':
      return reply(id, text(Number(args.a) + Number(args.b)));
    case 'fail':
      return reply(id, text('something went wrong', { isError: true }));
    case 'sleep': {
      const timer = setTimeout(() => {
        sleeping.delete(id);
        reply(id, text('slept'));
      }, Number(args.ms ?? 1000));
      sleeping.set(id, timer);
      return undefined;
    }
    case 'crash':
      process.stderr.write('fatal: crashing on purpose\n');
      return process.exit(3);
    case 'image':
      return reply(id, {
        content: [
          { type: 'text', text: 'here is a picture' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'mock://embedded', mimeType: 'text/plain', text: 'embedded text' } },
        ],
      });
    case 'structured':
      return reply(id, { structuredContent: { ok: true, items: [1, 2] } });
    case 'big':
      return reply(id, text('x'.repeat(Number(args.size ?? 1000))));
    case 'cancelled_count':
      return reply(id, text(cancelled));
    case 'ping_client':
      return askClient('ping', (response) => reply(id, text(response.error ? 'ping failed' : 'pong received')));
    case 'ask_client':
      return askClient('sampling/createMessage', (response) => reply(id, text(`client error ${response.error?.code}`)));
    case 'list_roots':
      return askClient('roots/list', (response) =>
        reply(
          id,
          text(
            JSON.stringify({
              advertised: clientCapabilities.roots !== undefined,
              roots: response.result?.roots,
              error: response.error?.code,
            }),
          ),
        ),
      );
    case 'env':
      return reply(id, text(process.env[String(args.name)] ?? '(unset)'));
    case 'dotted.name':
      return reply(id, text('dotted ok'));
    default:
      return fail(id, -32602, `Unknown tool: ${name}`);
  }
}

function handle(message) {
  // Responses to requests this server sent to the client.
  if (message.method === undefined && message.id !== undefined) {
    const callback = awaitingClient.get(message.id);
    awaitingClient.delete(message.id);
    callback?.(message);
    return;
  }

  const { id, method, params = {} } = message;
  switch (method) {
    case 'initialize':
      clientCapabilities = params.capabilities ?? {};
      return reply(id, {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: process.env.COCO_MOCK_NO_RESOURCES
          ? { tools: { listChanged: true }, prompts: {} }
          : { tools: { listChanged: true }, prompts: {}, resources: {} },
        serverInfo: { name: 'mock-mcp', version: '1.2.3' },
        instructions: 'Mock server instructions.',
      });
    case 'notifications/initialized':
      return undefined;
    case 'notifications/cancelled': {
      cancelled++;
      const timer = sleeping.get(params.requestId);
      if (timer) {
        clearTimeout(timer);
        sleeping.delete(params.requestId);
      }
      return undefined;
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list': {
      const start = params.cursor ? Number(params.cursor) : 0;
      const page = TOOLS.slice(start, start + PAGE_SIZE);
      const next = start + PAGE_SIZE < TOOLS.length ? String(start + PAGE_SIZE) : undefined;
      return reply(id, next ? { tools: page, nextCursor: next } : { tools: page });
    }
    case 'tools/call':
      return callTool(id, params.name, params.arguments ?? {});
    case 'prompts/list':
      return reply(id, {
        prompts: [
          {
            name: 'greet',
            description: 'Greet someone',
            arguments: [{ name: 'who', description: 'Name to greet', required: true }],
          },
        ],
      });
    case 'prompts/get':
      if (params.name !== 'greet') return fail(id, -32602, `Unknown prompt: ${params.name}`);
      return reply(id, {
        description: 'Greet someone',
        messages: [
          { role: 'user', content: { type: 'text', text: `Say hello to ${params.arguments?.who ?? 'nobody'}.` } },
          { role: 'assistant', content: { type: 'text', text: 'Be brief.' } },
        ],
      });
    case 'resources/list':
      return reply(id, {
        resources: [{ uri: 'mock://readme', name: 'readme', description: 'A readme', mimeType: 'text/plain' }],
      });
    case 'resources/read':
      // Not listed: a resource large enough to need clamping.
      if (params.uri === 'mock://big') return reply(id, { contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'r'.repeat(50000) }] });
      if (params.uri === 'mock://binary') return reply(id, { contents: [{ uri: params.uri, mimeType: 'image/png', blob: 'aGVsbG8=' }] });
      if (params.uri !== 'mock://readme') return fail(id, -32002, `Resource not found: ${params.uri}`);
      return reply(id, { contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'mock readme contents' }] });
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
      return undefined;
  }
}

process.stderr.write('mock-mcp-server starting\n');
// Not valid JSON-RPC: clients must tolerate stray stdout output.
process.stdout.write('mock-mcp-server ready\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  handle(message);
});
rl.on('close', () => process.exit(0));
