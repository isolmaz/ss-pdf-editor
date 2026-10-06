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
    // A second content stream MuPDF cannot decode (a predictor row width that overflows),
    // appended incrementally so the PDF/A claim and metadata stay as they were.
    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, compliant);
    let damaged: Uint8Array;
    try {
      const page = doc.findPage(0);
      const unreadable = doc.addRawStream(new Uint8Array([0x78, 0x9c, 3, 0, 0, 0, 0, 1]), {});
      unreadable.put('Filter', doc.newName('FlateDecode'));
      const parms = doc.newDictionary();
      parms.put('Predictor', 12);
      parms.put('Columns', 2147483647);
      parms.put('Colors', 32);
      parms.put('BitsPerComponent', 16);
      unreadable.put('DecodeParms', parms);
      const contents = doc.newArray();
      contents.push(page.get('Contents'));
      contents.push(unreadable);
      page.put('Contents', contents);
      damaged = new Uint8Array(doc.saveToBuffer('incremental').asUint8Array());
    } finally {
      doc.destroy();
    }

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
});
