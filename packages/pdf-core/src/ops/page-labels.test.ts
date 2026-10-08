/**
 * Page labels against real bytes: what is written is read back by pdf.js (the reader that
 * renders labels) and the pure `formatLabel` agrees with it for every style.
 */

import { PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it, vi } from 'vitest';
import {
  composedLabelRanges,
  composeLabelRanges,
  formatLabel,
  type LabelPlacement,
  type PageLabelRange,
  type PageLabelStyle,
  readLabelRanges,
  readPageLabels,
  replaceLabelRanges,
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

/** A document of `count` pages that `build` may give a /PageLabels tree. */
function labelledDocument(count: number, build: (doc: PDFDocument) => void): PDFDocument {
  const doc = new PDFDocument();
  for (let index = 0; index < count; index += 1) {
    doc.insertPage(index, doc.addPage([0, 0, 200, 200], 0, {}, ''));
  }
  build(doc);
  return doc;
}

/** The ranges `readLabelRanges` finds in a document `build` labelled, and nothing else. */
function rangesOf(build: (doc: PDFDocument) => void, count = 8): readonly PageLabelRange[] {
  const doc = labelledDocument(count, build);
  try {
    return readLabelRanges(doc);
  } finally {
    doc.destroy();
  }
}

describe('readLabelRanges', () => {
  it('reads every style, prefix and start a plan can carry, in page order', () => {
    const ranges = rangesOf((doc) => {
      doc.setPageLabels(5, PDFDocument.PAGE_LABEL_ALPHA_LC);
      doc.setPageLabels(0, PDFDocument.PAGE_LABEL_ROMAN_LC);
      doc.setPageLabels(2, PDFDocument.PAGE_LABEL_DECIMAL, 'p-', 7);
      doc.setPageLabels(3, PDFDocument.PAGE_LABEL_ALPHA_UC, 'Ek-', 3);
      doc.setPageLabels(4, PDFDocument.PAGE_LABEL_ROMAN_UC);
      doc.setPageLabels(6, PDFDocument.PAGE_LABEL_NONE, 'Kapak');
    });
    expect(ranges).toEqual([
      range(0, 'roman-lower'),
      range(2, 'decimal', 'p-', 7),
      range(3, 'alpha-upper', 'Ek-', 3),
      range(4, 'roman-upper'),
      range(5, 'alpha-lower'),
      range(6, 'none', 'Kapak'),
    ]);
  });

  it('reads a document without a plan as having none', () => {
    expect(rangesOf(() => undefined)).toEqual([]);
    expect(rangesOf((doc) => doc.getTrailer().get('Root').put('PageLabels', 7))).toEqual([]);
  });

  it('reads what it can from entries that are not well formed', () => {
    const ranges = rangesOf((doc) => {
      const labelled = doc.addObject({ S: 'R', P: doc.newString('Z-'), St: 4 });
      doc
        .getTrailer()
        .get('Root')
        .put(
          'PageLabels',
          doc.addObject({
            Nums: [
              // not a page index, a negative page index, a label that is not a dictionary
              doc.newName('x'),
              { S: 'D' },
              -1,
              { S: 'D' },
              3,
              7,
              // a style letter nobody knows, and a start that is below 1
              4,
              { S: 'Z', St: 0 },
              // a start with a fraction, a start that is no number, a label behind a reference
              5,
              { S: 'D', St: 2.9 },
              6,
              { S: 'D', St: doc.newName('x') },
              7,
              labelled,
              // two labels for page 2: the later one stands; a last key without a label
              2,
              { S: 'D' },
              2,
              { S: 'A' },
              9,
            ],
          }),
        );
    });
    expect(ranges).toEqual([
      range(2, 'alpha-upper'),
      range(4, 'none'),
      range(5, 'decimal', '', 2),
      range(6, 'decimal'),
      range(7, 'roman-upper', 'Z-', 4),
    ]);
  });

  it('follows kids, reads a node reachable twice once, and ends at a cycle and at a depth no tree has', () => {
    const ranges = rangesOf((doc) => {
      const leaf = doc.addObject({ Nums: [3, { S: 'D' }, 4, { S: 'r' }] });
      leaf.put('Kids', [leaf, 5, { Nums: [6, { S: 'A' }] }]);
      let deep: unknown = { Nums: [7, { S: 'D' }] };
      for (let level = 0; level < 40; level += 1) deep = { Kids: [deep] };
      doc
        .getTrailer()
        .get('Root')
        .put(
          'PageLabels',
          doc.addObject({
            Kids: [doc.addObject({ Nums: [0, { S: 'R' }] }), leaf, leaf, deep],
          }),
        );
    });
    expect(ranges).toEqual([
      range(0, 'roman-upper'),
      range(3, 'decimal'),
      range(4, 'roman-lower'),
      range(6, 'alpha-upper'),
    ]);
  });
});

describe('composeLabelRanges', () => {
  /** The pages of source `source` in output order starting at `from`, taking `pages` of it. */
  const place = (source: number, from: number, pages: readonly number[]): LabelPlacement[] =>
    pages.map((page, index) => ({ source, page, position: from + index }));
  const frontMatter = [range(0, 'roman-lower'), range(2, 'decimal')];

  it('writes nothing when no source that contributes a page has a plan', () => {
    expect(composeLabelRanges([[], []], [...place(0, 0, [0, 1]), ...place(1, 2, [0])])).toEqual([]);
    expect(composeLabelRanges([[], frontMatter], place(0, 0, [0, 1]))).toEqual([]);
  });

  it('keeps every page of the first document and gives an inserted page its own number', () => {
    const placements = [...place(1, 0, [0]), ...place(0, 1, [0, 1, 2, 3])];
    expect(composeLabelRanges([frontMatter, []], placements)).toEqual([
      range(0, 'decimal'),
      range(1, 'roman-lower'),
      range(3, 'decimal'),
    ]);
  });

  it('splits a range around an insertion and resumes its counting behind it', () => {
    const placements = [...place(0, 0, [0, 1]), ...place(1, 2, [0]), ...place(0, 3, [2, 3])];
    expect(composeLabelRanges([[range(0, 'decimal')], []], placements)).toEqual([
      range(0, 'decimal'),
      range(2, 'decimal'),
      range(3, 'decimal', '', 3),
    ]);
  });

  it('does not split a range that continues across documents, and does not depend on the order given', () => {
    const placements = [...place(1, 2, [2]), ...place(0, 0, [0, 1])];
    expect(composeLabelRanges([[range(0, 'decimal')], []], placements)).toEqual([range(0, 'decimal')]);
  });

  it('starts a range where only the prefix changes, and counts nothing in an unnumbered one', () => {
    const base = [range(0, 'decimal', 'A-', 4), range(2, 'none', 'Kapak', 9)];
    expect(composeLabelRanges([base], place(0, 0, [0, 1, 2, 3]))).toEqual([
      range(0, 'decimal', 'A-', 4),
      range(2, 'none', 'Kapak'),
    ]);
    expect(
      composeLabelRanges(
        [[range(0, 'decimal', 'A-', 4)], [range(0, 'decimal', 'B-', 5)]],
        [...place(0, 0, [0]), ...place(1, 1, [0])],
      ),
    ).toEqual([range(0, 'decimal', 'A-', 4), range(1, 'decimal', 'B-', 5)]);
  });

  it('gives a page in front of the first range the empty label a reader shows there', () => {
    expect(composeLabelRanges([[range(1, 'decimal')]], place(0, 0, [0, 1, 2]))).toEqual([
      range(0, 'none'),
      range(1, 'decimal'),
    ]);
  });
});

describe('replaceLabelRanges', () => {
  it('makes the ranges the whole plan, clearing the rules it does not name', async () => {
    const mupdf = await import('mupdf');
    const doc = labelledDocument(5, (document) => {
      document.setPageLabels(0, PDFDocument.PAGE_LABEL_ROMAN_LC);
      document.setPageLabels(3, PDFDocument.PAGE_LABEL_ALPHA_UC);
    });
    try {
      replaceLabelRanges(mupdf, doc, [range(0, 'decimal', 'p-', 2), range(2, 'roman-upper')]);
      expect(readLabelRanges(doc)).toEqual([range(0, 'decimal', 'p-', 2), range(2, 'roman-upper')]);
    } finally {
      doc.destroy();
    }
  });
});

describe('composedLabelRanges', () => {
  const labelled = async (rules: readonly (readonly [number, string])[]) => {
    const doc = labelledDocument(3, (document) => {
      for (const [page, style] of rules) document.setPageLabels(page, style);
    });
    try {
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    } finally {
      doc.destroy();
    }
  };

  it('reads the labels of every source and plans the composition from them', async () => {
    const planned = await composedLabelRanges(
      [await pages(2), await labelled([[0, 'R']])],
      [
        { source: 1, page: 2, position: 0 },
        { source: 0, page: 0, position: 1 },
        { source: 0, page: 1, position: 2 },
      ],
      run,
      'test',
    );
    expect(planned).toEqual([range(0, 'roman-upper', '', 3), range(1, 'decimal')]);
  });

  it('stops at an aborted signal', async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      composedLabelRanges(
        [await pages(1)],
        [{ source: 0, page: 0, position: 0 }],
        { signal: before.signal },
        'test',
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('maps an engine failure while a source is read, naming the step', async () => {
    const bytes = await pages(1);
    const trap = vi.spyOn(PDFDocument.prototype, 'getTrailer').mockImplementation(() => {
      throw new Error('trailer is damaged');
    });
    try {
      const error = await failureOf(
        composedLabelRanges([bytes], [{ source: 0, page: 0, position: 0 }], run, 'insertPages.labels'),
      );
      expect(error.details.engineMessage).toBe('insertPages.labels: trailer is damaged');
    } finally {
      trap.mockRestore();
    }
  });
});
