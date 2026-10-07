/**
 * Layer writes against hand-written structures: the declarations a real producer emits and a
 * careful one does not (a PDF-1.4 `/OCGs` dictionary, entries that point at integers, an `/AS`
 * list with a number in it, a group that has no name, an `/Order` with a duplicate in the request),
 * each read back from the bytes the writer produced. The wrong answers that matter: a layer left
 * out of both arrays, a stale entry reported under the wrong name, a request that names a layer
 * twice failing its own read-back, and a note that claims usage entries were kept when none are left.
 */

import { PDFDocument, type PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { applyLayerWrite } from './layer-write';
import { layerPdf } from './layer-write.fixtures';

const run = { signal: new AbortController().signal };

/** What an entry of an array reads as: the group's name, or its shape when it is not a group. */
function label(entry: PDFObject): string {
  if (entry.isNull()) return 'null';
  const target = entry.resolve();
  if (target.isDictionary()) return target.get('Name').asString();
  return target.isArray() ? 'array' : 'other';
}

/** `/D` of a produced file: each named key's entries, or `null` when the key is gone. */
function configOf(bytes: Uint8Array) {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const config = doc.getTrailer().get('Root').resolve().get('OCProperties').resolve().get('D').resolve();
    const list = (key: string): string[] | null => {
      const value = config.get(key);
      if (value.isNull()) return null;
      const array = value.resolve();
      return Array.from({ length: array.length }, (_entry, index) => label(array.get(index)));
    };
    /** Each `/AS` entry: its event and the names it lists (`null` for no `/OCGs`). */
    const usage = (): { event: string; groups: string[] | null }[] | null => {
      const value = config.get('AS');
      if (value.isNull()) return null;
      const array = value.resolve();
      return Array.from({ length: array.length }, (_entry, index) => {
        const entry = array.get(index).resolve();
        if (!entry.isDictionary()) return { event: 'not a dictionary', groups: null };
        const groups = entry.get('OCGs');
        return {
          event: entry.get('Event').isNull() ? '' : entry.get('Event').asName(),
          groups: groups.isNull()
            ? null
            : Array.from({ length: groups.resolve().length }, (_group, at) =>
                label(groups.resolve().get(at)),
              ),
        };
      });
    };
    return { on: list('ON'), off: list('OFF'), order: list('Order'), usage: usage() };
  } finally {
    doc.destroy();
  }
}

const config = (body: string) => layerPdf({ config: `<<${body}>>` });
const keys = (outcome: { readonly report: { readonly notes: readonly { readonly key: string }[] } }) =>
  outcome.report.notes.map((entry) => entry.key);
const paramsOf = (
  outcome: {
    readonly report: { readonly notes: readonly { readonly key: string; readonly params?: unknown }[] };
  },
  key: string,
) => outcome.report.notes.find((entry) => entry.key === key)?.params;

describe('groups as the document declares them', () => {
  it('reads the PDF-1.4 form that nests the array in a dictionary', async () => {
    const out = await applyLayerWrite(
      layerPdf({ ocgs: '<</OCGs[10 0 R 11 0 R 12 0 R]>>', config: '<</ON[10 0 R]>>' }),
      { states: [{ name: 'A', visible: false }] },
      run,
    );
    expect(configOf(out.bytes)).toMatchObject({ on: null, off: ['A'] });
  });

  it.each(['null', '<<>>', '42'])(
    'finds no groups when /OCGs is %s, so nothing can be toggled',
    async (ocgs) => {
      const input = layerPdf({ ocgs, config: '<<>>' });
      const out = await applyLayerWrite(input, { states: [{ name: 'A', visible: false }] }, run);
      expect(out.bytes).toBe(input);
      expect(paramsOf(out, 'op.note.layer.nameMissing')).toEqual({ count: 1 });
    },
  );

  it('skips entries that are not groups: a direct dictionary, an integer, a missing object', async () => {
    const input = layerPdf({
      ocgs: '[<</Name(D)>> 13 0 R 99 0 R 10 0 R]',
      config: '<</ON[10 0 R]>>',
      extra: { 13: '42' },
    });
    const out = await applyLayerWrite(
      input,
      {
        states: [
          { name: 'A', visible: false },
          { name: 'D', visible: false },
        ],
      },
      run,
    );
    expect(configOf(out.bytes)).toMatchObject({ on: null, off: ['A'] });
    expect(paramsOf(out, 'op.note.layer.nameMissing')).toEqual({ count: 1 });
  });
});

describe('the /ON and /OFF arrays', () => {
  it('creates /ON when the document has none, and drops the /OFF it emptied', async () => {
    const out = await applyLayerWrite(
      config('/OFF[11 0 R]'),
      { states: [{ name: 'B', visible: true }] },
      run,
    );
    expect(configOf(out.bytes)).toMatchObject({ on: ['B'], off: null });
  });

  it('drops an /ON it emptied and names what is left on in the report', async () => {
    const out = await applyLayerWrite(
      config('/ON[10 0 R]'),
      { states: [{ name: 'A', visible: false }] },
      run,
    );
    expect(configOf(out.bytes)).toMatchObject({ on: null, off: ['A'] });
    expect(paramsOf(out, 'op.note.layer.states')).toEqual({ on: '', off: 'A' });
  });

  it('makes a group that is in neither array explicit, in either direction', async () => {
    const off = await applyLayerWrite(config(''), { states: [{ name: 'C', visible: false }] }, run);
    expect(configOf(off.bytes)).toMatchObject({ on: null, off: ['C'] });
    const on = await applyLayerWrite(config(''), { states: [{ name: 'C', visible: true }] }, run);
    expect(configOf(on.bytes)).toMatchObject({ on: ['C'], off: null });
  });

  it('reports entries it cannot name by their object number, and a direct one by a question mark', async () => {
    const input = layerPdf({
      ocgs: '[10 0 R 11 0 R 14 0 R]',
      config: '<</ON[10 0 R 13 0 R (x) 14 0 R]/OFF[11 0 R]>>',
      extra: { 13: '42', 14: '<</Type/OCG>>' },
    });
    const out = await applyLayerWrite(input, { states: [{ name: 'B', visible: true }] }, run);
    expect(paramsOf(out, 'op.note.layer.states')).toEqual({ on: 'A, 13 0 R, ? 0 R, 14 0 R, B', off: '' });
  });

  it('cuts a long list in the report to 300 characters', async () => {
    const names = [20, 21, 22, 23, 24].map((number) => `${number}${'x'.repeat(78)}`);
    const input = layerPdf({
      ocgs: '[10 0 R 20 0 R 21 0 R 22 0 R 23 0 R 24 0 R]',
      config: '<</ON[20 0 R 21 0 R 22 0 R 23 0 R 24 0 R]/OFF[10 0 R]>>',
      extra: Object.fromEntries(names.map((name, index) => [20 + index, `<</Type/OCG/Name(${name})>>`])),
    });
    const out = await applyLayerWrite(input, { states: [{ name: 'A', visible: true }] }, run);
    const listed = paramsOf(out, 'op.note.layer.states') as { on: string };
    expect(listed.on).toHaveLength(298);
    expect(listed.on.startsWith(`${names[0]}, ${names[1]}`)).toBe(true);
    expect(listed.on.endsWith('…')).toBe(true);
  });

  it('drops an empty /Order the document carried', async () => {
    const out = await applyLayerWrite(
      config('/ON[10 0 R]/Order[]'),
      { states: [{ name: 'A', visible: false }] },
      run,
    );
    expect(configOf(out.bytes).order).toBeNull();
  });
});

describe('usage applications', () => {
  const as =
    '/AS[5 <</Category[/View]>> <</Event/View>> <</Event/View/OCGs[11 0 R]>> <</Event/View/OCGs[10 0 R 11 0 R]>> <</Event/Print/OCGs[10 0 R]>>]';

  it('takes a toggled group out of the /View entries that list it and leaves every other entry alone', async () => {
    const out = await applyLayerWrite(
      config(`/ON[10 0 R]/OFF[11 0 R]${as}`),
      { states: [{ name: 'A', visible: false }] },
      run,
    );
    expect(configOf(out.bytes).usage).toEqual([
      { event: 'not a dictionary', groups: null },
      { event: '', groups: null },
      { event: 'View', groups: null },
      { event: 'View', groups: ['B'] },
      { event: 'View', groups: ['B'] },
      { event: 'Print', groups: ['A'] },
    ]);
    expect(paramsOf(out, 'op.note.layer.viewOverrides')).toEqual({ count: 1 });
    expect(keys(out)).toContain('op.note.layer.usageKept');
  });

  it('removes /AS once its last entry is empty, and does not claim usage was kept', async () => {
    const out = await applyLayerWrite(
      config('/ON[10 0 R]/AS[<</Event/View/OCGs[10 0 R]>>]'),
      { states: [{ name: 'A', visible: false }] },
      run,
    );
    expect(configOf(out.bytes).usage).toBeNull();
    expect(paramsOf(out, 'op.note.layer.viewOverrides')).toEqual({ count: 1 });
    expect(keys(out)).not.toContain('op.note.layer.usageKept');
  });
});

describe('the reading order', () => {
  it('writes an order for a document that had none, appending what the request left out', async () => {
    const out = await applyLayerWrite(config(''), { order: ['C', 'A'] }, run);
    expect(configOf(out.bytes).order).toEqual(['C', 'A', 'B']);
    expect(keys(out)).toEqual([
      'op.note.layer.orderAppended',
      'op.note.layer.order',
      'op.note.layer.states',
      'op.note.metadata.producerKept',
    ]);
    expect(paramsOf(out, 'op.note.layer.order')).toEqual({ order: 'C, A' });
  });

  it('names a layer once when the request names it twice, and still verifies what it wrote', async () => {
    const out = await applyLayerWrite(config('/Order[12 0 R]'), { order: ['Nope', 'A', 'A', 'B', 'C'] }, run);
    expect(configOf(out.bytes).order).toEqual(['A', 'B', 'C']);
    expect(paramsOf(out, 'op.note.layer.order')).toEqual({ order: 'A, B, C' });
    expect(paramsOf(out, 'op.note.layer.orderUnknown')).toEqual({ count: 1 });
  });

  it('hands back the same bytes when the flat order is already what was asked for', async () => {
    const input = config('/Order[10 0 R 11 0 R 12 0 R]');
    for (const order of [
      ['A', 'B', 'C'],
      ['A', 'B'],
    ]) {
      const out = await applyLayerWrite(input, { order }, run);
      expect(out.bytes).toBe(input);
      expect(out.report.incremental).toBe(true);
    }
  });

  it('still says which names matched nothing when the order is already what the document states', async () => {
    const input = config('/Order[10 0 R 11 0 R 12 0 R]');
    const out = await applyLayerWrite(input, { order: ['A', 'B', 'C', 'Nope'] }, run);
    expect(out.bytes).toBe(input);
    expect(paramsOf(out, 'op.note.layer.orderUnknown')).toEqual({ count: 1 });
  });

  it('treats null entries in the order as nothing, not as a nested level', async () => {
    const input = config('/Order[10 0 R null 11 0 R 12 0 R]');
    const out = await applyLayerWrite(input, { order: ['A', 'B', 'C'] }, run);
    expect(out.bytes).toBe(input);
  });

  it('rewrites an order that lists fewer groups than the document has', async () => {
    const out = await applyLayerWrite(config('/Order[10 0 R 11 0 R]'), { order: ['B', 'A'] }, run);
    expect(configOf(out.bytes).order).toEqual(['B', 'A', 'C']);
    expect(keys(out)).toContain('op.note.layer.orderAppended');
  });

  it('asks for no order when the list is empty', async () => {
    const input = config('/Order[10 0 R]');
    const out = await applyLayerWrite(input, { order: [] }, run);
    expect(out.bytes).toBe(input);
  });
});

describe('renaming', () => {
  it('refuses a name that is blank once trimmed', async () => {
    await expect(
      applyLayerWrite(config(''), { rename: { from: 'A', to: '   ' } }, run),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { path: 'request.rename.to', engineMessage: 'a layer name cannot be empty' },
    });
  });

  it('writes the trimmed name', async () => {
    const out = await applyLayerWrite(
      config('/Order[10 0 R]'),
      { rename: { from: 'A', to: '  Yeni  ' } },
      run,
    );
    expect(configOf(out.bytes).order).toEqual(['Yeni']);
    expect(paramsOf(out, 'op.note.layer.renamed')).toEqual({ from: 'A', to: 'Yeni' });
  });

  it('counts a missing rename source with the toggles that missed', async () => {
    const input = config('');
    const renameOnly = await applyLayerWrite(input, { rename: { from: 'Yok', to: 'X' } }, run);
    expect(renameOnly.bytes).toBe(input);
    expect(paramsOf(renameOnly, 'op.note.layer.nameMissing')).toEqual({ count: 1 });
    const both = await applyLayerWrite(
      input,
      { states: [{ name: 'Yok', visible: true }], rename: { from: 'Yok', to: 'X' } },
      run,
    );
    expect(paramsOf(both, 'op.note.layer.nameMissing')).toEqual({ count: 2 });
  });

  it('runs state, order and rename in that order and reports each step', async () => {
    const out = await applyLayerWrite(
      config('/ON[10 0 R]/OFF[11 0 R]'),
      { states: [{ name: 'B', visible: true }], order: ['C'], rename: { from: 'C', to: 'Z' } },
      run,
    );
    expect(out.report.steps).toEqual([
      'load',
      'layer.state',
      'layer.order',
      'layer.rename',
      'producer',
      'save',
      'verify',
    ]);
    expect(configOf(out.bytes)).toMatchObject({ on: ['A', 'B'], off: null, order: ['Z', 'A', 'B'] });
  });
});

describe('requests that do nothing, and requests that are stopped', () => {
  it('returns the input without opening it when nothing is asked', async () => {
    const garbage = new Uint8Array([1, 2, 3]);
    for (const request of [{}, { states: [] }, { order: [] }]) {
      const out = await applyLayerWrite(garbage, request, run);
      expect(out.bytes).toBe(garbage);
      expect(out.report).toMatchObject({ pageCount: 0, incremental: true, outputBytes: 3 });
      expect(keys(out)).toEqual(['op.note.layer.nothing', 'op.note.metadata.producerKept']);
    }
  });

  it('stops on an aborted signal, before and during the edit', async () => {
    await expect(
      applyLayerWrite(
        config(''),
        { states: [{ name: 'A', visible: true }] },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    await expect(
      applyLayerWrite(
        config(''),
        { states: [{ name: 'A', visible: true }] },
        { signal: controller.signal, onProgress: () => controller.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
