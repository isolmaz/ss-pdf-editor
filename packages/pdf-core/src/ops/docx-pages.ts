/**
 * The "one picture per page" Word layout of `exportOffice`: every page is drawn by MuPDF as
 * it looks in a viewer (annotations and form fields included, white paper) and placed in
 * its own DOCX section as one picture, anchored at the page's corner behind the text. The
 * look is exact; the text is not editable in Word.
 *
 *  - A section is the page's size (after `/Rotate` and the crop box, what `getBounds` says)
 *    with no margins. A page above Word's 22-inch limit is shrunk by one factor on both
 *    sides (`wordPageScale`); the picture is rendered from the original size, so shrinking
 *    the page loses no detail.
 *  - The picture is 200 dpi of the original page from its corner, at one scale on both axes,
 *    capped at 40 megapixels, and shown at the section's size to the twip, so the page keeps
 *    its size. Its pixel count is the one a renderer draws the extent into, so it copies
 *    the pixels instead of resampling them (see `coverPixels`). JPEG (quality 92)
 *    when raster images cover at least half of the page — photographs, scans — where it is a
 *    fraction of the size; PNG otherwise (text and vector art stay crisp, and a small logo
 *    does not put JPEG artefacts around the text).
 *  - The paragraph that carries the picture is one point high, so it never spills onto a
 *    page of its own.
 */

import type { Page, PDFDocument } from 'mupdf';
import { loadMupdf, type Mupdf } from '../engines/mupdf';
import {
  anchoredPictureXml,
  contentTypesXml,
  corePropertiesXml,
  documentRelsXml,
  imageRelId,
  type MediaExtension,
  PACKAGE_RELS,
  pageSectionXml,
  TWIPS,
  wordDocumentXml,
  wordPageScale,
  XML_HEAD,
  zipped,
} from './docx-drawing';
import { borrowed, transformBox } from './page-layout';
import { type OperationContext, throwIfAborted } from './types';

/**
 * The resolution of a page's picture (never raised, so never above 300 dpi), and the most
 * pixels one may have: a page that would pass the cap is drawn at fewer dpi.
 */
const RENDER_DPI = 200;
const MAX_PIXELS = 40_000_000;
const JPEG_QUALITY = 92;
/** The share of the page raster images must cover for the page to be drawn as a JPEG. */
const PHOTO_SHARE = 0.5;

/** One page as a picture, with the size it takes in the document. */
export interface PageImage {
  /** 0-based page index. */
  readonly index: number;
  /** The page's size in the PDF, in points. */
  readonly width: number;
  readonly height: number;
  /** 1, or the factor that brought the page inside Word's 22-inch limit. */
  readonly scale: number;
  readonly extension: MediaExtension;
  readonly bytes: Uint8Array;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** The resolution the page was drawn at. */
  readonly dpi: number;
}

/**
 * Whether raster images cover at least `PHOTO_SHARE` of the page: the area of each drawn
 * image inside the page, added up (images that overlap count twice, which only matters for a
 * page that is mostly pictures anyway).
 */
function mostlyImages(mupdf: Mupdf, page: Page): boolean {
  const [x0, y0, x1, y1] = page.getBounds();
  let covered = 0;
  const device = new mupdf.Device({
    fillImage(image, ctm) {
      borrowed(image);
      const box = transformBox([0, 0, 1, 1], ctm);
      const width = Math.min(box[2], x1) - Math.max(box[0], x0);
      const height = Math.min(box[3], y1) - Math.max(box[1], y0);
      if (width > 0 && height > 0) covered += width * height;
    },
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  return covered >= PHOTO_SHARE * (x1 - x0) * (y1 - y0);
}

/**
 * A side of the page in points as Word keeps it: a whole number of twips (at most 0.025 pt from
 * the page's). The section's `w:pgSz` and the picture's extent both come from this, so the
 * picture is exactly the page (EMU = twips × 635) and LibreOffice, which keeps twips, does not
 * stretch it.
 */
const wordSide = (points: number): number => Math.round(points * TWIPS) / TWIPS;

/** Float noise below this (the page 612 pt at 200 dpi is 1700.0000000000002 px) is not a pixel. */
const PIXEL_EPSILON = 1e-6;

/**
 * The pixels of a side of the picture. A renderer draws a picture into the whole pixels its
 * extent reaches into (a viewer at 200 dpi: the extent in pixels, rounded up) and resamples it
 * to that count unless it already has it; an image of exactly that many pixels is copied, one
 * pixel to one, which keeps a noisy scan from being blurred. The extent is the page's side in
 * whole twips (`wordSide`, undone from the shrinking `scale`), drawn at `perPoint` pixels per point.
 */
const coverPixels = (points: number, scale: number, perPoint: number): number =>
  Math.max(1, Math.ceil((wordSide(points * scale) / scale) * perPoint - PIXEL_EPSILON));

/**
 * The most pixels per point at which a `width × height` page, drawn into the whole pixels that
 * reach over it (under two more than the exact count on each side, counting the twip rounding),
 * stays within `MAX_PIXELS`: the positive root of `(width · k + 2)(height · k + 2) = MAX_PIXELS`.
 */
export function cappedPerPoint(width: number, height: number): number {
  const area = width * height;
  const sides = (width + height) * 2;
  return (Math.sqrt(sides * sides + 4 * area * (MAX_PIXELS - 4)) - sides) / (2 * area);
}

/** The page, drawn at 200 dpi (fewer when that would pass 40 megapixels), as JPEG (mostly pictures) or PNG. */
function renderPage(mupdf: Mupdf, page: Page, index: number): PageImage {
  const [x0, y0, x1, y1] = page.getBounds();
  const width = x1 - x0;
  const height = y1 - y0;
  const scale = wordPageScale(width, height);
  const perPoint = Math.min(RENDER_DPI / 72, cappedPerPoint(width, height));
  const pixelWidth = coverPixels(width, scale, perPoint);
  const pixelHeight = coverPixels(height, scale, perPoint);
  // One scale for both axes, from the page's corner: pixel `(i, j)` is the square
  // `[i, i + 1] × [j, j + 1]` of the page at `perPoint` pixels per point, so the picture laid
  // down at that same scale is the page pixel for pixel; stretching the page to a whole number
  // of pixels would shift its far edge by a fraction of one.
  const place = mupdf.Matrix.concat(mupdf.Matrix.translate(-x0, -y0), mupdf.Matrix.scale(perPoint, perPoint));
  const photographic = mostlyImages(mupdf, page);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pixelWidth, pixelHeight], false);
  try {
    // White paper under what the page draws.
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(place, pixmap);
    try {
      // `run` draws what a viewer shows: the contents, the annotations and the form fields.
      page.run(device, mupdf.Matrix.identity);
      device.close();
    } finally {
      device.destroy();
    }
    // `slice` copies the bytes out of the engine's memory.
    const bytes = photographic ? pixmap.asJPEG(JPEG_QUALITY).slice() : pixmap.asPNG().slice();
    return {
      index,
      width,
      height,
      scale,
      extension: photographic ? 'jpeg' : 'png',
      bytes,
      pixelWidth,
      pixelHeight,
      dpi: perPoint * 72,
    };
  } finally {
    pixmap.destroy();
  }
}

/** The pages (0-based indices) as pictures, one at a time, the event loop given a turn between. */
export async function renderPageImages(
  doc: PDFDocument,
  pages: readonly number[],
  context: OperationContext,
): Promise<PageImage[]> {
  const mupdf = await loadMupdf();
  const out: PageImage[] = [];
  for (const [done, index] of pages.entries()) {
    throwIfAborted(context.signal);
    context.onProgress?.({
      phase: 'read',
      labelKey: 'op.progress.exportOffice.read',
      done,
      total: pages.length,
    });
    const page = doc.loadPage(index);
    try {
      out.push(renderPage(mupdf, page, index));
    } finally {
      page.destroy();
    }
    // Give the event loop a turn so the progress bar and Cancel stay live.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

/** The styles a page of pictures needs: the Normal style, no space between paragraphs. */
const STYLES_XML =
  `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '</w:styles>';

/**
 * LibreOffice lays an anchored picture one twip above where the file puts it, whatever the page
 * size (a picture at 0 pt comes out at 0.05 pt above the page's top edge, 0.14 px at 200 dpi — enough
 * to resample the whole page and lose several percent of SSIM). The offset cancels it: one twip
 * is invisible in Word.
 */
const LIBREOFFICE_LIFT = 1 / TWIPS;

/**
 * One page's paragraph: the anchored picture, in a run and a paragraph a point high.
 * `name` is its file under `word/media/`; `section` is the page's `w:sectPr` for all but the
 * last page (the body carries that one).
 */
function pageParagraphXml(image: PageImage, number: number, name: string, section: string): string {
  const size = '<w:sz w:val="2"/><w:szCs w:val="2"/>';
  const drawing = anchoredPictureXml({
    id: number,
    name,
    rid: imageRelId(number),
    x: 0,
    y: LIBREOFFICE_LIFT,
    width: wordSide(image.width * image.scale),
    height: wordSide(image.height * image.scale),
  });
  return (
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>' +
    `<w:rPr>${size}</w:rPr>${section}</w:pPr><w:r><w:rPr>${size}</w:rPr>${drawing}</w:r></w:p>`
  );
}

/** The DOCX of the pictures: one section per page, each a picture the size of its page. */
export async function pageImagesDocx(images: readonly PageImage[], title: string): Promise<Uint8Array> {
  const sections = images.map((image) =>
    pageSectionXml(wordSide(image.width * image.scale), wordSide(image.height * image.scale)),
  );
  const names = images.map((image, at) => `page${at + 1}.${image.extension}`);
  const last = images.length - 1;
  const paragraphs = images.map((image, at) =>
    pageParagraphXml(image, at + 1, names[at] as string, at === last ? '' : (sections[at] as string)),
  );
  // The last page's section is the body's own `w:sectPr`.
  const body = paragraphs.join('') + (sections[last] as string);
  const extensions = [...new Set(images.map((image) => image.extension))];
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypesXml(extensions),
    '_rels/.rels': PACKAGE_RELS('word/document.xml'),
    'docProps/core.xml': corePropertiesXml(title),
    'word/document.xml': wordDocumentXml(body),
    'word/styles.xml': STYLES_XML,
    'word/_rels/document.xml.rels': documentRelsXml(names),
  };
  images.forEach((image, at) => {
    files[`word/media/${names[at]}`] = image.bytes;
  });
  return zipped(files);
}
