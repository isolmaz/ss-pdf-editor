/**
 * A new, empty document.
 *
 * The home screen's "blank document" starts here: a page size, an orientation and a page
 * count become a PDF of that many empty pages, written by MuPDF like every other file
 * this product produces. The pages carry an empty content stream and no resources, so a
 * reader shows exactly a white page and the document has nothing to report as lost.
 *
 * The sizes are the ISO 216 and US sizes in PostScript points (1/72 in), rounded the way
 * every PDF producer rounds them (A4 = 595 × 842).
 */

import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError } from '../engines/mupdf';
import { saveRewrite } from '../engines/mupdf-write';
import type { OperationContext, OperationOutcome } from './types';
import { throwIfAborted } from './types';

export type BlankPageSize = 'a3' | 'a4' | 'a5' | 'letter' | 'legal';
export type BlankOrientation = 'portrait' | 'landscape';

/** Portrait width × height in points. */
export const BLANK_PAGE_SIZES: Readonly<Record<BlankPageSize, readonly [number, number]>> = {
  a3: [842, 1191],
  a4: [595, 842],
  a5: [420, 595],
  letter: [612, 792],
  legal: [612, 1008],
};

/** Enough for any real "start from nothing" document; a larger request is a typo. */
export const MAX_BLANK_PAGES = 500;

export interface BlankDocumentOptions {
  readonly size: BlankPageSize;
  readonly orientation: BlankOrientation;
  readonly pageCount: number;
  /** Written as the document title when non-empty. */
  readonly title?: string;
}

/** Width and height in points for a size and orientation. */
export function blankPageDimensions(
  size: BlankPageSize,
  orientation: BlankOrientation,
): readonly [number, number] {
  const [width, height] = BLANK_PAGE_SIZES[size];
  return orientation === 'landscape' ? [height, width] : [width, height];
}

export async function createBlankDocument(
  options: BlankDocumentOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (
    !Number.isSafeInteger(options.pageCount) ||
    options.pageCount < 1 ||
    options.pageCount > MAX_BLANK_PAGES
  ) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `a blank document takes 1-${MAX_BLANK_PAGES} pages, not ${options.pageCount}`,
    });
  }
  if (!(options.size in BLANK_PAGE_SIZES)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: `unknown page size ${String(options.size)}`,
    });
  }
  const [width, height] = blankPageDimensions(options.size, options.orientation);
  const mupdf = await loadMupdf();
  const document = new mupdf.PDFDocument();
  let bytes: Uint8Array;
  try {
    for (let index = 0; index < options.pageCount; index += 1) {
      const page = document.addPage([0, 0, width, height], 0, {}, '');
      document.insertPage(document.countPages(), page);
    }
    const title = options.title?.trim() ?? '';
    if (title.length > 0) document.setMetaData('info:Title', title);
    bytes = saveRewrite(document, 'createBlankDocument');
  } catch (error) {
    throw mapMupdfError(error, 'createBlankDocument');
  } finally {
    document.destroy();
  }
  return {
    bytes,
    report: {
      engine: 'mupdf',
      steps: ['create.blank', 'save'],
      notes: [],
      inputBytes: 0,
      outputBytes: bytes.length,
      pageCount: options.pageCount,
      incremental: false,
    },
  };
}
