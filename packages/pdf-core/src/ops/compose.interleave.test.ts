/**
 * Alternating the front and back sides of a double-sided scan: the plan, and the real
 * `extractPages` merge it drives. Pages are told apart by their MediaBox width.
 */

import { describe, expect, it } from 'vitest';
import { interleaveDocuments, planInterleave } from './compose';
import { readPageLabels } from './page-labels';

const run = { signal: new AbortController().signal };

/** `count` pages of widths `first`, `first + 10`, … so every page of every file is recognisable. */
async function sides(count: number, first: number, title?: string): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < count; index += 1) {
    doc.insertPage(index, doc.addPage([0, 0, first + index * 10, 200], 0, {}, ''));
  }
  if (title !== undefined) doc.setMetaData('info:Title', title);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const file = async (name: string, count: number, first: number, title?: string) => ({
  name,
  bytes: await sides(count, first, title),
  pageCount: count,
});

/** The widths of a produced file's pages, and its title, as MuPDF reads them. */
async function widthsOf(bytes: Uint8Array): Promise<{ widths: number[]; title: string | null }> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return {
      widths: Array.from({ length: doc.countPages() }, (_unused, index) =>
        doc.findPage(index).getInheritable('MediaBox').get(2).asNumber(),
      ),
      title: doc.getMetaData('info:Title') ?? null,
    };
  } finally {
    doc.destroy();
  }
}

describe('planInterleave', () => {
  it('puts the k-th back after the k-th front', () => {
    expect(planInterleave(3, 3, false)).toEqual({ fronts: [0, 2, 4], backs: [1, 3, 5] });
  });

  it('takes the backs from the last page when the stack was turned over', () => {
    expect(planInterleave(3, 3, true)).toEqual({ fronts: [0, 2, 4], backs: [5, 3, 1] });
  });

  it('appends the fronts that have no back, in order', () => {
    expect(planInterleave(4, 2, false)).toEqual({ fronts: [0, 2, 4, 5], backs: [1, 3] });
  });

  it('appends the backs that have no front, in sheet order', () => {
    // Reversed, the first sheet's back is the last page of the file; the extra sheets are the first pages.
    expect(planInterleave(1, 3, true)).toEqual({ fronts: [0], backs: [3, 2, 1] });
  });
});

describe('interleaveDocuments', () => {
  it('alternates the sides, the fronts first, and keeps the front file’s title', async () => {
    const out = await interleaveDocuments(
      await file('fronts.pdf', 3, 100, 'Sözleşme'),
      await file('backs.pdf', 3, 200, 'Arka'),
      { reverseBacks: false },
      run,
    );
    const result = await widthsOf(out.bytes);
    expect(result.widths).toEqual([100, 200, 110, 210, 120, 220]);
    expect(result.title).toBe('Sözleşme');
    expect(out.report.pageCount).toBe(6);
    const notes = out.report.notes.map((entry) => entry.key);
    expect(notes).toContain('op.note.merge.interleaved');
    expect(notes).not.toContain('op.note.merge.backsReversed');
    expect(notes.some((key) => key.startsWith('op.note.merge.unequal'))).toBe(false);
  });

  it('reads the backs from their last page when asked, and says so', async () => {
    const out = await interleaveDocuments(
      await file('fronts.pdf', 3, 100),
      await file('backs.pdf', 3, 200),
      { reverseBacks: true },
      run,
    );
    expect((await widthsOf(out.bytes)).widths).toEqual([100, 220, 110, 210, 120, 200]);
    expect(out.report.notes).toContainEqual({ kind: 'changed', key: 'op.note.merge.backsReversed' });
  });

  it('appends the extra front pages and warns about them', async () => {
    const out = await interleaveDocuments(
      await file('fronts.pdf', 4, 100),
      await file('backs.pdf', 2, 200),
      { reverseBacks: false },
      run,
    );
    expect((await widthsOf(out.bytes)).widths).toEqual([100, 200, 110, 210, 120, 130]);
    expect(out.report.notes).toContainEqual({
      kind: 'warning',
      key: 'op.note.merge.unequalFronts',
      params: { count: 2 },
    });
  });

  it('appends the extra back pages and warns about them', async () => {
    const out = await interleaveDocuments(
      await file('fronts.pdf', 1, 100),
      await file('backs.pdf', 3, 200),
      { reverseBacks: false },
      run,
    );
    expect((await widthsOf(out.bytes)).widths).toEqual([100, 200, 210, 220]);
    expect(out.report.notes).toContainEqual({
      kind: 'warning',
      key: 'op.note.merge.unequalBacks',
      params: { count: 2 },
    });
  });

  it('gives every page the label its own file gave it', async () => {
    const mupdf = await import('mupdf');
    const open = mupdf.PDFDocument.openDocument((await sides(2, 100)).slice(), 'application/pdf').asPDF();
    if (open === null) throw new Error('not a PDF');
    open.setPageLabels(0, 'r');
    const fronts = {
      name: 'fronts.pdf',
      bytes: new Uint8Array(open.saveToBuffer('').asUint8Array()),
      pageCount: 2,
    };
    open.destroy();
    const out = await interleaveDocuments(
      fronts,
      await file('backs.pdf', 2, 200),
      { reverseBacks: false },
      run,
    );
    expect(await readPageLabels(out.bytes, 4)).toEqual(['i', '1', 'ii', '2']);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.merge.labels');
  });
});
