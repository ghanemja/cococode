/**
 * End-to-end tests: the real CLI in a child process, talking to the scripted
 * mock model server over HTTP. These cover the path a user actually runs.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempProject, writeFiles } from './helpers.ts';
import { lastMessage, startMockServer, type MockServer, type MockServerOptions, type Script } from './mock-server.ts';

const CLI = fileURLToPath(new URL('../bin/coco.js', import.meta.url));
const MCP_FIXTURE = fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url));

let servers: MockServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

async function mock(script: Script, opts?: MockServerOptions): Promise<MockServer> {
  const server = await startMockServer(script, opts);
  servers.push(server);
  return server;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function coco(dir: string, args: string[], opts: { env?: Record<string, string>; stdin?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, COCO_CONFIG_DIR: path.join(dir, '.coco-home'), NO_COLOR: '1', ...opts.env };
    // The developer's own setup must not leak into the tests.
    for (const key of ['COCO_MODEL', 'COCO_PROVIDER', 'COCO_BASE_URL', 'COCO_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY']) if (!(key in (opts.env ?? {}))) delete env[key];
    if (!opts.env?.OLLAMA_HOST) env.OLLAMA_HOST = '127.0.0.1:1'; // nothing listens here
    const child = spawn('node', [CLI, ...args], { cwd: dir, env, stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`coco timed out.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 30_000);
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function project(files: Record<string, string> = {}): string {
  const dir = tempProject();
  writeFiles(dir, { 'hello.txt': 'hello world\n', ...files });
  return dir;
}

const base = (server: MockServer) => ['--base-url', server.url, '--model', 'mock-model'];

describe('coco -p', () => {
  test('prints the answer and exits 0', async () => {
    const server = await mock([{ text: 'Four.' }]);
    const res = await coco(project(), ['-p', 'what is 2+2?', ...base(server)]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, 'Four.\n');
    const body = server.requests[0]!.body;
    assert.equal(body.model, 'mock-model');
    assert.equal(body.stream, true);
    assert.equal(lastMessage(server.requests[0]!, 'user').content, 'what is 2+2?');
    assert.match(body.messages[0].content, /You are coco/);
  });

  test('runs tools across several model turns', async () => {
    const server = await mock([
      { toolCalls: [{ name: 'Read', arguments: { file_path: 'hello.txt' } }] },
      { toolCalls: [{ name: 'Edit', arguments: { file_path: 'hello.txt', old_string: 'hello', new_string: 'goodbye' } }] },
      { text: 'Changed.' },
    ]);
    const dir = project();
    const res = await coco(dir, ['-p', 'change it', '--permission-mode', 'acceptEdits', ...base(server)]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'Changed.');
    assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'goodbye world\n');
    // The assistant's tool call and its result are replayed in the OpenAI wire format.
    const messages = server.requests[2]!.body.messages as any[];
    const call = messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.equal(call.tool_calls[0].function.name, 'Read');
    assert.equal(typeof call.tool_calls[0].function.arguments, 'string');
    const result = messages.find((m) => m.role === 'tool');
    assert.equal(result.tool_call_id, call.tool_calls[0].id);
  });

  test('without approval, changes are refused and the model is told', async () => {
    const server = await mock([
      { toolCalls: [{ name: 'Write', arguments: { file_path: 'new.txt', content: 'x' } }] },
      { text: 'I was not allowed to write the file.' },
    ]);
    const dir = project();
    const res = await coco(dir, ['-p', 'write a file', ...base(server)]);
    assert.equal(res.code, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'new.txt')));
    assert.match(lastMessage(server.requests[1]!, 'tool').content, /Permission is required/);
  });

  test('--allowedTools and --disallowedTools are applied', async () => {
    const server = await mock([
      { toolCalls: [{ name: 'Bash', arguments: { command: 'touch allowed.txt' } }, { name: 'Bash', arguments: { command: 'mkdir nope' } }] },
      { text: 'done' },
    ]);
    const dir = project();
    const res = await coco(dir, ['-p', 'go', '--allowedTools', 'Bash(touch:*)', '--disallowedTools', 'WebFetch,WebSearch', ...base(server)]);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'allowed.txt')));
    assert.ok(!fs.existsSync(path.join(dir, 'nope')));
    const tools = (server.requests[0]!.body.tools as any[]).map((t) => t.function.name);
    assert.ok(!tools.includes('WebFetch') && !tools.includes('WebSearch') && tools.includes('Bash'));
  });

  test('--dangerously-skip-permissions runs everything', async () => {
    const server = await mock([{ toolCalls: [{ name: 'Bash', arguments: { command: 'echo hi > out.txt' } }] }, { text: 'done' }]);
    const dir = project();
    await coco(dir, ['-p', 'go', '--dangerously-skip-permissions', ...base(server)]);
    assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), 'hi\n');
  });

  test('piped stdin is added to the prompt', async () => {
    const server = await mock([{ text: 'A log.' }]);
    const res = await coco(project(), ['-p', 'what is this?', ...base(server)], { stdin: 'ERROR: disk full\n' });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(lastMessage(server.requests[0]!, 'user').content, 'what is this?\n\n<stdin>\nERROR: disk full\n</stdin>');
  });

  test('--output-format json reports the result and usage', async () => {
    const server = await mock([{ toolCalls: [{ name: 'Glob', arguments: { pattern: '*.txt' } }] }, { text: 'One file.' }]);
    const res = await coco(project(), ['-p', 'count', '--output-format', 'json', ...base(server)]);
    const out = JSON.parse(res.stdout);
    assert.equal(out.type, 'result');
    assert.equal(out.subtype, 'success');
    assert.equal(out.is_error, false);
    assert.equal(out.result, 'One file.');
    assert.equal(out.num_turns, 2);
    assert.equal(out.usage.tool_uses, 1);
    assert.ok(out.usage.input_tokens > 0);
    assert.match(out.session_id, /^[0-9a-f-]{36}$/);
  });

  test('--output-format stream-json emits one JSON object per line', async () => {
    const server = await mock([{ thinking: 'hmm', toolCalls: [{ name: 'Read', arguments: { file_path: 'hello.txt' } }] }, { text: 'It says hello.' }]);
    const res = await coco(project(), ['-p', 'read', '--output-format', 'stream-json', ...base(server)]);
    const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.type), ['system', 'assistant', 'user', 'assistant', 'result']);
    assert.equal(lines[0].subtype, 'init');
    assert.ok(lines[0].tools.includes('Read'));
    assert.deepEqual(lines[1].message.content.map((c: any) => c.type), ['thinking', 'tool_use']);
    assert.equal(lines[2].message.content[0].type, 'tool_result');
    assert.match(lines[2].message.content[0].content, /hello world/);
    assert.equal(lines[4].result, 'It says hello.');
  });

  test('--max-turns stops a runaway loop with a non-success result', async () => {
    let n = 0;
    const server = await mock(() => ({ toolCalls: [{ name: 'Glob', arguments: { pattern: `*.${n++}` } }] }));
    const res = await coco(project(), ['-p', 'loop', '--max-turns', '3', '--output-format', 'json', ...base(server)]);
    assert.equal(server.requests.length, 3);
    assert.equal(JSON.parse(res.stdout).subtype, 'error_max_turns');
  });

  test('a server error is reported on stderr with exit code 1', async () => {
    const server = await mock([{ error: { status: 500, message: 'out of memory' } }]);
    const res = await coco(project(), ['-p', 'hi', ...base(server)]);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /out of memory/);
  });

  test('no prompt and no server are explained, not crashed on', async () => {
    const server = await mock([]);
    const noPrompt = await coco(project(), ['-p', ...base(server)]);
    assert.equal(noPrompt.code, 1);
    assert.match(noPrompt.stderr, /No prompt given/);
    const noServer = await coco(project(), ['-p', 'hi', '--base-url', 'http://127.0.0.1:1/v1', '--model', 'x']);
    assert.equal(noServer.code, 1);
    assert.match(noServer.stderr, /Could not reach http:\/\/127\.0\.0\.1:1/);
  });

  test('--system-prompt and --append-system-prompt shape the system message', async () => {
    const server = await mock([{ text: 'Arr.' }]);
    await coco(project(), ['-p', 'hi', '--system-prompt', 'You are a pirate.', '--append-system-prompt', 'Be brief.', ...base(server)]);
    const system = server.requests[0]!.body.messages[0].content as string;
    assert.ok(system.startsWith('You are a pirate.'));
    assert.ok(system.trimEnd().endsWith('Be brief.'));
  });
});

describe('local-model robustness', () => {
  test('a tool call leaked into the text is still executed', async () => {
    const server = await mock([
      { text: 'Let me look.\n<tool_call>\n{"name": "Read", "arguments": {"file_path": "hello.txt"}}\n</tool_call>' },
      { text: 'The file says hello world.' },
    ]);
    const res = await coco(project(), ['-p', 'read it', ...base(server)]);
    assert.equal(res.stdout.trim(), 'The file says hello world.');
    assert.equal(server.requests.length, 2);
    assert.match(lastMessage(server.requests[1]!, 'tool').content, /hello world/);
    // The leaked markup is not replayed to the model as prose.
    const assistant = lastMessage(server.requests[1]!, 'assistant');
    assert.equal(assistant.content, 'Let me look.\n');
    assert.equal(assistant.tool_calls[0].function.name, 'Read');
  });

  test('a bare JSON tool call as the whole reply is executed', async () => {
    const server = await mock([{ text: '{"name": "Glob", "parameters": {"pattern": "*.txt"}}' }, { text: 'Found hello.txt.' }]);
    const res = await coco(project(), ['-p', 'list', ...base(server)]);
    assert.equal(res.stdout.trim(), 'Found hello.txt.');
    assert.match(lastMessage(server.requests[1]!, 'tool').content, /hello\.txt/);
  });

  test('a server without tool support falls back to the text protocol', async () => {
    let n = 0;
    const server = await mock(
      () => (n++ === 0 ? { text: '<tool_call>\n{"name": "Read", "arguments": {"file_path": "hello.txt"}}\n</tool_call>' } : { text: 'It says hello world.' }),
      { rejectTools: true },
    );
    const res = await coco(project(), ['-p', 'read it', ...base(server)]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'It says hello world.');
    // First request was rejected for carrying tools; the retries describe tools in the prompt instead.
    assert.ok(server.requests[0]!.body.tools?.length > 0);
    const retry = server.requests[1]!.body;
    assert.equal(retry.tools, undefined);
    assert.match(retry.messages[0].content, /<tool_call>[\s\S]*"name": "Read"|Available tools/);
    const followUp = server.requests[2]!.body.messages as any[];
    assert.ok(!followUp.some((m) => m.role === 'tool'));
    assert.match(followUp.at(-1).content, /<tool_response name="Read">[\s\S]*hello world/);
  });

  test('--tool-mode prompt never sends native tools', async () => {
    const server = await mock([{ text: 'Hi.' }]);
    await coco(project(), ['-p', 'hi', '--tool-mode', 'prompt', ...base(server)]);
    assert.equal(server.requests[0]!.body.tools, undefined);
    assert.match(server.requests[0]!.body.messages[0].content, /Available tools \(JSON schema\)/);
  });

  test('optional request fields a server rejects are dropped and the request retried', async () => {
    const server = await mock([{ text: 'Hi.' }], { rejectFields: ['stream_options', 'parallel_tool_calls'] });
    const res = await coco(project(), ['-p', 'hi', ...base(server)]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'Hi.');
    const last = server.requests.at(-1)!.body;
    assert.ok(!('stream_options' in last) && !('parallel_tool_calls' in last));
  });
});

describe('Ollama native API', () => {
  const ollamaEnv = (server: MockServer) => ({ OLLAMA_HOST: server.root.replace('http://', '') });

  test('is auto-detected, pins the context window and uses the native wire format', async () => {
    const server = await mock([{ thinking: 'need the file', toolCalls: [{ name: 'Read', arguments: { file_path: 'hello.txt' } }] }, { text: 'hello world' }], {
      models: ['qwen3:8b'],
    });
    const res = await coco(project(), ['-p', 'read it'], { env: ollamaEnv(server) });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'hello world');
    const first = server.requests[0]!;
    assert.equal(first.path, '/api/chat');
    assert.equal(first.body.model, 'qwen3:8b');
    assert.equal(first.body.options.num_ctx, 32768);
    assert.ok(first.body.options.num_predict >= 1024);
    assert.equal(first.body.keep_alive, '30m');
    assert.ok(!('think' in first.body));
    const messages = server.requests[1]!.body.messages as any[];
    const call = messages.find((m) => m.tool_calls);
    assert.deepEqual(call.tool_calls[0].function.arguments, { file_path: 'hello.txt' });
    const result = messages.find((m) => m.role === 'tool');
    assert.equal(result.tool_name, 'Read');
    assert.match(result.content, /hello world/);
  });

  test('--context sets num_ctx, capped at what the model supports', async () => {
    const server = await mock([{ text: 'a' }, { text: 'b' }], { models: ['m'], contextLength: 16384 });
    await coco(project(), ['-p', 'hi', '--context', '8192'], { env: ollamaEnv(server) });
    assert.equal(server.requests[0]!.body.options.num_ctx, 8192);
    const res = await coco(project(), ['-p', 'hi', '--context', '65536'], { env: ollamaEnv(server) });
    assert.equal(server.requests[1]!.body.options.num_ctx, 16384);
    assert.match(res.stderr, /exceeds the model's maximum/);
  });

  test('a model without the tools capability gets the text protocol up front', async () => {
    const server = await mock([{ text: 'Hi.' }], { models: ['gemma'], capabilities: ['completion'] });
    const res = await coco(project(), ['-p', 'hi'], { env: ollamaEnv(server) });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.body.tools, undefined);
    assert.match(res.stderr, /does not advertise native tool calling/);
  });

  test('images reach a vision model, and are refused for a text-only one', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const vision = await mock([{ toolCalls: [{ name: 'Read', arguments: { file_path: 'pixel.png' } }] }, { text: 'A single pixel.' }, { text: 'Also a pixel.' }], {
      models: ['llava'],
      capabilities: ['completion', 'tools', 'vision'],
    });
    const dir = project();
    fs.writeFileSync(path.join(dir, 'pixel.png'), png);
    await coco(dir, ['-p', 'look at pixel.png'], { env: ollamaEnv(vision) });
    // The image from the Read tool follows the tool result as a user turn carrying base64 data.
    const withImage = (vision.requests[1]!.body.messages as any[]).find((m) => Array.isArray(m.images));
    assert.equal(withImage.role, 'user');
    assert.equal(withImage.images[0], png.toString('base64'));
    await coco(dir, ['-p', 'describe @pixel.png'], { env: ollamaEnv(vision) });
    const mention = (vision.requests[2]!.body.messages as any[]).find((m) => m.role === 'user');
    assert.deepEqual(mention.images, [png.toString('base64')]);

    const textOnly = await mock([{ toolCalls: [{ name: 'Read', arguments: { file_path: 'pixel.png' } }] }, { text: 'Cannot see it.' }], { models: ['qwen'] });
    await coco(dir, ['-p', 'look at pixel.png'], { env: ollamaEnv(textOnly) });
    const result = (textOnly.requests[1]!.body.messages as any[]).find((m) => m.role === 'tool');
    assert.match(result.content, /does not accept images/);
    assert.ok(!(textOnly.requests[1]!.body.messages as any[]).some((m) => m.images));
  });

  test('coco models lists what the server has', async () => {
    const server = await mock([], { models: ['qwen3:8b', 'nomic-embed-text', 'llama3.2'] });
    const res = await coco(project(), ['models'], { env: ollamaEnv(server) });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /ollama/);
    assert.match(res.stdout, /qwen3:8b/);
    assert.match(res.stdout, /llama3\.2/);
    assert.ok(!res.stdout.includes('nomic-embed-text'), 'embedding models are not chat models');
  });

  test('coco doctor reports a healthy setup', async () => {
    const server = await mock([], { models: ['qwen3:8b'] });
    const res = await coco(project(), ['doctor'], { env: ollamaEnv(server) });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /✓ ollama at http:\/\/127\.0\.0\.1:\d+ \(1 model\)/);
    assert.match(res.stdout, /Model qwen3:8b: 32k context/);
  });
});

describe('sessions and configuration from the command line', () => {
  test('--continue carries the previous conversation into the next run', async () => {
    const server = await mock([{ text: 'Noted: your name is Ada.' }, { text: 'Your name is Ada.' }]);
    const dir = project();
    await coco(dir, ['-p', 'my name is Ada', ...base(server)]);
    const res = await coco(dir, ['-p', 'what is my name?', '--continue', ...base(server)]);
    assert.equal(res.stdout.trim(), 'Your name is Ada.');
    const contents = (server.requests[1]!.body.messages as any[]).map((m) => m.content);
    assert.deepEqual(contents.slice(1), ['my name is Ada', 'Noted: your name is Ada.', 'what is my name?']);
    const sessions = await coco(dir, ['sessions']);
    assert.match(sessions.stdout, /my name is Ada/);
    assert.equal(sessions.stdout.trim().split('\n').filter((l) => /^[0-9a-f]{8}-/.test(l)).length, 1);
  });

  test('--resume <id> picks a specific conversation', async () => {
    const server = await mock([{ text: 'first' }, { text: 'second' }, { text: 'again' }]);
    const dir = project();
    const one = JSON.parse((await coco(dir, ['-p', 'alpha topic', '--output-format', 'json', ...base(server)])).stdout);
    await coco(dir, ['-p', 'beta topic', ...base(server)]);
    await coco(dir, ['-p', 'more', '--resume', one.session_id, ...base(server)]);
    const contents = (server.requests[2]!.body.messages as any[]).map((m) => m.content);
    assert.deepEqual(contents.slice(1), ['alpha topic', 'first', 'more']);
    const missing = await coco(dir, ['-p', 'x', '--resume', 'deadbeef', ...base(server)]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No session matching/);
  });

  test('coco config reads and writes settings files', async () => {
    const dir = project();
    assert.equal((await coco(dir, ['config', 'set', 'model', 'qwen3:8b'])).code, 0);
    await coco(dir, ['config', 'set', 'permissions.defaultMode', 'acceptEdits', '--scope', 'project']);
    await coco(dir, ['config', 'set', 'contextWindow', '16384']);
    assert.equal((await coco(dir, ['config', 'get', 'model'])).stdout.trim(), 'qwen3:8b');
    assert.equal((await coco(dir, ['config', 'get', 'contextWindow'])).stdout.trim(), '16384');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.coco/settings.json'), 'utf8')), { permissions: { defaultMode: 'acceptEdits' } });
    const all = JSON.parse((await coco(dir, ['config'])).stdout.split('\n\n')[0]!);
    assert.equal(all.permissions.defaultMode, 'acceptEdits');
    assert.equal((await coco(dir, ['config', 'get', 'nothing.here'])).code, 1);
  });

  test('settings files drive a run: model, permissions and env', async () => {
    const server = await mock([{ toolCalls: [{ name: 'Bash', arguments: { command: 'printf %s "$GREETING" > env.txt' } }] }, { text: 'ok' }]);
    const dir = project({
      '.coco/settings.json': JSON.stringify({ permissions: { allow: ['Bash(printf:*)'] }, env: { GREETING: 'bonjour' } }),
    });
    writeFiles(dir, { '.coco-home/settings.json': JSON.stringify({ baseUrl: server.url, model: 'mock-model' }) });
    const res = await coco(dir, ['-p', 'go']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'env.txt'), 'utf8'), 'bonjour');
  });

  test('--version and --help work without a server', async () => {
    const dir = project();
    assert.match((await coco(dir, ['--version'])).stdout, /^\d+\.\d+\.\d+\n$/);
    const help = await coco(dir, ['--help']);
    assert.match(help.stdout, /--permission-mode/);
    assert.equal(help.code, 0);
  });
});

describe('MCP', () => {
  test('coco mcp add / list / get / remove manage the config files', async () => {
    const dir = project();
    const added = await coco(dir, ['mcp', 'add', 'files', '--scope', 'project', '-e', 'TOKEN=abc', '--', 'node', 'server.js', '--flag']);
    assert.equal(added.code, 0, added.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')), {
      mcpServers: { files: { command: 'node', args: ['server.js', '--flag'], env: { TOKEN: 'abc' } } },
    });
    await coco(dir, ['mcp', 'add', '--transport', 'http', 'remote', 'https://example.com/mcp', '-H', 'Authorization: Bearer x']);
    const listed = await coco(dir, ['mcp', 'list']);
    assert.match(listed.stdout, /files\s+project\s+node server\.js --flag/);
    assert.match(listed.stdout, /remote\s+local\s+http https:\/\/example\.com\/mcp/);
    assert.equal(JSON.parse((await coco(dir, ['mcp', 'get', 'remote'])).stdout).headers.Authorization, 'Bearer x');
    assert.equal((await coco(dir, ['mcp', 'remove', 'files'])).code, 0);
    assert.ok(!(await coco(dir, ['mcp', 'list'])).stdout.includes('files'));
    assert.equal((await coco(dir, ['mcp', 'remove', 'files'])).code, 1);
  });

  test('tools from an MCP server are offered to the model and callable', async () => {
    const server = await mock([{ toolCalls: [{ name: 'mcp__fixture__echo', arguments: { text: 'ping' } }] }, { text: 'It echoed ping.' }]);
    const dir = project({ '.mcp.json': JSON.stringify({ mcpServers: { fixture: { command: 'node', args: [MCP_FIXTURE] } } }) });
    const res = await coco(dir, ['-p', 'echo ping', '--allowedTools', 'mcp__fixture', ...base(server)]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'It echoed ping.');
    const tools = (server.requests[0]!.body.tools as any[]).map((t) => t.function.name);
    assert.ok(tools.includes('mcp__fixture__echo'), tools.join(','));
    assert.match(lastMessage(server.requests[1]!, 'tool').content, /ping/);
  });

  test('an MCP tool without a rule is not run in headless mode', async () => {
    const server = await mock([{ toolCalls: [{ name: 'mcp__fixture__echo', arguments: { text: 'ping' } }] }, { text: 'blocked' }]);
    const dir = project({ '.mcp.json': JSON.stringify({ mcpServers: { fixture: { command: 'node', args: [MCP_FIXTURE] } } }) });
    await coco(dir, ['-p', 'echo ping', ...base(server)]);
    assert.match(lastMessage(server.requests[1]!, 'tool').content, /Permission is required/);
  });
});

describe('hooks from settings', () => {
  test('PreToolUse hooks see the call and can veto it; Stop hooks run at the end', async () => {
    const server = await mock([{ toolCalls: [{ name: 'Bash', arguments: { command: 'touch blocked.txt' } }] }, { text: 'I could not.' }]);
    const dir = project();
    const log = path.join(dir, 'hook.log');
    writeFiles(dir, {
      '.coco/settings.json': JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `cat > ${log}; echo "shell is off limits" >&2; exit 2` }] }],
          Stop: [{ hooks: [{ type: 'command', command: `echo stopped >> ${log}.stop` }] }],
        },
      }),
    });
    const res = await coco(dir, ['-p', 'go', '--dangerously-skip-permissions', ...base(server)]);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'blocked.txt')));
    const payload = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(payload.hook_event_name, 'PreToolUse');
    assert.equal(payload.tool_name, 'Bash');
    assert.equal(payload.tool_input.command, 'touch blocked.txt');
    assert.equal(payload.cwd, dir);
    assert.match(lastMessage(server.requests[1]!, 'tool').content, /shell is off limits/);
    assert.equal(fs.readFileSync(`${log}.stop`, 'utf8'), 'stopped\n');
  });
});
