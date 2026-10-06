/**
 * Typed text: the pure wrap, and the writer against real bytes with the real
 * pinned face. The wrong answers that matter are a line wider than its box (the reader
 * clips it, and letters vanish), a Turkish letter that cannot be encoded, and a box the
 * writer claims to have written but that a re-read cannot find.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FREETEXT_LINE_HEIGHT,
  FREETEXT_PADDING,
  planFreeTextLayout,
  writeFreeTextAnnotations,
} from './annotation-freetext';
import type { AnnotationMark } from './annotations';

/** One point per character: widths are easy to reason about in the planner cases. */
const perCharacter = (value: string): number => value.length;

describe('planFreeTextLayout', () => {
  it('keeps every line within the box, padding included', () => {
    const width = 12 + 2 * FREETEXT_PADDING;
    const layout = planFreeTextLayout('bir iki üç dört beş altı', width, 10, perCharacter);
    for (const line of layout.lines) expect(perCharacter(line)).toBeLessThanOrEqual(12);
    expect(layout.lines.join(' ')).toBe('bir iki üç dört beş altı');
  });

  it('keeps hard line breaks, including an empty line', () => {
    const layout = planFreeTextLayout('bir\n\niki', 100, 10, perCharacter);
    expect(layout.lines).toEqual(['bir', '', 'iki']);
  });

  it('breaks a word wider than the box between characters instead of overflowing', () => {
    // Size 4: the box is never narrower than one em, so a 6-point box needs a smaller size.
    const layout = planFreeTextLayout('çokuzunbirkelime', 6 + 2 * FREETEXT_PADDING, 4, perCharacter);
    expect(layout.lines).toEqual(['çokuzu', 'nbirke', 'lime']);
  });

  it('measures its height from the line count, the pitch and the padding', () => {
    const layout = planFreeTextLayout('a\nb\nc', 100, 10, perCharacter);
    expect(layout.height).toBe(3 * 10 * FREETEXT_LINE_HEIGHT + 2 * FREETEXT_PADDING);
  });
});

/** The pinned regular face, as `fetch:engines` copies it from this package. */
function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

function mark(overrides: Partial<AnnotationMark> = {}): AnnotationMark {
  return {
    id: 'text-1',
    kind: 'freetext',
    pageIndex: 0,
    quads: [],
    rect: [72, 72, 292, 100],
    color: '#1a4dff',
    opacity: 1,
    contents: 'Şişli’de ığdır — İĞÜŞÖÇ',
    author: 'Deneme',
    createdAt: '2026-09-28T10:00:00.000Z',
    fontSize: 12,
    ...overrides,
  };
}

async function blankPdf(pages = 1): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < pages; index += 1)
    doc.insertPage(index, doc.addPage([0, 0, 595, 842], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('writeFreeTextAnnotations', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes a /FreeText with its marker, its text and an appearance using the embedded face', async () => {
    const outcome = await writeFreeTextAnnotations(await blankPdf(), [mark()], {
      signal: new AbortController().signal,
    });
    expect(outcome.report.steps).toContain('annotations.freetext');

    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(outcome.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const annots = doc.findPage(0).get('Annots').resolve();
      expect(annots.length).toBe(1);
      const dict = annots.get(0).resolve();
      expect(dict.get('Subtype').asName()).toBe('FreeText');
      const text = dict.get('Contents').asString();
      expect(text).toContain('pdf-editor-ann:text-1');
      expect(text).toContain('Şişli’de ığdır — İĞÜŞÖÇ');
      // The box keeps the clicked top-left corner (72, 72 from the top) and the width;
      // its height is one line of the wrapped text: the pitch plus the padding.
      const box = dict.get('Rect').resolve();
      const [x0, y0, x1, y1] = [0, 1, 2, 3].map((index) => box.get(index).asNumber());
      expect(x0).toBeCloseTo(72);
      expect((x1 ?? 0) - (x0 ?? 0)).toBeCloseTo(220);
      expect(y1).toBeCloseTo(842 - 72);
      expect((y1 ?? 0) - (y0 ?? 0)).toBeCloseTo(12 * FREETEXT_LINE_HEIGHT + 2 * FREETEXT_PADDING);
      // The appearance draws with the embedded face, not a WinAnsi base font.
      const normal = dict.get('AP').get('N');
      expect(normal.isStream()).toBe(true);
      const fonts = normal.resolve().get('Resources').get('Font').resolve();
      const baseFonts: string[] = [];
      fonts.forEach((font) => {
        baseFonts.push(font.resolve().get('BaseFont').asName());
      });
      expect(baseFonts.some((name) => name.includes('NotoSans'))).toBe(true);
    } finally {
      doc.destroy();
    }
  });

  /** What a reader paints for page 1 at 1 px per point: the bounds of the non-white pixels and the strongest red. */
  async function inkOf(bytes: Uint8Array) {
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
    try {
      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const pixels = pixmap.getPixels();
      const width = pixmap.getWidth();
      const stride = pixmap.getNumberOfComponents();
      let count = 0;
      const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
      let darkest: number[] = [255, 255, 255];
      for (let y = 0; y < pixmap.getHeight(); y += 1) {
        for (let x = 0; x < width; x += 1) {
          const at = (y * width + x) * stride;
          const rgb = [pixels[at] ?? 255, pixels[at + 1] ?? 255, pixels[at + 2] ?? 255];
          if (rgb.every((channel) => channel >= 250)) continue;
          count += 1;
          box.x0 = Math.min(box.x0, x);
          box.y0 = Math.min(box.y0, y);
          box.x1 = Math.max(box.x1, x);
          box.y1 = Math.max(box.y1, y);
          if (rgb[0] !== undefined && rgb[0] < (darkest[0] ?? 255)) darkest = rgb;
        }
      }
      return { count, box, darkest };
    } finally {
      doc.destroy();
    }
  }

  it('paints the typed text inside its box, in the mark colour', async () => {
    const signal = new AbortController().signal;
    const solid = await writeFreeTextAnnotations(await blankPdf(), [mark()], { signal });
    const ink = await inkOf(solid.bytes);
    // The words are really drawn (a dictionary with an empty appearance has none of this)...
    expect(ink.count).toBeGreaterThan(100);
    // ...within the box the mark asked for: x 72..292, and 72 pt down from the top for one line...
    expect(ink.box.x0).toBeGreaterThanOrEqual(72);
    expect(ink.box.x1).toBeLessThanOrEqual(292);
    expect(ink.box.y0).toBeGreaterThanOrEqual(72);
    expect(ink.box.y1).toBeLessThanOrEqual(72 + 12 * FREETEXT_LINE_HEIGHT + 2 * FREETEXT_PADDING);
    // ...with the line vertically centred in its 15 pt line box (2 pt of padding below the top).
    const lineCentre = 72 + FREETEXT_PADDING + (12 * FREETEXT_LINE_HEIGHT) / 2;
    expect(Math.abs((ink.box.y0 + ink.box.y1) / 2 - lineCentre)).toBeLessThan(3);
    // ...in #1a4dff.
    expect(ink.darkest).toEqual([0x1a, 0x4d, 0xff]);
  });

  it('records the opacity and the print flag on the annotation', async () => {
    const outcome = await writeFreeTextAnnotations(await blankPdf(), [mark({ opacity: 0.5 })], {
      signal: new AbortController().signal,
    });
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(outcome.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const dict = doc.findPage(0).get('Annots').resolve().get(0).resolve();
      expect(dict.get('CA').asNumber()).toBeCloseTo(0.5);
      expect(dict.get('F').asNumber()).toBe(4);
    } finally {
      doc.destroy();
    }
  });

  it('writes nothing, and says so, for a box left empty', async () => {
    const input = await blankPdf();
    const outcome = await writeFreeTextAnnotations(input, [mark({ contents: '   ' })], {
      signal: new AbortController().signal,
    });
    expect(outcome.bytes).toBe(input);
    expect(outcome.written).toEqual([]);
    expect(outcome.report.steps).toEqual(['annotations.freetext.skipped']);
  });

  it('refuses a mark on a page the document does not have', async () => {
    await expect(
      writeFreeTextAnnotations(await blankPdf(1), [mark({ pageIndex: 3 })], {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'range-invalid' });
  });
});
