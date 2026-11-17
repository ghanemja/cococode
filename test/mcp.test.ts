import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { McpClient, McpError, parseSse } from '../src/mcp/client.ts';
import {
  addMcpServer,
  loadMcpServers,
  mcpConfigPath,
  normalizeMcpConfig,
  removeMcpServer,
  type McpServerConfig,
  type ScopedMcpServer,
} from '../src/mcp/config.ts';
import { McpManager, mcpToolName, toToolResult } from '../src/mcp/manager.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeContext, tempProject, writeFiles } from './helpers.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'mock-mcp-server.mjs');
const TOOL_COUNT = 13;

function stdioConfig(env?: Record<string, string>): McpServerConfig {
  return env ? { command: process.execPath, args: [FIXTURE], env } : { command: process.execPath, args: [FIXTURE] };
}

function text(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? []).map((b) => b.text ?? '').join('');
}

async function connected(t: TestContext, opts: ConstructorParameters<typeof McpClient>[2] = {}): Promise<McpClient> {
  const client = new McpClient('mock', stdioConfig(), opts);
  t.after(() => client.close());
  await client.connect();
  return client;
}

function findTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should exist (have: ${tools.map((t) => t.name).join(', ')})`);
  return tool;
}

// ---------------------------------------------------------------------------
// config

test('config: merges sources with local > project > user > settings, and flags on top', () => {
  const root = tempProject();
  writeFiles(root, {
    '.coco-home/mcp.json': JSON.stringify({
      mcpServers: { shared: { command: 'user-cmd' }, userOnly: { command: 'u' } },
    }),
    '.mcp.json': JSON.stringify({
      mcpServers: { shared: { command: 'project-cmd' }, projectOnly: { type: 'http', url: 'http://localhost:9/mcp' } },
    }),
    '.coco/mcp.local.json': JSON.stringify({ mcpServers: { shared: { command: 'local-cmd' } } }),
    'extra.json': JSON.stringify({ flagged: { command: 'bare-map' }, userOnly: { command: 'from-flag' } }),
  });

  const { servers, errors } = loadMcpServers(root, {
    inline: { shared: { command: 'settings-cmd' }, inlineOnly: { command: 'i' } },
  });
  assert.deepEqual(errors, []);
  const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
  assert.equal(byName.shared!.scope, 'local');
  assert.equal((byName.shared!.config as { command: string }).command, 'local-cmd');
  assert.equal(byName.userOnly!.scope, 'user');
  assert.equal(byName.projectOnly!.scope, 'project');
  assert.deepEqual(byName.projectOnly!.config, { type: 'http', url: 'http://localhost:9/mcp' });
  assert.equal(byName.inlineOnly!.scope, 'settings');
  assert.equal(servers.length, 4);

  const withFlags = loadMcpServers(root, {
    extraFiles: ['extra.json', '{"mcpServers":{"shared":{"command":"inline-json"}}}'],
  });
  assert.deepEqual(withFlags.errors, []);
  const flagged = Object.fromEntries(withFlags.servers.map((s) => [s.name, s]));
  assert.equal(flagged.flagged!.scope, 'flag');
  assert.equal((flagged.userOnly!.config as { command: string }).command, 'from-flag');
  assert.equal((flagged.shared!.config as { command: string }).command, 'inline-json');
  assert.equal(flagged.shared!.scope, 'flag');
});

test('config: expands ${VAR} and ${VAR:-default}, and reports unset variables', () => {
  const root = tempProject();
  process.env.COCO_MCP_TEST_TOKEN = 'secret-token';
  delete process.env.COCO_MCP_TEST_MISSING;
  writeFiles(root, {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        a: {
          command: '${COCO_MCP_TEST_BIN:-node}',
          args: ['--token=${COCO_MCP_TEST_TOKEN}', 'plain'],
          env: { KEY: '${COCO_MCP_TEST_TOKEN}', OTHER: '${COCO_MCP_TEST_MISSING:-fallback}' },
        },
        b: {
          type: 'http',
          url: 'http://localhost:${COCO_MCP_TEST_PORT:-8123}/mcp',
          headers: { Authorization: 'Bearer ${COCO_MCP_TEST_TOKEN}' },
        },
        c: { command: 'x', args: ['${COCO_MCP_TEST_MISSING}'] },
      },
    }),
  });
  const { servers, errors } = loadMcpServers(root);
  const byName = Object.fromEntries(servers.map((s) => [s.name, s.config]));
  assert.deepEqual(byName.a, {
    type: 'stdio',
    command: 'node',
    args: ['--token=secret-token', 'plain'],
    env: { KEY: 'secret-token', OTHER: 'fallback' },
  });
  assert.deepEqual(byName.b, {
    type: 'http',
    url: 'http://localhost:8123/mcp',
    headers: { Authorization: 'Bearer secret-token' },
  });
  assert.deepEqual(byName.c, { type: 'stdio', command: 'x', args: [''] });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /"c".*COCO_MCP_TEST_MISSING/);
  delete process.env.COCO_MCP_TEST_TOKEN;
});

test('config: collects problems instead of throwing, and honours the disabled list', () => {
  const root = tempProject();
  writeFiles(root, {
    '.coco-home/mcp.json': '{ not json',
    '.mcp.json': JSON.stringify({
      mcpServers: {
        ok: { command: 'fine' },
        off: { command: 'disabled' },
        noCommand: { args: ['x'] },
        badType: { type: 'websocket', url: 'ws://x' },
        badUrl: { type: 'http', url: 'not a url' },
        notObject: 'nope',
        urlOnly: { url: 'https://example.com/mcp' },
        legacy: { type: 'sse', url: 'https://example.com/sse' },
      },
    }),
    '.coco/mcp.local.json': JSON.stringify({ mcpServers: 'wrong shape' }),
  });
  const { servers, errors } = loadMcpServers(root, { disabled: ['off'], extraFiles: ['missing.json', '{bad'] });
  assert.deepEqual(servers.map((s) => s.name).sort(), ['legacy', 'ok', 'urlOnly']);
  const byName = Object.fromEntries(servers.map((s) => [s.name, s.config]));
  assert.equal((byName.urlOnly as { type: string }).type, 'http');
  assert.equal((byName.legacy as { type: string }).type, 'sse');
  const joined = errors.join('\n');
  assert.match(joined, /Could not parse .*mcp\.json/);
  assert.match(joined, /"noCommand" needs either/);
  assert.match(joined, /"badType" unknown type/);
  assert.match(joined, /"badUrl" invalid url/);
  assert.match(joined, /"notObject" must be an object/);
  assert.match(joined, /mcp\.local\.json: expected/);
  assert.match(joined, /not found: .*missing\.json/);
  assert.match(joined, /--mcp-config is not valid JSON/);
  assert.equal(errors.length, 8);
});

test('config: normalizeMcpConfig accepts streamable-http aliases', () => {
  assert.deepEqual(normalizeMcpConfig({ type: 'streamable-http', url: 'http://h/mcp' }).config, {
    type: 'http',
    url: 'http://h/mcp',
  });
  assert.match(normalizeMcpConfig({ type: 'http' }).error ?? '', /requires a "url"/);
  assert.match(normalizeMcpConfig({ command: 'x', args: 'oops' }).error ?? '', /"args" must be an array/);
});

test('config: add and remove servers per scope', () => {
  const root = tempProject();
  assert.equal(mcpConfigPath('user', root), path.join(root, '.coco-home', 'mcp.json'));
  assert.equal(mcpConfigPath('project', root), path.join(root, '.mcp.json'));
  assert.equal(mcpConfigPath('local', root), path.join(root, '.coco', 'mcp.local.json'));

  // Existing unrelated keys in the file are preserved.
  writeFiles(root, { '.mcp.json': JSON.stringify({ other: 1, mcpServers: { keep: { command: 'k' } } }) });
  const file = addMcpServer('project', root, 'fs', { command: 'npx', args: ['-y', 'server-fs'] });
  assert.equal(file, path.join(root, '.mcp.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    other: 1,
    mcpServers: { keep: { command: 'k' }, fs: { command: 'npx', args: ['-y', 'server-fs'] } },
  });

  addMcpServer('user', root, 'fs', { command: 'user-fs' });
  addMcpServer('local', root, 'fs', { type: 'http', url: 'http://localhost:1/mcp' });
  assert.equal(loadMcpServers(root).servers.find((s) => s.name === 'fs')!.scope, 'local');

  // Without a scope the most specific definition goes first.
  assert.equal(removeMcpServer(root, 'fs'), 'local');
  assert.equal(removeMcpServer(root, 'fs'), 'project');
  assert.equal(loadMcpServers(root).servers.find((s) => s.name === 'fs')!.scope, 'user');
  assert.equal(removeMcpServer(root, 'fs', 'project'), undefined);
  assert.equal(removeMcpServer(root, 'fs', 'user'), 'user');
  assert.equal(removeMcpServer(root, 'fs'), undefined);
  assert.deepEqual(
    loadMcpServers(root).servers.map((s) => s.name),
    ['keep'],
  );
});

// ---------------------------------------------------------------------------
// stdio client

test('stdio: connect performs the handshake and exposes server metadata', async (t) => {
  const client = await connected(t);
  assert.equal(client.connected, true);
  assert.deepEqual(client.serverInfo, { name: 'mock-mcp', version: '1.2.3' });
  assert.equal(client.instructions, 'Mock server instructions.');
  assert.equal(client.protocolVersion, '2025-06-18');
  assert.ok('tools' in client.capabilities);
});

test('stdio: listTools follows nextCursor across pages', async (t) => {
  const client = await connected(t);
  const tools = await client.listTools();
  assert.equal(tools.length, TOOL_COUNT);
  assert.equal(tools[0]!.name, 'echo');
  assert.equal(tools[0]!.annotations?.readOnlyHint, true);
  assert.equal(new Set(tools.map((x) => x.name)).size, TOOL_COUNT);
});

test('stdio: callTool returns results, error results and JSON-RPC errors', async (t) => {
  const client = await connected(t);
  assert.equal(text(await client.callTool('echo', { text: 'hello' })), 'hello');
  assert.equal(text(await client.callTool('add', { a: 2, b: 40 })), '42');

  const failed = await client.callTool('fail', {});
  assert.equal(failed.isError, true);
  assert.equal(text(failed), 'something went wrong');

  await assert.rejects(client.callTool('no_such_tool', {}), (err: unknown) => {
    assert.ok(err instanceof McpError);
    assert.equal(err.code, -32602);
    assert.match(err.message, /Unknown tool: no_such_tool/);
    return true;
  });
  await assert.rejects(client.request('bogus/method'), (err: unknown) => (err as McpError).code === -32601);
});

test('stdio: concurrent requests are matched to their responses', async (t) => {
  const client = await connected(t);
  const results = await Promise.all([
    client.callTool('sleep', { ms: 60 }),
    client.callTool('echo', { text: 'a' }),
    client.callTool('add', { a: 1, b: 1 }),
  ]);
  assert.deepEqual(results.map(text), ['slept', 'a', '2']);
});

test('stdio: a slow request times out and the server is told to cancel', async (t) => {
  const client = await connected(t, { requestTimeoutMs: 150 });
  const started = Date.now();
  await assert.rejects(client.callTool('sleep', { ms: 5000 }), /timed out after 150ms: tools\/call/);
  assert.ok(Date.now() - started < 2000);
  // The connection is still usable, and the server saw exactly one cancellation.
  assert.equal(text(await client.callTool('cancelled_count', {})), '1');
});

test('stdio: an AbortSignal cancels the request', async (t) => {
  const client = await connected(t);
  const controller = new AbortController();
  const pending = client.callTool('sleep', { ms: 5000 }, controller.signal);
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, (err: unknown) => (err as Error).name === 'AbortError');
  assert.equal(text(await client.callTool('cancelled_count', {})), '1');

  const already = new AbortController();
  already.abort();
  await assert.rejects(client.callTool('echo', { text: 'x' }, already.signal), { name: 'AbortError' });
});

test('stdio: server exit rejects pending requests with the stderr tail', async (t) => {
  let closedWith: Error | undefined;
  let closeCalls = 0;
  const client = await connected(t, {
    onClose: (err) => {
      closeCalls++;
      closedWith = err;
    },
  });
  await assert.rejects(client.callTool('crash', {}), (err: unknown) => {
    assert.match((err as Error).message, /exited with code 3/);
    assert.match((err as Error).message, /crashing on purpose/);
    return true;
  });
  assert.equal(client.connected, false);
  assert.equal(closeCalls, 1);
  assert.match(closedWith?.message ?? '', /exited with code 3/);
  await assert.rejects(client.callTool('echo', { text: 'x' }), /not connected.*exited with code 3/s);
});

test('stdio: answers server pings and rejects other server requests', async (t) => {
  const client = await connected(t);
  assert.equal(text(await client.callTool('ping_client', {})), 'pong received');
  assert.equal(text(await client.callTool('ask_client', {})), 'client error -32601');
});

test('stdio: prompts and resources', async (t) => {
  const client = await connected(t);
  const prompts = await client.listPrompts();
  assert.deepEqual(
    prompts.map((p) => p.name),
    ['greet'],
  );
  assert.equal(prompts[0]!.arguments?.[0]?.required, true);
  const prompt = await client.getPrompt('greet', { who: 'Ada' });
  assert.equal(prompt.messages.length, 2);

  const resources = await client.listResources();
  assert.deepEqual(
    resources.map((r) => r.uri),
    ['mock://readme'],
  );
  assert.deepEqual(await client.readResource('mock://readme'), [
    { uri: 'mock://readme', mimeType: 'text/plain', text: 'mock readme contents' },
  ]);
  await assert.rejects(client.readResource('mock://nope'), /Resource not found/);
});

test('stdio: config env reaches the server process', async (t) => {
  const client = new McpClient('mock', stdioConfig({ COCO_MOCK_VAR: 'from-config' }));
  t.after(() => client.close());
  await client.connect();
  assert.equal(text(await client.callTool('env', { name: 'COCO_MOCK_VAR' })), 'from-config');
});

test('stdio: connect fails cleanly for a missing command, an early exit and a silent server', async () => {
  const missing = new McpClient('bad', { command: 'coco-definitely-not-a-real-command' });
  await assert.rejects(missing.connect(), /Command not found: coco-definitely-not-a-real-command/);
  assert.equal(missing.connected, false);

  const dies = new McpClient('dies', {
    command: process.execPath,
    args: ['-e', 'console.error("boom at start"); process.exit(2)'],
  });
  await assert.rejects(dies.connect(), (err: unknown) => {
    assert.match((err as Error).message, /boom at start/);
    return true;
  });

  const silent = new McpClient(
    'silent',
    { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] },
    { connectTimeoutMs: 200 },
  );
  const started = Date.now();
  await assert.rejects(silent.connect(), /timed out/i);
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(silent.callTool('echo', {}), /not connected/);
});

test('stdio: close() ends the process and rejects in-flight requests', async () => {
  const client = new McpClient('mock', stdioConfig());
  await client.connect();
  const pending = client.callTool('sleep', { ms: 5000 });
  const settled = assert.rejects(pending, /Client closed/);
  await client.close();
  await settled;
  assert.equal(client.connected, false);
  await client.close(); // idempotent
});

// ---------------------------------------------------------------------------
// manager

function managerFor(t: TestContext, servers: ScopedMcpServer[], opts?: ConstructorParameters<typeof McpManager>[1]): McpManager {
  const manager = new McpManager(servers, opts);
  t.after(() => manager.close());
  return manager;
}

test('manager: names, metadata and execution of tools', async (t) => {
  const root = tempProject();
  const manager = managerFor(t, [{ name: 'my server.v1', scope: 'project', config: stdioConfig() }]);
  assert.equal(manager.status()[0]!.status, 'pending');
  await manager.connectAll();

  const [status] = manager.status();
  assert.equal(status!.status, 'connected');
  assert.equal(status!.scope, 'project');
  assert.equal(status!.toolCount, TOOL_COUNT);
  assert.equal(status!.instructions, 'Mock server instructions.');
  assert.equal(status!.error, undefined);

  const tools = manager.tools();
  assert.equal(tools.length, TOOL_COUNT);
  assert.ok(tools.every((x) => /^mcp__my_server_v1__[A-Za-z0-9_-]+$/.test(x.name)));
  assert.equal(mcpToolName('my server.v1', 'dotted.name'), 'mcp__my_server_v1__dotted_name');

  const ctx = makeContext(root);
  const echo = findTool(tools, 'mcp__my_server_v1__echo');
  assert.equal(echo.description, 'Echo the text back');
  assert.deepEqual(echo.parameters.required, ['text']);
  assert.equal(echo.isReadOnly({}), true);
  assert.deepEqual(echo.permission!({ text: 'hi' }, ctx), {
    tool: 'mcp__my_server_v1__echo',
    kind: 'mcp',
    description: 'my server.v1: echo',
  });
  assert.equal(echo.label!({ text: 'hi', n: 2 }, ctx), 'text: "hi", n: 2');
  assert.ok(echo.label!({ text: 'x'.repeat(500) }, ctx).length <= 80);
  assert.deepEqual(await echo.execute({ text: 'hi' }, ctx), { content: 'hi' });

  const add = findTool(tools, 'mcp__my_server_v1__add');
  assert.equal(add.isReadOnly({}), false);
  assert.equal((await add.execute({ a: 3, b: 4 }, ctx)).content, '7');

  // Tools without an inputSchema still get a usable object schema.
  const crash = findTool(tools, 'mcp__my_server_v1__crash');
  assert.deepEqual(crash.parameters, { type: 'object', properties: {} });

  // The sanitised name still routes to the server's original tool name.
  const dotted = findTool(tools, 'mcp__my_server_v1__dotted_name');
  assert.equal((await dotted.execute({}, ctx)).content, 'dotted ok');
});

test('manager: maps error results, images, embedded resources and structured content', async (t) => {
  const root = tempProject();
  const manager = managerFor(t, [{ name: 'm', scope: 'user', config: stdioConfig() }]);
  await manager.connectAll();
  const tools = manager.tools();
  const ctx = makeContext(root);

  const failed = await findTool(tools, 'mcp__m__fail').execute({}, ctx);
  assert.deepEqual(failed, { content: 'something went wrong', isError: true });

  const image = await findTool(tools, 'mcp__m__image').execute({}, ctx);
  assert.deepEqual(image.images, [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }]);
  assert.equal(image.content, 'here is a picture\n[image: image/png]\nembedded text');
  assert.equal(image.isError, undefined);

  const structured = await findTool(tools, 'mcp__m__structured').execute({}, ctx);
  assert.deepEqual(JSON.parse(structured.content), { ok: true, items: [1, 2] });

  const small = makeContext(root, { maxToolOutputChars: 200 });
  const big = await findTool(tools, 'mcp__m__big').execute({ size: 5000 }, small);
  assert.match(big.content, /\[4800 characters truncated\]/);
  assert.ok(big.content.length < 400);

  assert.deepEqual(toToolResult({ content: [] }, 100), { content: '(no output)' });
  assert.deepEqual(toToolResult(undefined, 100), { content: '(no output)' });
  assert.equal(
    toToolResult({ content: [{ type: 'resource_link', uri: 'file:///a', name: 'a' }, { type: 'audio', mimeType: 'audio/wav' }] }, 100).content,
    '[resource: a file:///a]\n[audio: audio/wav]',
  );
});

test('manager: timeouts and cancellation become error results, not exceptions', async (t) => {
  const root = tempProject();
  const manager = managerFor(t, [{ name: 'm', scope: 'user', config: stdioConfig() }], { requestTimeoutMs: 150 });
  await manager.connectAll();
  const sleep = findTool(manager.tools(), 'mcp__m__sleep');

  const timedOut = await sleep.execute({ ms: 5000 }, makeContext(root));
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content, /MCP tool m\/sleep failed: Request timed out/);

  const controller = new AbortController();
  const ctx = { ...makeContext(root), signal: controller.signal };
  const pending = sleep.execute({ ms: 5000 }, ctx);
  setTimeout(() => controller.abort(), 30);
  const cancelled = await pending;
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.content, /cancelled/);
});

test('manager: a server that fails to start is reported without affecting the others', async (t) => {
  const manager = managerFor(t, [
    { name: 'bad', scope: 'local', config: { command: 'coco-definitely-not-a-real-command' } },
    { name: 'good', scope: 'user', config: stdioConfig() },
    { name: 'down', scope: 'project', config: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
  ]);
  await manager.connectAll(); // must not throw

  const status = Object.fromEntries(manager.status().map((s) => [s.name, s]));
  assert.equal(status.bad!.status, 'failed');
  assert.match(status.bad!.error ?? '', /Command not found/);
  assert.equal(status.bad!.toolCount, 0);
  assert.equal(status.down!.status, 'failed');
  assert.match(status.down!.error ?? '', /Could not reach http:\/\/127\.0\.0\.1:1\/mcp/);
  assert.equal(status.good!.status, 'connected');
  assert.equal(status.good!.toolCount, TOOL_COUNT);

  const tools = manager.tools();
  assert.equal(tools.length, TOOL_COUNT);
  assert.ok(tools.every((x) => x.name.startsWith('mcp__good__')));
  await assert.rejects(manager.getPrompt('bad', 'greet', {}), /"bad" is not connected: Command not found/);
  await assert.rejects(manager.readResource('nope', 'x'), /Unknown MCP server "nope"/);
});

test('manager: prompts and resources', async (t) => {
  const manager = managerFor(t, [{ name: 'good', scope: 'user', config: stdioConfig() }]);
  await manager.connectAll();
  assert.deepEqual(manager.prompts(), [
    {
      server: 'good',
      name: 'greet',
      description: 'Greet someone',
      arguments: [{ name: 'who', description: 'Name to greet', required: true }],
    },
  ]);
  assert.equal(await manager.getPrompt('good', 'greet', { who: 'Ada' }), 'Say hello to Ada.\n\nBe brief.');
  assert.deepEqual(await manager.listResources(), [
    { server: 'good', uri: 'mock://readme', name: 'readme', description: 'A readme', mimeType: 'text/plain' },
  ]);
  assert.equal(await manager.readResource('good', 'mock://readme'), 'mock readme contents');
});

test('manager: recovers from a crashed server and supports reconnect()', async (t) => {
  const root = tempProject();
  const manager = managerFor(t, [{ name: 'm', scope: 'user', config: stdioConfig() }]);
  await manager.connectAll();
  const ctx = makeContext(root);
  const tools = manager.tools();

  const crashed = await findTool(tools, 'mcp__m__crash').execute({}, ctx);
  assert.equal(crashed.isError, true);
  assert.match(crashed.content, /exited with code 3/);
  assert.equal(manager.status()[0]!.status, 'failed');
  assert.match(manager.status()[0]!.error ?? '', /exited with code 3/);
  assert.deepEqual(manager.tools(), []);

  // The next call restarts the server transparently.
  const echoed = await findTool(tools, 'mcp__m__echo').execute({ text: 'back' }, ctx);
  assert.deepEqual(echoed, { content: 'back' });
  assert.equal(manager.status()[0]!.status, 'connected');
  assert.equal(manager.status()[0]!.error, undefined);

  await manager.reconnect('m');
  assert.equal(manager.status()[0]!.status, 'connected');
  assert.equal(manager.tools().length, TOOL_COUNT);
  await assert.rejects(manager.reconnect('missing'), /Unknown MCP server/);

  await manager.close();
  const afterClose = await findTool(tools, 'mcp__m__echo').execute({ text: 'x' }, ctx);
  assert.equal(afterClose.isError, undefined, 'a closed manager reconnects on demand');
});

// ---------------------------------------------------------------------------
// HTTP transports

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
  result?: unknown;
  error?: unknown;
}

function answer(msg: Rpc): Rpc | undefined {
  if (msg.id === undefined || msg.method === undefined) return undefined;
  const ok = (result: unknown): Rpc => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'http-mock', version: '9' },
      });
    case 'tools/list':
      return ok({ tools: [{ name: 'echo', description: 'Echo over HTTP', inputSchema: { type: 'object' } }] });
    case 'tools/call':
      return ok({ content: [{ type: 'text', text: `http:${String(msg.params?.arguments?.text)}` }] });
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => resolve(body));
  });
}

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body?: Rpc;
}

async function startServer(
  t: TestContext,
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string, log: Recorded[]) => void,
): Promise<{ base: string; log: Recorded[] }> {
  const log: Recorded[] = [];
  const server = http.createServer((req, res) => {
    void readBody(req).then((body) => {
      let parsed: Rpc | undefined;
      try {
        parsed = body ? (JSON.parse(body) as Rpc) : undefined;
      } catch {
        parsed = undefined;
      }
      log.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: parsed });
      handler(req, res, body, log);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, log };
}

/** A Streamable HTTP endpoint that replies with either a JSON body or an SSE stream. */
function streamable(mode: 'json' | 'sse') {
  const SESSION = 'sess-123';
  return (req: http.IncomingMessage, res: http.ServerResponse, body: string) => {
    if (req.url === '/broken') {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('boom');
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const msg = JSON.parse(body) as Rpc;
    const headers: Record<string, string> = {};
    if (msg.method === 'initialize') {
      headers['Mcp-Session-Id'] = SESSION;
    } else if (req.headers['mcp-session-id'] !== SESSION) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('missing session id');
      return;
    }
    const reply = answer(msg);
    if (!reply) {
      res.writeHead(202, headers).end();
      return;
    }
    if (mode === 'json') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
    res.write(': keep-alive comment\n\n');
    if (msg.method === 'tools/call') {
      // A server-initiated request delivered on the same stream, split across chunks.
      const ping = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' })}\n\n`;
      res.write(ping.slice(0, 20));
      res.write(ping.slice(20));
    }
    res.end(`event: message\r\ndata: ${JSON.stringify(reply)}\r\n\r\n`);
  };
}

for (const mode of ['json', 'sse'] as const) {
  test(`http: streamable transport with ${mode} responses, session id and protocol header`, async (t) => {
    const { base, log } = await startServer(t, streamable(mode));
    const client = new McpClient('remote', { type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer abc' } });
    t.after(() => client.close());
    await client.connect();
    assert.deepEqual(client.serverInfo, { name: 'http-mock', version: '9' });

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((x) => x.name),
      ['echo'],
    );
    assert.equal(text(await client.callTool('echo', { text: 'hi' })), 'http:hi');
    assert.deepEqual(await client.listPrompts(), [], 'no prompts capability means no request');

    const init = log.find((r) => r.body?.method === 'initialize')!;
    assert.equal(init.headers['mcp-session-id'], undefined);
    assert.equal(init.headers['mcp-protocol-version'], undefined);
    assert.equal(init.headers.authorization, 'Bearer abc');
    assert.match(String(init.headers.accept), /application\/json/);
    assert.match(String(init.headers.accept), /text\/event-stream/);

    const later = log.filter((r) => r.method === 'POST' && r.body?.method !== 'initialize');
    assert.ok(later.length >= 3);
    for (const r of later) {
      assert.equal(r.headers['mcp-session-id'], 'sess-123');
      assert.equal(r.headers['mcp-protocol-version'], '2025-06-18');
    }
    assert.ok(log.some((r) => r.body?.method === 'notifications/initialized'));

    if (mode === 'sse') {
      // Give the ping reply a moment to be posted back.
      for (let i = 0; i < 50 && !log.some((r) => r.body?.id === 'srv-ping'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pong = log.find((r) => r.body?.id === 'srv-ping');
      assert.deepEqual(pong?.body?.result, {});
    }

    await client.close();
    assert.ok(log.some((r) => r.method === 'DELETE' && r.headers['mcp-session-id'] === 'sess-123'));
  });
}

test('http: HTTP errors and unreachable servers reject with a useful message', async (t) => {
  const { base } = await startServer(t, streamable('json'));
  const broken = new McpClient('broken', { type: 'http', url: `${base}/broken` });
  await assert.rejects(broken.connect(), /HTTP 500 Internal Server Error: boom/);
  assert.equal(broken.connected, false);

  const down = new McpClient('down', { type: 'http', url: 'http://127.0.0.1:1/mcp' });
  await assert.rejects(down.connect(), /Could not reach http:\/\/127\.0\.0\.1:1\/mcp/);
});

test('http: a stream that ends without a result fails the waiting request', async (t) => {
  const { base } = await startServer(t, (req, res, body) => {
    const msg = JSON.parse(body) as Rpc;
    if (msg.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(': nothing useful\n\n');
      return;
    }
    const reply = answer(msg);
    if (!reply) res.writeHead(202).end();
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  });
  const client = new McpClient('remote', { type: 'http', url: `${base}/mcp` });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.callTool('echo', { text: 'x' }), /stream ended before a result/);
});

test('http: manager exposes tools from a remote server', async (t) => {
  const root = tempProject();
  const { base } = await startServer(t, streamable('sse'));
  const manager = managerFor(t, [{ name: 'remote', scope: 'project', config: { type: 'http', url: `${base}/mcp` } }]);
  await manager.connectAll();
  assert.equal(manager.status()[0]!.status, 'connected');
  const echo = findTool(manager.tools(), 'mcp__remote__echo');
  assert.deepEqual(await echo.execute({ text: 'yo' }, makeContext(root)), { content: 'http:yo' });
});

test('sse: legacy transport waits for the endpoint event and reads replies from the stream', async (t) => {
  let stream: http.ServerResponse | undefined;
  const { base, log } = await startServer(t, (req, res, body) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages?sessionId=abc\n\n');
      stream = res;
      return;
    }
    if (req.method === 'POST' && req.url === '/messages?sessionId=abc') {
      res.writeHead(202, { 'Content-Type': 'text/plain' }).end('Accepted');
      const reply = answer(JSON.parse(body) as Rpc);
      if (reply) stream?.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });

  let closed = 0;
  const client = new McpClient('legacy', { type: 'sse', url: `${base}/sse`, headers: { 'X-Key': 'k' } }, { onClose: () => closed++ });
  t.after(() => client.close());
  await client.connect();
  assert.deepEqual(client.serverInfo, { name: 'http-mock', version: '9' });
  assert.equal(text(await client.callTool('echo', { text: 'old' })), 'http:old');
  assert.equal(log.find((r) => r.method === 'GET')!.headers['x-key'], 'k');
  assert.match(String(log.find((r) => r.method === 'GET')!.headers.accept), /text\/event-stream/);

  // The server dropping the stream is a lost connection.
  stream?.end();
  for (let i = 0; i < 100 && client.connected; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.connected, false);
  assert.equal(closed, 1);
  await assert.rejects(client.callTool('echo', { text: 'x' }), /not connected/);
});

test('sse: connect fails when the stream never announces an endpoint', async (t) => {
  const { base } = await startServer(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': waiting\n\n');
  });
  const client = new McpClient('legacy', { type: 'sse', url: `${base}/sse` }, { connectTimeoutMs: 200 });
  await assert.rejects(client.connect(), /Timed out starting the server/);
});

// ---------------------------------------------------------------------------
// SSE parsing

test('parseSse handles split chunks, CRLF, comments, multi-line data and a missing final blank line', async () => {
  const encoder = new TextEncoder();
  const chunks = ['event: a\nda', 'ta: one\ndata: two\n\n', ': comment\r\n', 'data:no-space\r', '\n\r\n', 'id: 7\ndata: last'];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseSse(body)) events.push(event);
  assert.deepEqual(events, [
    { event: 'a', data: 'one\ntwo', id: undefined },
    { event: '', data: 'no-space', id: undefined },
    { event: '', data: 'last', id: '7' },
  ]);
});
