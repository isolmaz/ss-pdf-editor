/**
 * Composition and merge against real bytes and the real pdf.js `extractPages`. The wrong
 * answers that matter: a requested turn that replaces the page's own `/Rotate` instead of
 * adding to it, a page landing at the wrong position, a merge that drops the base
 * document's title or XMP packet, and a merged file without the product producer line.
 */

import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { PRODUCER_LINE } from '../engines/mupdf-write';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { type ComposeOptions, composeDocument, mergeDocuments, type PdfComposeHandle } from './compose';

const run = { signal: new AbortController().signal };

/** `count` pages whose widths tell them apart (100, 110, …); `turned` pages carry /Rotate 90. */
async function pages(count: number, turned: readonly number[] = [], title?: string): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < count; index += 1) {
    doc.insertPage(
      index,
      doc.addPage([0, 0, 100 + index * 10, 200], turned.includes(index) ? 90 : 0, {}, ''),
    );
  }
  if (title !== undefined) {
    doc.setMetaData('info:Title', title);
    const packet = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="r"?>';
    doc
      .getTrailer()
      .get('Root')
      .put('Metadata', doc.addRawStream(packet, { Type: 'Metadata', Subtype: 'XML' }));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Each page's MediaBox width and /Rotate, plus the Info title, producer and XMP presence. */
async function read(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const list = Array.from({ length: doc.countPages() }, (_unused, index) => {
      const page = doc.findPage(index);
      const rotate = page.getInheritable('Rotate');
      return {
        width: page.getInheritable('MediaBox').get(2).asNumber(),
        rotate: rotate.isNull() ? 0 : rotate.asNumber(),
      };
    });
    return {
      pages: list,
      title: doc.getMetaData('info:Title') ?? null,
      producer: doc.getMetaData('info:Producer') ?? null,
      xmp: !doc.getTrailer().get('Root', 'Metadata').isNull(),
    };
  } finally {
    doc.destroy();
  }
}

describe('composeDocument', () => {
  it('reorders pages and adds a requested turn to the page’s own rotation', async () => {
    const handle = await openWithPdfjs(await pages(3, [2]));
    try {
      const out = await composeDocument(
        { sources: [{ pages: [2, 0], rotations: { 0: 90, 1: 180 } }], pageCount: 2 },
        handle.raw,
        run,
      );
      const result = await read(out.bytes);
      expect(result.pages).toEqual([
        { width: 120, rotate: 180 },
        { width: 100, rotate: 180 },
      ]);
      expect(result.producer).toBe(PRODUCER_LINE);
      expect(out.report.steps).toEqual(['pdfjs.extractPages', 'compose.rotate', 'save']);
      expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.compose.rotation');
    } finally {
      await handle.destroy();
    }
  });

  it('hands the engine’s bytes through untouched when nothing is turned', async () => {
    const handle = await openWithPdfjs(await pages(3));
    try {
      const out = await composeDocument({ sources: [{ pages: [1] }], pageCount: 1 }, handle.raw, run);
      expect(out.report.steps).toEqual(['pdfjs.extractPages']);
      expect((await read(out.bytes)).pages).toEqual([{ width: 110, rotate: 0 }]);
    } finally {
      await handle.destroy();
    }
  });

  it('refuses a composition whose page count is not the one planned', async () => {
    const handle = await openWithPdfjs(await pages(2));
    try {
      await expect(
        composeDocument({ sources: [{ pages: [0, 1] }], pageCount: 3 }, handle.raw, run),
      ).rejects.toMatchObject({ code: 'range-invalid' });
    } finally {
      await handle.destroy();
    }
  });
});

describe('mergeDocuments', () => {
  it('inserts another document after a base page and keeps the base title and XMP', async () => {
    const base = await pages(2, [], 'Çeyrek Rapor');
    const other = await pages(1);
    const out = await mergeDocuments(
      { bytes: base, pageCount: 2 },
      [{ name: 'ek.pdf', bytes: other, pageCount: 1 }],
      0,
      run,
    );
    const result = await read(out.bytes);
    expect(result.pages.map((page) => page.width)).toEqual([100, 100, 110]);
    expect(result.title).toBe('Çeyrek Rapor');
    expect(result.xmp).toBe(true);
    expect(result.producer).toBe(PRODUCER_LINE);
    expect(out.report.steps).toEqual(['pdfjs.extractPages', 'metadata', 'save']);
    expect(out.report.notes.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['op.note.merge.metadata', 'op.note.merge.verified']),
    );
  });
});

// ---------------------------------------------------------------------------
// planning, refusals and what the report says
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

/** Run `use` against a live handle over `bytes`. */
async function withHandle<T>(
  bytes: Uint8Array,
  use: (handle: Awaited<ReturnType<typeof openWithPdfjs>>) => Promise<T>,
): Promise<T> {
  const handle = await openWithPdfjs(bytes);
  try {
    return await use(handle);
  } finally {
    await handle.destroy();
  }
}

/** Compose `options` against a base document of `count` pages. */
async function compose(options: ComposeOptions, count = 3, turned: readonly number[] = []) {
  return withHandle(await pages(count, turned), (handle) => composeDocument(options, handle.raw, run));
}

describe('composeDocument plans its pages', () => {
  it.each([
    ['a negative page', { sources: [{ pages: [-1] }], pageCount: 1 }, 'source 0 asks for page index -1'],
    ['a fractional page', { sources: [{ pages: [0.5] }], pageCount: 1 }, 'source 0 asks for page index 0.5'],
    [
      'a base page the document lacks',
      { sources: [{ pages: [5] }], pageCount: 1 },
      'page 6 is outside the 3-page document',
    ],
    [
      'a position outside the result',
      { sources: [{ pages: [0], positions: [4] }], pageCount: 1 },
      'output position 4 is outside 0…0',
    ],
    [
      'a fractional position',
      { sources: [{ pages: [0], positions: [0.5] }], pageCount: 1 },
      'output position 0.5 is outside',
    ],
    [
      'a position claimed twice',
      { sources: [{ pages: [0, 1], positions: [1, 1] }], pageCount: 2 },
      'output position 1 is claimed twice',
    ],
    [
      'a turn that is not a quarter',
      { sources: [{ pages: [0], rotations: { 0: 45 as 90 } }], pageCount: 1 },
      'rotation 45 on output position 0 is not a multiple of 90',
    ],
    [
      'a turn that is not finite',
      { sources: [{ pages: [0], rotations: { 0: Number.NaN as 90 } }], pageCount: 1 },
      'rotation NaN',
    ],
    [
      'a page total that is not the planned count',
      { sources: [{ pages: [0, 1] }], pageCount: 3 },
      'the sources ask for 2 pages but the result should hold 3',
    ],
  ] as const)('refuses %s', async (_name, options, message) => {
    const error = await refusal(compose(options as ComposeOptions));
    expect(error.code).toBe('range-invalid');
    expect(error.details.engineMessage).toContain(message);
  });

  it('names the source in the error path', async () => {
    const error = await refusal(
      compose({ sources: [{ pages: [0] }, { bytes: new Uint8Array(), pages: [-3] }], pageCount: 2 }),
    );
    expect(error.details.path).toBe('1');
  });

  it('fills the positions nobody claimed in ascending order around the ones that were', async () => {
    const out = await compose({ sources: [{ pages: [2, 1, 0], positions: [1] }], pageCount: 3 });
    expect((await read(out.bytes)).pages.map((page) => page.width)).toEqual([110, 120, 100]);
  });

  it('repeats a page and adds each requested turn to the page own rotation', async () => {
    const out = await compose(
      { sources: [{ pages: [0, 0, 1], rotations: { 0: 90, 1: 270, 2: -90 as 90 } }], pageCount: 3 },
      2,
      [0],
    );
    expect((await read(out.bytes)).pages).toEqual([
      { width: 100, rotate: 180 },
      { width: 100, rotate: 0 },
      { width: 110, rotate: 270 },
    ]);
    expect(out.report.steps).toEqual(['pdfjs.extractPages', 'compose.rotate', 'save']);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.compose.rotation');
  });

  it('says a repeated page repeats the outline and a plain composition does not', async () => {
    const withOutline = await pages(2);
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(withOutline.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    const outlines = doc.newDictionary();
    const item = doc.addObject({
      Title: doc.newString('Giriş'),
      Dest: [doc.findPage(0), doc.newName('Fit')],
    });
    outlines.put('Type', doc.newName('Outlines'));
    outlines.put('First', item);
    outlines.put('Last', item);
    doc.getTrailer().get('Root').put('Outlines', doc.addObject(outlines));
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const repeated = await withHandle(bytes, (handle) =>
      composeDocument({ sources: [{ pages: [0, 0] }], pageCount: 2 }, handle.raw, run),
    );
    expect(
      repeated.report.notes.find((entry) => entry.key === 'op.note.compose.outlineCopies')?.params,
    ).toEqual({ copies: 2 });
    const once = await withHandle(bytes, (handle) =>
      composeDocument({ sources: [{ pages: [0, 1] }], pageCount: 2 }, handle.raw, run),
    );
    expect(once.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.outlineCopies');
    const bare = await compose({ sources: [{ pages: [0, 0] }], pageCount: 2 });
    expect(bare.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.outlineCopies');
  });

  it('composes from a source that is another document, leaving the base out of the report', async () => {
    const other = await pages(2);
    const out = await compose({ sources: [{ bytes: other, pages: [1, 0] }], pageCount: 2 });
    expect((await read(out.bytes)).pages.map((page) => page.width)).toEqual([110, 100]);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.storage');
    expect(out.report.inputBytes).toBeGreaterThan(other.length);
  });

  it('reports the base data length only when the handle can say, and counts the sources alone when it cannot', async () => {
    const base = await pages(2);
    await withHandle(base, async (handle) => {
      const options: ComposeOptions = { sources: [{ pages: [0] }], pageCount: 1 };
      const bare: PdfComposeHandle = Object.create(handle.raw, { getDownloadInfo: { value: undefined } });
      expect((await composeDocument(options, bare, run)).report.inputBytes).toBe(0);
      const failing: PdfComposeHandle = Object.create(handle.raw, {
        getDownloadInfo: { value: () => Promise.reject(new Error('gone')) },
      });
      expect((await composeDocument(options, failing, run)).report.inputBytes).toBe(0);
      const full = await composeDocument(options, handle.raw, run);
      expect(full.report.inputBytes).toBe(base.length);
    });
  });

  it('refuses a composition the engine cannot produce', async () => {
    const handle: PdfComposeHandle = { numPages: 1, extractPages: async () => null };
    const error = await refusal(composeDocument({ sources: [{ pages: [0] }], pageCount: 1 }, handle, run));
    expect(error.code).toBe('verification-failed');
    expect(error.details.engine).toBe('pdfjs');
  });

  it('refuses a turned composition whose page count is not the planned one', async () => {
    const two = await pages(2);
    const handle: PdfComposeHandle = { numPages: 2, extractPages: async () => two };
    const error = await refusal(
      composeDocument({ sources: [{ pages: [0], rotations: { 0: 90 } }], pageCount: 1 }, handle, run),
    );
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe('composed document has 2 pages, expected 1');
  });

  it('stops at an aborted signal, before the call and between turned pages', async () => {
    const before = new AbortController();
    before.abort();
    await withHandle(await pages(3), async (handle) => {
      await expect(
        composeDocument({ sources: [{ pages: [0] }], pageCount: 1 }, handle.raw, { signal: before.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      const midway = new AbortController();
      await expect(
        composeDocument(
          { sources: [{ pages: [0, 1, 2], rotations: { 0: 90, 1: 90, 2: 90 } }], pageCount: 3 },
          handle.raw,
          { signal: midway.signal, onProgress: (event) => event.phase === 'rotate' && midway.abort() },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      const extracting = new AbortController();
      await expect(
        composeDocument({ sources: [{ pages: [0] }], pageCount: 1 }, handle.raw, {
          signal: extracting.signal,
          onProgress: () => extracting.abort(),
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});

describe('composeDocument across sources and odd outlines', () => {
  it('interleaves pages of the base and of another document by output position', async () => {
    const other = await pages(2);
    const out = await compose({
      sources: [
        { pages: [0, 2], positions: [0, 2] },
        { bytes: other, pages: [1, 0], positions: [3, 1] },
      ],
      pageCount: 4,
    });
    expect((await read(out.bytes)).pages.map((page) => page.width)).toEqual([100, 100, 120, 110]);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.compose.storage');
  });

  it('adds a turn to a composed page whose own dictionary has no /Rotate', async () => {
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument((await pages(1)).slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    doc.findPage(0).delete('Rotate');
    const composed = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const stub: PdfComposeHandle = { numPages: 1, extractPages: async () => composed };
    const out = await composeDocument(
      { sources: [{ pages: [0], rotations: { 0: 90 } }], pageCount: 1 },
      stub,
      run,
    );
    expect((await read(out.bytes)).pages).toEqual([{ width: 100, rotate: 90 }]);
  });

  it.each([
    ['no outline', null, false],
    ['an empty outline', [], false],
    ['entries that are not outline nodes', [null, 5, { items: 'x' }], true],
    ['a nested outline', [{ items: [{ items: [{}] }] }], true],
  ])('reads %s without trusting its shape', async (_name, outline, repeated) => {
    await withHandle(await pages(2), async (handle) => {
      const stub: PdfComposeHandle = Object.create(handle.raw, {
        getOutline: { value: async () => outline },
      });
      const out = await composeDocument({ sources: [{ pages: [0, 0] }], pageCount: 2 }, stub, run);
      expect(out.report.notes.map((entry) => entry.key).includes('op.note.compose.outlineCopies')).toBe(
        repeated,
      );
    });
  });

  it('stops counting an outline that is absurdly deep or wide, and still reports it', async () => {
    let deep: unknown = {};
    for (let level = 0; level < 60; level += 1) deep = { items: [deep] };
    const wide = Array.from({ length: 20_005 }, () => ({}));
    for (const outline of [[deep], wide]) {
      await withHandle(await pages(2), async (handle) => {
        const stub: PdfComposeHandle = Object.create(handle.raw, {
          getOutline: { value: async () => outline },
        });
        const out = await composeDocument({ sources: [{ pages: [0, 0] }], pageCount: 2 }, stub, run);
        expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.compose.outlineCopies');
      });
    }
  });
});

describe('mergeDocuments refuses and measures', () => {
  it.each([[-2], [1.5], [Number.NaN]])('refuses an insertion point of %s', async (insertAfter) => {
    const error = await refusal(
      mergeDocuments({ bytes: await pages(1), pageCount: 1 }, [], insertAfter, run),
    );
    expect(error.code).toBe('range-invalid');
  });

  it('reads a base document whose XMP packet is blank as having none', async () => {
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(
      (await pages(1, [], 'Boş')).slice(),
      'application/pdf',
    ).asPDF();
    if (doc === null) throw new Error('not a PDF');
    doc
      .getTrailer()
      .get('Root')
      .put('Metadata', doc.addRawStream('   ', { Type: 'Metadata', Subtype: 'XML' }));
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const out = await mergeDocuments(
      { bytes, pageCount: 1 },
      [{ name: 'a.pdf', bytes: await pages(1), pageCount: 1 }],
      0,
      run,
    );
    expect((await read(out.bytes)).xmp).toBe(false);
  });

  it('refuses a merge of nothing', async () => {
    const error = await refusal(mergeDocuments({ bytes: await pages(1), pageCount: 0 }, [], 0, run));
    expect(error.details.engineMessage).toBe('nothing to merge');
  });

  it('refuses a document the engine cannot merge', async () => {
    const error = await refusal(
      mergeDocuments(
        { bytes: await pages(1), pageCount: 1 },
        [{ name: 'bozuk.pdf', bytes: new Uint8Array([1, 2, 3]), pageCount: 1 }],
        0,
        run,
      ),
    );
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe('extractPages produced no document for the merge');
  });

  it('puts documents in front of the base with -1, in the order they were given', async () => {
    const out = await mergeDocuments(
      { bytes: await pages(1), pageCount: 1 },
      [
        { name: 'a.pdf', bytes: await pages(2), pageCount: 2 },
        { name: 'b.pdf', bytes: await pages(3), pageCount: 3 },
      ],
      -1,
      run,
    );
    expect((await read(out.bytes)).pages.map((page) => page.width)).toEqual([100, 110, 100, 110, 120, 100]);
    expect(out.report.pageCount).toBe(6);
  });

  it('stops at an aborted signal', async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      mergeDocuments({ bytes: await pages(1), pageCount: 1 }, [], 0, { signal: before.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const merging = new AbortController();
    await expect(
      mergeDocuments(
        { bytes: await pages(1), pageCount: 1 },
        [{ name: 'a.pdf', bytes: await pages(1), pageCount: 1 }],
        0,
        {
          signal: merging.signal,
          onProgress: () => merging.abort(),
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('counts the outline items and form fields the merged file carries', async () => {
    const mupdf = await import('mupdf');
    const source = await pages(2, [], 'Rapor');
    const doc = mupdf.PDFDocument.openDocument(source.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    const root = doc.getTrailer().get('Root');
    const child = doc.addObject({ Title: doc.newString('Alt'), Dest: [doc.findPage(1), doc.newName('Fit')] });
    const second = doc.addObject({
      Title: doc.newString('İkinci'),
      Dest: [doc.findPage(1), doc.newName('Fit')],
    });
    const first = doc.addObject({
      Title: doc.newString('Giriş'),
      Dest: [doc.findPage(0), doc.newName('Fit')],
      First: child,
      Last: child,
      Next: second,
    });
    root.put('Outlines', doc.addObject({ Type: doc.newName('Outlines'), First: first, Last: second }));
    const field = doc.addObject({
      FT: doc.newName('Tx'),
      T: doc.newString('ad'),
      Subtype: doc.newName('Widget'),
      Rect: [0, 0, 10, 10],
    });
    doc.findPage(0).put('Annots', [field]);
    root.put('AcroForm', { Fields: [field] });
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const out = await mergeDocuments(
      { bytes, pageCount: 2 },
      [{ name: 'ek.pdf', bytes: await pages(1), pageCount: 1 }],
      1,
      run,
    );
    expect(out.report.notes.find((entry) => entry.key === 'op.note.merge.structure')?.params).toMatchObject({
      outline: 3,
      fields: 1,
    });
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.merge.outlineLost');
  });
});
