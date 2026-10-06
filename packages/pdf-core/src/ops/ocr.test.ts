/**
 * The OCR text layer against real bytes, with pdf.js's own viewport as the map from
 * rendered pixels to PDF space. The wrong answers that matter: a Turkish word that
 * cannot be extracted, a layer that lands sideways or elsewhere on a turned page, a word
 * whose selection overflows its box, and a layer that paints over the scan.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPdfjs, openWithPdfjs } from '../engines/pdfjs-handle';
import { writeOcrLayer } from './ocr';

const pdfjs = await loadPdfjs();
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  // The legacy worker: the modern one calls `Math.sumPrecise`, which this Node lacks.
  createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const run = { signal: new AbortController().signal };

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

/** A plain 300×400 page and a 400×300 page turned a quarter (shown 300×400 too). */
async function scans(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  doc.insertPage(1, doc.addPage([0, 0, 400, 300], 90, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Words MuPDF extracts from a page, with their boxes in displayed space. */
async function extracted(bytes: Uint8Array, pageIndex: number) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    const json = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
      blocks: { lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
    };
    const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false);
    const blank = pixmap.getPixels().every((value) => value === 255);
    return { lines: json.blocks.flatMap((block) => block.lines ?? []), blank };
  } finally {
    doc.destroy();
  }
}

describe('writeOcrLayer', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts invisible, extractable words where they were seen, on a turned page too', async () => {
    const input = await scans();
    const handle = await openWithPdfjs(input);
    const layers = [];
    try {
      for (const pageIndex of [0, 1]) {
        const viewport = (await handle.raw.getPage(pageIndex + 1)).getViewport({ scale: 1 });
        layers.push({
          pageIndex,
          // Displayed (rendered) pixels at 72 dpi: a word 100 wide, 20 tall.
          words: [{ text: 'Çarşı', x0: 50, y0: 100, x1: 150, y1: 120, confidence: 90 }],
          toPdfPoint: (x: number, y: number) => viewport.convertToPdfPoint(x, y) as [number, number],
        });
      }
    } finally {
      await handle.destroy();
    }
    const out = await writeOcrLayer(input, layers, run);

    for (const pageIndex of [0, 1]) {
      const page = await extracted(out, pageIndex);
      expect(page.blank).toBe(true);
      expect(page.lines.map((line) => line.text)).toEqual(['Çarşı']);
      const box = page.lines[0]?.bbox;
      // Horizontal on the displayed page and inside the word's box.
      expect(box?.x).toBeCloseTo(50, -1);
      expect((box?.x ?? 0) + (box?.w ?? 0)).toBeCloseTo(150, -1);
      expect((box?.y ?? 0) + (box?.h ?? 0)).toBeGreaterThan(110);
      expect(box?.y ?? 0).toBeLessThan(110);
      expect(box?.w ?? 0).toBeGreaterThan(box?.h ?? 0);
    }
  });
});
