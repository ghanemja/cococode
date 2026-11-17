/**
 * Minimal YAML front matter parser for command, agent and skill files.
 * Supports the subset those files use: scalars, quoted strings, inline
 * lists (`[a, b]`), block lists (`- a`) and folded/literal block scalars.
 */

export type FrontmatterValue = string | number | boolean | string[];

export interface ParsedDocument {
  data: Record<string, FrontmatterValue>;
  body: string;
}

function parseScalar(raw: string): string | number | boolean {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/**
 * Split on commas that are not inside parentheses, brackets or braces, so
 * `Bash(echo a, b), Read(lib.{ts,tsx})` yields two items. With
 * `stripQuotes`, a quoted top-level item may also contain commas.
 */
function splitTopLevel(raw: string, stripQuotes: boolean): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (stripQuotes && depth === 0 && (ch === '"' || ch === "'")) {
      quote = ch;
    } else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth--;
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function splitInlineList(raw: string): string[] {
  return splitTopLevel(raw, true);
}

const BOM = String.fromCodePoint(0xfeff);

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

const KEY_LINE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const LIST_ITEM = /^\s*-\s+/;

/** A front matter block holds keys, comments, list items and indented continuations, nothing else. */
function looksLikeYaml(lines: string[]): boolean {
  return lines.every((line) => line.trim() === '' || /^\s/.test(line) || line.startsWith('#') || LIST_ITEM.test(line) || KEY_LINE.test(line));
}

export function parseFrontmatter(text: string): ParsedDocument {
  const normalized = stripBom(text).replace(/\r\n/g, '\n');
  const match = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { data: {}, body: normalized };

  const data: Record<string, FrontmatterValue> = {};
  const lines = (match[1] ?? '').split('\n');
  // A document that merely opens with a horizontal rule is not front matter; keep its text.
  if (!looksLikeYaml(lines)) return { data: {}, body: normalized };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = KEY_LINE.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2]!.trim();

    if (rest === '' || rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      // Block: either a list of "- item" or an indented scalar. YAML also
      // allows list items at the key's own indentation.
      const block: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        const continues = /^\s+/.test(next) || next.trim() === '' || (rest === '' && LIST_ITEM.test(next));
        if (!continues) break;
        block.push(lines[++i]!);
      }
      const items = block.filter((l) => l.trim());
      const listItems = items.filter((l) => !l.trim().startsWith('#'));
      if (rest === '' && listItems.length > 0 && listItems.every((l) => LIST_ITEM.test(l))) {
        data[key] = listItems.map((l) => String(parseScalar(l.replace(LIST_ITEM, ''))));
      } else if (items.length > 0) {
        const indent = Math.min(...items.map((l) => /^\s*/.exec(l)![0].length));
        const dedented = block.map((l) => l.slice(indent));
        data[key] = rest.startsWith('>') ? dedented.join(' ').replace(/\s+/g, ' ').trim() : dedented.join('\n').trim();
      } else {
        data[key] = '';
      }
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = splitInlineList(rest.slice(1, -1));
    } else {
      data[key] = parseScalar(rest);
    }
  }
  return { data, body: normalized.slice(match[0].length) };
}

/** Accepts `tools: a, b` as well as YAML lists. Commas inside parentheses or braces do not split. */
export function asList(value: FrontmatterValue | undefined): string[] | undefined {
  if (value === undefined || value === '') return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return splitTopLevel(String(value), false);
}

export function asString(value: FrontmatterValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
