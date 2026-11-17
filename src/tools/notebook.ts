import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { stripAnsi } from '../ui/ansi.ts';
import { htmlToMarkdown } from '../util/html.ts';
import { checkFresh, detectEol, editPermission, encodingProblem, resolvePath, shortPath, writeFileTracked } from './fsutil.ts';
import { errorResult, type PermissionRequest, type Tool, type ToolContext, type ToolResult } from './types.ts';

export interface NotebookEditInput {
  notebook_path: string;
  new_source: string;
  /** A cell's id, or its zero-based index. */
  cell_id?: string | number;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
}

interface NotebookCell {
  cell_type: string;
  source?: string | string[];
  id?: string;
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [key: string]: unknown;
}

function parseNotebook(json: string): Notebook {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`Not a valid notebook: ${(err as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || !Array.isArray((data as Notebook).cells)) {
    throw new Error('Not a valid notebook: there is no "cells" array.');
  }
  return data as Notebook;
}

function joinText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : '')).join('');
  return typeof value === 'string' ? value : '';
}

/** Jupyter stores source as lines that keep their trailing newline. */
function toSourceLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split(/(?<=\n)/);
}

/** Find a cell by id, or by zero-based index ("3", 3, "cell-3"). Returns -1 when absent. */
function locateCell(cells: NotebookCell[], cellId: string | number): number {
  const key = String(cellId).trim();
  const byId = cells.findIndex((c) => typeof c.id === 'string' && c.id === key);
  if (byId !== -1) return byId;
  const m = /^(?:cell[-_ ]?)?(\d+)$/i.exec(key);
  if (m) {
    const index = Number(m[1]);
    if (index < cells.length) return index;
  }
  return -1;
}

/** Indentation of the existing file, so a small edit stays a small diff. */
function detectIndent(text: string): string | number {
  const m = /^\s*[{[]\r?\n([ \t]+)\S/.exec(text);
  if (m) return m[1]!;
  return text.includes('\n') ? 1 : 0;
}

function newCellId(cells: NotebookCell[]): string {
  const taken = new Set(cells.map((c) => c.id));
  for (;;) {
    const id = crypto.randomBytes(4).toString('hex');
    if (!taken.has(id)) return id;
  }
}

function describeCells(cells: NotebookCell[]): string {
  if (cells.length === 0) return 'The notebook has no cells.';
  return `The notebook has ${cells.length} cell${cells.length === 1 ? '' : 's'} (indices 0-${cells.length - 1}).`;
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [${text.length - max} characters truncated]`;
}

function renderOutputs(outputs: unknown[] | undefined, maxChars: number): string {
  if (!Array.isArray(outputs) || outputs.length === 0) return '';
  const parts: string[] = [];
  for (const raw of outputs) {
    if (typeof raw !== 'object' || raw === null) continue;
    const out = raw as Record<string, unknown>;
    switch (out.output_type) {
      case 'stream':
        parts.push(stripAnsi(joinText(out.text)).trimEnd());
        break;
      case 'error': {
        const head = [out.ename, out.evalue].filter((v) => typeof v === 'string' && v).join(': ');
        const trace = stripAnsi(Array.isArray(out.traceback) ? out.traceback.join('\n') : '').trimEnd();
        parts.push(`[error] ${head || 'Error'}${trace ? `\n${trace}` : ''}`);
        break;
      }
      case 'execute_result':
      case 'display_data': {
        const data = (typeof out.data === 'object' && out.data !== null ? out.data : {}) as Record<string, unknown>;
        for (const mime of Object.keys(data)) {
          if (mime.startsWith('image/')) parts.push(`[${mime} output omitted]`);
        }
        if (data['text/plain'] !== undefined) {
          parts.push(stripAnsi(joinText(data['text/plain'])).trimEnd());
        } else if (data['text/markdown'] !== undefined) {
          parts.push(joinText(data['text/markdown']).trimEnd());
        } else if (data['text/html'] !== undefined) {
          parts.push(htmlToMarkdown(joinText(data['text/html'])));
        } else if (data['application/json'] !== undefined) {
          parts.push(JSON.stringify(data['application/json'], null, 2));
        }
        break;
      }
    }
  }
  return clamp(parts.filter(Boolean).join('\n'), maxChars);
}

/**
 * Render a notebook as plain text for the model: one `[cell N] type id=...`
 * header per cell, then its source and, for code cells, its outputs. Text
 * outputs and tracebacks are clamped to `maxOutputChars` per cell; images
 * become a placeholder. Throws if `json` is not a notebook.
 */
export function renderNotebook(json: string, maxOutputChars = 2000): string {
  const nb = parseNotebook(json);
  const meta = (nb.metadata ?? {}) as { kernelspec?: { language?: unknown }; language_info?: { name?: unknown } };
  const language = meta.language_info?.name ?? meta.kernelspec?.language;
  const lines = [
    `Jupyter notebook with ${nb.cells.length} cell${nb.cells.length === 1 ? '' : 's'}` +
      (typeof language === 'string' && language ? ` (${language})` : ''),
  ];
  nb.cells.forEach((cell, index) => {
    const isCode = cell.cell_type === 'code';
    let header = `[cell ${index}] ${cell.cell_type}`;
    if (typeof cell.id === 'string' && cell.id) header += ` id=${cell.id}`;
    if (isCode && typeof cell.execution_count === 'number') header += ` execution_count=${cell.execution_count}`;
    lines.push('', header);
    const source = joinText(cell.source).trimEnd();
    if (source) lines.push(source);
    if (isCode) {
      const outputs = renderOutputs(cell.outputs, maxOutputChars);
      if (outputs) lines.push('[output]', outputs);
    }
  });
  return lines.join('\n');
}

export const notebookEditTool: Tool<NotebookEditInput> = {
  name: 'NotebookEdit',
  description:
    'Edit one cell of a Jupyter notebook (.ipynb): replace its source, insert a new cell, or delete it. ' +
    'Read the notebook first to see cell indices and ids. Insert adds the new cell after cell_id, or at the top when cell_id is omitted.',
  parameters: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Path to the .ipynb file.' },
      new_source: { type: 'string', description: 'New source for the cell. Use an empty string when deleting.' },
      cell_id: { type: 'string', description: "The cell's id, or its zero-based index." },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type. Required when inserting.' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'What to do. Defaults to replace.' },
    },
    required: ['notebook_path', 'new_source'],
  },

  isReadOnly: () => false,

  permission(input, ctx): PermissionRequest {
    return editPermission(ctx, 'Edit', resolvePath(ctx, input.notebook_path));
  },

  label(input, ctx): string {
    return shortPath(ctx, resolvePath(ctx, input.notebook_path ?? ''));
  },

  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    if (!input.notebook_path || typeof input.notebook_path !== 'string') return errorResult('notebook_path is required.');
    const abs = resolvePath(ctx, input.notebook_path);
    const name = shortPath(ctx, abs);
    if (!abs.toLowerCase().endsWith('.ipynb')) {
      return errorResult(`${name} is not a notebook. NotebookEdit only works on .ipynb files; use Edit for other files.`);
    }
    const mode = input.edit_mode ?? 'replace';
    if (mode !== 'replace' && mode !== 'insert' && mode !== 'delete') {
      return errorResult(`edit_mode must be "replace", "insert" or "delete", not "${String(mode)}".`);
    }
    if (input.cell_type !== undefined && input.cell_type !== 'code' && input.cell_type !== 'markdown') {
      return errorResult(`cell_type must be "code" or "markdown", not "${String(input.cell_type)}".`);
    }
    if (mode !== 'delete' && typeof input.new_source !== 'string') return errorResult('new_source is required.');

    if (!fs.existsSync(abs)) return errorResult(`Notebook not found: ${name}. Use Write to create a new notebook.`);
    const stale = checkFresh(ctx, abs);
    if (stale) return errorResult(stale);

    let original: string;
    let nb: Notebook;
    try {
      const bytes = fs.readFileSync(abs);
      // Rewriting a file that is not UTF-8 would corrupt it.
      const problem = encodingProblem(bytes);
      if (problem) return errorResult(`Could not edit ${name}: the file ${problem}.`);
      original = bytes.toString('utf8');
      nb = parseNotebook(original);
    } catch (err) {
      return errorResult(`Could not edit ${name}: ${(err as Error).message}`);
    }
    const cells = nb.cells;

    const hasCellId = input.cell_id !== undefined && input.cell_id !== null && String(input.cell_id).trim() !== '';
    let index = -1;
    if (hasCellId) {
      index = locateCell(cells, input.cell_id!);
      if (index === -1) return errorResult(`Cell "${String(input.cell_id)}" was not found in ${name}. ${describeCells(cells)}`);
    } else if (mode !== 'insert') {
      return errorResult(`cell_id is required to ${mode} a cell. ${describeCells(cells)}`);
    }

    const newSource = typeof input.new_source === 'string' ? input.new_source.replace(/\r\n/g, '\n') : '';
    let before = '';
    let after = '';
    let message: string;
    let summary: string;

    if (mode === 'insert') {
      if (!input.cell_type) return errorResult('cell_type ("code" or "markdown") is required when inserting a cell.');
      const cell: NotebookCell = { cell_type: input.cell_type };
      if (input.cell_type === 'code') cell.execution_count = null;
      const usesIds = (nb.nbformat ?? 4) > 4 || ((nb.nbformat ?? 4) === 4 && (nb.nbformat_minor ?? 0) >= 5);
      if (usesIds) cell.id = newCellId(cells);
      cell.metadata = {};
      if (input.cell_type === 'code') cell.outputs = [];
      cell.source = toSourceLines(newSource);
      const at = index + 1; // index is -1 without cell_id: insert at the top
      cells.splice(at, 0, cell);
      after = newSource;
      message = `Inserted a ${input.cell_type} cell at index ${at} in ${name}${cell.id ? ` (id ${cell.id})` : ''}.`;
      summary = `Inserted ${input.cell_type} cell ${at}`;
    } else if (mode === 'delete') {
      const [removed] = cells.splice(index, 1);
      before = joinText(removed!.source);
      message = `Deleted cell ${index} (${removed!.cell_type}) from ${name}.`;
      summary = `Deleted cell ${index}`;
    } else {
      const cell = cells[index]!;
      before = joinText(cell.source);
      after = newSource;
      const typeChanged = input.cell_type !== undefined && input.cell_type !== cell.cell_type;
      if (before === after && !typeChanged) {
        return { content: `No change: cell ${index} of ${name} already has this source.`, summary: 'No change' };
      }
      cell.source = toSourceLines(newSource);
      if (typeChanged) cell.cell_type = input.cell_type!;
      let cleared = false;
      if (cell.cell_type === 'code') {
        cleared = (Array.isArray(cell.outputs) && cell.outputs.length > 0) || typeof cell.execution_count === 'number';
        cell.outputs = [];
        cell.execution_count = null;
      } else {
        delete cell.outputs;
        delete cell.execution_count;
      }
      message =
        `Replaced the source of cell ${index} (${cell.cell_type}) in ${name}.` +
        (typeChanged ? ` It is now a ${cell.cell_type} cell.` : '') +
        (cleared ? ' Its outputs were cleared.' : '');
      summary = `Replaced cell ${index}`;
    }

    let serialized = JSON.stringify(nb, null, detectIndent(original));
    if (detectEol(original) === '\r\n') serialized = serialized.replace(/\n/g, '\r\n');
    if (/\r?\n$/.test(original)) serialized += detectEol(original);

    try {
      writeFileTracked(ctx, abs, serialized);
    } catch (err) {
      return errorResult(`Could not write ${name}: ${(err as Error).message}`);
    }

    return {
      content: `${message} ${describeCells(cells).replace('has', 'now has')}`,
      summary,
      diff: { path: abs, before, after },
    };
  },
};
