/**
 * A small syntax highlighter for code blocks in the terminal.
 *
 * One generic tokenizer is driven by per-language tables (keywords, comment
 * markers, string delimiters). It works a line at a time and carries the open
 * construct (block comment, multi-line string) from one line to the next, so
 * every returned line is self-contained and a streamed code block can be
 * coloured as its lines arrive.
 */
import { c } from './ansi.ts';

type Kind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'func' | 'prop';

/** What is still open at the end of a line. `null` means nothing. */
export type HighlightState =
  | null
  | { kind: 'comment'; close: string }
  | { kind: 'string'; rule: number }
  | { kind: 'tag' };

export interface HighlightedLine {
  text: string;
  state: HighlightState;
}

interface StringRule {
  open: string;
  close: string;
  multiline: boolean;
  escape: boolean;
}

interface Lang {
  keywords: Set<string>;
  literals: Set<string>;
  line: string[];
  block: [string, string][];
  strings: StringRule[];
  /** Sticky regex matching an identifier. */
  ident: RegExp;
  caseInsensitive: boolean;
  /** `#` only starts a comment at the start of a line or after whitespace. */
  hashBoundary: boolean;
  /** Single quotes delimit a one-character literal (C, Rust, Go, Java). */
  charLiteral: boolean;
  /** How a property/key is recognised, if the language has them. */
  prop?: 'colon' | 'colon-space' | 'equals';
  /** `$name` is coloured as a variable. */
  vars: boolean;
  /** `#include` style directives. */
  preproc: boolean;
  /** `[section]` header lines (TOML, INI). */
  sections: boolean;
  /** `@rule`, `#hex`, `!important`. */
  css: boolean;
  /** Colour identifiers that are immediately followed by `(`. */
  funcs: boolean;
}

type LineFn = (line: string, state: HighlightState) => HighlightedLine;

function paint(kind: Kind, text: string): string {
  switch (kind) {
    case 'comment':
      return c.gray(text);
    case 'string':
      return c.green(text);
    case 'number':
      return c.yellow(text);
    case 'keyword':
      return c.magenta(text);
    case 'literal':
    case 'prop':
      return c.cyan(text);
    case 'func':
      return c.blue(text);
    default:
      return text;
  }
}

const DQ: StringRule = { open: '"', close: '"', multiline: false, escape: true };
const SQ: StringRule = { open: "'", close: "'", multiline: false, escape: true };
const SQ_RAW: StringRule = { open: "'", close: "'", multiline: false, escape: false };
const BACKTICK: StringRule = { open: '`', close: '`', multiline: true, escape: true };
const BACKTICK_RAW: StringRule = { open: '`', close: '`', multiline: true, escape: false };
const TRIPLE_DQ: StringRule = { open: '"""', close: '"""', multiline: true, escape: true };
const TRIPLE_SQ: StringRule = { open: "'''", close: "'''", multiline: true, escape: true };
const C_BLOCK: [string, string][] = [['/*', '*/']];

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const IDENT_DOLLAR = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const IDENT_DASHED = /[A-Za-z_][A-Za-z0-9_.-]*/y;
const IDENT_CSS = /-{0,2}[A-Za-z_][A-Za-z0-9_-]*/y;

interface LangInit {
  kw?: string;
  lit?: string;
  line?: string[];
  block?: [string, string][];
  strings?: StringRule[];
  ident?: RegExp;
  caseInsensitive?: boolean;
  hashBoundary?: boolean;
  charLiteral?: boolean;
  prop?: 'colon' | 'colon-space' | 'equals';
  vars?: boolean;
  preproc?: boolean;
  sections?: boolean;
  css?: boolean;
  funcs?: boolean;
}

function words(list: string | undefined): Set<string> {
  return new Set((list ?? '').split(/\s+/).filter(Boolean));
}

function def(init: LangInit): LineFn {
  const lang: Lang = {
    keywords: words(init.kw),
    literals: words(init.lit),
    line: init.line ?? [],
    block: init.block ?? [],
    strings: init.strings ?? [DQ, SQ],
    ident: init.ident ?? IDENT,
    caseInsensitive: init.caseInsensitive ?? false,
    hashBoundary: init.hashBoundary ?? false,
    charLiteral: init.charLiteral ?? false,
    prop: init.prop,
    vars: init.vars ?? false,
    preproc: init.preproc ?? false,
    sections: init.sections ?? false,
    css: init.css ?? false,
    funcs: init.funcs ?? true,
  };
  return (line, state) => genericLine(line, lang, state);
}

function scanString(line: string, from: number, rule: StringRule): { end: number; closed: boolean } {
  let j = from;
  while (j < line.length) {
    if (rule.escape && line[j] === '\\') {
      j += 2;
      continue;
    }
    if (line.startsWith(rule.close, j)) return { end: j + rule.close.length, closed: true };
    j++;
  }
  return { end: line.length, closed: false };
}

const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[A-Za-z%]*/y;
const CHAR_LITERAL = /'(?:\\.[^']{0,8}|[^\\'])'/y;
const VARIABLE = /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$-])/y;
const PREPROC = /#[ \t]*[A-Za-z_]+/y;
const CSS_AT = /@[A-Za-z-]+/y;
const CSS_HEX = /#[0-9a-fA-F]{3,8}(?![A-Za-z0-9_-])/y;
const CSS_IMPORTANT = /![A-Za-z]+/y;
const SECTION = /^(\s*)(\[\[?[^\]]*\]\]?)(\s*)((?:[#;].*)?)$/;

function matchAt(re: RegExp, line: string, at: number): string | null {
  re.lastIndex = at;
  const m = re.exec(line);
  return m ? m[0] : null;
}

function genericLine(line: string, lang: Lang, state: HighlightState): HighlightedLine {
  let out = '';
  let i = 0;
  const n = line.length;

  // Finish whatever the previous line left open.
  if (state?.kind === 'comment') {
    const end = line.indexOf(state.close);
    if (end < 0) return { text: paint('comment', line), state };
    i = end + state.close.length;
    out += paint('comment', line.slice(0, i));
  } else if (state?.kind === 'string') {
    const rule = lang.strings[state.rule];
    if (rule) {
      const scan = scanString(line, 0, rule);
      if (!scan.closed) return { text: paint('string', line), state };
      i = scan.end;
      out += paint('string', line.slice(0, i));
    }
  }

  if (lang.sections && i === 0) {
    const m = SECTION.exec(line);
    if (m) {
      return { text: m[1]! + paint('keyword', m[2]!) + m[3]! + paint('comment', m[4]!), state: null };
    }
  }

  let plain = '';
  const flush = () => {
    out += plain;
    plain = '';
  };
  const onlySpaceBefore = (at: number) => line.slice(0, at).trim() === '';

  scan: while (i < n) {
    const ch = line[i]!;

    for (const [open, close] of lang.block) {
      if (line.startsWith(open, i)) {
        flush();
        const end = line.indexOf(close, i + open.length);
        if (end < 0) {
          out += paint('comment', line.slice(i));
          return { text: out, state: { kind: 'comment', close } };
        }
        out += paint('comment', line.slice(i, end + close.length));
        i = end + close.length;
        continue scan;
      }
    }

    for (const marker of lang.line) {
      if (!line.startsWith(marker, i)) continue;
      if (marker === '#' && lang.hashBoundary && i > 0 && !/\s/.test(line[i - 1]!)) continue;
      flush();
      out += paint('comment', line.slice(i));
      return { text: out, state: null };
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      if (ch === "'" && lang.charLiteral) {
        const lit = matchAt(CHAR_LITERAL, line, i);
        if (lit) {
          flush();
          out += paint('string', lit);
          i += lit.length;
          continue;
        }
      } else {
        for (let r = 0; r < lang.strings.length; r++) {
          const rule = lang.strings[r]!;
          if (!line.startsWith(rule.open, i)) continue;
          flush();
          const scan = scanString(line, i + rule.open.length, rule);
          const text = line.slice(i, scan.end);
          if (!scan.closed) {
            out += paint('string', text);
            return { text: out, state: rule.multiline ? { kind: 'string', rule: r } : null };
          }
          i = scan.end;
          const isKey = lang.prop === 'colon' && /^\s*:/.test(line.slice(i));
          out += paint(isKey ? 'prop' : 'string', text);
          continue scan;
        }
      }
    }

    if (ch === '$' && lang.vars) {
      const v = matchAt(VARIABLE, line, i);
      if (v) {
        flush();
        out += paint('literal', v);
        i += v.length;
        continue;
      }
    }

    if (ch === '#' && lang.preproc && onlySpaceBefore(i)) {
      const d = matchAt(PREPROC, line, i);
      if (d) {
        flush();
        out += paint('keyword', d);
        i += d.length;
        continue;
      }
    }

    if (lang.css && (ch === '@' || ch === '#' || ch === '!')) {
      const m = matchAt(ch === '@' ? CSS_AT : ch === '#' ? CSS_HEX : CSS_IMPORTANT, line, i);
      if (m) {
        flush();
        out += paint(ch === '#' ? 'number' : 'keyword', m);
        i += m.length;
        continue;
      }
    }

    if (ch >= '0' && ch <= '9') {
      const num = matchAt(NUMBER, line, i);
      if (num) {
        flush();
        out += paint('number', num);
        i += num.length;
        continue;
      }
    }

    const word = matchAt(lang.ident, line, i);
    if (word) {
      flush();
      const after = line.slice(i + word.length);
      const key = lang.caseInsensitive ? word.toLowerCase() : word;
      let kind: Kind = 'plain';
      if (lang.prop === 'equals' && onlySpaceBefore(i) && /^\s*=/.test(after)) kind = 'prop';
      else if (lang.prop === 'colon' && /^\s*:/.test(after)) kind = 'prop';
      else if (lang.prop === 'colon-space' && /^:(?:\s|$)/.test(after)) kind = 'prop';
      else if (lang.keywords.has(key)) kind = 'keyword';
      else if (lang.literals.has(key)) kind = 'literal';
      else if (lang.funcs && after.startsWith('(')) kind = 'func';
      out += paint(kind, word);
      i += word.length;
      continue;
    }

    plain += ch;
    i++;
  }
  flush();
  return { text: out, state: null };
}

const TAG_OPEN = /<\/?[A-Za-z!?][A-Za-z0-9:.-]*/y;
const TAG_ATTR = /[^\s=<>/"']+/y;

function markupLine(line: string, state: HighlightState): HighlightedLine {
  let out = '';
  let i = 0;
  let st: HighlightState = state;
  const n = line.length;
  while (i < n) {
    if (st?.kind === 'comment') {
      const end = line.indexOf(st.close, i);
      if (end < 0) {
        out += paint('comment', line.slice(i));
        return { text: out, state: st };
      }
      out += paint('comment', line.slice(i, end + st.close.length));
      i = end + st.close.length;
      st = null;
      continue;
    }
    const ch = line[i]!;
    if (st?.kind === 'tag') {
      if (ch === '>') {
        out += ch;
        i++;
        st = null;
      } else if (ch === '"' || ch === "'") {
        const end = line.indexOf(ch, i + 1);
        const stop = end < 0 ? n : end + 1;
        out += paint('string', line.slice(i, stop));
        i = stop;
      } else {
        const attr = matchAt(TAG_ATTR, line, i);
        if (attr) {
          out += paint('prop', attr);
          i += attr.length;
        } else {
          out += ch;
          i++;
        }
      }
      continue;
    }
    if (line.startsWith('<!--', i)) {
      st = { kind: 'comment', close: '-->' };
      continue;
    }
    if (ch === '<') {
      const tag = matchAt(TAG_OPEN, line, i);
      if (tag) {
        const nameAt = tag.startsWith('</') ? 2 : 1;
        out += tag.slice(0, nameAt) + paint('keyword', tag.slice(nameAt));
        i += tag.length;
        st = { kind: 'tag' };
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { text: out, state: st };
}

function diffLine(line: string): HighlightedLine {
  let text = line;
  if (line.startsWith('+++') || line.startsWith('---')) text = c.bold(line);
  else if (line.startsWith('@@')) text = c.cyan(line);
  else if (line.startsWith('+')) text = c.green(line);
  else if (line.startsWith('-')) text = c.red(line);
  else if (/^(?:diff |index |new file|deleted file|rename |similarity )/.test(line)) text = c.bold(line);
  return { text, state: null };
}

const JS_KW =
  'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set as from';
const TS_KW = `${JS_KW} interface type enum implements namespace declare readonly abstract public private protected keyof infer satisfies is module override`;
const JS_LIT = 'true false null undefined NaN Infinity';
const C_KW =
  'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while';
const CPP_KW = `${C_KW} bool catch class constexpr decltype delete explicit friend namespace new noexcept operator override private protected public template this throw try typename using virtual`;

const javascript = def({ kw: JS_KW, lit: JS_LIT, line: ['//'], block: C_BLOCK, strings: [DQ, SQ, BACKTICK], ident: IDENT_DOLLAR });
const typescript = def({ kw: TS_KW, lit: JS_LIT, line: ['//'], block: C_BLOCK, strings: [DQ, SQ, BACKTICK], ident: IDENT_DOLLAR });
const python = def({
  kw: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
  lit: 'True False None self cls',
  line: ['#'],
  strings: [TRIPLE_DQ, TRIPLE_SQ, DQ, SQ],
});
const shell = def({
  kw: 'if then else elif fi for while until do done case esac function in select time return exit local export readonly declare unset shift source alias set trap break continue eval exec',
  lit: 'true false',
  line: ['#'],
  hashBoundary: true,
  strings: [
    { open: '"', close: '"', multiline: true, escape: true },
    { open: "'", close: "'", multiline: true, escape: false },
  ],
  vars: true,
});
const json = def({ lit: 'true false null', line: ['//'], block: C_BLOCK, strings: [DQ], prop: 'colon', funcs: false });
const go = def({
  kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  lit: 'true false nil iota',
  line: ['//'],
  block: C_BLOCK,
  strings: [DQ, BACKTICK_RAW],
  charLiteral: true,
});
const rust = def({
  kw: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
  lit: 'true false None Some Ok Err',
  line: ['//'],
  block: C_BLOCK,
  strings: [{ open: '"', close: '"', multiline: true, escape: true }],
  charLiteral: true,
});
const clang = def({ kw: C_KW, lit: 'true false NULL', line: ['//'], block: C_BLOCK, strings: [DQ], charLiteral: true, preproc: true });
const cpp = def({ kw: CPP_KW, lit: 'true false NULL nullptr', line: ['//'], block: C_BLOCK, strings: [DQ], charLiteral: true, preproc: true });
const java = def({
  kw: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public record return sealed short static strictfp super switch synchronized this throw throws transient try var void volatile while yield',
  lit: 'true false null',
  line: ['//'],
  block: C_BLOCK,
  strings: [TRIPLE_DQ, DQ],
  charLiteral: true,
});
const csharp = def({
  kw: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double dynamic else enum event explicit extern finally fixed float for foreach get goto if implicit in init int interface internal is lock long namespace new object operator out override params partial private protected public readonly record ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using var virtual void volatile when where while yield',
  lit: 'true false null',
  line: ['//'],
  block: C_BLOCK,
  strings: [DQ],
  charLiteral: true,
  preproc: true,
});
const kotlin = def({
  kw: 'abstract as break by catch class companion const constructor continue data do else enum final finally for fun if import in init interface internal is lateinit object open operator override package private protected public return sealed super suspend this throw try typealias val var when while',
  lit: 'true false null',
  line: ['//'],
  block: C_BLOCK,
  strings: [TRIPLE_DQ, DQ],
  charLiteral: true,
});
const swift = def({
  kw: 'actor as async await break case catch class continue default defer do else enum extension fallthrough fileprivate final for func guard if import in init inout internal is let mutating open operator override private protocol public repeat return self Self static struct subscript super switch throw throws try typealias var where while',
  lit: 'true false nil',
  line: ['//'],
  block: C_BLOCK,
  strings: [TRIPLE_DQ, DQ],
});
const ruby = def({
  kw: 'alias and begin break case class def do else elsif end ensure extend for if in include lambda module next not or private proc protected public raise redo require require_relative rescue retry return self super then undef unless until when while yield',
  lit: 'true false nil',
  line: ['#'],
  hashBoundary: true,
});
const php = def({
  kw: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty extends final finally fn for foreach function global goto if implements include include_once instanceof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield',
  lit: 'true false null TRUE FALSE NULL',
  line: ['//', '#'],
  block: C_BLOCK,
  ident: IDENT_DOLLAR,
});
const sql = def({
  kw: 'select from where insert into values update set delete create table alter drop index view join inner left right full outer cross on as and or not is in like between group by order having limit offset union all distinct case when then else end primary key foreign references default constraint unique check exists begin commit rollback transaction with returning asc desc if add column database schema grant revoke truncate explain analyze using over partition window',
  lit: 'true false null',
  line: ['--'],
  block: C_BLOCK,
  strings: [{ open: "'", close: "'", multiline: true, escape: false }, DQ],
  caseInsensitive: true,
});
const yaml = def({
  lit: 'true false null yes no on off',
  line: ['#'],
  hashBoundary: true,
  strings: [DQ, SQ_RAW],
  ident: IDENT_DASHED,
  prop: 'colon-space',
  funcs: false,
});
const toml = def({
  lit: 'true false inf nan',
  line: ['#'],
  hashBoundary: true,
  strings: [TRIPLE_DQ, TRIPLE_SQ, DQ, SQ_RAW],
  ident: IDENT_DASHED,
  prop: 'equals',
  sections: true,
  funcs: false,
});
const ini = def({ lit: 'true false yes no on off', line: ['#', ';'], ident: IDENT_DASHED, prop: 'equals', sections: true, funcs: false });
const css = def({ block: C_BLOCK, ident: IDENT_CSS, prop: 'colon-space', css: true });
const scss = def({ line: ['//'], block: C_BLOCK, ident: IDENT_CSS, prop: 'colon-space', css: true, vars: true });
const lua = def({
  kw: 'and break do else elseif end for function goto if in local not or repeat return then until while',
  lit: 'true false nil',
  line: ['--'],
  block: [['--[[', ']]']],
});
const dockerfile = def({
  kw: 'FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS',
  line: ['#'],
  hashBoundary: true,
  vars: true,
  funcs: false,
});

const passthrough: LineFn = (line) => ({ text: line, state: null });

const LANGS: Record<string, LineFn> = {
  js: javascript,
  javascript,
  jsx: javascript,
  mjs: javascript,
  cjs: javascript,
  node: javascript,
  ts: typescript,
  typescript,
  tsx: typescript,
  mts: typescript,
  cts: typescript,
  py: python,
  python,
  python3: python,
  sh: shell,
  bash: shell,
  zsh: shell,
  shell,
  console: shell,
  json,
  jsonc: json,
  json5: json,
  jsonl: json,
  go,
  golang: go,
  rs: rust,
  rust,
  c: clang,
  h: clang,
  cpp,
  'c++': cpp,
  cc: cpp,
  cxx: cpp,
  hpp: cpp,
  java,
  cs: csharp,
  csharp,
  'c#': csharp,
  kt: kotlin,
  kotlin,
  swift,
  rb: ruby,
  ruby,
  php,
  sql,
  mysql: sql,
  postgres: sql,
  postgresql: sql,
  sqlite: sql,
  yaml,
  yml: yaml,
  toml,
  ini,
  cfg: ini,
  conf: ini,
  html: markupLine,
  htm: markupLine,
  xml: markupLine,
  svg: markupLine,
  vue: markupLine,
  css,
  scss,
  less: scss,
  lua,
  dockerfile,
  docker: dockerfile,
  md: passthrough,
  markdown: passthrough,
  diff: diffLine,
  patch: diffLine,
};

function resolve(lang: string | undefined): LineFn | undefined {
  if (!lang) return undefined;
  const key = lang.trim().toLowerCase();
  return Object.hasOwn(LANGS, key) ? LANGS[key] : undefined;
}

/** True when `lang` names a language this highlighter knows. */
export function isHighlightable(lang: string | undefined): boolean {
  return resolve(lang) !== undefined;
}

/**
 * Highlight one line. Pass the `state` returned for the previous line (or
 * `null` for the first) so block comments and multi-line strings keep their
 * colour. The state is a plain value; holding on to an old one is safe.
 */
export function highlightLine(line: string, lang: string | undefined, state: HighlightState = null): HighlightedLine {
  const fn = resolve(lang);
  if (!fn) return { text: line, state: null };
  try {
    // Keep a trailing CR out of the coloured span so it cannot split an escape pair.
    if (line.endsWith('\r')) {
      const res = fn(line.slice(0, -1), state);
      return { text: res.text + '\r', state: res.state };
    }
    return fn(line, state);
  } catch {
    return { text: line, state: null };
  }
}

/**
 * Highlight a block of code. The result has exactly the same lines as the
 * input, each coloured independently. Unknown languages come back unchanged.
 */
export function highlight(code: string, lang: string | undefined): string {
  if (!resolve(lang)) return code;
  let state: HighlightState = null;
  return code
    .split('\n')
    .map((line) => {
      const res = highlightLine(line, lang, state);
      state = res.state;
      return res.text;
    })
    .join('\n');
}
