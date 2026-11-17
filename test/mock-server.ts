/**
 * A scripted model server for tests. It speaks both wire protocols coco
 * supports: OpenAI-compatible chat completions (SSE) and Ollama's native
 * API (NDJSON), so the whole agent can run end to end without a model.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MockTurn {
  text?: string;
  thinking?: string;
  toolCalls?: MockToolCall[];
  /** Overrides the finish reason (stop / tool_calls / length). */
  finish?: string;
  /** Respond with this HTTP status and error body instead of a stream. */
  error?: { status: number; message: string };
  usage?: { prompt: number; completion: number };
  /** Milliseconds to wait before the first chunk. */
  delayMs?: number;
}

export interface MockRequest {
  path: string;
  body: Record<string, any>;
}

export type Script = MockTurn[] | ((req: MockRequest, index: number) => MockTurn);

export interface MockServerOptions {
  models?: string[];
  /** Reject requests that carry tools, like a model without tool support. */
  rejectTools?: boolean;
  /** Ollama capabilities reported by /api/show. */
  capabilities?: string[];
  contextLength?: number;
  /** Fields the server refuses with a 400 naming the field. */
  rejectFields?: string[];
}

export interface MockServer {
  /** Base URL for the OpenAI-compatible API (ends in /v1). */
  url: string;
  /** Base URL for the Ollama-native API. */
  root: string;
  /** Chat requests received, in order. */
  requests: MockRequest[];
  close(): Promise<void>;
}

function chunks(text: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export async function startMockServer(script: Script, opts: MockServerOptions = {}): Promise<MockServer> {
  const models = opts.models ?? ['mock-model'];
  const requests: MockRequest[] = [];
  let index = 0;

  const nextTurn = (req: MockRequest): MockTurn => {
    const i = index++;
    if (typeof script === 'function') return script(req, i);
    return script[i] ?? { text: '(mock server: script exhausted)' };
  };

  const readBody = (req: http.IncomingMessage): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url === '/v1/models') return json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
    if (req.method === 'GET' && url === '/api/version') return json(200, { version: '0.0.0-mock' });
    if (req.method === 'GET' && url === '/api/tags') {
      return json(200, { models: models.map((name, i) => ({ name, model: name, modified_at: `2026-01-0${i + 1}T00:00:00Z`, size: 1000, details: { parameter_size: '7B', quantization_level: 'Q4_K_M' } })) });
    }
    if (req.method === 'GET' && url === '/api/ps') return json(200, { models: [] });
    if (req.method === 'POST' && url === '/api/show') {
      await readBody(req);
      return json(200, {
        capabilities: opts.capabilities ?? ['completion', 'tools'],
        model_info: { 'mock.context_length': opts.contextLength ?? 131072 },
        details: { parameter_size: '7B', quantization_level: 'Q4_K_M' },
      });
    }

    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/api/chat')) {
      const body = await readBody(req);
      const record: MockRequest = { path: url, body };
      requests.push(record);

      for (const field of opts.rejectFields ?? []) {
        if (field in body) return json(400, { error: { message: `Unsupported parameter: ${field}` } });
      }
      if (opts.rejectTools && Array.isArray(body.tools) && body.tools.length) {
        return json(400, { error: url === '/api/chat' ? `${body.model} does not support tools` : { message: `${body.model} does not support tools` } });
      }
      const turn = nextTurn(record);
      if (turn.error) {
        return json(turn.error.status, url === '/api/chat' ? { error: turn.error.message } : { error: { message: turn.error.message } });
      }
      if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
      const usage = turn.usage ?? { prompt: 100 + JSON.stringify(body.messages ?? []).length / 4, completion: 10 + (turn.text?.length ?? 0) / 4 };

      if (url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const line = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
        const base = { model: body.model, created_at: new Date().toISOString() };
        for (const part of chunks(turn.thinking ?? '')) line({ ...base, message: { role: 'assistant', content: '', thinking: part }, done: false });
        for (const part of chunks(turn.text ?? '')) line({ ...base, message: { role: 'assistant', content: part }, done: false });
        if (turn.toolCalls?.length) {
          line({
            ...base,
            message: { role: 'assistant', content: '', tool_calls: turn.toolCalls.map((c, i) => ({ type: 'function', function: { index: i, name: c.name, arguments: c.arguments } })) },
            done: false,
          });
        }
        line({
          ...base,
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: turn.finish ?? 'stop',
          prompt_eval_count: Math.round(usage.prompt),
          eval_count: Math.round(usage.completion),
          eval_duration: 500_000_000,
        });
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model };
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      for (const part of chunks(turn.thinking ?? '')) send({ ...base, choices: [{ index: 0, delta: { reasoning_content: part }, finish_reason: null }] });
      for (const part of chunks(turn.text ?? '')) send({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
      (turn.toolCalls ?? []).forEach((call, i) => {
        // Arguments arrive in pieces, as real servers send them.
        const args = JSON.stringify(call.arguments);
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_mock_${index}_${i}`, type: 'function', function: { name: call.name, arguments: '' } }] }, finish_reason: null }] });
        for (const part of chunks(args, 11)) {
          send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: part } }] }, finish_reason: null }] });
        }
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.finish ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop') }] });
      if (body.stream_options?.include_usage) {
        send({ ...base, choices: [], usage: { prompt_tokens: Math.round(usage.prompt), completion_tokens: Math.round(usage.completion) } });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    json(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const root = `http://127.0.0.1:${port}`;
  return {
    url: `${root}/v1`,
    root,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Text of the last message with the given role in a recorded request. */
export function lastMessage(req: MockRequest, role: string): any {
  const messages = (req.body.messages ?? []) as any[];
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === role) return messages[i];
  return undefined;
}
