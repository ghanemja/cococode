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

function splitInlineList(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

const BOM = String.fromCodePoint(0xfeff);

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function parseFrontmatter(text: string): ParsedDocument {
  const normalized = stripBom(text).replace(/\r\n/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { data: {}, body: normalized };

  const data: Record<string, FrontmatterValue> = {};
  const lines = match[1]!.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2]!.trim();

    if (rest === '' || rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      // Block: either a list of "- item" or an indented scalar.
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) {
        block.push(lines[++i]!);
      }
      const items = block.filter((l) => l.trim());
      if (rest === '' && items.length > 0 && items.every((l) => /^\s*-\s+/.test(l))) {
        data[key] = items.map((l) => String(parseScalar(l.replace(/^\s*-\s+/, ''))));
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

/** Accepts `tools: a, b` as well as YAML lists. */
export function asList(value: FrontmatterValue | undefined): string[] | undefined {
  if (value === undefined || value === '') return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function asString(value: FrontmatterValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
