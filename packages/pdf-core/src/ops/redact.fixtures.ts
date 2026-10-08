/**
 * Pages built in a test for the redaction tests (`redact.test.ts`, `redact-find.test.ts`):
 * Helvetica lines on 400×500 pages, and a reader for what the engine extracts back.
 */

import type { PDFDocument } from 'mupdf';
import { loadMupdf } from '../engines/mupdf';
import type { RedactRect } from './redact';

/** A mark in the app's page space: x as in PDF user space, y counted down from the top. */
export const mark = (rect: readonly [number, number, number, number], pageIndex = 0): RedactRect => ({
  pageIndex,
  space: 'app-v1',
  rect,
});

/** 400×500 pages, Helvetica lines at (x, baseline y from the bottom); `rotate` is `/Rotate`. */
export async function build(
  pages: readonly {
    readonly lines: readonly (readonly [string, number, number])[];
    readonly rotate?: 0 | 90 | 180 | 270;
    readonly size?: number;
  }[],
  prepare?: (doc: PDFDocument) => void,
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  pages.forEach((page, index) => {
    const content = page.lines
      .map(([text, x, y]) => `BT /F1 ${page.size ?? 12} Tf ${x} ${y} Td (${text}) Tj ET`)
      .join('\n');
    doc.insertPage(index, doc.addPage([0, 0, 400, 500], page.rotate ?? 0, { Font: { F1: font } }, content));
  });
  prepare?.(doc);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Page texts of a document, as MuPDF extracts them. */
export async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf');
  const texts: string[] = [];
  for (let index = 0; index < doc.countPages(); index += 1) {
    const page = doc.loadPage(index);
    texts.push(page.toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' ').trim());
    page.destroy();
  }
  doc.destroy();
  return texts;
}

export const TWO_LINES = {
  lines: [
    ['Public line', 50, 400],
    ['Secret 4711', 50, 300],
  ] as const,
};
