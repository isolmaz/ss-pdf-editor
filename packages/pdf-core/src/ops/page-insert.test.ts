/**
 * Page insertion and replacement against real bytes and the real pdf.js `extractPages`.
 * The wrong answers that matter: a matched blank page sized like the stored page instead
 * of the page a reader sees, an image page not scaled onto the matched size, pages landing
 * in the wrong slots, and the base document's title lost to the composition.
 */

import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { PRODUCER_LINE } from '../engines/mupdf-write';
import {
  buildInsertedPages,
  type InsertPagesOptions,
  insertPages,
  type PageInsertSource,
  pageSizesOf,
  planInsert,
  planReplace,
  replacePages,
} from './page-insert';

const run = { signal: new AbortController().signal };

/** Pages whose MediaBox widths tell them apart; `turned` pages carry /Rotate 90. */
async function pages(widths: readonly number[], turned: readonly number[] = [], title?: string) {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (const [index, width] of widths.entries()) {
    doc.insertPage(index, doc.addPage([0, 0, width, 300], turned.includes(index) ? 90 : 0, {}, ''));
  }
  if (title !== undefined) {
    doc.setMetaData('info:Title', title);
    doc.setMetaData('info:CreationDate', 'D:20240102030405Z');
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Each page's displayed size, plus the Info title, creation date and producer. */
async function read(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return {
      sizes: Array.from({ length: doc.countPages() }, (_unused, index) => {
        const bounds = doc.loadPage(index).getBounds();
        return [Math.round(bounds[2] - bounds[0]), Math.round(bounds[3] - bounds[1])];
      }),
      title: doc.getMetaData('info:Title') ?? null,
      created: doc.getMetaData('info:CreationDate') ?? null,
      producer: doc.getMetaData('info:Producer') ?? null,
    };
  } finally {
    doc.destroy();
  }
}

/** Whether the rendered page is dark at a displayed point (72 dpi). */
async function inkAt(bytes: Uint8Array, pageIndex: number, x: number, y: number): Promise<boolean> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc
      .loadPage(pageIndex)
      .toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false);
    return (pixmap.getPixels()[y * pixmap.getWidth() + x] ?? 255) < 128;
  } finally {
    doc.destroy();
  }
}

describe('page insertion', () => {
  it('reads the size a reader sees, turned pages turned', async () => {
    expect(await pageSizesOf(await pages([200, 250], [1]), [0, 1])).toEqual([
      { width: 200, height: 300 },
      { width: 300, height: 250 },
    ]);
  });

  it('inserts matched blank pages at a position and keeps the base Info', async () => {
    const base = await pages([200, 250], [1], 'Çeyrek Rapor');
    const out = await insertPages(
      { source: { kind: 'blank', size: 'match', count: 2 }, at: 1, bytes: base, pageCount: 2, matchPage: 1 },
      run,
    );
    const result = await read(out.bytes);
    expect(result.sizes).toEqual([
      [200, 300],
      [300, 250],
      [300, 250],
      [300, 250],
    ]);
    expect(result.title).toBe('Çeyrek Rapor');
    expect(result.created).toBe('D:20240102030405Z');
    expect(result.producer).toBe(PRODUCER_LINE);
  });

  it('scales an image page onto the matched page size', async () => {
    const mupdf = await import('mupdf');
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 20, 10], false);
    pixmap.clear(0);
    const png = pixmap.asPNG();
    const out = await insertPages(
      {
        source: {
          kind: 'image',
          files: [{ name: 'a.png', bytes: png }],
          size: 'match',
          fit: 'fit',
          marginMm: 0,
        },
        at: 1,
        bytes: await pages([200]),
        pageCount: 1,
        matchPage: 0,
      },
      run,
    );
    expect((await read(out.bytes)).sizes).toEqual([
      [200, 300],
      [200, 300],
    ]);
    // A 2:1 picture fitted to 200 wide: 100 tall, centred vertically.
    expect(await inkAt(out.bytes, 1, 100, 150)).toBe(true);
    expect(await inkAt(out.bytes, 1, 5, 105)).toBe(true);
    expect(await inkAt(out.bytes, 1, 100, 95)).toBe(false);
    expect(await inkAt(out.bytes, 1, 100, 205)).toBe(false);
  });

  it('inserts chosen pages of another document and replaces a page', async () => {
    const base = await pages([200, 210, 220], [], 'Ana');
    const other = await pages([500, 510]);
    const inserted = await insertPages(
      { source: { kind: 'document', bytes: other, pages: [1] }, at: 0, bytes: base, pageCount: 3 },
      run,
    );
    expect((await read(inserted.bytes)).sizes.map((size) => size[0])).toEqual([510, 200, 210, 220]);
    expect(inserted.report.steps).toEqual(['pdfjs.extractPages', 'metadata', 'save']);

    const replaced = await replacePages(
      { bytes: base, pageCount: 3, pages: [1], replacements: [{ name: 'ek.pdf', bytes: other, index: 0 }] },
      run,
    );
    const result = await read(replaced.bytes);
    expect(result.sizes.map((size) => size[0])).toEqual([200, 500, 220]);
    expect(result.title).toBe('Ana');
  });
});

// ---------------------------------------------------------------------------
// plans, refusals and the sources the first tests do not take
// ---------------------------------------------------------------------------

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  let outcome: { readonly error: unknown } | null = null;
  try {
    await promise;
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call resolved instead of rejecting');
  if (!isToolError(outcome.error)) throw outcome.error;
  return outcome.error;
}

function refusalOf(call: () => unknown): ToolError {
  let outcome: { readonly error: unknown } | null = null;
  try {
    call();
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call returned instead of throwing');
  if (!isToolError(outcome.error)) throw outcome.error;
  return outcome.error;
}

/** A small black PNG, 20×10. */
async function png(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 20, 10], false);
  pixmap.clear(0);
  return pixmap.asPNG();
}

describe('planInsert', () => {
  it('keeps the document order and shifts what follows the insertion point', () => {
    expect(planInsert(3, 1, 2)).toEqual([
      { position: 0, source: 'document', page: 0 },
      { position: 1, source: 'inserted', page: 0 },
      { position: 2, source: 'inserted', page: 1 },
      { position: 3, source: 'document', page: 1 },
      { position: 4, source: 'document', page: 2 },
    ]);
  });

  it.each([
    ['a page count that is not valid', () => planInsert(-1, 0, 1), 'range-invalid', 'invalid page count'],
    ['a fractional page count', () => planInsert(1.5, 0, 1), 'range-invalid', 'invalid page count'],
    [
      'an insertion point before the first page',
      () => planInsert(3, -1, 1),
      'range-invalid',
      'at must be between 0 and 3',
    ],
    [
      'an insertion point after the end',
      () => planInsert(3, 4, 1),
      'range-invalid',
      'at must be between 0 and 3',
    ],
    ['nothing to insert', () => planInsert(3, 0, 0), 'selection-empty', 'no pages to insert'],
    ['a fractional count', () => planInsert(3, 0, 1.5), 'selection-empty', 'no pages to insert'],
    [
      'more pages than the budget',
      () => planInsert(1999, 0, 2),
      'page-limit',
      'exceeds the 2000-page budget',
    ],
  ])('refuses %s', (_name, call, code, message) => {
    const error = refusalOf(call);
    expect(error.code).toBe(code);
    expect(error.details.engineMessage).toContain(message);
  });
});

describe('planReplace', () => {
  const replacements = [{ index: 0 }, { index: 1 }];

  it('keeps every page in place and points the replaced ones at their replacement', () => {
    expect(planReplace(3, [0, 2], replacements)).toEqual([
      { position: 0, source: 'replacement', page: 0, replacement: 0 },
      { position: 1, source: 'document', page: 1 },
      { position: 2, source: 'replacement', page: 1, replacement: 1 },
    ]);
  });

  it.each([
    [
      'an invalid page count',
      () => planReplace(-1, [0], [{ index: 0 }]),
      'range-invalid',
      'invalid page count',
    ],
    ['no page', () => planReplace(3, [], []), 'selection-empty', 'no pages to replace'],
    [
      'a different number of replacements',
      () => planReplace(3, [0, 1], [{ index: 0 }]),
      'selection-empty',
      '2 page(s) selected but 1 replacement page(s) built',
    ],
    [
      'a page the file lacks',
      () => planReplace(3, [3], [{ index: 0 }]),
      'range-invalid',
      'page 4 is outside the 3-page document',
    ],
    ['a negative page', () => planReplace(3, [-1], [{ index: 0 }]), 'range-invalid', 'page 0 is outside'],
    [
      'pages out of order',
      () => planReplace(3, [2, 1], replacements),
      'range-invalid',
      'the replaced pages must be ascending and unique',
    ],
    [
      'a repeated page',
      () => planReplace(3, [1, 1], replacements),
      'range-invalid',
      'the replaced pages must be ascending and unique',
    ],
    [
      'a negative replacement page',
      () => planReplace(3, [1], [{ index: -1 }]),
      'range-invalid',
      'replacement index must be between 0 and',
    ],
  ])('refuses %s', (_name, call, code, message) => {
    const error = refusalOf(call);
    expect(error.code).toBe(code);
    expect(error.details.engineMessage).toContain(message);
  });
});

describe('pageSizesOf', () => {
  it('refuses a page the document does not have', async () => {
    const error = await refusal(pageSizesOf(await pages([200]), [3]));
    expect(error.details.engineMessage).toBe('page must be between 0 and 0');
  });
});

describe('buildInsertedPages', () => {
  const blank = (
    overrides: Partial<Extract<PageInsertSource, { kind: 'blank' }>> = {},
  ): PageInsertSource => ({
    kind: 'blank',
    size: 'a4',
    count: 1,
    ...overrides,
  });

  it('builds blank pages of a named paper, each of the matched sizes in turn, the last one repeating', async () => {
    const a4 = await buildInsertedPages(blank({ count: 2 }), null, run);
    expect((await read(a4.bytes)).sizes).toEqual([
      [595, 842],
      [595, 842],
    ]);
    const letter = await buildInsertedPages(blank({ size: 'letter' }), null, run);
    expect((await read(letter.bytes)).sizes).toEqual([[612, 792]]);
    const matched = await buildInsertedPages(
      blank({ size: 'match', count: 3 }),
      [
        { width: 100, height: 120 },
        { width: 200, height: 220 },
      ],
      run,
    );
    expect((await read(matched.bytes)).sizes).toEqual([
      [100, 120],
      [200, 220],
      [200, 220],
    ]);
  });

  it('reports the preparation to the caller', async () => {
    const events: unknown[] = [];
    await buildInsertedPages(blank({ count: 2 }), null, {
      ...run,
      onProgress: (event) => events.push([event.phase, event.done, event.total]),
    });
    expect(events).toEqual([['prepare', 0, 2]]);
  });

  it.each([
    [
      'a matched size with no page to match',
      blank({ size: 'match' }),
      null,
      'size "match" without a matched page size',
    ],
    [
      'a matched size with an empty list',
      blank({ size: 'match' }),
      [],
      'size "match" without a matched page size',
    ],
    ['no blank page', blank({ count: 0 }), null, 'blank page count must be between 1 and 2000'],
    ['too many blank pages', blank({ count: 2001 }), null, 'blank page count must be between 1 and 2000'],
    [
      'no images',
      { kind: 'image', files: [], size: 'a4', fit: 'fit', marginMm: 0 },
      null,
      'no images were handed in',
    ],
    [
      'too many images',
      {
        kind: 'image',
        files: Array.from({ length: 2001 }, () => ({ name: 'x.png', bytes: new Uint8Array() })),
        size: 'a4',
        fit: 'fit',
        marginMm: 0,
      },
      null,
      'image count must be between 1 and 2000',
    ],
    [
      'no chosen page',
      { kind: 'document', bytes: new Uint8Array(), pages: [] },
      null,
      'no pages of the inserted document were chosen',
    ],
  ] as const)('refuses %s', async (_name, source, sizes, message) => {
    const error = await refusal(buildInsertedPages(source as PageInsertSource, sizes as never, run));
    expect(error.details.engineMessage ?? '').toContain(message);
  });

  it('refuses a chosen page the document does not have, naming it', async () => {
    const error = await refusal(
      buildInsertedPages({ kind: 'document', bytes: await pages([200, 210]), pages: [0, 2] }, null, run),
    );
    expect(error.details.engineMessage).toBe("page 3 is outside the inserted document's 2 pages");
    expect(error.details.pageIndex).toBe(2);
    const negative = await refusal(
      buildInsertedPages({ kind: 'document', bytes: await pages([200]), pages: [-1] }, null, run),
    );
    expect(negative.code).toBe('range-invalid');
  });

  it('builds pages from images at a named paper size, and refits them to a matched size by each fit', async () => {
    const image = { kind: 'image', files: [{ name: 'a.png', bytes: await png() }], marginMm: 0 } as const;
    const onA4 = await buildInsertedPages({ ...image, size: 'a4', fit: 'fill' }, null, run);
    expect(onA4.pageCount).toBe(1);
    expect((await read(onA4.bytes)).sizes).toEqual([[595, 842]]);
    const sizes = [{ width: 200, height: 300 }];
    for (const fit of ['fill', 'stretch'] as const) {
      const fitted = await buildInsertedPages({ ...image, size: 'match', fit }, sizes, run);
      expect((await read(fitted.bytes)).sizes).toEqual([[200, 300]]);
      // Both cover the whole page with a black picture: the corners are ink.
      expect(await inkAt(fitted.bytes, 0, 2, 2)).toBe(true);
      expect(await inkAt(fitted.bytes, 0, 197, 297)).toBe(true);
    }
  });

  it('refuses a matched image size with no page to match', async () => {
    const error = await refusal(
      buildInsertedPages(
        {
          kind: 'image',
          files: [{ name: 'a.png', bytes: await png() }],
          size: 'match',
          fit: 'fit',
          marginMm: 0,
        },
        null,
        run,
      ),
    );
    expect(error.details.engineMessage).toBe('size "match" without a matched page size');
  });

  it('reports an image it could not use, and still inserts the others', async () => {
    const out = await insertPages(
      {
        source: {
          kind: 'image',
          files: [
            { name: 'a.png', bytes: await png() },
            { name: 'broken.png', bytes: new Uint8Array([1, 2, 3]) },
          ],
          size: 'a4',
          fit: 'fit',
          marginMm: 0,
        },
        at: 1,
        bytes: await pages([200]),
        pageCount: 1,
      },
      run,
    );
    expect(out.report.notes.find((entry) => entry.key === 'insert.note.skipped')?.params).toEqual({
      count: 1,
    });
    expect((await read(out.bytes)).sizes).toHaveLength(2);
  });

  it('stops when the signal is aborted just as the refit begins', async () => {
    const controller = new AbortController();
    // The signal reads as aborted only to the refit loop, which is the step under test.
    Object.defineProperty(controller.signal, 'aborted', {
      get: () => new Error().stack?.includes('fitPagesOnto') === true,
    });
    const image = {
      kind: 'image',
      files: [{ name: 'a.png', bytes: await png() }],
      marginMm: 0,
      size: 'match',
      fit: 'fit',
    } as const;
    await expect(
      buildInsertedPages(image, [{ width: 200, height: 300 }], { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('stops at an aborted signal, before and while an image is refitted', async () => {
    const before = new AbortController();
    before.abort();
    await expect(buildInsertedPages(blank(), null, { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const image = {
      kind: 'image',
      files: [{ name: 'a.png', bytes: await png() }],
      marginMm: 0,
      size: 'match',
      fit: 'fit',
    } as const;
    const refitting = new AbortController();
    await expect(
      buildInsertedPages(image, [{ width: 200, height: 300 }], {
        signal: refitting.signal,
        onProgress: () => refitting.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('insertPages in every position and from every source', () => {
  const options = async (overrides: Partial<InsertPagesOptions>): Promise<InsertPagesOptions> => ({
    source: { kind: 'blank', size: 'match', count: 1 },
    at: 0,
    bytes: await pages([200, 210]),
    pageCount: 2,
    ...overrides,
  });

  it('matches a blank page to the page at the insertion point, the last page at the end, or the one asked for', async () => {
    const atStart = await insertPages(await options({ at: 0 }), run);
    expect((await read(atStart.bytes)).sizes.map((size) => size[0])).toEqual([200, 200, 210]);
    const atEnd = await insertPages(await options({ at: 2 }), run);
    expect((await read(atEnd.bytes)).sizes.map((size) => size[0])).toEqual([200, 210, 210]);
    const asked = await insertPages(await options({ at: 2, matchPage: 0 }), run);
    expect((await read(asked.bytes)).sizes.map((size) => size[0])).toEqual([200, 210, 200]);
  });

  it('refuses a match against a document with no page, or a page it does not have, and an insertion point outside it', async () => {
    expect((await refusal(insertPages(await options({ pageCount: 0 }), run))).details.engineMessage).toBe(
      'size "match" needs a page of the current document, and it has none',
    );
    expect((await refusal(insertPages(await options({ matchPage: 5 }), run))).details.engineMessage).toBe(
      'matchPage must be between 0 and 1',
    );
    expect((await refusal(insertPages(await options({ at: 9 }), run))).details.engineMessage).toBe(
      'at must be between 0 and 2',
    );
  });

  it('reports the placement as it happens and where the pages landed', async () => {
    const events: unknown[] = [];
    const out = await insertPages(await options({ at: 1, source: { kind: 'blank', size: 'a4', count: 2 } }), {
      ...run,
      onProgress: (event) => events.push([event.phase, event.labelKey]),
    });
    expect(events).toContainEqual(['place', 'insert.progress.place']);
    expect(out.report.pageCount).toBe(4);
    expect(out.report.notes.find((entry) => entry.key === 'insert.note.inserted')?.params).toEqual({
      count: 2,
      position: 2,
    });
  });

  it('inserts the chosen pages of another document in the order they were chosen', async () => {
    const out = await insertPages(
      await options({
        at: 2,
        source: { kind: 'document', bytes: await pages([500, 510, 520]), pages: [2, 0] },
      }),
      run,
    );
    expect((await read(out.bytes)).sizes.map((size) => size[0])).toEqual([200, 210, 520, 500]);
  });

  it('stops at an aborted signal', async () => {
    const before = new AbortController();
    before.abort();
    await expect(insertPages(await options({}), { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('replacePages beyond one replacement', () => {
  it('draws several replacements from one document and keeps what is not replaced', async () => {
    const other = await pages([500, 510, 520]);
    const out = await replacePages(
      {
        bytes: await pages([200, 210, 220, 230]),
        pageCount: 4,
        pages: [0, 2],
        replacements: [
          { name: 'ek.pdf', bytes: other, index: 2 },
          { name: 'ek.pdf', bytes: other, index: 0 },
        ],
      },
      run,
    );
    expect((await read(out.bytes)).sizes.map((size) => size[0])).toEqual([520, 210, 500, 230]);
    expect(out.report.inputBytes).toBe((await pages([200, 210, 220, 230])).length + other.length);
    expect(out.report.notes.find((entry) => entry.key === 'replace.note.replaced')?.params).toEqual({
      count: 2,
    });
  });

  it('refuses a replacement page its document does not have, naming the file', async () => {
    const error = await refusal(
      replacePages(
        {
          bytes: await pages([200, 210]),
          pageCount: 2,
          pages: [0],
          replacements: [{ name: 'ek.pdf', bytes: await pages([500]), index: 3 }],
        },
        run,
      ),
    );
    expect(error.details.engineMessage).toBe('ek.pdf has 1 pages; page 4 was asked for');
    expect(error.details.path).toBe('ek.pdf');
    expect(error.details.pageIndex).toBe(3);
  });

  it('reports the replacement as it happens, and stops at an aborted signal', async () => {
    const phases: unknown[] = [];
    const replacements = [{ name: 'ek.pdf', bytes: await pages([500]), index: 0 }];
    await replacePages(
      { bytes: await pages([200, 210]), pageCount: 2, pages: [1], replacements },
      {
        ...run,
        onProgress: (event) => phases.push(event.phase),
      },
    );
    expect(phases).toContain('replace');
    const before = new AbortController();
    before.abort();
    await expect(
      replacePages(
        { bytes: await pages([200, 210]), pageCount: 2, pages: [1], replacements },
        { signal: before.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
