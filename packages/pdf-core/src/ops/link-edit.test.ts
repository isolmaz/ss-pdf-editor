/**
 * Link edits, against real bytes. The wrong answers that matter: a link drawn on a
 * rotated page that lands somewhere else in the file, a URL with a parenthesis that ends
 * its string early and breaks the file, a `javascript:` address written as a link, a
 * stale index that deletes a highlight, an edge-touching drag that removes a link, a
 * removed link whose object stays in the file, and a no-op that rewrites the document.
 */

import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { applyLinkEdit } from './link-edit';

const run = { signal: new AbortController().signal };

/**
 * Page 1: 200×300, `/Annots` = [link at [20 20 60 40], highlight, link at [100 100 150 150]].
 * Page 2: the same size, `/Rotate 90`. Page 3: `/Rotate 180`, no annotations.
 */
async function fixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (const rotate of [0, 90, 180] as const) {
    doc.insertPage(-1, doc.addPage([0, 0, 200, 300], rotate, {}, ''));
  }
  const first = doc.findPage(0);
  const annots = doc.newArray();
  annots.push(doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [20, 20, 60, 40], P: first }));
  annots.push(
    doc.addObject({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [20, 200, 120, 220],
      QuadPoints: [20, 220, 120, 220, 20, 200, 120, 200],
      P: first,
    }),
  );
  annots.push(doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [100, 100, 150, 150], P: first }));
  first.put('Annots', annots);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** pdf.js's view of one page's annotations: subtype, rect and URL. */
async function annotationsOn(bytes: Uint8Array, pageIndex: number) {
  const handle = await openWithPdfjs(bytes);
  try {
    const page = await handle.raw.getPage(pageIndex + 1);
    const annotations = (await page.getAnnotations()) as {
      subtype: string;
      rect: number[];
      url?: string;
    }[];
    return annotations.map((entry) => ({
      subtype: entry.subtype,
      rect: entry.rect.map((value) => Math.round(value * 100) / 100),
      ...(entry.url === undefined ? {} : { url: entry.url }),
    }));
  } finally {
    await handle.destroy();
  }
}

/** Object-level facts MuPDF reads: link objects left anywhere, and one page's `/Dest`. */
async function objects(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    let links = 0;
    for (let number = 1; number < doc.countObjects(); number += 1) {
      const object = doc.newIndirect(number).resolve();
      if (
        object.isDictionary() &&
        object.get('Subtype').isName() &&
        object.get('Subtype').asName() === 'Link'
      ) {
        links += 1;
      }
    }
    const pageNumbers = [0, 1, 2].map((index) => doc.findPage(index).asIndirect());
    const hasAnnots = [0, 1, 2].map((index) => !doc.findPage(index).get('Annots').isNull());
    const dests: unknown[][] = [];
    const uris: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const annots = doc.findPage(index).get('Annots');
      if (annots.isNull()) continue;
      const array = annots.resolve();
      for (let at = 0; at < array.length; at += 1) {
        const action = array.get(at).resolve().get('A');
        if (!action.isNull()) uris.push(action.resolve().get('URI').asString());
        const dest = array.get(at).resolve().get('Dest');
        if (dest.isNull()) continue;
        const entries = dest.resolve();
        const values: unknown[] = [];
        for (let k = 0; k < entries.length; k += 1) {
          const value = entries.get(k);
          values.push(
            value.isIndirect()
              ? `page ${pageNumbers.indexOf(value.asIndirect())}`
              : value.isName()
                ? value.asName()
                : value.isNumber()
                  ? value.asNumber()
                  : null,
          );
        }
        dests.push(values);
      }
    }
    return { links, hasAnnots, dests, uris };
  } finally {
    doc.destroy();
  }
}

const keys = (outcome: { readonly report: { readonly notes: readonly { readonly key: string }[] } }) =>
  outcome.report.notes.map((entry) => entry.key);

describe('applyLinkEdit', () => {
  it('writes a URI link on a rotated page where the drag was, with the address percent-encoded', async () => {
    const out = await applyLinkEdit(
      await fixture(),
      {
        add: [
          {
            target: { pageIndex: 1, rect: [10, 20, 60, 40] },
            destination: { kind: 'uri', uri: 'https://örnek.com.tr/a (b)?q=ğ' },
          },
        ],
      },
      run,
    );
    // `/Rotate 90`: displayed (u, v) → user (v, u), so [10 20 60 40] lands at [20 10 40 60].
    expect(await annotationsOn(out.bytes, 1)).toEqual([
      // pdf.js normalises the host it reads (punycode); the file holds what was written.
      { subtype: 'Link', rect: [20, 10, 40, 60], url: 'https://xn--rnek-4qa.com.tr/a%20(b)?q=%C4%9F' },
    ]);
    expect((await objects(out.bytes)).uris).toEqual(['https://%C3%B6rnek.com.tr/a%20(b)?q=%C4%9F']);
    expect(keys(out)).toContain('op.note.link.uriEncoded');
    expect(out.report.steps).toEqual(['load', 'link.add', 'producer', 'save', 'verify']);
  });

  it('writes a page link as an /XYZ destination converted through the target page rotation', async () => {
    const out = await applyLinkEdit(
      await fixture(),
      {
        add: [
          {
            target: { pageIndex: 0, rect: [10, 10, 50, 30] },
            destination: { kind: 'page', pageIndex: 2, x: 30, y: 40, zoom: 1.5 },
          },
          {
            target: { pageIndex: 0, rect: [60, 10, 90, 30] },
            destination: { kind: 'page', pageIndex: 99 },
          },
        ],
      },
      run,
    );
    // `/Rotate 180`: displayed (30, 40) → user (200 − 30, 40) = (170, 40). An index past
    // the end is clamped to the last page and reported.
    expect((await objects(out.bytes)).dests).toEqual([
      ['page 2', 'XYZ', 170, 40, 1.5],
      ['page 2', 'XYZ', null, null, null],
    ]);
    expect(keys(out)).toContain('op.note.link.destinationClamped');
  });

  it('writes a link on a /Rotate 270 page through the matching table row', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 300], 270, {}, ''));
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const out = await applyLinkEdit(
      bytes,
      {
        add: [
          {
            target: { pageIndex: 0, rect: [10, 20, 60, 40] },
            destination: { kind: 'uri', uri: 'https://example.com' },
          },
        ],
      },
      run,
    );
    // `/Rotate 270`: displayed (u, v) → user (200 − v, 300 − u): [10 20 60 40] → [160 240 180 290].
    expect((await annotationsOn(out.bytes, 0)).map((entry) => entry.rect)).toEqual([[160, 240, 180, 290]]);
  });

  it('refuses a script address before anything is written', async () => {
    await expect(
      applyLinkEdit(
        await fixture(),
        {
          add: [
            {
              target: { pageIndex: 0, rect: [0, 0, 10, 10] },
              destination: { kind: 'uri', uri: 'javascript:alert(1)' },
            },
          ],
        },
        run,
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('removes a link by index, never the highlight a stale index points at, and deletes its object', async () => {
    const out = await applyLinkEdit(
      await fixture(),
      { remove: [{ pageIndex: 0, annotationIndexes: [0, 1] }] },
      run,
    );
    expect((await annotationsOn(out.bytes, 0)).map((entry) => entry.subtype)).toEqual(['Highlight', 'Link']);
    expect((await objects(out.bytes)).links).toBe(1);
    expect(keys(out)).toContain('op.note.link.removeNotLink');
  });

  it('removes what a drag overlaps, not what it only touches, and drops the emptied /Annots', async () => {
    const input = await fixture();
    // Displayed space on an unrotated 300-high page: the link at user [20 20 60 40] is
    // displayed at [20 260 60 280]; this drag only touches its left edge.
    const touching = await applyLinkEdit(input, { remove: [{ pageIndex: 0, rect: [0, 260, 20, 280] }] }, run);
    expect(touching.bytes).toBe(input);
    expect(touching.report.incremental).toBe(true);

    const both = await applyLinkEdit(
      input,
      {
        remove: [
          { pageIndex: 0, rect: [0, 150, 200, 300] },
          { pageIndex: 0, annotationIndexes: [1] },
        ],
      },
      run,
    );
    expect((await annotationsOn(both.bytes, 0)).map((entry) => entry.subtype)).toEqual(['Highlight']);
    expect((await objects(both.bytes)).links).toBe(0);

    // A page whose only link goes keeps no empty /Annots array behind.
    const added = await applyLinkEdit(
      input,
      {
        add: [
          {
            target: { pageIndex: 2, rect: [10, 10, 50, 30] },
            destination: { kind: 'uri', uri: 'https://example.com' },
          },
        ],
      },
      run,
    );
    expect((await objects(added.bytes)).hasAnnots).toEqual([true, false, true]);
    const emptied = await applyLinkEdit(
      added.bytes,
      { remove: [{ pageIndex: 2, rect: [0, 0, 200, 300] }] },
      run,
    );
    expect((await objects(emptied.bytes)).hasAnnots).toEqual([true, false, false]);
  });

  it('hands back the input when a link would go on a page that does not exist', async () => {
    const input = await fixture();
    const out = await applyLinkEdit(
      input,
      {
        add: [
          {
            target: { pageIndex: 7, rect: [0, 0, 10, 10] },
            destination: { kind: 'uri', uri: 'https://example.com' },
          },
        ],
      },
      run,
    );
    expect(out.bytes).toBe(input);
    expect(keys(out)).toContain('op.note.link.targetMissing');
  });
});

// ---------------------------------------------------------------------------
// refusals, odd inputs and what a drag overlaps on every rotation
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

const box = { pageIndex: 0, rect: [10, 10, 50, 30] } as const;
const web = { kind: 'uri', uri: 'https://example.com' } as const;

describe('applyLinkEdit refuses a request it cannot honour, before writing', () => {
  it.each([
    [
      'a fractional target page',
      { add: [{ target: { pageIndex: 0.5, rect: box.rect }, destination: web }] },
      'value-out-of-range',
      'request.add[0].target.pageIndex',
      'page index must be an integer, got 0.5',
    ],
    [
      'a negative border width',
      { add: [{ target: box, destination: web, border: [0, 0, -1] as const }] },
      'value-out-of-range',
      'request.add[0].border[2]',
      'link border value must be a finite number ≥ 0, got -1',
    ],
    [
      'an infinite border radius',
      { add: [{ target: box, destination: web, border: [Number.POSITIVE_INFINITY, 0, 1] as const }] },
      'value-out-of-range',
      'request.add[0].border[0]',
      'got Infinity',
    ],
    [
      'a rect with no area',
      { add: [{ target: { pageIndex: 0, rect: [10, 10, 10, 30] as const }, destination: web }] },
      'selection-empty',
      'request.add[0].target.rect',
      'link rect has no area: [10, 10, 10, 30]',
    ],
    [
      'a fractional destination page',
      { add: [{ target: box, destination: { kind: 'page', pageIndex: 1.5 } as const }] },
      'value-out-of-range',
      'request.add[0].destination.pageIndex',
      'page index must be an integer, got 1.5',
    ],
    [
      'half of a destination point',
      { add: [{ target: box, destination: { kind: 'page', pageIndex: 1, x: 10 } as const }] },
      'unsupported',
      'request.add[0].destination',
      'a /XYZ destination point needs both x and y',
    ],
    [
      'a zero zoom',
      { add: [{ target: box, destination: { kind: 'page', pageIndex: 1, zoom: 0 } as const }] },
      'value-out-of-range',
      'request.add[0].destination.zoom',
      'link zoom must be a finite number > 0, got 0',
    ],
    [
      'a removal without a selector',
      { remove: [{ pageIndex: 0 }] },
      'unsupported',
      'request.remove[0]',
      'removal request carries neither annotation indexes nor a rect',
    ],
    [
      'a removal on a fractional page',
      { remove: [{ pageIndex: 0.5, annotationIndexes: [0] }] },
      'value-out-of-range',
      'request.remove[0].pageIndex',
      'page index must be an integer, got 0.5',
    ],
  ])('refuses %s', async (_name, request, code, path, message) => {
    const error = await refusal(applyLinkEdit(await fixture(), request, run));
    expect(error.code).toBe(code);
    expect(error.details.path).toBe(path);
    expect(error.details.engineMessage).toContain(message);
  });

  it.each([
    ['empty', '   ', 'link uri is empty'],
    [
      'carrying a control character',
      'https://exa\u0007mple.com',
      'link uri carries a control character (U+7)',
    ],
    ['carrying DEL', 'https://example.com/\u007f', 'link uri carries a control character (U+7F)'],
    ['without a scheme', 'example.com/path', 'link uri has no scheme; http:, https: or mailto: is required'],
    [
      'with a scheme outside the safe three',
      'ftp://example.com',
      'link uri scheme "ftp:" is not one of http:, https:, mailto:',
    ],
    [
      'with a script scheme in any case',
      'JavaScript:alert(1)',
      'link uri scheme "javascript:" is not one of',
    ],
  ])('refuses an address that is %s', async (_name, uri, message) => {
    const error = await refusal(
      applyLinkEdit(await fixture(), { add: [{ target: box, destination: { kind: 'uri', uri } }] }, run),
    );
    expect(error.code).toBe('unsupported');
    expect(error.details.path).toBe('request.add[0].destination.uri');
    expect(error.details.engineMessage).toContain(message);
  });
});

describe('applyLinkEdit on odd documents', () => {
  it('hands back the input, counting nothing, for an empty request', async () => {
    const input = await fixture();
    const out = await applyLinkEdit(input, {}, run);
    expect(out.bytes).toBe(input);
    expect(out.report.pageCount).toBe(0);
    expect(out.report.incremental).toBe(true);
  });

  it('encodes a non-ASCII address by its UTF-8 bytes and reports how many were encoded', async () => {
    const out = await applyLinkEdit(
      await fixture(),
      {
        add: [
          { target: box, destination: { kind: 'uri', uri: 'https://example.com/ç a' } },
          { target: box, destination: { kind: 'uri', uri: 'https://example.com/plain' } },
        ],
      },
      run,
    );
    expect((await objects(out.bytes)).uris).toContain('https://example.com/%C3%A7%20a');
    expect(out.report.notes.find((entry) => entry.key === 'op.note.link.uriEncoded')?.params).toEqual({
      count: 1,
    });
  });

  it('reads a page with no /MediaBox as Letter and no /Rotate as upright', async () => {
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument((await fixture()).slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    const page = doc.findPage(2);
    page.delete('MediaBox');
    page.delete('Rotate');
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const out = await applyLinkEdit(
      bytes,
      { add: [{ target: { pageIndex: 2, rect: [10, 10, 50, 30] }, destination: web }] },
      run,
    );
    // Letter is 612×792: a drag at the top-left of the display lands at the top of user space.
    expect(await annotationsOn(out.bytes, 2)).toEqual([
      { subtype: 'Link', rect: [10, 762, 50, 782], url: 'https://example.com/' },
    ]);
  });

  it('writes a link on a page with a /CropBox relative to the crop', async () => {
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument((await fixture()).slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    doc.findPage(2).put('CropBox', [10, 20, 110, 220]);
    doc.findPage(2).put('Rotate', 0);
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const out = await applyLinkEdit(
      bytes,
      { add: [{ target: { pageIndex: 2, rect: [0, 0, 30, 20] }, destination: web }] },
      run,
    );
    expect(await annotationsOn(out.bytes, 2)).toEqual([
      { subtype: 'Link', rect: [10, 200, 40, 220], url: 'https://example.com/' },
    ]);
  });

  it('clamps a destination page into the document and says so, and skips a target page it lacks', async () => {
    const out = await applyLinkEdit(
      await fixture(),
      {
        add: [
          { target: box, destination: { kind: 'page', pageIndex: 99 } },
          { target: box, destination: { kind: 'page', pageIndex: -4 } },
          { target: { pageIndex: 7, rect: box.rect }, destination: web },
        ],
      },
      run,
    );
    expect((await objects(out.bytes)).dests).toEqual([
      ['page 2', 'XYZ', null, null, null],
      ['page 0', 'XYZ', null, null, null],
    ]);
    const noteKeys = out.report.notes.map((entry) => entry.key);
    expect(noteKeys).toContain('op.note.link.destinationClamped');
    expect(noteKeys).toContain('op.note.link.targetMissing');
  });
});

describe('applyLinkEdit removal', () => {
  it('counts indexes that do not exist or are not links, and pages it lacks, as notes', async () => {
    const out = await applyLinkEdit(
      await fixture(),
      {
        remove: [
          { pageIndex: 0, annotationIndexes: [0, 1, 9, -1, 1.5] },
          { pageIndex: 2, annotationIndexes: [0] },
          { pageIndex: 8, annotationIndexes: [0] },
          { pageIndex: -1, rect: [0, 0, 10, 10] },
        ],
      },
      run,
    );
    const note = (key: string) => out.report.notes.find((entry) => entry.key === key)?.params;
    // Not found: 9, -1, 1.5, page 3's missing array, and the two missing pages. Not a link: the highlight.
    expect(note('op.note.link.removeNotFound')).toEqual({ count: 6 });
    expect(note('op.note.link.removeNotLink')).toEqual({ count: 1 });
    expect((await annotationsOn(out.bytes, 0)).map((entry) => entry.subtype)).toEqual(['Highlight', 'Link']);
  });

  it('removes nothing, and hands the input back, when every request misses', async () => {
    const input = await fixture();
    const out = await applyLinkEdit(input, { remove: [{ pageIndex: 5, annotationIndexes: [0] }] }, run);
    expect(out.bytes).toBe(input);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.link.nothing');
  });

  it('removes a link by a drag on a page turned a quarter or three, in display space', async () => {
    for (const rotate of [90, 270] as const) {
      const mupdf = await import('mupdf');
      const doc = mupdf.PDFDocument.openDocument((await fixture()).slice(), 'application/pdf').asPDF();
      if (doc === null) throw new Error('not a PDF');
      const page = doc.findPage(0);
      page.put('Rotate', rotate);
      const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
      doc.destroy();
      // Add a link by display rect, then drag the same display rect: the pair must agree.
      const added = await applyLinkEdit(
        bytes,
        { add: [{ target: { pageIndex: 0, rect: [150, 10, 190, 30] }, destination: web }] },
        run,
      );
      expect(await annotationsOn(added.bytes, 0)).toHaveLength(4);
      const removed = await applyLinkEdit(
        added.bytes,
        { remove: [{ pageIndex: 0, rect: [140, 5, 195, 35] }] },
        run,
      );
      expect(
        await annotationsOn(removed.bytes, 0).then((list) => list.map((entry) => entry.url ?? entry.subtype)),
      ).not.toContain('https://example.com/');
      expect(removed.report.notes.find((entry) => entry.key === 'op.note.link.removed')?.params).toEqual({
        count: 1,
      });
    }
  });

  it('removes a link listed directly in /Annots, and skips a link with no usable /Rect and entries that are not dictionaries', async () => {
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument((await fixture()).slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    const page = doc.findPage(2);
    const annots = doc.newArray();
    const direct = doc.newDictionary();
    direct.put('Type', 'Annot');
    direct.put('Subtype', 'Link');
    direct.put('Rect', [10, 10, 60, 60]);
    annots.push(direct);
    annots.push(doc.addObject({ Type: 'Annot', Subtype: 'Link' }));
    annots.push(doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [1, 2, 3] }));
    annots.push(doc.newNull());
    annots.push(doc.newInteger(7));
    page.put('Annots', annots);
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const out = await applyLinkEdit(bytes, { remove: [{ pageIndex: 2, rect: [0, 0, 200, 300] }] }, run);
    // Only the link with a usable rect is dragged out; the two without one stay.
    expect(out.report.notes.find((entry) => entry.key === 'op.note.link.removed')?.params).toEqual({
      count: 1,
    });
    const reopened = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (reopened === null) throw new Error('not a PDF');
    try {
      // The direct link is gone; the two links without a usable rect, the null and the integer stay.
      expect(reopened.findPage(2).get('Annots').resolve().length).toBe(4);
    } finally {
      reopened.destroy();
    }
  });

  it('reports progress and stops at an aborted signal', async () => {
    const phases: unknown[] = [];
    await applyLinkEdit(
      await fixture(),
      { remove: [{ pageIndex: 0, annotationIndexes: [0] }] },
      { ...run, onProgress: (event) => phases.push(event.labelKey) },
    );
    expect(phases).toContain('op.progress.link.remove');
    const controller = new AbortController();
    const input = await fixture();
    await expect(
      applyLinkEdit(
        input,
        {
          remove: [
            { pageIndex: 0, annotationIndexes: [0] },
            { pageIndex: 0, annotationIndexes: [2] },
          ],
        },
        { signal: controller.signal, onProgress: () => controller.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const before = new AbortController();
    before.abort();
    await expect(
      applyLinkEdit(input, { remove: [{ pageIndex: 0, annotationIndexes: [0] }] }, { signal: before.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
