import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { McpServerConfig, ScopedMcpServer } from '../src/mcp/config.ts';
import { McpManager } from '../src/mcp/manager.ts';
import { mcpResourceTools } from '../src/tools/mcpResources.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeContext, tempProject } from './helpers.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'mock-mcp-server.mjs');

/** The fixture server; `resources: false` starts it without the resources capability. */
function fixture(resources = true): McpServerConfig {
  return resources ? { command: process.execPath, args: [FIXTURE] } : { command: process.execPath, args: [FIXTURE], env: { COCO_MOCK_NO_RESOURCES: '1' } };
}

async function managerFor(t: TestContext, servers: ScopedMcpServer[]): Promise<McpManager> {
  const manager = new McpManager(servers);
  t.after(() => manager.close());
  await manager.connectAll();
  return manager;
}

function pair(manager: McpManager): { list: Tool; read: Tool } {
  const tools = mcpResourceTools(manager);
  assert.deepEqual(
    tools.map((x) => x.name),
    ['ListMcpResources', 'ReadMcpResource'],
  );
  return { list: tools[0]!, read: tools[1]! };
}

function rows(content: string): Record<string, string>[] {
  return content.split('\n').map((line) => JSON.parse(line) as Record<string, string>);
}

test('resources: no tools without a connected server that advertises resources', async (t) => {
  assert.deepEqual(mcpResourceTools(undefined), []);
  assert.deepEqual(mcpResourceTools(new McpManager([])), []);

  // Configured but not connected yet.
  const pending = new McpManager([{ name: 'docs', scope: 'user', config: fixture() }]);
  t.after(() => pending.close());
  assert.deepEqual(mcpResourceTools(pending), []);

  // Connected, but the server has no resources capability.
  const plain = await managerFor(t, [
    { name: 'plain', scope: 'user', config: fixture(false) },
    { name: 'bad', scope: 'user', config: { command: 'coco-definitely-not-a-real-command' } },
  ]);
  assert.equal(plain.status()[0]!.status, 'connected');
  assert.deepEqual(plain.resourceServers(), []);
  assert.deepEqual(mcpResourceTools(plain), []);

  // The tools appear once such a server connects, and go away when it is switched off.
  await pending.connectAll();
  assert.deepEqual(pending.resourceServers(), ['docs']);
  assert.equal(mcpResourceTools(pending).length, 2);
  await pending.setEnabled('docs', false);
  assert.deepEqual(mcpResourceTools(pending), []);
});

test('resources: both tools are read-only, need no permission and are briefly described', async (t) => {
  const manager = await managerFor(t, [{ name: 'docs', scope: 'user', config: fixture() }]);
  const { list, read } = pair(manager);
  const ctx = makeContext(tempProject());
  for (const tool of [list, read]) {
    assert.equal(tool.isReadOnly({}), true);
    assert.equal(tool.permission, undefined);
    assert.ok(tool.description.length < 200, tool.description);
  }
  assert.deepEqual(list.parameters.required, undefined);
  assert.deepEqual(Object.keys(list.parameters.properties ?? {}), ['server']);
  assert.deepEqual(read.parameters.required, ['server', 'uri']);
  assert.equal(read.label!({ server: 'docs', uri: 'mock://readme' }, ctx), 'mock://readme');
});

test('resources: ListMcpResources lists every server, or the one asked for', async (t) => {
  const manager = await managerFor(t, [
    { name: 'docs', scope: 'user', config: fixture() },
    { name: 'my server.v1', scope: 'project', config: fixture() },
    { name: 'plain', scope: 'user', config: fixture(false) },
  ]);
  const { list } = pair(manager);
  const ctx = makeContext(tempProject());

  const all = await list.execute({}, ctx);
  assert.equal(all.isError, undefined);
  assert.equal(all.summary, '2 resources');
  assert.deepEqual(rows(all.content), [
    { server: 'docs', uri: 'mock://readme', name: 'readme', description: 'A readme', mimeType: 'text/plain' },
    { server: 'my server.v1', uri: 'mock://readme', name: 'readme', description: 'A readme', mimeType: 'text/plain' },
  ]);

  const one = await list.execute({ server: 'docs' }, ctx);
  assert.deepEqual(rows(one.content), [{ server: 'docs', uri: 'mock://readme', name: 'readme', description: 'A readme', mimeType: 'text/plain' }]);
  assert.equal(one.summary, '1 resource');

  // The form used in tool names (mcp__my_server_v1__...) finds the server too.
  const sanitised = await list.execute({ server: 'my_server_v1' }, ctx);
  assert.equal(rows(sanitised.content)[0]!.server, 'my server.v1');

  // Error paths: results, not exceptions.
  const unknown = await list.execute({ server: 'nope' }, ctx);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /Unknown MCP server "nope"\. Servers with resources: docs, my server\.v1\./);
  const unsupported = await list.execute({ server: 'plain' }, ctx);
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content, /MCP server "plain" does not offer resources\./);
});

test('resources: ReadMcpResource returns the text, clamped to maxToolOutputChars', async (t) => {
  const root = tempProject();
  const manager = await managerFor(t, [{ name: 'docs', scope: 'user', config: fixture() }]);
  const { read } = pair(manager);

  const readme = await read.execute({ server: 'docs', uri: 'mock://readme' }, makeContext(root));
  assert.deepEqual(readme, { content: 'mock readme contents', summary: 'Read mock://readme' });

  // 50,000 characters against the default limit of 30,000.
  const byDefault = await read.execute({ server: 'docs', uri: 'mock://big' }, makeContext(root));
  assert.equal(byDefault.isError, undefined);
  assert.match(byDefault.content, /\[20000 characters truncated\]/);
  assert.ok(byDefault.content.length < 30_200);

  const small = await read.execute({ server: 'docs', uri: 'mock://big' }, makeContext(root, { maxToolOutputChars: 500 }));
  assert.match(small.content, /\[49500 characters truncated\]/);
  assert.ok(small.content.length < 700);

  const binary = await read.execute({ server: 'docs', uri: 'mock://binary' }, makeContext(root));
  assert.equal(binary.isError, undefined);
  assert.equal(binary.content, '[binary resource: mock://binary (image/png)]');
});

test('resources: an unknown server, a server without resources and a failed read are error results', async (t) => {
  const manager = await managerFor(t, [
    { name: 'docs', scope: 'user', config: fixture() },
    { name: 'plain', scope: 'user', config: fixture(false) },
    { name: 'bad', scope: 'local', config: { command: 'coco-definitely-not-a-real-command' } },
    { name: 'off', scope: 'user', config: fixture() },
  ]);
  await manager.setEnabled('off', false);
  const { read } = pair(manager);
  const ctx = makeContext(tempProject());

  const unknown = await read.execute({ server: 'nope', uri: 'mock://readme' }, ctx);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /Unknown MCP server "nope"\. Servers with resources: docs\./);

  const unsupported = await read.execute({ server: 'plain', uri: 'mock://readme' }, ctx);
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content, /MCP server "plain" does not offer resources\. Servers with resources: docs\./);

  const failedRead = await read.execute({ server: 'docs', uri: 'mock://nope' }, ctx);
  assert.equal(failedRead.isError, true);
  assert.match(failedRead.content, /Could not read mock:\/\/nope from MCP server "docs": Resource not found: mock:\/\/nope/);

  const notConnected = await read.execute({ server: 'bad', uri: 'mock://readme' }, ctx);
  assert.equal(notConnected.isError, true);
  assert.match(notConnected.content, /MCP server "bad" is not connected: Command not found/);

  const disabled = await read.execute({ server: 'off', uri: 'mock://readme' }, ctx);
  assert.equal(disabled.isError, true);
  assert.match(disabled.content, /MCP server "off" is disabled\./);

  for (const input of [{}, { server: 'docs' }, { uri: 'mock://readme' }, { server: ' ', uri: 'mock://readme' }]) {
    const missing = await read.execute(input, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.content, /Give both "server" and "uri"/);
  }

  // The server is still healthy after all of that.
  assert.equal((await read.execute({ server: 'docs', uri: 'mock://readme' }, ctx)).content, 'mock readme contents');
});

test('resources: a cancelled read and a crashed server do not throw', async (t) => {
  const root = tempProject();
  const manager = await managerFor(t, [{ name: 'docs', scope: 'user', config: fixture() }]);
  const { list, read } = pair(manager);

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await read.execute({ server: 'docs', uri: 'mock://readme' }, { ...makeContext(root), signal: aborted.signal });
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.content, /Could not read mock:\/\/readme from MCP server "docs": the read was cancelled/);

  // Kill the server through one of its tools; the resource tools stay on offer and the next read restarts it.
  const crash = manager.tools().find((x) => x.name === 'mcp__docs__crash')!;
  assert.equal((await crash.execute({}, makeContext(root))).isError, true);
  assert.equal(manager.status()[0]!.status, 'failed');
  assert.equal(mcpResourceTools(manager).length, 2);
  // A sweep of all servers does not reconnect anything; naming the server does.
  assert.deepEqual(await list.execute({}, makeContext(root)), { content: 'No MCP resources are available.', summary: 'No resources' });
  assert.equal(manager.status()[0]!.status, 'failed');
  const revived = await read.execute({ server: 'docs', uri: 'mock://readme' }, makeContext(root));
  assert.deepEqual(revived, { content: 'mock readme contents', summary: 'Read mock://readme' });
  assert.equal(manager.status()[0]!.status, 'connected');
});
