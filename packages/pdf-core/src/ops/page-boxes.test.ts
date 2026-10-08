/**
 * Page boxes against real bytes. The wrong answers that matter: a resize that moves the
 * content somewhere other than inside the new page, a scale whose annotations stay
 * behind, a shift in the wrong direction, a crop box written outside the MediaBox, an
 * auto-crop that cuts ink or keeps the white margin, and a turned page reported with the
 * unturned size.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
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

// ---------------------------------------------------------------------------
// requests that are not valid, and pages that are not ordinary
// ---------------------------------------------------------------------------

/** A file of `pages` blank 200×100 pages, with `build` free to change each page's dictionary. */
async function pagesWith(
  pages: number,
  build: (doc: PDFDocument, page: PDFObject, index: number) => void,
  content = '0 g 20 10 100 50 re f',
): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < pages; index += 1) {
    doc.insertPage(index, doc.addPage([0, 0, 200, 100], 0, {}, content));
  }
  for (let index = 0; index < pages; index += 1) build(doc, doc.findPage(index), index);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  let outcome: { readonly error: unknown } | null = null;
  try {
    await promise;
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call resolved instead of rejecting');
  if (!isToolError(outcome.error)) throw outcome.error;
  return outcome.error;
}

const noteKeys = (out: { readonly report: { readonly notes: readonly { readonly key: string }[] } }) =>
  out.report.notes.map((entry) => entry.key);

describe('applyPageBoxes refuses requests that are not valid', () => {
  const pages = [0];

  it.each([
    [
      'no page at all',
      { mode: 'rotate-content', pages: [], degrees: 90 },
      'selection-empty',
      'needs at least one page',
    ],
    [
      'a negative page',
      { mode: 'rotate-content', pages: [-1], degrees: 90 },
      'range-invalid',
      'page index -1 is not a non-negative integer',
    ],
    [
      'a fractional page',
      { mode: 'rotate-content', pages: [0.5], degrees: 90 },
      'range-invalid',
      'page index 0.5 is not a non-negative integer',
    ],
    ['a set without a box', { mode: 'set', pages, rect: [0, 0, 5, 5] }, 'range-invalid', 'needs both'],
    ['a set without a rect', { mode: 'set', pages, box: 'crop' }, 'range-invalid', 'needs both'],
    [
      'a set with a rect that is not finite',
      { mode: 'set', pages, box: 'crop', rect: [0, 0, Number.NaN, 5] },
      'range-invalid',
      'is not a positive rectangle',
    ],
    [
      'a set with an empty rect',
      { mode: 'set', pages, box: 'crop', rect: [5, 0, 5, 5] },
      'range-invalid',
      'is not a positive rectangle',
    ],
    [
      'a resize with no width',
      { mode: 'resize', pages, height: 100 },
      'value-out-of-range',
      'width is required and must be a finite number',
    ],
    [
      'a resize with a NaN height',
      { mode: 'resize', pages, width: 100, height: Number.NaN },
      'value-out-of-range',
      'height is required',
    ],
    [
      'a resize wider than a page can be',
      { mode: 'resize', pages, width: 30000, height: 100 },
      'value-out-of-range',
      'width = 30000 is outside 1..20000',
    ],
    [
      'a resize whose margin leaves no room',
      { mode: 'resize', pages, width: 100, height: 100, marginMm: 20 },
      'value-out-of-range',
      'leaves no room',
    ],
    ['a scale with no factor', { mode: 'scale', pages }, 'value-out-of-range', 'factor is required'],
    [
      'a scale that is too small',
      { mode: 'scale', pages, factor: 0.01 },
      'value-out-of-range',
      'factor = 0.01 is outside',
    ],
    [
      'an auto-crop with a negative padding',
      { mode: 'auto-crop', pages, paddingMm: -1 },
      'value-out-of-range',
      'paddingMm = -1 is outside',
    ],
    [
      'a shift that moves nothing',
      { mode: 'shift', pages },
      'value-out-of-range',
      'a content shift needs a non-zero offset',
    ],
    [
      'a shift too far',
      { mode: 'shift', pages, offsetXmm: 900 },
      'value-out-of-range',
      'offsetXmm = 900 is outside',
    ],
    [
      'a content turn of nothing',
      { mode: 'rotate-content', pages },
      'value-out-of-range',
      'would change nothing',
    ],
    ['a content turn of 45°', { mode: 'rotate-content', pages, degrees: 45 }, 'value-out-of-range', 'by 45°'],
  ] as const)('refuses %s', async (_name, options, code, message) => {
    const error = await refusal(applyPageBoxes(await fixture(), options as never, run));
    expect(error.code).toBe(code);
    expect(error.details.engineMessage).toContain(message);
  });

  it('refuses a crop box that misses the page entirely, and a page whose box has no size', async () => {
    const error = await refusal(
      applyPageBoxes(
        await fixture(),
        { mode: 'set', pages: [0], box: 'trim', rect: [300, 300, 400, 400] },
        run,
      ),
    );
    expect(error.code).toBe('range-invalid');
    expect(error.details.engineMessage).toContain('does not overlap the MediaBox [0, 0, 200, 100]');
    const flat = await pagesWith(1, (_doc, page) => page.put('CropBox', [10, 10, 10, 10]));
    const resize = await refusal(
      applyPageBoxes(flat, { mode: 'resize', pages: [0], width: 100, height: 100 }, run),
    );
    expect(resize.details.engineMessage).toBe("the page's CropBox is 0×0 pt");
  });

  it('stops at an aborted signal, before the call and from a progress event between pages', async () => {
    const input = await pagesWith(2, () => {});
    const before = new AbortController();
    before.abort();
    await expect(
      applyPageBoxes(
        input,
        { mode: 'rotate-content', pages: [0, 1], degrees: 90 },
        { signal: before.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const midway = new AbortController();
    await expect(
      applyPageBoxes(
        input,
        { mode: 'rotate-content', pages: [0, 1], degrees: 90 },
        { signal: midway.signal, onProgress: () => midway.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const last = new AbortController();
    await expect(
      applyPageBoxes(
        input,
        { mode: 'rotate-content', pages: [0], degrees: 90 },
        { signal: last.signal, onProgress: () => last.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // An abort while measuring for an auto-crop is not rewritten into an engine error either.
    const measuring = new AbortController();
    await expect(
      applyPageBoxes(
        input,
        { mode: 'auto-crop', pages: [0, 1] },
        { signal: measuring.signal, onProgress: () => measuring.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('applyPageBoxes: the media box and the boxes derived from it', () => {
  it('moves a MediaBox and clamps or drops the derived boxes that no longer fit', async () => {
    const input = await pagesWith(1, (_doc, page) => {
      page.put('CropBox', [20, 20, 180, 80]);
      page.put('TrimBox', [150, 10, 190, 90]);
      page.put('ArtBox', [190, 0, 200, 100]);
      page.put('BleedBox', [0, 0, 100, 50]);
    });
    const out = await applyPageBoxes(
      input,
      { mode: 'set', pages: [0], box: 'media', rect: [0, 0, 100, 100] },
      run,
    );
    const page = await facts(out.bytes, 0);
    expect(page.media).toEqual([0, 0, 100, 100]);
    expect(page.crop).toEqual([20, 20, 100, 80]);
    // Nothing of the trim box is left inside the new page: its entry is dropped.
    expect(page.trim).toBeNull();
    expect(out.changed).toEqual([{ pages: [0], box: [0, 0, 100, 100] }]);
    expect(out.report.notes.find((entry) => entry.key === 'boxes.note.clamped')?.params).toEqual({
      count: 3,
    });
  });
});

describe('applyPageBoxes: resizing with each fit', () => {
  const resized = async (
    options: Record<string, unknown>,
    build: (doc: PDFDocument, page: PDFObject) => void = () => {},
  ) => {
    const input = await pagesWith(1, build);
    return applyPageBoxes(input, { mode: 'resize', pages: [0], ...options } as never, run);
  };

  it('keeps the content 1:1 and centred for fit none', async () => {
    const out = await resized({ width: 300, height: 300, fit: 'none' });
    expect((await facts(out.bytes, 0)).media).toEqual([0, 0, 300, 300]);
    // The ink (x 20…120, y 10…60 up) moved by (+50, +100): displayed x 70…170, y 140…190.
    expect(await inkAt(out.bytes, 0, 100, 160)).toBe(true);
    expect(await inkAt(out.bytes, 0, 40, 160)).toBe(false);
  });

  it('covers the new page for fit fill, cropping what overflows', async () => {
    const out = await resized({ width: 100, height: 100, fit: 'fill' });
    // Scale 1, shifted left by 50: the ink is now x -30…70, y 10…60 up → displayed y 40…90.
    expect(await inkAt(out.bytes, 0, 40, 70)).toBe(true);
    expect(await inkAt(out.bytes, 0, 85, 70)).toBe(false);
  });

  it('scales each axis on its own for stretch, and moves the other boxes with the content', async () => {
    const out = await resized({ width: 100, height: 100, fit: 'stretch' }, (_doc, page) => {
      page.put('TrimBox', [20, 10, 120, 60]);
    });
    const page = await facts(out.bytes, 0);
    expect(page.trim).toEqual([10, 10, 60, 60]);
    expect(page.crop).toEqual([0, 0, 100, 100]);
    expect(await inkAt(out.bytes, 0, 30, 70)).toBe(true);
    expect(await inkAt(out.bytes, 0, 80, 70)).toBe(false);
  });

  it('measures a turned page as the viewer shows it and swaps the written box', async () => {
    const out = await resized({ width: 400, height: 200, fit: 'fit' }, (_doc, page) =>
      page.put('Rotate', 90),
    );
    const page = await facts(out.bytes, 0);
    expect(page.media).toEqual([0, 0, 200, 400]);
    expect(page.rotate).toBe(90);
  });

  it('leaves a margin around the fitted content', async () => {
    const out = await resized({ width: 100, height: 100, fit: 'fit', marginMm: 5 });
    // 5 mm = 14.17 pt on every side: the ink no longer reaches the page edge.
    expect(await inkAt(out.bytes, 0, 2, 98)).toBe(false);
    expect(out.report.notes.find((entry) => entry.key === 'boxes.note.resize')?.params).toEqual({
      count: 1,
      width: 100,
      height: 100,
    });
  });
});

describe('applyPageBoxes: scaling annotations', () => {
  it('scales every point of an annotation, skips what is not a number, and moves the boxes on request', async () => {
    const input = await pagesWith(1, (doc, page) => {
      page.put('TrimBox', [20, 10, 120, 60]);
      const stroke = doc.newArray();
      for (const value of [10, 20, 30, 40]) stroke.push(value);
      const ink = doc.newArray();
      ink.push(stroke);
      ink.push(5);
      const vertices = doc.newArray();
      for (const value of [10, 20]) vertices.push(value);
      vertices.push(doc.newName('x'));
      vertices.push(40);
      page.put('Annots', [
        doc.addObject({
          Type: 'Annot',
          Subtype: 'Ink',
          Rect: [10, 20, 30, 40],
          InkList: ink,
          Vertices: vertices,
        }),
        doc.addObject(5),
        doc.addObject({ Type: 'Annot', Subtype: 'Line', Rect: [0, 0, 50, 50], L: [0, 0, 50, 50] }),
      ]);
    });
    const out = await applyPageBoxes(input, { mode: 'scale', pages: [0], factor: 2, scaleBoxes: true }, run);
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const annots = doc.findPage(0).get('Annots').resolve();
      const first = annots.get(0).resolve();
      const flat = (value: PDFObject) =>
        Array.from({ length: value.length }, (_u, index) => value.get(index).resolve());
      expect(flat(first.get('Rect')).map((entry) => entry.asNumber())).toEqual([20, 40, 60, 80]);
      expect(flat(first.get('InkList').resolve().get(0).resolve()).map((entry) => entry.asNumber())).toEqual([
        20, 40, 60, 80,
      ]);
      expect(first.get('InkList').resolve().get(1).resolve().asNumber()).toBe(5);
      const vertices = flat(first.get('Vertices').resolve());
      expect([
        vertices[0]?.asNumber(),
        vertices[1]?.asNumber(),
        vertices[2]?.asName(),
        vertices[3]?.asNumber(),
      ]).toEqual([20, 40, 'x', 80]);
      expect(annots.get(1).resolve().asNumber()).toBe(5);
      expect(flat(annots.get(2).resolve().get('L')).map((entry) => entry.asNumber())).toEqual([
        0, 0, 100, 100,
      ]);
    } finally {
      doc.destroy();
    }
    const page = await facts(out.bytes, 0);
    expect(page.media).toEqual([0, 0, 400, 200]);
    expect(page.trim).toEqual([40, 20, 240, 120]);
    expect(noteKeys(out)).toEqual(
      expect.arrayContaining(['boxes.note.annotationsScaled', 'boxes.note.boxesScaled']),
    );
  });

  it('scales a page with no annotations without the annotation note', async () => {
    const out = await applyPageBoxes(
      await pagesWith(1, () => {}),
      { mode: 'scale', pages: [0], factor: 2 },
      run,
    );
    expect(noteKeys(out)).not.toContain('boxes.note.annotationsScaled');
    expect(out.changed).toEqual([{ pages: [0], box: null }]);
  });
});

describe('applyPageBoxes: auto-crop in every orientation and with every option', () => {
  const crop = async (
    options: Record<string, unknown>,
    build: (doc: PDFDocument, page: PDFObject, index: number) => void = () => {},
    pages = 1,
    content?: string,
  ) => {
    const input = await pagesWith(pages, build, content);
    const out = await applyPageBoxes(
      input,
      { mode: 'auto-crop', pages: Array.from({ length: pages }, (_u, index) => index), ...options } as never,
      run,
    );
    return out;
  };

  it('finds the ink on a page turned half or three quarters round', async () => {
    for (const rotate of [180, 270]) {
      const out = await crop({}, (_doc, page) => page.put('Rotate', rotate));
      expect(near((await facts(out.bytes, 0)).crop, [20, 10, 120, 60], 1), `rotate ${rotate}`).toBe(true);
    }
  });

  it('pads the crop by the requested millimetres, never beyond the MediaBox', async () => {
    const out = await crop({ paddingMm: 10 });
    expect(near((await facts(out.bytes, 0)).crop, [0, 0, 148.35, 88.35], 1)).toBe(true);
  });

  it('grows a crop that would be too small to the minimum and says so', async () => {
    const out = await crop({}, () => {}, 1, '0 g 50 50 2 2 re f');
    expect(near((await facts(out.bytes, 0)).crop, [42, 42, 60, 60], 1)).toBe(true);
    expect(out.report.notes.find((entry) => entry.key === 'boxes.note.minCrop')?.params).toEqual({
      count: 1,
      points: 18,
    });
  });

  it('writes the trim box too on request and says so', async () => {
    const out = await crop({ alsoTrim: true });
    expect(noteKeys(out)).toContain('boxes.note.trimWritten');
  });

  it('counts a page whose crop already is the ink box once, and rewrites a trim box that is not', async () => {
    // Every edge of this ink sits on a 150 dpi pixel boundary, so the measured box is exact.
    const exact = '0 g 12 4 108 48 re f';
    const out = await crop(
      { alsoTrim: true },
      (_doc, page, index) => {
        page.put('CropBox', [12, 4, 120, 52]);
        if (index === 1) page.put('TrimBox', [0, 0, 50, 50]);
        if (index === 2) page.delete('CropBox');
      },
      3,
      exact,
    );
    expect(out.changed.map((entry) => entry.pages)).toEqual([[1], [2]]);
    expect(out.report.notes.find((entry) => entry.key === 'boxes.note.unchangedPages')?.params).toEqual({
      count: 1,
    });
    const second = await facts(out.bytes, 1);
    expect(near(second.trim, [12, 4, 120, 52], 0.01)).toBe(true);
  });

  it('leaves a page alone whose ink lies outside its MediaBox', async () => {
    const out = await crop(
      {},
      (_doc, page) => {
        page.put('MediaBox', [0, 0, 100, 100]);
        page.put('CropBox', [0, 0, 400, 100]);
      },
      2,
      '0 g 250 10 100 50 re f',
    );
    expect(out.changed).toEqual([]);
    expect(noteKeys(out)).toContain('boxes.note.unchanged');
  });
});

describe('applyPageBoxes: setting boxes that fit', () => {
  it('writes a crop box inside the page as asked, with nothing to clamp', async () => {
    const out = await applyPageBoxes(
      await pagesWith(1, () => {}),
      { mode: 'set', pages: [0], box: 'crop', rect: [10, 10, 100, 50] },
      run,
    );
    expect((await facts(out.bytes, 0)).crop).toEqual([10, 10, 100, 50]);
    expect(noteKeys(out)).not.toContain('boxes.note.clamped');
  });

  it('moves a MediaBox of a page that has no other box', async () => {
    const out = await applyPageBoxes(
      await pagesWith(1, () => {}),
      { mode: 'set', pages: [0], box: 'media', rect: [0, 0, 150, 90] },
      run,
    );
    const page = await facts(out.bytes, 0);
    expect(page.media).toEqual([0, 0, 150, 90]);
    expect(page.crop).toBeNull();
    expect(noteKeys(out)).not.toContain('boxes.note.clamped');
  });
});

describe('applyPageBoxes: turning content', () => {
  it('treats a /Rotate that is not a number as no turn', async () => {
    const input = await pagesWith(1, (doc, page) => page.put('Rotate', doc.newName('Foo')));
    const out = await applyPageBoxes(input, { mode: 'rotate-content', pages: [0], degrees: 90 }, run);
    expect((await facts(out.bytes, 0)).rotate).toBe(90);
  });

  it('turns from a /Rotate the page inherits, not from zero', async () => {
    const input = await pagesWith(1, (doc, page) => {
      page.delete('Rotate');
      doc.getTrailer().get('Root').get('Pages').put('Rotate', 90);
    });
    const out = await applyPageBoxes(input, { mode: 'rotate-content', pages: [0], degrees: 90 }, run);
    expect((await facts(out.bytes, 0)).rotate).toBe(180);
    expect(out.changed).toEqual([{ pages: [0], box: null }]);
  });
});

describe('readPageBoxes in unusual files', () => {
  it('answers nothing for no page, and refuses a page that is not there or not valid', async () => {
    const input = await pagesWith(1, () => {});
    expect(await readPageBoxes(input, [])).toEqual([]);
    expect((await refusal(readPageBoxes(input, [4]))).details.engineMessage).toBe(
      'page index 4 outside 0..0',
    );
    expect((await refusal(readPageBoxes(input, [-2]))).code).toBe('range-invalid');
  });

  it('stops at an aborted signal', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(readPageBoxes(await pagesWith(1, () => {}), [0], aborted.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    const live = new AbortController();
    expect(await readPageBoxes(await pagesWith(1, () => {}), [0], live.signal)).toHaveLength(1);
  });

  it('reads the default US Letter MediaBox of a page that has none', async () => {
    const input = await pagesWith(1, (_doc, page) => page.delete('MediaBox'));
    const [report] = await readPageBoxes(input, [0]);
    expect(report?.media).toEqual([0, 0, 612, 792]);
  });
});
