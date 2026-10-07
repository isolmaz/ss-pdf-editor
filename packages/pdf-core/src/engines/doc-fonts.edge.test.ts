/**
 * Document fonts as untrusted structure: `/ToUnicode` maps with entries that cannot be used,
 * `/W` arrays that stop in the wrong place, `/Differences` naming glyphs nobody has heard of
 * (including names that are also properties of every object), and resources that nest forms
 * deeper than they are searched. Each file is written out object by object, so the reader gets
 * exactly the structure, not what a builder would have produced.
 */

import { PDFDocument, type PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { handPdf } from '../ops/forms.fixtures';
import {
  type DocumentFont,
  encodes,
  findFont,
  measureText,
  pageFonts,
  readDocumentFont,
  showText,
} from './doc-fonts';

/** A stream object whose `/Length` is right. */
function stream(body: string, entries = ''): string {
  return `<</Length ${body.length}${entries}>>\nstream\n${body}\nendstream`;
}

const cmap = (blocks: string): string =>
  `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n${blocks}\nendcmap end end`;

/** Opens `objects` (plus a one-page skeleton) and hands the document to `use`. */
function withDocument<T>(
  objects: Readonly<Record<number, string>>,
  use: (doc: PDFDocument, ref: (number: number) => PDFObject) => T,
  resources = '<<>>',
): T {
  const bytes = handPdf({
    1: '<</Type/Catalog/Pages 2 0 R>>',
    2: `<</Type/Pages/Kids[3 0 R]/Count 1/Resources ${resources}>>`,
    3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>',
    ...objects,
  });
  const doc = PDFDocument.openDocument(bytes, 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return use(doc, (number) => doc.newIndirect(number));
  } finally {
    doc.destroy();
  }
}

const entries = (font: DocumentFont | null) => [...(font?.codes ?? [])].sort((a, b) => a[0] - b[0]);
const point = (character: string): number => character.codePointAt(0) ?? Number.NaN;

/** A Type0 font (object 10) with the descendant `descendant` and `/ToUnicode` object 11. */
function composite(toUnicode: string, descendant = 'DW 600'): Record<number, string> {
  return {
    10: '<</Type/Font/Subtype/Type0/BaseFont/Cid/Encoding/Identity-H/DescendantFonts[12 0 R]/ToUnicode 11 0 R>>',
    11: stream(toUnicode),
    12: `<</Type/Font/Subtype/CIDFontType2/BaseFont/Cid/${descendant}>>`,
  };
}

describe('/ToUnicode of a composite font', () => {
  it('keeps only the entries that spell one code point in codes of the font width', () => {
    const map = cmap(
      [
        '5 beginbfchar',
        '<01> <0041>', // a one-byte code in a two-byte font
        '<0002> <0042>',
        '<0003> <00410042>', // a ligature: two code points
        '<0004> <004>', // not whole UTF-16 units
        '<0009> <0042>', // a second spelling of B: the first stays
        'endbfchar',
        '6 beginbfrange',
        '<01> <05> <0061>', // one-byte range
        '<0020> <0010> <0061>', // backwards
        '<0030> <0033> [<0041> <0043>]', // an array shorter than the range
        '<0040> <0041> <00410042>', // a base of two code points
        '<0050> <0052> <0078>',
        '<0060> <0061> <>', // an empty base
        'endbfrange',
      ].join('\n'),
    );
    withDocument(composite(map), (_doc, ref) => {
      const font = readDocumentFont(ref(10));
      expect(font?.codeBytes).toBe(2);
      expect(entries(font)).toEqual([
        [point('A'), 0x30],
        [point('B'), 0x02],
        [point('C'), 0x31],
        [point('x'), 0x50],
        [point('y'), 0x51],
        [point('z'), 0x52],
      ]);
    });
  });

  it('is not a face when the map holds nothing usable or is not a stream', () => {
    for (const objects of [
      composite(cmap('1 beginbfchar <01> <0041> endbfchar')),
      { ...composite(''), 11: '/NotAStream' },
    ]) {
      withDocument(objects, (_doc, ref) => expect(readDocumentFont(ref(10))).toBeNull());
    }
  });
});

/** `object` answering as itself from `resolve`, with `override` replacing what it answers for a property. */
function wrapped(object: PDFObject, override: (property: string | symbol) => unknown): PDFObject {
  const proxy: PDFObject = new Proxy(object, {
    get(target, property) {
      if (property === 'resolve') return () => proxy;
      const replaced = override(property);
      if (replaced !== undefined) return replaced;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}

describe('a /ToUnicode stream the engine cannot decode', () => {
  it('is no map at all, so the font is not a face (MuPDF itself hands back what it can, so the engine is made to throw)', () => {
    withDocument(composite(cmap('1 beginbfchar <0001> <0041> endbfchar')), (_doc, ref) => {
      const font = ref(10).resolve();
      const damaged = wrapped(font, (property) =>
        property === 'get'
          ? (name: string) =>
              name === 'ToUnicode'
                ? wrapped(font.get(name), (key) =>
                    key === 'readStream'
                      ? () => {
                          throw new Error('stream damaged');
                        }
                      : undefined,
                  )
                : font.get(name)
          : undefined,
      );
      expect(readDocumentFont(damaged)).toBeNull();
    });
  });
});

describe('/W and /DW of a composite font', () => {
  const widthsOf = (descendant: string, codes: readonly number[]) =>
    withDocument(composite(cmap('1 beginbfchar <0001> <0041> endbfchar'), descendant), (_doc, ref) => {
      const font = readDocumentFont(ref(10));
      return codes.map((code) => font?.width(code));
    });

  it('reads lists and ranges, and answers /DW for what /W does not name', () => {
    expect(widthsOf('DW 600/W[1[800 700] 10 12 300 20 21 450]', [0, 1, 2, 3, 10, 12, 13, 20, 21])).toEqual([
      600, 800, 700, 600, 300, 300, 600, 450, 450,
    ]);
  });

  it('answers 1000 when the font states no /DW, and /DW for every code when it states no /W', () => {
    expect(widthsOf('W[1[800]]', [1, 2])).toEqual([800, 1000]);
    expect(widthsOf('DW 450', [1, 2])).toEqual([450, 450]);
    expect(widthsOf('DW 450/W 7', [1])).toEqual([450]);
  });

  it('stops at an entry it cannot read, keeping what came before', () => {
    expect(widthsOf('DW 600/W[1[800] 5]', [1, 5])).toEqual([800, 600]);
    expect(widthsOf('DW 600/W[1[800] null[900]]', [1])).toEqual([800]);
  });

  it('leaves a code with a missing width at the default', () => {
    expect(widthsOf('DW 600/W[1[800 null 700]]', [1, 2, 3])).toEqual([800, 600, 700]);
  });

  it('uses /DW for a range with no width, and stops expanding an absurd range', () => {
    expect(widthsOf('DW 600/W[3 4]', [3, 4])).toEqual([600, 600]);
    expect(widthsOf('DW 600/W[0 4000000000 500]', [0, 65535, 65536, 1000000])).toEqual([500, 500, 600, 600]);
  });
});

describe('a simple font', () => {
  const simple = (extra: string): Record<number, string> => ({
    10: `<</Type/Font/Subtype/Type1/BaseFont/Plain${extra}>>`,
  });
  const codesOf = (extra: string) =>
    withDocument(simple(extra), (_doc, ref) => entries(readDocumentFont(ref(10))));

  it('takes StandardEncoding when it names no encoding: ASCII but for the two quotes', () => {
    const codes = codesOf('/Encoding<</Type/Encoding>>');
    expect(codes).toHaveLength(0x7e - 0x20 + 1 - 2);
    expect(codes.find(([text]) => text === point('A'))).toEqual([point('A'), 0x41]);
    expect(codes.some(([text]) => text === 0x27 || text === 0x60)).toBe(false);
  });

  it('takes WinAnsi and MacRoman through the platform decoder, whole', () => {
    const win = codesOf('/Encoding/WinAnsiEncoding');
    const mac = codesOf('/Encoding<</BaseEncoding/MacRomanEncoding>>');
    // 0x20 … 0xFF without DEL, every code a different character.
    expect(win).toHaveLength(223);
    expect(mac).toHaveLength(223);
    expect(win.find(([text]) => text === 0x20ac)).toEqual([0x20ac, 0x80]);
    expect(mac.find(([text]) => text === point('é'))).toEqual([point('é'), 0x8e]);
  });

  it('is not a face when the encoding is a number or absent, or there is no usable /ToUnicode', () => {
    for (const extra of ['/Encoding 5', '', '/ToUnicode/Nope']) {
      withDocument(simple(extra), (_doc, ref) => expect(readDocumentFont(ref(10))).toBeNull());
    }
  });

  it('applies /Differences: glyph names, uniXXXX, letters, and a code it cannot name is dropped', () => {
    const codes = codesOf(
      '/Encoding<</BaseEncoding/WinAnsiEncoding/Differences[1 /Q /uni015E (text) /Scedilla /nosuchglyph 65 /foo null /bullet]>>',
    );
    const at = (text: number) => codes.find(([entry]) => entry === text)?.[1];
    expect(at(point('Q'))).toBe(81); // base WinAnsi has Q at 81 and keeps the first spelling
    expect(at(0x15e)).toBe(2); // the later /Scedilla at 3 does not replace the first spelling
    expect(at(0x2022)).toBe(66); // /bullet follows /foo, which took 65
    // `/foo` and `/nosuchglyph` name nothing: code 65 ('A') and code 4 lose their character.
    expect(at(point('A'))).toBeUndefined();
    expect(codes.some(([, code]) => code === 4)).toBe(false);
  });

  it('does not take a glyph named like a property of every object for a character', () => {
    const codes = codesOf(
      '/Encoding<</BaseEncoding/WinAnsiEncoding/Differences[65 /constructor /toString /__proto__]>>',
    );
    for (const [text, code] of codes) {
      expect(typeof text).toBe('number');
      expect(typeof code).toBe('number');
    }
    expect(codes.some(([, code]) => code >= 65 && code <= 67)).toBe(false);
  });

  it('widths: /Widths from /FirstChar, /MissingWidth outside them, 0 with neither', () => {
    const map = stream(cmap('2 beginbfchar <41> <0041> <42> <0042> endbfchar'));
    withDocument(
      {
        10: '<</Type/Font/Subtype/TrueType/BaseFont/W/ToUnicode 11 0 R/FirstChar 65/Widths[700]/FontDescriptor 12 0 R>>',
        11: map,
        12: '<</Type/FontDescriptor/FontName/Face/MissingWidth 333/Ascent 750/Descent -250>>',
        13: '<</Type/Font/Subtype/MMType1/BaseFont/M/ToUnicode 11 0 R>>',
      },
      (_doc, ref) => {
        const font = readDocumentFont(ref(10));
        expect([font?.width(65), font?.width(66), font?.width(10)]).toEqual([700, 333, 333]);
        expect([font?.ascent, font?.descent]).toEqual([750, -250]);
        expect(font?.names).toEqual(['W', 'Face']);
        const bare = readDocumentFont(ref(13));
        expect([bare?.width(65), bare?.ascent, bare?.descent]).toEqual([0, 800, -200]);
      },
    );
  });

  it('answers the default metrics for a descriptor with an ascent below zero or a descent above it', () => {
    withDocument(
      {
        10: '<</Type/Font/Subtype/Type1/Encoding/WinAnsiEncoding/FontDescriptor 12 0 R>>',
        12: '<</Type/FontDescriptor/Ascent -5/Descent 5>>',
      },
      (_doc, ref) => {
        const font = readDocumentFont(ref(10));
        expect([font?.ascent, font?.descent]).toEqual([800, -200]);
      },
    );
  });

  it('is nothing for an entry that is not a font dictionary', () => {
    withDocument({ 10: '42' }, (_doc, ref) => expect(readDocumentFont(ref(10))).toBeNull());
  });
});

describe('the fonts of a page', () => {
  const face = (number: number, name: string): Record<number, string> => ({
    [number]: `<</Type/Font/Subtype/Type1/BaseFont/${name}/Encoding/WinAnsiEncoding>>`,
  });
  const form = (number: number, resources: string): Record<number, string> => ({
    [number]: `<</Type/XObject/Subtype/Form/BBox[0 0 1 1]/Resources ${resources}/Length 0>>\nstream\n\nendstream`,
  });
  const namesOf = (fonts: readonly DocumentFont[]) => fonts.flatMap((font) => font.names);

  it('is empty for resources without fonts, and for a /Font entry that is not a dictionary', () => {
    for (const resources of ['<<>>', '<</Font 5>>', '<</Font<</F1 5>>>>']) {
      withDocument({}, (doc) => expect(pageFonts(doc.findPage(0))).toEqual([]), resources);
    }
  });

  it('reads the fonts of a form, skips an entry that is not a form, and stops at three levels', () => {
    const objects = {
      ...face(10, 'Top'),
      ...face(11, 'InForm'),
      ...face(12, 'Two'),
      ...face(13, 'Three'),
      ...face(14, 'Four'),
      ...form(20, '<</Font<</F 11 0 R>>/XObject<</X 21 0 R>>>>'),
      ...form(21, '<</Font<</F 12 0 R>>/XObject<</X 22 0 R>>>>'),
      ...form(22, '<</Font<</F 13 0 R>>/XObject<</X 23 0 R>>>>'),
      ...form(23, '<</Font<</F 14 0 R>>>>'),
      30: '<</Type/XObject/Subtype/Image/Width 1/Height 1/Length 0>>\nstream\n\nendstream',
    };
    const resources = '<</Font<</F 10 0 R>>/XObject<</A 20 0 R/I 30 0 R/M 99 0 R>>>>';
    withDocument(
      objects,
      (doc) => {
        const page = doc.findPage(0);
        expect(namesOf(pageFonts(page))).toEqual(['Top', 'InForm', 'Two', 'Three']);
        expect(namesOf(pageFonts(page, { forms: false }))).toEqual(['Top']);
      },
      resources,
    );
  });

  it('reads a font used twice once, a direct font dictionary, and a form that contains itself', () => {
    const objects = {
      ...face(10, 'Shared'),
      ...form(20, '<</Font<</F 10 0 R>>/XObject<</Self 20 0 R>>>>'),
    };
    const resources =
      '<</Font<</A 10 0 R/B 10 0 R/D<</Type/Font/Subtype/Type1/BaseFont/Direct/Encoding/WinAnsiEncoding>>>>/XObject<</F 20 0 R>>>>';
    withDocument(
      objects,
      (doc) => expect(namesOf(pageFonts(doc.findPage(0)))).toEqual(['Shared', 'Direct']),
      resources,
    );
  });

  it('finds a font by the extractor spelling of its name, and answers null for another', () => {
    withDocument(
      face(10, 'ABCDEF+Nimbus-Sans'),
      (doc) => {
        const fonts = pageFonts(doc.findPage(0));
        expect(findFont(fonts, 'NimbusSans')).toBe(fonts[0]);
        expect(findFont(fonts, 'Other')).toBeNull();
      },
      '<</Font<</F 10 0 R>>>>',
    );
  });
});

describe('spelling and measuring text', () => {
  /** `A`, `B` and nothing else, one byte each; space is not in the font. */
  const lettersOnly = () =>
    withDocument(
      {
        10: '<</Type/Font/Subtype/Type1/BaseFont/Letters/ToUnicode 11 0 R/FirstChar 65/Widths[600 500]>>',
        11: stream(cmap('2 beginbfchar <41> <0041> <42> <0042> endbfchar')),
      },
      (_doc, ref) => {
        const font = readDocumentFont(ref(10));
        if (font === null) throw new Error('no font');
        return font;
      },
    );

  it('writes one hex string for text the font has codes for', () => {
    expect(showText(lettersOnly(), 'AB')).toBe('<4142> Tj');
  });

  it('writes a gap for every character without a code: leading, between, trailing, and alone', () => {
    const font = lettersOnly();
    expect(showText(font, ' A')).toBe('[-250 <41>] TJ');
    expect(showText(font, 'A  B')).toBe('[<41> -250 -250 <42>] TJ');
    expect(showText(font, 'A ')).toBe('[<41> -250] TJ');
    expect(showText(font, ' ')).toBe('[-250] TJ');
    expect(showText(font, '')).toBe('[] TJ');
  });

  it('measures a gap as a quarter of an em and a character at its width', () => {
    const font = lettersOnly();
    expect(measureText(font, 'AB', 10)).toBeCloseTo(11, 10);
    expect(measureText(font, 'A B', 10)).toBeCloseTo(13.5, 10);
  });

  it('can draw text only when every character that is not white space has a code and a width', () => {
    const font = lettersOnly();
    expect(encodes(font, 'AB A\t')).toBe(true);
    expect(encodes(font, 'AC')).toBe(false);
    // `0x0F` is a code with no width: the font gives it nothing to advance by.
    const widthless = { ...font, codes: new Map([[point('Z'), 0x5a]]) };
    expect(encodes(widthless, 'Z')).toBe(false);
  });
});
