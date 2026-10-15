/**
 * A page built in a test whose text holds characters above U+FFFF, for the readers that must hand
 * a character over whole (`text-source.test.ts`, `ops/export-office.astral.test.ts`): an emoji, a
 * mathematical letter, a Linear B syllable and a SignWriting sign, each of them two UTF-16 units.
 *
 * The characters come from a `/ToUnicode` map: Courier shows the codes 1 to 4, which the map hands
 * over as U+1F600, U+1D400, U+10000 and U+1D800 (UTF-16BE pairs, written out in hex so that the
 * fixture does not lean on the code it checks). MuPDF's stock binding keeps only the low 16 bits of
 * such a code point: U+1F600 reads as U+F600, U+1D400 as U+D400, U+10000 as U+0000 and U+1D800 as a
 * lone `\uD800`.
 */

import { loadMupdf } from './engines/mupdf';

const TO_UNICODE = [
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
  '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
  '1 begincodespacerange <00> <FF> endcodespacerange',
  '4 beginbfchar <01> <D83DDE00> <02> <D835DC00> <03> <D800DC00> <04> <D836DC00> endbfchar',
  'endcmap end end',
].join('\n');

/** The four code points above U+FFFF the page shows, in order. */
export const ASTRAL_CODE_POINTS: readonly number[] = [0x1f600, 0x1d400, 0x10000, 0x1d800];

/** The same four characters, built with `String.fromCodePoint`. */
export const ASTRAL_CHARACTERS = ASTRAL_CODE_POINTS.map((code) => String.fromCodePoint(code));

/** The page's one line as it reads: Latin letters on both sides of the four characters. */
export const ASTRAL_LINE = `Hi ${ASTRAL_CHARACTERS.join('')} ok`;

/** A 200 × 200 pt page holding `ASTRAL_LINE`. */
export async function astralPage(): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  try {
    const font = doc.addObject({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Courier',
      Encoding: 'WinAnsiEncoding',
      ToUnicode: doc.addStream(TO_UNICODE, {}),
    });
    const content = 'BT /F 12 Tf 10 100 Td (Hi \\001\\002\\003\\004 ok) Tj ET';
    doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, { Font: { F: font } }, content));
    return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  } finally {
    doc.destroy();
  }
}
