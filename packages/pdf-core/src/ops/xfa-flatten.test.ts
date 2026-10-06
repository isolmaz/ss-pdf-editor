/**
 * The flattened dynamic-XFA PDF, built from page pictures: one page per picture at the
 * template's size, the picture filling it, and an invisible text layer where the browser
 * laid the words out. The wrong answers that matter: a page at the wrong size, a picture
 * that does not fill the page, words that cannot be searched or sit in the wrong place, and
 * an empty form turned into an empty file.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { buildFlattenedXfa, type XfaRasterPage } from './xfa-flatten';

const run = { signal: new AbortController().signal };

/** A solid grey PNG, so the rendered page shows whether the picture fills it. */
async function png(width: number, height: number, grey: number): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, width, height], false);
  pixmap.clear(grey);
  const bytes = new Uint8Array(pixmap.asPNG());
  pixmap.destroy();
  return bytes;
}

async function inspect(bytes: Uint8Array) {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return Array.from({ length: doc.countPages() }, (_, index) => {
      const page = doc.loadPage(index);
      const [x0, y0, x1, y1] = page.getBounds();
      const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, false);
      const w = pixmap.getWidth();
      const h = pixmap.getHeight();
      const pixels = pixmap.getPixels();
      const at = (x: number, y: number) => pixels[y * pixmap.getStride() + x] as number;
      const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2), at(w >> 1, h >> 1)];
      const json = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
        blocks: { lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
      };
      return {
        size: [x1 - x0, y1 - y0],
        corners,
        lines: json.blocks.flatMap((block) => block.lines ?? []),
      };
    });
  } finally {
    doc.destroy();
  }
}

describe('buildFlattenedXfa', () => {
  beforeEach(() => {
    const file = createRequire(import.meta.url).resolve(
      '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
      { paths: [process.cwd()] },
    );
    const font = new Uint8Array(readFileSync(file));
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('makes one page per picture at the template size, filled by the picture, with searchable words in place', async () => {
    const pages: XfaRasterPage[] = [
      {
        widthPt: 300,
        heightPt: 400,
        scale: 2,
        png: await png(600, 800, 60),
        // Picture pixels, origin top-left: 100..260 across, 100..130 down, i.e. 50..130 pt, 50..65 pt.
        words: [{ text: 'Çağrı', x0: 100, y0: 100, x1: 260, y1: 130 }],
      },
      { widthPt: 500, heightPt: 200, scale: 2, png: await png(1000, 400, 120), words: [] },
    ];
    const out = await buildFlattenedXfa(pages, run);
    const read = await inspect(out.bytes);
    expect(read.map((page) => page.size)).toEqual([
      [300, 400],
      [500, 200],
    ]);
    // The picture covers every corner and the middle of its page, not just part of it.
    for (const value of read[0]?.corners ?? []) expect(Math.abs(value - 60)).toBeLessThanOrEqual(3);
    for (const value of read[1]?.corners ?? []) expect(Math.abs(value - 120)).toBeLessThanOrEqual(3);
    // The words are extractable, lie where the browser put them, and are not drawn.
    expect(read[0]?.lines.map((line) => line.text)).toEqual(['Çağrı']);
    const box = read[0]?.lines[0]?.bbox;
    expect(box?.x).toBeCloseTo(50, -1);
    expect((box?.x ?? 0) + (box?.w ?? 0)).toBeCloseTo(130, -1);
    expect(box?.y ?? 0).toBeGreaterThan(40);
    expect((box?.y ?? 0) + (box?.h ?? 0)).toBeLessThan(75);
    expect(read[1]?.lines).toEqual([]);

    expect(out.report).toMatchObject({ pageCount: 2, incremental: false });
    expect(out.report.steps).toEqual(['xfa.flatten', 'ocr.layer', 'verify', 'save']);
    expect(out.report.notes.map((entry) => entry.key)).toEqual([
      'xfa.note.flattened',
      'xfa.note.flattenPictures',
      'xfa.note.fieldsGone',
      'xfa.note.fonts',
    ]);
  });

  it('skips the text layer when no words were laid out, and refuses a form with no pages', async () => {
    const out = await buildFlattenedXfa(
      [{ widthPt: 200, heightPt: 100, scale: 1, png: await png(200, 100, 90), words: [] }],
      run,
    );
    expect(out.report.steps).toEqual(['xfa.flatten', 'verify', 'save']);
    expect((await inspect(out.bytes))[0]?.size).toEqual([200, 100]);
    await expect(buildFlattenedXfa([], run)).rejects.toMatchObject({ code: 'selection-empty' });
  });
});
