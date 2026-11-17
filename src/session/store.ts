import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TranscriptSink } from '../agent/loop.ts';
import { configDir, ensureDir, sessionsDir } from '../config/paths.ts';
import type { Message } from '../types.ts';
import { messageText } from '../types.ts';

type Entry =
  | { type: 'meta'; sessionId: string; cwd: string; version: string; model?: string; ts: string }
  | { type: 'message'; message: Message; ts: string }
  | { type: 'compact'; messages: Message[]; ts: string }
  | { type: 'truncate'; length: number; ts: string };

/**
 * Append-only JSONL transcript. Compaction and rewinds are recorded as
 * entries, so replaying the file reproduces the conversation as it stood.
 */
export class Transcript implements TranscriptSink {
  readonly path: string;
  private readonly header: Entry;
  private started = false;
  private readonly enabled: boolean;

  constructor(cwd: string, sessionId: string, version: string, opts: { persist?: boolean; model?: string; existing?: boolean } = {}) {
    this.path = path.join(sessionsDir(cwd), `${sessionId}.jsonl`);
    this.header = { type: 'meta', sessionId, cwd, version, model: opts.model, ts: new Date().toISOString() };
    this.enabled = opts.persist ?? true;
    this.started = Boolean(opts.existing);
  }

  private write(entry: Entry): void {
    if (!this.enabled) return;
    try {
      if (!this.started) {
        ensureDir(path.dirname(this.path));
        fs.appendFileSync(this.path, JSON.stringify(this.header) + '\n');
        this.started = true;
      }
      fs.appendFileSync(this.path, JSON.stringify(entry) + '\n');
    } catch {
      // A read-only home directory must not break the session.
    }
  }

  message(message: Message): void {
    this.write({ type: 'message', message, ts: new Date().toISOString() });
  }

  compacted(messages: Message[]): void {
    this.write({ type: 'compact', messages, ts: new Date().toISOString() });
  }

  /** Record that the conversation was cut back to `length` messages (rewind). */
  truncate(length: number): void {
    this.write({ type: 'truncate', length, ts: new Date().toISOString() });
  }
}

export interface LoadedSession {
  id: string;
  messages: Message[];
  cwd?: string;
  model?: string;
}

export function loadSession(file: string): LoadedSession {
  const id = path.basename(file, '.jsonl');
  let messages: Message[] = [];
  let cwd: string | undefined;
  let model: string | undefined;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // a torn last line after a crash
    }
    if (entry.type === 'meta') {
      cwd = entry.cwd;
      model = entry.model;
    } else if (entry.type === 'message') messages.push(entry.message);
    else if (entry.type === 'compact') messages = [...entry.messages];
    else if (entry.type === 'truncate') messages = messages.slice(0, entry.length);
  }
  return { id, messages: repairMessages(messages), cwd, model };
}

/**
 * Make a loaded history valid for a model again: every tool call needs a
 * result, which a crash or kill mid-turn can leave missing.
 */
export function repairMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    out.push(msg);
    if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      answered.add((messages[j] as Extract<Message, { role: 'tool' }>).toolCallId);
      out.push(messages[j]!);
      j++;
    }
    for (const call of msg.toolCalls) {
      if (!answered.has(call.id)) {
        out.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'No result: the session ended before this tool finished.', isError: true });
      }
    }
    i = j - 1;
  }
  return out;
}

export interface SessionSummary {
  id: string;
  path: string;
  modifiedAt: Date;
  firstPrompt: string;
  messageCount: number;
}

function summarizeFile(file: string): SessionSummary | undefined {
  try {
    const stat = fs.statSync(file);
    const loaded = loadSession(file);
    const prompts = loaded.messages.filter((m) => m.role === 'user' && !m.isMeta);
    if (prompts.length === 0) return undefined;
    const first = messageText((prompts[0] as Extract<Message, { role: 'user' }>).content);
    return {
      id: loaded.id,
      path: file,
      modifiedAt: stat.mtime,
      firstPrompt: first.split('\n<attached-files>')[0]!.replace(/\s+/g, ' ').trim().slice(0, 200),
      messageCount: loaded.messages.length,
    };
  } catch {
    return undefined;
  }
}

/** Sessions for a working directory, newest first. */
export function listSessions(cwd: string, limit = 50): SessionSummary[] {
  const dir = sessionsDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const withTime = files
    .map((f) => {
      const full = path.join(dir, f);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit * 2);
  const out: SessionSummary[] = [];
  for (const { full } of withTime) {
    const summary = summarizeFile(full);
    if (summary) out.push(summary);
    if (out.length >= limit) break;
  }
  return out;
}

/** Look a session up by full id or unique prefix. */
export function findSession(cwd: string, idOrPrefix: string): SessionSummary | undefined {
  const all = listSessions(cwd, 500);
  return all.find((s) => s.id === idOrPrefix) ?? (idOrPrefix.length >= 4 ? all.find((s) => s.id.startsWith(idOrPrefix)) : undefined);
}

/** Delete transcripts and file checkpoints older than `days`. */
export function cleanupOldSessions(days: number): void {
  if (!(days > 0)) return;
  const cutoff = Date.now() - days * 86_400_000;
  const sweep = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (entry.isDirectory()) {
          if (depth > 0) sweep(full, depth - 1);
          else if (stat.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
        } else if (stat.mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
        }
      } catch {
        // raced with another process
      }
    }
  };
  sweep(path.join(configDir(), 'projects'), 1);
  sweep(path.join(configDir(), 'file-history'), 0);
}

/** Markdown export of a conversation, for /export. */
export function exportMarkdown(messages: Message[], title: string): string {
  const parts: string[] = [`# ${title}`, ''];
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.isMeta) continue;
      parts.push('## User', '', messageText(msg.content).split('\n<attached-files>')[0]!.trim(), '');
    } else if (msg.role === 'assistant') {
      if (msg.content.trim()) parts.push('## Assistant', '', msg.content.trim(), '');
      for (const call of msg.toolCalls ?? []) {
        parts.push(`**Tool call:** \`${call.name}\``, '', '```json', JSON.stringify(call.arguments, null, 2), '```', '');
      }
    } else {
      const body = msg.content.length > 4000 ? `${msg.content.slice(0, 4000)}\n… [truncated]` : msg.content;
      parts.push(`**Result${msg.isError ? ' (error)' : ''}:**`, '', '```', body, '```', '');
    }
  }
  return parts.join('\n');
}
