/**
 * Comment replies and review states.
 *
 * ## In the file
 *
 * PDF has one vocabulary for both (ISO 32000-2 §12.5.6.2–3), and every reader that shows
 * a comment thread speaks it:
 *
 *  - a **reply** is a `/Text` annotation whose `/IRT` (“in reply to”) names the comment
 *    it answers, with `/RT /R` (the default, so it is not written);
 *  - a **review state** is the same shape plus `/State` and `/StateModel`: `Review`
 *    with `Accepted`, `Rejected`, `Cancelled`, `Completed` or `None`, or `Marked` with
 *    `Marked`/`Unmarked`, both text strings (ISO 32000-1 Table 172; a file that wrote them
 *    as names is still read). A state is a record, not a field of the comment: each one
 *    says who set what and when, and the newest is the comment's state.
 *
 * Both are written with an **empty appearance**. A reply lives in the comment list, not
 * on the page: Acrobat draws none of them over the page, and a reader that knows nothing
 * of threads would otherwise stack a second note icon on top of every comment answered.
 * A state record is also flagged hidden (`/F` 30), as Acrobat writes it; pdf.js still
 * lists it (`viewable` ignores the Hidden bit), which is how `readAnnotations` sees it.
 *
 * The page box of a reply is the top-left icon square of the comment it answers, so a
 * reader that does show it shows it in the right place.
 *
 * ## In the session
 *
 * A mark that is not written yet carries its replies and state on itself
 * (`AnnotationMark.replies`, `.review`); `writeAnnotationsToFile` writes them with this
 * module once the mark has a reference of its own. A comment already in the file gets
 * them written at once, as one journal step.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  openForWrite,
  pageObjects,
  pdfDate,
  readName,
  readNumbers,
  readText,
  resolved,
  saveRewrite,
  text,
} from '../engines/mupdf-write';
import { type ReviewState, referenceOf } from './annotations';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

/** The side of the icon square a reply's `/Rect` takes at its comment's top-left corner. */
const ICON = 20;

/** `/F`: Print | NoZoom | NoRotate, the flags Acrobat gives a reply. */
const REPLY_FLAGS = 4 | 8 | 16;

/** `/F` for a state record: the reply flags plus Hidden. */
const STATE_FLAGS = REPLY_FLAGS | 2;

/** Subtypes that are not comments and cannot be answered. */
const NOT_COMMENTS = new Set(['Popup', 'Widget', 'Link']);

/** One record to write: a reply or a state, attached to a comment by its pdf.js id. */
export type ReviewRecordRequest = {
  /** 0-based page of the comment answered; the record goes on the same page. */
  readonly pageIndex: number;
  /** The comment answered, as pdf.js names it (`17R`). */
  readonly parentId: string;
  /** Written as `/NM`, the name XFDF and every reader use to address the record. */
  readonly id: string;
  readonly author: string;
  /** ISO 8601. */
  readonly createdAt: string;
} & (
  | { readonly kind: 'reply'; readonly contents: string }
  | { readonly kind: 'state'; readonly state: ReviewState }
);

export interface ReviewWriteOutcome extends OperationOutcome {
  /** `/NM` of every record written, in request order. */
  readonly written: readonly string[];
}

/** The text Acrobat writes into a state record (`Accepted set by Ayşe`). */
export function stateContents(state: string, author: string): string {
  return author.trim() === '' ? state : `${state} set by ${author.trim()}`;
}

/**
 * Write replies and review states into the file and read them back.
 *
 * Each record must find the comment it answers on its own page, under its own id; a
 * comment that is gone (another tab removed it) or a target that is not a comment is
 * refused rather than answered by a dangling `/IRT`.
 */
export async function writeCommentReview(
  bytes: Uint8Array,
  records: readonly ReviewRecordRequest[],
  context: OperationContext,
): Promise<ReviewWriteOutcome> {
  if (records.length === 0) {
    throw new ToolError('selection-empty', { engine: 'ui', engineMessage: 'no reply or state to write' });
  }
  const { doc } = await openForWrite(bytes);
  let saved: Uint8Array;
  let pageCount = 0;
  try {
    const pages = pageObjects(doc);
    pageCount = pages.length;
    try {
      for (const record of records) {
        throwIfAborted(context.signal);
        const page = pages[record.pageIndex];
        if (page === undefined) {
          throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex: record.pageIndex });
        }
        const parent = findAnnotation(doc, page, record.parentId);
        if (parent === null) {
          throw new ToolError('selection-empty', {
            engine: 'mupdf',
            pageIndex: record.pageIndex,
            engineMessage: `comment ${record.parentId} is not on page ${record.pageIndex + 1}`,
          });
        }
        const subtype = readName(parent.dict.get('Subtype')) ?? '';
        if (NOT_COMMENTS.has(subtype)) {
          throw new ToolError('unsupported', {
            engine: 'mupdf',
            pageIndex: record.pageIndex,
            engineMessage: `a ${subtype} annotation cannot be answered`,
          });
        }
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = readNumbers(parent.dict.get('Rect'));
        const left = Math.min(x0, x1);
        const top = Math.max(y0, y1);
        const date = text(doc, pdfDate(new Date(record.createdAt)));
        const appearance = doc.addStream('', {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, ICON, ICON],
          Matrix: [1, 0, 0, 1, 0, 0],
        });
        const colour = resolved(parent.dict.get('C'));
        const dict = doc.addObject({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [left, top - ICON, left + ICON, top],
          P: page,
          IRT: parent.entry,
          F: record.kind === 'state' ? STATE_FLAGS : REPLY_FLAGS,
          Name: 'Comment',
          NM: text(doc, record.id),
          T: text(doc, record.author),
          M: date,
          CreationDate: date,
          Contents: text(
            doc,
            record.kind === 'reply' ? record.contents : stateContents(record.state, record.author),
          ),
          AP: { N: appearance },
          // Text strings (ISO 32000-1 Table 172), not names: a bare JS string becomes a name.
          ...(record.kind === 'state'
            ? { State: text(doc, record.state), StateModel: text(doc, 'Review') }
            : {}),
        });
        if (colour?.isArray() === true) dict.put('C', colour);
        annotsOf(doc, page, true)?.push(dict);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // `mapMupdfError` hands a `ToolError` back unchanged.
      throw mapMupdfError(error, 'annotations.review');
    }
    saved = saveRewrite(doc, 'annotations.review');
  } finally {
    doc.destroy();
  }
  await verifyReview(saved, records, context);
  const replies = records.filter((record) => record.kind === 'reply').length;
  const states = records.length - replies;
  return {
    bytes: saved,
    written: records.map((record) => record.id),
    report: {
      engine: 'mupdf',
      steps: ['load', 'annotations.review', 'save', 'annotations.review.verify'],
      notes: [
        ...(replies === 0 ? [] : [note('changed', 'op.note.annotate.replies', { count: replies })]),
        ...(states === 0 ? [] : [note('changed', 'op.note.annotate.states', { count: states })]),
      ],
      inputBytes: bytes.byteLength,
      outputBytes: saved.byteLength,
      pageCount,
      incremental: false,
    },
  };
}

/** A page's annotation under a pdf.js id: its `/Annots` entry (the reference) and its dictionary. */
function findAnnotation(
  doc: PDFDocument,
  page: PDFObject,
  id: string,
): { readonly entry: PDFObject; readonly dict: PDFObject } | null {
  const annots = annotsOf(doc, page);
  if (annots === null) return null;
  for (let position = 0; position < annots.length; position += 1) {
    const entry = annots.get(position);
    if (!entry.isIndirect() || referenceOf(entry) !== id) continue;
    const dict = resolved(entry);
    return dict?.isDictionary() === true ? { entry, dict } : null;
  }
  return null;
}

/**
 * Read the written file back: every record is a `/Text` on its page under its `/NM`,
 * its `/IRT` points at the comment it answers, a state carries the state asked for, and
 * the comment is still there. Anything less is a write that did not happen.
 */
async function verifyReview(
  bytes: Uint8Array,
  records: readonly ReviewRecordRequest[],
  context: OperationContext,
): Promise<void> {
  const { doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    const missing: string[] = [];
    for (const record of records) {
      throwIfAborted(context.signal);
      // The writer refused a record whose page is missing, so every page index is valid here.
      const page = pages[record.pageIndex] as PDFObject;
      const annots = annotsOf(doc, page);
      let found = false;
      let parentPresent = false;
      for (let position = 0; annots !== null && position < annots.length; position += 1) {
        const entry = annots.get(position);
        if (entry.isIndirect() && referenceOf(entry) === record.parentId) parentPresent = true;
        const dict = resolved(entry);
        if (dict === null || !dict.isDictionary()) continue;
        if (readText(dict.get('NM')) !== record.id || readName(dict.get('Subtype')) !== 'Text') continue;
        const irt = dict.get('IRT');
        if (!irt.isIndirect() || referenceOf(irt) !== record.parentId) continue;
        if (record.kind === 'state' && readText(dict.get('State')) !== record.state) continue;
        found = true;
      }
      if (!found || !parentPresent) missing.push(record.id);
    }
    if (missing.length > 0) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `${missing.length} reply/state record(s) were not found in the written file`,
      });
    }
  } finally {
    doc.destroy();
  }
}
