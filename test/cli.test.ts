import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { parseArgs, splitRules } from '../src/cli.ts';
import { tempProject, writeFiles } from './helpers.ts';

describe('command-line parsing', () => {
  test('flags, values and the prompt', () => {
    const { flags, positional } = parseArgs(['-p', 'fix the bug', '--model', 'qwen3:8b', '--max-turns=5', '--verbose']);
    assert.equal(flags.print, true);
    assert.equal(flags.model, 'qwen3:8b');
    assert.equal(flags['max-turns'], '5');
    assert.equal(flags.verbose, true);
    assert.deepEqual(positional, ['fix the bug']);
  });

  test('short flags map to long ones', () => {
    const { flags } = parseArgs(['-c', '-m', 'llama3', '-v', '-h']);
    assert.deepEqual(flags, { continue: true, model: 'llama3', version: true, help: true });
  });

  test('a value flag with nothing after it is an error', () => {
    assert.throws(() => parseArgs(['--model']), /--model needs a value/);
  });

  test('rule lists accept separate arguments, commas and spaces', () => {
    assert.deepEqual(parseArgs(['--allowedTools', 'Bash(git log:*)', 'Edit']).flags.allowedTools, ['Bash(git log:*)', 'Edit']);
    assert.deepEqual(parseArgs(['--allowedTools', 'Bash(npm run test:*), Read,Glob']).flags.allowedTools, ['Bash(npm run test:*)', 'Read', 'Glob']);
    assert.deepEqual(parseArgs(['--disallowed-tools=WebFetch']).flags['disallowed-tools'], ['WebFetch']);
    const twice = parseArgs(['--allowedTools', 'Read', '--model', 'm', '--allowedTools', 'Edit']);
    assert.deepEqual(twice.flags.allowedTools, ['Read', 'Edit']);
  });

  test('splitRules keeps commas and spaces inside parentheses', () => {
    assert.deepEqual(splitRules('Bash(git commit -m "a, b"), Edit(src/**)'), ['Bash(git commit -m "a, b")', 'Edit(src/**)']);
    assert.deepEqual(splitRules('  Read  '), ['Read']);
    assert.deepEqual(splitRules(''), []);
  });

  test('--resume takes an id only when the next word looks like one', () => {
    assert.equal(parseArgs(['--resume', '3f2a9c1e-1111-2222-3333-444455556666']).flags.resume, '3f2a9c1e-1111-2222-3333-444455556666');
    assert.equal(parseArgs(['--resume', '3f2a9c1e']).flags.resume, '3f2a9c1e');
    const withPrompt = parseArgs(['--resume', 'added', 'the', 'tests']);
    assert.equal(withPrompt.flags.resume, true);
    assert.deepEqual(withPrompt.positional, ['added', 'the', 'tests']);
    assert.equal(parseArgs(['-r']).flags.resume, true);
  });

  test('everything after -- is positional, flags included', () => {
    const { flags, positional } = parseArgs(['mcp', 'add', 'files', '-e', 'TOKEN=a,b', '-e', 'X=1', '--', 'npx', '-y', 'server', '--root', '.']);
    assert.deepEqual(flags.env, ['TOKEN=a,b', 'X=1']);
    assert.deepEqual(positional, ['mcp', 'add', 'files', 'npx', '-y', 'server', '--root', '.']);
  });

  test('path lists stop before a prompt', () => {
    const dir = tempProject();
    writeFiles(dir, { 'lib/x.txt': '', 'other/y.txt': '' });
    const a = path.join(dir, 'lib');
    const b = path.join(dir, 'other');
    const { flags, positional } = parseArgs(['--add-dir', a, b, 'now refactor the shared code']);
    assert.deepEqual(flags['add-dir'], [a, b]);
    assert.deepEqual(positional, ['now refactor the shared code']);
  });

  test('unknown flags are kept as booleans or inline values', () => {
    assert.deepEqual(parseArgs(['--no-color', '--weird=1']).flags, { 'no-color': true, weird: '1' });
  });
});
