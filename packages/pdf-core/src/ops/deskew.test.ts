/**
 * Straightening scanned pages, against bitmaps and PDFs whose tilt is known. The wrong
 * answers that matter: an angle that is off, or of the wrong sign (the page is turned the
 * wrong way and ends up twice as crooked); a page turned about the wrong point; a scan that
 * is re-encoded instead of turned; text pushed off the page; a page without lines of text
 * "measured" anyway; and a level page turned for no reason.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it, vi } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { PRODUCER_LINE, pageContentParts } from '../engines/mupdf-write';
import { assessPage, DESKEW_MAX_ANGLE, deskewPages } from './deskew';
import { PAGE_HEIGHT, PAGE_WIDTH, renderPage, scanDocument, textBitmap, tiltedText } from './deskew.fixtures';
import { detectSkew, type Grey } from './ocr-preprocess';

// Each case typesets, renders and measures whole pages with MuPDF: well under a second alone,
// several under the coverage run on a loaded core.
vi.setConfig({ testTimeout: 60_000 });

const run = { signal: new AbortController().signal };

describe('the angle of a page of text, measured on a bitmap', () => {
  const angles = [0.3, 1.37, 2.93, 6, 11.5, 14.6, -0.8, -4.61, -9.2, -14.8];
  it.each(angles)('finds %d° within 0.1° and keeps its sign', (degrees) => {
    const found = assessPage(textBitmap({ degrees }));
    expect(found.verdict).toBe('straightened');
    expect(Math.abs(found.angle - degrees)).toBeLessThanOrEqual(0.1);
  });

  it.each([
    [1.37, 30, 0.002],
    [-4.61, 50, 0.004],
    [-5, 40, 0.02],
  ])('finds %d° under grey noise of %d levels and %d speckle', (degrees, noise, speckle) => {
    const found = assessPage(textBitmap({ degrees, noise, speckle, seed: 7 }));
    expect(found.verdict).toBe('straightened');
    expect(Math.abs(found.angle - degrees)).toBeLessThanOrEqual(0.1);
  });

  it('calls a page that is off by less than a tenth of a degree level', () => {
    for (const degrees of [0, 0.04, -0.06]) {
      const found = assessPage(textBitmap({ degrees }));
      expect(found.verdict, String(degrees)).toBe('level');
      expect(Math.abs(found.angle)).toBeLessThan(0.1);
    }
  });

  it('has no estimate for a blank page, for dust alone or for a single line of text', () => {
    const blank: Grey = { width: 850, height: 1200, data: new Uint8Array(850 * 1200).fill(255) };
    expect(assessPage(blank)).toEqual({ verdict: 'unclear', angle: 0 });

    const dust = new Uint8Array(850 * 1200).fill(255);
    const next = (() => {
      let state = 99;
      return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
    })();
    for (let at = 0; at < dust.length; at += 1) if (next() < 0.01) dust[at] = 0;
    expect(assessPage({ width: 850, height: 1200, data: dust })).toEqual({ verdict: 'unclear', angle: 0 });

    // A page number: one short line.
    for (const degrees of [0, 3]) {
      expect(assessPage(textBitmap({ degrees, rows: 1, columns: 8 })), `${degrees}°`).toEqual({
        verdict: 'unclear',
        angle: 0,
      });
    }
  });

  it('does not trust a skew past the window it searches', () => {
    expect(DESKEW_MAX_ANGLE).toBe(15);
    expect(assessPage(textBitmap({ degrees: 16 }))).toEqual({ verdict: 'unclear', angle: 0 });
    expect(assessPage(textBitmap({ degrees: -16 }))).toEqual({ verdict: 'unclear', angle: 0 });
  });

  it('leaves a page alone when turning it would push its text off the page, and only then', () => {
    // A sheet that turned about its lower right corner: put back about the page centre, its
    // text moves sideways by far more than the margin.
    const corner = [850, 1200] as const;
    for (const degrees of [10, -10]) {
      const found = assessPage(textBitmap({ degrees, margin: 40, pivot: corner }));
      expect(found.verdict, `${degrees}°`).toBe('edge');
      expect(Math.abs(found.angle - degrees)).toBeLessThanOrEqual(0.1);
    }
    // The same tilt about the centre, or about the corner with room to spare, is turned.
    expect(assessPage(textBitmap({ degrees: 10, margin: 40 })).verdict).toBe('straightened');
    expect(assessPage(textBitmap({ degrees: 2, margin: 40, pivot: corner })).verdict).toBe('straightened');
  });

  it('lets a few specks beyond the text fall off the page, which is not text', () => {
    const page = textBitmap({ degrees: 3 });
    // Inside the frame now, outside it once the page is turned back: a speck near each corner.
    for (const [x, y] of [
      [26, 38],
      [822, 38],
      [26, 1160],
      [822, 1160],
      [40, 600],
    ] as const) {
      page.data[y * page.width + x] = 0;
    }
    const found = assessPage(page);
    expect(found.verdict).toBe('straightened');
    expect(Math.abs(found.angle - 3)).toBeLessThanOrEqual(0.1);
  });
});

/** A document's pages as MuPDF reads them. */
async function open(bytes: Uint8Array): Promise<{ doc: PDFDocument; pages: PDFObject[] }> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF() as PDFDocument;
  return { doc, pages: Array.from({ length: doc.countPages() }, (_unused, index) => doc.findPage(index)) };
}

/** The darkness a rendered page holds: what a turn that cuts nothing keeps. */
function ink(grey: Grey): number {
  let total = 0;
  for (const value of grey.data) total += 255 - value;
  return total;
}

/** The box around the dark pixels of a rendered page, `[x0, y0, x1, y1]`, half-open. */
function inkBox(grey: Grey): [number, number, number, number] {
  let [x0, y0, x1, y1] = [grey.width, grey.height, 0, 0];
  for (let y = 0; y < grey.height; y += 1) {
    for (let x = 0; x < grey.width; x += 1) {
      if ((grey.data[y * grey.width + x] as number) >= 128) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  return [x0, y0, x1, y1];
}

/** The six numbers of the `cm` that opens a turned page's first content stream, `q a b c d e f cm`. */
function turnMatrix(page: PDFObject): number[] {
  const parts = pageContentParts(page);
  if (parts === null || parts === 'unreadable') throw new Error('the page has no readable contents');
  const text = new TextDecoder().decode(parts[0]);
  const found = /^q ((?:-?[\d.]+ ){5}-?[\d.]+) cm\nq\n$/.exec(text);
  if (found === null) throw new Error(`not a turn: ${JSON.stringify(text)}`);
  return (found[1] as string).split(' ').map(Number);
}

/** The point a PDF matrix `[a b c d e f]` sends `(x, y)` to. */
const apply = (m: readonly number[], x: number, y: number): [number, number] => [
  (m[0] as number) * x + (m[2] as number) * y + (m[4] as number),
  (m[1] as number) * x + (m[3] as number) * y + (m[5] as number),
];

/** The raw pixels of the page's only picture. */
function pixelsOf(page: PDFObject): { width: number; height: number; bytes: Uint8Array } {
  const picture = page.get('Resources').get('XObject').get('Im0');
  const buffer = picture.readStream();
  try {
    return {
      width: picture.get('Width').asNumber(),
      height: picture.get('Height').asNumber(),
      bytes: new Uint8Array(buffer.asUint8Array()),
    };
  } finally {
    buffer.destroy();
  }
}

const boxOf = (page: PDFObject, key: string): number[] | null => {
  const entry = page.get(key);
  return entry.isNull() ? null : Array.from({ length: 4 }, (_unused, at) => entry.get(at).asNumber());
};

describe('straightening the pages of a scan', () => {
  it('turns each crooked page back by the angle it measured, and leaves the level and the blank alone', async () => {
    const input = await scanDocument([
      { content: tiltedText(2.4), noise: 20 },
      { content: tiltedText(-5.5) },
      { content: tiltedText(0) },
      { content: '' },
    ]);
    const outcome = await deskewPages(input, { pages: [0, 1, 2, 3] }, run);

    expect(outcome.pages.map((page) => page.verdict)).toEqual([
      'straightened',
      'straightened',
      'level',
      'unclear',
    ]);
    expect(Math.abs((outcome.pages[0]?.angle ?? 0) - 2.4)).toBeLessThanOrEqual(0.15);
    expect(Math.abs((outcome.pages[1]?.angle ?? 0) + 5.5)).toBeLessThanOrEqual(0.15);

    // The proof the page is straight: measured again on a picture taken of the result, with
    // another resolution and the OCR's own search, no tilt is left.
    for (const pageIndex of [0, 1]) {
      const left = detectSkew(await renderPage(outcome.bytes, pageIndex));
      expect(Math.abs(left.angle), `page ${pageIndex + 1}`).toBeLessThanOrEqual(0.15);
      expect(Math.abs(assessPage(await renderPage(outcome.bytes, pageIndex)).angle)).toBeLessThanOrEqual(
        0.15,
      );
    }
    // ... and it was crooked before: the same measurement on the input.
    expect(Math.abs(detectSkew(await renderPage(input, 1)).angle + 5.5)).toBeLessThanOrEqual(0.15);

    // Nothing was cut off the page: the render holds the ink it held, and none of it touches an edge.
    for (const pageIndex of [0, 1]) {
      const before = await renderPage(input, pageIndex);
      const after = await renderPage(outcome.bytes, pageIndex);
      expect(Math.abs(ink(after) / ink(before) - 1), `page ${pageIndex + 1}`).toBeLessThan(0.05);
      const [x0, y0, x1, y1] = inkBox(after);
      expect(Math.min(x0, y0, after.width - x1, after.height - y1), `page ${pageIndex + 1}`).toBeGreaterThan(
        20,
      );
    }

    expect(outcome.report.steps).toEqual(['render', 'deskew', 'save']);
    expect(outcome.report.incremental).toBe(false);
    expect(outcome.report.pageCount).toBe(4);
  });

  it('turns by a rotation about the centre of the page, around the contents it leaves as they were', async () => {
    const input = await scanDocument([{ content: tiltedText(3.2) }, { content: tiltedText(0) }]);
    const outcome = await deskewPages(input, { pages: [0, 1] }, run);
    const before = await open(input);
    const after = await open(outcome.bytes);
    try {
      const angle = outcome.pages[0]?.angle ?? 0;
      const matrix = turnMatrix(after.pages[0] as PDFObject);
      const radians = (angle * Math.PI) / 180;
      // A counter-clockwise turn by the angle the lines descend by.
      expect(matrix[0]).toBeCloseTo(Math.cos(radians), 5);
      expect(matrix[1]).toBeCloseTo(Math.sin(radians), 5);
      expect(matrix[2]).toBeCloseTo(-Math.sin(radians), 5);
      expect(matrix[3]).toBeCloseTo(Math.cos(radians), 5);
      expect(matrix[1] as number).toBeGreaterThan(0);
      const [x, y] = apply(matrix, PAGE_WIDTH / 2, PAGE_HEIGHT / 2);
      expect(x).toBeCloseTo(PAGE_WIDTH / 2, 2);
      expect(y).toBeCloseTo(PAGE_HEIGHT / 2, 2);

      // Wrapped, not rewritten: the original contents sit between the two new streams ...
      const wrapped = pageContentParts(after.pages[0] as PDFObject);
      const original = pageContentParts(before.pages[0] as PDFObject);
      if (wrapped === null || wrapped === 'unreadable' || original === null || original === 'unreadable') {
        throw new Error('unreadable contents');
      }
      expect(wrapped).toHaveLength(original.length + 2);
      expect(wrapped.slice(1, -1).map((part) => Array.from(part))).toEqual(
        original.map((part) => Array.from(part)),
      );
      expect(new TextDecoder().decode(wrapped.at(-1))).toBe('\nQ\nQ\n');

      // ... the scan is the same picture, pixel for pixel, and the page the same size.
      const picture = pixelsOf(after.pages[0] as PDFObject);
      const source = pixelsOf(before.pages[0] as PDFObject);
      expect([picture.width, picture.height]).toEqual([source.width, source.height]);
      expect(Buffer.compare(picture.bytes, source.bytes)).toBe(0);
      expect(boxOf(after.pages[0] as PDFObject, 'MediaBox')).toEqual([0, 0, PAGE_WIDTH, PAGE_HEIGHT]);
      expect(boxOf(after.pages[0] as PDFObject, 'CropBox')).toBeNull();

      // A level page is not touched.
      const untouched = pageContentParts(after.pages[1] as PDFObject);
      const was = pageContentParts(before.pages[1] as PDFObject);
      expect(untouched).toEqual(was);
    } finally {
      before.doc.destroy();
      after.doc.destroy();
    }
  });

  it('measures what the viewer shows: a page turned a quarter is straightened about the centre of its crop', async () => {
    // Landscape sheet shown turned a quarter, its text horizontal on screen and tilted 4°.
    const sideways = `q 0 1 -1 0 ${PAGE_HEIGHT} 0 cm\n${tiltedText(-4)}\nQ`;
    const input = await scanDocument([
      { content: sideways, size: [PAGE_HEIGHT, PAGE_WIDTH], rotate: 90, cropBox: [10, 10, 830, 585] },
    ]);
    const outcome = await deskewPages(input, { pages: [0] }, run);
    expect(outcome.pages[0]?.verdict).toBe('straightened');
    expect(Math.abs((outcome.pages[0]?.angle ?? 0) + 4)).toBeLessThanOrEqual(0.15);

    const after = await open(outcome.bytes);
    try {
      const matrix = turnMatrix(after.pages[0] as PDFObject);
      // The centre of the CropBox, in the page's own (unturned) space, stays where it is.
      const [x, y] = apply(matrix, 420, 297.5);
      expect(x).toBeCloseTo(420, 2);
      expect(y).toBeCloseTo(297.5, 2);
      // The lines climb to the right on screen, so the turn is clockwise there and in the page's own space.
      expect(matrix[1]).toBeCloseTo(Math.sin(((outcome.pages[0]?.angle ?? 0) * Math.PI) / 180), 5);
      expect(matrix[1] as number).toBeLessThan(0);
      expect(boxOf(after.pages[0] as PDFObject, 'CropBox')).toEqual([10, 10, 830, 585]);
      expect(after.pages[0]?.get('Rotate').asNumber()).toBe(90);
    } finally {
      after.doc.destroy();
    }
    expect(Math.abs(detectSkew(await renderPage(outcome.bytes, 0)).angle)).toBeLessThanOrEqual(0.15);
  });

  it('leaves annotations where they are and says on how many turned pages they no longer sit on the content', async () => {
    const input = await scanDocument([
      { content: tiltedText(2), annotated: true },
      { content: tiltedText(-3), emptyAnnots: true },
      { content: tiltedText(2.5), annotated: true },
      { content: tiltedText(0), annotated: true },
    ]);
    const outcome = await deskewPages(input, { pages: [0, 1, 2, 3] }, run);
    expect(outcome.pages.map((page) => page.verdict)).toEqual([
      'straightened',
      'straightened',
      'straightened',
      'level',
    ]);
    const after = await open(outcome.bytes);
    try {
      for (const pageIndex of [0, 2, 3]) {
        const annotation = after.pages[pageIndex]?.get('Annots').get(0);
        expect(
          Array.from({ length: 4 }, (_unused, at) => annotation?.get('Rect').get(at).asNumber()),
        ).toEqual([100, 100, 200, 160]);
      }
    } finally {
      after.doc.destroy();
    }
    // Pages 1 and 3 carry annotations that moved off the content; page 2 has an empty list and page 4 was not turned.
    expect(outcome.report.notes).toContainEqual({
      kind: 'warning',
      key: 'deskew.note.annotations',
      params: { count: 2 },
    });
  });

  it('skips a page whose text a turn would push off the page, and writes nothing when no page is left to turn', async () => {
    const input = await scanDocument([
      { content: tiltedText(10, { left: 25, pivot: [PAGE_WIDTH, 0], size: 11 }) },
    ]);
    const outcome = await deskewPages(input, { pages: [0] }, run);
    expect(outcome.pages[0]?.verdict).toBe('edge');
    expect(Math.abs((outcome.pages[0]?.angle ?? 0) - 10)).toBeLessThanOrEqual(0.15);
    expect(Buffer.compare(outcome.bytes, input)).toBe(0);
    expect(outcome.report.steps).toEqual(['render']);
    expect(outcome.report.incremental).toBe(true);
    expect(outcome.report.outputBytes).toBe(input.byteLength);
    expect(outcome.report.notes).toEqual([
      { kind: 'warning', key: 'deskew.note.edge', params: { page: 1, angle: outcome.pages[0]?.angle ?? 0 } },
      { kind: 'warning', key: 'deskew.note.unchanged' },
    ]);
  });

  it('reports every page by its number: the tilt removed, level, no clear lines, or skipped at the edge', async () => {
    const input = await scanDocument([
      { content: tiltedText(-1.8) },
      { content: tiltedText(0) },
      { content: '' },
    ]);
    const outcome = await deskewPages(input, { pages: [2, 0, 1, 0] }, run);
    expect(outcome.pages.map((page) => page.pageIndex)).toEqual([0, 1, 2]);
    const angle = Math.abs(outcome.pages[0]?.angle ?? 0);
    expect(outcome.report.notes).toEqual([
      { kind: 'changed', key: 'deskew.note.straightened', params: { page: 1, angle } },
      { kind: 'preserved', key: 'deskew.note.level', params: { page: 2 } },
      { kind: 'warning', key: 'deskew.note.unclear', params: { page: 3 } },
      { kind: 'preserved', key: 'deskew.note.lossless' },
      { kind: 'preserved', key: 'op.note.metadata.producerKept', params: { producer: PRODUCER_LINE } },
    ]);
    expect(angle).toBeGreaterThan(1.6);
    expect(angle).toBeLessThan(2);
  });

  it('works only on the pages it is given', async () => {
    const input = await scanDocument([{ content: tiltedText(3) }, { content: tiltedText(3) }]);
    const outcome = await deskewPages(input, { pages: [1] }, run);
    expect(outcome.pages.map((page) => page.pageIndex)).toEqual([1]);
    const after = await open(outcome.bytes);
    try {
      expect(pageContentParts(after.pages[0] as PDFObject)).toHaveLength(1);
      expect(pageContentParts(after.pages[1] as PDFObject)).toHaveLength(3);
    } finally {
      after.doc.destroy();
    }
  });

  it('finds a page it has straightened level the second time', async () => {
    const input = await scanDocument([{ content: tiltedText(4.3) }, { content: tiltedText(-7.1) }]);
    const once = await deskewPages(input, { pages: [0, 1] }, run);
    const twice = await deskewPages(once.bytes, { pages: [0, 1] }, run);
    expect(twice.pages.map((page) => page.verdict)).toEqual(['level', 'level']);
    expect(Buffer.compare(twice.bytes, once.bytes)).toBe(0);
  });

  it('reports a page at a time, to a listener or to none', async () => {
    const input = await scanDocument([{ content: tiltedText(1.5) }, { content: tiltedText(0) }]);
    const progress: unknown[] = [];
    await deskewPages(input, { pages: [0, 1] }, { ...run, onProgress: (entry) => progress.push(entry) });
    expect(progress).toEqual([
      { phase: 'deskew', labelKey: 'op.progress.deskew', done: 1, total: 2 },
      { phase: 'deskew', labelKey: 'op.progress.deskew', done: 2, total: 2 },
    ]);
    await expect(deskewPages(input, { pages: [0] }, run)).resolves.toBeDefined();
  });

  it('stops when it is cancelled, before it starts and between two pages', async () => {
    const input = await scanDocument([{ content: tiltedText(1.5) }, { content: tiltedText(2.5) }]);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(deskewPages(input, { pages: [0] }, { signal: cancelled.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    const later = new AbortController();
    await expect(
      deskewPages(input, { pages: [0, 1] }, { signal: later.signal, onProgress: () => later.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses no page, and a page the document does not have', async () => {
    const input = await scanDocument([{ content: tiltedText(1.5) }]);
    const refusal = async (pages: readonly number[]): Promise<ToolError> => {
      try {
        await deskewPages(input, { pages }, run);
      } catch (error) {
        if (isToolError(error)) return error;
        throw error;
      }
      throw new Error('the call resolved instead of rejecting');
    };
    expect((await refusal([])).code).toBe('selection-empty');
    for (const pages of [[1], [-1], [Number.NaN], [0.5]]) {
      expect((await refusal(pages)).code, JSON.stringify(pages)).toBe('range-invalid');
    }
  });
});
