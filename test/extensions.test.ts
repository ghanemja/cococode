import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AgentDefinition, SkillDefinition } from '../src/config/extensions.ts';
import {
  BUILTIN_AGENTS,
  BUILTIN_STYLES,
  expandCommand,
  expandSkill,
  findAgent,
  loadAgents,
  loadCommands,
  loadOutputStyles,
  loadSkills,
  modelVisibleSkills,
  parseAgentsJson,
  skillListing,
  splitArgs,
  userInvocableSkills,
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

  test('$ARGUMENTS[N] counts from 0 while $1 is still the first argument', async () => {
    const out = await expandCommand({ body: 'a=$ARGUMENTS[0] b=$ARGUMENTS[1] one=$1 two=$2 zero=$0' }, 'x "y z"');
    assert.equal(out, 'a=x b=y z one=x two=y z zero=$0');
  });

  test('$ARGUMENTS[N] past the last argument expands to nothing', async () => {
    assert.equal(await expandCommand({ body: '[$ARGUMENTS[2]] [$ARGUMENTS[0]] [$ARGUMENTS[10]]' }, 'only'), '[] [only] []');
    // Without a number in the brackets it is $ARGUMENTS followed by text.
    assert.equal(await expandCommand({ body: '$ARGUMENTS[x] $ARGUMENTS[]' }, 'only'), 'only[x] only[]');
  });

  test('session, project and command directory variables, in either spelling', async () => {
    const file = path.join(path.sep, 'proj', '.coco', 'commands', 'git', 'sync.md');
    const command = {
      body: 'S=${COCO_SESSION_ID}|${CLAUDE_SESSION_ID} P=${COCO_PROJECT_DIR}|${CLAUDE_PROJECT_DIR} D=${COCO_SKILL_DIR}|${CLAUDE_SKILL_DIR}',
      path: file,
    };
    const out = await expandCommand(command, '', undefined, { sessionId: 'sess-1', projectDir: '/proj' });
    const dir = path.dirname(file);
    assert.equal(out, `S=sess-1|sess-1 P=/proj|/proj D=${dir}|${dir}`);
  });

  test('variables with no value are left as typed', async () => {
    const body = 'S=${CLAUDE_SESSION_ID} P=${COCO_PROJECT_DIR} D=${CLAUDE_SKILL_DIR} E=${CLAUDE_EFFORT} H=${HOME}';
    assert.equal(await expandCommand({ body }, ''), body);
    assert.equal(await expandCommand({ body }, '', undefined, { sessionId: '', projectDir: undefined }), body);
    assert.equal(await expandCommand({ body: '${COCO_SESSION_ID} ${COCO_PROJECT_DIR}' }, '', undefined, { projectDir: '/p' }), '${COCO_SESSION_ID} /p');
  });

  test('a backslash keeps a placeholder as text', async () => {
    const body = 'Costs \\$1.00, not $1. \\$ARGUMENTS, \\$ARGUMENTS[0] and \\${CLAUDE_SESSION_ID} stay.';
    const out = await expandCommand({ body }, 'five', undefined, { sessionId: 's' });
    assert.equal(out, 'Costs $1.00, not five. $ARGUMENTS, $ARGUMENTS[0] and ${CLAUDE_SESSION_ID} stay.');
  });

  test('a backslash that escapes nothing is left alone', async () => {
    const body = 'echo \\$HOME \\$0 C:\\dir\\ \\n \\$';
    assert.equal(await expandCommand({ body }, ''), body);
  });

  test('a fenced ! block runs as one script and is replaced by its output', async () => {
    const seen: string[] = [];
    const run = async (cmd: string) => {
      seen.push(cmd);
      return '\n  M src/a.ts\n?? b.ts\n\n';
    };
    const body = 'Changes:\n```!\ngit status --short\ngit log -1 --format=%s -- $1\n```\nReview them.';
    // The first line of the output keeps its indentation; blank lines around it go.
    assert.equal(await expandCommand({ body }, 'src', run), 'Changes:\n  M src/a.ts\n?? b.ts\nReview them.');
    assert.deepEqual(seen, ['git status --short\ngit log -1 --format=%s -- src']);
  });

  test('a fenced block that may not or cannot run is marked', async () => {
    const body = 'Versions:\n```!\nnode -v\nnpm -v\n```';
    assert.equal(await expandCommand({ body }, ''), 'Versions:\n[command not run: node -v\nnpm -v]');
    assert.equal(await expandCommand({ body }, '', async () => null), 'Versions:\n[command not permitted: node -v\nnpm -v]');
  });

  test('only a fence opened with ```! on a line of its own is a command', async () => {
    const run = async () => 'RAN';
    const bodies = [
      '```bash\nls\n```',
      '```\n!ls\n```',
      '```!\nnever closed',
      '```!\n\n```',
      'text ```!\nls\n```',
      '```! ls\nls\n```',
      '````!\nls\n````',
    ];
    for (const body of bodies) assert.equal(await expandCommand({ body }, '', run), body);
  });

  test('indented blocks and CRLF line endings', async () => {
    const run = async (cmd: string) => `<${cmd}>`;
    assert.equal(await expandCommand({ body: '- step:\n  ```!\n  pwd\n  ```\n- next' }, '', run), '- step:\n  <  pwd>\n- next');
    assert.equal(await expandCommand({ body: 'a\r\n```!\r\npwd\r\nls\r\n```\r\nb' }, '', run), 'a\r\n<pwd\nls>\r\nb');
  });

  test('inline and fenced commands in one body land in the right places', async () => {
    const run = (cmd: string) => new Promise<string>((resolve) => setTimeout(() => resolve(cmd.toUpperCase()), cmd.startsWith('slow') ? 30 : 1));
    const body = '!`fast`\n```!\nslow one\nslow two\n```\n!`fast` end';
    assert.equal(await expandCommand({ body }, '', run), 'FAST\nSLOW ONE\nSLOW TWO\nFAST end');
  });

  test('a runner that throws marks the command instead of failing the expansion', async () => {
    const run = async () => {
      throw new Error('spawn failed');
    };
    assert.equal(await expandCommand({ body: 'Who: !`whoami`.' }, '', run), 'Who: [command failed: whoami: spawn failed].');
  });

  test('a fenced block that arrives through an argument is never run', async () => {
    const seen: string[] = [];
    const run = async (cmd: string) => {
      seen.push(cmd);
      return 'RAN';
    };
    const args = '```!\nrm -rf /\n```';
    assert.equal(await expandCommand({ body: 'Notes:\n$ARGUMENTS\nEnd' }, args, run), `Notes:\n${args}\nEnd`);
    assert.equal(await expandCommand({ body: 'Notes.' }, args, run), `Notes.\n\nARGUMENTS: ${args}`);
    // Nor can an argument supply the body of a command the file only began.
    assert.equal(await expandCommand({ body: 'Run !$1 now' }, '`whoami`', run), 'Run !`whoami` now');
    assert.deepEqual(seen, []);
  });

  test('variables and escapes inside an argument are left as typed', async () => {
    const args = '${CLAUDE_SESSION_ID} \\$1 $ARGUMENTS[0]';
    assert.equal(await expandCommand({ body: 'Got: $ARGUMENTS' }, args, undefined, { sessionId: 'secret' }), `Got: ${args}`);
  });

  test('ARGUMENTS is appended only when no placeholder received the arguments', async () => {
    // An escaped placeholder and a variable are not uses of the arguments.
    assert.equal(await expandCommand({ body: 'Price is \\$1.' }, 'x'), 'Price is $1.\n\nARGUMENTS: x');
    assert.equal(await expandCommand({ body: 'In ${COCO_PROJECT_DIR}.' }, 'x', undefined, { projectDir: '/p' }), 'In /p.\n\nARGUMENTS: x');
    // A placeholder inside a command is a use.
    assert.equal(await expandCommand({ body: 'Log: !`git log $1`' }, 'main', async (cmd) => cmd), 'Log: git log main');
    assert.equal(await expandCommand({ body: 'Item: $ARGUMENTS[0]' }, 'x'), 'Item: x');
    // A placeholder past the last argument received nothing, so what was typed is not lost.
    assert.equal(await expandCommand({ body: 'Second: $2.' }, 'only'), 'Second: .\n\nARGUMENTS: only');
    assert.equal(await expandCommand({ body: 'Second: $ARGUMENTS[1].' }, 'only'), 'Second: .\n\nARGUMENTS: only');
  });
});

describe('expandSkill', () => {
  test('$N counts from 0 in a skill and from 1 in a command file', async () => {
    const body = 'first=$0 second=$1 third=$2';
    assert.equal(await expandSkill({ body }, 'a "b c" d', {}), 'first=a second=b c third=d');
    // The same text as a legacy command: $1 is the first argument and $0 is not a placeholder.
    assert.equal(await expandCommand({ body }, 'a "b c" d'), 'first=$0 second=a third=b c');
  });

  test('$N is short for $ARGUMENTS[N], with any number of digits', async () => {
    const args = 'a0 a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11';
    assert.equal(await expandSkill({ body: '$0|$ARGUMENTS[0]|$10|$ARGUMENTS[10]|$11|$ARGUMENTS[11]' }, args, {}), 'a0|a0|a10|a10|a11|a11');
    // In a command file $10 is $1 followed by a zero, and $ARGUMENTS[N] counts from 0 all the same.
    assert.equal(await expandCommand({ body: '$10|$ARGUMENTS[10]' }, args), 'a00|a10');
  });

  test('an index past the last argument expands to nothing', async () => {
    assert.equal(await expandSkill({ body: '[$0] [$1] [$ARGUMENTS[1]] [$7] [$ARGUMENTS[99999999999999999999]]' }, 'only', {}), '[only] [] [] [] []');
  });

  test('$ARGUMENTS is everything that was typed, trimmed', async () => {
    assert.equal(await expandSkill({ body: 'Fix $ARGUMENTS now. Again: $ARGUMENTS' }, '  "the bug"  in auth ', {}), 'Fix "the bug"  in auth now. Again: "the bug"  in auth');
  });

  test('the context is optional', async () => {
    assert.equal(await expandSkill({ body: 'Hello $0' }, 'there'), 'Hello there');
  });

  test('named arguments map to positions in order', async () => {
    const skill = { body: 'Fix issue $issue on branch $branch ($ARGUMENTS[0], $1).', argumentNames: ['issue', 'branch'] };
    assert.equal(await expandSkill(skill, '42 "feat/login page"', {}), 'Fix issue 42 on branch feat/login page (42, feat/login page).');
    assert.equal(await expandSkill(skill, '42', {}), 'Fix issue 42 on branch  (42, ).');
    // Without the declaration the names are ordinary text.
    assert.equal(await expandSkill({ body: 'Fix $issue' }, '42', {}), 'Fix $issue\n\nARGUMENTS: 42');
  });

  test('a name that is the start of another name', async () => {
    const skill = { body: '$file|$filename|$file.$filename|$files|$file_name|$file-$filename-x|$filename2', argumentNames: ['file', 'filename'] };
    assert.equal(await expandSkill(skill, 'F N', {}), 'F|N|F.N|$files|$file_name|F-N-x|$filename2');
    // Whatever order they were declared in.
    assert.equal(await expandSkill({ body: '$file $filename', argumentNames: ['filename', 'file'] }, 'N F', {}), 'F N');
  });

  test('names may hold hyphens and underscores', async () => {
    const skill = { body: '$pr-number / $pr / $target_env / $pr-other', argumentNames: ['pr', 'pr-number', 'target_env'] };
    assert.equal(await expandSkill(skill, 'A B C', {}), 'B / A / C / A-other');
  });

  test('names that cannot be placeholders are skipped but keep their position', async () => {
    const skill = { body: 'x=$x y=$y', argumentNames: ['0', 'x', 'ARGUMENTS', 'y', 'x', 'has space', 'a.b'] };
    assert.equal(await expandSkill(skill, 'a b c d e', {}), 'x=b y=d');
  });

  test('skill directory, session and project variables, in either spelling', async () => {
    const skill = {
      body: 'python ${CLAUDE_SKILL_DIR}/run.py; ${COCO_SKILL_DIR} ${CLAUDE_SESSION_ID} ${COCO_SESSION_ID} ${CLAUDE_PROJECT_DIR} ${COCO_PROJECT_DIR}',
      baseDir: '/skills/pdf',
    };
    const out = await expandSkill(skill, '', { sessionId: 'abc123', projectDir: '/work/app' });
    assert.equal(out, 'python /skills/pdf/run.py; /skills/pdf abc123 abc123 /work/app /work/app');
  });

  test('variables without a value are left untouched', async () => {
    const body = '${CLAUDE_SKILL_DIR} ${COCO_SESSION_ID} ${CLAUDE_PROJECT_DIR} ${CLAUDE_EFFORT} ${claude_session_id} $CLAUDE_SESSION_ID ${COCO_SESSION_ID';
    assert.equal(await expandSkill({ body }, '', {}), body);
    assert.equal(await expandSkill({ body: '${COCO_SESSION_ID} ${COCO_PROJECT_DIR} ${COCO_SKILL_DIR}' }, '', { sessionId: 's1' }), 's1 ${COCO_PROJECT_DIR} ${COCO_SKILL_DIR}');
  });

  test('a backslash keeps a placeholder as text', async () => {
    const skill = {
      body: 'Costs \\$1.00 or \\$0.50; \\$ARGUMENTS, \\$ARGUMENTS[1], \\$name and \\${CLAUDE_SKILL_DIR} are text; $0 and $name are not.',
      argumentNames: ['name'],
      baseDir: '/s',
    };
    assert.equal(await expandSkill(skill, 'x', {}), 'Costs $1.00 or $0.50; $ARGUMENTS, $ARGUMENTS[1], $name and ${CLAUDE_SKILL_DIR} are text; x and x are not.');
    // Which is why a price needs one: unescaped, $1 is the second argument.
    assert.equal(await expandSkill({ body: 'Costs $1.00 today' }, '', {}), 'Costs .00 today');
    // A backslash in front of anything else stays.
    const other = 'echo \\$HOME \\$undeclared C:\\dir\\ \\n \\$';
    assert.equal(await expandSkill({ body: other }, '', {}), other);
  });

  test('inline and fenced commands run with arguments and variables filled in', async () => {
    const seen: string[] = [];
    const runBash = async (cmd: string) => {
      seen.push(cmd);
      return `out(${cmd})\n`;
    };
    const skill = {
      body: 'Diff: !`git diff $0`\n```!\npython ${COCO_SKILL_DIR}/scan.py $target\ngit log -1\n```\nDone.',
      baseDir: '/skills/scan',
      argumentNames: ['target'],
    };
    assert.equal(await expandSkill(skill, 'main', { runBash }), 'Diff: out(git diff main)\nout(python /skills/scan/scan.py main\ngit log -1)\nDone.');
    assert.deepEqual(seen.sort(), ['git diff main', 'python /skills/scan/scan.py main\ngit log -1']);
  });

  test('commands that may not or cannot run are marked', async () => {
    const skill = { body: 'A: !`whoami`\n```!\nid\nuname\n```' };
    assert.equal(await expandSkill(skill, '', {}), 'A: [command not run: whoami]\n[command not run: id\nuname]');
    assert.equal(await expandSkill(skill, '', { runBash: async () => null }), 'A: [command not permitted: whoami]\n[command not permitted: id\nuname]');
    const failing = async () => {
      throw new Error('spawn failed');
    };
    assert.equal(await expandSkill({ body: 'A: !`whoami`' }, '', { runBash: failing }), 'A: [command failed: whoami: spawn failed]');
  });

  test('text that arrives through an argument is never executed or expanded again', async () => {
    const seen: string[] = [];
    const runBash = async (cmd: string) => {
      seen.push(cmd);
      return 'RAN';
    };
    const ctx = { sessionId: 'sess', projectDir: '/proj', runBash };
    const skill = { body: 'All: $ARGUMENTS\nFirst: $0\nNamed: $what', argumentNames: ['what'], baseDir: '/skill' };

    // An inline command.
    assert.equal(await expandSkill(skill, '!`cat ~/.ssh/id_rsa`', ctx), 'All: !`cat ~/.ssh/id_rsa`\nFirst: !`cat\nNamed: !`cat');
    // A fenced block, on lines of its own.
    const fenced = '```!\nrm -rf /\n```';
    assert.equal(await expandSkill({ body: 'Notes:\n$ARGUMENTS\nEnd' }, fenced, ctx), `Notes:\n${fenced}\nEnd`);
    // Appended arguments are not scanned either.
    assert.equal(await expandSkill({ body: 'Explain.' }, '!`whoami`', ctx), 'Explain.\n\nARGUMENTS: !`whoami`');
    assert.equal(await expandSkill({ body: 'Explain.' }, fenced, ctx), `Explain.\n\nARGUMENTS: ${fenced}`);
    // An argument cannot complete a command the file only began.
    assert.equal(await expandSkill({ body: 'Run !$0 now' }, '`whoami`', ctx), 'Run !`whoami` now');
    assert.deepEqual(seen, []);

    // Placeholders, variables and escapes inside an argument stay as typed.
    const tricky = '$0 $1 $what $ARGUMENTS $ARGUMENTS[0] ${CLAUDE_SESSION_ID} ${COCO_SKILL_DIR} \\$0';
    assert.equal(await expandSkill({ body: 'Got: $ARGUMENTS', argumentNames: ['what'], baseDir: '/skill' }, tricky, ctx), `Got: ${tricky}`);
    assert.equal(await expandSkill({ body: 'Got: $what', argumentNames: ['what'] }, '"$ARGUMENTS ${COCO_SESSION_ID}" tail', ctx), 'Got: $ARGUMENTS ${COCO_SESSION_ID}');
    assert.equal(await expandSkill({ body: 'Got.', baseDir: '/skill' }, tricky, ctx), `Got.\n\nARGUMENTS: ${tricky}`);
  });

  test('an argument used inside a command from the file reaches the runner, which decides', async () => {
    const seen: string[] = [];
    const runBash = async (cmd: string) => {
      seen.push(cmd);
      return /^echo [a-z]+$/.test(cmd) ? 'ok' : null;
    };
    assert.equal(await expandSkill({ body: 'Say: !`echo $0`' }, 'hello', { runBash }), 'Say: ok');
    assert.equal(await expandSkill({ body: 'Say: !`echo $0`' }, '"a; rm -rf /"', { runBash }), 'Say: [command not permitted: echo a; rm -rf /]');
    assert.deepEqual(seen, ['echo hello', 'echo a; rm -rf /']);
  });

  test('command output and variable values are not expanded again', async () => {
    const seen: string[] = [];
    const runBash = async (cmd: string) => {
      seen.push(cmd);
      return '$0 $ARGUMENTS !`second` ${COCO_SESSION_ID}\n```!\nthird\n```';
    };
    const out = await expandSkill({ body: '!`first`\n${COCO_SESSION_ID} | $0' }, 'arg', { sessionId: '$0 !`fourth`', runBash });
    assert.equal(out, '$0 $ARGUMENTS !`second` ${COCO_SESSION_ID}\n```!\nthird\n```\n$0 !`fourth` | arg');
    assert.deepEqual(seen, ['first']);
  });

  test('ARGUMENTS is appended only when no placeholder received the arguments', async () => {
    // Nothing in the body refers to the arguments.
    assert.equal(await expandSkill({ body: 'Summarize the changes.\n' }, 'since monday', {}), 'Summarize the changes.\n\nARGUMENTS: since monday');
    // Variables, escapes and commands are not argument placeholders.
    const noUse = { body: 'In ${COCO_PROJECT_DIR}: \\$0 !`date`' };
    assert.equal(await expandSkill(noUse, 'x', { projectDir: '/p', runBash: async () => 'today' }), 'In /p: $0 today\n\nARGUMENTS: x');
    // Any placeholder that received something counts, also inside a command.
    for (const placeholder of ['$ARGUMENTS', '$0', '$ARGUMENTS[0]', '$first', '!`echo $0`', '```!\necho $first\n```']) {
      const out = await expandSkill({ body: `Do:\n${placeholder}`, argumentNames: ['first'] }, 'x', { runBash: async (cmd) => cmd });
      assert.ok(!out.includes('ARGUMENTS:'), `${placeholder} -> ${out}`);
    }
    // A placeholder past the last argument received nothing, so what was typed is not lost.
    assert.equal(await expandSkill({ body: 'Second: $1.' }, 'only', {}), 'Second: .\n\nARGUMENTS: only');
    assert.equal(await expandSkill({ body: 'Second: $second.', argumentNames: ['first', 'second'] }, 'only', {}), 'Second: .\n\nARGUMENTS: only');
    // No arguments, nothing to append.
    assert.equal(await expandSkill({ body: 'Summarize.' }, '  ', {}), 'Summarize.');
    assert.equal(await expandSkill({ body: 'Do $0 $ARGUMENTS' }, '', {}), 'Do');
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
    process.env.CLAUDE_CONFIG_DIR = path.join(process.env.HOME, '.claude');
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

    test('an unquoted bracketed hint, space-separated rules and Claude model aliases', () => {
      writeFiles(root, {
        '.claude/commands/pr.md': '---\nargument-hint: [pr-number] [priority]\nallowed-tools: Bash(git add *) Bash(git commit *)\nmodel: sonnet\n---\nReview PR $1.',
        '.claude/commands/commit.md': '---\nargument-hint: [message]\nallowed-tools:\n  - Bash(git commit *)\n  - Read\nmodel: llama3.3\n---\nCommit with $ARGUMENTS.',
        '.claude/commands/plain.md': '---\nargument-hint: <file> <format>\n---\nConvert.',
      });
      const byName = Object.fromEntries(loadCommands(root, true).map((c) => [c.name, c]));
      assert.equal(byName.pr!.argumentHint, '[pr-number] [priority]');
      assert.deepEqual(byName.pr!.allowedTools, ['Bash(git add *)', 'Bash(git commit *)']);
      assert.equal(byName.pr!.model, undefined);
      assert.equal(byName.commit!.argumentHint, '[message]');
      assert.deepEqual(byName.commit!.allowedTools, ['Bash(git commit *)', 'Read']);
      assert.equal(byName.commit!.model, 'llama3.3');
      assert.equal(byName.plain!.argumentHint, '<file> <format>');
    });

    test('a loaded command expands the directory it lives in', async () => {
      writeFiles(root, { '.coco/commands/tools/lint.md': 'Run !`sh ${COCO_SKILL_DIR}/lint.sh $1` in ${CLAUDE_PROJECT_DIR}.' });
      const [command] = loadCommands(root, true);
      const out = await expandCommand(command!, 'src', async (cmd) => `<${cmd}>`, { projectDir: root });
      assert.equal(out, `Run <sh ${path.join(root, '.coco', 'commands', 'tools')}/lint.sh src> in ${root}.`);
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

    // Changed from "nested directories are not scanned": Claude Code scans agents/ subfolders recursively.
    test('project beats user; nested directories are scanned', () => {
      writeFiles(root, {
        '.coco/agents/dup.md': 'project',
        '.coco-home/agents/dup.md': 'user',
        'home/.claude/agents/mine.md': 'from claude home',
        '.coco/agents/nested/deep.md': 'found',
      });
      const byName = Object.fromEntries(loadAgents(root, true).map((a) => [a.name, a]));
      assert.equal(byName.dup!.prompt, 'project');
      assert.equal(byName.mine!.source, 'user');
      assert.equal(byName.deep!.prompt, 'found');
      assert.equal(Object.fromEntries(loadAgents(root, false).map((a) => [a.name, a])).mine, undefined);
    });

    test('every documented field; the ones coco does not use are ignored', () => {
      writeFiles(root, {
        '.claude/agents/reviewer.md': [
          '---',
          'name: code-reviewer',
          'description: Reviews code for quality',
          'tools: Read, Grep, Bash(git diff *)',
          'disallowedTools: Write, Edit',
          'model: qwen3-coder:30b',
          'permissionMode: acceptEdits',
          'maxTurns: 12',
          'skills:',
          '  - api-conventions',
          '  - error-handling',
          'mcpServers:',
          '  - github',
          'hooks:',
          '  PreToolUse:',
          '    - matcher: "Bash"',
          '      hooks:',
          '        - type: command',
          'memory: project',
          'background: true',
          'omitClaudeMd: true',
          'effort: high',
          'isolation: worktree',
          'color: blue',
          'initialPrompt: Review the staged changes.',
          '---',
          'You are a code reviewer.',
          '',
        ].join('\n'),
      });
      assert.deepEqual(findAgent(loadAgents(root, true), 'code-reviewer'), {
        name: 'code-reviewer',
        description: 'Reviews code for quality',
        tools: ['Read', 'Grep', 'Bash(git diff *)'],
        disallowedTools: ['Write', 'Edit'],
        model: 'qwen3-coder:30b',
        permissionMode: 'acceptEdits',
        maxTurns: 12,
        skills: ['api-conventions', 'error-handling'],
        omitMemory: true,
        effort: 'high',
        initialPrompt: 'Review the staged changes.',
        background: true,
        color: 'blue',
        prompt: 'You are a code reviewer.',
        source: 'project',
        path: path.join(root, '.claude', 'agents', 'reviewer.md'),
      });
    });

    test('list fields as lists or comma strings; values that make no sense are dropped', () => {
      writeFiles(root, {
        '.coco/agents/a.md': '---\ntools: [Read, Grep]\ndisallowedTools:\n  - Write\n  - Edit\nskills: one, two\nmaxTurns: "7"\nomitClaudeMd: false\nbackground: false\ninitialPrompt: |\n  Line one\n  Line two\n---\nA',
        '.coco/agents/b.md': '---\nmaxTurns: 0\nmodel: fable\nomitClaudeMd: sometimes\nskills: [solo]\ndisallowedTools: Bash\n---\nB',
        '.coco/agents/c.md': '---\nmaxTurns: 2.5\nmodel: Fable\ncolor:\n---\nC',
        '.coco/agents/d.md': '---\nmaxTurns: -3\nmodel: opus[1m]\n---\nD',
      });
      const byName = Object.fromEntries(loadAgents(root, true).map((a) => [a.name, a]));
      assert.deepEqual(byName.a!.tools, ['Read', 'Grep']);
      assert.deepEqual(byName.a!.disallowedTools, ['Write', 'Edit']);
      assert.deepEqual(byName.a!.skills, ['one', 'two']);
      assert.equal(byName.a!.maxTurns, 7);
      assert.equal(byName.a!.omitMemory, false);
      assert.equal(byName.a!.background, false);
      assert.equal(byName.a!.initialPrompt, 'Line one\nLine two');
      assert.deepEqual(byName.b, { name: 'b', description: '', skills: ['solo'], disallowedTools: ['Bash'], prompt: 'B', source: 'project', path: path.join(root, '.coco', 'agents', 'b.md') });
      assert.deepEqual(Object.keys(byName.c!).sort(), ['description', 'name', 'path', 'prompt', 'source']);
      assert.deepEqual(Object.keys(byName.d!).sort(), ['description', 'name', 'path', 'prompt', 'source']);
    });

    test('subfolders are scanned four levels deep and the name alone identifies an agent', () => {
      writeFiles(root, {
        '.coco/agents/review/security.md': '---\ndescription: Security review\n---\nproject security',
        '.coco/agents/a/b/c/d/four.md': 'four levels down',
        '.coco/agents/a/b/c/d/e/five.md': 'five levels down',
        '.coco/agents/team/renamed.md': '---\nname: lead\n---\nnamed by its front matter',
        '.coco/agents/team/notes.txt': 'not an agent',
        '.coco-home/agents/other/place/security.md': 'user security',
        '.coco-home/agents/deep/mine.md': 'user mine',
        'home/.claude/agents/x/y/claude-user.md': 'claude user',
      });
      const agents = loadAgents(root, true);
      const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
      // The same name in a project subfolder and in a different user subfolder: the project wins.
      assert.equal(agents.filter((a) => a.name === 'security').length, 1);
      assert.equal(byName.security!.prompt, 'project security');
      assert.equal(byName.security!.source, 'project');
      assert.equal(byName.security!.path, path.join(root, '.coco', 'agents', 'review', 'security.md'));
      // Folders do not become part of the name.
      assert.equal(byName['review:security'], undefined);
      assert.equal(byName.four!.prompt, 'four levels down');
      assert.equal(byName.five, undefined);
      assert.equal(byName.lead!.prompt, 'named by its front matter');
      assert.equal(byName.renamed, undefined);
      assert.equal(byName.notes, undefined);
      assert.equal(byName.mine!.source, 'user');
      assert.equal(byName['claude-user']!.source, 'user');
      assert.equal(Object.fromEntries(loadAgents(root, false).map((a) => [a.name, a]))['claude-user'], undefined);
    });

    test('within one directory the file nearest the top wins', () => {
      writeFiles(root, {
        '.coco/agents/a/dup.md': 'nested a',
        '.coco/agents/dup.md': 'top',
        '.coco/agents/z/dup.md': 'nested z',
        '.coco/agents/m/only.md': 'nested m',
        '.coco/agents/b/c/only.md': 'nested b/c',
      });
      const byName = Object.fromEntries(loadAgents(root, true).map((a) => [a.name, a.prompt]));
      assert.equal(byName.dup, 'top');
      assert.equal(byName.only, 'nested m');
    });

    test('names are compared without regard to case', () => {
      writeFiles(root, {
        '.claude/agents/Explore.md': '---\nname: Explore\ndescription: Mine\n---\nCustom explore.',
        '.coco/agents/reviewer.md': 'project reviewer',
        '.coco-home/agents/REVIEWER.md': 'user reviewer',
      });
      const agents = loadAgents(root, true);
      const explore = agents.filter((a) => a.name.toLowerCase() === 'explore');
      assert.deepEqual(explore.map((a) => [a.name, a.source, a.prompt]), [['Explore', 'project', 'Custom explore.']]);
      const reviewer = agents.filter((a) => a.name.toLowerCase() === 'reviewer');
      assert.deepEqual(reviewer.map((a) => [a.name, a.prompt]), [['reviewer', 'project reviewer']]);
      assert.equal(findAgent(agents, 'explore')!.prompt, 'Custom explore.');
      assert.equal(findAgent(agents, 'plan')!.source, 'builtin');
    });

    test('session agents are merged in ahead of files and built-ins', () => {
      writeFiles(root, { '.coco/agents/reviewer.md': 'project reviewer', '.coco/agents/tester.md': 'project tester' });
      const session = parseAgentsJson('{"Reviewer": {"prompt": "session reviewer"}, "plan": {"description": "My planner", "prompt": "session plan"}}');
      assert.equal(session.error, undefined);
      const agents = loadAgents(root, true, session.agents);
      assert.deepEqual(
        agents.map((a) => `${a.name}:${a.source}`),
        ['Reviewer:flag', 'plan:flag', 'tester:project', 'general-purpose:builtin', 'explore:builtin'],
      );
      assert.equal(findAgent(agents, 'reviewer')!.prompt, 'session reviewer');
      assert.equal(findAgent(agents, 'Plan')!.prompt, 'session plan');
      // Without them, nothing changes.
      assert.equal(findAgent(loadAgents(root, true), 'reviewer')!.prompt, 'project reviewer');
      assert.deepEqual(loadAgents(root, true, []), loadAgents(root, true));
    });

    test('an unreadable agents directory is not an error', () => {
      writeFiles(root, { '.coco/agents': 'a file where a directory should be', '.claude/agents/ok.md': 'fine' });
      const agents = loadAgents(root, true);
      assert.equal(findAgent(agents, 'ok')!.prompt, 'fine');
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

    test('every documented field in its plain form; unknown fields are ignored', () => {
      writeFiles(root, {
        '.claude/skills/fix-issue/SKILL.md': [
          '---',
          'name: fix-issue',
          'description: Fix a GitHub issue',
          'when_to_use: When the user mentions an issue number',
          'argument-hint: [issue] [branch]',
          'arguments: issue branch',
          'disable-model-invocation: true',
          'user-invocable: false',
          'allowed-tools: Bash(gh issue view *) Bash(git commit *) Read',
          'disallowed-tools: WebFetch, WebSearch',
          'model: qwen3-coder:30b',
          'effort: high',
          'context: fork',
          'agent: Explore',
          'background: true',
          'hooks:',
          '  PreToolUse:',
          '    - matcher: "Bash"',
          '      hooks:',
          '        - type: command',
          '          command: "./check.sh"',
          'paths: src/**/*.{ts,tsx}, docs/**',
          'shell: bash',
          'metadata:',
          '  author: someone',
          '  version: "1.0"',
          'license: MIT',
          'compatibility: needs the gh CLI',
          'made-up-field: whatever',
          '---',
          'Fix issue $issue on $branch.',
          '',
        ].join('\n'),
      });
      assert.deepEqual(loadSkills(root, true), [
        {
          name: 'fix-issue',
          description: 'Fix a GitHub issue',
          whenToUse: 'When the user mentions an issue number',
          argumentHint: '[issue] [branch]',
          argumentNames: ['issue', 'branch'],
          disableModelInvocation: true,
          userInvocable: false,
          allowedTools: ['Bash(gh issue view *)', 'Bash(git commit *)', 'Read'],
          disallowedTools: ['WebFetch', 'WebSearch'],
          model: 'qwen3-coder:30b',
          effort: 'high',
          fork: true,
          agent: 'Explore',
          paths: ['src/**/*.{ts,tsx}', 'docs/**'],
          baseDir: path.join(root, '.claude', 'skills', 'fix-issue'),
          body: 'Fix issue $issue on $branch.\n',
          source: 'project',
        },
      ]);
    });

    test('list fields written as YAML lists', () => {
      writeFiles(root, {
        '.coco/skills/block/SKILL.md':
          '---\narguments:\n  - src\n  - dest\nallowed-tools:\n  - Bash(git add *)\n  - "Bash(npm run test:*)"\ndisallowed-tools:\n  - Write\npaths:\n  - "src/**"\n  - test/**\nargument-hint: [src]\n---\nBody',
        '.coco/skills/inline/SKILL.md': '---\narguments: [src, dest]\nallowed-tools: [Read, "Bash(echo a, b)"]\ndisallowed-tools: [Write, Edit]\npaths: [lib/**, "*.md"]\n---\nBody',
        '.coco/skills/commas/SKILL.md': '---\narguments: src, dest\nallowed-tools: Read, Bash(echo a, b)\ndisallowed-tools: Write\npaths: lib/**\nargument-hint: <src> <dest>\n---\nBody',
      });
      const byName = Object.fromEntries(loadSkills(root, true).map((s) => [s.name, s]));
      assert.deepEqual(byName.block!.argumentNames, ['src', 'dest']);
      assert.deepEqual(byName.block!.allowedTools, ['Bash(git add *)', 'Bash(npm run test:*)']);
      assert.deepEqual(byName.block!.disallowedTools, ['Write']);
      assert.deepEqual(byName.block!.paths, ['src/**', 'test/**']);
      assert.equal(byName.block!.argumentHint, '[src]');
      assert.deepEqual(byName.inline!.argumentNames, ['src', 'dest']);
      assert.deepEqual(byName.inline!.allowedTools, ['Read', 'Bash(echo a, b)']);
      assert.deepEqual(byName.inline!.disallowedTools, ['Write', 'Edit']);
      assert.deepEqual(byName.inline!.paths, ['lib/**', '*.md']);
      assert.deepEqual(byName.commas!.argumentNames, ['src', 'dest']);
      assert.deepEqual(byName.commas!.allowedTools, ['Read', 'Bash(echo a, b)']);
      assert.deepEqual(byName.commas!.disallowedTools, ['Write']);
      assert.deepEqual(byName.commas!.paths, ['lib/**']);
      assert.equal(byName.commas!.argumentHint, '<src> <dest>');
    });

    test('defaults: both the user and the model may start it, in the conversation', () => {
      writeFiles(root, { '.coco/skills/plain/SKILL.md': '---\ndescription: Plain\n---\nBody' });
      assert.deepEqual(loadSkills(root, true), [
        {
          name: 'plain',
          description: 'Plain',
          disableModelInvocation: false,
          userInvocable: true,
          fork: false,
          baseDir: path.join(root, '.coco', 'skills', 'plain'),
          body: 'Body',
          source: 'project',
        },
      ]);
    });

    test('booleans, context and model values are read leniently', () => {
      writeFiles(root, {
        '.claude/skills/a/SKILL.md': '---\nmodel: sonnet\ncontext: Fork\nuser-invocable: "false"\ndisable-model-invocation: yes\n---\nA',
        '.claude/skills/b/SKILL.md': '---\nmodel: inherit\ncontext: inline\nuser-invocable: maybe\ndisable-model-invocation: false\neffort:\nagent:\n---\nB',
        '.claude/skills/c/SKILL.md': '---\nmodel: fable\nuser-invocable: true\n---\nC',
        '.claude/skills/d/SKILL.md': '---\nmodel: mistral-small\n---\nD',
      });
      const byName = Object.fromEntries(loadSkills(root, true).map((s) => [s.name, s]));
      assert.deepEqual(
        [byName.a!.model, byName.a!.fork, byName.a!.userInvocable, byName.a!.disableModelInvocation],
        [undefined, true, false, true],
      );
      assert.deepEqual(
        [byName.b!.model, byName.b!.fork, byName.b!.userInvocable, byName.b!.disableModelInvocation, byName.b!.effort, byName.b!.agent],
        [undefined, false, true, false, undefined, undefined],
      );
      assert.equal(byName.c!.model, undefined);
      assert.equal(byName.d!.model, 'mistral-small');
    });

    test('field names are also accepted with underscores or in camel case', () => {
      writeFiles(root, {
        '.coco/skills/alt/SKILL.md': '---\nwhenToUse: On request\nallowed_tools: Read\nargumentHint: <x>\ndisableModelInvocation: true\nuser_invocable: false\n---\nBody',
      });
      const [skill] = loadSkills(root, true);
      assert.equal(skill!.whenToUse, 'On request');
      assert.deepEqual(skill!.allowedTools, ['Read']);
      assert.equal(skill!.argumentHint, '<x>');
      assert.equal(skill!.disableModelInvocation, true);
      assert.equal(skill!.userInvocable, false);
    });

    test('who may start a skill, from its front matter', () => {
      writeFiles(root, {
        '.coco/skills/both/SKILL.md': '---\ndescription: Both\n---\nBody',
        '.coco/skills/model-only/SKILL.md': '---\ndescription: Background knowledge\nuser-invocable: false\n---\nBody',
        '.coco/skills/user-only/SKILL.md': '---\ndescription: Deploy\ndisable-model-invocation: true\n---\nBody',
      });
      const skills = loadSkills(root, true);
      assert.deepEqual(modelVisibleSkills(skills).map((s) => s.name), ['both', 'model-only']);
      assert.deepEqual(userInvocableSkills(skills).map((s) => s.name), ['both', 'user-only']);
    });

    test('a loaded skill expands its own directory, names and 0-based arguments', async () => {
      writeFiles(root, {
        '.coco/skills/migrate/SKILL.md': '---\narguments: [component, from, to]\n---\nMigrate $component from $from to $to ($0, $1, $2).\nHelper: ${COCO_SKILL_DIR}/migrate.sh\n',
      });
      const [skill] = loadSkills(root, true);
      const out = await expandSkill(skill!, 'SearchBar React Vue', {});
      assert.equal(out, `Migrate SearchBar from React to Vue (SearchBar, React, Vue).\nHelper: ${path.join(root, '.coco', 'skills', 'migrate')}/migrate.sh`);
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

describe('skill visibility and listing', () => {
  const skill = (over: Partial<SkillDefinition>): SkillDefinition => ({
    name: 'x',
    description: '',
    disableModelInvocation: false,
    userInvocable: true,
    fork: false,
    baseDir: '/skills/x',
    body: '',
    source: 'project',
    ...over,
  });
  const ellipsis = String.fromCodePoint(0x2026);

  test('modelVisibleSkills drops disable-model-invocation; userInvocableSkills drops user-invocable: false', () => {
    const skills = [
      skill({ name: 'both' }),
      skill({ name: 'user-only', disableModelInvocation: true }),
      skill({ name: 'model-only', userInvocable: false }),
      skill({ name: 'neither', disableModelInvocation: true, userInvocable: false }),
    ];
    assert.deepEqual(modelVisibleSkills(skills).map((s) => s.name), ['both', 'model-only']);
    assert.deepEqual(userInvocableSkills(skills).map((s) => s.name), ['both', 'user-only']);
    assert.deepEqual(modelVisibleSkills([]), []);
    assert.deepEqual(userInvocableSkills([]), []);
    // The input is not modified.
    assert.equal(skills.length, 4);
  });

  test('skillListing is the description, then when_to_use, on one line', () => {
    assert.equal(skillListing({ description: 'Deploy the app' }), 'Deploy the app');
    assert.equal(skillListing({ description: 'Deploy the app', whenToUse: 'Use when the user says ship it' }), 'Deploy the app - Use when the user says ship it');
    assert.equal(skillListing({ description: '', whenToUse: 'Only this' }), 'Only this');
    assert.equal(skillListing({ description: 'Line one\n  line two\n\nline three', whenToUse: ' spaced\tout ' }), 'Line one line two line three - spaced out');
    assert.equal(skillListing(skill({ description: 'From a definition', whenToUse: 'when asked' })), 'From a definition - when asked');
  });

  test('skillListing falls back to the first line of the body', () => {
    assert.equal(skillListing({ description: '', body: '\n# Release steps\n\nMore text.\n' }), 'Release steps');
    assert.equal(skillListing({ description: 'Given', body: '# Heading' }), 'Given');
    assert.equal(skillListing({ description: '' }), '');
    assert.equal(skillListing({ description: '   ', body: '  ' }), '');
  });

  test('skillListing is cut to maxChars with an ellipsis', () => {
    const long = skillListing({ description: 'd'.repeat(200), whenToUse: 'w'.repeat(200) });
    assert.equal(long, `${'d'.repeat(200)} - ${'w'.repeat(46)}${ellipsis}`);
    assert.equal(long.length, 250);
    // Exactly at the limit nothing is cut.
    assert.equal(skillListing({ description: 'x'.repeat(250) }), 'x'.repeat(250));
    assert.equal(skillListing({ description: 'x'.repeat(251) }), 'x'.repeat(249) + ellipsis);
    assert.equal(skillListing({ description: 'hello wonderful world' }, 12), `hello wonde${ellipsis}`);
    assert.equal(skillListing({ description: 'hello wonderful world' }, 21), 'hello wonderful world');
    // No space is left in front of the ellipsis.
    assert.equal(skillListing({ description: 'hello wonderful world' }, 7), `hello${ellipsis}`);
    assert.equal(skillListing({ description: 'hello' }, 1), ellipsis);
    assert.equal(skillListing({ description: 'hello' }, 0), '');
    // A character outside the basic plane is not cut in half.
    const emoji = String.fromCodePoint(0x1f600);
    assert.equal(skillListing({ description: `ab${emoji}cd` }, 4), `ab${ellipsis}`);
    assert.equal(skillListing({ description: `ab${emoji}cd` }, 5), `ab${emoji}${ellipsis}`);
  });
});

describe('findAgent', () => {
  const agent = (name: string, prompt = name): AgentDefinition => ({ name, description: '', prompt, source: 'project' });

  test('the built-ins keep their names and answer to the ones Claude Code uses', () => {
    assert.deepEqual(BUILTIN_AGENTS.map((a) => a.name), ['general-purpose', 'explore', 'plan']);
    assert.equal(findAgent(BUILTIN_AGENTS, 'Explore')!.name, 'explore');
    assert.equal(findAgent(BUILTIN_AGENTS, 'Plan')!.name, 'plan');
    assert.equal(findAgent(BUILTIN_AGENTS, 'general-purpose')!.name, 'general-purpose');
    assert.equal(findAgent(BUILTIN_AGENTS, 'GENERAL-PURPOSE')!.name, 'general-purpose');
    assert.equal(findAgent(BUILTIN_AGENTS, 'explore'), BUILTIN_AGENTS[1]);
    assert.equal(findAgent(BUILTIN_AGENTS, '  Explore '), BUILTIN_AGENTS[1]);
  });

  test('unknown and empty names find nothing', () => {
    assert.equal(findAgent(BUILTIN_AGENTS, 'explorer'), undefined);
    assert.equal(findAgent(BUILTIN_AGENTS, ''), undefined);
    assert.equal(findAgent(BUILTIN_AGENTS, '   '), undefined);
    assert.equal(findAgent([], 'explore'), undefined);
    // A model may send anything as the agent type.
    assert.equal(findAgent(BUILTIN_AGENTS, undefined as unknown as string), undefined);
  });

  test('an exact match is preferred to one that differs in case', () => {
    const defs = [agent('Review', 'first'), agent('review', 'second')];
    assert.equal(findAgent(defs, 'review')!.prompt, 'second');
    assert.equal(findAgent(defs, 'Review')!.prompt, 'first');
    assert.equal(findAgent(defs, 'REVIEW')!.prompt, 'first');
  });
});

describe('parseAgentsJson', () => {
  test('inline JSON keyed by agent name', () => {
    const input = JSON.stringify({
      reviewer: { description: 'Reviews code', prompt: '  You review code.\n', tools: ['Read', 'Grep'], model: 'sonnet' },
      builder: {
        description: 'Builds things',
        prompt: 'You build.',
        tools: ['Read', 'Edit'],
        disallowedTools: ['WebFetch'],
        model: 'qwen3:8b',
        permissionMode: 'acceptEdits',
        maxTurns: 5,
        skills: ['conventions'],
        omitClaudeMd: true,
        effort: 'low',
        initialPrompt: 'Start.',
        background: true,
        color: 'green',
        mcpServers: { github: {} },
        hooks: {},
        memory: 'project',
        somethingElse: 1,
      },
    });
    assert.deepEqual(parseAgentsJson(input), {
      agents: [
        { name: 'reviewer', description: 'Reviews code', tools: ['Read', 'Grep'], prompt: 'You review code.', source: 'flag' },
        {
          name: 'builder',
          description: 'Builds things',
          tools: ['Read', 'Edit'],
          disallowedTools: ['WebFetch'],
          model: 'qwen3:8b',
          permissionMode: 'acceptEdits',
          maxTurns: 5,
          skills: ['conventions'],
          omitMemory: true,
          effort: 'low',
          initialPrompt: 'Start.',
          background: true,
          color: 'green',
          prompt: 'You build.',
          source: 'flag',
        },
      ],
    });
  });

  test('a description is optional and whitespace around the JSON is fine', () => {
    assert.deepEqual(parseAgentsJson('  \n{"quick": {"prompt": "Be quick."}}\n'), { agents: [{ name: 'quick', description: '', prompt: 'Be quick.', source: 'flag' }] });
    assert.deepEqual(parseAgentsJson('{}'), { agents: [] });
  });

  test('tools and disallowedTools as comma strings', () => {
    const { agents, error } = parseAgentsJson('{"a": {"prompt": "p", "tools": "Read, Grep,Glob, Bash(git log *)", "disallowedTools": "Write,Edit"}, "b": {"prompt": "p", "tools": "Read"}}');
    assert.equal(error, undefined);
    assert.deepEqual(agents[0]!.tools, ['Read', 'Grep', 'Glob', 'Bash(git log *)']);
    assert.deepEqual(agents[0]!.disallowedTools, ['Write', 'Edit']);
    assert.deepEqual(agents[1]!.tools, ['Read']);
    assert.equal(agents[1]!.disallowedTools, undefined);
  });

  test('a path to a JSON file', () => {
    const root = tempProject();
    writeFiles(root, { 'conf/agents.json': `${BOM}{"helper": {"description": "Helps", "prompt": "You help.", "tools": "Read"}}\n` });
    assert.deepEqual(parseAgentsJson(path.join(root, 'conf', 'agents.json')), {
      agents: [{ name: 'helper', description: 'Helps', tools: ['Read'], prompt: 'You help.', source: 'flag' }],
    });
  });

  test('the file is read through the reader that was passed in', () => {
    const asked: string[] = [];
    const reader = (p: string) => {
      asked.push(p);
      return '{"x": {"prompt": "X"}}';
    };
    assert.deepEqual(parseAgentsJson(' conf/agents.json ', reader).agents.map((a) => a.name), ['x']);
    assert.deepEqual(parseAgentsJson('~/agents.json', reader).agents.map((a) => a.name), ['x']);
    assert.deepEqual(asked, ['conf/agents.json', path.join(os.homedir(), 'agents.json')]);
    // Inline JSON never touches the reader.
    parseAgentsJson('{"y": {"prompt": "Y"}}', reader);
    assert.equal(asked.length, 2);
  });

  test('a file that cannot be read', () => {
    const missing = path.join(tempProject(), 'missing.json');
    const res = parseAgentsJson(missing);
    assert.deepEqual(res.agents, []);
    assert.match(res.error!, /^Could not read the agents file .*missing\.json: .*ENOENT/);
    const denied = parseAgentsJson('agents.json', () => {
      throw new Error('EACCES: permission denied');
    });
    assert.deepEqual(denied.agents, []);
    assert.match(denied.error!, /Could not read the agents file agents\.json: EACCES: permission denied/);
  });

  test('an agent without a prompt is reported and the others are kept', () => {
    const res = parseAgentsJson(
      JSON.stringify({
        good: { prompt: 'ok' },
        noprompt: { description: 'd', tools: ['Read'] },
        blank: { prompt: '   ' },
        wrongtype: { prompt: 5 },
        text: 'just a string',
        nothing: null,
        badtools: { prompt: 'p', tools: 7 },
        mixedtools: { prompt: 'p', disallowedTools: ['Read', 3] },
      }),
    );
    assert.deepEqual(res.agents, [{ name: 'good', description: '', prompt: 'ok', source: 'flag' }]);
    assert.match(res.error!, /agent "noprompt" needs a non-empty "prompt"/);
    assert.match(res.error!, /agent "blank" needs a non-empty "prompt"/);
    assert.match(res.error!, /agent "wrongtype" needs a non-empty "prompt"/);
    assert.match(res.error!, /agent "text" must be an object/);
    assert.match(res.error!, /agent "nothing" must be an object/);
    assert.match(res.error!, /agent "badtools": "tools" must be a list of tool names or a comma-separated string/);
    assert.match(res.error!, /agent "mixedtools": "disallowedTools" must be/);

    const one = parseAgentsJson('{"solo": {"description": "no prompt"}}');
    assert.deepEqual(one.agents, []);
    assert.equal(one.error, 'The agents JSON has an invalid definition: agent "solo" needs a non-empty "prompt".');
  });

  test('invalid JSON', () => {
    for (const input of ['{"a": {"prompt": "p"}', '{a: 1}', '{', '{"a": {"prompt": "p"}} trailing']) {
      const res = parseAgentsJson(input);
      assert.deepEqual(res.agents, [], input);
      assert.match(res.error!, /^The agents JSON is not valid JSON: /, input);
    }
    const file = parseAgentsJson('agents.json', () => 'not json at all');
    assert.deepEqual(file.agents, []);
    assert.match(file.error!, /^The agents file agents\.json is not valid JSON: /);
    assert.match(parseAgentsJson('agents.json', () => '').error!, /not valid JSON/);
  });

  test('anything but an object keyed by name', () => {
    for (const content of ['[]', '[{"prompt": "p"}]', '"text"', '42', 'null', 'true']) {
      const res = parseAgentsJson('agents.json', () => content);
      assert.deepEqual(res.agents, [], content);
      assert.match(res.error!, /^The agents file agents\.json must be a JSON object keyed by agent name/, content);
    }
    // Inline, such input does not start with a brace, so it is taken for a path that does not exist.
    const res = parseAgentsJson('[{"prompt": "p"}]', () => {
      throw new Error('ENOENT: no such file or directory');
    });
    assert.deepEqual(res.agents, []);
    assert.match(res.error!, /Could not read the agents file .*Expected a JSON object keyed by agent name/);
  });

  test('empty input', () => {
    for (const input of ['', '   ', '\n']) {
      const res = parseAgentsJson(input);
      assert.deepEqual(res.agents, []);
      assert.match(res.error!, /^No agents were given/);
    }
  });

  test('never throws', () => {
    const reader = () => {
      throw new Error('nope');
    };
    for (const input of ['{', '}', '{"a":', 'nul', '{"__proto__": {"prompt": "p"}}', '{"constructor": {"prompt": "p"}}', '{"a": null}', '{"a": []}', '{"": {"prompt": "p"}}']) {
      assert.doesNotThrow(() => parseAgentsJson(input, reader), input);
    }
    assert.doesNotThrow(() => parseAgentsJson(undefined as unknown as string, reader));
    assert.doesNotThrow(() => parseAgentsJson('agents.json', () => undefined as unknown as string));
    assert.deepEqual(parseAgentsJson('{"__proto__": {"prompt": "p"}}').agents.map((a) => a.name), ['__proto__']);
    assert.match(parseAgentsJson('{"": {"prompt": "p"}}').error!, /an agent has an empty name/);
  });
});
