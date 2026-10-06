/**
 * Layer writes, against real bytes and read back through the viewer's own reader. The
 * wrong answers that matter: a toggle that a `/View` usage entry silently overrides, a
 * print-state entry that is not ours rewritten anyway, a panel click that changed nothing
 * re-serialising the file, a Turkish layer name mangled, a nested order flattened without
 * saying so, and a document without layers given a layer tree it never had.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPdfjs, openWithPdfjs } from '../engines/pdfjs-handle';
import { listPdfLayers, type PdfLayerNode } from '../layers';
import { applyLayerWrite } from './layer-write';

const pdfjs = await loadPdfjs();
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve('pdfjs-dist/build/pdf.worker.mjs'),
).href;

const run = { signal: new AbortController().signal };

/**
 * Three groups: `Katman A` on, `B` off, `C` in neither array (on by BaseState). The order
 * nests `B` under a label; `/AS` has a `/View` entry naming A and B and a `/Print` entry
 * naming the same two.
 */
async function fixture(options: { readonly withConfig?: boolean; readonly withLayers?: boolean } = {}) {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
  if (options.withLayers !== false) {
    const group = (name: string) => {
      const ocg = doc.addObject(doc.newDictionary());
      ocg.put('Type', 'OCG');
      ocg.put('Name', doc.newString(name));
      return ocg;
    };
    const a = group('Katman A');
    const b = group('B');
    const c = group('C');
    const properties = doc.newDictionary();
    properties.put('OCGs', [a, b, c]);
    if (options.withConfig !== false) {
      const config = doc.newDictionary();
      config.put('ON', [a]);
      config.put('OFF', [b]);
      const nested = doc.newArray();
      nested.push(doc.newString('Grup'));
      nested.push(b);
      const order = doc.newArray();
      order.push(a);
      order.push(nested);
      order.push(c);
      config.put('Order', order);
      config.put('AS', [
        { Event: 'View', Category: ['View'], OCGs: [a, b] },
        { Event: 'Print', Category: ['Print'], OCGs: [a, b] },
      ]);
      properties.put('D', config);
    }
    doc.getTrailer().get('Root').resolve().put('OCProperties', properties);
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Every group as the viewer lists it: name and visibility, in tree order. */
async function layersOf(bytes: Uint8Array) {
  const handle = await openWithPdfjs(bytes);
  try {
    const out: { name: string; visible: boolean }[] = [];
    const visit = (nodes: readonly PdfLayerNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'group') out.push({ name: node.name, visible: node.visible });
        visit(node.children);
      }
    };
    visit(await listPdfLayers(handle));
    return out;
  } finally {
    await handle.destroy();
  }
}

/** The `/AS` entries left, as `{ event, groups }` with the group names they list. */
async function usageOf(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const config = doc.getTrailer().get('Root').resolve().get('OCProperties').resolve().get('D').resolve();
    const as = config.get('AS');
    if (as.isNull()) return [];
    const entries = as.resolve();
    const out: { event: string; groups: string[] }[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries.get(index).resolve();
      const groups = entry.get('OCGs').resolve();
      const names: string[] = [];
      for (let at = 0; at < groups.length; at += 1)
        names.push(groups.get(at).resolve().get('Name').asString());
      out.push({ event: entry.get('Event').asName(), groups: names });
    }
    return out;
  } finally {
    doc.destroy();
  }
}

const keys = (outcome: { readonly report: { readonly notes: readonly { readonly key: string }[] } }) =>
  outcome.report.notes.map((entry) => entry.key);

describe('applyLayerWrite', () => {
  it('turns layers on and off, and clears the view entries that would override the toggle', async () => {
    const out = await applyLayerWrite(
      await fixture(),
      {
        states: [
          { name: 'Katman A', visible: false },
          { name: 'B', visible: true },
        ],
      },
      run,
    );
    expect(await layersOf(out.bytes)).toEqual(
      expect.arrayContaining([
        { name: 'Katman A', visible: false },
        { name: 'B', visible: true },
        { name: 'C', visible: true },
      ]),
    );
    // The /View entry had only these two groups and goes; the /Print entry is not ours.
    expect(await usageOf(out.bytes)).toEqual([{ event: 'Print', groups: ['Katman A', 'B'] }]);
    expect(keys(out)).toEqual(
      expect.arrayContaining(['op.note.layer.viewOverrides', 'op.note.layer.usageKept']),
    );
    expect(out.report.steps).toEqual(['load', 'layer.state', 'producer', 'save', 'verify']);
    expect(out.report.incremental).toBe(false);
  });

  it('hands back the same bytes when the request states what the document already says', async () => {
    const input = await fixture();
    const out = await applyLayerWrite(
      input,
      {
        states: [
          { name: 'Katman A', visible: true },
          { name: 'B', visible: false },
        ],
      },
      run,
    );
    expect(out.bytes).toBe(input);
    expect(out.report.incremental).toBe(true);
  });

  it('writes the order flat, says the nesting was lost, and appends the groups it omitted', async () => {
    const out = await applyLayerWrite(await fixture(), { order: ['C', 'Katman A'] }, run);
    expect((await layersOf(out.bytes)).map((layer) => layer.name)).toEqual(['C', 'Katman A', 'B']);
    expect(keys(out)).toEqual(
      expect.arrayContaining(['op.note.layer.orderFlattened', 'op.note.layer.orderAppended']),
    );
  });

  it('renames a layer to a Turkish name that reads back unchanged', async () => {
    const out = await applyLayerWrite(
      await fixture(),
      { rename: { from: 'Katman A', to: 'Şişli Katmanı — Ğ' } },
      run,
    );
    expect((await layersOf(out.bytes)).map((layer) => layer.name)).toContain('Şişli Katmanı — Ğ');
    expect(out.report.steps).toContain('layer.rename');
  });

  it('returns the input and names the miss when no layer has the requested name', async () => {
    const input = await fixture();
    const out = await applyLayerWrite(input, { states: [{ name: 'Yok', visible: false }] }, run);
    expect(out.bytes).toBe(input);
    expect(keys(out)).toContain('op.note.layer.nameMissing');
  });

  it('refuses a document without layers, and one without a default configuration', async () => {
    const request = { states: [{ name: 'Katman A', visible: false }] };
    await expect(applyLayerWrite(await fixture({ withLayers: false }), request, run)).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(applyLayerWrite(await fixture({ withConfig: false }), request, run)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
