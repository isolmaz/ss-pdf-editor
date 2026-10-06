/**
 * An invisible text layer for any script.
 *
 * The OCR layer is drawn with the embedded Noto Sans (`mupdf-write.ts`), which encodes each
 * character as its glyph id and lets MuPDF derive `/ToUnicode` from the font's own cmap. A
 * character Noto Sans has no glyph for — Arabic, Hebrew, Devanagari, Chinese, Japanese,
 * Korean — becomes glyph 0, and glyph 0 maps back to nothing: the words were on the page
 * and could not be found or copied.
 *
 * The answer is Tesseract's own (`src/api/pdfrenderer.cpp`, its "GlyphLessFont"): a
 * TrueType program with one empty glyph, a CIDFont whose every CID draws that glyph, and a
 * `/ToUnicode` CMap that maps CID *n* to UTF-16 code unit *n*. The text is then exactly
 * the UTF-16 of the words, whatever the script; nothing is drawn, and the layer is
 * invisible anyway. Tesseract keeps its font as bytes inside its wasm core, but the build
 * splits data segments at zero runs, so the copy there is not one piece; the font is
 * small enough to write here, table by table, after the OpenType specification.
 */

import type { PDFDocument, PDFObject } from 'mupdf';

/** Units per em, and the advance every glyph has (half an em). */
const UNITS = 1000;
const ADVANCE = 500;

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function checksum(bytes: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    const word =
      ((bytes[index] ?? 0) << 24) |
      ((bytes[index + 1] ?? 0) << 16) |
      ((bytes[index + 2] ?? 0) << 8) |
      (bytes[index + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

function utf16be(value: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < value.length; index += 1) out.push(...u16(value.charCodeAt(index)));
  return out;
}

/** The `name` table: family, style, full name and PostScript name, Windows Unicode. */
function nameTable(): number[] {
  const records: [number, string][] = [
    [1, 'GlyphLessFont'],
    [2, 'Regular'],
    [4, 'GlyphLessFont'],
    [6, 'GlyphLessFont'],
  ];
  const strings: number[] = [];
  const entries: number[] = [];
  for (const [id, text] of records) {
    const encoded = utf16be(text);
    entries.push(
      ...u16(3),
      ...u16(1),
      ...u16(0x409),
      ...u16(id),
      ...u16(encoded.length),
      ...u16(strings.length),
    );
    strings.push(...encoded);
  }
  return [...u16(0), ...u16(records.length), ...u16(6 + entries.length), ...entries, ...strings];
}

let cached: Uint8Array | null = null;

/** The TrueType program: two empty glyphs (`.notdef` and the one every CID draws). */
export function glyphlessFontProgram(): Uint8Array {
  if (cached !== null) return cached;
  const tables: Record<string, number[]> = {
    // biome-ignore format: one field per line would make the layout unreadable
    'OS/2': [
      ...u16(4), ...u16(ADVANCE), ...u16(400), ...u16(5), ...u16(0),
      ...u16(650), ...u16(600), ...u16(0), ...u16(75), ...u16(650), ...u16(600), ...u16(0), ...u16(350), ...u16(50), ...u16(250),
      ...u16(0),
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...u32(0), ...u32(0), ...u32(0), ...u32(0),
      ...[0x55, 0x4b, 0x57, 0x4e],
      ...u16(0x40), ...u16(0x20), ...u16(0xffff),
      ...u16(1000), ...u16(0), ...u16(0), ...u16(1000), ...u16(0),
      ...u32(1), ...u32(0),
      ...u16(500), ...u16(700), ...u16(0), ...u16(0x20), ...u16(1),
    ],
    // One segment, the mandatory 0xFFFF end: no character maps to a glyph through the cmap;
    // the PDF's `/CIDToGIDMap` does the mapping.
    // biome-ignore format: the subtable's fields in order
    cmap: [
      ...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12),
      ...u16(4), ...u16(24), ...u16(0), ...u16(2), ...u16(2), ...u16(0), ...u16(0),
      ...u16(0xffff), ...u16(0), ...u16(0xffff), ...u16(1), ...u16(0),
    ],
    glyf: [0, 0, 0, 0],
    // biome-ignore format: the header's fields in order
    head: [
      ...u32(0x00010000), ...u32(0x00010000), ...u32(0), ...u32(0x5f0f3cf5),
      ...u16(0x000b), ...u16(UNITS),
      ...u32(0), ...u32(0), ...u32(0), ...u32(0),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u16(0), ...u16(8), ...u16(2), ...u16(0), ...u16(0),
    ],
    // biome-ignore format: the header's fields in order
    hhea: [
      ...u32(0x00010000), ...u16(UNITS), ...u16(0), ...u16(0), ...u16(ADVANCE),
      ...u16(0), ...u16(0), ...u16(0), ...u16(1), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(2),
    ],
    hmtx: [...u16(ADVANCE), ...u16(0), ...u16(ADVANCE), ...u16(0)],
    loca: [...u16(0), ...u16(0), ...u16(0)],
    // biome-ignore format: the header's fields in order
    maxp: [
      ...u32(0x00010000), ...u16(2), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(2),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ],
    name: nameTable(),
    post: [
      ...u32(0x00030000),
      ...u32(0),
      ...u16(0xff9c),
      ...u16(50),
      ...u32(1),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u32(0),
    ],
  };
  const tags = Object.keys(tables).sort();
  const count = tags.length;
  let search = 1;
  let selector = 0;
  while (search * 2 <= count) {
    search *= 2;
    selector += 1;
  }
  const header = [
    ...u32(0x00010000),
    ...u16(count),
    ...u16(search * 16),
    ...u16(selector),
    ...u16(count * 16 - search * 16),
  ];
  const directory: number[] = [];
  const body: number[] = [];
  let offset = 12 + count * 16;
  let headOffset = 0;
  for (const tag of tags) {
    const data = tables[tag] as number[];
    const padded = [...data, ...new Array((4 - (data.length % 4)) % 4).fill(0)];
    if (tag === 'head') headOffset = offset;
    directory.push(
      ...[...tag].map((c) => c.charCodeAt(0)),
      ...u32(checksum(padded)),
      ...u32(offset),
      ...u32(data.length),
    );
    body.push(...padded);
    offset += padded.length;
  }
  const font = [...header, ...directory, ...body];
  // `head.checkSumAdjustment`: 0xB1B0AFBA minus the sum over the whole file.
  const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
  font.splice(headOffset + 8, 4, ...u32(adjustment));
  cached = Uint8Array.from(font);
  return cached;
}

export interface GlyphlessFace {
  readonly ref: PDFObject;
  /** `<…>` operand: the text's UTF-16 code units, one CID each. */
  encode(value: string): string;
  widthOfTextAtSize(value: string, size: number): number;
}

/** A `/ToUnicode` CMap: CID *n* is UTF-16 code unit *n*, over the whole two-byte range. */
const TO_UNICODE = [
  '/CIDInit /ProcSet findresource begin',
  '12 dict begin',
  'begincmap',
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
  '/CMapName /Adobe-Identity-UCS def',
  '/CMapType 2 def',
  '1 begincodespacerange',
  '<0000> <FFFF>',
  'endcodespacerange',
  '1 beginbfrange',
  '<0000> <FFFF> <0000>',
  'endbfrange',
  'endcmap',
  'CMapName currentdict /CMap defineresource pop',
  'end',
  'end',
].join('\n');

/** Embed the font into `doc` as a Type 0 font over an Identity-H CIDFont. */
export function embedGlyphless(doc: PDFDocument): GlyphlessFace {
  const program = glyphlessFontProgram();
  const fontFile = doc.addStream(program, { Length1: program.length });
  const descriptor = doc.addObject({
    Type: 'FontDescriptor',
    FontName: 'GlyphLessFont',
    Flags: 5,
    FontBBox: [0, 0, ADVANCE, UNITS],
    ItalicAngle: 0,
    Ascent: UNITS,
    Descent: 0,
    CapHeight: UNITS,
    StemV: 80,
    FontFile2: fontFile,
  });
  // Every CID draws glyph 1, the empty one; written once, flate-compressed on save.
  const map = new Uint8Array(0x20000);
  for (let index = 1; index < map.length; index += 2) map[index] = 1;
  const cidToGid = doc.addStream(map, {});
  const systemInfo = doc.newDictionary();
  systemInfo.put('Registry', doc.newString('Adobe'));
  systemInfo.put('Ordering', doc.newString('Identity'));
  systemInfo.put('Supplement', 0);
  const descendant = doc.addObject({
    Type: 'Font',
    Subtype: 'CIDFontType2',
    BaseFont: 'GlyphLessFont',
    CIDSystemInfo: systemInfo,
    FontDescriptor: descriptor,
    DW: ADVANCE,
    CIDToGIDMap: cidToGid,
  });
  const ref = doc.addObject({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: 'GlyphLessFont',
    Encoding: 'Identity-H',
    DescendantFonts: [descendant],
    ToUnicode: doc.addStream(TO_UNICODE, {}),
  });
  return {
    ref,
    encode(value) {
      let hex = '';
      for (let index = 0; index < value.length; index += 1) {
        hex += value.charCodeAt(index).toString(16).padStart(4, '0');
      }
      return `<${hex}>`;
    },
    widthOfTextAtSize(value, size) {
      return (value.length * ADVANCE * size) / UNITS;
    },
  };
}
