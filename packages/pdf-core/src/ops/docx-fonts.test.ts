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

/** A one-page PDF of `text` set in Noto Sans, embedded as a Type0 / Identity-H font (the fidelity samples' way). */
async function notoPdf(text: string): Promise<Uint8Array> {
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
      { Font: { F0: object } },
      `BT /F0 18 Tf 40 200 Td <${hex}> Tj ET\n`,
    );
    doc.insertPage(0, page);
    doc.subsetFonts();
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
