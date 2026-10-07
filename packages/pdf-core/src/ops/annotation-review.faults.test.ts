/**
 * The review records are read back after they are written. The real writer writes what it is
 * told to, so the save is wrapped at the writer's module seam: just before the bytes are made,
 * the document is damaged in one chosen way, and the read-back has to refuse the file.
 */

import { PDFDocument as Doc, type PDFDocument, type PDFObject } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  damage: undefined as undefined | 'irt' | 'state' | 'parent' | 'annots' | 'junk',
}));

vi.mock('../engines/mupdf-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf-write')>();
  return {
    ...actual,
    saveRewrite: (doc: PDFDocument, context?: string, options?: string) => {
      if (state.damage !== undefined) {
        const page = doc.findPage(0);
        if (state.damage === 'annots') page.delete('Annots');
        if (state.damage === 'parent') page.get('Annots').delete(0);
        if (state.damage === 'junk') page.get('Annots').push(doc.newInteger(3));
        for (let index = 1; index < doc.countObjects(); index += 1) {
          const object: PDFObject = doc.newIndirect(index).resolve();
          if (!object.isDictionary() || object.get('IRT').isNull()) continue;
          if (state.damage === 'irt') object.put('IRT', 7);
          if (state.damage === 'state') object.put('State', 'Rejected');
        }
      }
      return actual.saveRewrite(doc, context, options);
    },
  };
});

const { writeCommentReview } = await import('./annotation-review');
const { referenceOf } = await import('./annotations');

const run = { signal: new AbortController().signal };

function commented(): { bytes: Uint8Array; id: string } {
  const doc = new Doc();
  doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  const page = doc.findPage(0);
  const note = doc.addObject({ Type: 'Annot', P: page, Subtype: 'Text', Rect: [10, 10, 30, 30] });
  page.put('Annots', [note]);
  const id = referenceOf(note);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return { bytes, id };
}

afterEach(() => {
  state.damage = undefined;
});

describe('review read-back', () => {
  const author = { pageIndex: 0, author: 'Mehmet', createdAt: '2026-10-01T09:30:00.000Z' } as const;

  it.each(['irt', 'parent', 'annots'] as const)(
    'refuses a reply when the file is damaged (%s)',
    async (damage) => {
      const { bytes, id } = commented();
      state.damage = damage;
      await expect(
        writeCommentReview(bytes, [{ ...author, kind: 'reply', parentId: id, id: 'r', contents: 'x' }], run),
      ).rejects.toMatchObject({ code: 'verification-failed' });
    },
  );

  it('reads past an annotation entry that is no dictionary and still finds the record', async () => {
    const { bytes, id } = commented();
    state.damage = 'junk';
    const out = await writeCommentReview(
      bytes,
      [{ ...author, kind: 'reply', parentId: id, id: 'r', contents: 'x' }],
      run,
    );
    expect(out.written).toEqual(['r']);
  });

  it('refuses a state record whose state is not the one asked for', async () => {
    const { bytes, id } = commented();
    state.damage = 'state';
    await expect(
      writeCommentReview(
        bytes,
        [{ ...author, kind: 'state', parentId: id, id: 's', state: 'Accepted' }],
        run,
      ),
    ).rejects.toMatchObject({ code: 'verification-failed' });
  });
});
