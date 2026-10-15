/**
 * Splitting against real bytes: every produced part is re-read by MuPDF, and a page is
 * recognised by its MediaBox width, so a part with the wrong pages cannot pass.
 */

import { PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it, vi } from 'vitest';
import type * as Compose from './compose';
import { planSplit, type SplitOptions, splitDocument } from './split';

/** How many parts the engine was asked to produce — a part that is produced again counts again. */
const productions = vi.hoisted(() => ({ count: 0 }));

vi.mock('./compose', async (importOriginal) => {
  const actual = await importOriginal<typeof Compose>();
  return {
    ...actual,
    composeDocument: (...args: Parameters<typeof Compose.composeDocument>) => {
      productions.count += 1;
      return actual.composeDocument(...args);
    },
  };
});

const run = { signal: new AbortController().signal };

/** Pages told apart by their width: page `n` is `100 + n` wide. */
function pages(count: number, noise = 0): Uint8Array {
  const doc = new PDFDocument();
  for (let index = 0; index < count; index += 1) {
    const content = noise > 0 ? `0 0 m ${'1 1 l '.repeat(noise)}S` : '';
    doc.insertPage(index, doc.addPage([0, 0, 100 + index, 200], 0, {}, content));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Page content of about `ops * 9` bytes that does not shrink under compression. */
function heavyContent(ops: number, seed: number): string {
  let state = seed;
  const numbers = Array.from({ length: ops }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return `${state % 1000} ${(state >>> 12) % 1000} l`;
  });
  return `0 0 m ${numbers.join(' ')} S`;
}

/** `count` pages, page `n` `100 + n` wide, carrying `opsOf(n)` path operators (0 = an empty page). */
function weighedPages(count: number, opsOf: (index: number) => number): Uint8Array {
  const doc = new PDFDocument();
  for (let index = 0; index < count; index += 1) {
    const ops = opsOf(index);
    const content = ops === 0 ? '' : heavyContent(ops, 5 + index);
    doc.insertPage(index, doc.addPage([0, 0, 100 + index, 200], 0, {}, content));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function widths(bytes: Uint8Array): number[] {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return Array.from({ length: doc.countPages() }, (_unused, index) => {
      const bounds = doc.loadPage(index).getBounds();
      return Math.round(bounds[2] - bounds[0]);
    });
  } finally {
    doc.destroy();
  }
}

function failureOf(task: () => unknown): ToolError {
  try {
    task();
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

async function asyncFailureOf(task: Promise<unknown>): Promise<ToolError> {
  try {
    await task;
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

const base = { baseName: 'doc', pageCount: 5 } as const;

describe('planSplit', () => {
  it('plans one part per entered range, in the order written', () => {
    const plan = planSplit({ ...base, mode: 'ranges', ranges: '4-5, 1;2\n3' });
    expect(plan.parts).toEqual([[3, 4], [0], [1], [2]]);
    expect(plan.names).toHaveLength(4);
  });

  it('cuts at whitespace like at a comma, and keeps spaces around a dash inside the range', () => {
    expect(planSplit({ ...base, mode: 'ranges', ranges: '1 3' }).parts).toEqual([[0], [2]]);
    expect(planSplit({ ...base, mode: 'ranges', ranges: '1-2 5' }).parts).toEqual([[0, 1], [4]]);
    expect(planSplit({ ...base, mode: 'ranges', ranges: '1 - 2  4 -' }).parts).toEqual([
      [0, 1],
      [3, 4],
    ]);
    // A line break always ends a part, even right after a dash.
    expect(planSplit({ ...base, mode: 'ranges', ranges: '4 -\n1' }).parts).toEqual([[3, 4], [0]]);
  });

  it('plans every N pages with a short last part', () => {
    expect(planSplit({ ...base, mode: 'everyN', chunkSize: 2 }).parts).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('plans booklet signatures of four pages unless told otherwise', () => {
    expect(planSplit({ ...base, mode: 'booklet' }).parts).toEqual([[0, 1, 2, 3], [4]]);
    expect(planSplit({ ...base, mode: 'booklet', chunkSize: 3 }).parts).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
  });

  it('plans by size from the page-count proportion, at least one page per part', () => {
    expect(planSplit({ ...base, mode: 'size', maxBytes: 250, totalBytes: 500 }).parts).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
    expect(planSplit({ ...base, mode: 'size', maxBytes: 10, totalBytes: 500 }).parts).toEqual([
      [0],
      [1],
      [2],
      [3],
      [4],
    ]);
  });

  it('refuses an empty range entry', () => {
    expect(failureOf(() => planSplit({ ...base, mode: 'ranges' })).code).toBe('selection-empty');
    expect(failureOf(() => planSplit({ ...base, mode: 'ranges', ranges: '   ' })).code).toBe(
      'selection-empty',
    );
  });

  it('refuses a range outside the document', () => {
    expect(failureOf(() => planSplit({ ...base, mode: 'ranges', ranges: '1-9' })).code).toBe('range-invalid');
  });

  it('refuses a page count that is not a whole number, and a document without pages', () => {
    for (const pageCount of [-1, 2.5, Number.NaN]) {
      expect(
        failureOf(() => planSplit({ mode: 'everyN', baseName: 'doc', pageCount, chunkSize: 1 })).code,
      ).toBe('range-invalid');
    }
    expect(
      failureOf(() => planSplit({ mode: 'everyN', baseName: 'doc', pageCount: 0, chunkSize: 1 })).code,
    ).toBe('selection-empty');
  });

  it('refuses every-N without a part size and a part size that is not a positive whole number', () => {
    expect(failureOf(() => planSplit({ ...base, mode: 'everyN' })).code).toBe('range-invalid');
    for (const chunkSize of [0, 1.5, -2, Number.NaN]) {
      expect(failureOf(() => planSplit({ ...base, mode: 'everyN', chunkSize })).code).toBe('range-invalid');
    }
  });

  it('refuses size mode without a usable limit, and without the document size', () => {
    for (const maxBytes of [undefined, 0, -1, Number.POSITIVE_INFINITY]) {
      const options: SplitOptions = {
        ...base,
        mode: 'size',
        totalBytes: 500,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      };
      expect(failureOf(() => planSplit(options)).code).toBe('range-invalid');
    }
    for (const totalBytes of [undefined, 0, -5, Number.NaN]) {
      const options: SplitOptions = {
        ...base,
        mode: 'size',
        maxBytes: 100,
        ...(totalBytes === undefined ? {} : { totalBytes }),
      };
      expect(failureOf(() => planSplit(options)).code).toBe('internal');
    }
  });
});

describe('splitDocument', () => {
  it('produces one PDF per range with exactly the requested pages', async () => {
    const result = await splitDocument(pages(5), { ...base, mode: 'ranges', ranges: '2-3, 5' }, run);
    expect(result.files.map((file) => widths(file.bytes))).toEqual([[101, 102], [104]]);
    expect(result.files.every((file) => file.mime === 'application/pdf')).toBe(true);
    expect(result.plan.parts).toEqual([[1, 2], [4]]);
    expect(result.files.map((file) => file.name)).toEqual(result.plan.names);
  });

  it('splits every N pages and reports progress per part', async () => {
    const progress: Array<[number | undefined, number | undefined]> = [];
    const result = await splitDocument(
      pages(5),
      { ...base, mode: 'everyN', chunkSize: 2 },
      {
        signal: run.signal,
        onProgress: (entry) => {
          if (entry.phase === 'part') progress.push([entry.done, entry.total]);
        },
      },
    );
    expect(result.files.map((file) => widths(file.bytes))).toEqual([[100, 101], [102, 103], [104]]);
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
  });

  it('splits booklet signatures', async () => {
    const result = await splitDocument(pages(5), { ...base, mode: 'booklet' }, run);
    expect(result.files.map((file) => widths(file.bytes))).toEqual([[100, 101, 102, 103], [104]]);
  });

  it('in size mode keeps every part under the limit and corrects an oversized estimate from its measured size', async () => {
    // Pages of very different weight: the first two are heavy (incompressible numbers), the
    // rest are empty, so the proportional estimate (two pages) is wrong for the first part
    // and has to be corrected down to one page.
    const doc = new PDFDocument();
    let seed = 7;
    const heavy = `0 0 m ${Array.from({ length: 4000 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return `${seed % 1000} ${(seed >> 8) % 1000} l`;
    }).join(' ')} S`;
    for (let index = 0; index < 5; index += 1) {
      doc.insertPage(index, doc.addPage([0, 0, 100 + index, 200], 0, {}, index < 2 ? heavy : ''));
    }
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    // The limit sits halfway between the real size of one heavy page and of the two together
    // (kilobytes apart: the same pages are not always produced at the same byte count, so a
    // limit one byte under the pair was a coin toss on CI), and the size estimate is told the
    // average page weighs 2/5 of the limit: two pages are estimated, produced, found too big,
    // and produced again as one.
    const sizeOf = async (chunkSize: number) =>
      (await splitDocument(bytes, { ...base, mode: 'everyN', chunkSize }, run)).files[0]?.bytes.length ?? 0;
    const [alone, together] = [await sizeOf(1), await sizeOf(2)];
    expect(together - alone).toBeGreaterThan(4000);
    const maxBytes = Math.floor((alone + together) / 2);
    const progress: Array<number | undefined> = [];
    const result = await splitDocument(
      bytes,
      { ...base, mode: 'size', maxBytes, totalBytes: maxBytes * 2 },
      {
        signal: run.signal,
        onProgress: (entry) => {
          if (entry.phase === 'part') progress.push(entry.done);
        },
      },
    );
    const all = result.files.flatMap((file) => widths(file.bytes));
    expect(all).toEqual([100, 101, 102, 103, 104]);
    expect(result.plan.parts.flat()).toEqual([0, 1, 2, 3, 4]);
    for (const [index, file] of result.files.entries()) {
      // A part is only over the limit when it is a single page that cannot be cut.
      if (file.bytes.length > maxBytes) expect(result.plan.parts[index]).toHaveLength(1);
    }
    expect(result.plan.parts[0]).toEqual([0]);
    expect(progress).toEqual(result.files.map((_file, index) => index + 1));
  });

  it('in size mode produces a page that is bigger than the limit on its own', async () => {
    const bytes = pages(2, 3000);
    const result = await splitDocument(
      bytes,
      { ...base, pageCount: 2, mode: 'size', maxBytes: 1, totalBytes: bytes.length },
      run,
    );
    expect(result.files.map((file) => widths(file.bytes))).toEqual([[100], [101]]);
    // Both parts break the limit and the result says so: a page cannot be cut.
    expect(result.oversizedPages).toEqual([0, 1]);
  });

  it('in size mode names only the pages that are over the limit on their own', async () => {
    // Page 2 is heavy (about 36 KB), the rest are empty.
    const bytes = weighedPages(5, (index) => (index === 2 ? 4000 : 0));
    const lightPair =
      (await splitDocument(bytes, { ...base, mode: 'everyN', chunkSize: 2 }, run)).files[0]?.bytes.length ??
      0;
    const maxBytes = lightPair + 2000;
    const result = await splitDocument(
      bytes,
      { ...base, mode: 'size', maxBytes, totalBytes: bytes.length },
      run,
    );
    expect(result.oversizedPages).toEqual([2]);
    expect(result.plan.parts.flat()).toEqual([0, 1, 2, 3, 4]);
    const heavyPart = result.plan.parts.findIndex((part) => part.includes(2));
    expect(result.plan.parts[heavyPart]).toEqual([2]);
    for (const [index, file] of result.files.entries()) {
      if (index === heavyPart) expect(file.bytes.length).toBeGreaterThan(maxBytes);
      else expect(file.bytes.length).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('in size mode leaves nothing to report when every part fits', async () => {
    const bytes = pages(5);
    const result = await splitDocument(
      bytes,
      { ...base, mode: 'size', maxBytes: bytes.length * 2, totalBytes: bytes.length },
      run,
    );
    expect(result.plan.parts).toEqual([[0, 1, 2, 3, 4]]);
    expect(result.oversizedPages).toEqual([]);
  });

  it('in size mode corrects an estimate that is far too large in a logarithmic number of productions', async () => {
    const bytes = weighedPages(20, () => 200);
    const options = { baseName: 'doc', pageCount: 20 } as const;
    // One part of the first `count` pages — a single production each, so the measurement stays cheap.
    const sizeOf = async (count: number) =>
      (await splitDocument(bytes, { ...options, mode: 'ranges', ranges: `1-${count}` }, run)).files[0]?.bytes
        .length ?? 0;
    const [four, five] = [await sizeOf(4), await sizeOf(5)];
    expect(five - four).toBeGreaterThan(500);
    // Exactly four pages fit: the limit sits halfway between four pages and five.
    const maxBytes = Math.floor((four + five) / 2);

    productions.count = 0;
    // Told that a page weighs a single byte, the first estimate is the whole document. Taking
    // one page off per production would need 17 of them for the first part alone (21 in all).
    const result = await splitDocument(bytes, { ...options, mode: 'size', maxBytes, totalBytes: 20 }, run);
    expect(result.plan.parts.map((part) => part.length)).toEqual([4, 4, 4, 4, 4]);
    expect(result.plan.parts.flat()).toEqual(Array.from({ length: 20 }, (_unused, page) => page));
    expect(result.oversizedPages).toEqual([]);
    // 1 estimate + 1 proportional correction + at most log2(19) bisections for the first part,
    // then one production for each of the four parts after it.
    expect(productions.count).toBeLessThanOrEqual(12);
  }, 60_000);

  it('refuses invalid options before opening the document', async () => {
    expect(
      (
        await asyncFailureOf(
          splitDocument(pages(2), { ...base, pageCount: 0, mode: 'everyN', chunkSize: 1 }, run),
        )
      ).code,
    ).toBe('selection-empty');
    expect(
      (
        await asyncFailureOf(
          splitDocument(pages(2), { ...base, pageCount: -1, mode: 'everyN', chunkSize: 1 }, run),
        )
      ).code,
    ).toBe('range-invalid');
  });

  it('stops with an abort error before starting and between parts', async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      splitDocument(
        pages(3),
        { ...base, pageCount: 3, mode: 'everyN', chunkSize: 1 },
        { signal: before.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const between = new AbortController();
    await expect(
      splitDocument(
        pages(3),
        { ...base, pageCount: 3, mode: 'everyN', chunkSize: 1 },
        { signal: between.signal, onProgress: () => between.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops between parts in size mode', async () => {
    const bytes = pages(3);
    const controller = new AbortController();
    await expect(
      splitDocument(
        bytes,
        { ...base, pageCount: 3, mode: 'size', maxBytes: 1, totalBytes: bytes.length },
        { signal: controller.signal, onProgress: () => controller.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
