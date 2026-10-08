/**
 * Comment review on pages and comments a producer may write differently: a comment without a
 * subtype or rectangle, a page without annotations, an annotation entry that is no dictionary,
 * replies without any state, and a cancelled run.
 */

import { PDFDocument, type PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { stateContents, writeCommentReview } from './annotation-review';
import { referenceOf } from './annotations';

const run = { signal: new AbortController().signal };
const base = { pageIndex: 0, author: 'Mehmet', createdAt: '2026-10-01T09:30:00.000Z' } as const;

function page(build: (doc: PDFDocument, page: PDFObject) => PDFObject[]): {
  bytes: Uint8Array;
  ids: string[];
} {
  const doc = new PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  const target = doc.findPage(0);
  const annotations = build(doc, target);
  if (annotations.length > 0) target.put('Annots', annotations);
  const ids = annotations.map((annotation) => (annotation.isIndirect() ? referenceOf(annotation) : ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return { bytes, ids };
}

describe('stateContents', () => {
  it('names the author unless there is none', () => {
    expect(stateContents('Accepted', ' Ayşe ')).toBe('Accepted set by Ayşe');
    expect(stateContents('Accepted', '   ')).toBe('Accepted');
  });
});

describe('writeCommentReview edge cases', () => {
  it('answers a comment that has neither a subtype nor a rectangle, placing the reply at the page origin', async () => {
    const { bytes, ids } = page((doc, target) => [doc.addObject({ Type: 'Annot', P: target })]);
    const out = await writeCommentReview(
      bytes,
      [{ ...base, kind: 'reply', parentId: ids[0] as string, id: 'r1', contents: 'Tamam' }],
      run,
    );
    expect(out.written).toEqual(['r1']);
    // Only replies were written: no state note.
    expect(out.report.notes.map((entry) => entry.key)).toEqual(['op.note.annotate.replies']);
  });

  it('writes states only, with only the states note', async () => {
    const { bytes, ids } = page((doc, target) => [
      doc.addObject({ Type: 'Annot', P: target, Subtype: 'Text', Rect: [10, 10, 30, 30] }),
    ]);
    const out = await writeCommentReview(
      bytes,
      [{ ...base, kind: 'state', parentId: ids[0] as string, id: 's1', state: 'Accepted' }],
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).toEqual(['op.note.annotate.states']);
  });

  it('says a comment is not there on a page without annotations, or when its entry is no dictionary', async () => {
    const empty = page(() => []);
    await expect(
      writeCommentReview(
        empty.bytes,
        [{ ...base, kind: 'reply', parentId: '5R', id: 'r', contents: 'x' }],
        run,
      ),
    ).rejects.toMatchObject({ code: 'selection-empty' });

    const odd = page((doc) => [doc.addObject(doc.newInteger(7))]);
    await expect(
      writeCommentReview(
        odd.bytes,
        [{ ...base, kind: 'reply', parentId: odd.ids[0] as string, id: 'r', contents: 'x' }],
        run,
      ),
    ).rejects.toMatchObject({ code: 'selection-empty' });
  });

  it('refuses a record for a page the document does not have', async () => {
    const { bytes } = page(() => []);
    await expect(
      writeCommentReview(
        bytes,
        [{ ...base, pageIndex: 4, kind: 'reply', parentId: '5R', id: 'r', contents: 'x' }],
        run,
      ),
    ).rejects.toMatchObject({ code: 'range-invalid' });
  });

  it('refuses an empty request and stops with an abort error for an aborted signal', async () => {
    const { bytes, ids } = page((doc, target) => [
      doc.addObject({ Type: 'Annot', P: target, Subtype: 'Text' }),
    ]);
    await expect(writeCommentReview(bytes, [], run)).rejects.toMatchObject({ code: 'selection-empty' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeCommentReview(
        bytes,
        [{ ...base, kind: 'reply', parentId: ids[0] as string, id: 'r', contents: 'x' }],
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
