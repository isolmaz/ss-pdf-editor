/**
 * Verification helpers for spike #3 (throwaway, `PLAN.md §9/K21`).
 *
 * Every check is measured on **saved bytes that were re-opened**, never on the
 * in-memory document that did the edit: MuPDF is the editing engine, so it cannot
 * be its own witness — pdf.js reads the same file independently, and the rendered
 * pixmaps catch what text extraction cannot see (glyphs, rules, images).
 */
import type { Mupdf, PdfDoc, PdfFont, PdfPixmap } from './engine';
import { openPdf, openWithPdfjs } from './engine';
import type { Rect4 } from './textmodel';
import { normalizeText, readBlocks } from './textmodel';

export interface PageModel {
  /** normalised text of each line, in reading order */
  readonly lines: readonly string[];
  /** whole page text, whitespace-collapsed */
  readonly text: string;
  readonly lineCount: number;
  readonly charCount: number;
}

/** MuPDF's own view of the saved file: per-page lines + whole-page text. */
export function muPdfModel(mupdf: Mupdf, bytes: Uint8Array): PageModel[] {
  const doc = openPdf(mupdf, bytes);
  const pages: PageModel[] = [];
  for (let index = 0; index < doc.countPages(); index += 1) {
    const page = doc.loadPage(index);
    const blocks = readBlocks(page);
    const lines = blocks.flatMap((block) =>
      block.lines.map((line) => normalizeText(line.chars.map((c) => c.c).join(''))),
    );
    pages.push({
      lines,
      text: normalizeText(lines.join(' ')),
      lineCount: lines.length,
      charCount: lines.reduce((total, line) => total + line.length, 0),
    });
  }
  doc.destroy();
  return pages;
}

export interface PdfJsModel {
  readonly pageCount: number;
  readonly pages: readonly string[];
  readonly fingerprint: string | null;
}

/** The independent reader: pdf.js through `pdf-core`'s adapter. */
export async function pdfJsModel(bytes: Uint8Array): Promise<PdfJsModel> {
  const handle = await openWithPdfjs(bytes);
  try {
    const pages: string[] = [];
    for (let index = 0; index < handle.pageCount; index += 1) {
      pages.push(await handle.getPageText(index));
    }
    return { pageCount: handle.pageCount, pages, fingerprint: handle.fingerprint };
  } finally {
    await handle.destroy();
  }
}

export interface DiffStat {
  readonly region: Rect4;
  readonly totalPixels: number;
  readonly changedPixels: number;
  readonly ratio: number;
  readonly maxChannelDelta: number;
}

/**
 * Compare the same region of two renders of the same page size. The threshold
 * ignores antialiasing noise from re-encoded content streams (16/255 ≈ 6 %).
 */
export function diffRegion(
  first: PdfPixmap,
  second: PdfPixmap,
  region: Rect4,
  scale: number,
  threshold = 16,
): DiffStat {
  const raw = first.getBounds();
  const bounds: Rect4 = [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0];
  const x0 = Math.max(Math.round(region[0] * scale), Math.ceil(bounds[0]));
  const y0 = Math.max(Math.round(region[1] * scale), Math.ceil(bounds[1]));
  const x1 = Math.min(Math.round(region[2] * scale), Math.floor(bounds[2]));
  const y1 = Math.min(Math.round(region[3] * scale), Math.floor(bounds[3]));
  const pixelsA = first.getPixels();
  const pixelsB = second.getPixels();
  const strideA = first.getStride();
  const strideB = second.getStride();
  const components = Math.min(first.getNumberOfComponents(), second.getNumberOfComponents());
  const originX = Math.ceil(bounds[0]);
  const originY = Math.ceil(bounds[1]);
  let totalPixels = 0;
  let changedPixels = 0;
  let maxChannelDelta = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const ia = (y - originY) * strideA + (x - originX) * components;
      const ib = (y - originY) * strideB + (x - originX) * components;
      let delta = 0;
      for (let channel = 0; channel < components; channel += 1) {
        delta = Math.max(delta, Math.abs((pixelsA[ia + channel] ?? 0) - (pixelsB[ib + channel] ?? 0)));
      }
      totalPixels += 1;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
      if (delta > threshold) changedPixels += 1;
    }
  }
  return {
    region,
    totalPixels,
    changedPixels,
    ratio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    maxChannelDelta,
  };
}

export interface RenderResult {
  readonly pixmap: PdfPixmap;
  readonly pngBase64: string | null;
}

export function renderPage(
  mupdf: Mupdf,
  doc: PdfDoc,
  pageIndex: number,
  scale: number,
  withPng: boolean,
): RenderResult {
  const page = doc.loadPage(pageIndex);
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
  const png = withPng ? pixmap.asPNG() : null;
  let base64: string | null = null;
  if (png) {
    let binary = '';
    for (const byte of png) binary += String.fromCharCode(byte);
    base64 = btoa(binary);
  }
  return { pixmap, pngBase64: base64 };
}

export interface ImageInfo {
  readonly resource: string;
  readonly objectNumber: number;
  readonly width: number;
  readonly height: number;
  readonly streamBytes: number;
  /** FNV-1a over the decoded pixels — the image survived iff this is unchanged */
  readonly pixelHash: string;
}

/** Images reachable from a page's resources, decoded (the object-level check for case d). */
export function imageObjects(doc: PdfDoc, pageIndex: number): ImageInfo[] {
  const page = doc.loadPage(pageIndex);
  const xobjects = page.getObject().getInheritable('Resources').get('XObject');
  const result: ImageInfo[] = [];
  xobjects.forEach((value, key) => {
    if (typeof key !== 'string') return;
    if (value.get('Subtype').asName() !== 'Image') return;
    const image = doc.loadImage(value);
    const pixmap = image.toPixmap();
    const pixels = pixmap.getPixels();
    let hash = 0x811c9dc5;
    for (const byte of pixels) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const length = value.get('Length');
    result.push({
      resource: key,
      objectNumber: value.asIndirect(),
      width: image.getWidth(),
      height: image.getHeight(),
      streamBytes: length.isNull() ? 0 : length.asNumber(),
      pixelHash: hash.toString(16).padStart(8, '0'),
    });
    pixmap.destroy();
    image.destroy();
  });
  return result;
}

/** Font resource names used by a page — the subset-growth measurement. */
export function pageFontResources(doc: PdfDoc, pageIndex: number): string[] {
  const page = doc.loadPage(pageIndex);
  const fonts = page.getObject().getInheritable('Resources').get('Font');
  const names: string[] = [];
  fonts.forEach((_value, key) => {
    if (typeof key === 'string') names.push(key);
  });
  return names;
}

/**
 * The font objects actually used by a page's text. MuPDF.js offers no
 * "load font from resources" call, so this is the only way to reach the font that
 * an edited page carries — needed for glyph coverage of a reopened subset.
 */
export function pageFontsFromText(doc: PdfDoc, pageIndex: number): { name: string; font: PdfFont }[] {
  const page = doc.loadPage(pageIndex);
  const stext = page.toStructuredText('preserve-whitespace');
  const found: Record<string, PdfFont> = {};
  stext.walk({
    onChar(_c, _origin, font, _size, _quad, _color, _bidi) {
      const name = font.getName();
      if (found[name] === undefined) found[name] = font;
    },
  });
  stext.destroy();
  return Object.entries(found).map(([name, font]) => ({ name, font }));
}

/** Objects/xref growth per save round. */
export function documentStats(doc: PdfDoc): { objects: number; versions: number; incremental: boolean } {
  return {
    objects: doc.countObjects(),
    versions: doc.countVersions(),
    incremental: doc.canBeSavedIncrementally(),
  };
}
