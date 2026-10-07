/**
 * Page insertion and replacement against real bytes and the real pdf.js `extractPages`.
 * The wrong answers that matter: a matched blank page sized like the stored page instead
 * of the page a reader sees, an image page not scaled onto the matched size, pages landing
 * in the wrong slots, and the base document's title lost to the composition.
 */

import { describe, expect, it } from 'vitest';
import { PRODUCER_LINE } from '../engines/mupdf-write';
import { insertPages, pageSizesOf, replacePages } from './page-insert';

const run = { signal: new AbortController().signal };

/** Pages whose MediaBox widths tell them apart; `turned` pages carry /Rotate 90. */
async function pages(widths: readonly number[], turned: readonly number[] = [], title?: string) {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (const [index, width] of widths.entries()) {
    doc.insertPage(index, doc.addPage([0, 0, width, 300], turned.includes(index) ? 90 : 0, {}, ''));
  }
  if (title !== undefined) {
    doc.setMetaData('info:Title', title);
    doc.setMetaData('info:CreationDate', 'D:20240102030405Z');
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Each page's displayed size, plus the Info title, creation date and producer. */
async function read(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return {
      sizes: Array.from({ length: doc.countPages() }, (_unused, index) => {
        const bounds = doc.loadPage(index).getBounds();
        return [Math.round(bounds[2] - bounds[0]), Math.round(bounds[3] - bounds[1])];
      }),
      title: doc.getMetaData('info:Title') ?? null,
      created: doc.getMetaData('info:CreationDate') ?? null,
      producer: doc.getMetaData('info:Producer') ?? null,
    };
  } finally {
    doc.destroy();
  }
}

/** Whether the rendered page is dark at a displayed point (72 dpi). */
async function inkAt(bytes: Uint8Array, pageIndex: number, x: number, y: number): Promise<boolean> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc
      .loadPage(pageIndex)
      .toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false);
    return (pixmap.getPixels()[y * pixmap.getWidth() + x] ?? 255) < 128;
  } finally {
    doc.destroy();
  }
}

describe('page insertion', () => {
  it('reads the size a reader sees, turned pages turned', async () => {
    expect(await pageSizesOf(await pages([200, 250], [1]), [0, 1])).toEqual([
      { width: 200, height: 300 },
      { width: 300, height: 250 },
    ]);
  });

  it('inserts matched blank pages at a position and keeps the base Info', async () => {
    const base = await pages([200, 250], [1], 'Çeyrek Rapor');
    const out = await insertPages(
      { source: { kind: 'blank', size: 'match', count: 2 }, at: 1, bytes: base, pageCount: 2, matchPage: 1 },
      run,
    );
    const result = await read(out.bytes);
    expect(result.sizes).toEqual([
      [200, 300],
      [300, 250],
      [300, 250],
      [300, 250],
    ]);
    expect(result.title).toBe('Çeyrek Rapor');
    expect(result.created).toBe('D:20240102030405Z');
    expect(result.producer).toBe(PRODUCER_LINE);
  });

  it('scales an image page onto the matched page size', async () => {
    const mupdf = await import('mupdf');
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 20, 10], false);
    pixmap.clear(0);
    const png = pixmap.asPNG();
    const out = await insertPages(
      {
        source: {
          kind: 'image',
          files: [{ name: 'a.png', bytes: png }],
          size: 'match',
          fit: 'fit',
          marginMm: 0,
        },
        at: 1,
        bytes: await pages([200]),
        pageCount: 1,
        matchPage: 0,
      },
      run,
    );
    expect((await read(out.bytes)).sizes).toEqual([
      [200, 300],
      [200, 300],
    ]);
    // A 2:1 picture fitted to 200 wide: 100 tall, centred vertically.
    expect(await inkAt(out.bytes, 1, 100, 150)).toBe(true);
    expect(await inkAt(out.bytes, 1, 5, 105)).toBe(true);
    expect(await inkAt(out.bytes, 1, 100, 95)).toBe(false);
    expect(await inkAt(out.bytes, 1, 100, 205)).toBe(false);
  });

  it('inserts chosen pages of another document and replaces a page', async () => {
    const base = await pages([200, 210, 220], [], 'Ana');
    const other = await pages([500, 510]);
    const inserted = await insertPages(
      { source: { kind: 'document', bytes: other, pages: [1] }, at: 0, bytes: base, pageCount: 3 },
      run,
    );
    expect((await read(inserted.bytes)).sizes.map((size) => size[0])).toEqual([510, 200, 210, 220]);
    expect(inserted.report.steps).toEqual(['pdfjs.extractPages', 'metadata', 'save']);

    const replaced = await replacePages(
      { bytes: base, pageCount: 3, pages: [1], replacements: [{ name: 'ek.pdf', bytes: other, index: 0 }] },
      run,
    );
    const result = await read(replaced.bytes);
    expect(result.sizes.map((size) => size[0])).toEqual([200, 500, 220]);
    expect(result.title).toBe('Ana');
  });
});
