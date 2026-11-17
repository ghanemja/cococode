import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Key } from '../src/ui/keys.ts';
import { KeyParser } from '../src/ui/keys.ts';

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Compact, readable form of a key: "ctrl+shift+left", "char:abc", "paste:...". */
function show(key: Key): string {
  const mods = `${key.ctrl ? 'ctrl+' : ''}${key.meta ? 'alt+' : ''}${key.shift ? 'shift+' : ''}`;
  if (key.name === 'char' || key.name === 'paste') return `${mods}${key.name}:${key.text}`;
  return `${mods}${key.name}`;
}

/** Feed everything at once, then flush as the escape timer would. */
function parse(input: string): string[] {
  const parser = new KeyParser();
  return [...parser.feed(input), ...parser.flush()].map(show);
}

/** Keys without the final flush, plus whether input is still pending. */
function partial(...chunks: string[]): { keys: string[]; pending: boolean } {
  const parser = new KeyParser();
  const keys = chunks.flatMap((chunk) => parser.feed(chunk));
  return { keys: keys.map(show), pending: parser.pending };
}

/** Adjacent plain text keys are one key when typed fast; merge them so chunking does not matter. */
function mergeText(keys: Key[]): string[] {
  const out: Key[] = [];
  for (const key of keys) {
    const prev = out[out.length - 1];
    if (prev && prev.name === 'char' && key.name === 'char' && !prev.ctrl && !prev.meta && !key.ctrl && !key.meta) {
      prev.text = (prev.text ?? '') + (key.text ?? '');
    } else {
      out.push({ ...key });
    }
  }
  return out.map(show);
}

function parseInChunks(chunks: string[]): string[] {
  const parser = new KeyParser();
  const keys = chunks.flatMap((chunk) => parser.feed(chunk));
  return mergeText([...keys, ...parser.flush()]);
}

describe('plain keys', () => {
  test('printable text arrives as one key', () => {
    assert.deepEqual(parse('hello world'), ['char:hello world']);
    assert.deepEqual(parse('a'), ['char:a']);
    assert.deepEqual(parse(' '), ['char: ']);
    assert.deepEqual(parse('~`!@#$%^&*()[]{}|;:\'",.<>/?\\'), ['char:~`!@#$%^&*()[]{}|;:\'",.<>/?\\']);
  });

  test('multi-byte text and emoji stay intact', () => {
    const accented = `h${String.fromCodePoint(0xe9)}llo`;
    const cjk = String.fromCodePoint(0x65e5, 0x672c);
    const thumbs = String.fromCodePoint(0x1f44d, 0x1f3fd);
    const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map((cp) => String.fromCodePoint(cp)).join('');
    assert.deepEqual(parse(`${accented} ${cjk} ${thumbs} ${family}`), [`char:${accented} ${cjk} ${thumbs} ${family}`]);
  });

  test('enter, tab, backspace', () => {
    assert.deepEqual(parse('\r'), ['return']);
    assert.deepEqual(parse('\t'), ['tab']);
    assert.deepEqual(parse('\x7f'), ['backspace']);
    assert.deepEqual(parse('\b'), ['backspace']);
  });

  test('ctrl+j (line feed) is distinct from enter', () => {
    assert.deepEqual(parse('\n'), ['ctrl+j']);
    assert.deepEqual(parse('a\rb\nc'), ['char:a', 'return', 'char:b', 'ctrl+j', 'char:c']);
  });

  test('ctrl+letter', () => {
    const special: Record<number, string> = { 8: 'backspace', 9: 'tab', 10: 'ctrl+j', 13: 'return' };
    for (let code = 1; code <= 26; code++) {
      const expected = special[code] ?? `ctrl+${String.fromCharCode(96 + code)}`;
      assert.deepEqual(parse(String.fromCharCode(code)), [expected], `code ${code}`);
    }
  });

  test('other control codes', () => {
    assert.deepEqual(parse('\x00'), ['ctrl+space']);
    assert.deepEqual(parse('\x1c'), ['ctrl+\\']);
    assert.deepEqual(parse('\x1d'), ['ctrl+]']);
    assert.deepEqual(parse('\x1e'), ['ctrl+^']);
    assert.deepEqual(parse('\x1f'), ['ctrl+_']);
  });

  test('text and control keys interleave in order', () => {
    assert.deepEqual(parse('ab\x03cd\x7f\re'), ['char:ab', 'ctrl+c', 'char:cd', 'backspace', 'return', 'char:e']);
  });

  test('empty input yields nothing', () => {
    assert.deepEqual(parse(''), []);
    assert.equal(new KeyParser().pending, false);
  });
});

describe('escape sequences', () => {
  test('arrows in CSI and SS3 form', () => {
    assert.deepEqual(parse(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`), ['up', 'down', 'right', 'left']);
    assert.deepEqual(parse(`${ESC}OA${ESC}OB${ESC}OC${ESC}OD`), ['up', 'down', 'right', 'left']);
  });

  test('home and end in every common encoding', () => {
    for (const seq of [`${ESC}[H`, `${ESC}[1~`, `${ESC}[7~`, `${ESC}OH`]) assert.deepEqual(parse(seq), ['home'], JSON.stringify(seq));
    for (const seq of [`${ESC}[F`, `${ESC}[4~`, `${ESC}[8~`, `${ESC}OF`]) assert.deepEqual(parse(seq), ['end'], JSON.stringify(seq));
  });

  test('delete, insert and page keys', () => {
    assert.deepEqual(parse(`${ESC}[3~`), ['delete']);
    assert.deepEqual(parse(`${ESC}[2~`), ['insert']);
    assert.deepEqual(parse(`${ESC}[5~`), ['pageup']);
    assert.deepEqual(parse(`${ESC}[6~`), ['pagedown']);
  });

  test('shift+tab', () => {
    assert.deepEqual(parse(`${ESC}[Z`), ['shift+tab']);
  });

  test('function keys f1-f4', () => {
    assert.deepEqual(parse(`${ESC}OP${ESC}OQ${ESC}OR${ESC}OS`), ['f1', 'f2', 'f3', 'f4']);
  });

  test('modifier parameters on arrows', () => {
    assert.deepEqual(parse(`${ESC}[1;2A`), ['shift+up']);
    assert.deepEqual(parse(`${ESC}[1;3C`), ['alt+right']);
    assert.deepEqual(parse(`${ESC}[1;4C`), ['alt+shift+right']);
    assert.deepEqual(parse(`${ESC}[1;5D`), ['ctrl+left']);
    assert.deepEqual(parse(`${ESC}[1;6B`), ['ctrl+shift+down']);
    assert.deepEqual(parse(`${ESC}[1;7A`), ['ctrl+alt+up']);
    assert.deepEqual(parse(`${ESC}[1;8A`), ['ctrl+alt+shift+up']);
    assert.deepEqual(parse(`${ESC}[1;5H`), ['ctrl+home']);
    assert.deepEqual(parse(`${ESC}[1;2F`), ['shift+end']);
  });

  test('modifier parameters on tilde keys', () => {
    assert.deepEqual(parse(`${ESC}[3;5~`), ['ctrl+delete']);
    assert.deepEqual(parse(`${ESC}[3;2~`), ['shift+delete']);
    assert.deepEqual(parse(`${ESC}[5;3~`), ['alt+pageup']);
  });

  test('alt-prefixed keys', () => {
    assert.deepEqual(parse(`${ESC}\r`), ['alt+return']);
    assert.deepEqual(parse(`${ESC}\x7f`), ['alt+backspace']);
    assert.deepEqual(parse(`${ESC}\b`), ['alt+backspace']);
    assert.deepEqual(parse(`${ESC}b`), ['alt+b']);
    assert.deepEqual(parse(`${ESC}f`), ['alt+f']);
    assert.deepEqual(parse(`${ESC}d`), ['alt+d']);
    assert.deepEqual(parse(`${ESC}B`), ['alt+shift+b']);
    assert.deepEqual(parse(`${ESC}.`), ['alt+.']);
    assert.deepEqual(parse(`${ESC}\t`), ['alt+tab']);
    assert.deepEqual(parse(`${ESC}\x01`), ['ctrl+alt+a']);
  });

  test('alt with a multi-byte character consumes the whole character', () => {
    const e = String.fromCodePoint(0xe9);
    const rocket = String.fromCodePoint(0x1f680);
    assert.deepEqual(parse(`${ESC}${e}x`), [`alt+${e}`, 'char:x']);
    assert.deepEqual(parse(`${ESC}${rocket}x`), [`alt+${rocket}`, 'char:x']);
  });

  test('kitty keyboard protocol', () => {
    assert.deepEqual(parse(`${ESC}[13;2u`), ['shift+return']);
    assert.deepEqual(parse(`${ESC}[13;5u`), ['ctrl+return']);
    assert.deepEqual(parse(`${ESC}[13;3u`), ['alt+return']);
    assert.deepEqual(parse(`${ESC}[27u`), ['escape']);
    assert.deepEqual(parse(`${ESC}[9;2u`), ['shift+tab']);
    assert.deepEqual(parse(`${ESC}[127;3u`), ['alt+backspace']);
    assert.deepEqual(parse(`${ESC}[97;5u`), ['ctrl+a']);
    assert.deepEqual(parse(`${ESC}[32;5u`), ['ctrl+space']);
    assert.deepEqual(parse(`${ESC}[97u`), ['char:a']);
    assert.deepEqual(parse(`${ESC}[13;2:1u`), ['shift+return']);
  });

  test('modifyOtherKeys', () => {
    assert.deepEqual(parse(`${ESC}[27;2;13~`), ['shift+return']);
    assert.deepEqual(parse(`${ESC}[27;5;13~`), ['ctrl+return']);
    assert.deepEqual(parse(`${ESC}[27;5;97~`), ['ctrl+a']);
    assert.deepEqual(parse(`${ESC}[27;3;127~`), ['alt+backspace']);
  });

  test('sequences back to back and mixed with text', () => {
    assert.deepEqual(parse(`ab${ESC}[Dc${ESC}[3~\r${ESC}[1;5C${ESC}bz`), ['char:ab', 'left', 'char:c', 'delete', 'return', 'ctrl+right', 'alt+b', 'char:z']);
  });

  test('unknown sequences are swallowed without leaking characters', () => {
    const unknown = [
      `${ESC}[?25h`, // private mode
      `${ESC}[I`, // focus in
      `${ESC}[O`, // focus out
      `${ESC}[?2026;2$y`, // mode report, with an intermediate byte
      `${ESC}[1 q`, // cursor style echo
      `${ESC}[<0;10;5M`, // SGR mouse
      `${ESC}[>0;276;0c`, // device attributes
      `${ESC}[11~`, // unmapped function key
      `${ESC}[15;5~`,
      `${ESC}[99;99;99x`,
      `${ESC}Ox`, // unmapped SS3
      `${ESC}[0;0u`,
    ];
    for (const seq of unknown) {
      assert.deepEqual(parse(`a${seq}b`), ['char:a', 'char:b'], JSON.stringify(seq));
      assert.deepEqual(parse(seq), [], JSON.stringify(seq));
    }
  });

  test('a malformed sequence does not swallow the key after it', () => {
    assert.deepEqual(parse(`${ESC}[12\r`), ['return']);
    assert.deepEqual(parse(`${ESC}[${ESC}[A`), ['up']);
  });

  test('an endless parameter string is eventually dropped', () => {
    const parser = new KeyParser();
    assert.deepEqual(parser.feed(`${ESC}[${'1;'.repeat(100)}`), []);
    assert.equal(parser.pending, false);
    assert.deepEqual(parser.feed('ok').map(show), ['char:ok']);
  });
});

describe('the escape key', () => {
  test('a lone ESC is reported only by flush()', () => {
    const parser = new KeyParser();
    assert.deepEqual(parser.feed(ESC), []);
    assert.equal(parser.pending, true);
    assert.deepEqual(parser.flush().map(show), ['escape']);
    assert.equal(parser.pending, false);
    assert.deepEqual(parser.flush(), []);
  });

  test('ESC then a key after the timeout are two separate keys', () => {
    const parser = new KeyParser();
    parser.feed(ESC);
    assert.deepEqual(parser.flush().map(show), ['escape']);
    assert.deepEqual(parser.feed('a').map(show), ['char:a']);
    assert.deepEqual(parser.feed(`${ESC}[A`).map(show), ['up']);
  });

  test('ESC then a key before the timeout is an alt combination', () => {
    assert.deepEqual(partial(ESC, 'a'), { keys: ['alt+a'], pending: false });
    assert.deepEqual(partial(ESC, '\r'), { keys: ['alt+return'], pending: false });
  });

  test('a sequence split across reads is still one key', () => {
    assert.deepEqual(partial(ESC, '[', 'A'), { keys: ['up'], pending: false });
    assert.deepEqual(partial(`${ESC}[1`, ';5', 'C'), { keys: ['ctrl+right'], pending: false });
    assert.deepEqual(partial(`${ESC}O`, 'F'), { keys: ['end'], pending: false });
    assert.deepEqual(partial(`${ESC}[`), { keys: [], pending: true });
    assert.deepEqual(partial(`${ESC}[3`), { keys: [], pending: true });
  });

  test('ESC ESC is escape, with the second still pending', () => {
    assert.deepEqual(partial(`${ESC}${ESC}`), { keys: ['escape'], pending: true });
    assert.deepEqual(parse(`${ESC}${ESC}`), ['escape', 'escape']);
    assert.deepEqual(parse(`${ESC}${ESC}[A`), ['escape', 'up']);
  });

  test('flushing an unfinished sequence gives escape and the typed characters', () => {
    assert.deepEqual(parse(`${ESC}[`), ['escape', 'char:[']);
    assert.deepEqual(parse(`${ESC}O`), ['escape', 'char:O']);
    assert.deepEqual(parse(`x${ESC}`), ['char:x', 'escape']);
  });

  test('text before a pending ESC is delivered immediately', () => {
    assert.deepEqual(partial(`abc${ESC}`), { keys: ['char:abc'], pending: true });
  });
});

describe('bracketed paste', () => {
  test('pasted text is one key', () => {
    assert.deepEqual(parse(`${PASTE_START}hello world${PASTE_END}`), ['paste:hello world']);
  });

  test('multi-line pastes keep their lines, with newlines normalised', () => {
    assert.deepEqual(parse(`${PASTE_START}line one\r\nline two\rline three\nend${PASTE_END}`), ['paste:line one\nline two\nline three\nend']);
  });

  test('control characters and escape sequences inside a paste are text, not keys', () => {
    const body = `a\x03b${ESC}[Ac\td${ESC}[3~e\x7f`;
    assert.deepEqual(parse(`${PASTE_START}${body}${PASTE_END}`), [`paste:${body}`]);
  });

  test('typing before and after a paste', () => {
    assert.deepEqual(parse(`ab${PASTE_START}pasted${PASTE_END}cd\r`), ['char:ab', 'paste:pasted', 'char:cd', 'return']);
  });

  test('two pastes in a row', () => {
    assert.deepEqual(parse(`${PASTE_START}one${PASTE_END}${PASTE_START}two${PASTE_END}`), ['paste:one', 'paste:two']);
  });

  test('an empty paste', () => {
    assert.deepEqual(parse(`${PASTE_START}${PASTE_END}`), ['paste:']);
  });

  test('an unfinished paste produces nothing and is not reported as a pending escape', () => {
    const parser = new KeyParser();
    assert.deepEqual(parser.feed(`${PASTE_START}still going`), []);
    assert.equal(parser.pending, false);
    assert.deepEqual(parser.flush(), []);
    assert.deepEqual(parser.feed(` and done${PASTE_END}`).map(show), ['paste:still going and done']);
  });

  test('split at every position gives the same result', () => {
    const input = `x${PASTE_START}first line\r\nsecond ${ESC}[A line\n${ESC}[20 not an end${PASTE_END}y${ESC}[D`;
    const whole = parseInChunks([input]);
    assert.deepEqual(whole, ['char:x', `paste:first line\nsecond ${ESC}[A line\n${ESC}[20 not an end`, 'char:y', 'left']);
    for (let i = 1; i < input.length; i++) {
      assert.deepEqual(parseInChunks([input.slice(0, i), input.slice(i)]), whole, `split at ${i}`);
    }
  });

  test('split into three parts at every pair of positions around the terminator', () => {
    const input = `${PASTE_START}abc${PASTE_END}z`;
    const whole = parseInChunks([input]);
    for (let i = 1; i < input.length; i++) {
      for (let j = i + 1; j < input.length; j++) {
        assert.deepEqual(parseInChunks([input.slice(0, i), input.slice(i, j), input.slice(j)]), whole, `split at ${i},${j}`);
      }
    }
  });

  test('a very large paste', () => {
    const body = 'lorem ipsum dolor\n'.repeat(20_000);
    const parser = new KeyParser();
    const keys: Key[] = [];
    const input = `${PASTE_START}${body}${PASTE_END}`;
    for (let i = 0; i < input.length; i += 4096) keys.push(...parser.feed(input.slice(i, i + 4096)));
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.name, 'paste');
    assert.equal(keys[0]!.text, body);
  });
});

describe('chunking does not change the result', () => {
  const emoji = String.fromCodePoint(0x1f44d);
  const samples = [
    'plain text',
    `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x65e5, 0x672c)} ${emoji}`,
    `${ESC}[A${ESC}[B${ESC}[C${ESC}[D`,
    `${ESC}OA${ESC}OH${ESC}OF${ESC}OP`,
    `${ESC}[1;5C${ESC}[1;2A${ESC}[3;5~${ESC}[Z`,
    `${ESC}[13;2u${ESC}[27;2;13~${ESC}[97;5u`,
    `${ESC}\r${ESC}\x7f${ESC}b${ESC}f${ESC}B`,
    `abc${ESC}[Ddef\r\n\t\x7f\x03\x04`,
    `${ESC}${ESC}[A`,
    `${ESC}${ESC}`,
    `x${ESC}`,
    `${ESC}[?25h${ESC}[Ix${ESC}[?2026;2$y${ESC}[1 q${ESC}[<0;10;5M!`,
    `${PASTE_START}pasted\r\ntext ${ESC}[A${PASTE_END}after`,
    `before${PASTE_START}${PASTE_END}${PASTE_START}two${PASTE_END}\r`,
    `${ESC}[12\r${ESC}[`,
    `\x00\x1c\x1d\x1e\x1f${ESC}\x01`,
    `${ESC}${emoji}${emoji}${ESC}[H`,
  ];

  for (const sample of samples) {
    test(`one character at a time: ${JSON.stringify(sample)}`, () => {
      const whole = parseInChunks([sample]);
      // Split by code point, as a decoded input stream delivers it.
      assert.deepEqual(parseInChunks(Array.from(sample)), whole);
    });
  }

  test('every two-way split of a long mixed input', () => {
    const input = samples.slice(0, 9).join('') + samples[12] + 'tail';
    const whole = parseInChunks([input]);
    const points = Array.from(input);
    let offset = 0;
    for (const point of points.slice(0, -1)) {
      offset += point.length;
      assert.deepEqual(parseInChunks([input.slice(0, offset), input.slice(offset)]), whole, `split at ${offset}`);
    }
  });
});
