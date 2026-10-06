/**
 * The pass before Ghostscript: the CMap that keeps a simple font's text mapping through the
 * rewrite, and what is removed or switched on in the document (script, annotations without the
 * Print flag, a missing `/ToUnicode`), read back from the produced bytes.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { prepareForPdfA, toUnicodeCMap } from './pdfa-prepare';

const run = { signal: new AbortController().signal };

async function fixture(options: { readonly save?: string } = {}): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const page = doc.addPage([0, 0, 200, 200], 0, { Font: { F: font } }, 'BT /F 12 Tf 20 100 Td (ABC) Tj ET');
  doc.insertPage(0, page);
  const link = doc.addObject({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [10, 10, 90, 30],
    F: 0,
    A: { S: 'JavaScript', JS: doc.newString('app.alert(1)') },
  });
  const sound = doc.addObject({ Type: 'Annot', Subtype: 'Sound', Rect: [100, 10, 120, 30], F: 4 });
  doc.findPage(0).put('Annots', [link, sound]);
  doc
    .getTrailer()
    .get('Root')
    .put('OpenAction', doc.addObject({ S: 'JavaScript', JS: doc.newString('app.alert(2)') }));
  const bytes = new Uint8Array(doc.saveToBuffer(options.save ?? '').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('toUnicodeCMap', () => {
  it('maps one-byte codes to UTF-16BE, writes astral points as surrogates and ignores wider codes', () => {
    const cmap = toUnicodeCMap(
      new Map([
        [0x42, 0x20ac],
        [0x41, 0x41],
        [0x43, 0x1f600],
        [0x100, 0x5a],
      ]),
    );
    expect(cmap).toContain('1 begincodespacerange\n<00> <FF>\nendcodespacerange');
    expect(cmap).toContain('3 beginbfchar\n<41> <0041>\n<42> <20ac>\n<43> <d83dde00>\nendbfchar');
    expect(cmap).not.toContain('<100>');
  });

  it('splits more than 100 mappings into blocks of at most 100', () => {
    const cmap = toUnicodeCMap(
      new Map(Array.from({ length: 250 }, (_, code) => [code, 0x100 + code] as const)),
    );
    expect([...cmap.matchAll(/^(\d+) beginbfchar$/gm)].map((match) => Number(match[1]))).toEqual([
      100, 100, 50,
    ]);
  });
});

describe('prepareForPdfA', () => {
  it('removes script, drops a forbidden annotation, sets Print and adds a ToUnicode, as the bytes read back', async () => {
    const prepared = await prepareForPdfA(await fixture(), 2, run);
    expect(prepared.counters).toMatchObject({
      actionsRemoved: 2,
      printFlagged: 1,
      toUnicodeAdded: 1,
      widgetsRemoved: 0,
      encryptionRemoved: false,
    });
    expect([...prepared.counters.annotationsRemoved]).toEqual([['Sound', 1]]);

    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, prepared.bytes);
    try {
      expect(doc.getTrailer().get('Root').get('OpenAction').isNull()).toBe(true);
      const annotations = doc.findPage(0).get('Annots');
      expect(annotations.length).toBe(1);
      const link = annotations.get(0).resolve();
      expect(link.get('Subtype').asName()).toBe('Link');
      expect(link.get('A').isNull()).toBe(true);
      expect(link.get('F').asNumber() & 4).toBe(4);
      const font = doc.findPage(0).get('Resources').get('Font').get('F').resolve();
      const map = new TextDecoder().decode(font.get('ToUnicode').readStream().asUint8Array());
      expect(map).toContain('<41> <0041>');
      expect(map).toContain('<43> <0043>');
    } finally {
      doc.destroy();
    }
  });

  it('refuses a file that needs a password and says an owner-password file was written unprotected', async () => {
    await expect(
      prepareForPdfA(await fixture({ save: 'encrypt=aes-128,owner-password=o,user-password=u' }), 2, run),
    ).rejects.toMatchObject({ code: 'encrypted-unsupported' });

    const owner = await prepareForPdfA(
      await fixture({ save: 'encrypt=aes-128,owner-password=o,user-password=' }),
      2,
      run,
    );
    expect(owner.counters.encryptionRemoved).toBe(true);
    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, owner.bytes);
    try {
      expect(doc.getTrailer().get('Encrypt').isNull()).toBe(true);
    } finally {
      doc.destroy();
    }
  });
});
