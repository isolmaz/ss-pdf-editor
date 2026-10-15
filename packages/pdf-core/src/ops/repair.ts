/**
 * Repair a damaged PDF.
 *
 * MuPDF repairs a file as it opens it: when the cross-reference table or the trailer is missing,
 * truncated or points at the wrong offsets, it rebuilds the table by reading every object in the
 * file (`wasRepaired()` says it had to). Saving the document then writes the objects it found
 * as a clean file with a table of its own, which every reader opens without a repair of its own.
 *
 * The output is read back before it is returned: it must open without a repair, hold the same
 * pages and be a file the viewer's engine opens too. A file with nothing MuPDF can read (no
 * objects, no pages) is `corrupt-document`, never an empty document presented as a repair.
 */

import { ToolError } from 'pdf-shared';
import { mapMupdfError, openPdf } from '../engines/mupdf';
import { openForWrite, producerKeptNote, saveRewrite } from '../engines/mupdf-write';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { countSignedFields } from './signature-status';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

export interface RepairOutcome extends OperationOutcome {
  /** Whether the file was damaged: MuPDF had to rebuild its structure to open it. */
  readonly repaired: boolean;
}

export async function repairDocument(bytes: Uint8Array, context: OperationContext): Promise<RepairOutcome> {
  throwIfAborted(context.signal);
  const { mupdf, doc } = await openForWrite(bytes);
  let repaired: boolean;
  let signed: boolean;
  let pageCount: number;
  let out: Uint8Array;
  try {
    pageCount = doc.countPages();
    if (pageCount === 0) {
      throw new ToolError('corrupt-document', {
        engine: 'mupdf',
        engineMessage: 'no page could be read from the file',
      });
    }
    signed = countSignedFields(doc) > 0;
    out = saveRewrite(doc, 'repair');
    // Asked last: MuPDF repairs lazily, when an object it needs is not where the table says, so the
    // flag is only complete once the whole file has been read for the save.
    repaired = doc.wasRepaired();
  } catch (error) {
    throw mapMupdfError(error, 'repair');
  } finally {
    doc.destroy();
  }

  throwIfAborted(context.signal);
  const written = openPdf(mupdf, out);
  let writtenPages: number;
  let writtenRepaired: boolean;
  try {
    writtenPages = written.countPages();
    writtenRepaired = written.wasRepaired();
  } catch (error) {
    throw mapMupdfError(error, 'repair.verify');
  } finally {
    written.destroy();
  }
  const handle = await openWithPdfjs(out, { signal: context.signal });
  let viewerPages: number;
  try {
    viewerPages = handle.pageCount;
  } finally {
    await handle.destroy();
  }
  if (writtenRepaired || new Set([pageCount, writtenPages, viewerPages]).size > 1) {
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `the repaired file has ${writtenPages} pages (${viewerPages} in the viewer) and ${
        writtenRepaired ? 'still needs a repair' : 'opens as it is'
      }, expected ${pageCount}`,
    });
  }

  const notes: OperationNote[] = repaired
    ? [note('changed', 'op.note.repair.rebuilt'), note('warning', 'op.note.repair.check')]
    : [note('changed', 'op.note.repair.rewritten')];
  if (signed) notes.push(note('lost', 'op.note.repair.signatureBroken'));
  notes.push(producerKeptNote(), note('preserved', 'op.note.repair.verified', { pages: pageCount }));

  return {
    bytes: out,
    repaired,
    report: {
      engine: 'mupdf',
      steps: repaired ? ['load', 'repair', 'save'] : ['load', 'save'],
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: out.byteLength,
      pageCount,
      incremental: false,
    },
  };
}
