/**
 * Scanned pages to a PDF (the camera scanner).
 *
 * The scanner's pictures — each already straightened and filtered in the page, then
 * encoded as a JPEG — become the pages of a new document. Composing is `imagesToPdf`,
 * not a second writer: the same embedding, the same page-size rules, the same
 * verification surface. What this adds is the scan's own contract:
 *
 *  - a page is one picture, in the order given, none skipped: `imagesToPdf` reports a
 *    picture it cannot embed as a warning and carries on, which is right for a folder of
 *    files and wrong here, where a missing page is a lost scan, so any such warning fails;
 *  - the output is read back with pdf.js before it is returned: the page count must be
 *    the number of pictures, and every page must have the paper (or, for `fit`, the
 *    picture's proportions) that was asked for.
 *
 * The photograph, the corners, the filters and the JPEG quality are the scanner's
 * (`scan-image.ts` and the dialog); this operation never sees a camera.
 */

import { ToolError } from 'pdf-shared';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { imagesToPdf } from './images';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

export type ScanPageSize = 'a4' | 'letter' | 'fit';

export interface ScanPageInput {
  readonly name: string;
  /** The straightened, filtered page as a JPEG. */
  readonly bytes: Uint8Array;
  /** Its size in pixels, for the read-back (`fit` pages are checked against the picture's proportions). */
  readonly width: number;
  readonly height: number;
}

export interface ScanToPdfOptions {
  readonly pages: readonly ScanPageInput[];
  readonly pageSize: ScanPageSize;
}

/** A4's long side in points: a `fit` page is as large as an A4 sheet on its long side. */
export const FIT_LONG_SIDE_PT = 841.89;

const PAPER: Record<'a4' | 'letter', readonly [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

export async function scanPagesToPdf(
  options: ScanToPdfOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (options.pages.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'no scanned page was handed in',
    });
  }

  const composed = await imagesToPdf(
    {
      images: options.pages.map((page) => ({ name: page.name, bytes: page.bytes })),
      pageSize: options.pageSize,
      fit: 'contain',
      marginMm: 0,
      // The pictures come from a canvas and carry no orientation tag.
      applyExif: false,
      fitLongSidePt: FIT_LONG_SIDE_PT,
    },
    context,
  );

  // Verify by reading the document back.
  const handle = await openWithPdfjs(composed.bytes, { signal: context.signal });
  try {
    if (handle.pageCount !== options.pages.length) {
      throw new ToolError('verification-failed', {
        engine: 'pdfjs',
        engineMessage: `${options.pages.length} scanned page(s) became ${handle.pageCount} page(s)`,
      });
    }
    for (const [index, page] of options.pages.entries()) {
      const size = await handle.getPageSize(index, 1);
      const wanted: readonly [number, number] =
        options.pageSize === 'fit' ? [page.width, page.height] : PAPER[options.pageSize];
      const ratio = size.width / size.height;
      const wantedRatio = wanted[0] / wanted[1];
      // `fit` keeps the picture's proportions; the paper sizes are fixed (to a point of rounding).
      const tolerance = options.pageSize === 'fit' ? 0.01 : 0.005;
      if (Math.abs(ratio / wantedRatio - 1) > tolerance) {
        throw new ToolError('verification-failed', {
          engine: 'pdfjs',
          pageIndex: index,
          engineMessage: `page ${index + 1} is ${size.width.toFixed(1)}x${size.height.toFixed(1)} pt, expected the proportions of ${wanted[0]}x${wanted[1]}`,
        });
      }
    }
  } finally {
    await handle.destroy();
  }

  const skipped = composed.report.notes.filter((entry) => entry.kind === 'warning');
  if (skipped.length > 0) {
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `a scanned page could not be embedded: ${skipped.map((entry) => entry.key).join(', ')}`,
    });
  }
  const notes: OperationNote[] = [
    ...composed.report.notes,
    note('changed', 'op.note.scan.pages', { count: options.pages.length }),
  ];
  return {
    bytes: composed.bytes,
    report: {
      ...composed.report,
      steps: ['scan.compose', ...composed.report.steps],
      notes,
    },
  };
}
