/**
 * **Test-only.** The untagged two-page document the PDF/UA and structure-editor tests start
 * from, built with MuPDF at run time. Page 1: a 24 pt heading, an 11 pt paragraph and an image;
 * page 2: another paragraph and the same image. The font is embedded. Imported only by tests.
 */

import { readFileSync } from 'node:fs';
import { tagDocument } from './accessibility';

export const run = { signal: new AbortController().signal };

export async function untaggedFixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  // A real embedded program (the pinned Noto Sans): PDF/UA wants every font embedded.
  const program = new Uint8Array(
    readFileSync(new URL('../../../../public/fonts/noto/NotoSans-Regular.ttf', import.meta.url)),
  );
  const font = doc.addSimpleFont(new mupdf.Font('NotoSans', program), 'Latin');
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
  pixmap.clear(0);
  const image = doc.addImage(new mupdf.Image(pixmap));
  const resources = { Font: { F: font }, XObject: { Im1: image } };
  const first =
    'BT /F 24 Tf 72 760 Td (Annual Report) Tj ET\n' +
    'BT /F 11 Tf 72 700 Td (The year was good for everyone involved.) Tj ET\n' +
    'q 100 0 0 100 72 500 cm /Im1 Do Q';
  const second =
    'BT /F 11 Tf 72 760 Td (Second page body text is here.) Tj ET\nq 50 0 0 50 72 600 cm /Im1 Do Q';
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, resources, first));
  doc.insertPage(1, doc.addPage([0, 0, 595, 842], 0, resources, second));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The same document after `tagDocument`: Document, H1, two P and two Figure elements. */
export async function taggedFixture(language = 'en-US'): Promise<Uint8Array> {
  return (await tagDocument(await untaggedFixture(), run, { language })).bytes;
}
