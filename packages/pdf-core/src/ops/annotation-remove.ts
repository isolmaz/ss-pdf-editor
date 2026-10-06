/**
 * Removing persisted annotations — selection's verified writer (the
 * annotation-deletion capability).
 *
 * ## What this is not
 *
 * Selection deletes **annotations**, never page content. Text and images that are
 * part of a page's content stream are not annotations, and removing them is
 * redaction's job (`ops/redact.ts`): this module writes no content stream, no page
 * box and no page list, so what a reader sees as "the page" is untouched.
 *
 * ## What a target names
 *
 * A target is a **pdf.js annotation id on a stated page** — the pair
 * `readAnnotations()` reports and the comment panel lists
 * (`ExistingAnnotation.id` + `pageIndex`). pdf.js spells an id as the annotation's
 * object reference: `17R` for generation 0, `17R5` for generation 5
 * (`Ref.toString`, `build/pdf.mjs`). Resolution is therefore exact: the id is
 * parsed back to `objectNumber`/`generationNumber` and matched against the
 * **indirect reference** the stated page's `/Annots` array holds.
 *
 * Two consequences are deliberate:
 *
 *  - An id that does not name an object reference (pdf.js's synthetic `annot_12`
 *    for an annotation the file stores as a *direct* dictionary) is refused, not
 *    guessed at: it cannot be addressed by reference, and a positional guess would
 *    delete whatever moved into its place.
 *  - An id that resolves on some **other** page is not a match. The page in the
 *    target is the only page this call looks at, which is exactly what keeps a
 *    stale target from erasing a different annotation that shares its id.
 *
 * ## Refusals come first
 *
 * The whole request is judged before anything is written: every target must resolve
 * on its stated page, and a `/Widget` is refused outright — a widget *is* a form
 * field's visible half, so erasing one would silently drop the field from the
 * document's form (`flatten` or the form writer is the tool for that). A call that
 * cannot satisfy every target throws and produces nothing, so a partial deletion
 * cannot reach the caller.
 *
 * ## Popups
 *
 * A comment's popup window is a second annotation object. A target that owns one
 * takes it along — but only when the file proves the ownership, i.e. the popup's
 * `/Parent` names the target. A popup the target merely references is left in
 * place; there is no blanket delete of whatever sits near the target. Removing a
 * popup *target* clears the owning parent's `/Popup` key, because that parent
 * survives and its key would otherwise dangle.
 *
 * ## Object lifetime
 *
 * Unlinking an annotation from `/Annots` is what makes it invisible; deleting its
 * object is what keeps the file from keeping a dead dictionary per removal. The
 * object is deleted only
 * when nothing else in the document still points at it — another page's `/Annots`
 * entry, a reply's `/IRT`, a popup's `/Parent` — all read as references before the
 * delete. So a removal never creates a dangling reference, and it never rewrites a
 * surviving annotation's dictionary to make that true.
 *
 * ## The read-back
 *
 * The produced bytes are re-opened and compared with what the call predicted: every
 * requested id is gone from its page, every other annotation of every touched page
 * is still there under the same id, no page gained an annotation, and each page's
 * `/Annots` entry count is its count before minus what was removed from it. A
 * mismatch is `verification-failed` and the caller keeps the original file.
 *
 * The write is MuPDF's rewrite (`engines/mupdf-write.ts`), which regenerates no
 * appearance stream: regenerating field appearances would rewrite the form the
 * operation promises to leave alone. Object numbers are kept, so every survivor keeps
 * the pdf.js id the panel listed it under.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  openForWrite,
  pageObjects,
  producerKeptNote,
  readName,
  resolved,
  saveRewrite,
} from '../engines/mupdf-write';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

/**
 * One annotation to remove: an id `readAnnotations()` reported, on the page it
 * reported it for. The pair is the identity — the same id on another page is a
 * different annotation and is never touched.
 */
export interface AnnotationRemovalTarget {
  /** 0-based page the annotation was read from. */
  readonly pageIndex: number;
  /** pdf.js annotation id: the object reference (`17R`, `17R5`). */
  readonly id: string;
}

export interface RemoveAnnotationsRequest {
  readonly targets: readonly AnnotationRemovalTarget[];
}

export interface AnnotationRemovalOutcome extends OperationOutcome {
  /**
   * The ids actually removed, in request order and de-duplicated — what a caller
   * may now drop from its own lists. Popups that went with their parent are not
   * listed: they are not separately addressable marks.
   */
  readonly removed: readonly string[];
}

/** pdf.js's own reference spelling (`Ref.toString`): `17R` for generation 0. */
const REFERENCE_ID = /^(\d+)R(\d*)$/;

/** MuPDF's spelling of an indirect reference: `17 0 R`. */
const MUPDF_REFERENCE = /^(\d+) (\d+) R$/;

interface Reference {
  readonly objectNumber: number;
  readonly generationNumber: number;
}

/**
 * The id pdf.js reports for an object reference — the *only* spelling this module
 * matches against: generation 0 is `17R`, every other generation is `17R5`
 * (`Ref.toString`, `build/pdf.mjs`), and a file that says `17 0 R` is the same
 * object under MuPDF's spelling.
 */
function referenceId(ref: Reference): string {
  return ref.generationNumber === 0 ? `${ref.objectNumber}R` : `${ref.objectNumber}R${ref.generationNumber}`;
}

/**
 * The reference an indirect entry holds, generation included — `asIndirect()` answers
 * only the object number, and pdf.js ids carry the generation, so it is read off the
 * engine's own `toString()` (`17 5 R`). `null` for a direct value.
 */
function referenceOf(object: PDFObject): Reference | null {
  if (!object.isIndirect()) return null;
  const match = MUPDF_REFERENCE.exec(object.toString());
  if (match === null) return { objectNumber: object.asIndirect(), generationNumber: 0 };
  return { objectNumber: Number(match[1]), generationNumber: Number(match[2]) };
}

/** The pdf.js id of an indirect entry, or `null` for a direct value. */
function idOf(object: PDFObject): string | null {
  const reference = referenceOf(object);
  return reference === null ? null : referenceId(reference);
}

/** The reference a pdf.js id names, or `null` when the id is not an object reference. */
function parseReferenceId(id: string): Reference | null {
  const match = REFERENCE_ID.exec(id.trim());
  if (match === null) return null;
  const objectNumber = Number.parseInt(match[1] as string, 10);
  if (!Number.isSafeInteger(objectNumber) || objectNumber <= 0) return null;
  const digits = match[2] as string;
  const generationNumber = digits.length === 0 ? 0 : Number.parseInt(digits, 10);
  return Number.isSafeInteger(generationNumber) && generationNumber >= 0
    ? { objectNumber, generationNumber }
    : null;
}

/** The annotation references one page holds, by id, next to the array that holds them. */
interface PageAnnotations {
  readonly array: PDFObject | null;
  /** id → position in `/Annots`, for entries that travel as indirect references. */
  readonly refs: ReadonlyMap<string, number>;
  /** `/Annots` entry count, direct dictionaries included. */
  readonly count: number;
}

function annotationsOf(doc: PDFDocument, page: PDFObject): PageAnnotations {
  const array = annotsOf(doc, page);
  const refs = new Map<string, number>();
  if (array === null) return { array, refs, count: 0 };
  for (let position = 0; position < array.length; position += 1) {
    const id = idOf(array.get(position));
    if (id !== null) refs.set(id, position);
  }
  return { array, refs, count: array.length };
}

/** One target, judged without the document: a page and a canonical reference id. */
interface PlannedTarget {
  readonly pageIndex: number;
  readonly id: string;
}

/**
 * Validate the request and collapse repeated targets.
 *
 * Everything judged here is judged from the request alone, before the file is
 * opened: a request that cannot be satisfied must fail without a half-written file.
 */
function planRemovals(targets: readonly AnnotationRemovalTarget[]): PlannedTarget[] {
  const planned: PlannedTarget[] = [];
  const seen = new Set<string>();
  for (const [index, target] of targets.entries()) {
    const path = `request.targets[${index}]`;
    if (!Number.isInteger(target.pageIndex) || target.pageIndex < 0) {
      throw new ToolError('value-out-of-range', {
        engine: 'mupdf',
        path: `${path}.pageIndex`,
        engineMessage: `page index must be a non-negative integer, got ${String(target.pageIndex)}`,
      });
    }
    const parsed = typeof target.id === 'string' ? parseReferenceId(target.id) : null;
    if (parsed === null) {
      throw new ToolError('unsupported', {
        engine: 'mupdf',
        path: `${path}.id`,
        engineMessage:
          `annotation id ${JSON.stringify(String(target.id))} is not an object reference (e.g. 17R); ` +
          'an annotation the file stores as a direct dictionary cannot be addressed for removal',
      });
    }
    const id = referenceId(parsed);
    const key = `${target.pageIndex}|${id}`;
    // The same annotation named twice is one removal, not two.
    if (seen.has(key)) continue;
    seen.add(key);
    planned.push({ pageIndex: target.pageIndex, id });
  }
  return planned;
}

/** What the read-back compares the produced file against. */
interface RemovalExpectation {
  readonly pageCount: number;
  /** `/Annots` entry count per page, read before any mutation. */
  readonly beforeCounts: readonly number[];
  /** Reference ids per touched page, read before its first mutation. */
  readonly beforeIds: ReadonlyMap<number, ReadonlySet<string>>;
  /** Ids removed per touched page. */
  readonly removedIds: ReadonlyMap<number, ReadonlySet<string>>;
  /** `/Annots` entries removed per touched page (a page can list one object twice). */
  readonly removedCounts: ReadonlyMap<number, number>;
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Every reference to a doomed object that survives the removal.
 *
 * Only annotations can point at an annotation: a page's `/Annots` array, and the
 * `/IRT`, `/RT`, `/Popup` or `/Parent` keys of another annotation (including the
 * reply that points at the comment being removed). The walk reads references
 * without following them, so a cycle cannot trap it, and the doomed annotations'
 * own dictionaries are skipped — they are going away with their references.
 */
function heldReferences(
  doc: PDFDocument,
  pages: readonly PDFObject[],
  doomed: ReadonlySet<string>,
): Set<string> {
  const held = new Set<string>();
  const visit = (value: PDFObject): void => {
    const id = idOf(value);
    if (id !== null) {
      if (doomed.has(id)) held.add(id);
      return;
    }
    if (value.isDictionary()) {
      value.forEach((entry) => {
        visit(entry);
      });
      return;
    }
    if (value.isArray()) {
      for (let index = 0; index < value.length; index += 1) visit(value.get(index));
    }
  };
  for (const page of pages) {
    const array = annotsOf(doc, page);
    if (array === null) continue;
    for (let position = 0; position < array.length; position += 1) {
      const entry = array.get(position);
      const id = idOf(entry);
      // Still listed by a page: another page owns the same object.
      if (id !== null && doomed.has(id)) {
        held.add(id);
        continue;
      }
      const dict = resolved(entry);
      if (dict === null || !dict.isDictionary()) continue;
      dict.forEach((value) => {
        visit(value);
      });
    }
  }
  return held;
}

function verificationFailed(message: string, pageIndex?: number): ToolError {
  return new ToolError('verification-failed', {
    engine: 'mupdf',
    ...(pageIndex === undefined ? {} : { pageIndex }),
    engineMessage: message,
  });
}

/**
 * Re-open the produced bytes and check what the call predicted.
 *
 * A file that does not parse, a page count that moved, a page whose annotation count
 * is not its count before minus what was removed from it, an annotation that
 * disappeared without being asked for, an annotation that appeared, or a requested
 * id that is still there — each is `verification-failed`, and the caller keeps the
 * original file.
 */
async function verifyRemoval(produced: Uint8Array, expected: RemovalExpectation): Promise<void> {
  let doc: PDFDocument;
  try {
    ({ doc } = await openForWrite(produced));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw verificationFailed(`produced file does not re-open: ${message}`);
  }
  try {
    const pages = pageObjects(doc);
    if (pages.length !== expected.pageCount) {
      throw verificationFailed(`produced file has ${pages.length} pages, expected ${expected.pageCount}`);
    }
    for (const [index, page] of pages.entries()) {
      const annotations = annotationsOf(doc, page);
      const want = (expected.beforeCounts[index] ?? 0) - (expected.removedCounts.get(index) ?? 0);
      if (annotations.count !== want) {
        throw verificationFailed(
          `page ${index + 1} carries ${annotations.count} annotations, expected ${want}`,
          index,
        );
      }
      const before = expected.beforeIds.get(index);
      if (before === undefined) continue;
      const gone = expected.removedIds.get(index) ?? NO_IDS;
      for (const id of before) {
        const present = annotations.refs.has(id);
        if (gone.has(id)) {
          if (present)
            throw verificationFailed(`annotation ${id} is still on page ${index + 1} after removal`, index);
          continue;
        }
        if (!present) throw verificationFailed(`annotation ${id} disappeared from page ${index + 1}`, index);
      }
      for (const id of annotations.refs.keys()) {
        if (!before.has(id)) throw verificationFailed(`page ${index + 1} gained annotation ${id}`, index);
      }
    }
  } finally {
    doc.destroy();
  }
}

/** A request with nothing in it: no page is opened and the input comes back as it was. */
function nothingToDo(bytes: Uint8Array): AnnotationRemovalOutcome {
  return {
    bytes,
    removed: [],
    report: {
      engine: 'mupdf',
      // No engine pass ran, so no step id is claimed: the report says the call
      // changed nothing instead of naming work nobody did.
      steps: [],
      notes: [note('warning', 'op.note.annotate.nothing')],
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount: 0,
      incremental: true,
    },
  };
}

/** Unlink the doomed entries, delete the objects nothing else holds, drop empty arrays. */
function applyRemovals(
  doc: PDFDocument,
  pages: readonly PDFObject[],
  doomedPositions: ReadonlyMap<number, ReadonlySet<number>>,
  doomed: ReadonlyMap<string, number>,
  touched: Iterable<number>,
): void {
  for (const [pageIndex, positions] of doomedPositions) {
    const page = pages[pageIndex];
    const array = page === undefined ? null : annotsOf(doc, page);
    if (array === null) continue;
    // Descending, so positions collected from the untouched array stay valid.
    for (const position of [...positions].sort((left, right) => right - left)) array.delete(position);
  }

  // Objects a surviving annotation still points at are left in place: deleting one
  // would leave a dangling reference, and rewriting a surviving dictionary to avoid
  // that is a bigger claim than the request makes.
  const held = heldReferences(doc, pages, new Set(doomed.keys()));
  for (const [id, number] of doomed) {
    if (!held.has(id)) doc.deleteObject(number);
  }

  // An `/Annots` array with nothing left in it is a shell, not a fact.
  for (const pageIndex of touched) {
    const page = pages[pageIndex];
    if (page !== undefined && annotsOf(doc, page)?.length === 0) page.delete('Annots');
  }
}

/**
 * Remove persisted annotations, all of them or none.
 *
 * Bytes in, bytes out, through MuPDF: the input is never mutated and the
 * produced file is verified before it is returned. Every target is resolved on the
 * page it names, `/Widget` targets are refused, an owned popup goes with its
 * comment, and an annotation object is deleted only when nothing else still points
 * at it. The first failure throws and produces no bytes.
 */
export async function removePdfAnnotations(
  bytes: Uint8Array,
  request: RemoveAnnotationsRequest,
  context: OperationContext,
): Promise<AnnotationRemovalOutcome> {
  throwIfAborted(context.signal);
  const requested = request?.targets;
  if (!Array.isArray(requested)) {
    throw new ToolError('internal', {
      engine: 'mupdf',
      path: 'request.targets',
      engineMessage: 'removePdfAnnotations expects a targets array',
    });
  }
  const targets = planRemovals(requested);
  if (targets.length === 0) return nothingToDo(bytes);

  const { doc } = await openForWrite(bytes);
  let saved: Uint8Array;
  let expectation: RemovalExpectation;
  const removed: string[] = [];
  try {
    const pages = pageObjects(doc);
    const pageCount = pages.length;
    const beforeCounts = pages.map((page) => annotationsOf(doc, page).count);
    const beforeIds = new Map<number, ReadonlySet<string>>();
    const removedIds = new Map<number, Set<string>>();
    const removedCounts = new Map<number, number>();
    const doomedPositions = new Map<number, Set<number>>();
    /** id → object number of every object that goes. */
    const doomed = new Map<string, number>();

    /** The page at an index, or a failure naming what asked for it. */
    const pageOrFail = (pageIndex: number, what: string): PDFObject => {
      const page = pages[pageIndex];
      if (page === undefined) {
        throw new ToolError('range-invalid', {
          engine: 'mupdf',
          pageIndex,
          engineMessage: `${what} targets page ${pageIndex + 1} of ${pageCount}`,
        });
      }
      return page;
    };

    /** One page's annotations, with the pre-mutation id set captured on first read. */
    const readPage = (pageIndex: number, page: PDFObject): PageAnnotations => {
      const annotations = annotationsOf(doc, page);
      if (!beforeIds.has(pageIndex)) beforeIds.set(pageIndex, new Set(annotations.refs.keys()));
      return annotations;
    };

    /** Record one entry for removal, once, whatever asked for it. */
    const doom = (pageIndex: number, position: number, id: string, number: number): void => {
      const positions = doomedPositions.get(pageIndex) ?? new Set<number>();
      if (!positions.has(position)) {
        positions.add(position);
        doomedPositions.set(pageIndex, positions);
        removedCounts.set(pageIndex, (removedCounts.get(pageIndex) ?? 0) + 1);
      }
      const ids = removedIds.get(pageIndex) ?? new Set<string>();
      ids.add(id);
      removedIds.set(pageIndex, ids);
      doomed.set(id, number);
    };

    /** Unlink an annotation whichever page lists it; `false` when no page does. */
    const doomAnywhere = (id: string, number: number): boolean => {
      for (const [pageIndex, page] of pages.entries()) {
        const position = annotationsOf(doc, page).refs.get(id);
        if (position === undefined) continue;
        readPage(pageIndex, page);
        doom(pageIndex, position, id, number);
        return true;
      }
      return false;
    };

    try {
      for (const target of targets) {
        throwIfAborted(context.signal);
        const page = pageOrFail(target.pageIndex, `annotation ${target.id}`);
        const annotations = readPage(target.pageIndex, page);
        const position = annotations.refs.get(target.id);
        const entry = position === undefined ? null : (annotations.array?.get(position) ?? null);
        if (position === undefined || entry === null || !entry.isIndirect()) {
          throw new ToolError('selection-empty', {
            engine: 'mupdf',
            pageIndex: target.pageIndex,
            engineMessage: `annotation ${target.id} is not on page ${target.pageIndex + 1}`,
          });
        }
        const dict = resolved(entry);
        if (dict === null || !dict.isDictionary()) {
          throw new ToolError('corrupt-document', {
            engine: 'mupdf',
            pageIndex: target.pageIndex,
            engineMessage: `annotation ${target.id} on page ${target.pageIndex + 1} is not a dictionary`,
          });
        }
        const subtype = readName(dict.get('Subtype'));
        if (subtype === 'Widget') {
          throw new ToolError('unsupported', {
            engine: 'mupdf',
            pageIndex: target.pageIndex,
            engineMessage:
              `annotation ${target.id} is a form field widget (/Widget); ` +
              "erasing it would remove the field from the document's form",
          });
        }
        doom(target.pageIndex, position, target.id, entry.asIndirect());

        // The comment's own popup window goes with the comment, and only when the
        // popup's `/Parent` says the comment owns it.
        const popup = dict.get('Popup');
        const popupId = idOf(popup);
        if (popupId !== null && !doomed.has(popupId)) {
          const popupDict = resolved(popup);
          const owned = popupDict !== null && idOf(popupDict.get('Parent')) === target.id;
          // A popup no page lists is not on a page to unlink, but its `/Parent` dies
          // with the target, so the object goes too.
          if (owned && !doomAnywhere(popupId, popup.asIndirect())) doomed.set(popupId, popup.asIndirect());
        }

        // A popup that is itself a target leaves its owner's `/Popup` key pointing at a
        // removed object; the owner survives, so the key is cleared instead.
        if (subtype === 'Popup') {
          const parent = dict.get('Parent');
          const parentId = idOf(parent);
          if (parentId !== null && !doomed.has(parentId)) {
            const parentDict = resolved(parent);
            if (parentDict !== null && idOf(parentDict.get('Popup')) === target.id)
              parentDict.delete('Popup');
          }
        }

        removed.push(target.id);
      }

      applyRemovals(doc, pages, doomedPositions, doomed, beforeIds.keys());
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'annotations.remove');
    }

    saved = saveRewrite(doc, 'annotations.remove');
    expectation = { pageCount, beforeCounts, beforeIds, removedIds, removedCounts };
  } finally {
    doc.destroy();
  }
  await verifyRemoval(saved, expectation);

  return {
    bytes: saved,
    removed,
    report: {
      engine: 'mupdf',
      steps: ['load', 'annotations.remove', 'save', 'verify'],
      notes: [
        // The operation's own result first: which annotations were removed. The producer
        // line is still merged (metadata survives the rewrite) and still reported, but it
        // never stands in for the result.
        note('changed', 'ann.removed', { count: removed.length }),
        producerKeptNote(),
      ],
      inputBytes: bytes.byteLength,
      outputBytes: saved.byteLength,
      pageCount: expectation.pageCount,
      // A rewrite re-serialises the file: the incremental fast path ends here,
      // and the report says so.
      incremental: false,
    },
  };
}
