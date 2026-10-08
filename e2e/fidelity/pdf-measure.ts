/**
 * MuPDF in Node, for the harness only: render pages to 8-bit grayscale and read a page's
 * words. The package is declared by `pdf-core`, so it is resolved from there.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { type Gray, joinHyphenation } from './compare';

interface MupdfPixmap {
  getWidth(): number;
  getHeight(): number;
  getStride(): number;
  getNumberOfComponents(): number;
  getPixels(): Uint8ClampedArray;
  destroy(): void;
}
interface MupdfPage {
  getBounds(): number[];
  toPixmap(matrix: number[], colorspace: unknown, alpha: boolean): MupdfPixmap;
  toStructuredText(options: string): { asText(): string; destroy(): void };
  destroy(): void;
}
interface MupdfDocument {
  countPages(): number;
  loadPage(index: number): MupdfPage;
  destroy(): void;
}
interface Mupdf {
  Document: { openDocument(bytes: Uint8Array, magic: string): MupdfDocument };
  Matrix: { scale(sx: number, sy: number): number[] };
  ColorSpace: { DeviceGray: unknown };
}

/** Pixels per PDF point at 100 dpi. */
const SCALE = 100 / 72;

let mupdf: Promise<Mupdf> | undefined;

function load(): Promise<Mupdf> {
  mupdf ??= (async () => {
    // A static `import 'mupdf'` cannot resolve from the repository root (pnpm isolation keeps
    // the package inside `pdf-core`), so the installed file is located at runtime.
    const core = createRequire(new URL('../../packages/pdf-core/package.json', import.meta.url));
    return (await import(pathToFileURL(core.resolve('mupdf')).href)) as Mupdf;
  })();
  return mupdf;
}

export interface MeasuredPage {
  /** Page size in PDF points. */
  size: [number, number];
  gray: Gray;
  text: string;
}

/** Render every page at 100 dpi (grayscale, no alpha) and extract its text. */
export async function measurePdf(bytes: Uint8Array): Promise<MeasuredPage[]> {
  const { Document, Matrix, ColorSpace } = await load();
  const doc = Document.openDocument(bytes, 'application/pdf');
  try {
    const pages: MeasuredPage[] = [];
    for (let index = 0; index < doc.countPages(); index++) {
      const page = doc.loadPage(index);
      try {
        const [x0, y0, x1, y1] = page.getBounds() as [number, number, number, number];
        const pixmap = page.toPixmap(Matrix.scale(SCALE, SCALE), ColorSpace.DeviceGray, false);
        try {
          const width = pixmap.getWidth();
          const height = pixmap.getHeight();
          const stride = pixmap.getStride();
          const n = pixmap.getNumberOfComponents();
          const pixels = pixmap.getPixels();
          const data = new Uint8Array(width * height);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) data[y * width + x] = pixels[y * stride + x * n] as number;
          }
          const text = page.toStructuredText('preserve-whitespace');
          try {
            pages.push({
              size: [x1 - x0, y1 - y0],
              gray: { width, height, data },
              text: joinHyphenation(text.asText()),
            });
          } finally {
            text.destroy();
          }
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return pages;
  } finally {
    doc.destroy();
  }
}
