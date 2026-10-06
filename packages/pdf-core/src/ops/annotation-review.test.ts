/**
 * Comment replies and review states, written with MuPDF and read back by two independent
 * readers (MuPDF's object model, pdf.js). The wrong answers that matter: a reply that
 * does not point at its comment (`/IRT`), a state record that shows on the page (it must
 * be Hidden, flags 30), a reply written under a comment that is not on the page or under
 * a popup/widget/link, and a state the thread reader does not see as the comment's own.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { loadPdfjs, openWithPdfjs } from '../engines/pdfjs-handle';
import { writeCommentReview } from './annotation-review';
import { commentThreads } from './annotation-threads';
import { type ExistingAnnotation, readAnnotations, referenceOf } from './annotations';

const pdfjs = await loadPdfjs();
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve('pdfjs-dist/build/pdf.worker.mjs'),
).href;

const run = { signal: new AbortController().signal };

interface Fixture {
  readonly bytes: Uint8Array;
  readonly note: string;
  readonly popup: string;
  readonly link: string;
  readonly widget: string;
}

/** One 400×500 page with a red sticky note at (100, 300) and a popup, a link and a widget. */
async function fixture(): Promise<Fixture> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  const page = doc.findPage(0);
  const annotation = (extra: Record<string, unknown>): PDFObject =>
    doc.addObject({ Type: 'Annot', P: page, ...extra });
  const note = annotation({
    Subtype: 'Text',
    Rect: [100, 300, 124, 324],
    Contents: doc.newString('Kontrol et'),
    T: doc.newString('Ayşe'),
    C: [1, 0, 0],
    F: 4,
  });
  const popup = annotation({ Subtype: 'Popup', Rect: [200, 300, 300, 400], Parent: note });
  const link = annotation({ Subtype: 'Link', Rect: [10, 10, 60, 30] });
  const widget = annotation({ Subtype: 'Widget', FT: 'Tx', T: doc.newString('f'), Rect: [10, 40, 90, 60] });
  page.put('Annots', [note, popup, link, widget]);
  const ids = {
    note: referenceOf(note),
    popup: referenceOf(popup),
    link: referenceOf(link),
    widget: referenceOf(widget),
  };
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return { bytes, ...ids };
}

const base = { pageIndex: 0, author: 'Mehmet', createdAt: '2026-10-01T09:30:00.000Z' } as const;

async function annotationsOf(bytes: Uint8Array): Promise<readonly ExistingAnnotation[]> {
  const handle = await openWithPdfjs(bytes);
  try {
    return await readAnnotations(handle, run);
  } finally {
    await handle.destroy();
  }
}

describe('writeCommentReview', () => {
  it('writes a reply and a state record that MuPDF reads as /IRT Text annotations with the right flags', async () => {
    const { bytes, note } = await fixture();
    const out = await writeCommentReview(
      bytes,
      [
        { ...base, kind: 'reply', parentId: note, id: 'r1', contents: 'Düzelttim: şişli ığüöç' },
        { ...base, kind: 'state', parentId: note, id: 's1', state: 'Accepted' },
      ],
      run,
    );
    expect(out.written).toEqual(['r1', 's1']);

    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const annots = doc.findPage(0).get('Annots').resolve();
      expect(annots.length).toBe(6);
      const named = (nm: string) => {
        for (let index = 0; index < annots.length; index += 1) {
          const dict = annots.get(index).resolve();
          if (!dict.get('NM').isNull() && dict.get('NM').asString() === nm) return dict;
        }
        throw new Error(`no annotation named ${nm}`);
      };
      const parent = annots.get(0);
      const reply = named('r1');
      expect(reply.get('Subtype').asName()).toBe('Text');
      expect(reply.get('IRT').asIndirect()).toBe(parent.asIndirect());
      expect(reply.get('F').asNumber()).toBe(28);
      expect(reply.get('RT').isNull()).toBe(true);
      expect(reply.get('Contents').asString()).toBe('Düzelttim: şişli ığüöç');
      expect(reply.get('T').asString()).toBe('Mehmet');
      expect(reply.get('State').isNull()).toBe(true);
      // The record sits at the top-left icon square of the comment it answers, in its colour.
      const rect = [0, 1, 2, 3].map((index) => reply.get('Rect').get(index).asNumber());
      expect(rect).toEqual([100, 304, 120, 324]);
      expect([0, 1, 2].map((index) => reply.get('C').get(index).asNumber())).toEqual([1, 0, 0]);
      // Empty appearance: a reader that knows nothing of threads paints nothing for it.
      expect(reply.get('AP').get('N').readStream().getLength()).toBe(0);

      const state = named('s1');
      expect(state.get('IRT').asIndirect()).toBe(parent.asIndirect());
      expect(state.get('F').asNumber()).toBe(30);
      // Text strings, as ISO 32000-1 Table 172 defines them, not names.
      expect(state.get('State').isString()).toBe(true);
      expect(state.get('State').asString()).toBe('Accepted');
      expect(state.get('StateModel').isString()).toBe(true);
      expect(state.get('StateModel').asString()).toBe('Review');
      expect(state.get('Contents').asString()).toBe('Accepted set by Mehmet');
    } finally {
      doc.destroy();
    }
  });

  it('is read back by pdf.js as the same thread: the reply answers the comment, the state is its review', async () => {
    const { bytes, note } = await fixture();
    const out = await writeCommentReview(
      bytes,
      [
        { ...base, kind: 'reply', parentId: note, id: 'r1', contents: 'Tamam' },
        { ...base, kind: 'state', parentId: note, id: 's1', state: 'Rejected' },
      ],
      run,
    );
    const existing = await annotationsOf(out.bytes);
    const reply = existing.find((entry) => entry.contents === 'Tamam');
    const state = existing.find((entry) => entry.state === 'Rejected');
    expect(reply).toMatchObject({ subtype: 'Text', inReplyTo: note, replyType: 'R', author: 'Mehmet' });
    expect(state).toMatchObject({ inReplyTo: note, stateModel: 'Review' });

    const { threads, records } = commentThreads(existing);
    expect(records.size).toBe(2);
    const thread = threads.get(note);
    expect(thread?.replies.map((item) => item.annotation.contents)).toEqual(['Tamam']);
    expect(thread?.review).toMatchObject({ state: 'Rejected', author: 'Mehmet' });
  });

  it('still reads a state record an older file wrote with names as the comment review', async () => {
    const { bytes, note } = await fixture();
    const doc = openPdf(await loadMupdf(), bytes);
    let legacy: Uint8Array;
    try {
      const page = doc.findPage(0);
      const annots = page.get('Annots');
      annots.push(
        doc.addObject({
          Type: 'Annot',
          Subtype: 'Text',
          P: page,
          IRT: annots.get(0),
          Rect: [100, 304, 120, 324],
          F: 30,
          NM: doc.newString('old'),
          T: doc.newString('Mehmet'),
          State: 'Completed',
          StateModel: 'Review',
        }),
      );
      legacy = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    } finally {
      doc.destroy();
    }
    const existing = await annotationsOf(legacy);
    expect(existing.find((entry) => entry.state === 'Completed')).toMatchObject({
      inReplyTo: note,
      stateModel: 'Review',
    });
    expect(commentThreads(existing).threads.get(note)?.review).toMatchObject({ state: 'Completed' });
  });

  it('refuses a comment that is not on the page, and a popup, link or widget as the parent', async () => {
    const { bytes, popup, link, widget } = await fixture();
    const attempt = (parentId: string, pageIndex = 0) =>
      writeCommentReview(
        bytes,
        [{ ...base, pageIndex, kind: 'reply', parentId, id: 'x', contents: 'hello' }],
        run,
      );
    await expect(attempt('999R')).rejects.toMatchObject({ code: 'selection-empty' });
    for (const id of [popup, link, widget]) {
      await expect(attempt(id)).rejects.toMatchObject({ code: 'unsupported' });
    }
    await expect(attempt(popup, 5)).rejects.toMatchObject({ code: 'range-invalid' });
    await expect(writeCommentReview(bytes, [], run)).rejects.toMatchObject({ code: 'selection-empty' });
  });
});
