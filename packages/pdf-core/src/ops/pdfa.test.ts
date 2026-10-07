/**
 * Save as PDF/A end to end, with the real Ghostscript engine: one conversion to part 2b of a
 * small file (an unembedded standard font, device RGB colour), then the output read back by an
 * independent reader (MuPDF's object model and text extraction), not by the converter's own
 * verdict. The runs that need no engine (an already-compliant file, a locked one) share the
 * result of that conversion or stop before the engine starts.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { convertToPdfA } from './pdfa';
import { plain, rich, withUnreadableContent } from './pdfa.fixtures';
import { checkPdfA } from './pdfa-check';

const run = { signal: new AbortController().signal };

async function source(save = ''): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const content =
    '1 0 0 rg 20 20 80 40 re f\n0 g\n' +
    'BT /F 14 Tf 20 150 Td (Quarterly results were published today) Tj ET\n' +
    'BT /F 12 Tf 20 120 Td (Revenue grew while costs stayed flat) Tj ET';
  doc.insertPage(0, doc.addPage([0, 0, 300, 200], 0, { Font: { F: font } }, content));
  doc.getTrailer().put('Info', doc.addObject({ Title: doc.newString('Quarterly report') }));
  const bytes = new Uint8Array(doc.saveToBuffer(save).asUint8Array());
  doc.destroy();
  return bytes;
}

describe('convertToPdfA', () => {
  it('converts to PDF/A-2b, which an independent read confirms, keeps the text, and is then left alone', async () => {
    const input = await source();
    const outcome = await convertToPdfA(input, { part: 2 }, run);

    expect(outcome.converted).toBe(true);
    expect(outcome.report.engine).toBe('ghostscript');
    expect(outcome.report.steps).toEqual(['pdfa.prepare', 'pdfa.convert', 'pdfa.verify']);
    expect(outcome.report.pageCount).toBe(1);
    expect(outcome.source.verdict).toBe('no-claim');

    // The checker (run again here on the bytes returned) finds a PDF/A-2b claim and no violation.
    const check = await checkPdfA(outcome.bytes);
    expect(check.verdict).toBe('claims-and-meets');
    expect(check.claim).toEqual({ part: '2', conformance: 'B' });
    expect(check.violations).toBe(0);
    expect(outcome.check.violations).toBe(0);

    // Independent reading of the object model and the text.
    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, outcome.bytes);
    try {
      expect(doc.countPages()).toBe(1);
      const root = doc.getTrailer().get('Root');
      const packet = new TextDecoder().decode(root.get('Metadata').readStream().asUint8Array());
      expect(packet).toMatch(/pdfaid:part='2'/);
      expect(packet).toMatch(/pdfaid:conformance='B'/);
      expect(root.get('OutputIntents').get(0).resolve().get('S').asName()).toBe('GTS_PDFA1');
      expect(doc.getMetaData('info:Title')).toBe('Quarterly report');

      const page = doc.loadPage(0);
      const text = page.toStructuredText('preserve-whitespace').asText();
      expect(text).toContain('Quarterly results were published today');
      expect(text).toContain('Revenue grew while costs stayed flat');
    } finally {
      doc.destroy();
    }
    expect(outcome.measures.wordRecall).toBe(1);
    expect(outcome.measures.pictureDiffers).toEqual([]);
    expect(outcome.report.notes.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['op.note.pdfa.converted', 'op.note.pdfa.verified', 'op.note.pdfa.limits']),
    );

    // A file that already meets the part is returned as it is, without another rewrite.
    const again = await convertToPdfA(outcome.bytes, { part: 2 }, run);
    expect(again.converted).toBe(false);
    expect(again.bytes).toBe(outcome.bytes);
    expect(again.report.steps).toEqual(['pdfa.check']);
  });

  it('converts a file that claims the part but could not be fully checked, instead of calling it compliant', async () => {
    const compliant = (await convertToPdfA(await source(), { part: 2 }, run)).bytes;
    const damaged = await withUnreadableContent(compliant);
    const check = await checkPdfA(damaged);
    expect(check).toMatchObject({ verdict: 'claims-and-meets', violations: 0, targetFromClaim: true });
    expect(check.unchecked).toEqual(expect.arrayContaining(['fonts', 'device-colour']));

    const outcome = await convertToPdfA(damaged, { part: 2 }, run);
    expect(outcome.converted).toBe(true);
    expect(outcome.report.steps).toEqual(['pdfa.prepare', 'pdfa.convert', 'pdfa.verify']);
    expect(outcome.report.notes.map((entry) => entry.key)).not.toContain('op.note.pdfa.alreadyCompliant');
  });

  it('refuses a file that needs a password before the engine starts', async () => {
    const locked = await source('encrypt=aes-128,owner-password=o,user-password=u');
    await expect(convertToPdfA(locked, { part: 2 }, run)).rejects.toMatchObject({
      code: 'encrypted-unsupported',
    });
  });

  const keysOf = (notes: readonly { readonly key: string }[]) => notes.map((entry) => entry.key);

  it('converts to PDF/A-1b and tells what was flattened, removed, drawn, dropped and lost on the way', async () => {
    const progress: string[] = [];
    const outcome = await convertToPdfA(
      rich(),
      { part: 1 },
      {
        signal: run.signal,
        onProgress: (event) =>
          progress.push(`${event.phase}${event.done === undefined ? '' : `:${event.done}/${event.total}`}`),
      },
    );
    expect(progress).toEqual(['prepare', 'convert', 'convert:1/1', 'verify']);
    const notes = new Map(outcome.report.notes.map((entry) => [entry.key, entry.params]));
    expect(keysOf(outcome.report.notes)).toEqual([
      'op.note.pdfa.converted',
      'op.note.pdfa.colour',
      'op.note.pdfa.fontsSubstituted',
      'op.note.pdfa.transparencyFlattened',
      'op.note.pdfa.formsFlattened',
      'op.note.pdfa.widgetsRemoved',
      'op.note.pdfa.signatures',
      'op.note.pdfa.actionsRemoved',
      'op.note.pdfa.attachmentsRemoved',
      'op.note.pdfa.annotationsRemoved',
      'op.note.pdfa.printFlagged',
      'op.note.pdfa.appearancesDrawn',
      'op.note.pdfa.annotationsDropped',
      'op.note.pdfa.lost.tags',
      'op.note.pdfa.lost.layers',
      'op.note.pdfa.producer',
      'op.note.pdfa.textLoss',
      'op.note.pdfa.pictureKept',
      'op.note.pdfa.verified',
      'op.note.pdfa.limits',
    ]);
    expect(notes.get('op.note.pdfa.attachmentsRemoved')).toEqual({
      count: 2,
      names: 'f.txt, f.txt',
      level: 'PDF/A-1b',
    });
    expect(notes.get('op.note.pdfa.annotationsRemoved')).toEqual({
      count: 2,
      types: 'FileAttachment ×1, Sound ×1',
    });
    expect(notes.get('op.note.pdfa.annotationsDropped')).toEqual({ count: 2, types: 'Square ×1, Link ×1' });
    expect(notes.get('op.note.pdfa.producer')).toEqual({ producer: expect.stringContaining('Ghostscript') });
    // The constant alpha is flattened to a picture in part 1: the text is gone as text, and the report says so.
    expect(notes.get('op.note.pdfa.textLoss')).toEqual({ percent: '0 %', pages: '1' });
    expect(outcome.measures.textDiffers).toEqual([0]);
    expect(outcome.measures.wordRecall).toBe(0);
  });

  it('converts to PDF/A-3b keeping the attachments, and reports the text and picture as kept', async () => {
    const outcome = await convertToPdfA(rich(), { part: 3 }, run);
    expect(keysOf(outcome.report.notes)).toEqual([
      'op.note.pdfa.converted',
      'op.note.pdfa.colour',
      'op.note.pdfa.fontsSubstituted',
      'op.note.pdfa.formsFlattened',
      'op.note.pdfa.widgetsRemoved',
      'op.note.pdfa.signatures',
      'op.note.pdfa.actionsRemoved',
      'op.note.pdfa.attachmentsKept',
      'op.note.pdfa.annotationsRemoved',
      'op.note.pdfa.printFlagged',
      'op.note.pdfa.appearancesDrawn',
      'op.note.pdfa.lost.tags',
      'op.note.pdfa.producer',
      'op.note.pdfa.textKept',
      'op.note.pdfa.pictureKept',
      'op.note.pdfa.verified',
      'op.note.pdfa.limits',
    ]);
    const kept = outcome.report.notes.find((entry) => entry.key === 'op.note.pdfa.textKept');
    expect(kept?.params).toEqual({ percent: '100 %', pages: 1 });
    expect(outcome.measures.wordRecall).toBe(1);
    expect(outcome.measures.pictureDiffers).toEqual([]);
  });

  it('says so when the file was written with an owner password only, and has too few words to judge its text', async () => {
    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, plain({ text: 'Two words' }));
    const locked = new Uint8Array(
      doc.saveToBuffer('encrypt=aes-128,owner-password=o,user-password=').asUint8Array(),
    );
    doc.destroy();
    const outcome = await convertToPdfA(locked, { part: 2 }, run);
    const keys = keysOf(outcome.report.notes);
    expect(keys).toContain('op.note.pdfa.encryptionRemoved');
    expect(keys).not.toContain('op.note.pdfa.textKept');
    expect(keys).not.toContain('op.note.pdfa.textLoss');
    expect(outcome.measures.wordRecall).toBeNull();
    expect(outcome.measures.textDiffers).toEqual([]);
  });
});
