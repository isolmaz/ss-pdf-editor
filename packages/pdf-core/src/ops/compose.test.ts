/**
 * Composition and merge against real bytes and the real pdf.js `extractPages`. The wrong
 * answers that matter: a requested turn that replaces the page's own `/Rotate` instead of
 * adding to it, a page landing at the wrong position, a merge that drops the base
 * document's title or XMP packet, and a merged file without the product producer line.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { PRODUCER_LINE } from '../engines/mupdf-write';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import {
  type ComposeOptions,
  composeDocument,
  countOutlineItems,
  mergeDocuments,
  type PdfComposeHandle,
} from './compose';
import { readPageLabels } from './page-labels';

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

/** One /PageLabels rule: first page, the PDF style letter (`D`, `r`, `A`…), prefix and start value. */
type LabelRule = readonly [page: number, style: string, prefix?: string, start?: number];

/** `pages()` that also carries a /PageLabels plan. */
async function labelled(count: number, rules: readonly LabelRule[]): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument((await pages(count)).slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    for (const [page, style, prefix, start] of rules) doc.setPageLabels(page, style, prefix, start);
    return new Uint8Array(doc.saveToBuffer('').asUint8Array());
  } finally {
    doc.destroy();
  }
}

/** Four pages labelled `i, ii, 1, 2`. */
const frontMatter = () =>
  labelled(4, [
    [0, 'r'],
    [2, 'D'],
  ]);

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
});

describe('countOutlineItems', () => {
  it.each([
    ['no outline', null, 0],
    ['an empty outline', [], 0],
    ['entries that are not outline nodes', [null, 5, { items: 'x' }], 3],
    ['a nested outline', [{ items: [{ items: [{}] }] }], 3],
  ])('reads %s without trusting its shape', (_name, outline, count) => {
    expect(countOutlineItems(outline)).toBe(count);
  });

  it('stops counting an outline that is absurdly deep or wide', () => {
    let deep: unknown = {};
    for (let level = 0; level < 60; level += 1) deep = { items: [deep] };
    const wide = Array.from({ length: 20_005 }, () => ({}));
    expect(countOutlineItems([deep])).toBeLessThan(60);
    expect(countOutlineItems(wide)).toBeLessThanOrEqual(20_001);
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

/** Re-save `bytes` with owner-password encryption only: it opens without a password. */
async function ownerLocked(bytes: Uint8Array): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  const locked = new Uint8Array(
    doc.saveToBuffer('encrypt=aes-256,owner-password=sahip,permissions=-3904').asUint8Array(),
  );
  doc.destroy();
  return locked;
}

describe('mergeDocuments and password protection', () => {
  const dropped = 'op.note.merge.encryptionDropped';

  it.each([
    ['the base', true, false],
    ['an added document', false, true],
  ])('says the protection is not carried over when %s is encrypted', async (_name, lockBase, lockOther) => {
    const base = lockBase ? await ownerLocked(await pages(1)) : await pages(1);
    const other = lockOther ? await ownerLocked(await pages(1)) : await pages(1);
    const out = await mergeDocuments(
      { bytes: base, pageCount: 1 },
      [{ name: 'ek.pdf', bytes: other, pageCount: 1 }],
      0,
      run,
    );
    const note = out.report.notes.find((entry) => entry.key === dropped);
    expect(note?.kind).toBe('lost');
    expect(new TextDecoder('latin1').decode(out.bytes)).not.toContain('/Encrypt');
  });

  it('adds no such note when no merged document is encrypted', async () => {
    const out = await mergeDocuments(
      { bytes: await pages(1), pageCount: 1 },
      [{ name: 'ek.pdf', bytes: await pages(1), pageCount: 1 }],
      0,
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).not.toContain(dropped);
  });
});

// ---------------------------------------------------------------------------
// a duplicated page keeps its links and does not repeat the outline
// ---------------------------------------------------------------------------

/**
 * Four pages (widths 100…130). Page 1 holds three internal links to pages 2–4 (the last
 * through a `/A` GoTo action), one URI link and a text note; every page has one bookmark.
 * `urlBookmark` adds a bookmark that points at no page; `nested` hangs a child under the bookmark of page 2
 * that targets page 3; `named` makes every bookmark and link reach its page through a named destination
 * (`/Names /Dests` and a string `/Dest`, the way hyperref, Word and InDesign write them); `mixed` (with
 * `nested`) names the page of only the headings or only the child that way, the other one by page array.
 */
async function linkedPages(
  options: {
    urlBookmark?: boolean;
    remoteBookmark?: boolean;
    nested?: boolean;
    named?: boolean;
    mixed?: 'named-heading' | 'named-child';
  } = {},
): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument((await pages(4)).slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  if (options.named === true || options.mixed !== undefined) {
    const names = doc.newArray();
    for (let index = 0; index < 4; index += 1) {
      names.push(doc.newString(`chap${index + 1}`));
      names.push(doc.newArray());
      names.get(index * 2 + 1).push(doc.findPage(index));
      names.get(index * 2 + 1).push(doc.newName('Fit'));
    }
    doc
      .getTrailer()
      .get('Root')
      .put('Names', doc.addObject({ Dests: { Names: names } }));
  }
  const byName = (index: number) => doc.newString(`chap${index + 1}`);
  const byPage = (index: number) => [doc.findPage(index), doc.newName('Fit')];
  const target = options.named === true ? byName : byPage;
  const headingTarget = options.named === true || options.mixed === 'named-heading' ? byName : byPage;
  const childTarget = options.named === true || options.mixed === 'named-child' ? byName : byPage;
  const annots = doc.newArray();
  for (const [row, index] of [1, 2].entries()) {
    annots.push(
      doc.addObject({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [10, 10 + row * 20, 60, 25 + row * 20],
        Dest: target(index),
      }),
    );
  }
  annots.push(
    doc.addObject({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 50, 60, 65],
      A: { S: doc.newName('GoTo'), D: target(3) },
    }),
  );
  annots.push(
    doc.addObject({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 70, 60, 85],
      A: { S: doc.newName('URI'), URI: doc.newString('https://example.com/') },
    }),
  );
  annots.push(
    doc.addObject({ Type: 'Annot', Subtype: 'Text', Rect: [80, 10, 95, 25], Contents: doc.newString('not') }),
  );
  doc.findPage(0).put('Annots', doc.addObject(annots));
  const specs: BookmarkSpec[] = [0, 1, 2, 3].map((index) => ({
    title: `BM-Pg${index + 1}`,
    entry: { Dest: headingTarget(index) },
    children:
      index === 1 && options.nested === true ? [{ title: 'Sub', entry: { Dest: childTarget(2) } }] : [],
  }));
  if (options.urlBookmark === true) {
    specs.push({
      title: 'Site',
      entry: { A: { S: doc.newName('URI'), URI: doc.newString('https://example.com/') } },
    });
  }
  if (options.remoteBookmark === true) {
    // A link into page 2 of another file: MuPDF answers page 1 for it, which is a copy's position.
    specs.push({
      title: 'Remote',
      entry: {
        A: { S: doc.newName('GoToR'), F: doc.newString('other.pdf'), D: [1, doc.newName('Fit')] },
      },
    });
  }
  putOutline(doc, specs);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** A bookmark to write: its title, the rest of its dictionary (`/Dest` or `/A`) and its children. */
interface BookmarkSpec {
  readonly title: string;
  readonly entry: Record<string, unknown>;
  readonly children?: readonly BookmarkSpec[];
}

/** Write `specs` as the outline of `doc`, every sibling list linked through `/Parent`, `/Prev` and `/Next`. */
function putOutline(doc: PDFDocument, specs: readonly BookmarkSpec[]): void {
  const link = (list: readonly BookmarkSpec[], parent: PDFObject): void => {
    const items = list.map((spec) => doc.addObject({ Title: doc.newString(spec.title), ...spec.entry }));
    let total = items.length;
    for (const [index, item] of items.entries()) {
      item.put('Parent', parent);
      if (index > 0) item.put('Prev', items[index - 1]);
      if (index < items.length - 1) item.put('Next', items[index + 1]);
      const children = list[index]?.children ?? [];
      if (children.length > 0) {
        link(children, item);
        total += item.get('Count').asNumber();
      }
    }
    parent.put('First', items[0]);
    parent.put('Last', items.at(-1));
    parent.put('Count', total);
  };
  const root = doc.addObject({ Type: doc.newName('Outlines') });
  link(specs, root);
  doc.getTrailer().get('Root').put('Outlines', root);
}

/** The bookmarks (title and target page) and, per page, each link (rect and target) plus the note count. */
async function linkStructure(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const outline = (doc.loadOutline() ?? []).map((node) => ({
      title: node.title,
      page: node.page,
      children: node.down?.map((child) => ({ title: child.title, page: child.page })),
    }));
    const links = Array.from({ length: doc.countPages() }, (_unused, index) =>
      doc
        .loadPage(index)
        .getLinks()
        .map((link) => ({
          rect: [...link.getBounds()],
          target: link.isExternal() ? link.getURI() : doc.resolveLink(link),
        })),
    );
    const notes = Array.from({ length: doc.countPages() }, (_unused, index) => {
      const annots = doc.findPage(index).get('Annots');
      let count = 0;
      for (let at = 0; at < annots.length; at += 1) {
        if (annots.get(at).resolve().get('Subtype').asName() === 'Text') count += 1;
      }
      return count;
    });
    return { outline, links, notes };
  } finally {
    doc.destroy();
  }
}

/** The four links page 1 holds, with the page index each internal one should reach. */
function expectedLinks(first: number, second: number, third: number) {
  return [
    { rect: [10, 175, 60, 190], target: first },
    { rect: [10, 155, 60, 170], target: second },
    { rect: [10, 135, 60, 150], target: third },
    { rect: [10, 115, 60, 130], target: 'https://example.com/' },
  ];
}

describe('composeDocument duplicates a page that holds links', () => {
  it('gives every copy of page 1 its links and leaves the outline as it was', async () => {
    const out = await withHandle(await linkedPages(), (handle) =>
      composeDocument({ sources: [{ pages: [0, 0, 1, 2, 3] }], pageCount: 5 }, handle.raw, run),
    );
    const result = await linkStructure(out.bytes);
    expect(result.outline).toEqual([
      { title: 'BM-Pg1', page: 0 },
      { title: 'BM-Pg2', page: 2 },
      { title: 'BM-Pg3', page: 3 },
      { title: 'BM-Pg4', page: 4 },
    ]);
    expect(result.links).toEqual([expectedLinks(2, 3, 4), expectedLinks(2, 3, 4), [], [], []]);
    expect(result.notes).toEqual([1, 1, 0, 0, 0]);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.outlineCopies');
    expect(out.report.steps).toEqual(['pdfjs.extractPages', 'save']);
  });

  it('keeps the outline and the links of a duplicated page whose bookmarks and links use named destinations', async () => {
    const out = await withHandle(await linkedPages({ named: true }), (handle) =>
      composeDocument({ sources: [{ pages: [0, 0, 1, 2, 3] }], pageCount: 5 }, handle.raw, run),
    );
    const result = await linkStructure(out.bytes);
    expect(result.outline).toEqual([
      { title: 'BM-Pg1', page: 0 },
      { title: 'BM-Pg2', page: 2 },
      { title: 'BM-Pg3', page: 3 },
      { title: 'BM-Pg4', page: 4 },
    ]);
    expect(result.links).toEqual([expectedLinks(2, 3, 4), expectedLinks(2, 3, 4), [], [], []]);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.outlineCopies');
  });

  it('keeps the outline of a duplicated page that holds no links', async () => {
    const out = await withHandle(await linkedPages(), (handle) =>
      composeDocument({ sources: [{ pages: [0, 1, 1, 2, 3] }], pageCount: 5 }, handle.raw, run),
    );
    const result = await linkStructure(out.bytes);
    expect(result.outline).toEqual([
      { title: 'BM-Pg1', page: 0 },
      { title: 'BM-Pg2', page: 1 },
      { title: 'BM-Pg3', page: 3 },
      { title: 'BM-Pg4', page: 4 },
    ]);
    expect(result.links).toEqual([expectedLinks(1, 3, 4), [], [], [], []]);
  });

  it('copies the links onto every further copy and onto a copy whose engine copy kept some', async () => {
    const triple = await withHandle(await linkedPages(), (handle) =>
      composeDocument({ sources: [{ pages: [0, 0, 0, 1, 2, 3] }], pageCount: 6 }, handle.raw, run),
    );
    const three = await linkStructure(triple.bytes);
    expect(three.links).toEqual([
      expectedLinks(3, 4, 5),
      expectedLinks(3, 4, 5),
      expectedLinks(3, 4, 5),
      [],
      [],
      [],
    ]);
    expect(three.outline.map((node) => node.page)).toEqual([0, 3, 4, 5]);
    // Pages 1 and 2 repeated together: the engine keeps the copy's link to page 2 and aims it at
    // page 2's copy; the copy is made to point where the original does.
    const pair = await withHandle(await linkedPages(), (handle) =>
      composeDocument({ sources: [{ pages: [0, 1, 0, 1, 2, 3] }], pageCount: 6 }, handle.raw, run),
    );
    const both = await linkStructure(pair.bytes);
    expect(both.links).toEqual([expectedLinks(1, 4, 5), [], expectedLinks(1, 4, 5), [], [], []]);
    expect(both.outline.map((node) => node.page)).toEqual([0, 1, 4, 5]);
  });

  it('turns a copy and still keeps its links', async () => {
    const out = await withHandle(await linkedPages(), (handle) =>
      composeDocument(
        { sources: [{ pages: [0, 0, 1, 2, 3], rotations: { 1: 90 } }], pageCount: 5 },
        handle.raw,
        run,
      ),
    );
    expect(out.report.steps).toEqual(['pdfjs.extractPages', 'compose.rotate', 'save']);
    expect((await linkStructure(out.bytes)).links.map((list) => list.length)).toEqual([4, 4, 0, 0, 0]);
  });

  it('drops a heading whose only targets are copies, with its children, and keeps the nesting of the rest', async () => {
    const out = await withHandle(await linkedPages({ nested: true }), (handle) =>
      composeDocument({ sources: [{ pages: [0, 1, 2, 2, 3] }], pageCount: 5 }, handle.raw, run),
    );
    expect((await linkStructure(out.bytes)).outline).toEqual([
      { title: 'BM-Pg1', page: 0 },
      { title: 'BM-Pg2', page: 1, children: [{ title: 'Sub', page: 2 }] },
      { title: 'BM-Pg3', page: 2 },
      { title: 'BM-Pg4', page: 4 },
    ]);
    const first = await withHandle(await linkedPages({ nested: true }), (handle) =>
      composeDocument({ sources: [{ pages: [0, 1, 1, 2, 3] }], pageCount: 5 }, handle.raw, run),
    );
    expect((await linkStructure(first.bytes)).outline.map((node) => node.children?.[0]?.page)).toEqual([
      undefined,
      3,
      undefined,
      undefined,
    ]);
  });

  it('keeps the nesting of a named-destination outline when a nested target is duplicated', async () => {
    const bytes = await linkedPages({ nested: true, named: true });
    const out = await withHandle(bytes, (handle) =>
      composeDocument({ sources: [{ pages: [0, 1, 2, 2, 3] }], pageCount: 5 }, handle.raw, run),
    );
    expect((await linkStructure(out.bytes)).outline).toEqual([
      { title: 'BM-Pg1', page: 0 },
      { title: 'BM-Pg2', page: 1, children: [{ title: 'Sub', page: 2 }] },
      { title: 'BM-Pg3', page: 2 },
      { title: 'BM-Pg4', page: 4 },
    ]);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.outlineCopies');
  });

  // A heading and its child that name their pages by different mechanisms: a page array is valid
  // only in the copy entry that holds the page, a named destination in every entry. Copying a page
  // elsewhere then leaves, in the copy entry, either the heading without its destination (array
  // heading, named child) or the heading without its child (named heading, array child).
  describe.each(['named-child', 'named-heading'] as const)(
    'a heading and a child that name pages differently (%s)',
    (mixed) => {
      it.each([
        ['an unrelated page', [0, 0, 1, 2, 3]],
        ["the child's page", [0, 1, 2, 2, 3]],
        ["the heading's page", [0, 1, 1, 2, 3]],
      ])('leaves no stub of the outline when %s is duplicated', async (_name, plan) => {
        const out = await withHandle(await linkedPages({ nested: true, mixed }), (handle) =>
          composeDocument({ sources: [{ pages: plan }], pageCount: 5 }, handle.raw, run),
        );
        const at = (page: number) => plan.indexOf(page);
        expect((await linkStructure(out.bytes)).outline).toEqual([
          { title: 'BM-Pg1', page: at(0) },
          { title: 'BM-Pg2', page: at(1), children: [{ title: 'Sub', page: at(2) }] },
          { title: 'BM-Pg3', page: at(2) },
          { title: 'BM-Pg4', page: at(3) },
        ]);
        expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.outlineCopies');
      });
    },
  );

  it('keeps the outline of a named-destination document once for every further copy', async () => {
    const out = await withHandle(await linkedPages({ named: true }), (handle) =>
      composeDocument({ sources: [{ pages: [0, 0, 0, 1, 2, 3] }], pageCount: 6 }, handle.raw, run),
    );
    const result = await linkStructure(out.bytes);
    expect(result.outline.map((node) => [node.title, node.page])).toEqual([
      ['BM-Pg1', 0],
      ['BM-Pg2', 3],
      ['BM-Pg3', 4],
      ['BM-Pg4', 5],
    ]);
    expect(result.links.slice(0, 3)).toEqual([
      expectedLinks(3, 4, 5),
      expectedLinks(3, 4, 5),
      expectedLinks(3, 4, 5),
    ]);
  });

  it('keeps a bookmark that points at a URL or into another file once, not once per copy', async () => {
    const bytes = await linkedPages({ urlBookmark: true, remoteBookmark: true });
    const repeated = await withHandle(bytes, (handle) =>
      composeDocument({ sources: [{ pages: [0, 0, 1, 2, 3] }], pageCount: 5 }, handle.raw, run),
    );
    expect((await linkStructure(repeated.bytes)).outline.map((node) => node.title)).toEqual([
      'BM-Pg1',
      'BM-Pg2',
      'BM-Pg3',
      'BM-Pg4',
      'Site',
      'Remote',
    ]);
    expect(repeated.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.outlineCopies');
  });

  it('keeps every bookmark when nothing is repeated', async () => {
    const bytes = await linkedPages({ urlBookmark: true, named: true });
    const once = await withHandle(bytes, (handle) =>
      composeDocument({ sources: [{ pages: [0, 1, 2, 3] }], pageCount: 4 }, handle.raw, run),
    );
    expect((await linkStructure(once.bytes)).outline.map((node) => node.title)).toEqual([
      'BM-Pg1',
      'BM-Pg2',
      'BM-Pg3',
      'BM-Pg4',
      'Site',
    ]);
    expect(once.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.outlineCopies');
  });

  it('removes the copies and the repeats around a bookmark whose destination it cannot read, and says so', async () => {
    const stub = await stubWithOutline((doc) => [
      { title: 'Lost', entry: { Dest: doc.newString('nowhere') } },
      { title: 'Own', entry: { Dest: [doc.findPage(0), doc.newName('Fit')] } },
      { title: 'Own', entry: { Dest: [doc.findPage(1), doc.newName('Fit')] } },
      { title: 'Own', entry: { Dest: [doc.findPage(0), doc.newName('Fit')] } },
    ]);
    const out = await composeDocument({ sources: [{ pages: [0, 0] }], pageCount: 2 }, stub, run);
    expect((await linkStructure(out.bytes)).outline.map((node) => [node.title, node.page])).toEqual([
      ['Lost', undefined],
      ['Own', 0],
    ]);
    expect(out.report.notes.find((entry) => entry.key === 'op.note.compose.outlineCopies')?.params).toEqual({
      copies: 2,
    });
  });

  it('keeps a bookmark that only shares a title with an earlier one', async () => {
    const stub = await stubWithOutline((doc) => {
      const here = { Dest: [doc.findPage(0), doc.newName('Fit')] };
      return [
        { title: 'Same', entry: here, children: [{ title: 'Kid', entry: here }] },
        // A genuine action the engine kept whole: no page and no child, so no copy entry left it over.
        { title: 'Same', entry: { A: { S: doc.newName('Named'), N: doc.newName('NextPage') } } },
        { title: 'Same', entry: here, children: [{ title: 'Other', entry: here }] },
      ];
    });
    const out = await composeDocument({ sources: [{ pages: [0, 0] }], pageCount: 2 }, stub, run);
    expect((await linkStructure(out.bytes)).outline).toEqual([
      { title: 'Same', page: 0, children: [{ title: 'Kid', page: 0 }] },
      { title: 'Same', page: undefined },
      { title: 'Same', page: 0, children: [{ title: 'Other', page: 0 }] },
    ]);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.compose.outlineCopies');
  });

  it('says so when a bookmark is nested deeper than the bound it reads to', async () => {
    const stub = await stubWithOutline(() => {
      let chain: BookmarkSpec = { title: 'Deep', entry: {} };
      for (let level = 0; level < 40; level += 1) chain = { title: 'Deep', entry: {}, children: [chain] };
      return [chain];
    });
    const out = await composeDocument({ sources: [{ pages: [0, 0] }], pageCount: 2 }, stub, run);
    expect((await linkStructure(out.bytes)).outline.map((node) => node.title)).toEqual(['Deep']);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.compose.outlineCopies');
  });
});

/** A handle whose engine answers a two-page file with `build`'s bookmarks, as a composition of `[0, 0]` would. */
async function stubWithOutline(build: (doc: PDFDocument) => BookmarkSpec[]): Promise<PdfComposeHandle> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument((await pages(2)).slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  putOutline(doc, build(doc));
  const composed = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return { numPages: 1, extractPages: async () => composed };
}

describe('mergeDocuments keeps every page’s label', () => {
  // The rule under test: a page keeps the label its own document gave it — that document's
  // /PageLabels, or its decimal page number in that document when it has none.
  const merge = async (
    others: readonly Uint8Array[],
    insertAfter: number,
    base: Uint8Array | Promise<Uint8Array> = frontMatter(),
  ) => {
    const baseBytes = await base;
    const added = await Promise.all(
      others.map(async (bytes, index) => ({
        name: `ek${index}.pdf`,
        bytes,
        pageCount: (await read(bytes)).pages.length,
      })),
    );
    return mergeDocuments(
      { bytes: baseBytes, pageCount: (await read(baseBytes)).pages.length },
      added,
      insertAfter,
      run,
    );
  };
  const labelsOf = async (bytes: Uint8Array) => readPageLabels(bytes, (await read(bytes)).pages.length);
  const donor = () => labelled(2, [[0, 'D', 'Ek-', 10]]);

  it('keeps the base labels and the donor labels when a document is added at the end', async () => {
    const out = await merge([await donor()], 3);
    expect(await labelsOf(out.bytes)).toEqual(['i', 'ii', '1', '2', 'Ek-10', 'Ek-11']);
  });

  it('keeps the base labels when a document is added at the start', async () => {
    const out = await merge([await donor()], -1);
    expect(await labelsOf(out.bytes)).toEqual(['Ek-10', 'Ek-11', 'i', 'ii', '1', '2']);
  });

  it('keeps the base labels on both sides of a document added in the middle', async () => {
    const out = await merge([await donor()], 1);
    expect(await labelsOf(out.bytes)).toEqual(['i', 'ii', 'Ek-10', 'Ek-11', '1', '2']);
  });

  it('puts a document asked to go past the last page at the end', async () => {
    const out = await merge([await donor()], 99);
    expect(await labelsOf(out.bytes)).toEqual(['i', 'ii', '1', '2', 'Ek-10', 'Ek-11']);
  });

  it('numbers the pages of a document without labels within that document', async () => {
    const out = await merge([await pages(3)], 3);
    expect(await labelsOf(out.bytes)).toEqual(['i', 'ii', '1', '2', '1', '2', '3']);
  });

  it('keeps several added documents in the order they were given', async () => {
    const out = await merge([await donor(), await pages(3)], -1);
    expect(await labelsOf(out.bytes)).toEqual(['Ek-10', 'Ek-11', '1', '2', '3', 'i', 'ii', '1', '2']);
  });

  it('numbers the pages of a base without labels and keeps the labels of the added document', async () => {
    const out = await merge([await donor()], 0, pages(2));
    expect(await labelsOf(out.bytes)).toEqual(['1', 'Ek-10', 'Ek-11', '2']);
  });

  it('writes no labels when no document has any', async () => {
    const out = await merge([await pages(1)], 0, pages(2));
    expect(await labelsOf(out.bytes)).toEqual([]);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.merge.labels');
  });

  it('reports the labels it measured in the file, and says how they were numbered', async () => {
    const out = await merge([await donor()], 3);
    const notes = out.report.notes;
    // `i` (page 1), `1` (page 3) and `Ek-10` (page 5): the ranges the produced file holds.
    expect(notes.find((entry) => entry.key === 'op.note.merge.structure')?.params).toMatchObject({
      labels: 3,
    });
    expect(notes.find((entry) => entry.key === 'op.note.merge.labels')).toMatchObject({ kind: 'changed' });
    expect(notes.map((entry) => entry.key)).not.toContain('op.note.merge.labelsLost');
  });
});
