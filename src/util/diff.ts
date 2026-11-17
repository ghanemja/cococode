/**
 * Line diff: the algorithm, a terminal renderer and unified-diff text.
 */
import { c, expandTabs, isColorEnabled, padStart, stringWidth, truncate } from '../ui/ansi.ts';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  /** 1-based line number in the old text (absent for added lines). */
  oldNo?: number;
  /** 1-based line number in the new text (absent for deleted lines). */
  newNo?: number;
  text: string;
}

export interface Hunk {
  /** First old line covered, 1-based. When the hunk has no old lines this is the line it follows (0 at the top). */
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

const EQ = 0;
const DEL = 1;
const ADD = 2;
type Op = typeof EQ | typeof DEL | typeof ADD;

/** Beyond this edit distance we stop looking for a minimal script. */
const MAX_EDIT_DISTANCE = 1500;

/** Split into lines, dropping line terminators (LF or CRLF). */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1);
  }
  return lines;
}

/**
 * Myers' O(ND) shortest edit script. Returns null when the distance exceeds
 * `maxD`, so the caller can fall back to something cheaper.
 */
function myers(a: Int32Array, b: Int32Array, maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return new Array<Op>(m).fill(ADD);
  if (m === 0) return new Array<Op>(n).fill(DEL);

  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds the furthest x for each diagonal k in [-d, d] after round d.
  const trace: Int32Array[] = [];
  let found = -1;

  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!;
    const get = (k: number) => prev[k + d - 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(EQ);
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push(ADD);
      y--;
    } else {
      ops.push(DEL);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(EQ);
    x--;
    y--;
  }
  return ops.reverse();
}

/** Edit script turning `a` into `b`, comparing lines by key. */
function editScript(aKeys: string[], bKeys: string[]): Op[] {
  const ids = new Map<string, number>();
  const intern = (key: string) => {
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const a = Int32Array.from(aKeys, intern);
  const b = Int32Array.from(bKeys, intern);
  const n = a.length;
  const m = b.length;

  // Most edits touch a small region; skip everything around it.
  let prefix = 0;
  const shortest = Math.min(n, m);
  while (prefix < shortest && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const midA = a.subarray(prefix, n - suffix);
  const midB = b.subarray(prefix, m - suffix);
  let mid = myers(midA, midB, MAX_EDIT_DISTANCE);
  if (!mid) {
    // Too different to align cheaply: show the region as one replaced block.
    mid = [...new Array<Op>(midA.length).fill(DEL), ...new Array<Op>(midB.length).fill(ADD)];
  }

  const ops: Op[] = new Array<Op>(prefix).fill(EQ);
  // Within a run of changes, list deletions before additions.
  let dels = 0;
  let adds = 0;
  const flush = () => {
    for (let i = 0; i < dels; i++) ops.push(DEL);
    for (let i = 0; i < adds; i++) ops.push(ADD);
    dels = 0;
    adds = 0;
  };
  for (const op of mid) {
    if (op === DEL) dels++;
    else if (op === ADD) adds++;
    else {
      flush();
      ops.push(EQ);
    }
  }
  flush();
  for (let i = 0; i < suffix; i++) ops.push(EQ);
  return ops;
}

function buildHunks(a: string[], b: string[], ops: Op[], context: number): Hunk[] {
  const ctx = Math.max(0, Math.floor(context));
  // Positions in the old/new text before each op.
  const oldAt = new Int32Array(ops.length + 1);
  const newAt = new Int32Array(ops.length + 1);
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    oldAt[i + 1] = oldAt[i]! + (op === ADD ? 0 : 1);
    newAt[i + 1] = newAt[i]! + (op === DEL ? 0 : 1);
    if (op !== EQ) changes.push(i);
  }

  const hunks: Hunk[] = [];
  let c0 = 0;
  while (c0 < changes.length) {
    // Extend the hunk while the next change is close enough to share context.
    let c1 = c0;
    while (c1 + 1 < changes.length && changes[c1 + 1]! - changes[c1]! - 1 <= 2 * ctx) c1++;
    const start = Math.max(0, changes[c0]! - ctx);
    const end = Math.min(ops.length - 1, changes[c1]! + ctx);

    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i <= end; i++) {
      const op = ops[i]!;
      const oi = oldAt[i]!;
      const ni = newAt[i]!;
      if (op === EQ) {
        lines.push({ type: 'ctx', oldNo: oi + 1, newNo: ni + 1, text: b[ni]! });
        oldCount++;
        newCount++;
      } else if (op === DEL) {
        lines.push({ type: 'del', oldNo: oi + 1, text: a[oi]! });
        oldCount++;
      } else {
        lines.push({ type: 'add', newNo: ni + 1, text: b[ni]! });
        newCount++;
      }
    }
    hunks.push({
      oldStart: oldCount > 0 ? oldAt[start]! + 1 : oldAt[start]!,
      newStart: newCount > 0 ? newAt[start]! + 1 : newAt[start]!,
      lines,
    });
    c0 = c1 + 1;
  }
  return hunks;
}

/**
 * Diff two texts line by line. Line endings are ignored (CRLF and LF compare
 * equal, as do files that differ only in a final newline).
 */
export function diffLines(before: string, after: string, context = 3): Hunk[] {
  const a = splitLines(before);
  const b = splitLines(after);
  return buildHunks(a, b, editScript(a, b), context);
}

export function diffStats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added++;
      else if (line.type === 'del') removed++;
    }
  }
  return { added, removed };
}

export interface RenderDiffOptions {
  /** Maximum rows to return; the rest is summarised as "… +N lines". */
  maxLines?: number;
  indent?: string;
}

/** Control characters would move the cursor or change colours; show a placeholder instead. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return expandTabs(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '�');
}

/**
 * Render hunks for the terminal: a line-number gutter, +/- markers and tinted
 * rows. Every returned row fits in `width` columns.
 */
export function renderDiff(hunks: Hunk[], width: number, opts: RenderDiffOptions = {}): string[] {
  if (hunks.length === 0) return [];
  const indent = opts.indent ?? '';
  let maxNo = 1;
  let total = hunks.length - 1;
  for (const hunk of hunks) {
    total += hunk.lines.length;
    for (const line of hunk.lines) maxNo = Math.max(maxNo, line.oldNo ?? 0, line.newNo ?? 0);
  }
  const gutter = String(maxNo).length;
  // "<no> <marker> <text>"
  const textWidth = Math.max(1, width - stringWidth(indent) - gutter - 3);

  let limit = total;
  if (opts.maxLines !== undefined && opts.maxLines >= 0 && total > opts.maxLines + 1) limit = Math.max(0, opts.maxLines);

  const fill = isColorEnabled();
  const rows: string[] = [];
  const row = (line: DiffLine): string => {
    const no = padStart(String((line.type === 'del' ? line.oldNo : line.newNo) ?? ''), gutter);
    const text = truncate(sanitize(line.text), textWidth);
    const pad = fill && line.type !== 'ctx' ? ' '.repeat(Math.max(0, textWidth - stringWidth(text))) : '';
    if (line.type === 'add') return indent + c.bg(22)(c.green(`${no} +`) + ' ' + c.fg(194)(text) + pad);
    if (line.type === 'del') return indent + c.bg(52)(c.red(`${no} -`) + ' ' + c.fg(224)(text) + pad);
    return indent + c.dim(no) + (text ? `   ${text}` : '');
  };

  outer: for (let h = 0; h < hunks.length; h++) {
    if (h > 0) {
      if (rows.length >= limit) break;
      rows.push(indent + c.dim(padStart('⋮', gutter)));
    }
    for (const line of hunks[h]!.lines) {
      if (rows.length >= limit) break outer;
      rows.push(row(line));
    }
  }
  if (limit < total) {
    const hidden = total - limit;
    rows.push(indent + c.dim(`… +${hidden} ${hidden === 1 ? 'line' : 'lines'}`));
  }
  return rows;
}

const NO_EOL = '\\ No newline at end of file';

/**
 * Standard unified diff text (`---`/`+++`/`@@`). Returns an empty string when
 * the texts are identical. Unlike `diffLines`, a missing final newline counts
 * as a change and is marked the way `diff -u` marks it.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const aNoEol = a.length > 0 && !before.endsWith('\n');
  const bNoEol = b.length > 0 && !after.endsWith('\n');

  // When only one side ends without a newline, its last line must not match the other's.
  const aKeys = a.slice();
  const bKeys = b.slice();
  if (aNoEol !== bNoEol) {
    if (aNoEol) aKeys[aKeys.length - 1] += '\u0000';
    if (bNoEol) bKeys[bKeys.length - 1] += '\u0000';
  }

  const hunks = buildHunks(a, b, editScript(aKeys, bKeys), context);
  if (hunks.length === 0) return '';

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    let oldCount = 0;
    let newCount = 0;
    for (const line of hunk.lines) {
      if (line.type !== 'add') oldCount++;
      if (line.type !== 'del') newCount++;
    }
    out.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`);
    for (const line of hunk.lines) {
      const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      out.push(marker + line.text);
      const lastOld = line.oldNo === a.length && aNoEol;
      const lastNew = line.newNo === b.length && bNoEol;
      if ((line.type === 'del' && lastOld) || (line.type === 'add' && lastNew) || (line.type === 'ctx' && lastOld && lastNew)) {
        out.push(NO_EOL);
      }
    }
  }
  return out.join('\n') + '\n';
}
