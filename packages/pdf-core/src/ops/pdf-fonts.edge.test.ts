/**
 * The font inventory on font dictionaries a producer may write badly: encodings that are
 * dictionaries, CMap streams or Differences-only arrays, composite fonts with odd descendants,
 * fonts used on several pages, resources that are no dictionaries, more fonts than the list
 * allows, and a page tree MuPDF cannot walk.
 */

import { PDFDocument } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { handPdf } from './forms.fixtures';
import { listPdfFonts, MAX_FONTS } from './pdf-fonts';

function document(build: (doc: PDFDocument) => Record<string, unknown>[]): Uint8Array {
  const doc = new PDFDocument();
  const resourcesPerPage = build(doc);
  for (const [index, resources] of resourcesPerPage.entries()) {
    doc.insertPage(index, doc.addPage([0, 0, 100, 100], 0, resources as never, ''));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('listPdfFonts edge cases', () => {
  it('reads the encoding from a CMap stream, a base encoding, or nothing when only Differences are given', async () => {
    const bytes = document((doc) => {
      const cmap = doc.addStream('', { Type: 'CMap', CMapName: 'Identity-H' });
      return [
        {
          Font: {
            A: { Type: 'Font', Subtype: 'Type0', BaseFont: 'A', Encoding: cmap },
            B: {
              Type: 'Font',
              Subtype: 'Type1',
              BaseFont: 'B',
              Encoding: { BaseEncoding: 'MacRomanEncoding' },
            },
            C: { Type: 'Font', Subtype: 'Type1', BaseFont: 'C', Encoding: { Differences: [32, 'space'] } },
            D: { Type: 'Font', Subtype: 'Type1', BaseFont: 'D', Encoding: [1, 2] },
            E: { Type: 'Font', Subtype: 'Type1', BaseFont: 'E' },
          },
        },
      ];
    });
    const fonts = await listPdfFonts(bytes);
    expect(fonts.map((font) => [font.baseFont, font.encoding])).toEqual([
      ['A', 'Identity-H'],
      ['B', 'MacRomanEncoding'],
      ['C', null],
      ['D', null],
      ['E', null],
    ]);
  });

  it('judges a composite font by its descendants: a non-array, a non-dictionary entry, one without a program, one with', async () => {
    const bytes = document((doc) => {
      const program = doc.addStream('x', {});
      return [
        {
          Font: {
            A: { Type: 'Font', Subtype: 'Type0', BaseFont: 'A', DescendantFonts: 7 },
            B: { Type: 'Font', Subtype: 'Type0', BaseFont: 'B', DescendantFonts: [7] },
            C: {
              Type: 'Font',
              Subtype: 'Type0',
              BaseFont: 'C',
              DescendantFonts: [{ Subtype: 'CIDFontType2', FontDescriptor: { FontName: 'C' } }],
            },
            D: {
              Type: 'Font',
              Subtype: 'Type0',
              BaseFont: 'D',
              DescendantFonts: [{ FontDescriptor: { FontFile3: program } }],
            },
            E: { Type: 'Font', Subtype: 'Type1', BaseFont: 'E', FontDescriptor: 7 },
          },
        },
      ];
    });
    const fonts = await listPdfFonts(bytes);
    expect(fonts.map((font) => [font.baseFont, font.embedded])).toEqual([
      ['A', false],
      ['B', false],
      ['C', false],
      ['D', true],
      ['E', false],
    ]);
  });

  it('merges a font used on several pages, taking the facts the first page lacked from the later ones', async () => {
    const bytes = document((doc) => {
      const program = doc.addStream('x', {});
      return [
        { Font: { F: { Type: 'Font', BaseFont: 'Shared' } } },
        {
          Font: {
            F: {
              Type: 'Font',
              Subtype: 'TrueType',
              BaseFont: 'Shared',
              Encoding: 'WinAnsiEncoding',
              FontDescriptor: { FontFile2: program },
            },
          },
        },
        { Font: { G: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Shared' } } },
        {
          Font: {
            H: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Shared', FontDescriptor: { FontFile: program } },
          },
        },
      ];
    });
    expect(await listPdfFonts(bytes)).toEqual([
      {
        baseFont: 'Shared',
        subtype: 'TrueType',
        embedded: true,
        encoding: 'WinAnsiEncoding',
        subset: false,
        pages: [0, 1, 2, 3],
      },
    ]);
  });

  it('leaves the type empty when no page states one', async () => {
    const bytes = document(() => [
      { Font: { F: { Type: 'Font', BaseFont: 'Plain' } } },
      { Font: { F: { Type: 'Font', BaseFont: 'Plain' } } },
    ]);
    expect(await listPdfFonts(bytes)).toMatchObject([{ baseFont: 'Plain', subtype: '', pages: [0, 1] }]);
  });

  it('skips resources and font entries that are not dictionaries', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R 4 0 R 5 0 R]/Count 3>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Resources 9>>',
      4: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Resources<</Font 9>>>>',
      5: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Resources<</Font<</F 9/G<</Type/Font/BaseFont/Good>>>>>>>>',
    });
    expect((await listPdfFonts(bytes)).map((font) => [font.baseFont, font.pages])).toEqual([['Good', [2]]]);
  });

  it('lists a font without a BaseFont under its resource key, and takes a string name', async () => {
    const bytes = document(() => [
      { Font: { F7: { Type: 'Font', Subtype: 'Type3' }, S: { Type: 'Font', BaseFont: 'Text' } } },
    ]);
    expect((await listPdfFonts(bytes)).map((font) => font.baseFont)).toEqual(['F7', 'Text']);
  });

  it('stops listing at the largest number of fonts, keeping the first of them', async () => {
    const bytes = document((doc) => {
      const fonts: Record<string, unknown> = {};
      for (let index = 0; index < MAX_FONTS + 5; index += 1) {
        fonts[`F${index}`] = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: `Font${index}` });
      }
      return [{ Font: fonts }, { Font: { X: { Type: 'Font', BaseFont: 'Font0' } } }];
    });
    const fonts = await listPdfFonts(bytes);
    expect(fonts).toHaveLength(MAX_FONTS);
    expect(fonts[0]?.baseFont).toBe('Font0');
  });

  it('maps a page tree MuPDF cannot walk to a tool error', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 2>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>',
    });
    await expect(listPdfFonts(bytes)).rejects.toMatchObject({ name: 'ToolError' });
  });
});
