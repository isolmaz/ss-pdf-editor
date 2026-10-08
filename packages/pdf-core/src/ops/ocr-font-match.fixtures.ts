/**
 * Synthetic scans for the font matcher: a page of words set in a real font with MuPDF at a
 * resolution, noise added, and the word boxes as OCR would give them.
 */

import type { Mupdf } from '../engines/mupdf';
import type { MatchWord } from './ocr-font-match';
import type { RgbaImage } from './ocr-scene';

export const SENTENCES = [
  'Quick brown foxes jumped over seven lazy dogs while pale wizards boxed',
  'Experience includes project management, software engineering and research',
  'Education: university degree, certificate programs, workshops and training',
  'Skills such as leadership, communication, analysis, planning and delivery',
  'Summary of responsibilities handled during the previous twelve months',
  'Packing my box with five dozen liquor jugs gave Jackie quite a thrill',
];

/** Deterministic noise in [-1, 1] (a sum of three uniforms, so bell-shaped). */
export function noise(seed: number): () => number {
  let state = seed >>> 0 || 1;
  const uniform = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return () => (uniform() + uniform() + uniform()) / 1.5 - 1;
}

export interface Scan {
  readonly image: RgbaImage;
  readonly words: MatchWord[];
}

/**
 * The sentences in `font` at `size` pt, `dpi` dots per inch, grey noise of `amplitude` (0–255)
 * over a paper of 245; the boxes are the words' advances by ascender to descender, and the
 * sizes carry `sizeError` (a factor) as the OCR's estimate would.
 */
export function renderScan(
  mupdf: Mupdf,
  font: import('mupdf').Font,
  options: { dpi: number; size: number; amplitude: number; sizeError?: number; seed?: number },
): Scan {
  const scale = options.dpi / 72;
  const { size } = options;
  const width = Math.ceil(540 * scale);
  const height = Math.ceil((SENTENCES.length * size * 1.6 + 40) * scale);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, width, height], false);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
  const words: MatchWord[] = [];
  const text = new mupdf.Text();
  try {
    pixmap.clear(245);
    SENTENCES.forEach((sentence, row) => {
      const baseline = (20 + size * 1.6 * (row + 1)) * scale;
      let pen = 20 * scale;
      for (const word of sentence.split(' ')) {
        const px = size * scale;
        const advance = [...word].reduce(
          (sum, char) => sum + font.advanceGlyph(font.encodeCharacter(char.codePointAt(0) as number), 0) * px,
          0,
        );
        text.showString(font, [px, 0, 0, -px, pen, baseline], word);
        words.push({
          text: word,
          box: [
            pen / scale,
            baseline / scale - 0.76 * size,
            (pen + advance) / scale,
            baseline / scale + 0.24 * size,
          ],
          size: size * (options.sizeError ?? 1),
          bold: false,
          italic: false,
        });
        pen += advance + font.advanceGlyph(font.encodeCharacter(32), 0) * px;
      }
    });
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
    device.close();
    const gray = pixmap.getPixels();
    const random = noise(options.seed ?? 7);
    const data = new Uint8Array(width * height * 4);
    for (let at = 0; at < width * height; at++) {
      const value = Math.max(0, Math.min(255, (gray[at] as number) + random() * options.amplitude));
      data.set([value, value, value, 255], at * 4);
    }
    return { image: { width, height, data, scale }, words };
  } finally {
    text.destroy();
    device.destroy();
    pixmap.destroy();
  }
}
