/**
 * Blank-page detection and two-up splitting against real bytes. The wrong answers that matter:
 * a page with a mark on it taken for blank, a scanned sheet with noise taken for content, a
 * half cut from the wrong side of a turned page, a split that draws instead of windows, and
 * labels that slide onto the wrong pages.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { readLabelRanges, replaceLabelRanges } from './page-labels';
import { findBlankPages, splitTwoUpPages } from './page-tidy';

const run = { signal: new AbortController().signal };

type Mupdf = typeof import('mupdf');

const SCAN_WIDTH = 600;
const SCAN_HEIGHT = 800;
const A4: readonly [number, number] = [595, 842];

/** A noisy blank sheet (greys 225..255) with a dark block at each mark, as a raw 8-bit image. */
function scanPixels(blocks: readonly (readonly [number, number, number, number])[]): Uint8Array {
  const width = SCAN_WIDTH;
  const pixels = new Uint8Array(width * SCAN_HEIGHT);
  let state = 12345;
  for (let index = 0; index < pixels.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[index] = 225 + (state % 31);
  }
  for (const [x, y, w, h] of blocks) {
    for (let row = y; row < y + h; row += 1) pixels.fill(110, row * width + x, row * width + x + w);
  }
  return pixels;
}

interface PageSpec {
  readonly size?: readonly [number, number];
  readonly rotate?: 0 | 90 | 180 | 270;
  readonly content?: string;
  readonly text?: string;
  readonly image?: Uint8Array;
  readonly annotation?: boolean;
}

async function build(
  specs: readonly PageSpec[],
  tweak?: (doc: PDFDocument, mupdf: Mupdf) => void,
): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  for (const [index, spec] of specs.entries()) {
    const size = spec.size ?? [200, 100];
    const resources: Record<string, unknown> = { Font: { F1: font } };
    let content = spec.content ?? '';
    if (spec.text !== undefined) content += ` BT /F1 18 Tf 10 40 Td ${spec.text} ET`;
    if (spec.image !== undefined) {
      const image = doc.addStream(spec.image, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: SCAN_WIDTH,
        Height: SCAN_HEIGHT,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      });
      resources.XObject = { Im0: image };
      content += ` q ${size[0]} 0 0 ${size[1]} 0 0 cm /Im0 Do Q`;
    }
    const page = doc.addPage([0, 0, size[0], size[1]], spec.rotate ?? 0, resources, content);
    if (spec.annotation === true) {
      page.put('Annots', [doc.addObject({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10] })]);
    }
    doc.insertPage(index, page);
  }
  tweak?.(doc, mupdf);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Page facts as a reader sees them after the split: its media box width and height. */
async function sizes(bytes: Uint8Array): Promise<readonly (readonly [number, number])[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF() as PDFDocument;
  try {
    return Array.from({ length: doc.countPages() }, (_unused, index) => {
      const bounds = doc.loadPage(index).getBounds();
      return [Math.round(bounds[2] - bounds[0]), Math.round(bounds[3] - bounds[1])] as const;
    });
  } finally {
    doc.destroy();
  }
}

/** The share of a page's pixels that are dark when it is drawn at 72 dpi. */
async function darkShare(bytes: Uint8Array, index: number): Promise<number> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc
      .loadPage(index)
      .toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, false);
    const pixels = pixmap.getPixels();
    let dark = 0;
    for (let y = 0; y < pixmap.getHeight(); y += 1) {
      for (let x = 0; x < pixmap.getWidth(); x += 1) {
        if ((pixels[y * pixmap.getStride() + x] ?? 255) < 128) dark += 1;
      }
    }
    return dark / (pixmap.getWidth() * pixmap.getHeight());
  } finally {
    doc.destroy();
  }
}

async function withDocument<T>(bytes: Uint8Array, read: (doc: PDFDocument) => T): Promise<T> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF() as PDFDocument;
  try {
    return read(doc);
  } finally {
    doc.destroy();
  }
}

describe('findBlankPages', () => {
  it('finds exactly the pages with nothing to see or read, and keeps every page that has a mark', async () => {
    const bytes = await build([
      {},
      { text: '(Hello) Tj' },
      { content: '1 g 0 0 200 100 re f' },
      { content: '0 g 20 20 80 40 re f' },
      { annotation: true },
      { text: '3 Tr (Hidden words) Tj' },
      { text: '3 Tr (. , -) Tj' },
      { content: '0 g 0 0 200 100 re f' },
      { content: '0.99 g 0 0 200 100 re f' },
      { content: '0.5 G 1 w 20 50 m 180 50 l S' },
    ]);
    expect(await findBlankPages(bytes, run)).toEqual([0, 2, 6, 8]);
  });

  it('treats a scanned sheet with noise as blank and the same sheet with a real mark as content', async () => {
    // Dust: two 3×3 specks. A mark: a bar 200 pixels long and 6 high.
    const speckled = scanPixels([
      [30, 40, 3, 3],
      [400, 600, 3, 3],
    ]);
    const marked = scanPixels([[100, 300, 200, 6]]);
    const bytes = await build([
      { size: A4, image: speckled },
      { size: A4, image: marked },
    ]);
    expect(await findBlankPages(bytes, run)).toEqual([0]);
  });

  it('takes a light-grey mark on white paper for content, and the same grey filling the page for tinted paper', async () => {
    const bytes = await build([
      { content: '0.8 g 20 20 80 40 re f' },
      { content: '0.8 G 1 w 20 50 m 180 50 l S 20 80 m 180 80 l S' },
      { content: '0.8 g 0 0 2000 2000 re f' },
    ]);
    expect(await findBlankPages(bytes, run)).toEqual([2]);
  });

  it('draws a poster-sized page at a bounded size and still finds its ink', async () => {
    const bytes = await build([
      { size: [14400, 14400] },
      { size: [14400, 14400], content: '0 g 100 100 2000 2000 re f' },
    ]);
    expect(await findBlankPages(bytes, run)).toEqual([0]);
  });

  it('reports a progress step for every page', async () => {
    const bytes = await build([{}, { text: '(A) Tj' }, {}]);
    const steps: { done?: number; total?: number; labelKey: string }[] = [];
    await findBlankPages(bytes, { signal: run.signal, onProgress: (step) => steps.push(step) });
    expect(steps.map((step) => [step.done, step.total, step.labelKey])).toEqual([
      [1, 3, 'tidy.progress.scan'],
      [2, 3, 'tidy.progress.scan'],
      [3, 3, 'tidy.progress.scan'],
    ]);
  });

  it('stops at an aborted signal, before the first page and between pages', async () => {
    const bytes = await build([{}, {}]);
    const before = new AbortController();
    before.abort();
    await expect(findBlankPages(bytes, { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const midway = new AbortController();
    await expect(
      findBlankPages(bytes, { signal: midway.signal, onProgress: () => midway.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('splitTwoUpPages', () => {
  const LEFT_INK = '0 g 0 0 150 200 re f';
  const RIGHT_INK = '0 g 250 0 150 100 re f';

  it('windows a landscape page into its left and right halves, in that order, without drawing anything', async () => {
    const bytes = await build([{ size: [400, 200], content: `${LEFT_INK} ${RIGHT_INK}` }]);
    const outcome = await splitTwoUpPages(bytes, [0], run);
    expect(outcome.split).toEqual([0]);
    expect(outcome.report.pageCount).toBe(2);
    expect(outcome.report.notes.map((entry) => [entry.kind, entry.key])).toContainEqual([
      'changed',
      'tidy.split.done',
    ]);
    expect(await sizes(outcome.bytes)).toEqual([
      [200, 200],
      [200, 200],
    ]);
    // The left page shows the left block (150 of its 200 columns); the right page shows the
    // lower half of the 150 columns of its own: each shows its half of the original page.
    expect(await darkShare(outcome.bytes, 0)).toBeCloseTo(0.75, 2);
    expect(await darkShare(outcome.bytes, 1)).toBeCloseTo(0.375, 2);
    // Windowing: both pages draw the same content stream, which the file holds once.
    const contents = await withDocument(outcome.bytes, (doc) =>
      [0, 1].map((index) => doc.findPage(index).get('Contents').asIndirect()),
    );
    expect(contents[0]).toBe(contents[1]);
    const boxes = await withDocument(outcome.bytes, (doc) =>
      [0, 1].map((index) => [
        doc.findPage(index).get('MediaBox').toString(),
        doc.findPage(index).get('CropBox').toString(),
      ]),
    );
    expect(boxes).toEqual([
      ['[0 0 200 200]', '[0 0 200 200]'],
      ['[200 0 400 200]', '[200 0 400 200]'],
    ]);
    expect(outcome.bytes.byteLength).toBeLessThan(bytes.byteLength * 1.5);
  });

  it.each([
    // The page is 400×200 once turned, with its ink in the half the reader shows on the left.
    [90, [200, 400], '0 g 0 0 200 200 re f'],
    [180, [400, 200], '0 g 200 0 200 200 re f'],
    [270, [200, 400], '0 g 0 200 200 200 re f'],
  ] as const)(
    'cuts a page turned %i degrees as the reader shows it, left half first',
    async (rotate, size, ink) => {
      const bytes = await build([{ size, rotate, content: ink }]);
      const outcome = await splitTwoUpPages(bytes, [0], run);
      expect(outcome.split).toEqual([0]);
      expect(await darkShare(outcome.bytes, 0)).toBeGreaterThan(0.95);
      expect(await darkShare(outcome.bytes, 1)).toBe(0);
    },
  );

  it('splits only the pages asked for, leaves a portrait page and a page with notes whole, and says so', async () => {
    const bytes = await build([
      { size: [400, 200] },
      { size: [100, 200] },
      { size: [600, 200] },
      { size: [800, 200], annotation: true },
      { size: [500, 200] },
    ]);
    const outcome = await splitTwoUpPages(bytes, [0, 1, 2, 3], run);
    expect(outcome.split).toEqual([0, 2]);
    expect((await sizes(outcome.bytes)).map(([width]) => width)).toEqual([200, 200, 100, 300, 300, 800, 500]);
    const notes = outcome.report.notes;
    expect(notes).toContainEqual({
      kind: 'changed',
      key: 'tidy.split.done',
      params: { count: 2, pages: '1, 3' },
    });
    expect(notes).toContainEqual({ kind: 'preserved', key: 'tidy.split.portrait', params: { count: 1 } });
    expect(notes).toContainEqual({
      kind: 'warning',
      key: 'tidy.split.annotated',
      params: { count: 1, pages: '4' },
    });
  });

  it('returns the file as it was, with the reason, when nothing in the scope can be split', async () => {
    const bytes = await build([{ size: [100, 200] }, { size: [400, 200], annotation: true }]);
    const outcome = await splitTwoUpPages(bytes, [0, 1], run);
    expect(outcome.split).toEqual([]);
    expect(outcome.bytes).toEqual(bytes);
    expect(outcome.report.pageCount).toBe(2);
    expect(outcome.report.notes.map((entry) => entry.key)).toEqual([
      'tidy.split.portrait',
      'tidy.split.annotated',
    ]);
  });

  it('gives each half the label its source page had', async () => {
    const bytes = await build(
      [{ size: [400, 200] }, { size: [100, 200] }, { size: [400, 200] }],
      (doc, mupdf) =>
        replaceLabelRanges(mupdf, doc, [{ startPage: 0, style: 'decimal', prefix: 'p-', start: 1 }]),
    );
    const outcome = await splitTwoUpPages(bytes, [0, 1, 2], run);
    expect((await sizes(outcome.bytes)).length).toBe(5);
    const ranges = await withDocument(outcome.bytes, (doc) => readLabelRanges(doc));
    // p-1 p-1 | p-2 | p-3 p-3: a run counts on, and starts again where a number repeats.
    expect(ranges).toEqual([
      { startPage: 0, style: 'decimal', prefix: 'p-', start: 1 },
      { startPage: 1, style: 'decimal', prefix: 'p-', start: 1 },
      { startPage: 4, style: 'decimal', prefix: 'p-', start: 3 },
    ]);
  });

  it('leaves a document without labels without labels', async () => {
    const bytes = await build([{ size: [400, 200] }]);
    const outcome = await splitTwoUpPages(bytes, [0], run);
    expect(await withDocument(outcome.bytes, (doc) => readLabelRanges(doc))).toEqual([]);
  });

  it('gives the copy its own inherited rotation and resources, and none of the thumbnail or structure keys', async () => {
    const bytes = await build([{ size: [200, 400], rotate: 90 }], (doc) => {
      const page = doc.findPage(0);
      const parent = page.get('Parent');
      parent.put('Rotate', 90);
      parent.put('Resources', page.get('Resources'));
      page.delete('Rotate');
      page.delete('Resources');
      page.put('StructParents', 3);
      page.put('Thumb', page.get('Contents'));
    });
    const outcome = await splitTwoUpPages(bytes, [0], run);
    const facts = await withDocument(outcome.bytes, (doc) =>
      [0, 1].map((index) => {
        const page = doc.findPage(index);
        const own = (key: string) => !page.get(key).isNull();
        return {
          rotate: own('Rotate'),
          resources: own('Resources'),
          thumb: own('Thumb'),
          struct: own('StructParents'),
        };
      }),
    );
    expect(facts[1]).toEqual({ rotate: true, resources: true, thumb: false, struct: false });
    expect(facts[0]?.thumb).toBe(false);
  });

  it('copes with a page that has no rotation anywhere', async () => {
    const bytes = await build([{ size: [400, 200] }], (doc) => doc.findPage(0).delete('Rotate'));
    const outcome = await splitTwoUpPages(bytes, [0], run);
    expect(outcome.split).toEqual([0]);
  });

  it('drops the finer page boxes, which no longer fit a half', async () => {
    const bytes = await build([{ size: [400, 200] }], (doc) => {
      const page: PDFObject = doc.findPage(0);
      for (const key of ['TrimBox', 'BleedBox', 'ArtBox']) page.put(key, [10, 10, 390, 190]);
    });
    const outcome = await splitTwoUpPages(bytes, [0], run);
    const left = await withDocument(outcome.bytes, (doc) =>
      ['TrimBox', 'BleedBox', 'ArtBox'].map((key) => doc.findPage(0).get(key).isNull()),
    );
    expect(left).toEqual([true, true, true]);
  });

  it('reports every page it handled and stops at an aborted signal', async () => {
    const bytes = await build([{ size: [400, 200] }, { size: [400, 200] }]);
    const steps: number[] = [];
    await splitTwoUpPages(bytes, [0, 1], {
      signal: run.signal,
      onProgress: (step) => steps.push(step.done ?? -1),
    });
    expect(steps).toEqual([1, 2]);

    const before = new AbortController();
    before.abort();
    await expect(splitTwoUpPages(bytes, [0], { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const midway = new AbortController();
    await expect(
      splitTwoUpPages(bytes, [0, 1], { signal: midway.signal, onProgress: () => midway.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // An abort during the last page still ends in an abort, not in a file nobody asked for.
    const last = new AbortController();
    await expect(
      splitTwoUpPages(bytes, [0], { signal: last.signal, onProgress: () => last.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
