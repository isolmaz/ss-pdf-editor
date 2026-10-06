/**
 * The font inventory, against real bytes. The wrong answers that matter: a font on a
 * page that inherits its resources from the page tree goes missing, a `Type0` font is
 * reported as not embedded because its file hangs on the descendant CIDFont, a font used
 * on two pages is listed twice, an encoding is invented where the document names none,
 * and a font without `/BaseFont` disappears instead of being listed under its key.
 */

import { describe, expect, it } from 'vitest';
import { listPdfFonts, type PdfFontInfo } from './pdf-fonts';

/**
 * Page 1 inherits `/Resources` from the page tree (Helvetica, a subset TrueType with a
 * `/BaseEncoding` dictionary, a `Type0` embedded through its descendant); page 2 has its
 * own resources (Helvetica again, indirect, and a font with neither `/BaseFont` nor a
 * named encoding).
 */
async function fixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const fontFile = doc.addStream('not a real font program', {});
  const helvetica = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const inherited = doc.addObject({
    Font: {
      F1: helvetica,
      F2: {
        Type: 'Font',
        Subtype: 'TrueType',
        BaseFont: 'ABCDEF+Gentium',
        Encoding: { Type: 'Encoding', BaseEncoding: 'MacRomanEncoding', Differences: [32, 'space'] },
        FontDescriptor: { Type: 'FontDescriptor', FontName: 'ABCDEF+Gentium', FontFile2: fontFile },
      },
      F3: {
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'NotoSans',
        Encoding: 'Identity-H',
        DescendantFonts: [
          {
            Type: 'Font',
            Subtype: 'CIDFontType2',
            BaseFont: 'NotoSans',
            FontDescriptor: { Type: 'FontDescriptor', FontName: 'NotoSans', FontFile2: fontFile },
          },
        ],
      },
    },
  });
  doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, {}, ''));
  doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, {}, ''));
  const first = doc.findPage(0);
  first.delete('Resources');
  doc.getTrailer().get('Root').resolve().get('Pages').resolve().put('Resources', inherited);
  doc.findPage(1).put(
    'Resources',
    doc.addObject({
      Font: {
        H: helvetica,
        X: { Type: 'Font', Subtype: 'Type3', Encoding: { Type: 'Encoding', Differences: [65, 'A'] } },
      },
    }),
  );
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const byName = (fonts: readonly PdfFontInfo[]) =>
  [...fonts].sort((left, right) => left.baseFont.localeCompare(right.baseFont));

describe('listPdfFonts', () => {
  it('lists every font once, with its pages, type, encoding and embedding as the file states them', async () => {
    expect(byName(await listPdfFonts(await fixture()))).toEqual([
      {
        baseFont: 'ABCDEF+Gentium',
        subtype: 'TrueType',
        embedded: true,
        encoding: 'MacRomanEncoding',
        subset: true,
        pages: [0],
      },
      {
        baseFont: 'Helvetica',
        subtype: 'Type1',
        embedded: false,
        encoding: 'WinAnsiEncoding',
        subset: false,
        pages: [0, 1],
      },
      {
        baseFont: 'NotoSans',
        subtype: 'Type0',
        embedded: true,
        encoding: 'Identity-H',
        subset: false,
        pages: [0],
      },
      { baseFont: 'X', subtype: 'Type3', embedded: false, encoding: null, subset: false, pages: [1] },
    ]);
  });

  it('stops at an aborted signal instead of finishing the walk', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(listPdfFonts(await fixture(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('answers an empty list for a document whose pages use no font', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    expect(await listPdfFonts(bytes)).toEqual([]);
  });
});
