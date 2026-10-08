/**
 * The verification step re-reads the produced file with pdf.js. A healthy run never fails
 * it, so these tests wrap pdf.js at its loading seam: the file is real, the reader's answer
 * is wrong in one chosen way. Each case proves the wrong answer is refused with the reason
 * named (`verification-failed`) instead of the edit being reported as done.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfDocumentHandle, PdfOpenOptions, TextContentPage } from '../engines/pdfjs-handle';

type Reader = (handle: PdfDocumentHandle) => PdfDocumentHandle;
const state: { reader: Reader | null } = { reader: null };

vi.mock('../engines/pdfjs-handle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/pdfjs-handle')>();
  return {
    ...actual,
    openWithPdfjs: async (bytes: Uint8Array, options?: PdfOpenOptions) => {
      const handle = await actual.openWithPdfjs(bytes, options);
      return state.reader === null ? handle : state.reader(handle);
    },
  };
});

const { applyTextEdit } = await import('./text-edit');
const run = { signal: new AbortController().signal };

async function page(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const content = 'BT /F 14 Tf 40 200 Td (Eski satir) Tj ET BT /F 14 Tf 40 100 Td (Kalan) Tj ET';
  doc.insertPage(0, doc.addPage([0, 0, 400, 300], 0, { Font: { F: font } }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const request = {
  erase: [{ pageIndex: 0, rects: [[35, 82, 200, 104] as [number, number, number, number]] }],
  insert: [
    {
      pageIndex: 0,
      lines: [
        { text: 'Yeni', x: 40, y: 100, fontSize: 14, color: '#000000', fontId: 'helvetica', width: 100 },
      ],
    },
  ],
  fonts: {},
};

/** The reader reports the real text plus one more run. */
const withExtraRun =
  (text: string, x: number, y: number): Reader =>
  (handle) => ({
    ...handle,
    textContent: async (pageIndex): Promise<TextContentPage> => {
      const content = await handle.textContent(pageIndex);
      const [first] = content.items;
      if (first === undefined) throw new Error('the page has no text to copy a run from');
      return { ...content, items: [...content.items, { ...first, text, x, y }] };
    },
  });

beforeEach(() => {
  const file = createRequire(import.meta.url).resolve(
    '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
    { paths: [process.cwd()] },
  );
  const font = new Uint8Array(readFileSync(file));
  vi.stubGlobal('fetch', async () => new Response(font));
});
afterEach(() => {
  state.reader = null;
  vi.unstubAllGlobals();
});

describe('applyTextEdit verification', () => {
  it('refuses a file the reader counts a different number of pages in', async () => {
    state.reader = (handle) => ({ ...handle, pageCount: handle.pageCount + 1 });
    await expect(applyTextEdit(await page(), request, run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engine: 'pdfjs', engineMessage: 'page count changed: 1 → 2' },
    });
  });

  it('refuses a file in which the reader still finds foreign text starting inside an erased rectangle', async () => {
    // The rectangle is [35, 82, 200, 104] from the top of a 300 pt page: user y 196 … 218.
    state.reader = withExtraRun('Leftover', 60, 200);
    await expect(applyTextEdit(await page(), request, run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: {
        engineMessage: 'page 0: text still starts inside an erased rectangle: “Leftover”',
      },
    });
  });

  it('refuses a file in which the erased text is still searchable elsewhere on the page', async () => {
    state.reader = withExtraRun('Eski satir', 300, 20);
    await expect(applyTextEdit(await page(), request, run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engineMessage: 'page 0: erased text is still searchable: “Eskisatir”' },
    });
  });
});
