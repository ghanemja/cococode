import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { recordRead } from '../src/tools/fsutil.ts';
import { notebookEditTool, renderNotebook } from '../src/tools/notebook.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { makeContext, tempProject } from './helpers.ts';

interface Cell {
  cell_type: string;
  source: string[] | string;
  id?: string;
  metadata?: object;
  outputs?: unknown[];
  execution_count?: number | null;
}

function sampleNotebook(minor = 5): { cells: Cell[]; metadata: object; nbformat: number; nbformat_minor: number } {
  const id = (s: string) => (minor >= 5 ? { id: s } : {});
  return {
    cells: [
      { cell_type: 'markdown', ...id('intro'), metadata: {}, source: ['# Analysis\n', '\n', 'Some notes.'] },
      {
        cell_type: 'code',
        execution_count: 3,
        ...id('load'),
        metadata: {},
        outputs: [{ name: 'stdout', output_type: 'stream', text: ['loaded 10 rows\n'] }],
        source: ['import pandas as pd\n', 'df = pd.read_csv("data.csv")'],
      },
      { cell_type: 'code', execution_count: null, ...id('plot'), metadata: {}, outputs: [], source: [] },
    ],
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: minor,
  };
}

/** Write a notebook the way Jupyter does (1-space indent, trailing newline) and mark it as read. */
function setup(opts: { minor?: number; indent?: number | string; trailingNewline?: boolean; read?: boolean } = {}) {
  const dir = tempProject();
  const ctx = makeContext(dir);
  const file = path.join(dir, 'nb.ipynb');
  const text = JSON.stringify(sampleNotebook(opts.minor ?? 5), null, opts.indent ?? 1) + (opts.trailingNewline === false ? '' : '\n');
  fs.writeFileSync(file, text);
  if (opts.read !== false) recordRead(ctx, file);
  return { dir, ctx, file, text };
}

const load = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as ReturnType<typeof sampleNotebook>;

function edit(ctx: ToolContext, input: Record<string, unknown>) {
  return notebookEditTool.execute({ notebook_path: 'nb.ipynb', new_source: '', ...input } as never, ctx);
}

describe('NotebookEdit: tool surface', () => {
  it('is governed by Edit permission rules', () => {
    const { ctx, file } = setup();
    assert.equal(notebookEditTool.name, 'NotebookEdit');
    assert.equal(notebookEditTool.isReadOnly({} as never), false);
    assert.deepEqual(notebookEditTool.permission!({ notebook_path: 'nb.ipynb', new_source: '' }, ctx), {
      tool: 'Edit',
      kind: 'edit',
      target: file,
      description: 'Edit nb.ipynb',
    });
    assert.equal(notebookEditTool.label!({ notebook_path: file, new_source: '' }, ctx), 'nb.ipynb');
    assert.deepEqual(notebookEditTool.parameters.required, ['notebook_path', 'new_source']);
  });
});

describe('NotebookEdit: replace', () => {
  it('replaces a cell found by id and clears its outputs', async () => {
    const { ctx, file } = setup();
    const r = await edit(ctx, { cell_id: 'load', new_source: 'import polars as pl\ndf = pl.read_csv("data.csv")\n' });
    assert.ok(!r.isError, r.content);
    const nb = load(file);
    assert.deepEqual(nb.cells[1]!.source, ['import polars as pl\n', 'df = pl.read_csv("data.csv")\n']);
    assert.deepEqual(nb.cells[1]!.outputs, []);
    assert.equal(nb.cells[1]!.execution_count, null);
    assert.equal(nb.cells[1]!.id, 'load');
    assert.deepEqual(nb.cells[0], sampleNotebook().cells[0]);
    assert.equal(r.content, 'Replaced the source of cell 1 (code) in nb.ipynb. Its outputs were cleared. The notebook now has 3 cells (indices 0-2).');
    assert.equal(r.summary, 'Replaced cell 1');
    assert.deepEqual(r.diff, {
      path: file,
      before: 'import pandas as pd\ndf = pd.read_csv("data.csv")',
      after: 'import polars as pl\ndf = pl.read_csv("data.csv")\n',
    });
  });

  it('finds a cell by zero-based index given as a string, a number or "cell-N"', async () => {
    for (const cellId of ['0', 0, 'cell-0', 'Cell 0']) {
      const { ctx, file } = setup();
      const r = await edit(ctx, { cell_id: cellId, new_source: '# New title' });
      assert.ok(!r.isError, r.content);
      assert.deepEqual(load(file).cells[0]!.source, ['# New title']);
    }
  });

  it('prefers an id match over an index', async () => {
    const dir = tempProject();
    const ctx = makeContext(dir);
    const file = path.join(dir, 'nb.ipynb');
    const nb = sampleNotebook();
    nb.cells[2]!.id = '0';
    fs.writeFileSync(file, JSON.stringify(nb, null, 1));
    recordRead(ctx, file);
    await edit(ctx, { cell_id: '0', new_source: 'x = 1' });
    assert.deepEqual(load(file).cells[2]!.source, ['x = 1']);
    assert.deepEqual(load(file).cells[0]!.source, nb.cells[0]!.source);
  });

  it('leaves markdown cells without outputs and can change the cell type', async () => {
    const { ctx, file } = setup();
    await edit(ctx, { cell_id: 'intro', new_source: 'Plain' });
    assert.equal('outputs' in load(file).cells[0]!, false);

    const toCode = await edit(ctx, { cell_id: 'intro', new_source: 'print(1)', cell_type: 'code' });
    assert.match(toCode.content, /It is now a code cell/);
    assert.deepEqual(load(file).cells[0], { cell_type: 'code', id: 'intro', metadata: {}, source: ['print(1)'], outputs: [], execution_count: null });

    await edit(ctx, { cell_id: 'load', new_source: 'Now prose', cell_type: 'markdown' });
    const cell = load(file).cells[1]!;
    assert.equal(cell.cell_type, 'markdown');
    assert.equal('outputs' in cell, false);
    assert.equal('execution_count' in cell, false);
  });

  it('does nothing when the source is unchanged', async () => {
    const { ctx, file, text } = setup();
    const r = await edit(ctx, { cell_id: 'load', new_source: 'import pandas as pd\ndf = pd.read_csv("data.csv")' });
    assert.ok(!r.isError);
    assert.match(r.content, /^No change/);
    assert.equal(r.diff, undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });

  it('normalises CRLF in the new source', async () => {
    const { ctx, file } = setup();
    await edit(ctx, { cell_id: 'plot', new_source: 'a = 1\r\nb = 2' });
    assert.deepEqual(load(file).cells[2]!.source, ['a = 1\n', 'b = 2']);
  });
});

describe('NotebookEdit: insert and delete', () => {
  it('inserts after the given cell and generates an id', async () => {
    const { ctx, file } = setup();
    const r = await edit(ctx, { edit_mode: 'insert', cell_id: 'intro', cell_type: 'code', new_source: 'x = 1\ny = 2' });
    assert.ok(!r.isError, r.content);
    const nb = load(file);
    assert.equal(nb.cells.length, 4);
    const cell = nb.cells[1]!;
    assert.match(cell.id!, /^[0-9a-f]{8}$/);
    assert.deepEqual(cell, { cell_type: 'code', execution_count: null, id: cell.id, metadata: {}, outputs: [], source: ['x = 1\n', 'y = 2'] });
    assert.deepEqual(nb.cells.map((c) => c.id), ['intro', cell.id, 'load', 'plot']);
    assert.equal(r.content, `Inserted a code cell at index 1 in nb.ipynb (id ${cell.id}). The notebook now has 4 cells (indices 0-3).`);
    assert.deepEqual(r.diff, { path: file, before: '', after: 'x = 1\ny = 2' });
  });

  it('inserts at the top when cell_id is omitted', async () => {
    const { ctx, file } = setup();
    const r = await edit(ctx, { edit_mode: 'insert', cell_type: 'markdown', new_source: '> Draft' });
    assert.ok(!r.isError, r.content);
    const nb = load(file);
    assert.equal(nb.cells[0]!.cell_type, 'markdown');
    assert.deepEqual(nb.cells[0]!.source, ['> Draft']);
    assert.equal('outputs' in nb.cells[0]!, false);
    assert.equal(nb.cells[1]!.id, 'intro');
  });

  it('inserts after the last cell', async () => {
    const { ctx, file } = setup();
    await edit(ctx, { edit_mode: 'insert', cell_id: 2, cell_type: 'markdown', new_source: 'The end' });
    assert.deepEqual(load(file).cells.at(-1)!.source, ['The end']);
  });

  it('does not add ids to notebooks older than nbformat 4.5', async () => {
    const { ctx, file } = setup({ minor: 4 });
    const r = await edit(ctx, { edit_mode: 'insert', cell_id: '0', cell_type: 'code', new_source: 'x' });
    assert.ok(!r.isError, r.content);
    assert.equal('id' in load(file).cells[1]!, false);
    assert.equal(r.content, 'Inserted a code cell at index 1 in nb.ipynb. The notebook now has 4 cells (indices 0-3).');
  });

  it('requires cell_type when inserting', async () => {
    const { ctx, file, text } = setup();
    const r = await edit(ctx, { edit_mode: 'insert', cell_id: '0', new_source: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content, /cell_type/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });

  it('deletes a cell', async () => {
    const { ctx, file } = setup();
    const r = await edit(ctx, { edit_mode: 'delete', cell_id: 'load' });
    assert.ok(!r.isError, r.content);
    assert.deepEqual(load(file).cells.map((c) => c.id), ['intro', 'plot']);
    assert.equal(r.content, 'Deleted cell 1 (code) from nb.ipynb. The notebook now has 2 cells (indices 0-1).');
    assert.deepEqual(r.diff, { path: file, before: 'import pandas as pd\ndf = pd.read_csv("data.csv")', after: '' });
  });

  it('can empty a notebook', async () => {
    const { ctx, file } = setup();
    for (let i = 0; i < 3; i++) assert.ok(!(await edit(ctx, { edit_mode: 'delete', cell_id: 0 })).isError);
    assert.deepEqual(load(file).cells, []);
    const r = await edit(ctx, { edit_mode: 'insert', cell_type: 'code', new_source: 'fresh' });
    assert.match(r.content, /now has 1 cell \(indices 0-0\)/);
  });
});

describe('NotebookEdit: file handling', () => {
  it('preserves Jupyter formatting so the rest of the file is untouched', async () => {
    const { ctx, file, text } = setup();
    await edit(ctx, { cell_id: 'plot', new_source: 'df.plot()' });
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, text.replace('"source": []', '"source": [\n    "df.plot()"\n   ]'));
    assert.ok(after.endsWith('}\n'));
  });

  it('preserves two-space indentation and a missing trailing newline', async () => {
    const { ctx, file } = setup({ indent: 2, trailingNewline: false });
    await edit(ctx, { cell_id: 'plot', new_source: 'df.plot()' });
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.startsWith('{\n  "cells": [\n    {\n'));
    assert.ok(after.endsWith('}'));
  });

  it('preserves tabs, CRLF line endings and minified files', async () => {
    const tabs = setup({ indent: '\t' });
    await edit(tabs.ctx, { cell_id: 'plot', new_source: 'x' });
    assert.ok(fs.readFileSync(tabs.file, 'utf8').startsWith('{\n\t"cells": [\n\t\t{\n'));

    const crlf = setup();
    fs.writeFileSync(crlf.file, crlf.text.replace(/\n/g, '\r\n'));
    recordRead(crlf.ctx, crlf.file);
    await edit(crlf.ctx, { cell_id: 'plot', new_source: 'x' });
    const crlfAfter = fs.readFileSync(crlf.file, 'utf8');
    assert.ok(crlfAfter.endsWith('}\r\n'));
    assert.equal(/[^\r]\n/.test(crlfAfter), false);

    const mini = setup({ indent: 0, trailingNewline: false });
    await edit(mini.ctx, { cell_id: 'plot', new_source: 'x' });
    assert.equal(fs.readFileSync(mini.file, 'utf8').includes('\n'), false);
  });

  it('requires the notebook to have been read first', async () => {
    const { ctx, file, text } = setup({ read: false });
    const r = await edit(ctx, { cell_id: '0', new_source: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content, /must Read/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });

  it('refuses to edit a notebook that changed on disk since it was read', async () => {
    const { ctx, file } = setup();
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(file, future, future);
    const r = await edit(ctx, { cell_id: '0', new_source: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content, /changed on disk/);
  });

  it('allows consecutive edits without another read', async () => {
    const { ctx, file } = setup();
    assert.ok(!(await edit(ctx, { cell_id: 'plot', new_source: 'one' })).isError);
    const second = await edit(ctx, { cell_id: 'plot', new_source: 'two' });
    assert.ok(!second.isError, second.content);
    assert.deepEqual(load(file).cells[2]!.source, ['two']);
  });

  it('checkpoints the file before changing it', async () => {
    const { ctx, file, text } = setup();
    ctx.session.turn = 4;
    await edit(ctx, { cell_id: 'plot', new_source: 'changed' });
    assert.deepEqual(ctx.session.checkpoints.changedSince(4), [file]);
    ctx.session.checkpoints.rewindTo(4);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });

  it('resolves the path against the session working directory', async () => {
    const { ctx, dir, file } = setup();
    fs.mkdirSync(path.join(dir, 'sub'));
    ctx.session.cwd = path.join(dir, 'sub');
    const r = await notebookEditTool.execute({ notebook_path: '../nb.ipynb', cell_id: 'plot', new_source: 'rel' }, ctx);
    assert.ok(!r.isError, r.content);
    assert.deepEqual(load(file).cells[2]!.source, ['rel']);
  });
});

describe('NotebookEdit: errors', () => {
  it('reports an unknown cell with the valid range', async () => {
    const { ctx } = setup();
    for (const cellId of ['nope', '3', 99]) {
      const r = await edit(ctx, { cell_id: cellId, new_source: 'x' });
      assert.equal(r.isError, true);
      assert.equal(r.content, `Cell "${cellId}" was not found in nb.ipynb. The notebook has 3 cells (indices 0-2).`);
    }
  });

  it('requires cell_id for replace and delete', async () => {
    const { ctx } = setup();
    assert.match((await edit(ctx, { new_source: 'x' })).content, /cell_id is required to replace/);
    assert.match((await edit(ctx, { edit_mode: 'delete' })).content, /cell_id is required to delete/);
  });

  it('rejects bad modes, bad cell types and non-notebooks', async () => {
    const { ctx, dir } = setup();
    assert.match((await edit(ctx, { edit_mode: 'append', cell_id: '0' })).content, /edit_mode must be/);
    assert.match((await edit(ctx, { cell_type: 'raw', cell_id: '0' })).content, /cell_type must be/);
    fs.writeFileSync(path.join(dir, 'script.py'), 'x = 1\n');
    const notNb = await notebookEditTool.execute({ notebook_path: 'script.py', cell_id: '0', new_source: 'x' }, ctx);
    assert.equal(notNb.isError, true);
    assert.match(notNb.content, /not a notebook/);
    const missing = await notebookEditTool.execute({ notebook_path: 'absent.ipynb', cell_id: '0', new_source: 'x' }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.content, /Notebook not found/);
  });

  it('reports invalid notebook files without changing them', async () => {
    const dir = tempProject();
    const ctx = makeContext(dir);
    for (const [name, body] of [['broken.ipynb', '{ not json'], ['nocells.ipynb', '{"metadata": {}}']] as const) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      recordRead(ctx, file);
      const r = await notebookEditTool.execute({ notebook_path: name, cell_id: '0', new_source: 'x' }, ctx);
      assert.equal(r.isError, true);
      assert.match(r.content, /Not a valid notebook/);
      assert.equal(fs.readFileSync(file, 'utf8'), body);
    }
  });
});

describe('renderNotebook', () => {
  it('renders each cell with a header, its source and its outputs', () => {
    const out = renderNotebook(JSON.stringify(sampleNotebook()));
    assert.equal(
      out,
      [
        'Jupyter notebook with 3 cells (python)',
        '',
        '[cell 0] markdown id=intro',
        '# Analysis',
        '',
        'Some notes.',
        '',
        '[cell 1] code id=load execution_count=3',
        'import pandas as pd',
        'df = pd.read_csv("data.csv")',
        '[output]',
        'loaded 10 rows',
        '',
        '[cell 2] code id=plot',
      ].join('\n'),
    );
  });

  it('includes results and tracebacks, strips ANSI and replaces images', () => {
    const nb = {
      cells: [
        {
          cell_type: 'code',
          execution_count: 1,
          metadata: {},
          source: 'df.head()',
          outputs: [
            { output_type: 'execute_result', execution_count: 1, metadata: {}, data: { 'text/plain': ['   a  b\n', '0  1  2'], 'text/html': '<table><tr><td>1</td></tr></table>' } },
            { output_type: 'display_data', metadata: {}, data: { 'image/png': 'iVBORw0KGgoAAAANSUhEUg'.repeat(50), 'text/plain': '<Figure size 640x480>' } },
            { output_type: 'display_data', metadata: {}, data: { 'text/html': '<p>only <b>html</b></p>' } },
            { output_type: 'stream', name: 'stderr', text: 'warning: \u001b[33mcareful\u001b[0m\n' },
            {
              output_type: 'error',
              ename: 'NameError',
              evalue: "name 'x' is not defined",
              traceback: ['\u001b[0;31m---------\u001b[0m', "\u001b[0;31mNameError\u001b[0m: name 'x' is not defined"],
            },
          ],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 2,
    };
    const out = renderNotebook(JSON.stringify(nb));
    assert.equal(
      out,
      [
        'Jupyter notebook with 1 cell',
        '',
        '[cell 0] code execution_count=1',
        'df.head()',
        '[output]',
        '   a  b',
        '0  1  2',
        '[image/png output omitted]',
        '<Figure size 640x480>',
        'only **html**',
        'warning: careful',
        "[error] NameError: name 'x' is not defined",
        '---------',
        "NameError: name 'x' is not defined",
      ].join('\n'),
    );
    assert.ok(!out.includes('iVBORw0KGgo'));
    assert.ok(!out.includes('\u001b'));
  });

  it('clamps long outputs per cell', () => {
    const nb = {
      cells: [{ cell_type: 'code', source: ['loop()'], outputs: [{ output_type: 'stream', name: 'stdout', text: 'x'.repeat(5000) }] }],
      nbformat: 4,
      nbformat_minor: 5,
    };
    const out = renderNotebook(JSON.stringify(nb), 100);
    assert.ok(out.endsWith(`${'x'.repeat(100)}\n... [4900 characters truncated]`));
    assert.ok(renderNotebook(JSON.stringify(nb)).includes('... [3000 characters truncated]'));
  });

  it('copes with an empty notebook and odd cells', () => {
    assert.equal(renderNotebook('{"cells": []}'), 'Jupyter notebook with 0 cells');
    assert.equal(renderNotebook('{"cells": [{"cell_type": "raw", "source": "text"}, {"cell_type": "code"}]}'), 'Jupyter notebook with 2 cells\n\n[cell 0] raw\ntext\n\n[cell 1] code');
  });

  it('throws on input that is not a notebook', () => {
    assert.throws(() => renderNotebook('nope'), /Not a valid notebook/);
    assert.throws(() => renderNotebook('[1, 2]'), /no "cells" array/);
  });
});
