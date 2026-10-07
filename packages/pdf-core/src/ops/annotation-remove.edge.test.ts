/**
 * Annotation removal against hand-written pages: an annotation the page lists twice, an object of
 * generation 5, entries that are not annotations, a popup that no page lists, an owner that is
 * removed together with its popup, and requests that cannot be honoured. Each file is read back
 * from the bytes the remover produced. The check that reads the written file back has its own
 * fault tests (`annotation-remove.faults.test.ts`).
 */

import { PDFDocument } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { removePdfAnnotations } from './annotation-remove';
import { annotatedPages, square, withGeneration } from './annotation-remove.fixtures';

const run = { signal: new AbortController().signal };
const remove = (bytes: Uint8Array, ...ids: [number, string][]) =>
  removePdfAnnotations(bytes, { targets: ids.map(([pageIndex, id]) => ({ pageIndex, id })) }, run);

/** What `/Annots` of a page lists in a produced file: the object number, or `direct`; `null` without the key. */
function listed(bytes: Uint8Array, pageIndex = 0): (number | 'direct')[] | null {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const annots = doc.findPage(pageIndex).get('Annots');
    if (annots.isNull()) return null;
    const array = annots.resolve();
    return Array.from({ length: array.length }, (_entry, index) => {
      const entry = array.get(index);
      return entry.isIndirect() ? entry.asIndirect() : 'direct';
    });
  } finally {
    doc.destroy();
  }
}

/** How many objects of the produced file are popups. */
function popups(bytes: Uint8Array): number {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    let count = 0;
    for (let number = 1; number < doc.countObjects(); number += 1) {
      const object = doc.newIndirect(number).resolve();
      if (
        object.isDictionary() &&
        object.get('Subtype').isName() &&
        object.get('Subtype').asName() === 'Popup'
      )
        count += 1;
    }
    return count;
  } finally {
    doc.destroy();
  }
}

describe('what the page lists', () => {
  it('removes an annotation the page lists twice, both entries, and says it once', async () => {
    const out = await remove(
      annotatedPages({ annots: '[10 0 R 10 0 R 11 0 R]', extra: { 10: square(1), 11: square(2) } }),
      [0, '10R'],
    );
    expect(out.removed).toEqual(['10R']);
    expect(listed(out.bytes)).toEqual([11]);
  });

  it('leaves a direct dictionary and an entry that is not a dictionary where they are', async () => {
    const out = await remove(
      annotatedPages({
        annots: `[${square(5)} 42 null 10 0 R 11 0 R]`,
        extra: { 10: square(1), 11: square(2) },
      }),
      [0, '10R'],
    );
    // The dictionary, the integer and the null are all direct entries; the removed one is gone.
    expect(listed(out.bytes)).toEqual(['direct', 'direct', 'direct', 11]);
  });

  it('keeps the object while another page still lists it, and drops the key of the page that lost its last entry', async () => {
    const out = await remove(
      annotatedPages({
        annots: '[10 0 R]',
        second: '[10 0 R 11 0 R]',
        extra: { 10: square(1), 11: square(2) },
      }),
      [0, '10R'],
    );
    expect(listed(out.bytes, 0)).toBeNull();
    expect(listed(out.bytes, 1)).toEqual([10, 11]);
  });

  it('works on a file in which a page has no /Annots at all', async () => {
    const out = await remove(annotatedPages({ annots: '[10 0 R]', second: null, extra: { 10: square(1) } }), [
      0,
      '10R',
    ]);
    expect(listed(out.bytes, 1)).toBeNull();
  });

  it('names an annotation by its generation: 10R5 is not 10R, and 10R0 is', async () => {
    const input = withGeneration(
      annotatedPages({ annots: '[10 5 R 11 0 R]', extra: { 10: square(1), 11: square(2) } }),
      10,
      5,
    );
    await expect(remove(input, [0, '10R'])).rejects.toMatchObject({ code: 'selection-empty' });
    const out = await remove(input, [0, '10R5']);
    expect(out.removed).toEqual(['10R5']);
    expect(listed(out.bytes)).toEqual([11]);
    const plain = await remove(
      annotatedPages({ annots: '[10 0 R 11 0 R]', extra: { 10: square(1), 11: square(2) } }),
      [0, ' 11R0 '],
    );
    expect(plain.removed).toEqual(['11R']);
  });

  it('refuses an annotation that is not a dictionary or whose object is missing, as a damaged document', async () => {
    for (const annots of ['[10 0 R]', '[99 0 R]']) {
      await expect(
        remove(annotatedPages({ annots, extra: { 10: '42' } }), [0, annots === '[10 0 R]' ? '10R' : '99R']),
      ).rejects.toMatchObject({
        code: 'corrupt-document',
        details: { pageIndex: 0 },
      });
    }
  });
});

describe('popups', () => {
  const comment = (popup: string) => square(1, `/Popup ${popup}`);
  const popup = (parent: string) => `<</Type/Annot/Subtype/Popup/Rect[0 0 50 50]${parent}>>`;

  it('removes an owner and its popup when both are asked for, listing both once', async () => {
    const out = await remove(
      annotatedPages({
        annots: '[10 0 R 11 0 R 12 0 R]',
        extra: { 10: comment('11 0 R'), 11: popup('/Parent 10 0 R'), 12: square(3) },
      }),
      [0, '10R'],
      [0, '11R'],
    );
    expect(out.removed).toEqual(['10R', '11R']);
    expect(listed(out.bytes)).toEqual([12]);
  });

  it('removes the popup of a comment even when no page lists the popup', async () => {
    const out = await remove(
      annotatedPages({
        annots: '[10 0 R 12 0 R]',
        extra: { 10: comment('11 0 R'), 11: popup('/Parent 10 0 R'), 12: square(3) },
      }),
      [0, '10R'],
    );
    expect(out.removed).toEqual(['10R']);
    expect(listed(out.bytes)).toEqual([12]);
    expect(popups(out.bytes)).toBe(0);
  });

  it('unlinks a popup that another page lists, wherever it is', async () => {
    const out = await remove(
      annotatedPages({
        annots: '[10 0 R]',
        second: '[11 0 R 12 0 R]',
        extra: { 10: comment('11 0 R'), 11: popup('/Parent 10 0 R'), 12: square(3) },
      }),
      [0, '10R'],
    );
    expect(listed(out.bytes, 1)).toEqual([12]);
  });

  it('leaves the owner of a removed popup pointing at nothing, but not when it points at another popup', async () => {
    const cleared = await remove(
      annotatedPages({
        annots: '[10 0 R 11 0 R]',
        extra: { 10: comment('11 0 R'), 11: popup('/Parent 10 0 R') },
      }),
      [0, '11R'],
    );
    expect(listed(cleared.bytes)).toEqual([10]);
    const other = await remove(
      annotatedPages({
        annots: '[10 0 R 11 0 R 12 0 R]',
        extra: { 10: comment('12 0 R'), 11: popup('/Parent 10 0 R'), 12: popup('/Parent 10 0 R') },
      }),
      [0, '11R'],
    );
    expect(listed(other.bytes)).toEqual([10, 12]);
  });

  it('removes a popup that names no owner', async () => {
    const out = await remove(
      annotatedPages({ annots: '[10 0 R 11 0 R]', extra: { 10: square(1), 11: popup('') } }),
      [0, '11R'],
    );
    expect(listed(out.bytes)).toEqual([10]);
  });
});

describe('requests that cannot be honoured', () => {
  const garbage = new Uint8Array([1, 2, 3]);

  it.each([-1, 1.5, Number.NaN])('refuses the page index %s before opening the file', async (pageIndex) => {
    await expect(
      removePdfAnnotations(garbage, { targets: [{ pageIndex, id: '10R' }] }, run),
    ).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { path: 'request.targets[0].pageIndex' },
    });
  });

  it.each(['0R', '99999999999999999999R', '10R99999999999999999999', 'abc', '10 0 R', ''])(
    'refuses %j as not an object reference',
    async (id) => {
      await expect(
        removePdfAnnotations(garbage, { targets: [{ pageIndex: 0, id }] }, run),
      ).rejects.toMatchObject({ code: 'unsupported', details: { path: 'request.targets[0].id' } });
    },
  );

  it('refuses an id that is not text, naming it', async () => {
    await expect(
      removePdfAnnotations(garbage, { targets: [{ pageIndex: 0, id: 5 as never }] }, run),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: expect.stringContaining('"5"') },
    });
  });

  it('refuses a request without a targets array', async () => {
    for (const request of [{ targets: 'x' }, null, {}]) {
      await expect(removePdfAnnotations(garbage, request as never, run)).rejects.toMatchObject({
        code: 'internal',
        details: { path: 'request.targets', engineMessage: 'removePdfAnnotations expects a targets array' },
      });
    }
  });

  it('refuses a page that does not exist, and names it', async () => {
    await expect(
      remove(annotatedPages({ annots: '[10 0 R]', extra: { 10: square(1) } }), [3, '10R']),
    ).rejects.toMatchObject({
      code: 'range-invalid',
      details: { pageIndex: 3, engineMessage: 'annotation 10R targets page 4 of 1' },
    });
  });

  it('stops when the signal aborts between targets', async () => {
    let reads = 0;
    const signal = new AbortController().signal;
    Object.defineProperty(signal, 'aborted', {
      get: () => {
        reads += 1;
        return reads > 1;
      },
    });
    await expect(
      removePdfAnnotations(
        annotatedPages({ annots: '[10 0 R]', extra: { 10: square(1) } }),
        { targets: [{ pageIndex: 0, id: '10R' }] },
        { signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
