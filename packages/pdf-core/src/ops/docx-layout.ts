/**
 * The "exact layout" Word layout of `exportOffice` (`docxLayout: 'layout'`): each page is
 * rebuilt in Word with the geometry it has in the PDF.
 *
 *  - A page is read once (`readPageScene`): the drawing in paint order, the links, the text.
 *  - A section is the page's size with no margins; a page above Word's 22-inch limit is
 *    shrunk by one factor on both sides (`wordPageScale`), text sizes and offsets with it.
 *  - The page's one paragraph is a point high and holds every drawing as an anchored run:
 *    first the scene's shapes and pictures in paint order (behind the text), then the text
 *    boxes (`textBoxes`), each above everything before it (`DocxRegistry.nextZ`). The text
 *    stays text, editable in Word, where the PDF had it.
 *  - The package's relationships carry the pictures and the external links the text boxes
 *    refer to; `styles.xml` sets the document's font to the one most text is set in.
 */

import type { PDFDocument } from 'mupdf';
import { loadMupdf } from '../engines/mupdf';
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
import { sceneItemXml } from './docx-layout-shapes';
import { textBoxes, textBoxXml, wordsInBoxes } from './docx-layout-text';
import { DocxRegistry, type PageScene, type TextBox } from './layout-scene';
import { readPageScene } from './layout-scene-read';
import { type OperationContext, throwIfAborted } from './types';

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
  /** Characters the PDF has no Unicode for (U+FFFD), over all pages. */
  readonly unreadable: number;
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
    '</w:styles>'
  );
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
): Promise<LayoutDocx> {
  const mupdf = await loadMupdf();
  const registry = new DocxRegistry(WORD_Z_BASE);
  const paragraphs: string[] = [];
  const allBoxes: TextBox[] = [];
  const scaled: { page: number; scale: number }[] = [];
  const textless: number[] = [];
  let shapes = 0;
  let pictures = 0;
  let rasters = 0;
  let unreadable = 0;
  let lastSection = '';
  for (const [done, index] of pages.entries()) {
    throwIfAborted(context.signal);
    context.onProgress?.({
      phase: 'read',
      labelKey: 'op.progress.exportOffice.read',
      done,
      total: pages.length,
    });
    const page = doc.loadPage(index);
    let scene: PageScene;
    try {
      scene = readPageScene(mupdf, page);
    } finally {
      page.destroy();
    }
    const scale = wordPageScale(scene.width, scene.height);
    if (scale < 1) scaled.push({ page: index + 1, scale });
    const section = pageSectionXml(scene.width * scale, scene.height * scale);
    const boxes = textBoxes(scene.text, scene.links);
    if (boxes.length === 0) textless.push(index + 1);
    allBoxes.push(...boxes);
    for (const item of scene.items) {
      if (item.kind === 'shape') shapes += 1;
      else if (item.kind === 'image') pictures += 1;
      else rasters += 1;
    }
    for (const block of scene.text.blocks) {
      if (block.kind !== 'text') continue;
      for (const line of block.lines) {
        for (const char of line.chars) if (char.c === '\uFFFD') unreadable += 1;
      }
    }
    const drawings = scene.items.map((item) => sceneItemXml(item, scale, registry)).join('');
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
  throwIfAborted(context.signal);
  context.onProgress?.({ phase: 'write', labelKey: 'op.progress.exportOffice.write' });
  // The last page's section is the body's own `w:sectPr`.
  const body = paragraphs.join('') + lastSection;
  const extensions = [
    ...new Set(registry.media.map((media): MediaExtension => (media.name.endsWith('.png') ? 'png' : 'jpeg'))),
  ];
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypesXml(extensions),
    '_rels/.rels': PACKAGE_RELS('word/document.xml'),
    'docProps/core.xml': corePropertiesXml(title),
    'word/document.xml': wordDocumentXml(body, SHAPE_NAMESPACES),
    'word/styles.xml': stylesXml(bodyFontOf(allBoxes), language),
    'word/_rels/document.xml.rels': documentRelsXml(
      registry.media.map((media) => media.name),
      registry.links,
    ),
  };
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
    unreadable,
  };
}
