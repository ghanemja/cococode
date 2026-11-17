/**
 * Tolerant JSON parsing. Local models frequently emit almost-JSON: trailing
 * commas, raw newlines inside strings, a code fence around the object, or a
 * truncated tail. We repair what can be repaired unambiguously.
 */

export function stripCodeFence(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1]!.trim() : t;
}

/** Escape raw control characters that appear inside string literals. */
function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === '\\') {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

function removeTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** Close any strings, arrays and objects left open by a truncated response. */
function closeOpenStructures(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = text;
  if (escaped) out = out.slice(0, -1);
  if (inString) out += '"';
  out = out.replace(/[,:]\s*$/, (m) => (m.trim() === ':' ? ': null' : ''));
  // Cut in the middle of a key: `{"a":1,"b` has a string where a pair is needed.
  if (stack[stack.length - 1] === '}' && /[{,]\s*"(?:[^"\\]|\\.)*"\s*$/.test(out)) out += ': null';
  while (stack.length) out += stack.pop();
  return out;
}

/**
 * Find the end of the first balanced JSON value starting at `start`
 * (which must point at `{` or `[`). Returns -1 if it never closes.
 */
export function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface LooseParse {
  ok: boolean;
  value?: unknown;
  /** True when the text had to be repaired before it parsed. */
  repaired?: boolean;
  /**
   * True when the text ended mid-value and was closed artificially. The value
   * is then incomplete (a string may be cut short), so callers that act on it,
   * such as tool calls, should treat it as an error rather than run with it.
   */
  truncated?: boolean;
  error?: string;
}

/** The first JSON-looking value in `text`: prose before and after it is dropped. */
function extractValue(text: string): string {
  const start = text.search(/[{[]/);
  if (start < 0) return text;
  const end = findBalancedEnd(text, start);
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

/**
 * Python dict syntax: single-quoted strings and True/False/None. Only applied
 * when the text has no double quotes at all, so the conversion is unambiguous.
 */
function fromPythonLiteral(text: string): string {
  if (text.includes('"') || !text.includes("'")) return text;
  let out = '';
  let inString = false;
  let word = '';
  const flushWord = () => {
    if (word === 'True') out += 'true';
    else if (word === 'False') out += 'false';
    else if (word === 'None') out += 'null';
    else out += word;
    word = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\' && text[i + 1] === "'") {
        out += "'";
        i++;
      } else if (ch === "'") {
        inString = false;
        out += '"';
      } else out += ch;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      word += ch;
      continue;
    }
    flushWord();
    if (ch === "'") {
      inString = true;
      out += '"';
    } else out += ch;
  }
  flushWord();
  return out;
}

export function parseJsonLoose(input: string): LooseParse {
  const text = stripCodeFence(input);
  if (text === '') return { ok: false, error: 'empty input' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (first) {
    const escaped = escapeControlCharsInStrings(text);
    const cleaned = removeTrailingCommas(escaped);
    // Each repair is tried in turn, cheapest and least invasive first.
    const repairs: { make: () => string; truncated?: boolean }[] = [
      { make: () => escaped },
      { make: () => cleaned },
      { make: () => extractValue(cleaned) },
      { make: () => removeTrailingCommas(escapeControlCharsInStrings(fromPythonLiteral(extractValue(text)))) },
      { make: () => closeOpenStructures(extractValue(cleaned)), truncated: true },
    ];
    let previous = text;
    for (const repair of repairs) {
      const candidate = repair.make();
      if (candidate === previous) continue;
      previous = candidate;
      try {
        const value = JSON.parse(candidate) as unknown;
        return repair.truncated ? { ok: true, value, repaired: true, truncated: true } : { ok: true, value, repaired: true };
      } catch {
        // try the next repair
      }
    }
    return { ok: false, error: (first as Error).message };
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
