/**
 * Flatten a dynamic XFA form into an ordinary PDF.
 *
 * A dynamic XFA form has no pages of its own: the file's one page says "Please wait…" and
 * every reader that cannot run XFA shows only that. pdf.js *can* lay the template out
 * (`getXfa()` and `XfaLayer`), and the browser draws that layout; `pdf-ui`'s `xfa-raster.ts`
 * turns each laid-out page into a picture, and this file builds the PDF from the pictures:
 *
 *  - one page per XFA page, at the size the template gives it, the picture filling it;
 *  - an **invisible text layer** over each picture (the words the browser laid out, the
 *    same writer the OCR layer uses), so the result can be searched and copied;
 *  - nothing of the XFA is kept: no fields, no scripts, no data — a flat document.
 *
 * What it costs is said in the report: the pages are pictures (resolution is fixed at
 * render time), the fields are no longer fillable, and the fonts are the browser's rather
 * than the form's. The result is read back: page count and sizes, and the text layer must
 * contain the words that were handed in.
 */

import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError, openPdf } from '../engines/mupdf';
import { saveRewrite } from '../engines/mupdf-write';
import { type OcrLayerPage, writeOcrLayer } from './ocr';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

/** One word the browser laid out, in the picture's pixels (origin top-left). */
export interface XfaRasterWord {
  readonly text: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface XfaRasterPage {
  /** The page size the template gives, in PDF points. */
  readonly widthPt: number;
  readonly heightPt: number;
  /** Picture pixels per point. */
  readonly scale: number;
  readonly png: Uint8Array;
  readonly words: readonly XfaRasterWord[];
}

export async function buildFlattenedXfa(
  pages: readonly XfaRasterPage[],
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (pages.length === 0) {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'the XFA form has no pages' });
  }
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  let bytes: Uint8Array;
  try {
    for (const [index, page] of pages.entries()) {
      throwIfAborted(context.signal);
      const image = new mupdf.Image(page.png.slice());
      try {
        const ref = doc.addImage(image);
        const added = doc.addPage(
          [0, 0, page.widthPt, page.heightPt],
          0,
          { XObject: { Im0: ref } },
          `q ${page.widthPt} 0 0 ${page.heightPt} 0 0 cm /Im0 Do Q`,
        );
        doc.insertPage(index, added);
      } finally {
        image.destroy();
      }
    }
    doc.setMetaData('info:Title', 'XFA form (flattened)');
    bytes = saveRewrite(doc, 'xfa.flatten');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof ToolError) throw error;
    throw mapMupdfError(error, 'xfa.flatten');
  } finally {
    doc.destroy();
  }

  // The layer writer takes boxes in the unit viewport (one unit per point) and sizes each
  // word's glyphs and advance from the box itself, so the picture's pixels become points here.
  const layers: OcrLayerPage[] = pages.map((page, pageIndex) => ({
    pageIndex,
    words: page.words.map((word) => ({
      text: word.text,
      x0: word.x0 / page.scale,
      y0: word.y0 / page.scale,
      x1: word.x1 / page.scale,
      y1: word.y1 / page.scale,
      confidence: 100,
    })),
    toPdfPoint: (x, y) => [x, page.heightPt - y] as const,
  }));
  const withText = pages.some((page) => page.words.length > 0)
    ? await writeOcrLayer(bytes, layers, context)
    : bytes;

  await verify(withText, pages);

  return {
    bytes: withText,
    report: {
      engine: 'mupdf',
      steps: pages.some((page) => page.words.length > 0)
        ? ['xfa.flatten', 'ocr.layer', 'verify', 'save']
        : ['xfa.flatten', 'verify', 'save'],
      notes: [
        note('changed', 'xfa.note.flattened', { count: pages.length }),
        note('lost', 'xfa.note.flattenPictures'),
        note('lost', 'xfa.note.fieldsGone'),
        note('warning', 'xfa.note.fonts'),
      ],
      inputBytes: pages.reduce((sum, page) => sum + page.png.byteLength, 0),
      outputBytes: withText.byteLength,
      pageCount: pages.length,
      incremental: false,
    },
  };
}

/** Read the file back: every page there, at its size, and the handed-in words in its text. */
async function verify(bytes: Uint8Array, pages: readonly XfaRasterPage[]): Promise<void> {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    if (doc.countPages() !== pages.length) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `${doc.countPages()} pages written, ${pages.length} expected`,
      });
    }
    for (const [index, expected] of pages.entries()) {
      const page = doc.loadPage(index);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        if (Math.abs(x1 - x0 - expected.widthPt) > 0.5 || Math.abs(y1 - y0 - expected.heightPt) > 0.5) {
          throw new ToolError('verification-failed', {
            engine: 'mupdf',
            pageIndex: index,
            engineMessage: 'the page size differs from the XFA page',
          });
        }
        const sample = expected.words.find((word) => /\p{L}{3,}/u.test(word.text));
        if (sample !== undefined) {
          const text = page.toStructuredText('preserve-whitespace').asText();
          if (!text.includes(sample.text)) {
            throw new ToolError('verification-failed', {
              engine: 'mupdf',
              pageIndex: index,
              engineMessage: `the text layer does not hold "${sample.text}"`,
            });
          }
        }
      } finally {
        page.destroy();
      }
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw mapMupdfError(error, 'xfa.verify');
  } finally {
    doc.destroy();
  }
}
