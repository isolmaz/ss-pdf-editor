/**
 * Link edits, against real bytes. The wrong answers that matter: a link drawn on a
 * rotated page that lands somewhere else in the file, a URL with a parenthesis that ends
 * its string early and breaks the file, a `javascript:` address written as a link, a
 * stale index that deletes a highlight, an edge-touching drag that removes a link, a
 * removed link whose object stays in the file, and a no-op that rewrites the document.
 */

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
