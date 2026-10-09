/**
 * The "exact layout" Word layout of `exportOffice` (`docxLayout: 'layout'`): each page is
 * rebuilt in Word with the geometry it has in the PDF.
 *
 *  - A page is read once (`readPageScene`): the drawing in paint order, the links, the text, and
 *    the text the form fields' and annotations' appearances draw (a field's value is in its
 *    appearance, not in the page's content), set in text boxes like the rest.
 *  - A section is the page's size with no margins; a page above Word's 22-inch limit is
 *    shrunk by one factor on both sides (`wordPageScale`), text sizes and offsets with it.
 *  - The page's one paragraph is a point high and holds every drawing as an anchored run:
 *    first the scene's shapes and pictures in paint order (behind the text), then the text
 *    boxes (`textBoxes`), each above everything before it (`DocxRegistry.nextZ`). The text
 *    stays text, editable in Word, where the PDF had it.
 *  - The package's relationships carry the pictures and the external links the text boxes
 *    refer to; `styles.xml` sets the document's font to the one most text is set in.
 */

import type { Page, PDFDocument } from 'mupdf';
import { loadMupdf, type Mupdf } from '../engines/mupdf';
import {
  contentTypesXml,
  corePropertiesXml,
  documentRelsXml,
  type MediaExtension,
  PACKAGE_RELS,
  pageSectionXml,
  SHAPE_NAMESPACES,
  wordDocumentXml,
  wordPageScale,
  XML_HEAD,
  xml,
  zipped,
} from './docx-drawing';
import { type EmbeddedFonts, embedFonts } from './docx-fonts';
import { isMixedPage, isScanPage, visibleBoxes } from './docx-layout-mixed';
import {
  type FlaggedWord,
  type OcrOptions,
  readPictureText,
  readScanPage,
  type ScanPage,
} from './docx-layout-ocr';
import { sceneItemXml } from './docx-layout-shapes';
import { textBoxes, textBoxXml, wordsInBoxes } from './docx-layout-text';
import { type OpenFonts, openFontFiles, openFontsFor, releaseOpenFonts } from './docx-ocr-font';
import { DocxRegistry, type PageScene, type TextBox } from './layout-scene';
import { readPageRaster, readPageScene } from './layout-scene-read';
import { type OperationContext, throwIfAborted } from './types';

export type { OcrOptions } from './docx-layout-ocr';

/**
 * Word's own first `relativeHeight`. Stacked from 1, LibreOffice paints the page-sized
 * background shape (height 1) over every shape and picture drawn after it; from Word's base
 * up it keeps the order.
 */
const WORD_Z_BASE = 251658240;

/** The body size of the document's default style, points (the text boxes carry their own). */
const BODY_SIZE = 11;

/** What the layout writer produced, with the totals the report is made of. */
export interface LayoutDocx {
  readonly bytes: Uint8Array;
  /** Pages written. */
  readonly pages: number;
  /** Words written, as mammoth reads them back (`wordsInBoxes`). */
  readonly words: number;
  /** Text boxes, vector shapes and pictures written, over all pages. */
  readonly boxes: number;
  readonly shapes: number;
  readonly pictures: number;
  /** Regions drawn as pictures because Word has no equivalent (`SceneRaster`). */
  readonly rasters: number;
  /** The pages that were shrunk to fit Word's limit: 1-based number and the factor. */
  readonly scaled: readonly { readonly page: number; readonly scale: number }[];
  /** 1-based numbers of the pages without any text. */
  readonly textless: readonly number[];
  /** Form fields with a value that no appearance shows, so the document cannot carry it. */
  readonly unseenFields: number;
  /** Characters the PDF has no Unicode for (U+FFFD), over all pages. */
  readonly unreadable: number;
  /** Fonts of the PDF embedded in the document (`docx-fonts.ts`). */
  readonly fonts: number;
  /** Scanned pages: those read by OCR (1-based), the words it was unsure of, and the scans left as pictures for want of a recogniser. */
  readonly ocr: {
    readonly pages: readonly number[];
    readonly flagged: readonly FlaggedWord[];
    readonly unavailable: readonly number[];
    /** Pages with real text over a scan (1-based): the text stays as it is and the scan's words were read with OCR. */
    readonly mixed: readonly number[];
    /** Pages whose invisible text layer was not trusted (unreadable characters, turned lines) and were read with OCR instead. */
    readonly untrusted: readonly number[];
    /** The open font families the scans' text is set in and the package carries (`docx-ocr-font.ts`). */
    readonly families: readonly string[];
  };
}

const COMMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const COMMENT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';

/** `word/comments.xml`: one comment per noted run, by the id its range carries. */
function commentsXml(comments: readonly { readonly id: number; readonly note: string }[]): string {
  const list = comments
    .map(
      ({ id, note }) =>
        `<w:comment w:id="${id}" w:author="SsPdfEditor" w:initials="OCR"><w:p><w:r><w:t xml:space="preserve">${xml(note)}</w:t></w:r></w:p></w:comment>`,
    )
    .join('');
  return `${XML_HEAD}<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${list}</w:comments>`;
}

/** The font most of the text is set in: the document's default font. */
function bodyFontOf(boxes: readonly TextBox[]): string {
  const counts = new Map<string, number>();
  for (const box of boxes) {
    for (const paragraph of box.paragraphs) {
      for (const line of paragraph.lines) {
        for (const run of line.runs) counts.set(run.font, (counts.get(run.font) ?? 0) + run.text.length);
      }
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Arial';
}

/** The styles of a page of boxes: no space between paragraphs, single lines, the main font. */
function stylesXml(font: string, language: string): string {
  const half = BODY_SIZE * 2;
  const name = xml(font);
  return (
    `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:cs="${name}"/>` +
    `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>${language === '' ? '' : `<w:lang w:val="${xml(language)}"/>`}</w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>' +
    '</w:styles>'
  );
}

/**
 * The page's scene; a page the shape reader fails on (a drawing it did not foresee) is the whole
 * page as one picture under its text boxes instead, so one page cannot fail the export.
 */
function readSceneOf(mupdf: Mupdf, page: Page): PageScene {
  try {
    return readPageScene(mupdf, page);
  } catch {
    return readPageRaster(mupdf, page);
  }
}

/**
 * The pages (0-based indices) of `doc` as one DOCX: read, one page at a time with the event
 * loop given a turn between, and written. The caller verifies the package with `words`.
 */
export async function writeLayoutDocx(
  doc: PDFDocument,
  pages: readonly number[],
  title: string,
  language: string,
  context: OperationContext,
  ocr: OcrOptions | null = null,
): Promise<LayoutDocx> {
  const mupdf = await loadMupdf();
  const embedded = await embedFonts(mupdf, doc, pages, context);
  // The open families the scans are set in are named against the PDF's own fonts and loaded once.
  const openFonts = openFontsFor(embedded.families);
  try {
    return await writePages(mupdf, doc, pages, title, language, context, ocr, embedded, openFonts);
  } finally {
    releaseOpenFonts(openFonts);
  }
}

/** `writeLayoutDocx` after the PDF's fonts are embedded. */
async function writePages(
  mupdf: Mupdf,
  doc: PDFDocument,
  pages: readonly number[],
  title: string,
  language: string,
  context: OperationContext,
  ocr: OcrOptions | null,
  embedded: EmbeddedFonts,
  openFonts: OpenFonts,
): Promise<LayoutDocx> {
  const registry = new DocxRegistry(WORD_Z_BASE);
  /** The scan pages' text boxes, for the open families' faces. */
  const scanBoxes: TextBox[] = [];
  const paragraphs: string[] = [];
  const allBoxes: TextBox[] = [];
  const scaled: { page: number; scale: number }[] = [];
  const textless: number[] = [];
  const ocrPages: number[] = [];
  const unavailable: number[] = [];
  const mixedPages: number[] = [];
  const untrusted: number[] = [];
  const flagged: FlaggedWord[] = [];
  let shapes = 0;
  let pictures = 0;
  let rasters = 0;
  let unreadable = 0;
  let unseenFields = 0;
  let lastSection = '';
  /** A page read: its scene, and what OCR made of it if it is a scan (`unavailable`: it is one, and there is no reading of it). */
  const readPage = async (
    index: number,
    signal: AbortSignal,
  ): Promise<{ scene: PageScene; scan: ScanPage | null; unavailable: boolean }> => {
    const page = doc.loadPage(index);
    try {
      const scene = readSceneOf(mupdf, page);
      // The readers are done with the page when they first wait, so a page read beside this one can use the document.
      let scan: ScanPage | null = null;
      if (isScanPage(scene)) scan = await readScanPage(mupdf, page, scene, ocr, signal, openFonts);
      else if (ocr !== null && isMixedPage(scene)) {
        // Real text over a scan: the text stays vector text, the scan's words are read with OCR (or `null`: nothing scanned to read).
        scan = await readScanPage(mupdf, page, scene, ocr, signal, openFonts, visibleBoxes(scene));
      } else if (ocr !== null) {
        // A picture on a page of vector text that holds text itself: its words become text boxes over it.
        scan = await readPictureText(mupdf, page, scene, ocr, signal, openFonts, visibleBoxes(scene));
      }
      return { scene, scan, unavailable: scan === null && isScanPage(scene) };
    } finally {
      page.destroy();
    }
  };
  // Scanned pages are read `ocr.concurrency` at a time, the ones after the page being written already under way;
  // the pages are written in their order. The reads stop with the export, however it ends.
  const ahead = Math.max(1, ocr?.concurrency ?? 1);
  const reading = new Map<number, ReturnType<typeof readPage>>();
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  context.signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (const [done, index] of pages.entries()) {
      throwIfAborted(context.signal);
      context.onProgress?.({
        phase: 'read',
        labelKey: 'op.progress.exportOffice.read',
        done,
        total: pages.length,
      });
      for (let next = done; next < Math.min(pages.length, done + ahead); next += 1) {
        if (reading.has(next)) continue;
        const started = readPage(pages[next] as number, stop.signal);
        // A read ahead that fails is the failure of its own page, when the loop gets there; until then it is not unhandled.
        started.catch(() => undefined);
        reading.set(next, started);
      }
      const { scene, scan, unavailable: unread } = await (reading.get(done) as ReturnType<typeof readPage>);
      reading.delete(done);
      if (unread) unavailable.push(index + 1);
      const scale = wordPageScale(scene.width, scene.height);
      if (scale < 1) scaled.push({ page: index + 1, scale });
      const section = pageSectionXml(scene.width * scale, scene.height * scale);
      const faceOf = (face: string) => embedded.faceOf(index, face);
      const vector = scan === null || scan.mixed;
      // The fields' text goes in boxes of its own, on a scan too: a scan's picture does not show it.
      const boxes = [
        ...(vector ? textBoxes(scene.text, scene.links, faceOf) : []),
        ...(scan?.boxes ?? []),
        ...textBoxes(scene.appearances, scene.links, faceOf),
      ];
      unseenFields += scene.unseenFields;
      const items = scan?.items ?? scene.items;
      if (scan !== null) {
        if (scan.mixed) mixedPages.push(index + 1);
        else ocrPages.push(index + 1);
        if (scan.layerRejected) untrusted.push(index + 1);
        scanBoxes.push(...scan.boxes);
        for (const word of scan.flagged) flagged.push({ page: index + 1, ...word });
      }
      if (boxes.length === 0) textless.push(index + 1);
      allBoxes.push(...boxes);
      for (const item of items) {
        if (item.kind === 'shape') shapes += 1;
        else if (item.kind === 'image') pictures += 1;
        else rasters += 1;
      }
      // The scene reads the page's text without pictures, so its blocks are text; a field's or an annotation's text counts too.
      const read = [...(vector ? scene.text.blocks : []), ...scene.appearances.blocks];
      for (const block of read.filter(
        (entry): entry is Extract<typeof entry, { kind: 'text' }> => entry.kind === 'text',
      )) {
        for (const line of block.lines) {
          for (const char of line.chars) if (char.c === '\uFFFD' && char.invisible !== true) unreadable += 1;
        }
      }
      const drawings = items.map((item) => sceneItemXml(item, scale, registry)).join('');
      const text = boxes.map((box) => textBoxXml(box, scale, registry)).join('');
      const isLast = done === pages.length - 1;
      if (isLast) lastSection = section;
      paragraphs.push(
        '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>' +
          `${isLast ? '' : section}</w:pPr><w:r><w:rPr><w:sz w:val="2"/></w:rPr></w:r>${drawings}${text}</w:p>`,
      );
      // Give the event loop a turn so the progress bar and Cancel stay live.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    stop.abort();
    context.signal.removeEventListener('abort', onAbort);
    await Promise.allSettled(reading.values());
  }
  throwIfAborted(context.signal);
  const open = [...openFonts.loaded.values()];
  const openFiles = openFontFiles(open, scanBoxes);
  const fonts = embedded.plus(openFiles);
  context.onProgress?.({ phase: 'write', labelKey: 'op.progress.exportOffice.write' });
  // The last page's section is the body's own `w:sectPr`.
  const body = paragraphs.join('') + lastSection;
  /** The comments part's declaration added to the content types or the relationships, when there are comments. */
  const withComments = (part: string, kind: 'types' | 'rels' = 'rels'): string => {
    if (registry.comments.length === 0) return part;
    return kind === 'types'
      ? part.replace(
          '</Types>',
          `<Override PartName="/word/comments.xml" ContentType="${COMMENT_TYPE}"/></Types>`,
        )
      : part.replace(
          '</Relationships>',
          `<Relationship Id="rIdComments" Type="${COMMENT_REL}" Target="comments.xml"/></Relationships>`,
        );
  };
  const extensions = [
    ...new Set(registry.media.map((media): MediaExtension => (media.name.endsWith('.png') ? 'png' : 'jpeg'))),
  ];
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': withComments(fonts.contentTypes(contentTypesXml(extensions)), 'types'),
    '_rels/.rels': PACKAGE_RELS('word/document.xml'),
    'docProps/core.xml': corePropertiesXml(title),
    'word/document.xml': wordDocumentXml(body, SHAPE_NAMESPACES),
    'word/styles.xml': stylesXml(bodyFontOf(allBoxes), language),
    'word/_rels/document.xml.rels': withComments(
      fonts.documentRels(
        documentRelsXml(
          registry.media.map((media) => media.name),
          registry.links,
        ),
      ),
    ),
    ...fonts.files,
  };
  if (registry.comments.length > 0) files['word/comments.xml'] = commentsXml(registry.comments);
  for (const media of registry.media) files[`word/media/${media.name}`] = media.data;
  return {
    bytes: await zipped(files),
    pages: pages.length,
    words: wordsInBoxes(allBoxes),
    boxes: allBoxes.length,
    shapes,
    pictures,
    rasters,
    scaled,
    textless,
    unseenFields,
    unreadable,
    fonts: fonts.count,
    ocr: {
      pages: ocrPages,
      flagged,
      unavailable,
      mixed: mixedPages,
      untrusted,
      families: open
        .filter((family) => openFiles.some((file) => file.family === family.name))
        .map((family) => family.family),
    },
  };
}
