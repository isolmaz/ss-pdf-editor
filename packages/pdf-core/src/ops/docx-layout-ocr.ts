/**
 * A scanned page in the "exact layout" Word writer (`docx-layout.ts`): a page that shows
 * pictures and no visible text is rebuilt from what OCR reads off it.
 *
 *  - The page is rendered by MuPDF at the scan's own resolution (150–300 dpi) and the words come
 *    from the `recognize` the caller supplied — or, when the PDF already carries an invisible
 *    text layer (this app's own OCR leaves one), from that layer, and the page is not rendered
 *    for OCR at all.
 *    A layer that fails `layerTrusted` (replacement characters, turned lines) is not reused: the
 *    page is read with OCR.
 *  - A mixed page (real text over a scan, `docx-layout-mixed.ts`) is read the same way with the
 *    real text masked out of the render; the writer keeps that text as it is.
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
import {
  dropCovered,
  dropMasked,
  inkBoxes,
  layerTrusted,
  maskBoxes,
  pictureBoxes,
  pictureLooksLikeText,
  textPictures,
  wordsInPicture,
} from './docx-layout-mixed';
import { chooseOpenFont, type OpenFont, type OpenFonts, ocrAdvance, settleReadings } from './docx-ocr-font';
import { cappedPerPoint } from './docx-pages';
import type { PageScene, SceneImage, SceneItem, SceneShape, TextBox } from './layout-scene';
import { readPageScene } from './layout-scene-read';
import { turnBoxes, uprightScan } from './ocr-preprocess';
import { type ReadWord, refineWords } from './ocr-refine';
import {
  dropDuplicates,
  dropEdgeMarks,
  dropMisreads,
  eraseRules,
  eraseRulesTurned,
  eraseWords,
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

/** A scan is read at its own resolution within these bounds, dpi. */
/** The quality an erased JPEG picture is written at. */
const PICTURE_JPEG_QUALITY = 90;
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
  /** The page also shows real text, kept as it is by the caller (`visible` of `readScanPage`). */
  readonly mixed: boolean;
  /** The page's invisible text layer was not trusted (`layerTrusted`) and the page was read with OCR instead. */
  readonly layerRejected: boolean;
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

/** The page drawn as the reader sees it, annotations included (a black box over a word hides it from OCR too), opaque, as RGBA pixels and as a PNG. */
function renderScan(
  mupdf: Mupdf,
  page: Page,
  dpi: number,
  withPng = true,
): { image: RgbaImage; png: Uint8Array } {
  const [x0, y0, x1, y1] = page.getBounds();
  // Within the pixel budget of the page images, however large the page: a poster at 300 dpi
  // would be over a hundred megapixels, twice (pixels and PNG). Everything after this reads `image.scale`.
  const scale = Math.min(dpi / 72, cappedPerPoint(x1 - x0, y1 - y0));
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
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
      png: withPng ? pixmap.asPNG().slice() : new Uint8Array(),
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

/** What the recogniser found on a page: the words to set, the ones read twice (still erased), the rules under words, and the picture as read. */
interface OcrRead {
  readonly words: readonly OcrWord[];
  readonly duplicates: readonly OcrWord[];
  readonly rules: readonly Rule[];
  /** The upright copy as read (rules erased) and, for a crooked scan, the scan with them erased too. */
  readonly image: RgbaImage;
  readonly picture: RgbaImage;
}

/** The words `ocr` reads off the rendered page, `null` when it cannot run (the caller keeps the page as it was). */
async function readWords(
  mupdf: Mupdf,
  firstImage: RgbaImage,
  firstPng: Uint8Array,
  ocr: OcrOptions,
  signal: AbortSignal,
  turn: { readonly picture: RgbaImage; readonly angle: number } | null = null,
): Promise<OcrRead | null> {
  let image = firstImage;
  let picture = turn?.picture ?? firstImage;
  let png = firstPng;
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
  const rules = findUnderlines(image, read);
  if (rules.length > 0) {
    if (turn !== null) picture = eraseRulesTurned(image, rules, picture, turn.angle);
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
  const words = dropEdgeMarks(
    unique.filter((word) => !marks.has(word)),
    image.width / image.scale,
  );
  throwIfAborted(signal);
  // Words read twice are dropped from the text, but their ink is erased all the same.
  return {
    words,
    duplicates: [...read.filter((word) => !unique.includes(word)), ...marks],
    rules,
    image,
    picture,
  };
}

/**
 * The words as positioned text boxes (in the frame of `image`), set in the stand-in that fits their
 * boxes best, or in the open family they appear to be set in (`chooseOpenFont`); a word the second
 * look read two ways is drawn in the page's face once per reading, and the ink that lies on the scan
 * best is the word (`settleReadings`), with the page set again with those.
 */
async function setWords(
  mupdf: Mupdf,
  image: RgbaImage,
  words: readonly OcrWord[],
  lowConfidence: number,
  solid: readonly Box[],
  rules: readonly Rule[],
  fonts: OpenFonts,
): Promise<{ boxes: TextBox[]; flagged: ReturnType<typeof ocrTextBoxes>['flagged'] }> {
  const setIn = (read: readonly OcrWord[], open: OpenFont | null) =>
    ocrTextBoxes(read, image, lowConfidence, solid, ocrAdvance(open), open?.name, rules);
  let set = setIn(words, null);
  const open = await chooseOpenFont(mupdf, image, set.measured, fonts);
  if (open !== null) set = setIn(words, open);
  const settled = settleReadings(mupdf, image, set.unsettled, set.family, open);
  if (settled.size > 0)
    set = setIn(
      words.map((word) => ({ ...word, ...settled.get(word) })),
      open,
    );
  return { boxes: set.boxes, flagged: set.flagged };
}

/** Whether any pixel of the picture is see-through. */
const hasAlpha = (rgba: RgbaImage): boolean => {
  for (let at = 3; at < rgba.data.length; at += 4) if ((rgba.data[at] as number) < 255) return true;
  return false;
};

/** A picture's own pixels as RGBA, on the scale of its box (pixels per page point). */
function decodePicture(mupdf: Mupdf, data: Uint8Array, box: Box): RgbaImage {
  const picture = new mupdf.Image(data);
  const pixmap = picture.toPixmap();
  try {
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const channels = pixmap.getNumberOfComponents();
    const stride = pixmap.getStride();
    const from = pixmap.getPixels();
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const source = y * stride + x * channels;
        const target = (y * width + x) * 4;
        out[target] = from[source] as number;
        out[target + 1] = from[source + (channels > 2 ? 1 : 0)] as number;
        out[target + 2] = from[source + (channels > 2 ? 2 : 0)] as number;
        out[target + 3] = pixmap.getAlpha() && channels >= 2 ? (from[source + channels - 1] as number) : 255;
      }
    }
    return { width, height, data: out, scale: width / Math.max(1e-6, box[2] - box[0]) };
  } finally {
    pixmap.destroy();
    picture.destroy();
  }
}

/** The picture without alpha as PNG, or as JPEG when it came as one (a scanned screenshot stays small). */
function opaquePicture(
  mupdf: Mupdf,
  rgba: RgbaImage,
  mime: SceneImage['mime'],
): Pick<SceneImage, 'data' | 'mime'> {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, rgba.width, rgba.height], false);
  try {
    const to = pixmap.getPixels();
    const stride = pixmap.getStride();
    for (let y = 0; y < rgba.height; y += 1) {
      for (let x = 0; x < rgba.width; x += 1) {
        const source = (y * rgba.width + x) * 4;
        const target = y * stride + x * 3;
        to[target] = rgba.data[source] as number;
        to[target + 1] = rgba.data[source + 1] as number;
        to[target + 2] = rgba.data[source + 2] as number;
      }
    }
    return mime === 'image/jpeg'
      ? { data: pixmap.asJPEG(PICTURE_JPEG_QUALITY, false).slice(), mime }
      : { data: pixmap.asPNG().slice(), mime };
  } finally {
    pixmap.destroy();
  }
}

/**
 * The text inside the pictures of a page that is not a scan (a screenshot, a sign, a table
 * saved as an image). Pictures are first judged on their own pixels (`pictureLooksLikeText`:
 * a logo or a photograph is dropped before anything is rendered); then the page is rendered
 * with its visible text masked, OCR reads what is left, and the words of a picture that holds
 * enough surely read lines over most of its ink become text boxes over the picture, which is
 * set again without them (a picture with see-through pixels is left as it is, its glyphs
 * behind the text). Each word belongs to the topmost picture it lies in. The rest of the page is
 * as it was (`null`: no picture has words, or OCR cannot run, and the caller keeps the page).
 */
export async function readPictureText(
  mupdf: Mupdf,
  page: Page,
  scene: PageScene,
  ocr: OcrOptions,
  signal: AbortSignal,
  fonts: OpenFonts,
  visible: readonly Box[],
): Promise<ScanPage | null> {
  const decoded = new Map<SceneImage, RgbaImage>();
  // Topmost first: the scene lists the drawing bottom first.
  const candidates = textPictures(scene)
    .reverse()
    .filter((picture) => {
      const own = decodePicture(mupdf, picture.data, picture.box);
      decoded.set(picture, own);
      return pictureLooksLikeText(own);
    });
  if (candidates.length === 0) return null;
  const scan = renderScan(mupdf, page, scanDpi(scene), false);
  const masked = maskBoxes(scan.image, visible);
  throwIfAborted(signal);
  const read = await readWords(mupdf, masked, pngOf(mupdf, masked), ocr, signal);
  if (read === null) return null;
  provideStandardMetrics(mupdf);
  const outside = dropMasked(read.words, visible, read.image.scale);
  const misread = misreadWords(outside);
  const taken = new Set<OcrWord>();
  const found = new Map<SceneImage, OcrWord[]>();
  for (const picture of candidates) {
    const free = outside.filter((word) => !misread.has(word) && !taken.has(word));
    const inside = wordsInPicture(read.image, free, picture.box);
    for (const word of inside) taken.add(word);
    if (inside.length > 0) found.set(picture, inside);
  }
  if (found.size === 0) return null;
  const items = scene.items.map((item): SceneItem => {
    const words = item.kind === 'image' ? found.get(item) : undefined;
    const own = item.kind === 'image' ? decoded.get(item) : undefined;
    if (item.kind !== 'image' || words === undefined || own === undefined) return item;
    // Words cannot be taken out of see-through pixels: the picture stays, its words above it.
    if (hasAlpha(own)) return item;
    // The picture's own pixels, without the words (in its box's frame).
    const erased = eraseWords(
      own,
      words.map((word) => ({
        ...word,
        x0: word.x0 - item.box[0],
        x1: word.x1 - item.box[0],
        y0: word.y0 - item.box[1],
        y1: word.y1 - item.box[1],
      })),
    );
    return { ...item, ...opaquePicture(mupdf, erased, item.mime) };
  });
  const all = [...found.values()].flat();
  const { boxes, flagged } = await setWords(mupdf, read.image, all, ocr.lowConfidence, [], read.rules, fonts);
  return { items, boxes, flagged, regions: 0, mixed: true, layerRejected: false };
}

/**
 * The page's own vector shapes, to stay above the pictures. The render holds the annotations
 * and form fields (it is drawn as the reader sees it), so on a page that has some the shapes
 * are read again without them: a translucent annotation is drawn once, in the picture.
 */
function shapesOnPage(mupdf: Mupdf, page: Page, scene: PageScene): SceneShape[] {
  const shapes = (items: readonly SceneItem[]): SceneShape[] =>
    items.filter((item): item is SceneShape => item.kind === 'shape');
  if (!(page instanceof mupdf.PDFPage) || page.getAnnotations().length + page.getWidgets().length === 0) {
    return shapes(scene.items);
  }
  try {
    return shapes(readPageScene(mupdf, page, true).items);
  } catch {
    return shapes(scene.items);
  }
}

/**
 * The scan page rebuilt: words from the invisible layer if there is one it can trust, else from
 * `ocr.recognize` (`null`: there is none or it failed, and the page has no layer — the caller
 * keeps the page as it was). The page's vector shapes stay above the pictures.
 *
 * `visible` (a mixed page, `docx-layout-mixed.ts`) are the boxes of text the page really shows:
 * they are painted over with their surroundings before OCR reads the render and before the
 * background is made, the words found on them are dropped, and the page is left as it was
 * (`null`) when what is left holds no scanned text.
 */
export async function readScanPage(
  mupdf: Mupdf,
  page: Page,
  scene: PageScene,
  ocr: OcrOptions | null,
  signal: AbortSignal,
  fonts: OpenFonts,
  visible: readonly Box[] = [],
): Promise<ScanPage | null> {
  const mixed = visible.length > 0;
  const layer = layerWords(scene);
  if (layer.length === 0 && ocr === null) return null;
  // A layer of replacement characters or turned lines says less than the picture: OCR reads it again when it can.
  const trusted = ocr === null || layerTrusted(scene);
  const useLayer = layer.length > 0 && trusted;
  // The PNG goes to the recogniser only for a whole scan read by OCR; a mixed page sends its masked render.
  const scan = renderScan(mupdf, page, scanDpi(scene), !mixed && !useLayer && ocr !== null);
  const masked = maskBoxes(scan.image, visible);
  // Read now: the page is not used after the first wait (a page read beside this one uses the document).
  const shapes = shapesOnPage(mupdf, page, scene);
  const inked = inkBoxes(masked, pictureBoxes(scene));
  if (mixed && !useLayer && inked.length === 0) return null;
  // A layer word under a patch in the render (an opaque annotation, a picture over the scan) is not on the page.
  let words: readonly OcrWord[] = dropCovered(layer, masked);
  let image = masked;
  // A crooked scan is read on an upright copy (`ocr-preprocess.ts`): the recogniser cuts its lines
  // and the table reader groups its rows on level text. Everything made from the words — the
  // lines, the paragraphs, the boxes — is in the copy's frame, `image`; the scan itself, `picture`,
  // keeps its pixels and gives the background, and the text boxes are put on it turned by the
  // skew angle at the end. A level scan, a page with a text layer and a page with real text over
  // the scan (its masks and boxes are in the page's own frame) are read as they are.
  const upright = !useLayer && !mixed && ocr !== null ? uprightScan(masked) : null;
  let picture = masked;
  image = upright?.image ?? masked;
  // Words read twice are dropped from the text, but their ink is erased all the same.
  let duplicates: readonly OcrWord[] = [];
  let rules: readonly Rule[] = [];
  let reread = false;
  let fromOcr = false;
  if (!useLayer && ocr !== null) {
    throwIfAborted(signal);
    const read = await readWords(
      mupdf,
      image,
      upright === null ? (mixed ? pngOf(mupdf, masked) : scan.png) : pngOf(mupdf, image),
      ocr,
      signal,
      upright === null ? null : { picture, angle: upright.angle },
    );
    if (read === null && layer.length === 0) return null;
    if (read !== null) {
      ({ words, duplicates, rules, image, picture } = read);
      reread = layer.length > 0;
      fromOcr = true;
    }
  }
  if (mixed) {
    words = dropMasked(words, visible, image.scale);
    // Only a page whose pictures hold text is rebuilt: with a logo or a chart in them it stays as it was.
    if (
      words.length === 0 ||
      (fromOcr && !inked.some((box) => wordsInPicture(image, words, box).length > 0))
    ) {
      return null;
    }
  }
  // Regions are found with the guesses at graphics left in; the guesses that lie over one are
  // dropped, and the page is erased again only if one lies outside.
  provideStandardMetrics(mupdf);
  const misread = misreadWords(words);
  const text = words.filter((word) => !misread.has(word));
  const turn = upright === null ? undefined : { scan: picture, angle: upright.angle };
  const first = ocrBackground(image, [...text, ...duplicates], turn);
  const kept = dropMisreads(
    words,
    first.regions.map((region) => region.box),
    misread,
  );
  const { pageColor, regions } =
    kept.length === text.length ? first : ocrBackground(image, [...kept, ...duplicates], turn);
  const solid = regions.filter((region) => region.solid).map((region) => region.box);
  const { boxes: set, flagged } = await setWords(
    mupdf,
    image,
    kept,
    ocr?.lowConfidence ?? 0,
    solid,
    rules,
    fonts,
  );
  // Put back on the scan: each box turned by the skew about the page centre (a slanted line's box).
  const boxes =
    upright === null
      ? set
      : turnBoxes(set, upright.angle, image.width / (2 * image.scale), image.height / (2 * image.scale));
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
      box: region.placed,
      data: pngOf(mupdf, region.rgba),
      mime: 'image/png',
    }),
  );
  return {
    items: [background, ...pictures, ...shapes],
    boxes,
    flagged,
    regions: pictures.length,
    mixed,
    layerRejected: reread,
  };
}
