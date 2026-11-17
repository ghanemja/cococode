import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  BUILTIN_AGENTS,
  BUILTIN_STYLES,
  expandCommand,
  loadAgents,
  loadCommands,
  loadOutputStyles,
  loadSkills,
  splitArgs,
} from '../src/config/extensions.ts';
import { asList, asString, parseFrontmatter, stripBom } from '../src/util/frontmatter.ts';
import { tempProject, writeFiles } from './helpers.ts';

const BOM = String.fromCodePoint(0xfeff);

describe('parseFrontmatter', () => {
  test('scalars: strings, numbers and booleans', () => {
    const { data, body } = parseFrontmatter('---\nname: reviewer\ncount: 3\nratio: -0.5\nenabled: true\noff: false\n---\nBody text\n');
    assert.deepEqual(data, { name: 'reviewer', count: 3, ratio: -0.5, enabled: true, off: false });
    assert.equal(body, 'Body text\n');
  });

  test('values may contain colons, quoted or not', () => {
    const { data } = parseFrontmatter('---\ndescription: "Fix: the thing"\nother: Note: unquoted too\nurl: http://localhost:11434\n---\n');
    assert.equal(data.description, 'Fix: the thing');
    assert.equal(data.other, 'Note: unquoted too');
    assert.equal(data.url, 'http://localhost:11434');
  });

  test('quoted strings keep their type and unescape', () => {
    const { data } = parseFrontmatter(['---', 'a: "123"', "b: 'true'", 'c: "say \\"hi\\"\\nbye"', "d: 'it''s'", 'e: ""', '---', ''].join('\n'));
    assert.deepEqual(data, { a: '123', b: 'true', c: 'say "hi"\nbye', d: "it's", e: '' });
  });

  test('inline lists, with quoted items and nested commas', () => {
    const { data } = parseFrontmatter('---\ntools: [Read, Grep, "Bash(git log:*)"]\nmixed: [a, "b, c", \'d\']\nrules: [Bash(echo a, b), Read]\nempty: []\n---\n');
    assert.deepEqual(data.tools, ['Read', 'Grep', 'Bash(git log:*)']);
    assert.deepEqual(data.mixed, ['a', 'b, c', 'd']);
    assert.deepEqual(data.rules, ['Bash(echo a, b)', 'Read']);
    assert.deepEqual(data.empty, []);
  });

  test('block lists, indented or at the key indentation', () => {
    const { data } = parseFrontmatter('---\ntools:\n  - Read\n  - "Bash(npm test:*)"\nflush:\n- one\n- two\nname: x\n---\n');
    assert.deepEqual(data.tools, ['Read', 'Bash(npm test:*)']);
    assert.deepEqual(data.flush, ['one', 'two']);
    assert.equal(data.name, 'x');
  });

  test('comments inside a block list are skipped', () => {
    const { data } = parseFrontmatter('---\ntools:\n  # read-only\n  - Read\n  - Grep\n---\n');
    assert.deepEqual(data.tools, ['Read', 'Grep']);
  });

  test('literal block scalars keep line breaks', () => {
    const { data } = parseFrontmatter('---\ndescription: |\n  First line\n  Second line\n\n  After blank\nname: x\n---\n');
    assert.equal(data.description, 'First line\nSecond line\n\nAfter blank');
    assert.equal(data.name, 'x');
  });

  test('folded block scalars join lines with spaces', () => {
    const { data } = parseFrontmatter('---\ndescription: >\n  Use this agent when\n  the user asks for\n    a review.\nname: y\n---\n');
    assert.equal(data.description, 'Use this agent when the user asks for a review.');
    assert.equal(data.name, 'y');
  });

  test('chomping indicators are accepted', () => {
    const { data } = parseFrontmatter('---\na: |-\n  one\n  two\nb: >-\n  three\n  four\n---\n');
    assert.equal(data.a, 'one\ntwo');
    assert.equal(data.b, 'three four');
  });

  test('comments and blank lines are ignored', () => {
    const { data } = parseFrontmatter('---\n# a comment\n\nname: x\n  # indented comment\ndescription: y\n---\n');
    assert.deepEqual(data, { name: 'x', description: 'y' });
  });

  test('a key with no value is an empty string', () => {
    const { data } = parseFrontmatter('---\ndescription:\nname: x\n---\n');
    assert.deepEqual(data, { description: '', name: 'x' });
  });

  test('CRLF line endings', () => {
    const { data, body } = parseFrontmatter('---\r\nname: x\r\ntools:\r\n  - Read\r\n---\r\nBody\r\nmore\r\n');
    assert.deepEqual(data, { name: 'x', tools: ['Read'] });
    assert.equal(body, 'Body\nmore\n');
  });

  test('a byte order mark is ignored', () => {
    const { data, body } = parseFrontmatter(`${BOM}---\nname: x\n---\nBody`);
    assert.deepEqual(data, { name: 'x' });
    assert.equal(body, 'Body');
    assert.equal(stripBom(`${BOM}abc`), 'abc');
    assert.equal(stripBom('abc'), 'abc');
  });

  test('no front matter returns the text unchanged', () => {
    assert.deepEqual(parseFrontmatter('Just a prompt.\nname: not-a-key\n'), { data: {}, body: 'Just a prompt.\nname: not-a-key\n' });
    assert.deepEqual(parseFrontmatter(''), { data: {}, body: '' });
    assert.deepEqual(parseFrontmatter('\n---\nname: x\n---\nBody'), { data: {}, body: '\n---\nname: x\n---\nBody' });
  });

  test('an unterminated block is treated as body', () => {
    const text = '---\nname: x\ndescription: never closed\n\nBody text';
    assert.deepEqual(parseFrontmatter(text), { data: {}, body: text });
  });

  test('an empty block is recognised and removed', () => {
    assert.deepEqual(parseFrontmatter('---\n---\nBody'), { data: {}, body: 'Body' });
    assert.deepEqual(parseFrontmatter('---\n\n---\nBody'), { data: {}, body: 'Body' });
  });

  test('only the first closing marker ends the block; later rules stay in the body', () => {
    const { data, body } = parseFrontmatter('---\nname: x\n---\nIntro\n\n---\n\nAfter the rule\n---\nname: y\n---\n');
    assert.deepEqual(data, { name: 'x' });
    assert.equal(body, 'Intro\n\n---\n\nAfter the rule\n---\nname: y\n---\n');
  });

  test('a document that opens with a horizontal rule keeps all of its text', () => {
    const text = '---\n\nSome opening paragraph.\n\n---\n\nThe rest.\n';
    assert.deepEqual(parseFrontmatter(text), { data: {}, body: text });
  });

  test('a closing marker without a trailing newline', () => {
    assert.deepEqual(parseFrontmatter('---\nname: x\n---'), { data: { name: 'x' }, body: '' });
  });

  test('trailing whitespace on the markers and values', () => {
    const { data, body } = parseFrontmatter('--- \nname:   spaced   \n---\t\nBody');
    assert.deepEqual(data, { name: 'spaced' });
    assert.equal(body, 'Body');
  });

  test('later duplicate keys win', () => {
    assert.equal(parseFrontmatter('---\nname: a\nname: b\n---\n').data.name, 'b');
  });
});

describe('asList / asString', () => {
  test('comma-separated strings and lists', () => {
    assert.deepEqual(asList('Read, Grep ,Glob'), ['Read', 'Grep', 'Glob']);
    assert.deepEqual(asList(['Read ', ' Grep', '']), ['Read', 'Grep']);
    assert.deepEqual(asList('Read'), ['Read']);
    assert.equal(asList(undefined), undefined);
    assert.equal(asList(''), undefined);
    assert.deepEqual(asList(5), ['5']);
  });

  test('commas inside parentheses and braces do not split a rule', () => {
    assert.deepEqual(asList('Bash(git add:*), Bash(git commit -m "a, b"), Read(src/**/*.{ts,tsx})'), [
      'Bash(git add:*)',
      'Bash(git commit -m "a, b")',
      'Read(src/**/*.{ts,tsx})',
    ]);
    assert.deepEqual(asList("Bash(echo it's fine), Edit"), ["Bash(echo it's fine)", 'Edit']);
  });

  test('asString', () => {
    assert.equal(asString(undefined), undefined);
    assert.equal(asString('x'), 'x');
    assert.equal(asString(3), '3');
    assert.equal(asString(true), 'true');
    assert.equal(asString(['a', 'b']), 'a, b');
  });
});

describe('splitArgs', () => {
  test('splits on whitespace and honours quotes', () => {
    assert.deepEqual(splitArgs('one two  three'), ['one', 'two', 'three']);
    assert.deepEqual(splitArgs('fix "the login bug" \'in auth\' now'), ['fix', 'the login bug', 'in auth', 'now']);
    assert.deepEqual(splitArgs(''), []);
    assert.deepEqual(splitArgs('   '), []);
    assert.deepEqual(splitArgs('a "" b'), ['a', '', 'b']);
    assert.deepEqual(splitArgs('line\none\ttab'), ['line', 'one', 'tab']);
  });
});

describe('expandCommand', () => {
  test('$ARGUMENTS is replaced everywhere, trimmed', async () => {
    assert.equal(await expandCommand({ body: 'Fix $ARGUMENTS. Then test $ARGUMENTS.' }, '  issue 42  '), 'Fix issue 42. Then test issue 42.');
  });

  test('positional arguments, with quotes', async () => {
    const out = await expandCommand({ body: 'Review PR $1 with priority $2 assigned to $3 ($9)' }, '123 "very high" alice');
    assert.equal(out, 'Review PR 123 with priority very high assigned to alice ()');
  });

  test('positional and $ARGUMENTS together', async () => {
    assert.equal(await expandCommand({ body: 'first=$1 all=$ARGUMENTS' }, 'a b'), 'first=a all=a b');
  });

  test('arguments are appended when the body has no placeholder', async () => {
    assert.equal(await expandCommand({ body: 'Summarize the changes.\n' }, 'since yesterday'), 'Summarize the changes.\n\nARGUMENTS: since yesterday');
    assert.equal(await expandCommand({ body: 'Summarize the changes.\n' }, '   '), 'Summarize the changes.');
  });

  test('placeholders with no arguments expand to nothing', async () => {
    assert.equal(await expandCommand({ body: 'Do $ARGUMENTS now $1' }, ''), 'Do  now');
  });

  test('other dollar text is left alone', async () => {
    // $0 and $HOME are not placeholders; $10 is $1 followed by a zero.
    assert.equal(await expandCommand({ body: 'Cost is $0 and $HOME, see $10; $ARGUMENTS' }, 'x'), 'Cost is $0 and $HOME, see x0; x');
  });

  test('replacement patterns in the arguments are inserted literally', async () => {
    const args = "price $$5 and $& and $' and $` and $1";
    assert.equal(await expandCommand({ body: 'A: $ARGUMENTS :Z' }, args), `A: ${args} :Z`);
  });

  test('placeholders inside an argument are not expanded again', async () => {
    assert.equal(await expandCommand({ body: 'all=$ARGUMENTS first=$1' }, '$2 second'), 'all=$2 second first=$2');
  });

  test('inline commands are replaced by their trimmed output', async () => {
    const seen: string[] = [];
    const run = async (cmd: string) => {
      seen.push(cmd);
      return `  out of ${cmd}\n`;
    };
    const out = await expandCommand({ body: 'Status:\n!`git status --short`\nDiff: !`git diff` end' }, '', run);
    assert.equal(out, 'Status:\nout of git status --short\nDiff: out of git diff end');
    assert.deepEqual(seen.sort(), ['git diff', 'git status --short']);
  });

  test('outputs land in the right places whatever order they finish in', async () => {
    const run = (cmd: string) => new Promise<string>((resolve) => setTimeout(() => resolve(cmd.toUpperCase()), cmd === 'slow' ? 30 : 1));
    assert.equal(await expandCommand({ body: '!`slow` then !`fast` then !`slow`' }, '', run), 'SLOW then FAST then SLOW');
  });

  test('a refused command is marked, not dropped', async () => {
    const out = await expandCommand({ body: 'Log: !`git log`' }, '', async () => null);
    assert.equal(out, 'Log: [command not permitted: git log]');
  });

  test('without a runner nothing is executed', async () => {
    assert.equal(await expandCommand({ body: 'Log: !`git log`' }, ''), 'Log: [command not run: git log]');
  });

  test('arguments are substituted into inline commands from the file', async () => {
    const seen: string[] = [];
    const out = await expandCommand({ body: 'PR: !`gh pr view $1`' }, '42', async (cmd) => {
      seen.push(cmd);
      return 'title';
    });
    assert.equal(out, 'PR: title');
    assert.deepEqual(seen, ['gh pr view 42']);
  });

  test('an inline command that arrives through an argument is never run', async () => {
    const seen: string[] = [];
    const run = async (cmd: string) => {
      seen.push(cmd);
      return 'RAN';
    };
    assert.equal(await expandCommand({ body: 'Explain $ARGUMENTS' }, 'this: !`cat ~/.ssh/id_rsa`', run), 'Explain this: !`cat ~/.ssh/id_rsa`');
    assert.equal(await expandCommand({ body: 'Explain the code.' }, '!`whoami`', run), 'Explain the code.\n\nARGUMENTS: !`whoami`');
    assert.deepEqual(seen, []);
  });

  test('ordinary backticks and exclamation marks are not commands', async () => {
    const run = async () => 'RAN';
    const body = 'Use `npm test`! Also !important and ! `spaced` and !``';
    assert.equal(await expandCommand({ body }, '', run), body);
  });

  test('leading and trailing whitespace of the result is trimmed', async () => {
    assert.equal(await expandCommand({ body: '\n\n  Hello $1  \n\n' }, 'x'), 'Hello x');
  });
});

describe('extension loading', () => {
  let root: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    root = tempProject();
    savedHome = process.env.HOME;
    // ~/.claude is read when compat is on; point it somewhere empty.
    process.env.HOME = path.join(root, 'home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  describe('loadCommands', () => {
    test('reads project and user commands with front matter', () => {
      writeFiles(root, {
        '.coco/commands/test.md': '---\ndescription: Run the tests\nargument-hint: "[pattern]"\nallowed-tools: Bash(npm test:*), Read\nmodel: qwen3\n---\nRun tests matching $ARGUMENTS\n',
        '.coco-home/commands/standup.md': 'Summarize what I did yesterday.\n',
      });
      const commands = loadCommands(root, true);
      const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
      assert.deepEqual(Object.keys(byName).sort(), ['standup', 'test']);
      assert.equal(byName.test!.description, 'Run the tests');
      assert.equal(byName.test!.argumentHint, '[pattern]');
      assert.deepEqual(byName.test!.allowedTools, ['Bash(npm test:*)', 'Read']);
      assert.equal(byName.test!.model, 'qwen3');
      assert.equal(byName.test!.source, 'project');
      assert.equal(byName.test!.body, 'Run tests matching $ARGUMENTS\n');
      assert.equal(byName.test!.path, path.join(root, '.coco', 'commands', 'test.md'));
      assert.equal(byName.standup!.source, 'user');
      assert.equal(byName.standup!.allowedTools, undefined);
    });

    test('subdirectories become namespaces', () => {
      writeFiles(root, {
        '.coco/commands/git/sync.md': 'Sync the branch.',
        '.coco/commands/frontend/test/unit.md': 'Run unit tests.',
        '.coco/commands/top.md': 'Top level.',
        '.coco/commands/notes.txt': 'not a command',
      });
      assert.deepEqual(
        loadCommands(root, true)
          .map((c) => c.name)
          .sort(),
        ['frontend:test:unit', 'git:sync', 'top'],
      );
    });

    test('description falls back to the first line of the body', () => {
      writeFiles(root, {
        '.coco/commands/a.md': '\n\n# Review the diff\n\nMore text.\n',
        '.coco/commands/b.md': '---\nmodel: x\n---\n\nPlain first line that is the description\nsecond\n',
        '.coco/commands/c.md': `${'x'.repeat(150)}\n`,
        '.coco/commands/d.md': '',
      });
      const byName = Object.fromEntries(loadCommands(root, true).map((c) => [c.name, c.description]));
      assert.equal(byName.a, 'Review the diff');
      assert.equal(byName.b, 'Plain first line that is the description');
      assert.equal(byName.c!.length, 100);
      assert.equal(byName.d, '');
    });

    test('project beats user, and .coco beats .claude', () => {
      writeFiles(root, {
        '.coco/commands/one.md': 'project coco',
        '.claude/commands/one.md': 'project claude',
        '.coco-home/commands/one.md': 'user coco',
        'home/.claude/commands/one.md': 'user claude',
        '.claude/commands/two.md': 'project claude',
        '.coco-home/commands/two.md': 'user coco',
        '.coco-home/commands/three.md': 'user coco',
        'home/.claude/commands/three.md': 'user claude',
        'home/.claude/commands/four.md': 'user claude',
      });
      const byName = Object.fromEntries(loadCommands(root, true).map((c) => [c.name, `${c.source}:${c.body}`]));
      assert.deepEqual(byName, {
        one: 'project:project coco',
        two: 'project:project claude',
        three: 'user:user coco',
        four: 'user:user claude',
      });
    });

    test('.claude directories are ignored when compat is off', () => {
      writeFiles(root, {
        '.claude/commands/one.md': 'x',
        'home/.claude/commands/two.md': 'x',
        '.coco/commands/three.md': 'x',
      });
      assert.deepEqual(
        loadCommands(root, false).map((c) => c.name),
        ['three'],
      );
    });

    test('no command directories at all', () => {
      assert.deepEqual(loadCommands(root, true), []);
    });
  });

  describe('loadAgents', () => {
    test('built-ins are always present', () => {
      const agents = loadAgents(root, true);
      assert.deepEqual(agents.map((a) => a.name).sort(), BUILTIN_AGENTS.map((a) => a.name).sort());
      assert.ok(agents.every((a) => a.source === 'builtin' && a.prompt.length > 0));
    });

    test('custom agents: tools as a comma string or a list, name from the file', () => {
      writeFiles(root, {
        '.coco/agents/reviewer.md': '---\nname: code-reviewer\ndescription: Reviews diffs\ntools: Read, Grep, Bash\nmodel: qwen3-coder:30b\n---\nYou review code.\n',
        '.coco/agents/tester.md': '---\ndescription: Writes tests\ntools:\n  - Read\n  - Write\n---\n\nYou write tests.\n',
        '.coco/agents/free.md': 'You do anything.\n',
      });
      const byName = Object.fromEntries(loadAgents(root, true).map((a) => [a.name, a]));
      assert.deepEqual(byName['code-reviewer']!.tools, ['Read', 'Grep', 'Bash']);
      assert.equal(byName['code-reviewer']!.model, 'qwen3-coder:30b');
      assert.equal(byName['code-reviewer']!.prompt, 'You review code.');
      assert.equal(byName['code-reviewer']!.source, 'project');
      assert.equal(byName['code-reviewer']!.path, path.join(root, '.coco', 'agents', 'reviewer.md'));
      assert.deepEqual(byName.tester!.tools, ['Read', 'Write']);
      assert.equal(byName.tester!.prompt, 'You write tests.');
      assert.equal(byName.free!.tools, undefined);
      assert.equal(byName.free!.description, '');
    });

    test('a custom agent overrides the built-in of the same name', () => {
      writeFiles(root, { '.coco/agents/explore.md': '---\ndescription: My explorer\ntools: Read\n---\nCustom explore prompt.\n' });
      const agents = loadAgents(root, true);
      const explore = agents.filter((a) => a.name === 'explore');
      assert.equal(explore.length, 1);
      assert.equal(explore[0]!.prompt, 'Custom explore prompt.');
      assert.equal(explore[0]!.source, 'project');
      assert.ok(agents.some((a) => a.name === 'general-purpose' && a.source === 'builtin'));
    });

    test('Claude model aliases mean the session model', () => {
      writeFiles(root, {
        '.claude/agents/a.md': '---\nmodel: sonnet\n---\nA',
        '.claude/agents/b.md': '---\nmodel: Opus\n---\nB',
        '.claude/agents/c.md': '---\nmodel: inherit\n---\nC',
        '.claude/agents/d.md': '---\nmodel: haiku\n---\nD',
        '.claude/agents/e.md': '---\nmodel: llama3.3\n---\nE',
      });
      const byName = Object.fromEntries(loadAgents(root, true).map((a) => [a.name, a.model]));
      assert.equal(byName.a, undefined);
      assert.equal(byName.b, undefined);
      assert.equal(byName.c, undefined);
      assert.equal(byName.d, undefined);
      assert.equal(byName.e, 'llama3.3');
    });

    test('an agent with an empty body is skipped', () => {
      writeFiles(root, {
        '.coco/agents/empty.md': '---\nname: empty\ndescription: nothing\n---\n\n   \n',
        '.coco/agents/explore.md': '---\ndescription: broken override\n---\n',
      });
      const agents = loadAgents(root, true);
      assert.ok(!agents.some((a) => a.name === 'empty'));
      // The broken override does not hide the built-in.
      assert.equal(agents.find((a) => a.name === 'explore')!.source, 'builtin');
    });

    test('project beats user; nested directories are not scanned', () => {
      writeFiles(root, {
        '.coco/agents/dup.md': 'project',
        '.coco-home/agents/dup.md': 'user',
        'home/.claude/agents/mine.md': 'from claude home',
        '.coco/agents/nested/deep.md': 'ignored',
      });
      const byName = Object.fromEntries(loadAgents(root, true).map((a) => [a.name, a]));
      assert.equal(byName.dup!.prompt, 'project');
      assert.equal(byName.mine!.source, 'user');
      assert.equal(byName.deep, undefined);
      assert.equal(Object.fromEntries(loadAgents(root, false).map((a) => [a.name, a])).mine, undefined);
    });
  });

  describe('loadSkills', () => {
    test('one directory per skill, name from front matter or the directory', () => {
      writeFiles(root, {
        '.coco/skills/pdf/SKILL.md': '---\nname: pdf-tools\ndescription: Work with PDF files\n---\n# PDF\nUse scripts/extract.py\n',
        '.coco/skills/pdf/scripts/extract.py': 'print(1)',
        '.coco/skills/release/SKILL.md': 'Steps to cut a release.\n',
        '.coco/skills/not-a-skill/README.md': 'no SKILL.md here',
        '.coco/skills/stray.md': 'files at the top level are ignored',
      });
      const skills = loadSkills(root, true);
      assert.deepEqual(skills.map((s) => s.name).sort(), ['pdf-tools', 'release']);
      const pdf = skills.find((s) => s.name === 'pdf-tools')!;
      assert.equal(pdf.description, 'Work with PDF files');
      assert.equal(pdf.baseDir, path.join(root, '.coco', 'skills', 'pdf'));
      assert.equal(pdf.body, '# PDF\nUse scripts/extract.py\n');
      assert.equal(pdf.source, 'project');
      assert.equal(skills.find((s) => s.name === 'release')!.description, '');
    });

    test('precedence and compat', () => {
      writeFiles(root, {
        '.coco/skills/a/SKILL.md': 'project coco',
        '.claude/skills/a/SKILL.md': 'project claude',
        '.claude/skills/b/SKILL.md': 'project claude',
        '.coco-home/skills/b/SKILL.md': 'user coco',
        'home/.claude/skills/c/SKILL.md': 'user claude',
      });
      assert.deepEqual(Object.fromEntries(loadSkills(root, true).map((s) => [s.name, s.body])), { a: 'project coco', b: 'project claude', c: 'user claude' });
      assert.deepEqual(Object.fromEntries(loadSkills(root, false).map((s) => [s.name, s.body])), { a: 'project coco', b: 'user coco' });
    });

    test('a symlinked skill directory is followed', { skip: process.platform === 'win32' }, () => {
      writeFiles(root, { 'shared/skills/linked/SKILL.md': '---\ndescription: shared\n---\nShared skill.' });
      fs.mkdirSync(path.join(root, '.coco', 'skills'), { recursive: true });
      fs.symlinkSync(path.join(root, 'shared', 'skills', 'linked'), path.join(root, '.coco', 'skills', 'linked'));
      const skills = loadSkills(root, true);
      assert.deepEqual(
        skills.map((s) => [s.name, s.description]),
        [['linked', 'shared']],
      );
    });
  });

  describe('loadOutputStyles', () => {
    test('built-ins plus custom styles, names lower-cased', () => {
      writeFiles(root, {
        '.coco/output-styles/Terse.md': '---\ndescription: As short as possible\n---\nAnswer in as few words as possible.\n',
        '.coco/output-styles/named.md': '---\nname: Pirate\n---\nTalk like a pirate.',
        '.coco/output-styles/blank.md': '---\nname: blank\n---\n',
      });
      const styles = loadOutputStyles(root, true);
      const names = styles.map((s) => s.name);
      for (const builtin of BUILTIN_STYLES) assert.ok(names.includes(builtin.name));
      assert.ok(names.includes('terse'));
      assert.ok(names.includes('pirate'));
      assert.ok(!names.includes('blank'));
      const terse = styles.find((s) => s.name === 'terse')!;
      assert.equal(terse.description, 'As short as possible');
      assert.equal(terse.prompt, 'Answer in as few words as possible.');
      assert.equal(styles.find((s) => s.name === 'default')!.prompt, '');
    });

    test('a custom style can replace a built-in', () => {
      writeFiles(root, { '.coco-home/output-styles/explanatory.md': 'My own explanatory style.' });
      const style = loadOutputStyles(root, true).filter((s) => s.name === 'explanatory');
      assert.equal(style.length, 1);
      assert.equal(style[0]!.prompt, 'My own explanatory style.');
      assert.equal(style[0]!.source, 'user');
    });
  });
});
