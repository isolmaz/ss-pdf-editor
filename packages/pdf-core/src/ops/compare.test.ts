/**
 * Document comparison against real bytes. The wrong answers that matter: two identical
 * documents reported as different (or a changed line as identical), a changed line reported
 * as an unrelated removal plus addition, a page that exists on one side only silently
 * dropped, a bound that was hit but not reported, and a rendering comparison whose
 * "identical" depends on antialiasing noise.
 *
 * The text comparison runs on real MuPDF-built files through the real pdf.js engine. The
 * pixel comparison needs a 2D surface, which compare.ts takes from its caller; the tests
 * give it the Skia canvas that pdf.js itself uses in Node (`@napi-rs/canvas`, an optional
 * dependency of `pdfjs-dist`), so the pixels are really rendered.
 */

import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPARE_DPI,
  COMPARE_LIMITS,
  type CompareCanvas,
  compareText,
  compareVisual,
  IDENTICAL_PERCENT,
} from './compare';
import type { OperationContext, OperationProgress } from './types';

const run: OperationContext = { signal: new AbortController().signal };

/** A page: its size in points and, for the text tests, its lines. */
interface PageSpec {
  readonly size?: readonly [number, number];
  readonly lines?: readonly string[];
  /** Raw content-stream operators appended after the text. */
  readonly draw?: string;
}

/** A PDF whose pages carry the given lines (Helvetica 12, 14 pt apart) and drawing. */
async function build(pages: readonly PageSpec[]): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  for (const [index, page] of pages.entries()) {
    const [width, height] = page.size ?? [400, 400];
    const text = (page.lines ?? [])
      .map((line, row) => `BT /F 12 Tf 20 ${height - 40 - row * 14} Td (${line}) Tj ET`)
      .join('\n');
    doc.insertPage(
      index,
      doc.addPage([0, 0, width, height], 0, { Font: { F: font } }, `${text}\n${page.draw ?? ''}`),
    );
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const linesOf = (...pages: readonly (readonly string[])[]): PageSpec[] => pages.map((lines) => ({ lines }));

/** An abort that fires on the n-th progress report (1-based) of an operation. */
function abortOnProgress(count: number): OperationContext {
  const controller = new AbortController();
  let seen = 0;
  return {
    signal: controller.signal,
    onProgress: () => {
      seen += 1;
      if (seen === count) controller.abort();
    },
  };
}

describe('compareText', () => {
  it('reports identical documents page by page with zero changes', async () => {
    const bytes = await build(linesOf(['Alpha', 'Bravo'], ['Charlie']));
    const result = await compareText(bytes, bytes.slice(), run);
    expect(result).toEqual({
      method: 'text',
      leftPageCount: 2,
      rightPageCount: 2,
      pageCountDelta: 0,
      pages: [
        {
          pageIndex: 0,
          status: 'identical',
          leftLines: 2,
          rightLines: 2,
          added: 0,
          removed: 0,
          changed: 0,
          lines: [],
          truncated: false,
          reasons: [],
        },
        {
          pageIndex: 1,
          status: 'identical',
          leftLines: 1,
          rightLines: 1,
          added: 0,
          removed: 0,
          changed: 0,
          lines: [],
          truncated: false,
          reasons: [],
        },
      ],
      summary: {
        pagesCompared: 2,
        identicalPages: 2,
        changedPages: 0,
        addedPages: 0,
        removedPages: 0,
        addedLines: 0,
        removedLines: 0,
        changedLines: 0,
      },
      truncated: false,
      truncationReasons: [],
    });
  });

  it('names a edited line as one changed line with the words that differ', async () => {
    const left = await build(linesOf(['Alpha line', 'Beta beta gamma', 'Omega line']));
    const right = await build(linesOf(['Alpha line', 'Beta beta delta', 'Omega line']));
    const result = await compareText(left, right, run);
    expect(result.pages[0]).toMatchObject({
      status: 'changed',
      added: 0,
      removed: 0,
      changed: 1,
      lines: [
        {
          kind: 'changed',
          leftLine: 2,
          rightLine: 2,
          text: 'Beta beta delta',
          previous: 'Beta beta gamma',
          words: [
            { kind: 'removed', text: 'gamma' },
            { kind: 'added', text: 'delta' },
          ],
        },
      ],
    });
    expect(result.summary).toMatchObject({
      changedPages: 1,
      changedLines: 1,
      addedLines: 0,
      removedLines: 0,
    });
    expect(result.truncated).toBe(false);
  });

  it('pairs a hunk line by line, then reports the surplus lines as removed or added', async () => {
    const left = await build(linesOf(['one', 'two', 'three', 'four']));
    const right = await build(linesOf(['one', 'TWO', 'four', 'five', 'six']));
    const result = await compareText(left, right, run);
    const page = result.pages[0];
    expect(page).toMatchObject({
      status: 'changed',
      leftLines: 4,
      rightLines: 5,
      added: 2,
      removed: 1,
      changed: 1,
    });
    expect(page?.lines).toEqual([
      {
        kind: 'changed',
        leftLine: 2,
        rightLine: 2,
        text: 'TWO',
        previous: 'two',
        words: [
          { kind: 'removed', text: 'two' },
          { kind: 'added', text: 'TWO' },
        ],
      },
      { kind: 'removed', leftLine: 3, rightLine: null, text: 'three', words: null },
      { kind: 'added', leftLine: null, rightLine: 4, text: 'five', words: null },
      { kind: 'added', leftLine: null, rightLine: 5, text: 'six', words: null },
    ]);
    expect(result.summary).toMatchObject({ addedLines: 2, removedLines: 1, changedLines: 1 });
  });

  it('lists the changes in document order, an added line before the change that follows it', async () => {
    const left = await build(linesOf(['a', 'b', 'c']));
    const right = await build(linesOf(['a', 'new', 'b', 'C']));
    const result = await compareText(left, right, run);
    expect(
      result.pages[0]?.lines.map((line) => [line.kind, line.leftLine, line.rightLine, line.text]),
    ).toEqual([
      ['added', null, 2, 'new'],
      ['changed', 3, 4, 'C'],
    ]);
  });

  it('reports a page only the left document has as removed, never dropping it', async () => {
    const left = await build(linesOf(['kept'], ['gone one', 'gone two']));
    const right = await build(linesOf(['kept']));
    const result = await compareText(left, right, run);
    expect(result.pageCountDelta).toBe(-1);
    expect([result.leftPageCount, result.rightPageCount]).toEqual([2, 1]);
    expect(result.pages.map((page) => page.status)).toEqual(['identical', 'removed']);
    expect(result.pages[1]).toMatchObject({
      pageIndex: 1,
      leftLines: 2,
      rightLines: 0,
      removed: 2,
      added: 0,
      changed: 0,
      lines: [
        { kind: 'removed', leftLine: 1, rightLine: null, text: 'gone one' },
        { kind: 'removed', leftLine: 2, rightLine: null, text: 'gone two' },
      ],
    });
    expect(result.summary).toMatchObject({
      pagesCompared: 2,
      removedPages: 1,
      addedPages: 0,
      removedLines: 2,
    });
  });

  it('reports a page only the right document has as added', async () => {
    const left = await build(linesOf(['kept']));
    const right = await build(linesOf(['kept'], ['fresh page']));
    const result = await compareText(left, right, run);
    expect(result.pageCountDelta).toBe(1);
    expect(result.pages.map((page) => page.status)).toEqual(['identical', 'added']);
    expect(result.pages[1]).toMatchObject({
      leftLines: 0,
      rightLines: 1,
      added: 1,
      lines: [{ kind: 'added', leftLine: null, rightLine: 1, text: 'fresh page' }],
    });
    expect(result.summary).toMatchObject({ addedPages: 1, removedPages: 0, addedLines: 1 });
  });

  it('treats a document without pages as having no text, so every page of the other side is added or removed', async () => {
    const empty = await build([]);
    const one = await build(linesOf(['solo']));
    const both = await compareText(empty, empty, run);
    expect(both).toMatchObject({ leftPageCount: 0, rightPageCount: 0, pageCountDelta: 0, pages: [] });
    expect(both.summary.pagesCompared).toBe(0);
    const added = await compareText(empty, one, run);
    expect(added.pages).toMatchObject([
      { pageIndex: 0, status: 'added', leftLines: 0, rightLines: 1, added: 1 },
    ]);
    const removed = await compareText(one, empty, run);
    expect(removed.pages).toMatchObject([
      { pageIndex: 0, status: 'removed', leftLines: 1, rightLines: 0, removed: 1 },
    ]);
  });

  it('compares only the requested pages, sorted and without duplicates', async () => {
    const left = await build(linesOf(['a'], ['b'], ['c']));
    const right = await build(linesOf(['a'], ['B'], ['c']));
    const result = await compareText(left, right, run, { pages: [2, 0, 2] });
    expect(result.pages.map((page) => [page.pageIndex, page.status])).toEqual([
      [0, 'identical'],
      [2, 'identical'],
    ]);
    expect(result.summary.pagesCompared).toBe(2);
    const changed = await compareText(left, right, run, { pages: [1] });
    expect(changed.pages.map((page) => page.status)).toEqual(['changed']);
  });

  it.each([-1, 3, 1.5, Number.NaN])('refuses the page index %s with the index named', async (index) => {
    const bytes = await build(linesOf(['a'], ['b'], ['c']));
    await expect(compareText(bytes, bytes, run, { pages: [index] })).rejects.toMatchObject({
      code: 'range-invalid',
      details: { engine: 'model', pageIndex: index },
    });
  });

  it('cuts a middle block that exceeds the line matrix to one replaced block and says so', async () => {
    const left = await build(linesOf(['top', 'b', 'bottom']));
    const right = await build(linesOf(['top', 'x', 'y', 'bottom']));
    const result = await compareText(left, right, run, { limits: { maxLineMatrixCells: 4 } });
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(['line-matrix']);
    expect(result.pages[0]).toMatchObject({
      truncated: true,
      reasons: ['line-matrix'],
      changed: 1,
      added: 1,
      removed: 0,
    });
    // Within the default bound the same pair is an exact LCS: the same facts, no truncation.
    const exact = await compareText(left, right, run);
    expect(exact.truncated).toBe(false);
    expect(exact.pages[0]).toMatchObject({ truncated: false, reasons: [], changed: 1, added: 1 });
  });

  it('names a changed pair at line level only when its words exceed the word matrix', async () => {
    const left = await build(linesOf(['red green blue']));
    const right = await build(linesOf(['cyan magenta yellow']));
    const bounded = await compareText(left, right, run, { limits: { maxWordMatrixCells: 4 } });
    expect(bounded.pages[0]?.lines).toEqual([
      {
        kind: 'changed',
        leftLine: 1,
        rightLine: 1,
        text: 'cyan magenta yellow',
        previous: 'red green blue',
        words: null,
      },
    ]);
    expect(bounded.pages[0]).toMatchObject({ truncated: true, reasons: ['word-matrix'] });
    expect(bounded.truncationReasons).toEqual(['word-matrix']);
    expect(COMPARE_LIMITS.maxWordMatrixCells).toBeGreaterThan(16);
    const exact = await compareText(left, right, run);
    expect(exact.pages[0]?.lines[0]?.words).toHaveLength(6);
    expect(exact.truncated).toBe(false);
  });

  it('cuts the change list at maxReportedLines while the counters stay exact', async () => {
    const left = await build(linesOf(['a1', 'a2', 'a3'], ['same']));
    const right = await build(linesOf(['b1', 'b2', 'b3'], ['same']));
    const result = await compareText(left, right, run, { limits: { maxReportedLines: 2 } });
    const page = result.pages[0];
    expect(page?.changed).toBe(3);
    expect(page?.lines.map((line) => line.text)).toEqual(['b1', 'b2']);
    expect(page).toMatchObject({ truncated: true, reasons: ['line-list'] });
    expect(result.truncationReasons).toEqual(['line-list']);
    expect(result.summary.changedLines).toBe(3);
    expect(result.pages[1]?.truncated).toBe(false);
  });

  it('reports every progress step through the shared progress contract', async () => {
    const bytes = await build(linesOf(['a'], ['b']));
    const seen: OperationProgress[] = [];
    await compareText(bytes, bytes, { ...run, onProgress: (step) => seen.push(step) });
    const own = seen.filter((step) => step.total === 2 && step.labelKey === 'op.progress.textExport');
    expect(own.map((step) => step.done)).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(seen.at(-1)).toMatchObject({ phase: 'text', done: 2, total: 2 });
  });

  it('fails as aborted when the signal is already aborted', async () => {
    const bytes = await build(linesOf(['a']));
    const controller = new AbortController();
    controller.abort();
    await expect(compareText(bytes, bytes, { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
      details: { engine: 'model' },
    });
  });

  it.each([
    ['while the right document is extracted', 4],
    ['once the right document is extracted', 6],
    ['between two pages', 7],
  ])('fails as aborted when the user cancels %s', async (_name, step) => {
    const bytes = await build(linesOf(['a'], ['b']));
    const single = await build(linesOf(['a']));
    // Call 6 is the last report of the right extraction, which only a one-page pair reaches
    // before the next abort check; the others need two pages to have a "next page".
    const pair = step === 6 ? single : bytes;
    await expect(compareText(pair, pair, abortOnProgress(step))).rejects.toMatchObject({ code: 'aborted' });
  });

  it('fails as aborted once the left document is extracted', async () => {
    const single = await build(linesOf(['a']));
    // 1 = own start, 2-3 = the left export's start and page, so the abort lands after the left side.
    await expect(compareText(single, single, abortOnProgress(3))).rejects.toMatchObject({ code: 'aborted' });
  });

  it('fails as corrupt-document for bytes that are not a PDF', async () => {
    const good = await build(linesOf(['a']));
    const damaged = new TextEncoder().encode('this is not a pdf');
    await expect(compareText(damaged, good, run)).rejects.toMatchObject({ code: 'corrupt-document' });
    await expect(compareText(good, damaged, run)).rejects.toMatchObject({ code: 'corrupt-document' });
  });
});

/* ------------------------------------------------------------------ visual ----- */

interface Skia {
  createCanvas(width: number, height: number): CompareCanvas & { style?: object };
  Path2D: unknown;
}

const coreRequire = createRequire(new URL('../../package.json', import.meta.url));
const pdfjsRequire = createRequire(coreRequire.resolve('pdfjs-dist/package.json'));
const skia = pdfjsRequire('@napi-rs/canvas') as Skia;

/** A Skia canvas; the adapter writes `canvas.style`, which only a DOM element has. */
function skiaCanvas(): CompareCanvas {
  return Object.assign(skia.createCanvas(1, 1), { style: {} });
}

/**
 * A surface factory that counts the canvases and the `getContext` calls it served.
 * `onContext` sees the running call number and answers `false` to serve no context.
 */
function counting(onContext?: (calls: number) => boolean) {
  const state = { canvases: 0, contexts: 0 };
  const createCanvas = (): CompareCanvas => {
    state.canvases += 1;
    const canvas = skiaCanvas();
    const real = canvas.getContext.bind(canvas);
    return {
      get width() {
        return canvas.width;
      },
      set width(value: number) {
        canvas.width = value;
      },
      get height() {
        return canvas.height;
      },
      set height(value: number) {
        canvas.height = value;
      },
      style: (canvas as unknown as { style: object }).style,
      getContext(kind: '2d') {
        state.contexts += 1;
        return onContext?.(state.contexts) === false ? null : real(kind);
      },
    } as CompareCanvas;
  };
  return { state, createCanvas };
}

const BLACK_SQUARE = (x: number, y: number, size: number) => `0 0 0 rg ${x} ${y} ${size} ${size} re f`;

describe('compareVisual', () => {
  const globals = globalThis as unknown as { Path2D?: unknown };
  let previous: unknown;
  beforeAll(() => {
    // pdf.js draws paths with the DOM's `Path2D`, which Node lacks; Skia provides it.
    previous = globals.Path2D;
    globals.Path2D = skia.Path2D;
  });
  afterAll(() => {
    globals.Path2D = previous;
  });

  it('reports a page rendered twice as identical, with the raster sizes at the fixed DPI', async () => {
    const bytes = await build([{ draw: BLACK_SQUARE(40, 40, 200) }]);
    const { createCanvas } = counting();
    const result = await compareVisual(bytes, bytes.slice(), run, { createCanvas });
    expect(result.method).toBe('pixels');
    expect(result.dpi).toBe(COMPARE_DPI);
    expect(result.thresholdPercent).toBe(IDENTICAL_PERCENT);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      pageIndex: 0,
      status: 'identical',
      differencePercent: 0,
      differingPixels: 0,
      meanDifference: 0,
      differingTiles: 0,
      leftSize: { width: 222, height: 222 },
      rightSize: { width: 222, height: 222 },
      tiles: { columns: 4, rows: 4 },
      tileCount: 16,
      totalPixels: 55 * 55,
    });
    expect(result.pages[0]).not.toHaveProperty('reason');
    expect(result.summary).toEqual({
      pagesCompared: 1,
      identicalPages: 1,
      changedPages: 0,
      addedPages: 0,
      removedPages: 0,
      unavailablePages: 0,
      meanDifferencePercent: 0,
    });
    expect(result.truncated).toBe(false);
  });

  it('sees a block that moved: differing pixels in the tiles it left and the tiles it entered', async () => {
    const left = await build([{ draw: BLACK_SQUARE(20, 200, 100) }]);
    const right = await build([{ draw: BLACK_SQUARE(280, 200, 100) }]);
    const { createCanvas, state } = counting();
    const result = await compareVisual(left, right, run, { createCanvas });
    const page = result.pages[0];
    expect(page?.status).toBe('changed');
    expect(page?.differencePercent).toBeGreaterThan(IDENTICAL_PERCENT);
    expect(page?.differencePercent).toBeCloseTo(((page?.differingPixels ?? 0) / 3025) * 100, 10);
    // The two squares are 260 pt apart on a 400 pt page: they never share a 16-px tile
    // (64 pt), so two disjoint tile groups differ and the rest of the page does not.
    expect(page?.differingTiles).toBeGreaterThanOrEqual(2);
    expect(page?.differingTiles).toBeLessThan(page?.tileCount ?? 0);
    expect(page?.meanDifference).toBeGreaterThan(0);
    expect(result.summary).toMatchObject({ pagesCompared: 1, changedPages: 1, identicalPages: 0 });
    expect(result.summary.meanDifferencePercent).toBe(page?.differencePercent);
    expect(state.canvases).toBe(2);
  });

  it('counts a speck below the identical threshold but still calls the page identical', async () => {
    const left = await build([{}]);
    const right = await build([{ draw: BLACK_SQUARE(100, 100, 6) }]);
    const { createCanvas } = counting();
    const result = await compareVisual(left, right, run, { createCanvas });
    const page = result.pages[0];
    expect(page?.differingPixels).toBeGreaterThan(0);
    expect(page?.differencePercent).toBeGreaterThan(0);
    expect(page?.differencePercent).toBeLessThanOrEqual(IDENTICAL_PERCENT);
    expect(page?.status).toBe('identical');
    expect(result.summary.identicalPages).toBe(1);
  });

  it('compares the overlapping area of pages that differ in size and says so', async () => {
    const left = await build([{ size: [400, 400], draw: BLACK_SQUARE(20, 20, 100) }]);
    const right = await build([{ size: [400, 600], draw: BLACK_SQUARE(20, 20, 100) }]);
    const { createCanvas } = counting();
    const result = await compareVisual(left, right, run, { createCanvas });
    const page = result.pages[0];
    expect(page).toMatchObject({
      reason: 'page-size-mismatch',
      leftSize: { width: 222, height: 222 },
      rightSize: { width: 222, height: 333 },
      totalPixels: 55 * 55,
      tiles: { columns: 4, rows: 4 },
    });
    expect(page?.status).toBe('changed');
  });

  it('reports pages only one side has, with their size, and never compares them', async () => {
    const one = await build([{}]);
    const two = await build([{}, { size: [200, 300] }]);
    const { createCanvas, state } = counting();
    const added = await compareVisual(one, two, run, { createCanvas });
    expect(added.pageCountDelta).toBe(1);
    expect(added.pages[1]).toMatchObject({
      pageIndex: 1,
      status: 'added',
      leftSize: null,
      rightSize: { width: 111, height: 167 },
      totalPixels: 0,
      tileCount: 0,
      tiles: { columns: 0, rows: 0 },
    });
    expect(added.summary).toMatchObject({ pagesCompared: 1, addedPages: 1, removedPages: 0 });
    expect(state.canvases).toBe(2);

    const removed = await compareVisual(two, one, run, { createCanvas });
    expect(removed.pageCountDelta).toBe(-1);
    expect(removed.pages[1]).toMatchObject({
      status: 'removed',
      leftSize: { width: 111, height: 167 },
      rightSize: null,
    });
    expect(removed.summary).toMatchObject({ pagesCompared: 1, removedPages: 1, addedPages: 0 });
  });

  it('reports two documents without pages as nothing compared and a mean of zero', async () => {
    const empty = await build([]);
    const { createCanvas, state } = counting();
    const result = await compareVisual(empty, empty, run, { createCanvas });
    expect(result.pages).toEqual([]);
    expect(result.summary).toEqual({
      pagesCompared: 0,
      identicalPages: 0,
      changedPages: 0,
      addedPages: 0,
      removedPages: 0,
      unavailablePages: 0,
      meanDifferencePercent: 0,
    });
    expect(state.canvases).toBe(0);
  });

  it('does not compare a page over the raster cap and reports it unavailable and truncated', async () => {
    const bytes = await build([{ draw: BLACK_SQUARE(20, 20, 100) }]);
    const { createCanvas, state } = counting();
    const result = await compareVisual(bytes, bytes, run, { createCanvas, limits: { maxRasterPixels: 100 } });
    expect(state.canvases).toBe(0);
    expect(result.pages[0]).toMatchObject({
      status: 'unavailable',
      reason: 'page-too-large',
      leftSize: { width: 222, height: 222 },
      rightSize: { width: 222, height: 222 },
      totalPixels: 0,
    });
    expect(result.summary).toMatchObject({ pagesCompared: 0, unavailablePages: 1, meanDifferencePercent: 0 });
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(['raster-cap']);
  });

  it('reports the page unavailable when only one side is over the cap', async () => {
    const big = await build([{ size: [800, 800] }]);
    const small = await build([{ size: [100, 100] }]);
    const limits = { maxRasterPixels: 100_000 };
    const { createCanvas } = counting();
    const leftBig = await compareVisual(big, small, run, { createCanvas, limits });
    expect(leftBig.pages[0]).toMatchObject({
      status: 'unavailable',
      leftSize: { width: 444, height: 444 },
      rightSize: { width: 55, height: 55 },
    });
    const rightBig = await compareVisual(small, big, run, { createCanvas, limits });
    expect(rightBig.pages[0]).toMatchObject({
      status: 'unavailable',
      leftSize: { width: 55, height: 55 },
      rightSize: { width: 444, height: 444 },
    });
  });

  it('renders at the requested DPI and compares only the requested pages', async () => {
    const left = await build([{}, { draw: BLACK_SQUARE(20, 20, 100) }]);
    const right = await build([{}, {}]);
    const { createCanvas } = counting();
    const result = await compareVisual(left, right, run, { createCanvas, dpi: 72, pages: [1, 1] });
    expect(result.dpi).toBe(72);
    expect(result.pages.map((page) => page.pageIndex)).toEqual([1]);
    expect(result.pages[0]).toMatchObject({
      status: 'changed',
      leftSize: { width: 400, height: 400 },
      tiles: { columns: 7, rows: 7 },
    });
  });

  it.each([11.9, 96.1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the dpi %s', async (dpi) => {
    const bytes = await build([{}]);
    const { createCanvas } = counting();
    await expect(compareVisual(bytes, bytes, run, { createCanvas, dpi })).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engine: 'model' },
    });
  });

  it('refuses a page index outside either document', async () => {
    const bytes = await build([{}]);
    const { createCanvas } = counting();
    await expect(compareVisual(bytes, bytes, run, { createCanvas, pages: [1] })).rejects.toMatchObject({
      code: 'range-invalid',
      details: { pageIndex: 1 },
    });
  });

  it('fails as unsupported when the surface has no 2d context after rendering', async () => {
    const bytes = await build([{}]);
    // Learn how many `getContext` calls one render makes; the next call is the read-back.
    const probe = counting();
    await compareVisual(bytes, bytes, run, { createCanvas: probe.createCanvas, pages: [0] });
    const perPage = probe.state.contexts / 2;
    const noReadBack = counting((calls) => calls !== perPage);
    await expect(
      compareVisual(bytes, bytes, run, { createCanvas: noReadBack.createCanvas }),
    ).rejects.toMatchObject({ code: 'unsupported', details: { engine: 'model' } });
  });

  it('reports every page through the shared progress contract', async () => {
    const bytes = await build([{}, {}]);
    const { createCanvas } = counting();
    const seen: OperationProgress[] = [];
    await compareVisual(bytes, bytes, { ...run, onProgress: (step) => seen.push(step) }, { createCanvas });
    expect(seen).toEqual([
      { phase: 'render', labelKey: 'op.progress.compress.render', done: 1, total: 2 },
      { phase: 'render', labelKey: 'op.progress.compress.render', done: 2, total: 2 },
    ]);
  });

  it('fails as aborted for an aborted signal, and between pages when cancelled mid-run', async () => {
    const bytes = await build([{}, {}]);
    const { createCanvas } = counting();
    const controller = new AbortController();
    controller.abort();
    await expect(
      compareVisual(bytes, bytes, { signal: controller.signal }, { createCanvas }),
    ).rejects.toMatchObject({ code: 'aborted' });
    await expect(compareVisual(bytes, bytes, abortOnProgress(1), { createCanvas })).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('fails as aborted when the user cancels right after the left page was rasterised', async () => {
    const bytes = await build([{}]);
    const probe = counting();
    await compareVisual(bytes, bytes, run, { createCanvas: probe.createCanvas });
    const perPage = probe.state.contexts / 2;
    const controller = new AbortController();
    const cancelling = counting((calls) => {
      if (calls === perPage) controller.abort();
      return true;
    });
    await expect(
      compareVisual(bytes, bytes, { signal: controller.signal }, { createCanvas: cancelling.createCanvas }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(cancelling.state.canvases).toBe(1);
  });

  it('maps a damaged document to corrupt-document and releases the other one', async () => {
    const good = await build([{}]);
    const damaged = new TextEncoder().encode('this is not a pdf');
    const { createCanvas } = counting();
    await expect(compareVisual(damaged, good, run, { createCanvas })).rejects.toMatchObject({
      code: 'corrupt-document',
    });
    await expect(compareVisual(good, damaged, run, { createCanvas })).rejects.toMatchObject({
      code: 'corrupt-document',
    });
  });
});
