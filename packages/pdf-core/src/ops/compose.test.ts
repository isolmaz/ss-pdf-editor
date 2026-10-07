/**
 * Composition and merge against real bytes and the real pdf.js `extractPages`. The wrong
 * answers that matter: a requested turn that replaces the page's own `/Rotate` instead of
 * adding to it, a page landing at the wrong position, a merge that drops the base
 * document's title or XMP packet, and a merged file without the product producer line.
 */

import { describe, expect, it } from 'vitest';
import { PRODUCER_LINE } from '../engines/mupdf-write';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { composeDocument, mergeDocuments } from './compose';

const run = { signal: new AbortController().signal };

/** `count` pages whose widths tell them apart (100, 110, …); `turned` pages carry /Rotate 90. */
async function pages(count: number, turned: readonly number[] = [], title?: string): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < count; index += 1) {
    doc.insertPage(
      index,
      doc.addPage([0, 0, 100 + index * 10, 200], turned.includes(index) ? 90 : 0, {}, ''),
    );
  }
  if (title !== undefined) {
    doc.setMetaData('info:Title', title);
    const packet = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="r"?>';
    doc
      .getTrailer()
      .get('Root')
      .put('Metadata', doc.addRawStream(packet, { Type: 'Metadata', Subtype: 'XML' }));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Each page's MediaBox width and /Rotate, plus the Info title, producer and XMP presence. */
async function read(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const list = Array.from({ length: doc.countPages() }, (_unused, index) => {
      const page = doc.findPage(index);
      const rotate = page.getInheritable('Rotate');
      return {
        width: page.getInheritable('MediaBox').get(2).asNumber(),
        rotate: rotate.isNull() ? 0 : rotate.asNumber(),
      };
    });
    return {
      pages: list,
      title: doc.getMetaData('info:Title') ?? null,
      producer: doc.getMetaData('info:Producer') ?? null,
      xmp: !doc.getTrailer().get('Root', 'Metadata').isNull(),
    };
  } finally {
    doc.destroy();
  }
}

describe('composeDocument', () => {
  it('reorders pages and adds a requested turn to the page’s own rotation', async () => {
    const handle = await openWithPdfjs(await pages(3, [2]));
    try {
      const out = await composeDocument(
        { sources: [{ pages: [2, 0], rotations: { 0: 90, 1: 180 } }], pageCount: 2 },
        handle.raw,
        run,
      );
      const result = await read(out.bytes);
      expect(result.pages).toEqual([
        { width: 120, rotate: 180 },
        { width: 100, rotate: 180 },
      ]);
      expect(result.producer).toBe(PRODUCER_LINE);
      expect(out.report.steps).toEqual(['pdfjs.extractPages', 'compose.rotate', 'save']);
      expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.compose.rotation');
    } finally {
      await handle.destroy();
    }
  });

  it('hands the engine’s bytes through untouched when nothing is turned', async () => {
    const handle = await openWithPdfjs(await pages(3));
    try {
      const out = await composeDocument({ sources: [{ pages: [1] }], pageCount: 1 }, handle.raw, run);
      expect(out.report.steps).toEqual(['pdfjs.extractPages']);
      expect((await read(out.bytes)).pages).toEqual([{ width: 110, rotate: 0 }]);
    } finally {
      await handle.destroy();
    }
  });

  it('refuses a composition whose page count is not the one planned', async () => {
    const handle = await openWithPdfjs(await pages(2));
    try {
      await expect(
        composeDocument({ sources: [{ pages: [0, 1] }], pageCount: 3 }, handle.raw, run),
      ).rejects.toMatchObject({ code: 'range-invalid' });
    } finally {
      await handle.destroy();
    }
  });
});

describe('mergeDocuments', () => {
  it('inserts another document after a base page and keeps the base title and XMP', async () => {
    const base = await pages(2, [], 'Çeyrek Rapor');
    const other = await pages(1);
    const out = await mergeDocuments(
      { bytes: base, pageCount: 2 },
      [{ name: 'ek.pdf', bytes: other, pageCount: 1 }],
      0,
      run,
    );
    const result = await read(out.bytes);
    expect(result.pages.map((page) => page.width)).toEqual([100, 100, 110]);
    expect(result.title).toBe('Çeyrek Rapor');
    expect(result.xmp).toBe(true);
    expect(result.producer).toBe(PRODUCER_LINE);
    expect(out.report.steps).toEqual(['pdfjs.extractPages', 'metadata', 'save']);
    expect(out.report.notes.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['op.note.merge.metadata', 'op.note.merge.verified']),
    );
  });
});
