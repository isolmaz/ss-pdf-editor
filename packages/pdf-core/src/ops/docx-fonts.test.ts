/**
 * The PDF's fonts inside the "exact layout" Word export: the obfuscation of the font parts
 * (ECMA-376 §17.8.1) and the package an embedded-font export writes. The wrong answers that
 * matter: a font Word cannot de-obfuscate (a wrong key order), text that still names Arial
 * although its font is embedded, a font part with no content type or relationship, and fonts
 * "embedded" from a PDF that only uses the standard 14.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { buildCff, index } from './docx-font-fixtures';
import { cffForWord } from './docx-font-sfnt';
import { obfuscateFont } from './docx-fonts';
import { exportOffice } from './export-office';
import { line, officeDocument } from './export-office-fixtures';
import type { OperationContext } from './types';

const run: OperationContext = { signal: new AbortController().signal };
const options = { pages: [0], baseName: 'plan.pdf', format: 'docx', docxLayout: 'layout' } as const;

const root = createRequire(fileURLToPath(new URL('../../../../package.json', import.meta.url)));
const noto = (file: string): Uint8Array =>
  new Uint8Array(
    readFileSync(join(dirname(root.resolve('@expo-google-fonts/noto-sans/package.json')), file)),
  );
const notoRegular = (): Uint8Array => noto('400Regular/NotoSans_400Regular.ttf');

/** Writes `fsType` into the `OS/2` table of the TrueType `program`, in place (or hides the table). */
function setFsType(program: Uint8Array, fsType: number | 'none'): void {
  const dv = new DataView(program.buffer, program.byteOffset, program.byteLength);
  for (let index = 0; index < dv.getUint16(4); index += 1) {
    const record = 12 + index * 16;
    if (String.fromCharCode(...program.subarray(record, record + 4)) === 'OS/2') {
      // `'none'`: the table is renamed, so the font has no `OS/2` of its own.
      if (fsType === 'none')
        program.set(
          [...'OS/9'].map((character) => character.charCodeAt(0)),
          record,
        );
      else dv.setUint16(dv.getUint32(record + 8) + 8, fsType);
      return;
    }
  }
  throw new Error('the program has no OS/2 table');
}

/** A one-page PDF of `text` set in Noto Sans, embedded as a Type0 / Identity-H font (the fidelity samples' way). */
async function notoPdf(
  text: string,
  {
    fsType,
    invisible = false,
    stroked = false,
  }: { fsType?: number | 'none'; invisible?: boolean; stroked?: boolean } = {},
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font('NotoSans-Regular', notoRegular());
  try {
    const object = doc.addFont(font);
    let hex = '';
    for (const character of text)
      hex += font
        .encodeCharacter(character.codePointAt(0) as number)
        .toString(16)
        .padStart(4, '0');
    const page = doc.addPage(
      [0, 0, 400, 300],
      0,
      { Font: { F0: object }, ExtGState: { Hidden: { Type: 'ExtGState', ca: 0, CA: 0 } } },
      `${invisible ? '/Hidden gs ' : ''}BT ${stroked ? '1 Tr ' : ''}/F0 18 Tf 40 200 Td <${hex}> Tj ET\n`,
    );
    doc.insertPage(0, page);
    doc.subsetFonts();
    if (fsType !== undefined) {
      // MuPDF will not embed such a font itself; other producers do, so the program is patched in the file.
      const file = doc
        .findPage(0)
        .get('Resources')
        .get('Font')
        .get('F0')
        .get('DescendantFonts')
        .get(0)
        .get('FontDescriptor')
        .get('FontFile2');
      const program = new Uint8Array(file.readStream().asUint8Array());
      setFsType(program, fsType);
      file.writeStream(program);
    }
    return new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array());
  } finally {
    font.destroy();
    doc.destroy();
  }
}

describe('obfuscateFont', () => {
  const GUID = '{00112233-4455-6677-8899-AABBCCDDEEFF}';

  it('XORs the first 32 bytes with the GUID read backwards, twice over', () => {
    const font = new Uint8Array(40).fill(0);
    const out = obfuscateFont(font, GUID);
    const key = [
      0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00,
    ];
    expect([...out.subarray(0, 32)]).toEqual([...key, ...key]);
    // Bytes past the 32nd are the font's own.
    expect([...out.subarray(32)]).toEqual(new Array(8).fill(0));
  });

  it('is its own inverse and leaves the input alone', () => {
    const font = Uint8Array.from({ length: 100 }, (_, at) => (at * 7 + 3) & 0xff);
    const once = obfuscateFont(font, GUID);
    expect([...once]).not.toEqual([...font]);
    expect([...obfuscateFont(once, GUID)]).toEqual([...font]);
    expect(font[0]).toBe(3);
  });

  it('refuses what is not a GUID', () => {
    expect(() => obfuscateFont(new Uint8Array(4), '{1234}')).toThrow(RangeError);
  });
});

describe('exact layout without embeddable fonts', () => {
  it('embeds nothing from a PDF that only uses the standard 14', async () => {
    const bytes = await officeDocument([{ content: line('helvetica', 12, 60, 200, 'Plain Helvetica text') }]);
    const result = await exportOffice(bytes, options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);
    expect(
      Object.keys(zip.files).filter((name) => name.includes('font') || name.includes('settings')),
    ).toEqual([]);
    expect(await zip.file('[Content_Types].xml')?.async('string')).not.toContain('odttf');
    expect(result.notes.map((note) => note.key)).not.toContain('op.note.exportOffice.fontsEmbedded');
    const document = (await zip.file('word/document.xml')?.async('string')) ?? '';
    expect(document).toContain('w:ascii="Arial"');
  });
});

// These need FontSfnt's real `docx-font-sfnt.ts` (the builders return `null` in a stub).
describe('exact layout with an embedded TrueType font', () => {
  const TEXT = 'İstanbul ağaçları';

  it('embeds the font obfuscated, names it in the runs and wires the package', async () => {
    const result = await exportOffice(await notoPdf(TEXT), options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);

    const table = (await zip.file('word/fontTable.xml')?.async('string')) ?? '';
    expect(table).toMatch(
      /<w:font w:name="NotoSans"><w:embedRegular r:id="rIdFont1" w:fontKey="\{[0-9A-F-]{36}\}"\/><\/w:font>/,
    );
    const key = /w:fontKey="(\{[^"]+\})"/.exec(table)?.[1] as string;

    const rels = (await zip.file('word/_rels/fontTable.xml.rels')?.async('string')) ?? '';
    expect(rels).toContain(
      'Id="rIdFont1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.odttf"',
    );
    expect(await zip.file('word/settings.xml')?.async('string')).toContain('<w:embedTrueTypeFonts/>');
    const docRels = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
    expect(docRels).toContain('relationships/fontTable" Target="fontTable.xml"');
    expect(docRels).toContain('relationships/settings" Target="settings.xml"');
    const types = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
    expect(types).toContain(
      '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>',
    );
    expect(types).toContain(
      '/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"',
    );
    expect(types).toContain(
      '/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"',
    );

    const document = (await zip.file('word/document.xml')?.async('string')) ?? '';
    expect(document).toContain('<w:rFonts w:ascii="NotoSans" w:hAnsi="NotoSans" w:cs="NotoSans"/>');
    expect(document).not.toContain('<w:b/>');
    expect(result.notes).toContainEqual(
      expect.objectContaining({ key: 'op.note.exportOffice.fontsEmbedded', params: { count: 1 } }),
    );

    // De-obfuscated, the part is a font MuPDF loads, with the Turkish letters the text uses.
    const odttf = await zip.file('word/fonts/font1.odttf')?.async('uint8array');
    const bytes = obfuscateFont(odttf as Uint8Array, key);
    const mupdf = await loadMupdf();
    const font = new mupdf.Font('Embedded', bytes);
    try {
      expect(font.encodeCharacter('ğ'.codePointAt(0) as number)).toBeGreaterThan(0);
      expect(font.encodeCharacter('İ'.codePointAt(0) as number)).toBeGreaterThan(0);
    } finally {
      font.destroy();
    }
  });
});

describe('exact layout: which fonts are embedded', () => {
  const embedded = async (bytes: Uint8Array) => {
    const result = await exportOffice(bytes, options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);
    return Object.keys(zip.files).filter((name) => name.endsWith('.odttf'));
  };

  it('embeds nothing of a font that allows only bitmaps to be embedded', async () => {
    expect(await embedded(await notoPdf('Stanbul', { fsType: 0x0200 }))).toEqual([]);
    expect(await embedded(await notoPdf('Stanbul', { fsType: 0x0002 }))).toEqual([]);
    expect(await embedded(await notoPdf('Stanbul', { fsType: 0x0004 }))).toHaveLength(1);
    // A font with no OS/2 table has no licence bits to forbid it.
    expect(await embedded(await notoPdf('Stanbul', { fsType: 'none' }))).toHaveLength(1);
  });

  it('embeds no font for text drawn with no opacity, as the OCR layer of this app is', async () => {
    expect(await embedded(await notoPdf('Stanbul', { invisible: true }))).toEqual([]);
    expect(await embedded(await notoPdf('Stanbul'))).toHaveLength(1);
    // Outlined text counts the same way: seen, it needs its font; with no opacity, it does not.
    expect(await embedded(await notoPdf('Stanbul', { stroked: true }))).toHaveLength(1);
    expect(await embedded(await notoPdf('Stanbul', { stroked: true, invisible: true }))).toEqual([]);
  });
});

describe('exact layout with an embedded OpenType-CFF font', () => {
  /** A one-page PDF drawing "A" in an OpenType-CFF CID font whose `OS/2` has `fsType`. */
  async function openTypePdf(fsType: number): Promise<Uint8Array> {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    try {
      const program = cffForWord(
        buildCff(),
        [{ unicode: 0x41, gid: 1 }],
        new Map([[1, 600]]),
        { family: 'Sample', style: 'Regular' },
        { ascent: 900, descent: -250, fsType },
      ) as Uint8Array;
      const descriptor = doc.addObject({
        Type: 'FontDescriptor',
        FontName: 'AAAAAA+Sample',
        Flags: 4,
        FontBBox: [-200, -1500, 2000, 900],
        ItalicAngle: 0,
        Ascent: 900,
        Descent: -250,
        CapHeight: 700,
        StemV: 80,
        FontFile3: doc.addStream(program, { Subtype: 'OpenType' }),
      });
      const cid = doc.addObject({
        Type: 'Font',
        Subtype: 'CIDFontType0',
        BaseFont: 'AAAAAA+Sample',
        CIDSystemInfo: { Registry: '(Adobe)', Ordering: '(Identity)', Supplement: 0 },
        FontDescriptor: descriptor,
        DW: 600,
      });
      const toUnicode = doc.addStream(
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def ' +
          '1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0001> <0041> endbfchar endcmap end end',
        {},
      );
      const font = doc.addObject({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'AAAAAA+Sample',
        Encoding: 'Identity-H',
        DescendantFonts: [cid],
        ToUnicode: toUnicode,
      });
      doc.insertPage(
        0,
        doc.addPage([0, 0, 400, 300], 0, { Font: { F0: font } }, 'BT /F0 18 Tf 40 200 Td <0001> Tj ET\n'),
      );
      return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    } finally {
      doc.destroy();
    }
  }

  it('keeps the font licence bits in the embedded program', async () => {
    for (const fsType of [0x0004, 0x0008]) {
      const result = await exportOffice(await openTypePdf(fsType), options, run);
      const zip = await JSZip.loadAsync(result.file.bytes);
      const table = (await zip.file('word/fontTable.xml')?.async('string')) ?? '';
      const key = /w:fontKey="(\{[^"]+\})"/.exec(table)?.[1] as string;
      const odttf = await zip.file('word/fonts/font1.odttf')?.async('uint8array');
      const bytes = obfuscateFont(odttf as Uint8Array, key);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let found = -1;
      for (let index = 0; index < dv.getUint16(4); index += 1) {
        const record = 12 + index * 16;
        if (String.fromCharCode(...bytes.subarray(record, record + 4)) === 'OS/2')
          found = dv.getUint16(dv.getUint32(record + 8) + 8);
      }
      expect(found).toBe(fsType);
    }
  });

  it('embeds nothing of one that allows only bitmaps', async () => {
    const result = await exportOffice(await openTypePdf(0x0200), options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);
    expect(Object.keys(zip.files).filter((name) => name.endsWith('.odttf'))).toEqual([]);
  });
});

describe('exact layout with two subsets of one face', () => {
  /** Two Noto Sans programs (regular, bold) both named `…+NotoSans-Regular`, tagged `AAAAAA` and `BBBBBB`: `F0` draws "ab", `F1` "cd". */
  async function twoSubsets(): Promise<Uint8Array> {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const fonts = [
      new mupdf.Font('NotoSans-Regular', notoRegular()),
      new mupdf.Font('NotoSans-Regular', noto('700Bold/NotoSans_700Bold.ttf')),
    ];
    try {
      const hex = (font: (typeof fonts)[number], text: string) =>
        [...text]
          .map((c) =>
            font
              .encodeCharacter(c.codePointAt(0) as number)
              .toString(16)
              .padStart(4, '0'),
          )
          .join('');
      const objects = fonts.map((font) => doc.addFont(font));
      const page = doc.addPage(
        [0, 0, 400, 300],
        0,
        { Font: { F0: objects[0], F1: objects[1] } },
        `BT /F0 18 Tf 40 200 Td <${hex(fonts[0] as (typeof fonts)[number], 'ab')}> Tj ET\n` +
          `BT /F1 18 Tf 40 150 Td <${hex(fonts[1] as (typeof fonts)[number], 'cd')}> Tj ET\n`,
      );
      doc.insertPage(0, page);
      doc.subsetFonts();
      const resources = doc.findPage(0).get('Resources').get('Font');
      for (const [index, key] of ['F0', 'F1'].entries()) {
        const object = resources.get(key);
        const name = doc.newName(`${index === 0 ? 'AAAAAA' : 'BBBBBB'}+NotoSans-Regular`);
        object.put('BaseFont', name);
        object.get('DescendantFonts').get(0).put('BaseFont', name);
      }
      return new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array());
    } finally {
      for (const font of fonts) font.destroy();
      doc.destroy();
    }
  }

  it('embeds one program per subset although the faces share a name', async () => {
    const result = await exportOffice(await twoSubsets(), options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);
    const table = (await zip.file('word/fontTable.xml')?.async('string')) ?? '';
    expect(table).toMatch(/<w:embedRegular [^>]*\/>/);
    expect(table).toMatch(/<w:embedBold [^>]*\/>/);
    expect(result.notes).toContainEqual(
      expect.objectContaining({ key: 'op.note.exportOffice.fontsEmbedded', params: { count: 2 } }),
    );
  });
});

describe('exact layout with a ligature glyph', () => {
  /**
   * Noto Sans, Identity-H, whose ToUnicode reads the fi ligature glyph (U+FB01's glyph) as the two
   * characters "fi", as a PDF that was set with ligatures does; `show` is drawn from `o`, `f` and `fi`.
   */
  async function ligaturePdf(show: readonly ('o' | 'f' | 'fi')[]): Promise<Uint8Array> {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const font = new mupdf.Font('NotoSans-Regular', notoRegular());
    try {
      const gid = (code: number): number => font.encodeCharacter(code);
      const gids = { o: gid(0x6f), f: gid(0x66), fi: gid(0xfb01) };
      const hex = (n: number): string => n.toString(16).padStart(4, '0');
      const object = doc.addFont(font);
      const page = doc.addPage(
        [0, 0, 400, 300],
        0,
        { Font: { F0: object } },
        `BT /F0 18 Tf 40 200 Td <${show.map((c) => hex(gids[c])).join('')}> Tj ET\n`,
      );
      doc.insertPage(0, page);
      doc.subsetFonts();
      const cmap =
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Lig def /CMapType 2 def ' +
        `1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <${hex(gids.o)}> <006F> ` +
        `<${hex(gids.f)}> <0066> <${hex(gids.fi)}> <00660069> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
      doc.findPage(0).get('Resources').get('Font').get('F0').put('ToUnicode', doc.addStream(cmap, {}));
      return new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array());
    } finally {
      font.destroy();
      doc.destroy();
    }
  }

  /** What the embedded program of the export has for "f" and "i": the advance of each (`undefined` when unmapped), and the program's own "f" and "fi" advances. */
  async function embedded(show: readonly ('o' | 'f' | 'fi')[]): Promise<{
    f: number | undefined;
    i: number | undefined;
    plain: number;
    ligature: number;
  }> {
    const result = await exportOffice(await ligaturePdf(show), options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);
    const table = (await zip.file('word/fontTable.xml')?.async('string')) ?? '';
    const key = /w:fontKey="(\{[^"]+\})"/.exec(table)?.[1] as string;
    const odttf = await zip.file('word/fonts/font1.odttf')?.async('uint8array');
    const mupdf = await loadMupdf();
    const program = new mupdf.Font('Embedded', obfuscateFont(odttf as Uint8Array, key));
    const original = new mupdf.Font('Original', notoRegular());
    try {
      const advance = (code: number): number | undefined => {
        const gid = program.encodeCharacter(code);
        return gid === 0 ? undefined : program.advanceGlyph(gid);
      };
      return {
        f: advance(0x66),
        i: advance(0x69),
        plain: original.advanceGlyph(original.encodeCharacter(0x66)),
        ligature: original.advanceGlyph(original.encodeCharacter(0xfb01)),
      };
    } finally {
      program.destroy();
      original.destroy();
    }
  }

  it('keeps the plain "f" glyph for "f", not the ligature drawn first', async () => {
    const seen = await embedded(['o', 'fi', 'f', 'o']);
    expect(seen.plain).not.toBe(seen.ligature);
    expect(seen.f).toBe(seen.plain);
    // "i" is only ever drawn inside the ligature: no glyph of its own was seen, so none is mapped.
    expect(seen.i).toBeUndefined();
  });

  it('maps no glyph for "f" when it is only ever drawn inside the ligature', async () => {
    const seen = await embedded(['o', 'fi', 'o']);
    expect(seen.f).toBeUndefined();
    expect(seen.i).toBeUndefined();
  });
});

describe('exact layout with a bare CFF font program', () => {
  /** The test CFF's glyph 1 is named "A" (SID 34); as a CID font it is CID 34, code <0022>. */
  async function bareCffPdf(program: Uint8Array, kind: 'name-keyed' | 'cid-keyed'): Promise<Uint8Array> {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    try {
      const cid = kind === 'cid-keyed';
      const descriptor = doc.addObject({
        Type: 'FontDescriptor',
        FontName: 'AAAAAA+Sample',
        Flags: cid ? 4 : 32,
        FontBBox: [-200, -1500, 2000, 900],
        ItalicAngle: 0,
        Ascent: 900,
        Descent: -250,
        CapHeight: 700,
        StemV: 80,
        FontFile3: doc.addStream(program, { Subtype: cid ? 'CIDFontType0C' : 'Type1C' }),
      });
      let font: ReturnType<typeof doc.addObject>;
      if (cid) {
        const descendant = doc.addObject({
          Type: 'Font',
          Subtype: 'CIDFontType0',
          BaseFont: 'AAAAAA+Sample',
          CIDSystemInfo: { Registry: '(Adobe)', Ordering: '(Identity)', Supplement: 0 },
          FontDescriptor: descriptor,
          DW: 600,
        });
        const toUnicode = doc.addStream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def ' +
            '1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0022> <0041> endbfchar endcmap end end',
          {},
        );
        font = doc.addObject({
          Type: 'Font',
          Subtype: 'Type0',
          BaseFont: 'AAAAAA+Sample',
          Encoding: 'Identity-H',
          DescendantFonts: [descendant],
          ToUnicode: toUnicode,
        });
      } else {
        font = doc.addObject({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'AAAAAA+Sample',
          FirstChar: 65,
          LastChar: 65,
          Widths: [600],
          FontDescriptor: descriptor,
          Encoding: 'WinAnsiEncoding',
        });
      }
      doc.insertPage(
        0,
        doc.addPage(
          [0, 0, 400, 300],
          0,
          { Font: { F0: font } },
          `BT /F0 18 Tf 40 200 Td ${cid ? '<0022>' : '(A)'} Tj ET\n`,
        ),
      );
      return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    } finally {
      doc.destroy();
    }
  }

  /** The embedded program of the export (de-obfuscated) opened in MuPDF, or `null` when nothing was embedded. */
  async function embeddedGlyphs(pdf: Uint8Array): Promise<{ a: boolean; table: string } | null> {
    const result = await exportOffice(pdf, options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);
    const odttf = await zip.file('word/fonts/font1.odttf')?.async('uint8array');
    if (odttf === undefined) return null;
    const table = (await zip.file('word/fontTable.xml')?.async('string')) as string;
    const key = /w:fontKey="(\{[^"]+\})"/.exec(table)?.[1] as string;
    const mupdf = await loadMupdf();
    const program = new mupdf.Font('Embedded', obfuscateFont(odttf, key));
    try {
      return { a: program.encodeCharacter(0x41) !== 0, table };
    } finally {
      program.destroy();
    }
  }

  it('embeds a name-keyed CFF, its glyph for "A" kept under "A"', async () => {
    const seen = await embeddedGlyphs(await bareCffPdf(buildCff(), 'name-keyed'));
    expect(seen?.a).toBe(true);
    expect(seen?.table).toContain('w:name="Sample"');
  });

  /** buildCff's charset (format 0, CIDs 34 and 35) rewritten in the same five bytes as `format`. */
  function withCharset(format: 0 | 1 | 2): Uint8Array {
    const cff = buildCff({ cid: 'with-fd', fdSelect: true });
    const at = cff.findIndex(
      (_, i) =>
        cff[i] === 0 && cff[i + 1] === 0 && cff[i + 2] === 34 && cff[i + 3] === 0 && cff[i + 4] === 35,
    );
    expect(at).toBeGreaterThan(0);
    // Format 1: one range, 34 and one more (a trailing byte is left over); format 2: the same with a 16-bit count.
    if (format === 1) cff.set([1, 0, 34, 1, 0], at);
    if (format === 2) cff.set([2, 0, 34, 0, 1], at);
    return cff;
  }

  it.each([0, 1, 2] as const)(
    'finds the glyph of a CID-keyed CFF by its CID, charset format %i',
    async (format) => {
      const seen = await embeddedGlyphs(await bareCffPdf(withCharset(format), 'cid-keyed'));
      expect(seen?.a).toBe(true);
    },
  );
});

describe('exact layout with a damaged font program', () => {
  /** A page drawing "A" in a font whose FontFile (2 or 3) is `program`, with `Subtype` as given. */
  async function damagedPdf(program: Uint8Array, file: 'FontFile2' | 'FontFile3'): Promise<Uint8Array> {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    try {
      const descriptor = doc.addObject({
        Type: 'FontDescriptor',
        FontName: 'AAAAAA+Sample',
        Flags: 32,
        FontBBox: [-200, -1500, 2000, 900],
        ItalicAngle: 0,
        Ascent: 900,
        Descent: -250,
        CapHeight: 700,
        StemV: 80,
        [file]: doc.addStream(program, file === 'FontFile3' ? { Subtype: 'Type1C' } : {}),
      });
      const font = doc.addObject({
        Type: 'Font',
        Subtype: file === 'FontFile2' ? 'TrueType' : 'Type1',
        BaseFont: 'AAAAAA+Sample',
        FirstChar: 65,
        LastChar: 65,
        Widths: [600],
        FontDescriptor: descriptor,
        Encoding: 'WinAnsiEncoding',
      });
      doc.insertPage(
        0,
        doc.addPage([0, 0, 400, 300], 0, { Font: { F0: font } }, 'BT /F0 18 Tf 40 200 Td (A) Tj ET\n'),
      );
      return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    } finally {
      doc.destroy();
    }
  }

  const embeddedCount = async (pdf: Uint8Array): Promise<number> => {
    const result = await exportOffice(pdf, options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);
    return Object.keys(zip.files).filter((name) => name.endsWith('.odttf')).length;
  };

  const sfnt = (version: string, tables: number, size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    bytes.set([...version].map((c) => c.charCodeAt(0)));
    bytes[5] = tables;
    return bytes;
  };

  /** A CID-keyed CFF whose CharStrings offset (a five-byte operand, `29 …`) starts with a byte that makes it a one-byte number: the Top DICT then reads on from the middle of the offset. */
  const withBrokenOperand = (() => {
    const cff = buildCff({ cid: 'with-fd', fdSelect: true });
    const at = cff.findIndex((byte, i) => byte === 29 && cff[i + 5] === 17);
    cff[at] = 242;
    return cff;
  })();

  it.each([
    ['a CFF whose CharStrings operand is cut to one byte', 'FontFile3', withBrokenOperand],
    ['a few bytes', 'FontFile2', new Uint8Array([1, 2, 3])],
    ['bytes that are no font at all', 'FontFile2', new Uint8Array(64).fill(7)],
    ['a table directory cut short', 'FontFile2', sfnt('\0\x01\0\0', 9, 40)],
    ['an OpenType header with no tables', 'FontFile3', sfnt('OTTO', 0, 32)],
    ['a TrueType collection', 'FontFile2', sfnt('ttcf', 0, 64)],
    ['a CFF cut off after its header', 'FontFile3', new Uint8Array([1, 0, 4, 1, 0, 9, 1, 1])],
    ['a CFF of two bytes', 'FontFile3', new Uint8Array([1, 0])],
    [
      'a CFF whose header size points beyond it',
      'FontFile3',
      new Uint8Array([1, 0, 40, 1, 0, 0, 0, 0, 0, 0]),
    ],
    ['a CFF with no names and no Top DICT', 'FontFile3', new Uint8Array([1, 0, 4, 1, 0, 0, 0, 0])],
    [
      'a CFF whose Top DICT holds a byte no DICT has',
      'FontFile3',
      new Uint8Array([1, 0, 4, 1, ...index([[65]]), ...index([[31]])]),
    ],
    [
      'a CID-keyed CFF whose CharStrings are beyond it',
      'FontFile3',
      new Uint8Array([
        1,
        0,
        4,
        1,
        ...index([[65]]),
        // ROS 0 0 0, charset at 5, CharStrings at 9999
        ...index([[139, 139, 139, 12, 30, 144, 15, 29, 0, 0, 39, 15, 17]]),
      ]),
    ],
    [
      'a CFF with an offset size no INDEX has',
      'FontFile3',
      new Uint8Array([1, 0, 4, 1, 0, 1, 9, 1, 2, 3, 4, 5, 6, 7, 8]),
    ],
  ] as const)('embeds nothing and still exports, from %s', async (_name, file, program) => {
    expect(await embeddedCount(await damagedPdf(program, file))).toBe(0);
  });

  it('embeds nothing from a stream MuPDF cannot decode', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    try {
      const stream = doc.addStream(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), {
        Filter: 'FlateDecode',
      });
      const descriptor = doc.addObject({
        Type: 'FontDescriptor',
        FontName: 'AAAAAA+Sample',
        Flags: 32,
        FontBBox: [0, 0, 1000, 1000],
        ItalicAngle: 0,
        Ascent: 900,
        Descent: -250,
        CapHeight: 700,
        StemV: 80,
        FontFile2: stream,
      });
      const font = doc.addObject({
        Type: 'Font',
        Subtype: 'TrueType',
        BaseFont: 'AAAAAA+Sample',
        FirstChar: 65,
        LastChar: 65,
        Widths: [600],
        FontDescriptor: descriptor,
        Encoding: 'WinAnsiEncoding',
      });
      doc.insertPage(
        0,
        doc.addPage([0, 0, 400, 300], 0, { Font: { F0: font } }, 'BT /F0 18 Tf 40 200 Td (A) Tj ET\n'),
      );
      expect(await embeddedCount(new Uint8Array(doc.saveToBuffer('compress').asUint8Array()))).toBe(0);
    } finally {
      doc.destroy();
    }
  });
});

describe('exact layout: fonts of a page, told from one another', () => {
  const hexOf = (font: { encodeCharacter(code: number): number }, text: string): string =>
    [...text]
      .map((c) =>
        font
          .encodeCharacter(c.codePointAt(0) as number)
          .toString(16)
          .padStart(4, '0'),
      )
      .join('');

  /** The font the run holding `text` is set in (its `w:rFonts` ascii name), or `undefined`. */
  const fontOf = (document: string, text: string): string | undefined => {
    const run = [...document.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)]
      .map((match) => match[1] ?? '')
      .find((xml) => new RegExp(`<w:t[^>]*>${text}</w:t>`).test(xml));
    return /w:ascii="([^"]+)"/.exec(run ?? '')?.[1];
  };

  /** The export of `pdf`: its `word/document.xml`, `word/fontTable.xml` and embedded programs. */
  async function exported(pdf: Uint8Array) {
    const result = await exportOffice(pdf, options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);
    return {
      result,
      document: (await zip.file('word/document.xml')?.async('string')) ?? '',
      table: (await zip.file('word/fontTable.xml')?.async('string')) ?? '',
      programs: Object.keys(zip.files).filter((name) => name.endsWith('.odttf')),
      zip,
    };
  }

  /** Two Noto Sans subsets (regular and medium, both regular style), named alike, tagged `AAAAAA` ("ab") and `BBBBBB` ("cd"), the second with `fsType` when given. */
  async function twoRegularSubsets(secondFsType?: number): Promise<Uint8Array> {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const fonts = [
      new mupdf.Font('NotoSans-Regular', notoRegular()),
      new mupdf.Font('NotoSans-Regular', noto('500Medium/NotoSans_500Medium.ttf')),
    ];
    try {
      const objects = fonts.map((font) => doc.addFont(font));
      doc.insertPage(
        0,
        doc.addPage(
          [0, 0, 400, 300],
          0,
          { Font: { F0: objects[0], F1: objects[1] } },
          `BT /F0 18 Tf 40 200 Td <${hexOf(fonts[0] as (typeof fonts)[number], 'ab')}> Tj ET\n` +
            `BT /F1 18 Tf 40 150 Td <${hexOf(fonts[1] as (typeof fonts)[number], 'cd')}> Tj ET\n`,
        ),
      );
      doc.subsetFonts();
      const resources = doc.findPage(0).get('Resources').get('Font');
      for (const [index, key] of ['F0', 'F1'].entries()) {
        const object = resources.get(key);
        const name = doc.newName(`${index === 0 ? 'AAAAAA' : 'BBBBBB'}+NotoSans-Regular`);
        object.put('BaseFont', name);
        object.get('DescendantFonts').get(0).put('BaseFont', name);
      }
      if (secondFsType !== undefined) {
        const file = resources.get('F1').get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
        const program = new Uint8Array(file.readStream().asUint8Array());
        setFsType(program, secondFsType);
        file.writeStream(program);
      }
      return new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array());
    } finally {
      for (const font of fonts) font.destroy();
      doc.destroy();
    }
  }

  it('names a second program of the same face and style "Family 2", and sets each text in its own', async () => {
    const { document, table, programs } = await exported(await twoRegularSubsets());
    expect(programs).toHaveLength(2);
    expect(table).toContain('<w:font w:name="NotoSans">');
    expect(table).toContain('<w:font w:name="NotoSans 2">');
    expect(fontOf(document, 'ab')).toBe('NotoSans');
    expect(fontOf(document, 'cd')).toBe('NotoSans 2');
  });

  it('leaves the text of a font Word may not embed in the fallback, though another font of the page is embedded', async () => {
    const { document, table, programs } = await exported(await twoRegularSubsets(0x0200));
    expect(programs).toHaveLength(1);
    expect(table).toContain('w:name="NotoSans"');
    expect(table).not.toContain('NotoSans 2');
    expect(fontOf(document, 'ab')).toBe('NotoSans');
    expect(fontOf(document, 'cd')).not.toMatch(/^NotoSans/);
  });

  it('embeds the font a page has and leaves the text of one it does not have in the fallback', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const font = new mupdf.Font('NotoSans-Regular', notoRegular());
    try {
      const helvetica = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
      doc.insertPage(
        0,
        doc.addPage(
          [0, 0, 400, 300],
          0,
          { Font: { F0: doc.addFont(font), F1: helvetica } },
          `BT /F0 18 Tf 40 200 Td <${hexOf(font, 'Stanbul')}> Tj ET\nBT /F1 18 Tf 40 150 Td (Plain) Tj ET\n`,
        ),
      );
      doc.subsetFonts();
      const { document, programs } = await exported(
        new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array()),
      );
      expect(programs).toHaveLength(1);
      expect(fontOf(document, 'Stanbul')).toBe('NotoSans');
      expect(fontOf(document, 'Plain')).toBe('Arial');
    } finally {
      font.destroy();
      doc.destroy();
    }
  });

  it('maps no glyph for the notdef glyph, a control character or U+FFFD, whatever the PDF says they read as', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const font = new mupdf.Font('NotoSans-Regular', notoRegular());
    try {
      const gid = (c: string) => font.encodeCharacter(c.codePointAt(0) as number);
      const hex = (n: number) => n.toString(16).padStart(4, '0');
      const [a, b, c] = [gid('A'), gid('B'), gid('C')];
      doc.insertPage(
        0,
        doc.addPage(
          [0, 0, 400, 300],
          0,
          { Font: { F0: doc.addFont(font) } },
          `BT /F0 18 Tf 40 200 Td <${hex(a)}0000${hex(b)}${hex(c)}> Tj ET\n`,
        ),
      );
      doc.subsetFonts();
      // The notdef glyph (code 0) reads as "Q", B's glyph as U+0007 (BEL), C's as U+FFFD.
      const cmap =
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Odd def /CMapType 2 def ' +
        `1 begincodespacerange <0000> <FFFF> endcodespacerange 4 beginbfchar <${hex(a)}> <0041> <0000> <0051> ` +
        `<${hex(b)}> <0007> <${hex(c)}> <FFFD> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
      doc.findPage(0).get('Resources').get('Font').get('F0').put('ToUnicode', doc.addStream(cmap, {}));
      const { zip, programs } = await exported(
        new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array()),
      );
      expect(programs).toHaveLength(1);
      const table = (await zip.file('word/fontTable.xml')?.async('string')) as string;
      const key = /w:fontKey="(\{[^"]+\})"/.exec(table)?.[1] as string;
      const embedded = new mupdf.Font(
        'Embedded',
        obfuscateFont((await zip.file('word/fonts/font1.odttf')?.async('uint8array')) as Uint8Array, key),
      );
      try {
        expect(embedded.encodeCharacter(0x41)).toBeGreaterThan(0);
        for (const code of [0x51, 0x07, 0xfffd]) expect(embedded.encodeCharacter(code)).toBe(0);
      } finally {
        embedded.destroy();
      }
    } finally {
      font.destroy();
      doc.destroy();
    }
  });
});

describe('exact layout with fonts in form XObjects', () => {
  /**
   * A page that only draws form `X`, which draws "ab" in Noto Sans; `wrappers` more forms
   * sit between them (each one draws the next), `shape` adds a second name for a form or a
   * form that draws itself.
   */
  async function formPdf(
    wrappers: number,
    shape: 'chain' | 'twice' | 'itself' = 'chain',
  ): Promise<Uint8Array> {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const font = new mupdf.Font('NotoSans-Regular', notoRegular());
    try {
      const fontObject = doc.addFont(font);
      const hex = [...'ab']
        .map((c) =>
          font
            .encodeCharacter(c.codePointAt(0) as number)
            .toString(16)
            .padStart(4, '0'),
        )
        .join('');
      const box = [0, 0, 400, 300];
      const text = doc.addStream(`BT /F0 18 Tf 40 200 Td <${hex}> Tj ET\n`, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: box,
        Resources: { Font: { F0: fontObject } },
      });
      if (shape === 'itself') text.get('Resources').put('XObject', doc.addObject({ X: text }));
      let inner = text;
      for (let level = 0; level < wrappers; level += 1)
        inner = doc.addStream('/X Do\n', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: box,
          Resources: { XObject: { X: inner } },
        });
      doc.insertPage(
        0,
        doc.addPage(
          [0, 0, 400, 300],
          0,
          { XObject: shape === 'twice' ? { X: inner, Y: inner } : { X: inner } },
          shape === 'twice' ? '/X Do /Y Do\n' : '/X Do\n',
        ),
      );
      return new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array());
    } finally {
      font.destroy();
      doc.destroy();
    }
  }

  const programsOf = async (pdf: Uint8Array): Promise<number> => {
    const result = await exportOffice(pdf, options, run);
    const zip = await JSZip.loadAsync(result.file.bytes);
    return Object.keys(zip.files).filter((name) => name.endsWith('.odttf')).length;
  };

  it('skips fonts with no program and XObjects that are no form, and embeds the one font that has a program', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const font = new mupdf.Font('NotoSans-Regular', notoRegular());
    try {
      const hex = [...'ab']
        .map((c) =>
          font
            .encodeCharacter(c.codePointAt(0) as number)
            .toString(16)
            .padStart(4, '0'),
        )
        .join('');
      const descriptor = doc.addObject({
        Type: 'FontDescriptor',
        FontName: 'Bare',
        Flags: 32,
        FontBBox: [0, 0, 1000, 1000],
        ItalicAngle: 0,
        Ascent: 900,
        Descent: -250,
        CapHeight: 700,
        StemV: 80,
      });
      const image = doc.addStream(new Uint8Array([0]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 1,
        Height: 1,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      });
      const form = doc.addStream('0 0 m\n', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] });
      doc.insertPage(
        0,
        doc.addPage(
          [0, 0, 400, 300],
          0,
          {
            Font: {
              F0: doc.addFont(font),
              // A composite font with no descendant, a font whose descriptor holds no program.
              F1: doc.addObject({
                Type: 'Font',
                Subtype: 'Type0',
                BaseFont: 'Empty',
                Encoding: 'Identity-H',
              }),
              F2: doc.addObject({
                Type: 'Font',
                Subtype: 'TrueType',
                BaseFont: 'Bare',
                FontDescriptor: descriptor,
              }),
            },
            XObject: { Im: image, Fm: form },
          },
          `BT /F0 18 Tf 40 200 Td <${hex}> Tj ET\n/Fm Do\n`,
        ),
      );
      doc.subsetFonts();
      const result = await exportOffice(
        new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array()),
        options,
        run,
      );
      const zip = await JSZip.loadAsync(result.file.bytes);
      expect(Object.keys(zip.files).filter((name) => name.endsWith('.odttf'))).toHaveLength(1);
      expect((await zip.file('word/document.xml')?.async('string')) ?? '').toContain('w:ascii="NotoSans"');
    } finally {
      font.destroy();
      doc.destroy();
    }
  });

  it('embeds a font the page only reaches through nested forms', async () => {
    expect(await programsOf(await formPdf(0))).toBe(1);
    expect(await programsOf(await formPdf(3))).toBe(1);
  });

  it('embeds it once when two names draw the same form', async () => {
    expect(await programsOf(await formPdf(1, 'twice'))).toBe(1);
  });

  it('finishes with a form that draws itself', async () => {
    expect(await programsOf(await formPdf(0, 'itself'))).toBe(1);
  });

  it('does not look for fonts past six levels of forms: the text keeps the fallback', async () => {
    expect(await programsOf(await formPdf(5))).toBe(1);
    expect(await programsOf(await formPdf(8))).toBe(0);
  });
});
