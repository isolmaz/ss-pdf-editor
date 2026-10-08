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
 *  - The picture is 200 dpi of the original page, capped at 40 megapixels. JPEG (quality 90)
 *    when the page draws any raster image — photographs, scans — where it is a fraction of
 *    the size; PNG otherwise (text and vector art stay crisp).
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
  wordDocumentXml,
  wordPageScale,
  XML_HEAD,
  zipped,
} from './docx-drawing';
import { borrowed } from './page-layout';
import { type OperationContext, throwIfAborted } from './types';

/**
 * The resolution of a page's picture (never raised, so never above 300 dpi), and the most
 * pixels one may have: a page that would pass the cap is drawn at fewer dpi.
 */
const RENDER_DPI = 200;
const MAX_PIXELS = 40_000_000;
const JPEG_QUALITY = 90;

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
  /** The resolution the page was drawn at (the lower of its two axes). */
  readonly dpi: number;
}

/** Whether the page draws a raster image (not a vector drawing or text). */
function drawsImage(mupdf: Mupdf, page: Page): boolean {
  let found = false;
  const device = new mupdf.Device({
    fillImage(image) {
      borrowed(image);
      found = true;
    },
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  return found;
}

/** The page, drawn at 200 dpi (fewer when that would pass 40 megapixels), as JPEG or PNG. */
function renderPage(mupdf: Mupdf, page: Page, index: number): PageImage {
  const [x0, y0, x1, y1] = page.getBounds();
  const width = x1 - x0;
  const height = y1 - y0;
  const capped = Math.sqrt(MAX_PIXELS / (width * height));
  const perPoint = Math.min(RENDER_DPI / 72, capped);
  // Rounding down under the cap keeps the product at or below it.
  const whole = perPoint === capped ? Math.floor : Math.round;
  const pixelWidth = Math.max(1, whole(width * perPoint));
  const pixelHeight = Math.max(1, whole(height * perPoint));
  // Each side is scaled to its own pixel count, so the pixmap is exactly that size.
  const place = mupdf.Matrix.concat(
    mupdf.Matrix.translate(-x0, -y0),
    mupdf.Matrix.scale(pixelWidth / width, pixelHeight / height),
  );
  const photographic = drawsImage(mupdf, page);
  const pixmap = page.toPixmap(place, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    // `slice` copies the bytes out of the engine's memory.
    const bytes = photographic ? pixmap.asJPEG(JPEG_QUALITY).slice() : pixmap.asPNG().slice();
    return {
      index,
      width,
      height,
      scale: wordPageScale(width, height),
      extension: photographic ? 'jpeg' : 'png',
      bytes,
      pixelWidth,
      pixelHeight,
      dpi: Math.min((pixelWidth / width) * 72, (pixelHeight / height) * 72),
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
    y: 0,
    width: image.width * image.scale,
    height: image.height * image.scale,
  });
  return (
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>' +
    `<w:rPr>${size}</w:rPr>${section}</w:pPr><w:r><w:rPr>${size}</w:rPr>${drawing}</w:r></w:p>`
  );
}

/** The DOCX of the pictures: one section per page, each a picture the size of its page. */
export async function pageImagesDocx(images: readonly PageImage[], title: string): Promise<Uint8Array> {
  const sections = images.map((image) =>
    pageSectionXml(image.width * image.scale, image.height * image.scale),
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
