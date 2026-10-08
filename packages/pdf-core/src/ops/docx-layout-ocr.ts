/**
 * A scanned page in the "exact layout" Word writer (`docx-layout.ts`): a page that shows
 * pictures and no visible text is rebuilt from what OCR reads off it.
 *
 *  - The page is rendered by MuPDF at the scan's own resolution (150–300 dpi) and the words come
 *    from the `recognize` the caller supplied — or, when the PDF already carries an invisible
 *    text layer (this app's own OCR leaves one), from that layer, and the page is not rendered
 *    for OCR at all.
 *  - `ocrTextBoxes` makes the words positioned text boxes; `ocrBackground` makes the page colour
 *    a page-sized shape and everything else a picture in place. The page's own pictures are
 *    replaced by those; its vector shapes stay above them.
 *  - A word below the confidence threshold is a run with a `note`, which the writer sets as a
 *    Word comment, and is reported (`flagged`).
 */

import type { Page } from 'mupdf';
import type { Mupdf } from '../engines/mupdf';
import type { OcrWord } from '../engines/tesseract';
import { provideStandardMetrics, standardAdvance } from './docx-fonts';
import type { PageScene, SceneImage, SceneItem, SceneShape, TextBox } from './layout-scene';
import {
  dropDuplicates,
  dropEdgeMarks,
  dropMisreads,
  misreadWords,
  ocrBackground,
  ocrTextBoxes,
  type RgbaImage,
} from './ocr-scene';
import type { Box, LayoutChar } from './page-layout';
import { throwIfAborted } from './types';

/** What the writer needs to read a scan: a recogniser and the confidence (0–1) below which a word is flagged. */
export interface OcrOptions {
  /** The words of a rendered page: its PNG, pixels per page point, an abort signal. Boxes in page points, y down. */
  readonly recognize: (png: Uint8Array, scale: number, signal: AbortSignal) => Promise<readonly OcrWord[]>;
  readonly lowConfidence: number;
}

/** The pictures cover at least this much of the page for it to be a scan. */
const SCAN_COVER = 0.5;
/** A scan is read at its own resolution within these bounds, dpi. */
const MIN_DPI = 150;
const MAX_DPI = 300;
const DEFAULT_DPI = 200;
/** Words from a text layer are as sure as the layer's author. */
const LAYER_CONFIDENCE = 100;

/** A word OCR was unsure of. */
export interface FlaggedWord {
  /** 1-based page number. */
  readonly page: number;
  readonly text: string;
  /** 0–1. */
  readonly confidence: number;
}

export interface ScanPage {
  readonly items: readonly SceneItem[];
  readonly boxes: readonly TextBox[];
  readonly flagged: readonly Omit<FlaggedWord, 'page'>[];
  /** Pictures added (regions), for the totals. */
  readonly regions: number;
}

const isVisible = (char: { readonly c: string; readonly invisible?: true }): boolean =>
  char.invisible !== true && char.c.trim() !== '';

/** Whether the page shows no text and is mostly pictures: a scan, with or without an invisible text layer. */
export function isScanPage(scene: PageScene): boolean {
  for (const block of scene.text.blocks) {
    if (block.kind !== 'text') continue;
    for (const line of block.lines) if (line.chars.some(isVisible)) return false;
  }
  let covered = 0;
  for (const item of scene.items) {
    if (item.kind === 'shape') continue;
    covered += Math.max(0, item.box[2] - item.box[0]) * Math.max(0, item.box[3] - item.box[1]);
  }
  return covered >= SCAN_COVER * scene.width * scene.height;
}

/** The words of the page's invisible text layer, as OCR words (boxes from the baseline and size the layer was written with). */
export function layerWords(scene: PageScene): OcrWord[] {
  const words: OcrWord[] = [];
  let block = 0;
  let line = 0;
  for (const textBlock of scene.text.blocks) {
    if (textBlock.kind !== 'text') continue;
    block += 1;
    for (const textLine of textBlock.lines) {
      line += 1;
      let chars: LayoutChar[] = [];
      const flush = (): void => {
        const first = chars[0];
        if (first === undefined) return;
        const x0 = Math.min(...chars.map((char) => char.box[0]));
        const x1 = Math.max(...chars.map((char) => char.box[2]));
        const size = Math.max(...chars.map((char) => char.size));
        const baseline = first.baseline;
        words.push({
          text: chars.map((char) => char.c).join(''),
          x0,
          y0: baseline - size,
          x1,
          y1: baseline,
          confidence: LAYER_CONFIDENCE,
          size,
          block,
          paragraph: block,
          line,
          baseline: { x0, y0: baseline, x1, y1: baseline },
        });
        chars = [];
      };
      for (const char of textLine.chars) {
        if (char.invisible !== true) continue;
        if (char.c.trim() === '') flush();
        else chars.push(char);
      }
      flush();
    }
  }
  return words;
}

/** Whether the page has an invisible text layer worth reading. */
export const hasLayer = (scene: PageScene): boolean => layerWords(scene).length > 0;

/** The resolution the scan is read at: its largest picture's own, within 150–300 dpi. */
function scanDpi(scene: PageScene): number {
  let best: SceneImage | null = null;
  for (const item of scene.items) {
    if (item.kind !== 'image') continue;
    const area = (item.box[2] - item.box[0]) * (item.box[3] - item.box[1]);
    if (best === null || area > (best.box[2] - best.box[0]) * (best.box[3] - best.box[1])) best = item;
  }
  const dpi = best?.nativeScale === undefined ? DEFAULT_DPI : best.nativeScale * 72;
  return Math.min(MAX_DPI, Math.max(MIN_DPI, dpi));
}

/** The page drawn as it shows, opaque, as RGBA pixels and as a PNG. */
function renderScan(mupdf: Mupdf, page: Page, dpi: number): { image: RgbaImage; png: Uint8Array } {
  const [x0, y0, x1, y1] = page.getBounds();
  const scale = dpi / 72;
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, false);
  try {
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const channels = pixmap.getNumberOfComponents();
    const stride = pixmap.getStride();
    const from = pixmap.getPixels();
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const source = y * stride + x * channels;
        const target = (y * width + x) * 4;
        data[target] = from[source] as number;
        data[target + 1] = from[source + (channels > 1 ? 1 : 0)] as number;
        data[target + 2] = from[source + (channels > 2 ? 2 : 0)] as number;
        data[target + 3] = 255;
      }
    }
    // Pixels per point: from the page's size, as the writer maps the words back.
    return {
      image: {
        width,
        height,
        data,
        scale: (width / Math.max(1e-6, x1 - x0) + height / Math.max(1e-6, y1 - y0)) / 2,
      },
      png: pixmap.asPNG().slice(),
    };
  } finally {
    pixmap.destroy();
  }
}

/** A picture of RGBA pixels, as a PNG. */
function pngOf(mupdf: Mupdf, rgba: RgbaImage): Uint8Array {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, rgba.width, rgba.height], true);
  try {
    const to = pixmap.getPixels();
    const stride = pixmap.getStride();
    for (let y = 0; y < rgba.height; y += 1) {
      to.set(rgba.data.subarray(y * rgba.width * 4, (y + 1) * rgba.width * 4), y * stride);
    }
    return pixmap.asPNG().slice();
  } finally {
    pixmap.destroy();
  }
}

const rectangle = (box: Box): SceneShape['segments'] => [
  { kind: 'move', to: [box[0], box[1]] },
  { kind: 'line', to: [box[2], box[1]] },
  { kind: 'line', to: [box[2], box[3]] },
  { kind: 'line', to: [box[0], box[3]] },
  { kind: 'close' },
];

/**
 * The scan page rebuilt: words from the invisible layer if there is one, else from
 * `ocr.recognize` (`null`: there is none, and the page has no layer — the caller keeps the page
 * as it was). The page's vector shapes stay above the pictures.
 */
export async function readScanPage(
  mupdf: Mupdf,
  page: Page,
  scene: PageScene,
  ocr: OcrOptions | null,
  signal: AbortSignal,
): Promise<ScanPage | null> {
  const layer = layerWords(scene);
  if (layer.length === 0 && ocr === null) return null;
  const { image, png } = renderScan(mupdf, page, scanDpi(scene));
  let words: readonly OcrWord[] = layer;
  // Words read twice are dropped from the text, but their ink is erased all the same.
  let duplicates: readonly OcrWord[] = [];
  if (layer.length === 0 && ocr !== null) {
    throwIfAborted(signal);
    const read = await ocr.recognize(png, image.scale, signal);
    const unique = dropDuplicates(read);
    duplicates = read.filter((word) => !unique.includes(word));
    words = dropEdgeMarks(unique, image.width / image.scale);
    throwIfAborted(signal);
  }
  // Regions are found with the guesses at graphics left in; the guesses that lie over one are
  // dropped, and the page is erased again only if one lies outside.
  provideStandardMetrics(mupdf);
  const advance = (family: string, bold: boolean, unicode: number) =>
    standardAdvance(family, bold, false, unicode);
  const misread = misreadWords(words);
  const text = words.filter((word) => !misread.has(word));
  const first = ocrBackground(image, [...text, ...duplicates]);
  const kept = dropMisreads(
    words,
    first.regions.map((region) => region.box),
    misread,
  );
  const { pageColor, regions } =
    kept.length === text.length ? first : ocrBackground(image, [...kept, ...duplicates]);
  const { boxes, flagged } = ocrTextBoxes(
    kept,
    image,
    ocr?.lowConfidence ?? 0,
    regions.filter((region) => region.solid).map((region) => region.box),
    advance,
  );
  const background: SceneShape = {
    kind: 'shape',
    box: [0, 0, scene.width, scene.height],
    segments: rectangle([0, 0, scene.width, scene.height]),
    fill: { color: pageColor, alpha: 1, evenOdd: false },
    stroke: null,
  };
  const pictures = regions.map(
    (region): SceneImage => ({
      kind: 'image',
      box: region.box,
      data: pngOf(mupdf, region.rgba),
      mime: 'image/png',
    }),
  );
  return {
    items: [background, ...pictures, ...scene.items.filter((item) => item.kind === 'shape')],
    boxes,
    flagged,
    regions: pictures.length,
  };
}
