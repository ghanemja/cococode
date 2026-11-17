import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { McpClient, McpError, parseSse } from '../src/mcp/client.ts';
import {
  addMcpServer,
  addMcpServerJson,
  loadMcpServers,
  mcpConfigPath,
  normalizeMcpConfig,
  removeMcpServer,
  type McpServerConfig,
  type ScopedMcpServer,
} from '../src/mcp/config.ts';
import {
  DEFAULT_MAX_MCP_DESCRIPTION,
  FIRST_CONNECT_RETRIES,
  MAX_RECONNECT_ATTEMPTS,
  McpManager,
  capDescription,
  mcpToolName,
  reconnectDelayMs,
  toToolResult,
} from '../src/mcp/manager.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeContext, tempProject, writeFiles } from './helpers.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'mock-mcp-server.mjs');
const TOOL_COUNT = 14;

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

test('config: a per-server timeout is kept in milliseconds, and values under 1000 are ignored', () => {
  assert.deepEqual(normalizeMcpConfig({ command: 'x', timeout: 5000 }).config, { type: 'stdio', command: 'x', timeout: 5000 });
  assert.deepEqual(normalizeMcpConfig({ type: 'http', url: 'http://h/mcp', timeout: '120000' }).config, {
    type: 'http',
    url: 'http://h/mcp',
    timeout: 120000,
  });
  assert.deepEqual(normalizeMcpConfig({ type: 'sse', url: 'http://h/sse', timeout: 1000.9 }).config, { type: 'sse', url: 'http://h/sse', timeout: 1000 });
  for (const timeout of [999, 30, 0, -5000, 'soon', '', null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(normalizeMcpConfig({ command: 'x', timeout }).config, { type: 'stdio', command: 'x' }, `timeout ${String(timeout)}`);
    assert.deepEqual(normalizeMcpConfig({ url: 'http://h/mcp', timeout }).config, { type: 'http', url: 'http://h/mcp' }, `timeout ${String(timeout)}`);
  }

  const root = tempProject();
  writeFiles(root, { '.mcp.json': JSON.stringify({ mcpServers: { slow: { command: 'x', timeout: 90000 }, typo: { command: 'y', timeout: 90 } } }) });
  const { servers, errors } = loadMcpServers(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    servers.map((s) => s.config.timeout),
    [90000, undefined],
  );
});

test('config: addMcpServerJson validates a JSON definition and writes it as given', () => {
  const root = tempProject();
  const definition = {
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer ${COCO_MCP_TEST_SECRET}' },
    timeout: 120000,
  };
  const added = addMcpServerJson('project', root, 'remote', JSON.stringify(definition));
  assert.deepEqual(added, { file: path.join(root, '.mcp.json') });
  // The reference is stored, not the secret it stands for.
  assert.deepEqual(JSON.parse(fs.readFileSync(added.file!, 'utf8')), { mcpServers: { remote: definition } });

  process.env.COCO_MCP_TEST_SECRET = 's3cret';
  const loaded = loadMcpServers(root);
  delete process.env.COCO_MCP_TEST_SECRET;
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.servers, [
    {
      name: 'remote',
      scope: 'project',
      config: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer s3cret' }, timeout: 120000 },
    },
  ]);

  // Other scopes, a second server in the same file, and replacing a definition.
  assert.deepEqual(addMcpServerJson('local', root, ' files ', '{"command":"npx","args":["-y","server-fs"],"env":{"A":"1"}}'), {
    file: path.join(root, '.coco', 'mcp.local.json'),
  });
  assert.deepEqual(addMcpServerJson('user', root, 'files', '{"command":"user-fs"}'), { file: path.join(root, '.coco-home', 'mcp.json') });
  assert.equal(addMcpServerJson('project', root, 'second', '{"url":"http://localhost:8123/mcp"}').error, undefined);
  assert.equal(addMcpServerJson('project', root, 'remote', '{"type":"sse","url":"https://example.com/sse"}').error, undefined);
  const after = Object.fromEntries(loadMcpServers(root).servers.map((s) => [s.name, s]));
  assert.deepEqual(after.remote!.config, { type: 'sse', url: 'https://example.com/sse' });
  assert.deepEqual(after.second!.config, { type: 'http', url: 'http://localhost:8123/mcp' });
  assert.equal(after.files!.scope, 'local');
  assert.deepEqual(after.files!.config, { type: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { A: '1' } });
});

test('config: addMcpServerJson reports invalid JSON and invalid servers without throwing or writing', () => {
  const root = tempProject();
  const file = path.join(root, '.mcp.json');

  const notJson = addMcpServerJson('project', root, 'x', '{not json');
  assert.equal(notJson.file, undefined);
  assert.match(notJson.error ?? '', /^Invalid JSON: /);
  assert.match(addMcpServerJson('project', root, 'x', '').error ?? '', /^Invalid JSON: /);

  const shapes: [string, RegExp][] = [
    ['"just a string"', /must be an object/],
    ['[{"command":"x"}]', /must be an object/],
    ['null', /must be an object/],
    ['{}', /needs either a "command" or a "url"/],
    ['{"args":["x"]}', /needs either a "command" or a "url"/],
    ['{"type":"websocket","url":"ws://x"}', /unknown type "websocket"/],
    ['{"type":"http"}', /requires a "url"/],
    ['{"type":"http","url":"not a url"}', /invalid url/],
    ['{"command":"x","args":"oops"}', /"args" must be an array/],
  ];
  for (const [json, why] of shapes) {
    const res = addMcpServerJson('project', root, 'x', json);
    assert.equal(res.file, undefined, json);
    assert.match(res.error ?? '', /^Invalid MCP server definition: /, json);
    assert.match(res.error ?? '', why, json);
  }
  assert.match(addMcpServerJson('project', root, '   ', '{"command":"x"}').error ?? '', /server name is required/);
  assert.match(addMcpServerJson('global' as 'user', root, 'x', '{"command":"x"}').error ?? '', /Unknown scope "global"/);
  assert.equal(fs.existsSync(file), false, 'nothing was written');

  // A file that cannot be written is an error result too.
  fs.mkdirSync(file);
  const unwritable = addMcpServerJson('project', root, 'x', '{"command":"x"}');
  assert.equal(unwritable.file, undefined);
  assert.match(unwritable.error ?? '', /^Could not write .*\.mcp\.json: /);
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
  // Without roots to offer, the capability is not advertised and roots/list is refused like any other request.
  assert.deepEqual(JSON.parse(text(await client.callTool('list_roots', {}))), { advertised: false, error: -32601 });
});

test('stdio: roots are advertised and returned as file:// URIs', async (t) => {
  const root = tempProject();
  const client = await connected(t, { roots: [root, ''] });
  assert.deepEqual(JSON.parse(text(await client.callTool('list_roots', {}))), {
    advertised: true,
    roots: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
  });
  // Having roots does not make the client answer requests it does not implement.
  assert.equal(text(await client.callTool('ask_client', {})), 'client error -32601');
});

test('timeouts: tool calls use option > MCP_TOOL_TIMEOUT > per-server timeout > transport default', (t) => {
  const saved = process.env.MCP_TOOL_TIMEOUT;
  t.after(() => {
    if (saved === undefined) delete process.env.MCP_TOOL_TIMEOUT;
    else process.env.MCP_TOOL_TIMEOUT = saved;
  });
  delete process.env.MCP_TOOL_TIMEOUT;

  const stdio: McpServerConfig = { command: 'x' };
  const http: McpServerConfig = { type: 'http', url: 'http://127.0.0.1:1/mcp' };
  const sse: McpServerConfig = { type: 'sse', url: 'http://127.0.0.1:1/sse' };
  const toolTimeout = (config: McpServerConfig, opts?: ConstructorParameters<typeof McpClient>[2]) => new McpClient('s', config, opts).toolTimeoutMs;

  // Transport defaults: 30 minutes for a local server, 5 for a remote one.
  assert.equal(toolTimeout(stdio), 1_800_000);
  assert.equal(toolTimeout(http), 300_000);
  assert.equal(toolTimeout(sse), 300_000);

  // The server's own timeout replaces the default, unless it is under a second.
  assert.equal(toolTimeout({ ...stdio, timeout: 45_000 }), 45_000);
  assert.equal(toolTimeout({ ...http, timeout: 1000 }), 1000);
  assert.equal(toolTimeout({ ...http, timeout: 999 }), 300_000);
  assert.equal(toolTimeout({ ...stdio, timeout: 60 }), 1_800_000);

  // MCP_TOOL_TIMEOUT beats the server's timeout.
  process.env.MCP_TOOL_TIMEOUT = '70000';
  assert.equal(toolTimeout({ ...stdio, timeout: 45_000 }), 70_000);
  assert.equal(toolTimeout(http), 70_000);

  // The option beats everything.
  assert.equal(toolTimeout({ ...stdio, timeout: 45_000 }, { requestTimeoutMs: 1234 }), 1234);
  assert.equal(toolTimeout(sse, { requestTimeoutMs: 1234 }), 1234);

  // An unusable environment value is as good as none.
  process.env.MCP_TOOL_TIMEOUT = 'soon';
  assert.equal(toolTimeout({ ...stdio, timeout: 45_000 }), 45_000);
  process.env.MCP_TOOL_TIMEOUT = '0';
  assert.equal(toolTimeout(http), 300_000);
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
  assert.match(timedOut.content, /MCP tool m\/sleep failed: Request timed out after 150ms: tools\/call\./);
  // The model is told not to send the identical call again.
  assert.match(timedOut.content, /Do not repeat the same call unchanged/);

  const controller = new AbortController();
  const ctx = { ...makeContext(root), signal: controller.signal };
  const pending = sleep.execute({ ms: 5000 }, ctx);
  setTimeout(() => controller.abort(), 30);
  const cancelled = await pending;
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.content, /cancelled/);
  assert.doesNotMatch(cancelled.content, /Do not repeat/);
  // Neither a timeout nor a cancellation costs the connection.
  assert.equal(manager.status()[0]!.status, 'connected');
});

test('manager: a server that fails to start is reported without affecting the others', async (t) => {
  const manager = managerFor(
    t,
    [
      { name: 'bad', scope: 'local', config: { command: 'coco-definitely-not-a-real-command' } },
      { name: 'good', scope: 'user', config: stdioConfig() },
      { name: 'down', scope: 'project', config: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
    ],
    { sleep: async () => {} }, // the unreachable remote server is retried; do not wait between attempts
  );
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
  assert.match(crashed.content, /connection to this server was lost; the next call to it reconnects first/);
  assert.equal(manager.status()[0]!.status, 'failed');
  assert.match(manager.status()[0]!.error ?? '', /exited with code 3/);
  assert.equal(manager.status()[0]!.toolCount, 0);
  // The tools stay on offer: the agent asks for the tool list on every request, and the
  // model can only bring the server back by calling one of them.
  assert.deepEqual(
    manager.tools().map((x) => x.name),
    tools.map((x) => x.name),
  );

  // The next call restarts the server transparently.
  const echoed = await findTool(manager.tools(), 'mcp__m__echo').execute({ text: 'back' }, ctx);
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

test('http: an unknown session or an unreachable server ends the connection; other errors do not', async (t) => {
  let mode: 'ok' | 'gone' | 'bad-session' | 'bad-request' | 'error' = 'ok';
  const { base } = await startServer(t, (_req, res, body) => {
    const msg = JSON.parse(body) as Rpc;
    if (msg.method === 'tools/call' && mode !== 'ok') {
      if (mode === 'gone') res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such session');
      else if (mode === 'bad-session') res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"Bad Request: No valid session ID provided"}}');
      else if (mode === 'bad-request') res.writeHead(400, { 'Content-Type': 'text/plain' }).end('malformed arguments');
      else res.writeHead(500, { 'Content-Type': 'text/plain' }).end('boom');
      return;
    }
    const reply = answer(msg);
    if (!reply) res.writeHead(202).end();
    else res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' }).end(JSON.stringify(reply));
  });
  const open = async () => {
    let closes = 0;
    const client = new McpClient('remote', { type: 'http', url: `${base}/mcp` }, { onClose: () => closes++ });
    t.after(() => client.close());
    mode = 'ok';
    await client.connect();
    return { client, closes: () => closes };
  };

  // Errors that say nothing about the session leave the connection alone.
  const healthy = await open();
  mode = 'error';
  await assert.rejects(healthy.client.callTool('echo', { text: 'x' }), /HTTP 500 Internal Server Error: boom/);
  mode = 'bad-request';
  await assert.rejects(healthy.client.callTool('echo', { text: 'x' }), /HTTP 400 Bad Request: malformed arguments/);
  assert.equal(healthy.client.connected, true);
  assert.equal(healthy.closes(), 0);

  // 404 for the session the server issued: it is gone, and so is the connection.
  mode = 'gone';
  await assert.rejects(healthy.client.callTool('echo', { text: 'x' }), /HTTP 404 Not Found: no such session/);
  assert.equal(healthy.client.connected, false);
  assert.equal(healthy.closes(), 1);
  await assert.rejects(healthy.client.callTool('echo', { text: 'x' }), /not connected: HTTP 404/);

  // Some servers report a stale session as 400.
  const stale = await open();
  mode = 'bad-session';
  await assert.rejects(stale.client.callTool('echo', { text: 'x' }), /HTTP 400 Bad Request: .*No valid session ID/);
  assert.equal(stale.client.connected, false);
  assert.equal(stale.closes(), 1);
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
// roots, limits and switching servers on and off

test('manager: the project directory is offered to servers through roots/list', async (t) => {
  const root = tempProject();
  const manager = managerFor(t, [{ name: 'm', scope: 'user', config: stdioConfig() }], { cwd: root });
  await manager.connectAll();
  const tools = manager.tools();
  const ctx = makeContext(root);

  const roots = await findTool(tools, 'mcp__m__list_roots').execute({}, ctx);
  assert.equal(roots.isError, undefined);
  assert.deepEqual(JSON.parse(roots.content), {
    advertised: true,
    roots: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
  });
  assert.match(pathToFileURL(root).href, /^file:\/\/\//);
  // Other server-initiated requests are answered as before.
  assert.equal((await findTool(tools, 'mcp__m__ping_client').execute({}, ctx)).content, 'pong received');
  assert.equal((await findTool(tools, 'mcp__m__ask_client').execute({}, ctx)).content, 'client error -32601');
});

test('manager: tool descriptions are capped at 4096 characters with the first line intact', async (t) => {
  const ellipsis = String.fromCodePoint(0x2026);
  assert.equal(DEFAULT_MAX_MCP_DESCRIPTION, 4096);
  assert.equal(capDescription('Short and sweet'), 'Short and sweet');
  assert.equal(capDescription('x'.repeat(4096)).length, 4096);

  const long = `What it does.\n${'detail '.repeat(1000)}`;
  const capped = capDescription(long);
  assert.equal(capped.length, 4096);
  assert.ok(capped.startsWith('What it does.\ndetail detail'));
  assert.ok(capped.endsWith(ellipsis));

  // A first line longer than the cap is kept whole; only what follows it is dropped.
  const longFirstLine = 'A'.repeat(5000);
  assert.equal(capDescription(`${longFirstLine}\nsecond line`), `${longFirstLine}${ellipsis}`);
  assert.equal(capDescription(longFirstLine), longFirstLine);
  assert.equal(capDescription('One line here.\nMore detail that goes on', 20), `One line here.\nMore${ellipsis}`);
  assert.equal(capDescription('A first line that is long\nand the rest', 10), `A first line that is long${ellipsis}`);

  // End to end: a server with a wordy tool.
  const wordy = `Summarise a document.\n${'More guidance. '.repeat(700)}`;
  assert.ok(wordy.length > 9000);
  const { base } = await startServer(t, (_req, res, body) => {
    const msg = JSON.parse(body) as Rpc;
    const reply =
      msg.method === 'tools/list'
        ? { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'wordy', description: wordy }, { name: 'terse', description: 'Terse.' }] } }
        : answer(msg);
    if (!reply) res.writeHead(202).end();
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  });
  const manager = managerFor(t, [{ name: 'remote', scope: 'user', config: { type: 'http', url: `${base}/mcp` } }]);
  await manager.connectAll();
  const description = findTool(manager.tools(), 'mcp__remote__wordy').description;
  assert.equal(description.length, 4096);
  assert.ok(description.startsWith('Summarise a document.\nMore guidance. '));
  assert.equal(findTool(manager.tools(), 'mcp__remote__terse').description, 'Terse.');

  // CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH lowers (or raises) the cap.
  const saved = process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH;
    else process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = saved;
  });
  process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = '100';
  assert.equal(findTool(manager.tools(), 'mcp__remote__wordy').description.length, 100);
  process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = '10';
  assert.equal(findTool(manager.tools(), 'mcp__remote__wordy').description, `Summarise a document.${ellipsis}`);
  process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = 'plenty';
  assert.equal(findTool(manager.tools(), 'mcp__remote__wordy').description.length, 4096);
});

test("timeouts: a server's own timeout applies to its tool calls, not to other requests", async (t) => {
  const root = tempProject();
  const SLOW_MS = 1400;
  const { base } = await startServer(t, (_req, res, body) => {
    const msg = JSON.parse(body) as Rpc;
    const send = (reply: Rpc | undefined) => {
      if (res.destroyed) return;
      if (!reply) res.writeHead(202).end();
      else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
    };
    if (msg.method === 'tools/call') setTimeout(() => send(answer(msg)), SLOW_MS);
    else if (msg.method === 'prompts/get') {
      setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: { messages: [{ role: 'user', content: { type: 'text', text: 'slow prompt' } }] } }), SLOW_MS);
    } else send(answer(msg));
  });
  const saved = process.env.MCP_TOOL_TIMEOUT;
  t.after(() => {
    if (saved !== undefined) process.env.MCP_TOOL_TIMEOUT = saved;
  });
  delete process.env.MCP_TOOL_TIMEOUT;

  // The config goes through the normaliser, as it would from .mcp.json.
  const { config } = normalizeMcpConfig({ type: 'http', url: `${base}/mcp`, timeout: 1000 });
  const manager = managerFor(t, [{ name: 'slow', scope: 'project', config: config! }]);
  await manager.connectAll();
  assert.equal(manager.status()[0]!.status, 'connected');

  const started = Date.now();
  const [called, prompt] = await Promise.all([
    findTool(manager.tools(), 'mcp__slow__echo').execute({ text: 'x' }, makeContext(root)),
    manager.getPrompt('slow', 'anything', {}),
  ]);
  assert.equal(called.isError, true);
  assert.match(called.content, /MCP tool slow\/echo failed: Request timed out after 1s: tools\/call\./);
  assert.match(called.content, /Do not repeat the same call unchanged/);
  // prompts/get took longer than the server's tool timeout and still succeeded.
  assert.equal(prompt, 'slow prompt');
  assert.ok(Date.now() - started >= SLOW_MS - 50);
  assert.equal(manager.status()[0]!.status, 'connected');
});

test('manager: setEnabled switches servers off and on at runtime', async (t) => {
  const root = tempProject();
  const ctx = makeContext(root);
  const manager = managerFor(
    t,
    [
      { name: 'a', scope: 'user', config: stdioConfig() },
      { name: 'b', scope: 'project', config: stdioConfig() },
      { name: 'c', scope: 'local', config: stdioConfig() },
    ],
    { disabled: ['c'] },
  );
  const state = () => Object.fromEntries(manager.status().map((s) => [s.name, s]));
  const prefixes = () => [...new Set(manager.tools().map((x) => x.name.split('__')[1]))].sort();

  assert.equal(state().c!.status, 'disabled');
  await manager.connectAll();
  assert.deepEqual(
    manager.status().map((s) => s.status),
    ['connected', 'connected', 'disabled'],
  );
  assert.equal(state().c!.toolCount, 0);
  assert.deepEqual(prefixes(), ['a', 'b']);
  const held = findTool(manager.tools(), 'mcp__a__echo');

  await manager.setEnabled('a', false);
  assert.deepEqual(state().a, { name: 'a', scope: 'user', config: stdioConfig(), status: 'disabled', toolCount: 0 });
  assert.deepEqual(prefixes(), ['b']);
  assert.deepEqual(
    manager.prompts().map((p) => p.server),
    ['b'],
  );
  assert.deepEqual(manager.resourceServers(), ['b']);

  // A tool object from before neither runs nor restarts the server.
  const refused = await held.execute({ text: 'x' }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.content, /MCP server "a" is disabled/);
  assert.equal(state().a!.status, 'disabled');
  await assert.rejects(manager.getPrompt('a', 'greet', {}), /MCP server "a" is disabled/);
  await assert.rejects(manager.readResource('a', 'mock://readme'), /MCP server "a" is disabled/);
  await assert.rejects(manager.reconnect('a'), /MCP server "a" is disabled/);
  await manager.connectAll();
  assert.equal(state().a!.status, 'disabled', 'connectAll leaves a disabled server alone');
  await manager.setEnabled('a', false); // already off

  await manager.setEnabled('a', true);
  assert.equal(state().a!.status, 'connected');
  assert.equal(state().a!.toolCount, TOOL_COUNT);
  assert.equal(state().a!.instructions, 'Mock server instructions.');
  assert.deepEqual(prefixes(), ['a', 'b']);
  assert.deepEqual(await held.execute({ text: 'again' }, ctx), { content: 'again' });

  // A server that started disabled can be switched on later.
  await manager.setEnabled('c', true);
  assert.equal(state().c!.status, 'connected');
  assert.deepEqual(prefixes(), ['a', 'b', 'c']);
  await manager.setEnabled('c', true); // already on
  assert.equal(state().c!.status, 'connected');

  await assert.rejects(manager.setEnabled('nope', true), /Unknown MCP server "nope"/);
  await assert.rejects(manager.setEnabled('nope', false), /Unknown MCP server "nope"/);
});

test('manager: disabling or closing while a server is still connecting leaves nothing behind', async (t) => {
  const manager = managerFor(t, [
    { name: 'a', scope: 'user', config: stdioConfig() },
    { name: 'b', scope: 'user', config: stdioConfig() },
  ]);
  const connecting = manager.connectAll();
  await manager.setEnabled('a', false);
  await connecting;
  assert.deepEqual(
    manager.status().map((s) => s.status),
    ['disabled', 'connected'],
  );
  assert.ok(manager.tools().every((x) => x.name.startsWith('mcp__b__')));

  // Enabling fails cleanly for a server that cannot start, and it stays enabled (failed), not disabled.
  const broken = managerFor(t, [{ name: 'bad', scope: 'user', config: { command: 'coco-definitely-not-a-real-command' } }], { disabled: ['bad'] });
  await broken.connectAll();
  assert.equal(broken.status()[0]!.status, 'disabled');
  await broken.setEnabled('bad', true);
  assert.equal(broken.status()[0]!.status, 'failed');
  assert.match(broken.status()[0]!.error ?? '', /Command not found/);

  // close() during the retries of an unreachable remote server stops them instead of waiting them out.
  const remote = managerFor(t, [{ name: 'down', scope: 'user', config: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }]);
  const started = Date.now();
  const pending = remote.connectAll();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await remote.close();
  await pending;
  assert.ok(Date.now() - started < 1500, `stopped after ${Date.now() - started}ms`);
});

// ---------------------------------------------------------------------------
// reconnection

interface Flaky {
  base: string;
  /** How many of the next initialize requests are refused. */
  failInits: number;
  /** HTTP status used to refuse them. */
  refuseWith: number;
  /** When set, every tools/call ends the session instead of answering. */
  dropCalls: boolean;
  /** initialize requests seen so far. */
  inits: number;
  /** Forget the current session, as a restarted server would. */
  restart(): void;
  /** Stop listening altogether. */
  stop(): Promise<void>;
}

/** A Streamable HTTP server that can refuse handshakes, forget its session, or go away. */
async function flakyServer(t: TestContext): Promise<Flaky> {
  let session: string | undefined;
  let sessions = 0;
  const server = http.createServer((req, res) => {
    void readBody(req).then((body) => {
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
        state.inits++;
        if (state.failInits > 0) {
          state.failInits--;
          res.writeHead(state.refuseWith, { 'Content-Type': 'text/plain' }).end('not now');
          return;
        }
        session = `sess-${++sessions}`;
        headers['Mcp-Session-Id'] = session;
      } else {
        if (msg.method === 'tools/call' && state.dropCalls) session = undefined;
        if (req.headers['mcp-session-id'] !== session) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('session not found');
          return;
        }
      }
      const reply = answer(msg);
      if (!reply) res.writeHead(202, headers).end();
      else res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let stopped = false;
  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    stopped = true;
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  };
  t.after(stop);
  const state: Flaky = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    failInits: 0,
    refuseWith: 503,
    dropCalls: false,
    inits: 0,
    restart: () => {
      session = undefined;
    },
    stop,
  };
  return state;
}

/** A manager for one remote server whose backoff waits are recorded instead of waited out. */
function remoteManager(t: TestContext, url: string, type: 'http' | 'sse' = 'http'): { manager: McpManager; delays: number[] } {
  const delays: number[] = [];
  const manager = managerFor(t, [{ name: 'remote', scope: 'user', config: { type, url } }], {
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { manager, delays };
}

test('reconnect: the wait doubles from one second and is capped at 30 seconds', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 50, 5000].map(reconnectDelayMs),
    [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000],
  );
  assert.equal(reconnectDelayMs(0), 0);
  assert.equal(reconnectDelayMs(-3), 0);
  assert.equal(MAX_RECONNECT_ATTEMPTS, 5);
  assert.equal(FIRST_CONNECT_RETRIES, 3);
});

test('http: the first connection is retried up to 3 times with a short backoff', async (t) => {
  const server = await flakyServer(t);

  // Two refusals, then the server is up.
  server.failInits = 2;
  const recovering = remoteManager(t, `${server.base}/mcp`);
  await recovering.manager.connectAll();
  assert.equal(recovering.manager.status()[0]!.status, 'connected');
  assert.equal(recovering.manager.status()[0]!.error, undefined);
  assert.equal(server.inits, 3);
  assert.deepEqual(recovering.delays, [500, 1000]);

  // A server that stays down: the first attempt and three retries, then it is reported as failed.
  server.inits = 0;
  server.failInits = 99;
  const stubborn = remoteManager(t, `${server.base}/mcp`);
  await stubborn.manager.connectAll();
  assert.equal(stubborn.manager.status()[0]!.status, 'failed');
  assert.match(stubborn.manager.status()[0]!.error ?? '', /HTTP 503 Service Unavailable: not now/);
  assert.equal(server.inits, 4);
  assert.deepEqual(stubborn.delays, [500, 1000, 2000]);
  assert.deepEqual(stubborn.manager.tools(), []);
  // It never worked, so a later use does not try again on its own.
  await assert.rejects(stubborn.manager.readResource('remote', 'x://y'), /"remote" is not connected: HTTP 503/);
  assert.equal(server.inits, 4);

  // A refusal that will not change (bad credentials) is not retried.
  server.inits = 0;
  server.refuseWith = 401;
  const refused = remoteManager(t, `${server.base}/mcp`);
  await refused.manager.connectAll();
  assert.equal(refused.manager.status()[0]!.status, 'failed');
  assert.match(refused.manager.status()[0]!.error ?? '', /HTTP 401.*authentication required/);
  assert.equal(server.inits, 1);
  assert.deepEqual(refused.delays, []);

  // An unreachable server is retried as well.
  await server.stop();
  const unreachable = remoteManager(t, `${server.base}/mcp`);
  await unreachable.manager.connectAll();
  assert.match(unreachable.manager.status()[0]!.error ?? '', /Could not reach http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.deepEqual(unreachable.delays, [500, 1000, 2000]);

  // Local servers are not retried.
  const delays: number[] = [];
  const local = managerFor(t, [{ name: 'bad', scope: 'user', config: { command: 'coco-definitely-not-a-real-command' } }], {
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  await local.connectAll();
  assert.equal(local.status()[0]!.status, 'failed');
  assert.deepEqual(delays, []);
});

test('http: a dropped connection is re-established on the next use, with backoff', async (t) => {
  const ctx = makeContext(tempProject());
  const server = await flakyServer(t);
  const { manager, delays } = remoteManager(t, `${server.base}/mcp`);
  await manager.connectAll();
  // Look the tool up afresh each time, as the agent loop does on every request.
  const echo = (value: string) => findTool(manager.tools(), 'mcp__remote__echo').execute({ text: value }, ctx);
  assert.deepEqual(await echo('one'), { content: 'http:one' });
  assert.equal(server.inits, 1);

  // The server restarts and no longer knows the session; coming back up takes it a while.
  server.restart();
  server.failInits = 3;
  const dropped = await echo('two');
  assert.equal(dropped.isError, true);
  assert.match(dropped.content, /MCP tool remote\/echo failed: HTTP 404 Not Found: session not found\./);
  assert.match(dropped.content, /connection to this server was lost; the next call to it reconnects first/);
  assert.equal(manager.status()[0]!.status, 'failed');
  assert.match(manager.status()[0]!.error ?? '', /HTTP 404/);
  assert.equal(manager.tools().length, 1, 'the tools stay on offer so the model can call again');
  assert.deepEqual(delays, []);
  assert.equal(server.inits, 1, 'nothing reconnects until the server is used');

  // The next use reconnects: three refused handshakes with growing waits, then success.
  assert.deepEqual(await echo('three'), { content: 'http:three' });
  assert.equal(server.inits, 5);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(manager.status()[0]!.status, 'connected');
  assert.equal(manager.status()[0]!.error, undefined);

  // That successful call reset the count: the next outage starts from a short wait again.
  delays.length = 0;
  server.restart();
  server.failInits = 1;
  assert.equal((await echo('four')).isError, true);
  assert.deepEqual(await echo('five'), { content: 'http:five' });
  assert.deepEqual(delays, [1000]);
});

test('http: reconnection gives up after 5 failures and points to /mcp reconnect', async (t) => {
  const ctx = makeContext(tempProject());
  const server = await flakyServer(t);
  const { manager, delays } = remoteManager(t, `${server.base}/mcp`);
  await manager.connectAll();
  const held = findTool(manager.tools(), 'mcp__remote__echo');
  assert.deepEqual(await held.execute({ text: 'one' }, ctx), { content: 'http:one' });

  // The server goes away entirely: the failed request is how the drop is noticed.
  await server.stop();
  const dropped = await held.execute({ text: 'two' }, ctx);
  assert.equal(dropped.isError, true);
  assert.match(dropped.content, /Could not reach http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.equal(manager.status()[0]!.status, 'failed');
  assert.equal(manager.tools().length, 1);

  // Five attempts, four waits between them, then no more.
  const gaveUp = await held.execute({ text: 'three' }, ctx);
  assert.equal(gaveUp.isError, true);
  assert.match(gaveUp.content, /MCP server "remote" is not connected: Could not reach .*\. Gave up after 5 reconnection attempts; run \/mcp reconnect remote to try again\./);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.ok(delays.every((ms) => ms <= 30_000));
  const [status] = manager.status();
  assert.equal(status!.status, 'failed');
  assert.match(status!.error ?? '', /run \/mcp reconnect remote to try again/);
  assert.deepEqual(manager.tools(), [], 'the tools are withdrawn once reconnection is given up');
  assert.deepEqual(manager.prompts(), []);

  // Later uses fail at once, without further attempts or waits.
  const later = await held.execute({ text: 'four' }, ctx);
  assert.equal(later.isError, true);
  assert.match(later.content, /run \/mcp reconnect remote/);
  await assert.rejects(manager.readResource('remote', 'x://y'), /run \/mcp reconnect remote/);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);

  // A manual reconnect is a single attempt, and starts the count afresh.
  await manager.reconnect('remote');
  assert.equal(manager.status()[0]!.status, 'failed');
  assert.doesNotMatch(manager.status()[0]!.error ?? '', /Gave up/);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(manager.tools().length, 1, 'on offer again: the next use retries');
});

test('http: a server that keeps dropping is backed off, given up on, and recovered with reconnect()', async (t) => {
  const ctx = makeContext(tempProject());
  const server = await flakyServer(t);
  const { manager, delays } = remoteManager(t, `${server.base}/mcp`);
  await manager.connectAll();
  const echo = (value: string) => findTool(manager.tools(), 'mcp__remote__echo').execute({ text: value }, ctx);
  assert.deepEqual(await echo('ok'), { content: 'http:ok' });

  // Every handshake works, but each call loses the session again.
  server.dropCalls = true;
  for (let use = 1; use <= 6; use++) {
    const res = await echo(`drop ${use}`);
    assert.equal(res.isError, true, `use ${use}`);
    assert.match(res.content, /HTTP 404/, `use ${use}`);
  }
  // One reconnection per use, each after a longer wait than the last.
  assert.equal(server.inits, 6);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(manager.tools().length, 1);

  // The fifth reconnection did not lead to a working call either: that is the end of it.
  const gaveUp = await findTool(manager.tools(), 'mcp__remote__echo').execute({ text: 'x' }, ctx);
  assert.equal(gaveUp.isError, true);
  assert.match(gaveUp.content, /Gave up after 5 reconnection attempts; run \/mcp reconnect remote to try again/);
  assert.equal(server.inits, 6);
  assert.deepEqual(manager.tools(), []);

  // The user fixes the server and reconnects by hand.
  server.dropCalls = false;
  await manager.reconnect('remote');
  assert.equal(manager.status()[0]!.status, 'connected');
  assert.equal(manager.status()[0]!.error, undefined);
  assert.deepEqual(await echo('back'), { content: 'http:back' });

  // A successful call in between keeps a flaky server from ever being given up on.
  delays.length = 0;
  for (let round = 0; round < 8; round++) {
    server.restart();
    assert.equal((await echo('lost')).isError, true);
    assert.deepEqual(await echo('found'), { content: 'http:found' });
  }
  assert.deepEqual(delays, []);
  assert.equal(manager.status()[0]!.status, 'connected');
});

test('sse: the legacy transport is retried at first connect and revived after its stream drops', async (t) => {
  const ctx = makeContext(tempProject());
  let stream: http.ServerResponse | undefined;
  let opens = 0;
  let refuse = 2;
  const { base } = await startServer(t, (req, res, body) => {
    if (req.method === 'GET' && req.url === '/sse') {
      opens++;
      if (refuse > 0) {
        refuse--;
        res.writeHead(503, { 'Content-Type': 'text/plain' }).end('warming up');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages\n\n');
      stream = res;
      return;
    }
    if (req.method === 'POST' && req.url === '/messages') {
      res.writeHead(202, { 'Content-Type': 'text/plain' }).end('Accepted');
      const reply = answer(JSON.parse(body) as Rpc);
      if (reply) stream?.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });

  const { manager, delays } = remoteManager(t, `${base}/sse`, 'sse');
  await manager.connectAll();
  assert.equal(manager.status()[0]!.status, 'connected');
  assert.equal(opens, 3);
  assert.deepEqual(delays, [500, 1000]);
  const echo = (value: string) => findTool(manager.tools(), 'mcp__remote__echo').execute({ text: value }, ctx);
  assert.deepEqual(await echo('one'), { content: 'http:one' });

  // The server closes the event stream and is slow to accept a new one.
  delays.length = 0;
  refuse = 1;
  stream?.end();
  for (let i = 0; i < 200 && manager.status()[0]!.status === 'connected'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.status()[0]!.status, 'failed');
  assert.match(manager.status()[0]!.error ?? '', /Event stream closed by the server/);
  assert.deepEqual(await echo('two'), { content: 'http:two' });
  assert.equal(opens, 5);
  assert.deepEqual(delays, [1000]);
  assert.equal(manager.status()[0]!.status, 'connected');
});

test('manager: a local server that cannot be restarted is given up on after 5 uses', async (t) => {
  const root = tempProject();
  const ctx = makeContext(root);
  const script = path.join(root, 'server.mjs');
  fs.copyFileSync(FIXTURE, script);
  const delays: number[] = [];
  const manager = managerFor(t, [{ name: 'm', scope: 'user', config: { command: process.execPath, args: [script] } }], {
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  await manager.connectAll();
  const tools = manager.tools();
  assert.equal(tools.length, TOOL_COUNT);

  // The server dies and its program is gone, so it cannot come back.
  fs.rmSync(script);
  assert.equal((await findTool(tools, 'mcp__m__crash').execute({}, ctx)).isError, true);
  for (let use = 1; use <= MAX_RECONNECT_ATTEMPTS; use++) {
    const res = await findTool(tools, 'mcp__m__echo').execute({ text: 'x' }, ctx);
    assert.equal(res.isError, true, `use ${use}`);
    assert.match(res.content, /MCP server "m" is not connected: /, `use ${use}`);
    assert.equal(manager.tools().length, use < MAX_RECONNECT_ATTEMPTS ? TOOL_COUNT : 0, `use ${use}`);
  }
  assert.match(manager.status()[0]!.error ?? '', /Gave up after 5 reconnection attempts; run \/mcp reconnect m to try again\./);
  assert.deepEqual(delays, [], 'a local server gets one restart per use, without waiting');

  // Once the program is back, a manual reconnect restores everything.
  fs.copyFileSync(FIXTURE, script);
  await manager.reconnect('m');
  assert.equal(manager.status()[0]!.status, 'connected');
  assert.equal(manager.tools().length, TOOL_COUNT);
  assert.deepEqual(await findTool(tools, 'mcp__m__echo').execute({ text: 'back' }, ctx), { content: 'back' });
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
