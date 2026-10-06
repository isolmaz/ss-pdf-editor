/**
 * Page boxes against real bytes. The wrong answers that matter: a resize that moves the
 * content somewhere other than inside the new page, a scale whose annotations stay
 * behind, a shift in the wrong direction, a crop box written outside the MediaBox, an
 * auto-crop that cuts ink or keeps the white margin, and a turned page reported with the
 * unturned size.
 */

import { describe, expect, it } from 'vitest';
import { applyPageBoxes, readPageBoxes } from './page-boxes';

const run = { signal: new AbortController().signal };

/**
 * Page 1: 200×100 with a black rectangle over the lower-left quarter and a square
 * annotation over it. Page 2: the same page turned a quarter. Page 3: blank.
 */
async function fixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const ink = '0 g 0 0 100 50 re f';
  const first = doc.addPage([0, 0, 200, 100], 0, {}, ink);
  first.put('Annots', [doc.addObject({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 100, 50] })]);
  doc.insertPage(0, first);
  doc.insertPage(1, doc.addPage([0, 0, 200, 100], 90, {}, ink));
  doc.insertPage(2, doc.addPage([0, 0, 200, 100], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** A page dictionary's own facts, as MuPDF reads them back. */
async function facts(bytes: Uint8Array, pageIndex: number) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const page = doc.findPage(pageIndex);
    const numbers = (key: string) => {
      const value = page.get(key);
      if (value.isNull()) return null;
      const array = value.resolve();
      return Array.from({ length: array.length }, (_unused, index) => array.get(index).asNumber());
    };
    const annots = page.get('Annots');
    const rect = annots.isNull() ? null : annots.resolve().get(0).resolve().get('Rect').resolve();
    return {
      media: numbers('MediaBox'),
      crop: numbers('CropBox'),
      trim: numbers('TrimBox'),
      rotate: page.get('Rotate').isNull() ? 0 : page.get('Rotate').asNumber(),
      annotRect:
        rect === null ? null : Array.from({ length: 4 }, (_unused, index) => rect.get(index).asNumber()),
    };
  } finally {
    doc.destroy();
  }
}

/** Whether the rendered page is dark at a displayed point (top-left origin, 72 dpi). */
async function inkAt(bytes: Uint8Array, pageIndex: number, x: number, y: number): Promise<boolean> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc
      .loadPage(pageIndex)
      .toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, false);
    return (pixmap.getPixels()[y * pixmap.getWidth() + x] ?? 255) < 128;
  } finally {
    doc.destroy();
  }
}

const near = (values: readonly number[] | null, expected: readonly number[], tolerance = 0.01) =>
  values !== null &&
  values.length === expected.length &&
  values.every((value, index) => Math.abs(value - (expected[index] ?? 0)) <= tolerance);

describe('applyPageBoxes', () => {
  it('sets a crop box and clamps one that reaches outside the MediaBox', async () => {
    const out = await applyPageBoxes(
      await fixture(),
      { mode: 'set', pages: [0], box: 'crop', rect: [10, 10, 300, 90] },
      run,
    );
    expect((await facts(out.bytes, 0)).crop).toEqual([10, 10, 200, 90]);
    expect(out.report.notes.map((entry) => entry.key)).toContain('boxes.note.clamped');
    expect(out.changed).toEqual([{ pages: [0], box: [10, 10, 200, 90] }]);
  });

  it('resizes a page with its content fitted inside the new size', async () => {
    const out = await applyPageBoxes(
      await fixture(),
      { mode: 'resize', pages: [0], width: 400, height: 200, fit: 'fit' },
      run,
    );
    const page = await facts(out.bytes, 0);
    expect(page.media).toEqual([0, 0, 400, 200]);
    // The rectangle doubled with the page: it now covers the displayed lower-left quarter.
    expect(await inkAt(out.bytes, 0, 50, 150)).toBe(true);
    expect(await inkAt(out.bytes, 0, 190, 110)).toBe(true);
    expect(await inkAt(out.bytes, 0, 210, 150)).toBe(false);
    expect(await inkAt(out.bytes, 0, 50, 90)).toBe(false);
  });

  it('scales the content, its annotations and on request the boxes about the origin', async () => {
    const out = await applyPageBoxes(
      await fixture(),
      { mode: 'scale', pages: [0], factor: 0.5, scaleBoxes: true },
      run,
    );
    const page = await facts(out.bytes, 0);
    expect(page.media).toEqual([0, 0, 100, 50]);
    expect(page.annotRect).toEqual([0, 0, 50, 25]);
    expect(out.report.notes.map((entry) => entry.key)).toContain('boxes.note.annotationsScaled');
    // The quarter-page rectangle is now 50×25 at the lower-left of a 100×50 page.
    expect(await inkAt(out.bytes, 0, 25, 40)).toBe(true);
    expect(await inkAt(out.bytes, 0, 75, 40)).toBe(false);
  });

  it('shifts the content right and up', async () => {
    const mm = 72 / 25.4;
    const out = await applyPageBoxes(
      await fixture(),
      { mode: 'shift', pages: [0], offsetXmm: 20, offsetYmm: 10 },
      run,
    );
    // The rectangle's lower-left corner moved to (20 mm, 10 mm).
    expect(await inkAt(out.bytes, 0, Math.round(20 * mm) + 2, 100 - Math.round(10 * mm) - 2)).toBe(true);
    expect(await inkAt(out.bytes, 0, Math.round(20 * mm) - 2, 100 - Math.round(10 * mm) - 2)).toBe(false);
    expect((await facts(out.bytes, 0)).media).toEqual([0, 0, 200, 100]);
  });

  it('turns content with /Rotate', async () => {
    const out = await applyPageBoxes(
      await fixture(),
      { mode: 'rotate-content', pages: [0, 1], degrees: 270 },
      run,
    );
    expect((await facts(out.bytes, 0)).rotate).toBe(270);
    expect((await facts(out.bytes, 1)).rotate).toBe(0);
  });

  it('auto-crops to the ink, on a turned page too, and leaves a blank page alone', async () => {
    const out = await applyPageBoxes(
      await fixture(),
      { mode: 'auto-crop', pages: [0, 1, 2], alsoTrim: true },
      run,
    );
    expect(out.report.steps).toEqual(['load', 'measure', 'boxes', 'save']);
    for (const pageIndex of [0, 1]) {
      const page = await facts(out.bytes, pageIndex);
      expect(near(page.crop, [0, 0, 100, 50], 1)).toBe(true);
      expect(page.trim).toEqual(page.crop);
    }
    expect((await facts(out.bytes, 2)).crop).toBeNull();
    expect(out.report.notes.map((entry) => entry.key)).toContain('boxes.note.emptyContent');
  });

  it('returns the input untouched when nothing changes', async () => {
    const input = await fixture();
    const out = await applyPageBoxes(input, { mode: 'auto-crop', pages: [2] }, run);
    expect(out.report.incremental).toBe(true);
    expect(out.report.notes.map((entry) => entry.key)).toContain('boxes.note.unchanged');
    expect(out.bytes).toEqual(input);
  });

  it('refuses a page the document does not have', async () => {
    await expect(
      applyPageBoxes(await fixture(), { mode: 'rotate-content', pages: [9], degrees: 90 }, run),
    ).rejects.toMatchObject({ code: 'range-invalid' });
  });
});

describe('readPageBoxes', () => {
  it('reports the visible size of a turned page turned', async () => {
    const [plain, turned] = await readPageBoxes(await fixture(), [0, 1]);
    expect(plain).toMatchObject({
      pageIndex: 0,
      media: [0, 0, 200, 100],
      crop: [0, 0, 200, 100],
      rotation: 0,
      width: 200,
      height: 100,
    });
    expect(turned).toMatchObject({ pageIndex: 1, rotation: 90, width: 100, height: 200 });
  });
});
