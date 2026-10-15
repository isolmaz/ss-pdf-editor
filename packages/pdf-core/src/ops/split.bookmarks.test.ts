/**
 * Splitting at the bookmarks of the outline: the plan, the name of every part, and the real
 * outline of a real file read back through pdf.js. A page is recognised by its MediaBox width.
 */

import { PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { applyOutlineEdit, type OutlineNodeInput } from './outline-edit';
import { flattenOutline, planSplit, readSplitBookmarks, type SplitOptions, splitDocument } from './split';

const run = { signal: new AbortController().signal };

/** `count` pages, page `n` `100 + n` wide, with the outline given (page indices are 0-based). */
async function book(count: number, outline: readonly OutlineNodeInput[]): Promise<Uint8Array> {
  const doc = new PDFDocument();
  for (let index = 0; index < count; index += 1) {
    doc.insertPage(index, doc.addPage([0, 0, 100 + index, 200], 0, {}, ''));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  if (outline.length === 0) return bytes;
  return (await applyOutlineEdit(bytes, { kind: 'replace-all', nodes: outline }, run)).bytes;
}

const node = (
  title: string,
  pageIndex: number | null,
  children: OutlineNodeInput[] = [],
): OutlineNodeInput => ({
  title,
  destination: pageIndex === null ? null : { pageIndex },
  children,
});

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

const plan = (options: Partial<SplitOptions>) =>
  planSplit({ mode: 'bookmarks', baseName: 'doc.pdf', pageCount: 6, leadTitle: 'Beginning', ...options });

describe('planSplit by bookmarks', () => {
  it('cuts at every bookmark, puts the pages before the first one in a part of their own and names the parts', () => {
    const result = plan({
      bookmarks: [
        { title: 'Chapter 2', pageIndex: 4 },
        { title: 'Chapter 1', pageIndex: 2 },
      ],
    });
    expect(result.parts).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    expect(result.names).toEqual(['doc-1-Beginning.pdf', 'doc-2-Chapter 1.pdf', 'doc-3-Chapter 2.pdf']);
  });

  it('starts no front part when the first bookmark is on the first page', () => {
    const result = plan({ bookmarks: [{ title: 'A', pageIndex: 0 }] });
    expect(result.parts).toEqual([[0, 1, 2, 3, 4, 5]]);
    expect(result.names).toEqual(['doc-1-A.pdf']);
  });

  it('starts one part for bookmarks on the same page, named after the first in outline order', () => {
    const result = plan({
      bookmarks: [
        { title: 'Part I', pageIndex: 1 },
        { title: 'Chapter 1', pageIndex: 1 },
        { title: 'Chapter 2', pageIndex: 3 },
      ],
    });
    expect(result.parts).toEqual([[0], [1, 2], [3, 4, 5]]);
    expect(result.names).toEqual(['doc-1-Beginning.pdf', 'doc-2-Part I.pdf', 'doc-3-Chapter 2.pdf']);
  });

  it('writes a title as a file name: no path or reserved characters, no edge dots, a bounded length', () => {
    const long = 'Çok uzun bir başlık '.repeat(10);
    const result = plan({
      bookmarks: [
        { title: ' ..A/B: C?*  "D"\u0001 ', pageIndex: 0 },
        { title: '???', pageIndex: 1 },
        { title: long, pageIndex: 2 },
      ],
    });
    expect(result.names[0]).toBe('doc-1-A B C D.pdf');
    // Nothing is left of a title made of reserved characters, so the part keeps its number alone.
    expect(result.names[1]).toBe('doc-2.pdf');
    const longName = (result.names[2] ?? '').replace(/^doc-3-|\.pdf$/g, '');
    expect(longName).toBe(Array.from(long.trim()).slice(0, 60).join('').trim());
  });

  it('asks for another mode when there is no bookmark to cut at', () => {
    expect(failureOf(() => plan({ bookmarks: [] })).code).toBe('no-bookmarks');
    expect(failureOf(() => plan({})).code).toBe('no-bookmarks');
  });

  it('refuses a bookmark outside the document', () => {
    for (const pageIndex of [6, -1, 1.5]) {
      const error = failureOf(() => plan({ bookmarks: [{ title: 'Late', pageIndex }] }));
      expect(error.code).toBe('range-invalid');
    }
  });

  it('leaves the front part with its number alone when no title was given for it', () => {
    const result = plan({ leadTitle: undefined, bookmarks: [{ title: 'A', pageIndex: 2 }] });
    expect(result.names).toEqual(['doc-1.pdf', 'doc-2-A.pdf']);
  });
});

describe('flattenOutline', () => {
  const outline = [
    { title: 'One', pageIndex: 0, children: [{ title: 'One.1', pageIndex: 1, children: [] }] },
    {
      title: 'Two (to another file)',
      pageIndex: null,
      children: [
        { title: 'Two.1', pageIndex: 3, children: [{ title: 'Two.1.1', pageIndex: 4, children: [] }] },
      ],
    },
  ];

  it('takes the top level only by default and counts what points nowhere', () => {
    expect(flattenOutline(outline, 1)).toEqual({ bookmarks: [{ title: 'One', pageIndex: 0 }], skipped: 1 });
  });

  it('goes down to the level asked for, in outline order, through an entry that points nowhere', () => {
    expect(flattenOutline(outline, 2).bookmarks.map((mark) => mark.title)).toEqual(['One', 'One.1', 'Two.1']);
    expect(flattenOutline(outline, 3).bookmarks.map((mark) => mark.title)).toEqual([
      'One',
      'One.1',
      'Two.1',
      'Two.1.1',
    ]);
  });
});

describe('splitDocument by bookmarks', () => {
  const outline = [node('Intro', 2, [node('Background', 3)]), node('Method', 5, [node('Data', 6)])];

  it('produces a file per bookmark of the real outline, the front pages first', async () => {
    const bytes = await book(8, outline);
    const { bookmarks } = await readSplitBookmarks(bytes, 1, run);
    const options: SplitOptions = {
      mode: 'bookmarks',
      baseName: 'report.pdf',
      pageCount: 8,
      bookmarks,
      leadTitle: 'Beginning',
    };
    const result = await splitDocument(bytes, options, run);
    expect(result.files.map((file) => file.name)).toEqual([
      'report-1-Beginning.pdf',
      'report-2-Intro.pdf',
      'report-3-Method.pdf',
    ]);
    expect(result.files.map((file) => widths(file.bytes))).toEqual([
      [100, 101],
      [102, 103, 104],
      [105, 106, 107],
    ]);
    expect(result.plan.names).toEqual(result.files.map((file) => file.name));
  });

  it('cuts at the inner bookmarks too when the level allows it', async () => {
    const bytes = await book(8, outline);
    const { bookmarks } = await readSplitBookmarks(bytes, 2, run);
    const result = await splitDocument(
      bytes,
      { mode: 'bookmarks', baseName: 'report.pdf', pageCount: 8, bookmarks, leadTitle: 'Beginning' },
      run,
    );
    expect(result.files.map((file) => file.name)).toEqual([
      'report-1-Beginning.pdf',
      'report-2-Intro.pdf',
      'report-3-Background.pdf',
      'report-4-Method.pdf',
      'report-5-Data.pdf',
    ]);
    expect(result.files.map((file) => widths(file.bytes).length)).toEqual([2, 1, 2, 1, 2]);
  });

  it('reads no bookmark from a document without an outline', async () => {
    const bytes = await book(3, []);
    expect(await readSplitBookmarks(bytes, 1, run)).toEqual({ bookmarks: [], skipped: 0 });
  });
});
