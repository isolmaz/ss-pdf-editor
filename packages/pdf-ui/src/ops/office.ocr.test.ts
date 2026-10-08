/**
 * The PDF → Word dialog reading a scanned page with OCR: the dialog's scan languages reach the
 * recogniser, the page picture it sends is a PNG, and the words it returns are in the Word file.
 * Only the third-party engine is replaced, at its loading boundary (as in `tesseract.worker.test.ts`):
 * the dialog, `recognizePage`, the exact-layout writer and MuPDF are the real ones.
 */

import { createRequire } from 'node:module';
import { loadMupdf } from 'pdf-core/engines/mupdf';
import { fixturePage } from 'pdf-core/ops/layout-fixtures';
import { createTranslator } from 'pdf-shared';
import { describe, expect, it, vi } from 'vitest';
import type { OpRunContext } from '../dialogs/types';

const JSZip = createRequire(new URL('../../../pdf-core/package.json', import.meta.url))('jszip') as {
  loadAsync(
    data: Uint8Array,
  ): Promise<{ file(name: string): { async(type: 'string'): Promise<string> } | null }>;
};

const state = vi.hoisted(() => ({
  created: [] as string[][],
  recognized: [] as Blob[],
}));

vi.mock('/engines/tesseract/tesseract.esm.min.js', () => ({
  default: undefined,
  createWorker: async (languages: string[]) => {
    state.created.push(languages);
    return {
      setParameters: async () => {},
      recognize: async (image: Blob) => {
        state.recognized.push(image);
        return {
          data: {
            // What a crop of one word reads as (the page read has blocks and ignores it).
            text: ' SQL\n',
            confidence: 90,
            blocks: [
              {
                paragraphs: [
                  {
                    lines: [
                      {
                        words: [
                          { text: 'Merhaba', bbox: { x0: 100, y0: 100, x1: 300, y1: 140 }, confidence: 95 },
                          { text: 'SOL', bbox: { x0: 320, y0: 100, x1: 400, y1: 140 }, confidence: 99 },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      },
      terminate: async () => {},
    };
  },
}));

/** A one-page PDF that is only a picture of a page of text: a scan. */
async function scan(): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const source = mupdf.Document.openDocument(
    (await fixturePage([{ text: 'Merhaba', x: 50, y: 400, size: 24 }])).slice(),
    'application/pdf',
  );
  const doc = new mupdf.PDFDocument();
  try {
    const pixmap = source
      .loadPage(0)
      .toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceRGB, false, false);
    const image = doc.addImage(new mupdf.Image(pixmap.asPNG()));
    pixmap.destroy();
    doc.insertPage(
      -1,
      doc.addPage([0, 0, 400, 500], 0, { XObject: { Im0: image } }, 'q 400 0 0 500 0 0 cm /Im0 Do Q\n'),
    );
    return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  } finally {
    doc.destroy();
    source.destroy();
  }
}

describe('export-office dialog with a scanned page', () => {
  it('reads the page in the chosen languages and writes the words it finds into the Word file', async () => {
    const { exportOfficeDialog } = await import('./office');
    const bytes = await scan();
    const context: OpRunContext = {
      signal: new AbortController().signal,
      onProgress: () => {},
      bytes,
      pageCount: 1,
      name: 'tarama.pdf',
      currentPage: 0,
      selectedPages: [],
      t: createTranslator('tr'),
    };
    const result = await exportOfficeDialog.run(
      { scope: 'all', format: 'docx', layout: 'layout', ocrLanguages: ['tur', 'eng', 'not-a-language'] },
      context,
    );
    // The page, then the capitals read again with English alone (the crop of "SOL").
    expect(state.recognized).toHaveLength(2);
    expect(state.created).toEqual([['tur', 'eng'], ['eng']]);
    expect((state.recognized[0] as Blob).type).toBe('image/png');
    expect((state.recognized[0] as Blob).size).toBeGreaterThan(1000);
    expect(result.report.notes.map((entry) => entry.key)).toContain('op.note.exportOffice.ocrPages');
    const zip = await JSZip.loadAsync(result.files?.[0]?.bytes ?? new Uint8Array());
    const document = (await zip.file('word/document.xml')?.async('string')) ?? '';
    // The word may be written in pieces (a run per fitted part); read together they are the word.
    const written = [...document.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('');
    expect(written).toContain('Merhaba');
    expect(written).toContain('SQL');
  });

  it('does not load English to read capitals again when it is not among the chosen languages', async () => {
    const { exportOfficeDialog } = await import('./office');
    const before = state.recognized.length;
    const result = await exportOfficeDialog.run(
      { scope: 'all', format: 'docx', layout: 'layout', ocrLanguages: ['tur'] },
      {
        signal: new AbortController().signal,
        onProgress: () => {},
        bytes: await scan(),
        pageCount: 1,
        name: 'tarama.pdf',
        currentPage: 0,
        selectedPages: [],
        t: createTranslator('tr'),
      },
    );
    expect(state.recognized.length - before).toBe(1);
    expect(state.created.slice(-1)).toEqual([['tur']]);
    expect(result.files).toHaveLength(1);
  });
});
