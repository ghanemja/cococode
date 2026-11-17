import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { configDir, fileHistoryDir, sessionsDir } from '../src/config/paths.ts';
import { Checkpoints } from '../src/session/checkpoints.ts';
import { SessionState, isInside, realpathSafe } from '../src/session/state.ts';
import { Transcript, cleanupOldSessions, exportMarkdown, findSession, listSessions, loadSession, repairMessages } from '../src/session/store.ts';
import type { Message } from '../src/types.ts';
import { tempProject, writeFiles } from './helpers.ts';

const posix = process.platform !== 'win32';
let root: string;

beforeEach(() => {
  root = tempProject();
});

function user(content: string, extra: Partial<Extract<Message, { role: 'user' }>> = {}): Message {
  return { role: 'user', content, ...extra };
}

function assistant(content: string, calls: { id: string; name: string; arguments?: Record<string, unknown> }[] = []): Message {
  const msg: Message = { role: 'assistant', content };
  if (calls.length) msg.toolCalls = calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments ?? {} }));
  return msg;
}

function result(id: string, name: string, content = 'ok'): Message {
  return { role: 'tool', toolCallId: id, name, content };
}

function setAge(file: string, daysAgo: number): void {
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  fs.utimesSync(file, when, when);
}

/** Write a session with the given messages and return its file. */
function writeSession(id: string, messages: Message[], secondsAgo = 0): string {
  const t = new Transcript(root, id, '1.0.0');
  for (const m of messages) t.message(m);
  if (secondsAgo && fs.existsSync(t.path)) {
    const when = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(t.path, when, when);
  }
  return t.path;
}

describe('Transcript', () => {
  test('nothing is written until the first message', () => {
    const t = new Transcript(root, 'abc', '1.0.0', { model: 'qwen' });
    assert.equal(t.path, path.join(sessionsDir(root), 'abc.jsonl'));
    assert.equal(fs.existsSync(t.path), false);
    assert.equal(fs.existsSync(sessionsDir(root)), false);
    t.message(user('hello'));
    assert.equal(fs.existsSync(t.path), true);
  });

  test('the file starts with a header describing the session', () => {
    const t = new Transcript(root, 'abc', '1.2.3', { model: 'qwen3:8b' });
    t.message(user('hello'));
    const entries = fs
      .readFileSync(t.path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.type, 'meta');
    assert.equal(entries[0]!.sessionId, 'abc');
    assert.equal(entries[0]!.cwd, root);
    assert.equal(entries[0]!.version, '1.2.3');
    assert.equal(entries[0]!.model, 'qwen3:8b');
    assert.equal(entries[1]!.type, 'message');
    assert.ok(!Number.isNaN(Date.parse(String(entries[1]!.ts))));
  });

  test('every kind of message survives a round trip', () => {
    const messages: Message[] = [
      { role: 'user', content: 'plain prompt', turn: 1 },
      { role: 'user', content: 'expanded /review prompt', display: '/review', turn: 2 },
      { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }], turn: 3 },
      { role: 'user', content: 'a hook said keep going', isMeta: true },
      {
        role: 'assistant',
        content: 'Let me look.\nUnicode: é 日本 👍 "quotes" \\ backslash',
        thinking: 'hmm',
        toolCalls: [
          { id: 'c1', name: 'Read', arguments: { file_path: 'a.ts', limit: 10 } },
          { id: 'c2', name: 'Bash', arguments: { command: 'echo "hi"\n' }, parseError: 'bad json' },
        ],
        usage: { inputTokens: 120, outputTokens: 30, evalMs: 500, tokensPerSecond: 60 },
        model: 'qwen',
        stopReason: 'tool_calls',
      },
      { role: 'tool', toolCallId: 'c1', name: 'Read', content: '     1\tline one\n     2\tline two' },
      { role: 'tool', toolCallId: 'c2', name: 'Bash', content: 'failed', isError: true, images: [{ type: 'image', mediaType: 'image/jpeg', data: '/9j/' }] },
      { role: 'assistant', content: 'Done.', stopReason: 'stop' },
    ];
    const file = writeSession('round-trip', messages);
    const loaded = loadSession(file);
    assert.equal(loaded.id, 'round-trip');
    assert.equal(loaded.cwd, root);
    assert.deepEqual(loaded.messages, messages);
  });

  test('a compaction replaces everything before it', () => {
    const t = new Transcript(root, 'compact', '1.0.0');
    t.message(user('one'));
    t.message(assistant('answer one'));
    t.compacted([user('summary of earlier work', { isMeta: true }), user('two')]);
    t.message(assistant('answer two'));
    assert.deepEqual(loadSession(t.path).messages, [user('summary of earlier work', { isMeta: true }), user('two'), assistant('answer two')]);
  });

  test('a rewind cuts the conversation back and later messages follow it', () => {
    const t = new Transcript(root, 'rewind', '1.0.0');
    t.message(user('one'));
    t.message(assistant('answer one'));
    t.message(user('two'));
    t.message(assistant('answer two'));
    t.truncate(2);
    t.message(user('two, rephrased'));
    assert.deepEqual(loadSession(t.path).messages, [user('one'), assistant('answer one'), user('two, rephrased')]);
  });

  test('compaction and rewinds replay in the order they happened', () => {
    const t = new Transcript(root, 'mixed', '1.0.0');
    t.message(user('a'));
    t.message(assistant('b'));
    t.truncate(0);
    t.message(user('c'));
    t.compacted([user('summary', { isMeta: true })]);
    t.message(user('d'));
    t.message(assistant('e'));
    t.truncate(2);
    assert.deepEqual(loadSession(t.path).messages, [user('summary', { isMeta: true }), user('d')]);
  });

  test('a torn last line and blank lines are tolerated', () => {
    const file = writeSession('torn', [user('one'), assistant('answer')]);
    fs.appendFileSync(file, '\n\n{"type":"message","message":{"role":"user","content":"cut off mid-wri');
    assert.deepEqual(loadSession(file).messages, [user('one'), assistant('answer')]);
  });

  test('persist: false writes nothing', () => {
    const t = new Transcript(root, 'ghost', '1.0.0', { persist: false });
    t.message(user('hello'));
    t.compacted([]);
    t.truncate(0);
    assert.equal(fs.existsSync(t.path), false);
  });

  test('continuing an existing transcript does not write a second header', () => {
    const file = writeSession('resumed', [user('one')]);
    const again = new Transcript(root, 'resumed', '1.0.0', { existing: true });
    again.message(assistant('two'));
    const types = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    assert.deepEqual(types, ['meta', 'message', 'message']);
    assert.deepEqual(loadSession(file).messages, [user('one'), assistant('two')]);
  });

  test('an unwritable location does not break the session', () => {
    // A file where the sessions directory should be makes every write fail.
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(path.join(configDir(), 'projects'), 'in the way');
    const t = new Transcript(root, 'blocked', '1.0.0');
    assert.doesNotThrow(() => {
      t.message(user('hello'));
      t.compacted([]);
      t.truncate(0);
    });
    assert.deepEqual(listSessions(root), []);
  });
});

describe('repairMessages', () => {
  test('a complete history is returned unchanged', () => {
    const messages = [user('go'), assistant('', [{ id: 'a', name: 'Read' }]), result('a', 'Read'), assistant('done')];
    assert.deepEqual(repairMessages(messages), messages);
  });

  test('missing results are added, answered calls are left alone', () => {
    const messages = [
      user('go'),
      assistant('', [
        { id: 'a', name: 'Read' },
        { id: 'b', name: 'Bash' },
        { id: 'c', name: 'Grep' },
      ]),
      result('b', 'Bash', 'real output'),
    ];
    const repaired = repairMessages(messages);
    assert.equal(repaired.length, 5);
    assert.deepEqual(repaired[2], result('b', 'Bash', 'real output'));
    const added = repaired.slice(3) as Extract<Message, { role: 'tool' }>[];
    assert.deepEqual(
      added.map((m) => [m.toolCallId, m.name, m.isError]),
      [
        ['a', 'Read', true],
        ['c', 'Grep', true],
      ],
    );
    assert.match(added[0]!.content, /session ended/);
  });

  test('a session that died straight after the tool calls', () => {
    const repaired = repairMessages([user('go'), assistant('working', [{ id: 'a', name: 'Bash' }])]);
    assert.equal(repaired.length, 3);
    assert.equal(repaired[2]!.role, 'tool');
  });

  test('results are inserted before the next message, not at the end', () => {
    const messages = [user('go'), assistant('', [{ id: 'a', name: 'Bash' }]), user('are you there?'), assistant('yes')];
    const repaired = repairMessages(messages);
    assert.deepEqual(
      repaired.map((m) => m.role),
      ['user', 'assistant', 'tool', 'user', 'assistant'],
    );
  });

  test('several rounds are each repaired', () => {
    const messages = [
      user('go'),
      assistant('', [{ id: 'a', name: 'Read' }]),
      result('a', 'Read'),
      assistant('', [
        { id: 'b', name: 'Edit' },
        { id: 'c', name: 'Bash' },
      ]),
      result('c', 'Bash'),
    ];
    const repaired = repairMessages(messages);
    assert.deepEqual(
      repaired.map((m) => (m.role === 'tool' ? m.toolCallId : m.role)),
      ['user', 'assistant', 'a', 'assistant', 'c', 'b'],
    );
  });

  test('results that answer no call are dropped', () => {
    const messages = [result('orphan', 'Read'), user('go'), assistant('', [{ id: 'a', name: 'Read' }]), result('a', 'Read'), result('stray', 'Bash'), result('a', 'Read', 'duplicate'), assistant('done')];
    assert.deepEqual(repairMessages(messages), [user('go'), assistant('', [{ id: 'a', name: 'Read' }]), result('a', 'Read'), assistant('done')]);
  });

  test('two calls that share an id each keep a result', () => {
    const messages = [
      assistant('', [
        { id: 'same', name: 'Read' },
        { id: 'same', name: 'Grep' },
      ]),
      result('same', 'Read', 'first'),
      result('same', 'Grep', 'second'),
    ];
    assert.deepEqual(repairMessages(messages), messages);
    assert.equal(repairMessages(messages.slice(0, 2)).length, 3);
  });

  test('the input is not modified', () => {
    const messages = [user('go'), assistant('', [{ id: 'a', name: 'Bash' }])];
    const copy = structuredClone(messages);
    repairMessages(messages);
    assert.deepEqual(messages, copy);
  });

  test('loading a transcript repairs it', () => {
    const file = writeSession('crashed', [user('go'), assistant('', [{ id: 'a', name: 'Bash', arguments: { command: 'sleep 100' } }])]);
    const loaded = loadSession(file);
    assert.equal(loaded.messages.length, 3);
    assert.equal(loaded.messages[2]!.role, 'tool');
  });
});

describe('listSessions / findSession', () => {
  test('no sessions directory yet', () => {
    assert.deepEqual(listSessions(root), []);
    assert.equal(findSession(root, 'anything'), undefined);
  });

  test('newest first, with the first real prompt as the title', () => {
    writeSession('11111111-old', [user('fix the login bug'), assistant('ok')], 3000);
    writeSession('22222222-new', [user('add dark mode'), assistant('ok'), user('and tests'), assistant('done')], 10);
    writeSession('33333333-mid', [user('explain the build'), assistant('ok')], 500);
    const sessions = listSessions(root);
    assert.deepEqual(
      sessions.map((s) => s.id),
      ['22222222-new', '33333333-mid', '11111111-old'],
    );
    assert.deepEqual(
      sessions.map((s) => s.firstPrompt),
      ['add dark mode', 'explain the build', 'fix the login bug'],
    );
    assert.deepEqual(
      sessions.map((s) => s.messageCount),
      [4, 2, 2],
    );
    assert.ok(sessions[0]!.modifiedAt > sessions[2]!.modifiedAt);
    assert.equal(sessions[0]!.path, path.join(sessionsDir(root), '22222222-new.jsonl'));
  });

  test('the title is what the user typed', () => {
    writeSession('attach', [user('look at @a.ts\n\n<attached-files>\n<file path="a.ts">\nconst x = 1;\n</file>\n</attached-files>')]);
    writeSession('command', [user('Review the code changes described below as a careful senior engineer would...', { display: '/review main' })]);
    writeSession('meta-first', [user('<session-start-hook>context</session-start-hook>', { isMeta: true }), user('real   prompt\nwith  spacing')]);
    writeSession('parts', [{ role: 'user', content: [{ type: 'text', text: 'describe this image' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] }]);
    writeSession('long', [user('x'.repeat(500))]);
    const titles = Object.fromEntries(listSessions(root).map((s) => [s.id, s.firstPrompt]));
    assert.equal(titles.attach, 'look at @a.ts');
    assert.equal(titles.command, '/review main');
    assert.equal(titles['meta-first'], 'real prompt with spacing');
    assert.equal(titles.parts, 'describe this image');
    assert.equal(titles.long!.length, 200);
  });

  test('sessions without a real prompt are left out', () => {
    writeSession('only-meta', [user('hook context', { isMeta: true })]);
    writeSession('real', [user('hello')]);
    const dir = sessionsDir(root);
    fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'garbage.jsonl'), 'not json at all\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a transcript');
    assert.deepEqual(
      listSessions(root).map((s) => s.id),
      ['real'],
    );
  });

  test('the limit is respected', () => {
    for (let i = 0; i < 6; i++) writeSession(`session-${i}`, [user(`prompt ${i}`)], (6 - i) * 60);
    assert.deepEqual(
      listSessions(root, 3).map((s) => s.id),
      ['session-5', 'session-4', 'session-3'],
    );
  });

  test('directories whose names flatten alike do not share sessions', () => {
    const dashed = path.join(root, 'my-app');
    const nested = path.join(root, 'my', 'app');
    fs.mkdirSync(dashed);
    fs.mkdirSync(nested, { recursive: true });
    new Transcript(dashed, 'in-dashed', '1.0.0').message(user('dashed work'));
    new Transcript(nested, 'in-nested', '1.0.0').message(user('nested work'));
    assert.deepEqual(
      listSessions(dashed).map((s) => s.id),
      ['in-dashed'],
    );
    assert.deepEqual(
      listSessions(nested).map((s) => s.id),
      ['in-nested'],
    );
    assert.equal(findSession(nested, 'in-dashed'), undefined);
  });

  test('sessions are kept apart per working directory', () => {
    const other = path.join(root, 'other-project');
    fs.mkdirSync(other);
    new Transcript(other, 'elsewhere', '1.0.0').message(user('other work'));
    writeSession('here', [user('this work')]);
    assert.deepEqual(
      listSessions(root).map((s) => s.id),
      ['here'],
    );
    assert.deepEqual(
      listSessions(other).map((s) => s.id),
      ['elsewhere'],
    );
  });

  test('find by full id or by a prefix of at least four characters', () => {
    writeSession('abcd1234-0000', [user('first')], 100);
    writeSession('abzz9999-0000', [user('second')], 50);
    assert.equal(findSession(root, 'abcd1234-0000')?.firstPrompt, 'first');
    assert.equal(findSession(root, 'abcd')?.id, 'abcd1234-0000');
    assert.equal(findSession(root, 'abzz99')?.id, 'abzz9999-0000');
    assert.equal(findSession(root, 'abc'), undefined);
    assert.equal(findSession(root, 'zzzz'), undefined);
    assert.equal(findSession(root, ''), undefined);
  });
});

describe('cleanupOldSessions', () => {
  test('removes old transcripts and checkpoints, keeps recent ones', () => {
    const oldFile = writeSession('old', [user('old')]);
    const newFile = writeSession('new', [user('new')]);
    setAge(oldFile, 45);
    setAge(newFile, 5);
    const oldHistory = fileHistoryDir('old');
    const newHistory = fileHistoryDir('new');
    writeFiles(oldHistory, { 'index.json': '[]', 'abc@1': 'backup' });
    writeFiles(newHistory, { 'index.json': '[]' });
    setAge(oldHistory, 45);
    setAge(newHistory, 5);

    cleanupOldSessions(30);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
    assert.equal(fs.existsSync(oldHistory), false);
    assert.equal(fs.existsSync(newHistory), true);
    assert.deepEqual(
      listSessions(root).map((s) => s.id),
      ['new'],
    );
  });

  test('zero or negative days means keep everything', () => {
    const file = writeSession('ancient', [user('old')]);
    setAge(file, 4000);
    cleanupOldSessions(0);
    cleanupOldSessions(-1);
    cleanupOldSessions(Number.NaN);
    assert.equal(fs.existsSync(file), true);
  });

  test('nothing to clean is not an error', () => {
    assert.doesNotThrow(() => cleanupOldSessions(30));
  });
});

describe('exportMarkdown', () => {
  test('renders the visible conversation', () => {
    const md = exportMarkdown(
      [
        user('fix @a.ts\n\n<attached-files>\n<file path="a.ts">secret contents</file>\n</attached-files>'),
        user('hook feedback', { isMeta: true }),
        assistant('Reading it.', [{ id: 'a', name: 'Read', arguments: { file_path: 'a.ts' } }]),
        result('a', 'Read', '     1\tconst x = 1;'),
        { role: 'tool', toolCallId: 'b', name: 'Bash', content: 'boom', isError: true },
        assistant('Fixed.'),
        assistant(''),
      ],
      'My session',
    );
    assert.ok(md.startsWith('# My session\n'));
    assert.ok(md.includes('## User\n\nfix @a.ts\n'));
    assert.ok(!md.includes('secret contents'));
    assert.ok(!md.includes('hook feedback'));
    assert.ok(md.includes('## Assistant\n\nReading it.\n'));
    assert.ok(md.includes('**Tool call:** `Read`'));
    assert.ok(md.includes('"file_path": "a.ts"'));
    assert.ok(md.includes('**Result:**\n\n```\n     1\tconst x = 1;\n```'));
    assert.ok(md.includes('**Result (error):**\n\n```\nboom\n```'));
    assert.ok(md.includes('## Assistant\n\nFixed.\n'));
    assert.equal(md.match(/## Assistant/g)!.length, 2);
  });

  test('long tool results are truncated', () => {
    const md = exportMarkdown([result('a', 'Bash', 'y'.repeat(10_000))], 't');
    assert.ok(md.includes('[truncated]'));
    assert.ok(md.length < 5000);
  });
});

describe('Checkpoints', () => {
  let dir: string;
  let work: string;

  beforeEach(() => {
    dir = path.join(root, 'history');
    work = path.join(root, 'work');
    fs.mkdirSync(work);
  });

  const file = (name: string) => path.join(work, name);
  const read = (name: string) => fs.readFileSync(file(name), 'utf8');
  /** What the file tools do: snapshot, then write. */
  function edit(cp: Checkpoints, name: string, turn: number, content: string): void {
    cp.track(file(name), turn);
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), content);
  }

  test('rewind restores the content from before the turn', () => {
    writeFiles(work, { 'a.txt': 'original' });
    const cp = new Checkpoints(dir);
    edit(cp, 'a.txt', 1, 'changed');
    assert.deepEqual(cp.changedSince(1), [file('a.txt')]);
    const res = cp.rewindTo(1);
    assert.deepEqual(res, { restored: [file('a.txt')], failed: [] });
    assert.equal(read('a.txt'), 'original');
    assert.deepEqual(cp.changedSince(1), []);
  });

  test('a file created during the session is deleted by a rewind', () => {
    const cp = new Checkpoints(dir);
    edit(cp, 'new.txt', 2, 'brand new');
    edit(cp, 'deep/er/nested.txt', 2, 'also new');
    cp.rewindTo(2);
    assert.equal(fs.existsSync(file('new.txt')), false);
    assert.equal(fs.existsSync(file('deep/er/nested.txt')), false);
  });

  test('a file deleted after an edit is recreated, with its directories', () => {
    writeFiles(work, { 'src/lib/util.ts': 'v0' });
    const cp = new Checkpoints(dir);
    edit(cp, 'src/lib/util.ts', 1, 'v1');
    fs.rmSync(path.join(work, 'src'), { recursive: true });
    cp.rewindTo(1);
    assert.equal(read('src/lib/util.ts'), 'v0');
  });

  test('several edits in one turn restore to the state before the turn', () => {
    writeFiles(work, { 'a.txt': 'v0' });
    const cp = new Checkpoints(dir);
    edit(cp, 'a.txt', 1, 'v1');
    edit(cp, 'a.txt', 1, 'v2');
    edit(cp, 'a.txt', 1, 'v3');
    cp.rewindTo(1);
    assert.equal(read('a.txt'), 'v0');
  });

  for (const target of [1, 2, 3, 4]) {
    test(`edits across turns: rewinding to turn ${target} gives the version from before it`, () => {
      writeFiles(work, { 'a.txt': 'v0', 'b.txt': 'b0' });
      const cp = new Checkpoints(dir);
      edit(cp, 'a.txt', 1, 'v1');
      edit(cp, 'a.txt', 2, 'v2');
      edit(cp, 'b.txt', 2, 'b2');
      edit(cp, 'a.txt', 3, 'v3');
      edit(cp, 'c.txt', 3, 'c3');
      const res = cp.rewindTo(target);
      const expected = [
        { a: 'v0', b: 'b0', c: false, restored: 3 },
        { a: 'v1', b: 'b0', c: false, restored: 3 },
        { a: 'v2', b: 'b2', c: false, restored: 2 },
        { a: 'v3', b: 'b2', c: true, restored: 0 },
      ][target - 1]!;
      assert.equal(read('a.txt'), expected.a);
      assert.equal(read('b.txt'), expected.b);
      assert.equal(fs.existsSync(file('c.txt')), expected.c);
      assert.equal(res.restored.length, expected.restored);
      assert.deepEqual(res.failed, []);
    });
  }

  test('rewinding in steps works like rewinding at once', () => {
    writeFiles(work, { 'a.txt': 'v0' });
    const cp = new Checkpoints(dir);
    edit(cp, 'a.txt', 1, 'v1');
    edit(cp, 'a.txt', 2, 'v2');
    edit(cp, 'a.txt', 3, 'v3');
    cp.rewindTo(3);
    assert.equal(read('a.txt'), 'v2');
    cp.rewindTo(2);
    assert.equal(read('a.txt'), 'v1');
    cp.rewindTo(1);
    assert.equal(read('a.txt'), 'v0');
    assert.deepEqual(cp.rewindTo(1), { restored: [], failed: [] });
  });

  test('editing again after a rewind is tracked afresh', () => {
    writeFiles(work, { 'a.txt': 'v0' });
    const cp = new Checkpoints(dir);
    edit(cp, 'a.txt', 1, 'v1');
    edit(cp, 'a.txt', 2, 'v2');
    cp.rewindTo(2);
    edit(cp, 'a.txt', 2, 'v2 again');
    cp.rewindTo(2);
    assert.equal(read('a.txt'), 'v1');
  });

  test('changedSince lists each file once and only from that turn on', () => {
    writeFiles(work, { 'a.txt': '', 'b.txt': '', 'c.txt': '' });
    const cp = new Checkpoints(dir);
    edit(cp, 'a.txt', 1, 'x');
    edit(cp, 'b.txt', 2, 'x');
    edit(cp, 'a.txt', 3, 'y');
    edit(cp, 'c.txt', 3, 'x');
    assert.deepEqual(cp.changedSince(1).sort(), [file('a.txt'), file('b.txt'), file('c.txt')]);
    assert.deepEqual(cp.changedSince(2).sort(), [file('a.txt'), file('b.txt'), file('c.txt')]);
    assert.deepEqual(cp.changedSince(3).sort(), [file('a.txt'), file('c.txt')]);
    assert.deepEqual(cp.changedSince(4), []);
    assert.equal(cp.lastTurn(), 3);
  });

  test('state survives a new instance on the same directory', () => {
    writeFiles(work, { 'a.txt': 'v0' });
    const first = new Checkpoints(dir);
    edit(first, 'a.txt', 1, 'v1');
    edit(first, 'b.txt', 2, 'new in turn 2');

    const second = new Checkpoints(dir);
    assert.deepEqual(second.changedSince(1).sort(), [file('a.txt'), file('b.txt')]);
    assert.equal(second.lastTurn(), 2);
    // Already snapshotted in turn 1: a later instance must not overwrite the backup.
    edit(second, 'a.txt', 1, 'v1b');
    second.rewindTo(1);
    assert.equal(read('a.txt'), 'v0');
    assert.equal(fs.existsSync(file('b.txt')), false);
    assert.deepEqual(new Checkpoints(dir).changedSince(0), []);
  });

  test('binary content is restored byte for byte', () => {
    const bytes = Buffer.from([0, 255, 1, 254, 13, 10, 0, 128, 200]);
    fs.writeFileSync(file('blob.bin'), bytes);
    const cp = new Checkpoints(dir);
    edit(cp, 'blob.bin', 1, 'text now');
    cp.rewindTo(1);
    assert.deepEqual(fs.readFileSync(file('blob.bin')), bytes);
  });

  test('an executable stays executable after a rewind', { skip: !posix }, () => {
    fs.writeFileSync(file('run.sh'), '#!/bin/sh\necho v0\n', { mode: 0o755 });
    fs.chmodSync(file('run.sh'), 0o755);
    const cp = new Checkpoints(dir);
    edit(cp, 'run.sh', 1, '#!/bin/sh\necho v1\n');
    fs.rmSync(file('run.sh'));
    cp.rewindTo(1);
    assert.equal(read('run.sh'), '#!/bin/sh\necho v0\n');
    assert.equal(fs.statSync(file('run.sh')).mode & 0o777, 0o755);
  });

  test('two files with the same name in different directories do not collide', () => {
    writeFiles(work, { 'x/index.ts': 'x0', 'y/index.ts': 'y0' });
    const cp = new Checkpoints(dir);
    edit(cp, 'x/index.ts', 1, 'x1');
    edit(cp, 'y/index.ts', 1, 'y1');
    cp.rewindTo(1);
    assert.equal(read('x/index.ts'), 'x0');
    assert.equal(read('y/index.ts'), 'y0');
  });

  test('tracking a directory or an unreadable path records nothing', () => {
    fs.mkdirSync(file('folder'));
    const cp = new Checkpoints(dir);
    cp.track(file('folder'), 1);
    assert.deepEqual(cp.changedSince(0), []);
    assert.deepEqual(cp.rewindTo(0), { restored: [], failed: [] });
    assert.equal(fs.existsSync(file('folder')), true);
  });

  test('a file that cannot be restored is reported and can be retried', () => {
    writeFiles(work, { 'blocked/a.txt': 'v0', 'b.txt': 'b0' });
    const cp = new Checkpoints(dir);
    edit(cp, 'blocked/a.txt', 1, 'v1');
    edit(cp, 'b.txt', 1, 'b1');
    // Replace the directory with a file, so the old path cannot be recreated.
    fs.rmSync(file('blocked'), { recursive: true });
    fs.writeFileSync(file('blocked'), 'now a file');
    const res = cp.rewindTo(1);
    assert.deepEqual(res.failed, [file('blocked/a.txt')]);
    assert.deepEqual(res.restored, [file('b.txt')]);
    assert.equal(read('b.txt'), 'b0');
    // The snapshot is kept, so once the obstacle is gone a retry succeeds.
    assert.deepEqual(cp.changedSince(1), [file('blocked/a.txt')]);
    fs.rmSync(file('blocked'));
    assert.deepEqual(cp.rewindTo(1), { restored: [file('blocked/a.txt')], failed: [] });
    assert.equal(read('blocked/a.txt'), 'v0');
    assert.deepEqual(cp.changedSince(1), []);
  });

  test('a corrupt index is treated as empty', () => {
    writeFiles(dir, { 'index.json': '{"not": "a list"' });
    assert.deepEqual(new Checkpoints(dir).changedSince(0), []);
    writeFiles(dir, { 'index.json': '{"not": "a list"}' });
    assert.deepEqual(new Checkpoints(dir).changedSince(0), []);
    writeFiles(dir, { 'index.json': '[null, 5, {"turn": "x"}, {"turn": 1, "path": "/p", "backup": null}]' });
    assert.deepEqual(new Checkpoints(dir).changedSince(0), ['/p']);
  });
});

describe('SessionState', () => {
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  test('starts in the project root with a fresh id', () => {
    const a = new SessionState({ cwd: root, settings: {} });
    const b = new SessionState({ cwd: root, settings: {} });
    assert.equal(a.cwd, root);
    assert.equal(a.projectRoot, root);
    assert.notEqual(a.id, b.id);
    assert.match(a.id, /^[0-9a-f-]{36}$/);
    assert.equal(new SessionState({ id: 'given', cwd: root, settings: {} }).id, 'given');
    assert.deepEqual(a.workingDirs(), [root]);
    assert.equal(a.turn, 0);
    assert.equal(a.vision, false);
  });

  test('a relative cwd is resolved', () => {
    const s = new SessionState({ cwd: path.relative(process.cwd(), root) || '.', settings: {} });
    assert.equal(s.projectRoot, root);
  });

  test('inWorkingDirs: inside, outside and look-alike siblings', () => {
    writeFiles(root, { 'src/a.ts': '' });
    const s = new SessionState({ cwd: root, settings: {} });
    assert.equal(s.inWorkingDirs(root), true);
    assert.equal(s.inWorkingDirs(path.join(root, 'src', 'a.ts')), true);
    assert.equal(s.inWorkingDirs(path.join(root, 'not', 'yet', 'created.ts')), true);
    assert.equal(s.inWorkingDirs(path.dirname(root)), false);
    assert.equal(s.inWorkingDirs(path.join(root, '..', 'elsewhere.txt')), false);
    assert.equal(s.inWorkingDirs(path.join(root, 'src', '..', '..', 'escape.txt')), false);
    assert.equal(s.inWorkingDirs(`${root}-sibling/file.txt`), false);
    assert.equal(s.inWorkingDirs('/etc/passwd'), false);
    assert.equal(s.inWorkingDirs(path.join(root, 'src', '..', 'src', 'a.ts')), true);
    assert.equal(s.inWorkingDirs(path.join(root, '..cache', 'x')), true);
  });

  test('moving the session cwd does not move the project root', () => {
    writeFiles(root, { 'sub/x.ts': '' });
    const s = new SessionState({ cwd: root, settings: {} });
    s.cwd = path.join(root, 'sub');
    assert.equal(s.projectRoot, root);
    assert.equal(s.inWorkingDirs(path.join(root, 'top-level.ts')), true);
  });

  test('added directories widen the working area', () => {
    const extra = path.join(path.dirname(root), `${path.basename(root)}-extra`);
    fs.mkdirSync(path.join(extra, 'lib'), { recursive: true });
    try {
      const s = new SessionState({ cwd: root, settings: {} });
      assert.equal(s.inWorkingDirs(path.join(extra, 'lib', 'x.ts')), false);
      assert.equal(s.addDir(extra), extra);
      assert.equal(s.addDir(extra), extra);
      assert.deepEqual(s.workingDirs(), [root, extra]);
      assert.equal(s.inWorkingDirs(path.join(extra, 'lib', 'x.ts')), true);
      assert.equal(s.inWorkingDirs(path.join(extra, '..', 'other')), false);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  test('relative and home-relative directories are resolved', () => {
    process.env.HOME = path.join(root, 'home');
    fs.mkdirSync(path.join(root, 'home', 'notes'), { recursive: true });
    const s = new SessionState({ cwd: path.join(root, 'home'), settings: {} });
    assert.equal(s.addDir('../sibling'), path.join(root, 'sibling'));
    assert.equal(s.addDir('~/notes'), path.join(root, 'home', 'notes'));
  });

  test('additionalDirectories from settings are applied', () => {
    const extra = path.join(root, 'vendor');
    const s = new SessionState({ cwd: path.join(root, 'app'), settings: { permissions: { additionalDirectories: [extra, '../shared'] } } });
    assert.deepEqual(s.workingDirs(), [path.join(root, 'app'), extra, path.join(root, 'shared')]);
    assert.equal(s.inWorkingDirs(path.join(extra, 'lib.js')), true);
    assert.equal(s.inWorkingDirs(path.join(root, 'shared', 'x')), true);
    assert.equal(s.inWorkingDirs(path.join(root, 'other', 'x')), false);
  });

  describe('symlinks', { skip: !posix }, () => {
    let project: string;
    let outside: string;

    beforeEach(() => {
      project = path.join(root, 'project');
      outside = path.join(root, 'outside');
      writeFiles(root, { 'project/src/a.ts': '', 'outside/secret.txt': 'secret', 'outside/dir/file.txt': '' });
    });

    test('a link inside the project that points out of it is outside', () => {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'link.txt'));
      fs.symlinkSync(path.join(outside, 'dir'), path.join(project, 'linkdir'));
      const s = new SessionState({ cwd: project, settings: {} });
      assert.equal(s.inWorkingDirs(path.join(project, 'link.txt')), false);
      assert.equal(s.inWorkingDirs(path.join(project, 'linkdir', 'file.txt')), false);
      assert.equal(s.inWorkingDirs(path.join(project, 'linkdir', 'new', 'file.txt')), false);
      assert.equal(s.inWorkingDirs(path.join(project, 'src', 'a.ts')), true);
    });

    test('a link outside the project that points into it is inside', () => {
      fs.symlinkSync(path.join(project, 'src'), path.join(outside, 'into'));
      const s = new SessionState({ cwd: project, settings: {} });
      assert.equal(s.inWorkingDirs(path.join(outside, 'into', 'a.ts')), true);
      assert.equal(s.inWorkingDirs(path.join(outside, 'into', 'new.ts')), true);
    });

    test('a link within the project is inside', () => {
      fs.symlinkSync('src', path.join(project, 'alias'));
      const s = new SessionState({ cwd: project, settings: {} });
      assert.equal(s.inWorkingDirs(path.join(project, 'alias', 'a.ts')), true);
    });

    test('a dangling link is judged by where it points', () => {
      // Writing through a dangling link creates its target.
      fs.symlinkSync(path.join(outside, 'not-created-yet.txt'), path.join(project, 'dangling-out'));
      fs.symlinkSync('../outside/relative-target.txt', path.join(project, 'dangling-rel-out'));
      fs.symlinkSync('src/not-created-yet.ts', path.join(project, 'dangling-in'));
      const s = new SessionState({ cwd: project, settings: {} });
      assert.equal(s.inWorkingDirs(path.join(project, 'dangling-out')), false);
      assert.equal(s.inWorkingDirs(path.join(project, 'dangling-rel-out')), false);
      assert.equal(s.inWorkingDirs(path.join(project, 'dangling-in')), true);
      assert.equal(realpathSafe(path.join(project, 'dangling-out')), path.join(outside, 'not-created-yet.txt'));
    });

    test('a chain of links ending outside is outside', () => {
      fs.symlinkSync(path.join(outside, 'nowhere'), path.join(project, 'hop2'));
      fs.symlinkSync('hop2', path.join(project, 'hop1'));
      const s = new SessionState({ cwd: project, settings: {} });
      assert.equal(s.inWorkingDirs(path.join(project, 'hop1')), false);
      assert.equal(s.inWorkingDirs(path.join(project, 'hop1', 'child.txt')), false);
    });

    test('a link loop does not hang', () => {
      fs.symlinkSync('loop-b', path.join(project, 'loop-a'));
      fs.symlinkSync('loop-a', path.join(project, 'loop-b'));
      const s = new SessionState({ cwd: project, settings: {} });
      assert.equal(typeof s.inWorkingDirs(path.join(project, 'loop-a', 'x')), 'boolean');
    });

    test('a project reached through a link matches its real path too', () => {
      const alias = path.join(root, 'alias-to-project');
      fs.symlinkSync(project, alias);
      const s = new SessionState({ cwd: alias, settings: {} });
      assert.equal(s.inWorkingDirs(path.join(alias, 'src', 'a.ts')), true);
      assert.equal(s.inWorkingDirs(path.join(project, 'src', 'a.ts')), true);
      assert.equal(s.inWorkingDirs(path.join(outside, 'secret.txt')), false);
    });
  });
});

describe('isInside / realpathSafe', () => {
  test('isInside', () => {
    assert.equal(isInside('/a/b', '/a/b'), true);
    assert.equal(isInside('/a/b/c', '/a/b'), true);
    assert.equal(isInside('/a/b/c/d.txt', '/a/b'), true);
    assert.equal(isInside('/a/bc', '/a/b'), false);
    assert.equal(isInside('/a/b-c/d', '/a/b'), false);
    assert.equal(isInside('/a', '/a/b'), false);
    assert.equal(isInside('/a/c', '/a/b'), false);
    assert.equal(isInside('/', '/a'), false);
    assert.equal(isInside('/a/b', '/'), true);
    assert.equal(isInside('/a/b/..hidden', '/a/b'), true);
    assert.equal(isInside('/a/b/...', '/a/b'), true);
    assert.equal(isInside('/a/b/', '/a/b'), true);
  });

  test('realpathSafe resolves the existing part and keeps the rest', { skip: !posix }, () => {
    writeFiles(root, { 'real/dir/file.txt': '' });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    assert.equal(realpathSafe(path.join(root, 'link', 'dir', 'file.txt')), path.join(root, 'real', 'dir', 'file.txt'));
    assert.equal(realpathSafe(path.join(root, 'link', 'dir', 'new', 'deep.txt')), path.join(root, 'real', 'dir', 'new', 'deep.txt'));
    assert.equal(realpathSafe(path.join(root, 'nothing', 'here')), path.join(root, 'nothing', 'here'));
    assert.equal(realpathSafe(root), root);
  });
});
