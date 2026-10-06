/**
 * Compression against real bytes. The wrong answers that matter: "clean metadata" that
 * also removes the producer line, a structure rewrite that loses a page or its text, a
 * growth reported as a saving, and a rasterised page that keeps its old text (or takes
 * the untouched pages and the outline down with it).
 */

import { describe, expect, it } from 'vitest';
import { PRODUCER_LINE } from '../engines/mupdf-write';
import { assembleRaster, compressDocument } from './compress';

const run = { signal: new AbortController().signal };

/** Two pages of text, the second turned; a title, an author and a one-item outline. */
async function fixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  for (const [index, word] of ['Alpha', 'Bravo'].entries()) {
    const text = `BT /F 24 Tf 40 700 Td (${word}) Tj ET `.repeat(20);
    doc.insertPage(index, doc.addPage([0, 0, 595, 842], index === 1 ? 90 : 0, { Font: { F: font } }, text));
  }
  doc.setMetaData('info:Title', 'Özet');
  doc.setMetaData('info:Author', 'Ayşe');
  const outline = doc.addObject({ Type: 'Outlines', Count: 1 });
  const item = doc.addObject({
    Title: doc.newString('Giriş'),
    Parent: outline,
    Dest: [doc.findPage(1), 'Fit'],
  });
  outline.put('First', item);
  outline.put('Last', item);
  doc.getTrailer().get('Root').put('Outlines', outline);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

async function read(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return {
      text: Array.from(
        { length: doc.countPages() },
        (_unused, index) => doc.loadPage(index).toStructuredText('').asText().trim().split('\n')[0] ?? '',
      ),
      sizes: Array.from({ length: doc.countPages() }, (_unused, index) => {
        const bounds = doc.loadPage(index).getBounds();
        return [Math.round(bounds[2] - bounds[0]), Math.round(bounds[3] - bounds[1])];
      }),
      title: doc.getMetaData('info:Title') ?? null,
      author: doc.getMetaData('info:Author') ?? null,
      producer: doc.getMetaData('info:Producer') ?? null,
      outline: (doc.loadOutline() ?? []).map((entry) => [entry.title, entry.page]),
    };
  } finally {
    doc.destroy();
  }
}

describe('compressDocument (structure)', () => {
  it('rewrites smaller, keeping every page and its text', async () => {
    const input = await fixture();
    const out = await compressDocument(
      input,
      { mode: 'structure', stripMetadata: false, keepProducer: true },
      run,
    );
    expect(out.bytes.byteLength).toBeLessThan(input.byteLength);
    expect(out.report.notes.map((entry) => entry.key)).toContain('optimize.saved');
    const result = await read(out.bytes);
    expect(result.text).toEqual(['Alpha', 'Bravo']);
    expect([result.title, result.author, result.producer]).toEqual(['Özet', 'Ayşe', PRODUCER_LINE]);
  });

  it('reports growth and no gain as what they are, never as a saving', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    const tiny = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const options = { mode: 'structure', stripMetadata: false, keepProducer: true } as const;
    const keys = (outcome: Awaited<ReturnType<typeof compressDocument>>) =>
      outcome.report.notes.map((entry) => entry.key).filter((key) => key.startsWith('optimize.'));

    // An empty page has nothing to shrink, and the rewrite adds the producer line: it grows.
    const grown = await compressDocument(tiny, options, run);
    expect(grown.bytes.byteLength).toBeGreaterThan(tiny.byteLength);
    expect(keys(grown)).toEqual(['optimize.grew']);

    // Rewriting what is already rewritten changes nothing.
    const again = await compressDocument(grown.bytes, options, run);
    expect(again.bytes.byteLength).toBe(grown.bytes.byteLength);
    expect(keys(again)).toEqual(['optimize.noGain']);
  });

  it('drops the Info metadata but never the producer line', async () => {
    const out = await compressDocument(
      await fixture(),
      { mode: 'structure', stripMetadata: true, keepProducer: true },
      run,
    );
    const result = await read(out.bytes);
    expect([result.title, result.author, result.producer]).toEqual([null, null, PRODUCER_LINE]);
    await expect(
      compressDocument(await fixture(), { mode: 'structure', stripMetadata: true, keepProducer: false }, run),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('assembleRaster', () => {
  it('replaces a page by its picture in place and leaves the rest of the file alone', async () => {
    const mupdf = await import('mupdf');
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 84, 60], false);
    pixmap.clear(200);
    const out = await assembleRaster(
      await fixture(),
      new Map([[1, { jpeg: new Uint8Array(pixmap.asJPEG(80)), width: 842, height: 595 }]]),
      run,
    );
    expect(out.pageCount).toBe(2);
    const result = await read(out.bytes);
    // The turned page is now an upright picture of itself: no text, the displayed size.
    expect(result.text).toEqual(['Alpha', '']);
    expect(result.sizes).toEqual([
      [595, 842],
      [842, 595],
    ]);
    expect(result.outline).toEqual([['Giriş', 1]]);
    expect(result.title).toBe('Özet');
  });
});
