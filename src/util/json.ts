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
  error?: string;
}

export function parseJsonLoose(input: string): LooseParse {
  const text = stripCodeFence(input);
  if (text === '') return { ok: false, error: 'empty input' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (first) {
    const attempts: ((s: string) => string)[] = [
      escapeControlCharsInStrings,
      (s) => removeTrailingCommas(escapeControlCharsInStrings(s)),
      (s) => {
        // Leading or trailing prose around a single JSON value.
        const start = s.search(/[{[]/);
        if (start < 0) return s;
        const end = findBalancedEnd(s, start);
        return end > start ? s.slice(start, end + 1) : s.slice(start);
      },
      (s) => closeOpenStructures(removeTrailingCommas(escapeControlCharsInStrings(s))),
    ];
    let candidate = text;
    for (const fix of attempts) {
      candidate = fix(candidate);
      try {
        return { ok: true, value: JSON.parse(candidate), repaired: true };
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
