/**
 * Pages built in a test for straightening (`deskew.test.ts`, and the browser spec): bitmaps of text
 * lines tilted by a known angle, and PDFs whose pages are pictures of such text — scans, with no
 * text layer. MuPDF is imported by name, as the other fixtures the browser specs share do, so the
 * file runs in Node as well as under the unit suite.
 */

import type { PDFObject } from 'mupdf';
import type { Grey } from './ocr-preprocess';

export const PAGE_WIDTH = 595;
export const PAGE_HEIGHT = 842;

/** A small deterministic generator (mulberry32): the same seed gives the same page. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BitmapOptions {
  readonly width?: number;
  readonly height?: number;
  /** Positive: the text lines descend to the right. */
  readonly degrees: number;
  /** The point the text is tilted about, in pixels; the centre of the bitmap by default (a sheet laid crooked on the glass turns about its own centre, wherever that is). */
  readonly pivot?: readonly [number, number];
  /** Distance from the page edge to the text block, in pixels. */
  readonly margin?: number;
  /** Distance between two lines, in pixels. */
  readonly pitch?: number;
  /** At most this many lines (the block ends at the bottom margin otherwise). */
  readonly rows?: number;
  /** At most this many letters to a line (the line ends at the right margin otherwise). */
  readonly columns?: number;
  /** The standard deviation of the grey noise added to every pixel. */
  readonly noise?: number;
  /** Share of pixels turned black or white, as dust and holes in a bad scan. */
  readonly speckle?: number;
  readonly seed?: number;
}

/**
 * A page of text as a greyscale bitmap: lines of word-shaped blocks (letters 4 pixels wide and
 * 8 high, a gap between words), tilted by `degrees` about the pivot, anti-aliased by 3 × 3
 * supersampling, with optional grey noise and speckle.
 */
export function textBitmap(options: BitmapOptions): Grey {
  const width = options.width ?? 850;
  const height = options.height ?? 1200;
  const margin = options.margin ?? 130;
  const pitch = options.pitch ?? 16;
  const next = random(options.seed ?? 1);
  const rows = Math.min(options.rows ?? Infinity, Math.floor((height - 2 * margin) / pitch));
  const columns = Math.min(options.columns ?? Infinity, Math.floor((width - 2 * margin) / 5));
  // Which letter cells of each row carry ink: words of three to eight letters, a blank cell between.
  const cells: boolean[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const cellsOfRow: boolean[] = [];
    while (cellsOfRow.length < columns) {
      const letters = 3 + Math.floor(next() * 6);
      for (let letter = 0; letter < letters; letter += 1) cellsOfRow.push(next() < 0.88);
      cellsOfRow.push(false);
    }
    cells.push(cellsOfRow);
  }
  const inked = (u: number, v: number): boolean => {
    const x = u - margin;
    const y = v - margin;
    if (x < 0 || y < 0) return false;
    const row = Math.floor(y / pitch);
    const column = Math.floor(x / 5);
    if (row >= rows || column >= columns || y - row * pitch >= 8 || x - column * 5 >= 4) return false;
    return cells[row]?.[column] === true;
  };
  const radians = (options.degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const [pivotX, pivotY] = options.pivot ?? [width / 2, height / 2];
  const data = new Uint8Array(width * height);
  const noise = options.noise ?? 0;
  const speckle = options.speckle ?? 0;
  const SUB = 3;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < SUB; sy += 1) {
        for (let sx = 0; sx < SUB; sx += 1) {
          const dx = x + (sx + 0.5) / SUB - pivotX;
          const dy = y + (sy + 0.5) / SUB - pivotY;
          if (inked(cos * dx + sin * dy + pivotX, -sin * dx + cos * dy + pivotY)) covered += 1;
        }
      }
      let value = 255 - (255 * covered) / (SUB * SUB);
      if (noise > 0) value += (next() + next() + next() - 1.5) * 2 * noise;
      if (speckle > 0 && next() < speckle) value = next() < 0.5 ? 0 : 255;
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return { width, height, data };
}

/**
 * Content operators for `rows` lines of Helvetica text, tilted by `degrees` (positive: descending
 * to the right) about `pivot` (the page centre by default, in points from the lower-left corner).
 */
export function tiltedText(
  degrees: number,
  options: {
    readonly rows?: number;
    readonly size?: number;
    readonly left?: number;
    readonly top?: number;
    readonly pivot?: readonly [number, number];
  } = {},
): string {
  const rows = options.rows ?? 48;
  const words =
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris'.split(
      ' ',
    );
  const lines = Array.from(
    { length: rows },
    (_unused, row) =>
      `BT /F1 ${options.size ?? 10} Tf ${options.left ?? 55} ${(options.top ?? 780) - row * 14.5} Td (${Array.from(
        { length: 12 },
        (_word, at) => words[(row * 5 + at * 7) % words.length],
      ).join(' ')}) Tj ET`,
  );
  const [pivotX, pivotY] = options.pivot ?? [PAGE_WIDTH / 2, PAGE_HEIGHT / 2];
  const phi = (-degrees * Math.PI) / 180;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const matrix = [c, s, -s, c, pivotX - (c * pivotX - s * pivotY), pivotY - (s * pivotX + c * pivotY)];
  return `q ${matrix.map((value) => value.toFixed(6)).join(' ')} cm\n${lines.join('\n')}\nQ`;
}

export interface ScanPage {
  /** Operators typeset on a page of `size`, then photographed. */
  readonly content: string;
  readonly size?: readonly [number, number];
  /** The page's `/Rotate` in the scan. */
  readonly rotate?: 0 | 90 | 180 | 270;
  /** A `/CropBox` for the scan page, `[x0, y0, x1, y1]`. */
  readonly cropBox?: readonly [number, number, number, number];
  readonly noise?: number;
  /** Adds a square annotation to the page. */
  readonly annotated?: boolean;
  /** Writes an empty `/Annots` array. */
  readonly emptyAnnots?: boolean;
  readonly seed?: number;
}

/**
 * A document of scans: every page is a greyscale picture (150 dpi) of its typeset content
 * and nothing else — no text layer, no vector content.
 */
export async function scanDocument(pages: readonly ScanPage[]): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const scan = new mupdf.PDFDocument();
  try {
    for (const [index, page] of pages.entries()) {
      const [width, height] = page.size ?? [PAGE_WIDTH, PAGE_HEIGHT];
      const typeset = new mupdf.PDFDocument();
      const font = typeset.addObject({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        Encoding: 'WinAnsiEncoding',
      });
      typeset.insertPage(0, typeset.addPage([0, 0, width, height], 0, { Font: { F1: font } }, page.content));
      let image: PDFObject;
      try {
        const scale = 150 / 72;
        const pixmap = typeset
          .loadPage(0)
          .toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, false);
        try {
          if (page.noise !== undefined) {
            const next = random(page.seed ?? index + 1);
            const pixels = pixmap.getPixels();
            for (let at = 0; at < pixels.length; at += 1) {
              pixels[at] = (pixels[at] as number) + (next() + next() + next() - 1.5) * 2 * page.noise;
            }
          }
          const picture = new mupdf.Image(pixmap);
          try {
            image = scan.addImage(picture);
          } finally {
            picture.destroy();
          }
        } finally {
          pixmap.destroy();
        }
      } finally {
        typeset.destroy();
      }
      const added = scan.addPage(
        [0, 0, width, height],
        page.rotate ?? 0,
        { XObject: { Im0: image } },
        `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`,
      );
      if (page.cropBox !== undefined) added.put('CropBox', [...page.cropBox]);
      if (page.annotated === true) {
        added.put('Annots', [
          scan.addObject({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 200, 160] }),
        ]);
      }
      if (page.emptyAnnots === true) added.put('Annots', []);
      scan.insertPage(-1, added);
    }
    const saved = scan.saveToBuffer('compress');
    const bytes = new Uint8Array(saved.asUint8Array());
    saved.destroy();
    return bytes;
  } finally {
    scan.destroy();
  }
}

/** A page as a viewer shows it (its `/Rotate` and `/CropBox` applied, annotations left out), at `dpi`, in greyscale. */
export async function renderPage(bytes: Uint8Array, pageIndex: number, dpi = 150): Promise<Grey> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const scale = dpi / 72;
    const pixmap = doc
      .loadPage(pageIndex)
      .toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, false);
    try {
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const stride = pixmap.getStride();
      const pixels = pixmap.getPixels();
      const data = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1)
        data.set(pixels.subarray(y * stride, y * stride + width), y * width);
      return { width, height, data };
    } finally {
      pixmap.destroy();
    }
  } finally {
    doc.destroy();
  }
}
