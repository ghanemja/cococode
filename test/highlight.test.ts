import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { setColorEnabled, stripAnsi } from '../src/ui/ansi.ts';
import { highlight, highlightLine, isHighlightable, type HighlightState } from '../src/ui/highlight.ts';

const GRAY = '\x1b[90m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const END = '\x1b[39m';

const gray = (s: string) => `${GRAY}${s}${END}`;
const green = (s: string) => `${GREEN}${s}${END}`;
const yellow = (s: string) => `${YELLOW}${s}${END}`;
const blue = (s: string) => `${BLUE}${s}${END}`;
const magenta = (s: string) => `${MAGENTA}${s}${END}`;
const cyan = (s: string) => `${CYAN}${s}${END}`;

const SAMPLES: Record<string, string> = {
  ts: [
    'import { readFile } from "node:fs";',
    '/* a block',
    '   comment */',
    'export async function load(path: string): Promise<number> {',
    '  const text = `multi',
    '  line ${path}`; // trailing',
    "  return text.length > 0x1f ? 1_000 : null ?? 3.5e2 + 'x'.length;",
    '}',
  ].join('\n'),
  python: [
    'def greet(name: str) -> None:',
    '    """Docstring',
    '    spans lines."""',
    "    print(f'hello {name}')  # say hi",
    '    return None if name else True',
  ].join('\n'),
  bash: ['#!/bin/bash', 'for f in *.txt; do', '  echo "$f: ${#f} chars" # count', "  n=$(wc -l < '$f')", 'done', 'url=http://x/#frag'].join('\n'),
  json: '{\n  "name": "coco",\n  "n": 12.5,\n  "ok": true,\n  "nil": null,\n  "list": ["a", "b"]\n}',
  go: 'package main\n\nfunc main() {\n\tr := \'x\'\n\ts := `raw\nstring`\n\tfmt.Println(r, s, nil) // done\n}',
  rust: "fn first<'a>(xs: &'a [u8]) -> Option<char> {\n    let c = 'x'; // char\n    Some(c)\n}",
  c: '#include <stdio.h>\nint main(void) {\n  char c = \'\\n\';\n  printf("%d\\n", 42); /* out */\n  return 0;\n}',
  cpp: 'template <typename T>\nclass Box { public: T value; };\nauto p = nullptr;',
  java: 'public class A {\n  /** doc */\n  static final int N = 10;\n  String s = "x";\n}',
  cs: 'using System;\n#region r\nvar x = await Foo("a"); // c\n#endregion',
  ruby: 'def hi(name)\n  puts "hi #{name}" # greet\nend\nx = nil',
  php: '<?php\n$total = count($items); // n\necho "sum: $total";\n# note',
  sql: "SELECT id, name FROM users -- all\nWHERE name = 'o''brien' AND age > 21\n/* multi\n   line */ ORDER BY id;",
  yaml: 'name: coco # app\nversion: 1.2\nenabled: true\nurl: "http://x/#y"\nlist:\n  - a-b: c',
  toml: '[package]\nname = "coco" # app\nversion = 1\n[[bin]]\nenabled = true\ntext = """\nmulti\n"""',
  html: '<!-- note\n  more -->\n<div class="a" id=\'b\' hidden>\n  <p>text &amp; more</p>\n</div>',
  css: '/* c */\n@media (min-width: 10px) {\n  .a:hover { color: #fff; margin: 0 auto !important; }\n}',
  diff: 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n context\n-old\n+new',
  markdown: '# Title\n\nSome *text* with `code`.',
  lua: 'local x = 1 -- one\n--[[ block\ncomment ]]\nfunction f() return nil end',
  dockerfile: 'FROM node:22 AS build\n# deps\nRUN npm ci\nENV PATH=$PATH:/app',
  kotlin: 'fun main() {\n  val s = """raw\n  text"""\n  println(s) // out\n}',
  swift: 'func add(_ a: Int) -> Int {\n  let s = "x" // c\n  return a + 1\n}',
  ini: '[core]\n; comment\nname = value\nflag = true',
};

beforeEach(() => setColorEnabled(true));
afterEach(() => setColorEnabled(false));

describe('highlight: invariants', () => {
  test('only adds escape sequences, for every language', () => {
    for (const [lang, code] of Object.entries(SAMPLES)) {
      const out = highlight(code, lang);
      assert.equal(stripAnsi(out), code, lang);
      assert.equal(out.split('\n').length, code.split('\n').length, `${lang}: line count`);
    }
  });

  test('is the identity when colour is off', () => {
    setColorEnabled(false);
    for (const [lang, code] of Object.entries(SAMPLES)) assert.equal(highlight(code, lang), code, lang);
  });

  test('actually colours something for every language except markdown', () => {
    for (const [lang, code] of Object.entries(SAMPLES)) {
      if (lang === 'markdown') assert.equal(highlight(code, lang), code);
      else assert.notEqual(highlight(code, lang), code, lang);
    }
  });

  test('every line is self-contained', () => {
    for (const [lang, code] of Object.entries(SAMPLES)) {
      for (const line of highlight(code, lang).split('\n')) {
        // Each open sequence is closed on the same line.
        // eslint-disable-next-line no-control-regex
        const opens = (line.match(/\x1b\[(?:1|3[0-7]|9[0-7])m/g) ?? []).length;
        // eslint-disable-next-line no-control-regex
        const closes = (line.match(/\x1b\[(?:22|39)m/g) ?? []).length;
        assert.equal(opens, closes, `${lang}: ${JSON.stringify(line)}`);
      }
    }
  });

  test('unknown or missing languages come back unchanged', () => {
    const code = 'const x = "y"; // z';
    assert.equal(highlight(code, 'brainfuck'), code);
    assert.equal(highlight(code, undefined), code);
    assert.equal(highlight(code, ''), code);
    assert.equal(highlight(code, 'constructor'), code);
    assert.equal(highlight(code, '__proto__'), code);
    assert.equal(isHighlightable('ts'), true);
    assert.equal(isHighlightable('nope'), false);
  });

  test('language names are case-insensitive and aliases resolve', () => {
    const code = 'const x = 1;';
    const expected = highlight(code, 'js');
    assert.notEqual(expected, code);
    for (const alias of ['JS', 'javascript', 'JavaScript', 'jsx', ' mjs ']) assert.equal(highlight(code, alias), expected, alias);
    assert.equal(highlight('x = None', 'py'), highlight('x = None', 'python'));
    assert.equal(highlight('echo hi', 'sh'), highlight('echo hi', 'zsh'));
    assert.equal(highlight('a: 1', 'yml'), highlight('a: 1', 'yaml'));
  });

  test('never throws on hostile input', () => {
    const nasty = ['', '\n\n\n', '"', "'", '`', '/*', '"""', '\\', '"\\', '\x00\x1b[31m', '\r\n\r\n', '<', '<!--', '$', '${', '#', '😀"😀', 'a'.repeat(5000)];
    for (const lang of Object.keys(SAMPLES)) {
      for (const code of nasty) {
        const out = highlight(code, lang);
        assert.equal(stripAnsi(out).replace(/\x1b\[31m/g, ''), stripAnsi(code).replace(/\x1b\[31m/g, ''), `${lang}: ${JSON.stringify(code.slice(0, 20))}`); // eslint-disable-line no-control-regex
        assert.equal(out.split('\n').length, code.split('\n').length);
      }
    }
  });

  test('a trailing carriage return stays outside the colour', () => {
    assert.equal(highlight('// c\r\nx', 'js'), `${gray('// c')}\r\nx`);
  });
});

describe('highlight: typescript', () => {
  test('keywords, strings, numbers, literals, comments and calls', () => {
    assert.equal(highlight('const x = 42;', 'ts'), `${magenta('const')} x = ${yellow('42')};`);
    assert.equal(highlight('return "a" + \'b\';', 'ts'), `${magenta('return')} ${green('"a"')} + ${green("'b'")};`);
    assert.equal(highlight('x = null // why', 'ts'), `x = ${cyan('null')} ${gray('// why')}`);
    assert.equal(highlight('foo(bar)', 'ts'), `${blue('foo')}(bar)`);
    assert.equal(highlight('if (ok) run()', 'ts'), `${magenta('if')} (ok) ${blue('run')}()`);
    assert.equal(highlight('0xff 1_000 3.5e-2 10n', 'ts'), `${yellow('0xff')} ${yellow('1_000')} ${yellow('3.5e-2')} ${yellow('10n')}`);
  });

  test('keywords inside identifiers are not coloured', () => {
    assert.equal(highlight('constant classify $if iffy', 'ts'), 'constant classify $if iffy');
    assert.equal(highlight('x1 = y2', 'ts'), 'x1 = y2');
  });

  test('comment markers and keywords inside strings are left alone', () => {
    assert.equal(highlight('"// not a comment" + "if"', 'ts'), `${green('"// not a comment"')} + ${green('"if"')}`);
    assert.equal(highlight('"a \\" b" c', 'ts'), `${green('"a \\" b"')} c`);
  });

  test('block comments keep their colour on every line', () => {
    assert.equal(highlight('a /* one\ntwo\nthree */ b', 'ts'), [`a ${gray('/* one')}`, gray('two'), `${gray('three */')} b`].join('\n'));
  });

  test('template literals span lines; ordinary strings do not', () => {
    assert.equal(highlight('`a\nb` c', 'ts'), [green('`a'), `${green('b`')} c`].join('\n'));
    assert.equal(highlight('"unterminated\nnext', 'ts'), [green('"unterminated'), 'next'].join('\n'));
  });
});

describe('highlight: other languages', () => {
  test('python triple-quoted strings span lines and # starts a comment', () => {
    assert.equal(highlight('x = """a\nb"""\ny = 1 # c', 'python'), [`x = ${green('"""a')}`, green('b"""'), `y = ${yellow('1')} ${gray('# c')}`].join('\n'));
    assert.equal(highlight('def f(): return None', 'py'), `${magenta('def')} ${blue('f')}(): ${magenta('return')} ${cyan('None')}`);
  });

  test('bash: # is a comment only at a word boundary, variables are coloured', () => {
    assert.equal(highlight('echo a#b # c', 'bash'), `echo a#b ${gray('# c')}`);
    assert.equal(highlight('echo $HOME ${#arr[@]} $1 $#', 'sh'), `echo ${cyan('$HOME')} ${cyan('${#arr[@]}')} ${cyan('$1')} ${cyan('$#')}`);
    assert.equal(highlight("echo 'a\nb'", 'bash'), [`echo ${green("'a")}`, green("b'")].join('\n'));
    assert.equal(highlight('if true; then exit 1; fi', 'bash'), `${magenta('if')} ${cyan('true')}; ${magenta('then')} ${magenta('exit')} ${yellow('1')}; ${magenta('fi')}`);
  });

  test('json keys differ from string values', () => {
    assert.equal(highlight('{"a": "b", "n": 1, "t": true}', 'json'), `{${cyan('"a"')}: ${green('"b"')}, ${cyan('"n"')}: ${yellow('1')}, ${cyan('"t"')}: ${cyan('true')}}`);
  });

  test('sql keywords are case-insensitive', () => {
    assert.equal(highlight('SELECT a from t -- c', 'sql'), `${magenta('SELECT')} a ${magenta('from')} t ${gray('-- c')}`);
    assert.equal(highlight("where n = 'it''s'", 'sql'), `${magenta('where')} n = ${green("'it'")}${green("'s'")}`);
  });

  test('rust lifetimes are not strings but char literals are', () => {
    assert.equal(highlight("fn f<'a>(x: &'a str) {}", 'rust'), `${magenta('fn')} f<'a>(x: &'a str) {}`);
    assert.equal(highlight("let c = 'x';", 'rust'), `${magenta('let')} c = ${green("'x'")};`);
    assert.equal(highlight("let n = '\\n';", 'rs'), `${magenta('let')} n = ${green("'\\n'")};`);
  });

  test('c preprocessor directives', () => {
    assert.equal(highlight('#include <stdio.h>', 'c'), `${magenta('#include')} <stdio.h>`);
    assert.equal(highlight('  # define N 3', 'c'), `  ${magenta('# define')} N ${yellow('3')}`);
    assert.equal(highlight('int x = NULL;', 'c'), `${magenta('int')} x = ${cyan('NULL')};`);
  });

  test('go raw strings span lines without escapes', () => {
    assert.equal(highlight('s := `a\\\nb`', 'go'), [`s := ${green('`a\\')}`, green('b`')].join('\n'));
  });

  test('yaml keys, comments and literals', () => {
    assert.equal(highlight('name: coco # app', 'yaml'), `${cyan('name')}: coco ${gray('# app')}`);
    assert.equal(highlight('on: true', 'yaml'), `${cyan('on')}: ${cyan('true')}`);
    assert.equal(highlight('url: http://x/#y', 'yaml'), `${cyan('url')}: http://x/#y`);
    assert.equal(highlight('my-key: 3', 'yml'), `${cyan('my-key')}: ${yellow('3')}`);
  });

  test('toml sections and keys', () => {
    assert.equal(highlight('[package] # p', 'toml'), `${magenta('[package]')} ${gray('# p')}`);
    assert.equal(highlight('name = "x"', 'toml'), `${cyan('name')} = ${green('"x"')}`);
    assert.equal(highlight('a.b-c = true', 'toml'), `${cyan('a.b-c')} = ${cyan('true')}`);
  });

  test('html tags, attributes, strings and comments', () => {
    assert.equal(highlight('<a href="x">t</a>', 'html'), `<${magenta('a')} ${cyan('href')}=${green('"x"')}>t</${magenta('a')}>`);
    assert.equal(highlight('<!-- a\nb --> <p>', 'html'), [gray('<!-- a'), `${gray('b -->')} <${magenta('p')}>`].join('\n'));
    assert.equal(highlight('<div\n  class="a">', 'xml'), [`<${magenta('div')}`, `  ${cyan('class')}=${green('"a"')}>`].join('\n'));
  });

  test('css properties, at-rules, colours and comments', () => {
    assert.equal(highlight('color: #fff;', 'css'), `${cyan('color')}: ${yellow('#fff')};`);
    assert.equal(highlight('a:hover { }', 'css'), 'a:hover { }');
    assert.equal(highlight('@media print /* c */', 'css'), `${magenta('@media')} print ${gray('/* c */')}`);
    assert.equal(highlight('margin: 10px !important;', 'css'), `${cyan('margin')}: ${yellow('10px')} ${magenta('!important')};`);
  });

  test('diff lines', () => {
    assert.equal(highlight('+added\n-removed\n context\n@@ -1 +1 @@', 'diff'), [`${GREEN}+added${END}`, `${RED}-removed${END}`, ' context', cyan('@@ -1 +1 @@')].join('\n'));
    assert.equal(highlight('--- a/f', 'diff'), '\x1b[1m--- a/f\x1b[22m');
  });

  test('markdown passes through', () => {
    assert.equal(highlight('# T\n`x` "y"', 'md'), '# T\n`x` "y"');
  });
});

describe('highlightLine', () => {
  test('carrying the state line by line matches highlighting the whole block', () => {
    for (const [lang, code] of Object.entries(SAMPLES)) {
      let state: HighlightState = null;
      const out = code.split('\n').map((line) => {
        const res = highlightLine(line, lang, state);
        state = res.state;
        return res.text;
      });
      assert.equal(out.join('\n'), highlight(code, lang), lang);
    }
  });

  test('reports what is still open at the end of the line', () => {
    assert.deepEqual(highlightLine('x /* open', 'ts').state, { kind: 'comment', close: '*/' });
    assert.equal(highlightLine('x /* closed */', 'ts').state, null);
    assert.equal(highlightLine('s = """doc', 'python').state?.kind, 'string');
    assert.equal(highlightLine('"single line', 'ts').state, null);
    assert.equal(highlightLine('<div', 'html').state?.kind, 'tag');
  });

  test('a stale state can be reused to preview without committing', () => {
    const open = highlightLine('/* start', 'ts').state;
    assert.equal(highlightLine('partial', 'ts', open).text, gray('partial'));
    assert.equal(highlightLine('partial */ done', 'ts', open).text, `${gray('partial */')} done`);
    assert.equal(highlightLine('partial', 'ts', open).text, gray('partial'));
  });

  test('unknown language: line unchanged, no state', () => {
    assert.deepEqual(highlightLine('x "y"', 'nope', null), { text: 'x "y"', state: null });
  });
});
