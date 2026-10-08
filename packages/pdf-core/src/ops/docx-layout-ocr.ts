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
import { provideStandardMetrics } from './docx-fonts';
import { chooseOpenFont, type OpenFonts, ocrAdvance } from './docx-ocr-font';
import { cappedPerPoint } from './docx-pages';
import type { PageScene, SceneImage, SceneItem, SceneShape, TextBox } from './layout-scene';
import { type ReadWord, refineWords } from './ocr-refine';
import {
  dropDuplicates,
  dropEdgeMarks,
  dropMisreads,
  eraseRules,
  findUnderlines,
  markWords,
  misreadWords,
  ocrBackground,
  ocrTextBoxes,
  type RgbaImage,
  type Rule,
} from './ocr-scene';
import type { Box, LayoutChar } from './page-layout';
import { throwIfAborted } from './types';

/** What the writer needs to read a scan: a recogniser and the confidence (0–1) below which a word is flagged. */
export interface OcrOptions {
  /** The words of a rendered page: its PNG, pixels per page point, an abort signal. Boxes in page points, y down. */
  readonly recognize: (png: Uint8Array, scale: number, signal: AbortSignal) => Promise<readonly OcrWord[]>;
  readonly lowConfidence: number;
  /** Reads the PNG of one cropped word again (see `ocr-refine.ts`); without it the first read stands. */
  readonly readWord?: ReadWord;
  /** Whether `readWord` with `'english'` reads with another set of languages than with `'all'` (not when English is the only one, or not among them); default no. */
  readonly englishAlone?: boolean;
  /** How many scanned pages the writer reads at a time, the recogniser being able to read as many side by side; default 1. */
  readonly concurrency?: number;
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
  // The scene reads the page's text without pictures, so its blocks are text.
  for (const block of scene.text.blocks)
    for (const line of block.kind === 'text' ? block.lines : []) if (line.chars.some(isVisible)) return false;
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
  // The scene reads the page's text without pictures, so its blocks are text.
  for (const textBlock of scene.text.blocks.flatMap((entry) => (entry.kind === 'text' ? [entry] : []))) {
    block += 1;
    for (const textLine of textBlock.lines) {
      line += 1;
      let chars: LayoutChar[] = [];
      const flush = (): void => {
        const first = chars[0] as LayoutChar;
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
      for (const char of textLine.chars.filter((c) => c.invisible === true)) {
        if (char.c.trim() !== '') chars.push(char);
        else if (chars.length > 0) flush();
      }
      if (chars.length > 0) flush();
    }
  }
  return words;
}

/** The resolution the scan is read at: its largest picture's own, within 150–300 dpi. */
function scanDpi(scene: PageScene): number {
  let best: SceneImage | null = null;
  for (const item of scene.items.filter((entry): entry is SceneImage => entry.kind === 'image')) {
    const area = (item.box[2] - item.box[0]) * (item.box[3] - item.box[1]);
    if (best === null || area > (best.box[2] - best.box[0]) * (best.box[3] - best.box[1])) best = item;
  }
  const dpi = best?.nativeScale === undefined ? DEFAULT_DPI : best.nativeScale * 72;
  return Math.min(MAX_DPI, Math.max(MIN_DPI, dpi));
}

/** The page drawn as it shows, opaque, as RGBA pixels and as a PNG. */
function renderScan(mupdf: Mupdf, page: Page, dpi: number): { image: RgbaImage; png: Uint8Array } {
  const [x0, y0, x1, y1] = page.getBounds();
  // Within the pixel budget of the page images, however large the page: a poster at 300 dpi
  // would be over a hundred megapixels, twice (pixels and PNG). Everything after this reads `image.scale`.
  const scale = Math.min(dpi / 72, cappedPerPoint(x1 - x0, y1 - y0));
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
 * `ocr.recognize` (`null`: there is none or it failed, and the page has no layer — the caller
 * keeps the page as it was). The page's vector shapes stay above the pictures.
 */
export async function readScanPage(
  mupdf: Mupdf,
  page: Page,
  scene: PageScene,
  ocr: OcrOptions | null,
  signal: AbortSignal,
  fonts: OpenFonts,
): Promise<ScanPage | null> {
  const layer = layerWords(scene);
  if (layer.length === 0 && ocr === null) return null;
  const scan = renderScan(mupdf, page, scanDpi(scene));
  let image = scan.image;
  let png = scan.png;
  let words: readonly OcrWord[] = layer;
  // Words read twice are dropped from the text, but their ink is erased all the same.
  let duplicates: readonly OcrWord[] = [];
  let rules: readonly Rule[] = [];
  if (layer.length === 0 && ocr !== null) {
    throwIfAborted(signal);
    const recognise = async (): Promise<readonly OcrWord[] | null> => {
      try {
        return await ocr.recognize(png, image.scale, signal);
      } catch (error) {
        // A recogniser that cannot run (language pack missing, offline, worker crashed) leaves
        // the page as the picture it is; only the reader's own cancel stops the export.
        throwIfAborted(signal);
        if (error instanceof Error && error.name === 'AbortError') throw error;
        return null;
      }
    };
    let read = await recognise();
    if (read === null) return null;
    // Rules under words (links) make tesseract misread them: the page is read again without them.
    rules = findUnderlines(image, read);
    if (rules.length > 0) {
      image = eraseRules(image, rules);
      png = pngOf(mupdf, image);
      read = (await recognise()) ?? read;
    }
    if (ocr.readWord !== undefined) {
      try {
        read = await refineWords(read, image, (crop) => pngOf(mupdf, crop), ocr.readWord, signal, {
          englishAlone: ocr.englishAlone === true,
        });
      } catch (error) {
        // The second look is a bonus: when it cannot run (a worker that crashed, no memory for another
        // one) the first read stands; only the reader's own cancel stops the export.
        throwIfAborted(signal);
        if (error instanceof Error && error.name === 'AbortError') throw error;
      }
    }
    const unique = dropDuplicates(read);
    const marks = markWords(unique);
    duplicates = [...read.filter((word) => !unique.includes(word)), ...marks];
    words = dropEdgeMarks(
      unique.filter((word) => !marks.has(word)),
      image.width / image.scale,
    );
    throwIfAborted(signal);
  }
  // Regions are found with the guesses at graphics left in; the guesses that lie over one are
  // dropped, and the page is erased again only if one lies outside.
  provideStandardMetrics(mupdf);
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
  const solid = regions.filter((region) => region.solid).map((region) => region.box);
  const lowConfidence = ocr?.lowConfidence ?? 0;
  // Set in the stand-in that fits the word boxes best; the words as set tell whether the scan is
  // in one of the open families, and then the page is set again in that family's own advances.
  let set = ocrTextBoxes(kept, image, lowConfidence, solid, ocrAdvance(null), undefined, rules);
  const open = await chooseOpenFont(mupdf, image, set.measured, fonts);
  if (open !== null) {
    set = ocrTextBoxes(kept, image, lowConfidence, solid, ocrAdvance(open), open.name, rules);
  }
  const { boxes, flagged } = set;
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
