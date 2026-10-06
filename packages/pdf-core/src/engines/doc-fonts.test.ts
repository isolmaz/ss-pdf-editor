/**
 * Reading a document's own fonts as faces new text can be drawn with: the character
 * codes (from `/ToUnicode` or from the encoding and `/Differences`), the widths a reader
 * will advance by, the show operator written for them, and the name matching that lets
 * the extractor's spelling of a font find the font. A wrong code or width here draws the
 * wrong letter or overlaps the next word.
 */

import { describe, expect, it } from 'vitest';
import {
  encodes,
  findFont,
  measureText,
  pageFonts,
  readDocumentFont,
  sameFontName,
  showText,
} from './doc-fonts';

/** A page whose resources hold a WinAnsi Type1 font with a `/Differences` and a CID font. */
async function fixture() {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const widths = new Array(224).fill(500);
  widths[0] = 250; // space (code 32)
  widths['A'.charCodeAt(0) - 32] = 700;
  const simple = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'ABCDEF+Nimbus-Sans',
    FirstChar: 32,
    LastChar: 255,
    Widths: widths,
    Encoding: {
      Type: 'Encoding',
      BaseEncoding: 'WinAnsiEncoding',
      Differences: [200, 'Scedilla', 'scedilla'],
    },
  });
  const toUnicode = doc.addStream(
    [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      '2 beginbfchar <0001> <0041> <0002> <015F> endbfchar',
      '1 beginbfrange <0010> <0012> <0061> endbfrange',
      'endcmap end end',
    ].join('\n'),
    {},
  );
  const composite = doc.addObject({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: 'Cid-Face',
    Encoding: 'Identity-H',
    ToUnicode: toUnicode,
    DescendantFonts: [
      {
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: 'Cid-Face',
        DW: 600,
        W: [1, [800], 16, 18, 400],
        FontDescriptor: { Type: 'FontDescriptor', FontName: 'Cid-Face', Ascent: 900, Descent: -300 },
      },
    ],
  });
  const page = doc.addPage([0, 0, 200, 200], 0, { Font: { F1: simple, F2: composite } }, '');
  doc.insertPage(0, page);
  return { doc, page: doc.findPage(0), simple, composite };
}

describe('doc-fonts', () => {
  it('reads a simple font: base encoding plus /Differences, widths from /Widths', async () => {
    const { doc, simple } = await fixture();
    try {
      const font = readDocumentFont(simple);
      expect(font?.codeBytes).toBe(1);
      expect(font?.codes.get('A'.codePointAt(0) ?? 0)).toBe(65);
      // `/Differences [200 /Scedilla /scedilla]`: Ş and ş sit at 200 and 201.
      expect(font?.codes.get(0x15e)).toBe(200);
      expect(font?.codes.get(0x15f)).toBe(201);
      expect(font?.codes.has(0x131)).toBe(false);
      expect(font?.width(65)).toBe(700);
      expect(font?.width(32)).toBe(250);
      expect(font?.names).toContain('ABCDEF+Nimbus-Sans');
    } finally {
      doc.destroy();
    }
  });

  it('reads a composite font through /ToUnicode (chars and ranges) with /W and /DW widths', async () => {
    const { doc, composite } = await fixture();
    try {
      const font = readDocumentFont(composite);
      expect(font?.codeBytes).toBe(2);
      expect(font?.codes.get(0x41)).toBe(1);
      expect(font?.codes.get(0x15f)).toBe(2);
      expect([0x61, 0x62, 0x63].map((point) => font?.codes.get(point))).toEqual([0x10, 0x11, 0x12]);
      expect([font?.width(1), font?.width(0x11), font?.width(2)]).toEqual([800, 400, 600]);
      expect([font?.ascent, font?.descent]).toEqual([900, -300]);
    } finally {
      doc.destroy();
    }
  });

  it('measures and spells text the way a reader will draw it', async () => {
    const { doc, simple, composite } = await fixture();
    try {
      const simpleFont = readDocumentFont(simple);
      const cid = readDocumentFont(composite);
      if (simpleFont === null || cid === null) throw new Error('fonts not read');
      expect(encodes(simpleFont, 'AŞ ş')).toBe(true);
      expect(encodes(simpleFont, 'ı')).toBe(false);
      expect(encodes(cid, 'Aaşx')).toBe(false);
      // A at 700, space (no code in the composite) falls back to a 250 gap.
      expect(measureText(simpleFont, 'AA', 10)).toBeCloseTo(14, 6);
      expect(measureText(cid, 'A a', 10)).toBeCloseTo(((800 + 250 + 400) * 10) / 1000, 6);
      expect(showText(simpleFont, 'AŞ')).toBe('<41c8> Tj');
      expect(showText(cid, 'A aş')).toBe('[<0001> -250 <00100002>] TJ');
    } finally {
      doc.destroy();
    }
  });

  it('finds the fonts of a page and matches the extractor spelling of a name', async () => {
    const { doc, page } = await fixture();
    try {
      const fonts = pageFonts(page);
      expect(fonts).toHaveLength(2);
      expect(findFont(fonts, 'Nimbus Sans')?.codeBytes).toBe(1);
      expect(findFont(fonts, 'Cid-Face')?.codeBytes).toBe(2);
      expect(findFont(fonts, 'Arial')).toBeNull();
      expect(sameFontName('ABCDEF+Nimbus-Sans', 'NimbusSans')).toBe(true);
      // Two subsets of one family are two fonts; a name with no letters matches nothing.
      expect(sameFontName('AAAAAA+Arial', 'BAAAAA+Arial')).toBe(false);
      expect(sameFontName('--', '--')).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('refuses fonts it cannot write for: Type3, a non-Identity CMap, no /ToUnicode', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    try {
      const type3 = doc.addObject({ Type: 'Font', Subtype: 'Type3' });
      const cmap = doc.addObject({ Type: 'Font', Subtype: 'Type0', Encoding: 'UniJIS-UCS2-H' });
      const bare = doc.addObject({ Type: 'Font', Subtype: 'Type0', Encoding: 'Identity-H' });
      expect([type3, cmap, bare].map((ref) => readDocumentFont(ref))).toEqual([null, null, null]);
    } finally {
      doc.destroy();
    }
  });
});
