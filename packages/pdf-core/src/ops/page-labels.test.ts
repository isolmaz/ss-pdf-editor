/**
 * Page labels against real bytes: what is written is read back by pdf.js (the reader that
 * renders labels) and the pure `formatLabel` agrees with it for every style.
 */

import { PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import {
  formatLabel,
  type PageLabelRange,
  type PageLabelStyle,
  readPageLabels,
  writePageLabels,
} from './page-labels';

const run = { signal: new AbortController().signal };

async function pages(count: number): Promise<Uint8Array> {
  const doc = new PDFDocument();
  for (let index = 0; index < count; index += 1) {
    doc.insertPage(index, doc.addPage([0, 0, 200, 200], 0, {}, ''));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function range(startPage: number, style: PageLabelStyle, prefix = '', start = 1): PageLabelRange {
  return { startPage, style, prefix, start };
}

async function failureOf(task: Promise<unknown>): Promise<ToolError> {
  try {
    await task;
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

describe('formatLabel', () => {
  it('renders every style the way pdf.js does, from the range start', () => {
    expect(formatLabel('none', 'X', 5, 3)).toBe('X');
    expect(formatLabel('decimal', 'p-', 2, 3)).toBe('p-5');
    expect(formatLabel('roman-upper', '', 3, 1)).toBe('IV');
    expect(formatLabel('roman-lower', '', 3, 1)).toBe('iv');
    expect(formatLabel('roman-upper', '', 0, 3999)).toBe('MMMCMXCIX');
    expect(formatLabel('alpha-upper', '', 25, 1)).toBe('Z');
    expect(formatLabel('alpha-upper', '', 26, 1)).toBe('AA');
    expect(formatLabel('alpha-lower', 'a', 51, 1)).toBe('azz');
  });

  it('clamps a value below 1 to 1 and reads a non-finite start or index as the defaults', () => {
    expect(formatLabel('decimal', '', -10, 1)).toBe('1');
    expect(formatLabel('decimal', '', 0, Number.NaN)).toBe('1');
    expect(formatLabel('decimal', '', Number.POSITIVE_INFINITY, 4)).toBe('4');
    expect(formatLabel('decimal', '', 1.9, 2.9)).toBe('3');
  });
});

describe('writePageLabels / readPageLabels', () => {
  it('writes ranges in page order and the reader renders them page by page', async () => {
    const bytes = await pages(6);
    const outcome = await writePageLabels(
      bytes,
      [range(3, 'decimal', 'B-', 7), range(0, 'roman-lower'), range(5, 'alpha-upper', '', 2)],
      run,
    );
    expect(await readPageLabels(outcome.bytes, 6)).toEqual(['i', 'ii', 'iii', 'B-7', 'B-8', 'B']);
    expect(outcome.report.engine).toBe('mupdf');
    expect(outcome.report.pageCount).toBe(6);
    expect(outcome.report.incremental).toBe(false);
    expect(outcome.report.steps).toEqual(['load', 'labels', 'save']);
    expect(outcome.report.notes.map((entry) => entry.kind)).toEqual(['changed', 'lost', 'preserved']);
    expect(outcome.report.notes[0]?.params).toEqual({ count: 3 });
  });

  it('writes none and alpha-lower styles', async () => {
    const bytes = await pages(3);
    const outcome = await writePageLabels(
      bytes,
      [range(0, 'none', 'Cover'), range(1, 'alpha-lower', '', 1)],
      run,
    );
    expect(await readPageLabels(outcome.bytes, 3)).toEqual(['Cover', 'a', 'b']);
  });

  it('replaces the previous plan instead of leaving an older rule behind', async () => {
    const first = await writePageLabels(
      await pages(4),
      [range(0, 'roman-upper'), range(2, 'decimal', 'x')],
      run,
    );
    const second = await writePageLabels(first.bytes, [range(0, 'decimal')], run);
    expect(await readPageLabels(second.bytes, 4)).toEqual(['1', '2', '3', '4']);
  });

  it('reports progress per page while the old plan is cleared', async () => {
    const seen: number[] = [];
    await writePageLabels(await pages(3), [range(0, 'decimal')], {
      signal: run.signal,
      onProgress: (progress) => {
        if (progress.done !== undefined) seen.push(progress.done);
      },
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('reads a document without a label tree as an empty list', async () => {
    expect(await readPageLabels(await pages(2), 2)).toEqual([]);
  });

  it('bounds the labels to the page count, and reads all of them for a count of 0', async () => {
    const labelled = (await writePageLabels(await pages(4), [range(0, 'decimal')], run)).bytes;
    expect(await readPageLabels(labelled, 2)).toEqual(['1', '2']);
    expect(await readPageLabels(labelled, 99)).toEqual(['1', '2', '3', '4']);
    expect(await readPageLabels(labelled, 0)).toEqual(['1', '2', '3', '4']);
  });

  it('refuses to read with a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failureOf(readPageLabels(await pages(1), 1, controller.signal));
    expect(error.code).toBe('aborted');
  });

  it('reads with a live signal', async () => {
    const labelled = (await writePageLabels(await pages(2), [range(0, 'roman-upper')], run)).bytes;
    expect(await readPageLabels(labelled, 2, new AbortController().signal)).toEqual(['I', 'II']);
  });

  it('refuses an empty plan', async () => {
    const error = await failureOf(writePageLabels(await pages(2), [], run));
    expect(error.code).toBe('selection-empty');
  });

  it('refuses a range that starts outside the document, negative or fractional', async () => {
    const bytes = await pages(2);
    for (const startPage of [2, -1, 0.5]) {
      const error = await failureOf(writePageLabels(bytes, [range(startPage, 'decimal')], run));
      expect(error.code).toBe('range-invalid');
    }
  });

  it('refuses two ranges that start on the same page', async () => {
    const error = await failureOf(
      writePageLabels(await pages(3), [range(1, 'decimal'), range(1, 'roman-upper')], run),
    );
    expect(error.code).toBe('range-invalid');
    expect(error.details.pageIndex).toBe(1);
  });

  it('refuses a start value that is not a positive integer', async () => {
    const bytes = await pages(2);
    for (const start of [0, 1.5, Number.NaN]) {
      const error = await failureOf(writePageLabels(bytes, [range(0, 'decimal', '', start)], run));
      expect(error.code).toBe('value-out-of-range');
    }
  });

  it('stops with an abort error before loading and while clearing the old plan', async () => {
    const bytes = await pages(3);
    const before = new AbortController();
    before.abort();
    await expect(
      writePageLabels(bytes, [range(0, 'decimal')], { signal: before.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });

    const during = new AbortController();
    const clearing = await failureOf(
      writePageLabels(bytes, [range(0, 'decimal')], {
        signal: during.signal,
        onProgress: () => during.abort(),
      }),
    );
    expect(clearing.code).toBe('aborted');
  });

  it('maps an engine failure on damaged bytes to a tool error', async () => {
    const error = await failureOf(writePageLabels(new Uint8Array([1, 2, 3]), [range(0, 'decimal')], run));
    expect(error.code).not.toBe('aborted');
  });
});
