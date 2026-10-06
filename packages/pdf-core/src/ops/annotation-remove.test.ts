/**
 * Selection's core writer: persisted annotations, removed by exact reference.
 *
 * What this suite is here to catch:
 *
 *  - **A broad erase.** Every survivor assertion is about a survivor of the *same
 *    kind on the same page* as something that was removed — a "delete every
 *    annotation on the page", "delete every highlight" or "delete everything the
 *    engine lists" implementation fails here, while a targeted one passes.
 *  - **A wrong-page hit.** pdf.js ids are object references, so a stale target can
 *    name an id that exists on another page; that must fail rather than resolve
 *    somewhere else, and the annotation it names must still be in the file.
 *  - **An unverified removal.** The output is re-opened by pdf.js (the engine the
 *    application reads with) and by MuPDF's object model, walked object by object: the removed
 *    marks are gone, the survivors are still listed under the same ids, the form
 *    field keeps its value, and the page count is the same.
 *  - **A popup taken by association.** A comment's popup goes with the comment only
 *    when the popup's `/Parent` proves the ownership; a surviving annotation that
 *    merely points at the same popup must not lose it.
 *
 * The fixture is written with MuPDF's object model, the removal runs on the real MuPDF, and
 * every result is read back by the real pdf.js: the fixture is a file a reader could
 * open, not a hand-built dictionary graph. The
 * only environment note is Node's: pdf.js needs a worker script and cannot use the
 * browser-relative path the adapter installs, so the file inside the installed
 * package is used instead (the workaround `apps/web/src/operations.test.ts` documents).
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { PDFDocument, PDFObject } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { loadPdfjs, openWithPdfjs } from '../engines/pdfjs-handle';
import { type RemoveAnnotationsRequest, removePdfAnnotations } from './annotation-remove';
import { type ExistingAnnotation, readAnnotations } from './annotations';
import type { OperationContext } from './types';

const pdfjs = await loadPdfjs();
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve('pdfjs-dist/build/pdf.worker.mjs'),
).href;

const CONTEXT: OperationContext = { signal: new AbortController().signal };

/** The fixture's page size; every annotation below is written in PDF user space. */
const PAGE_WIDTH = 400;
const PAGE_HEIGHT = 500;

const STEPS = ['load', 'annotations.remove', 'save', 'verify'];

/**
 * A two-page document with real text, a text field with a real widget, one annotation
 * of every kind selection must reach, and survivors beside them.
 *
 * Page 1 carries the mixed set (`ann highlight`, `ann ink`, `ann note` with its own
 * popup, `ann shape`, `ann measure`) and, next to it, a `/Circle`, a second
 * `/Highlight`, a second `/Text` and that second text's own popup — so every kind that
 * can be removed is also a kind that must survive. Page 2 carries one `/Square` of its
 * own, which is what a page-scoped removal must not touch.
 *
 * The second text's `/Popup` deliberately points at the *first* comment's popup: a
 * reference is not ownership, and that popup must stay when the second text is removed.
 */
async function annotatedDocument(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const text = (value: string) => `BT /F 18 Tf 40 460 Td (${value}) Tj ET`;
  doc.insertPage(
    0,
    doc.addPage([0, 0, PAGE_WIDTH, PAGE_HEIGHT], 0, { Font: { F: font } }, text('Alpha page one')),
  );
  doc.insertPage(
    1,
    doc.addPage([0, 0, PAGE_WIDTH, PAGE_HEIGHT], 0, { Font: { F: font } }, text('Beta page two')),
  );
  const first = doc.findPage(0);
  const second = doc.findPage(1);
  first.put('Annots', []);
  second.put('Annots', []);

  const attach = (page: PDFObject, dict: Record<string, unknown>): PDFObject => {
    const ref = doc.addObject(dict);
    page.get('Annots').push(ref);
    return ref;
  };
  // Comments as indirect strings, the shape a producer that shares them writes.
  const contents = (value: string): PDFObject => doc.addObject(doc.newString(value));

  attach(first, {
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [40, 400, 200, 430],
    QuadPoints: [40, 430, 200, 430, 40, 400, 200, 400],
    Contents: contents('ann highlight'),
    C: [1, 1, 0],
    CA: 0.5,
    F: 4,
  });
  attach(first, {
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: [40, 300, 200, 340],
    InkList: [[50, 310, 90, 330, 130, 310]],
    BS: { W: 3 },
    Contents: contents('ann ink'),
    F: 4,
  });
  attach(first, {
    Type: 'Annot',
    Subtype: 'Square',
    Rect: [40, 180, 200, 260],
    BS: { W: 2 },
    Contents: contents('ann shape'),
    F: 4,
  });
  attach(first, {
    Type: 'Annot',
    Subtype: 'Line',
    Rect: [40, 100, 200, 140],
    L: [50, 110, 190, 130],
    Measure: { Subtype: 'RL', R: [1, 100], X: { U: doc.newString('mm'), D: 2 } },
    Contents: contents('ann measure'),
    F: 4,
  });
  const note = attach(first, {
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [40, 60, 60, 80],
    Contents: contents('ann note'),
    F: 4,
  });
  const popup = attach(first, {
    Type: 'Annot',
    Subtype: 'Popup',
    Rect: [40, 60, 160, 110],
    Parent: note,
    Contents: contents('ann popup'),
    Open: false,
    F: 4,
  });
  note.put('Popup', popup);

  attach(first, {
    Type: 'Annot',
    Subtype: 'Circle',
    Rect: [250, 400, 330, 460],
    Contents: contents('keep circle'),
    F: 4,
  });
  const keepHighlight = attach(first, {
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [250, 340, 360, 370],
    QuadPoints: [250, 370, 360, 370, 250, 340, 360, 340],
    Contents: contents('keep highlight'),
    F: 4,
  });
  const keepPopup = attach(first, {
    Type: 'Annot',
    Subtype: 'Popup',
    Rect: [250, 340, 360, 390],
    Parent: keepHighlight,
    Contents: contents('keep popup'),
    F: 4,
  });
  keepHighlight.put('Popup', keepPopup);
  const keepNote = attach(first, {
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [250, 240, 270, 260],
    Contents: contents('keep note'),
    F: 4,
  });
  // A reference to the *first* comment's popup: ownership is the popup's `/Parent`, not
  // who points at it, so this must not make that popup removable.
  keepNote.put('Popup', popup);

  attach(second, {
    Type: 'Annot',
    Subtype: 'Square',
    Rect: [40, 400, 120, 460],
    Contents: contents('keep second page'),
    F: 4,
  });

  // A text field whose dictionary is its widget, with a value and an appearance.
  const appearance = doc.addStream('/Tx BMC BT /F 12 Tf 2 5 Td (Ada Lovelace) Tj ET EMC', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 180, 20],
    Resources: { Font: { F: font } },
  });
  const field = attach(first, {
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Tx',
    T: doc.newString('customer'),
    V: doc.newString('Ada Lovelace'),
    DA: doc.newString('/F 12 Tf 0 g'),
    Rect: [40, 20, 220, 40],
    P: first,
    F: 4,
    AP: { N: appearance },
  });
  doc
    .getTrailer()
    .get('Root')
    .put('AcroForm', { Fields: [field], DR: { Font: { F: font } } });

  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The engine's own view of a file's annotations, with the handle released. */
async function annotationsOf(bytes: Uint8Array): Promise<readonly ExistingAnnotation[]> {
  const handle = await openWithPdfjs(bytes);
  try {
    return await readAnnotations(handle, CONTEXT);
  } finally {
    await handle.destroy();
  }
}

/** The id the engine reports for the annotation with this comment (and kind). */
function idOf(existing: readonly ExistingAnnotation[], comment: string, subtype?: string): string {
  const match = existing.find(
    (annotation) =>
      annotation.contents === comment && (subtype === undefined || annotation.subtype === subtype),
  );
  if (match === undefined) {
    throw new Error(`the fixture carries no ${subtype ?? 'annotation'} commented "${comment}"`);
  }
  return match.id;
}

/** The refusal a request must produce; a request that succeeds is a failure here. */
async function refusalOf(bytes: Uint8Array, request: RemoveAnnotationsRequest): Promise<ToolError> {
  try {
    const outcome = await removePdfAnnotations(bytes, request, CONTEXT);
    throw new Error(`the removal was accepted and produced ${outcome.bytes.byteLength} bytes`);
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
}

/** Run `read` on the written file, opened with MuPDF, and release it. */
async function withDocument(bytes: Uint8Array, read: (doc: PDFDocument) => void): Promise<void> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    read(doc);
  } finally {
    doc.destroy();
  }
}

/** Every indirect dictionary in a written file whose `/Contents` decodes to `value`. */
function dictionariesWith(doc: PDFDocument, value: string): PDFObject[] {
  const found: PDFObject[] = [];
  for (let number = 1; number < doc.countObjects(); number += 1) {
    const object = doc.newIndirect(number).resolve();
    if (!object.isDictionary()) continue;
    // The fixture writes its comments as indirect strings, so the key is resolved —
    // and only a string can be a comment (`/Contents` is a stream or an array elsewhere).
    const raw = object.get('Contents');
    if (raw.isNull() || raw.isStream()) continue;
    const resolvedText = raw.resolve();
    if (resolvedText.isString() && resolvedText.asString() === value) found.push(object);
  }
  return found;
}

/** A text field's `/V`, read through the AcroForm by its name. */
function fieldValue(doc: PDFDocument, name: string): string | null {
  const fields = doc.getTrailer().get('Root', 'AcroForm', 'Fields').resolve();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields.get(index).resolve();
    if (field.get('T').asString() === name) return field.get('V').asString();
  }
  return null;
}

describe('removePdfAnnotations', () => {
  it('removes exactly the targeted marks of every kind and leaves the file alone', async () => {
    const bytes = await annotatedDocument();
    const existing = await annotationsOf(bytes);

    const highlight = { pageIndex: 0, id: idOf(existing, 'ann highlight') };
    const targets = [
      highlight,
      { pageIndex: 0, id: idOf(existing, 'ann ink') },
      { pageIndex: 0, id: idOf(existing, 'ann note', 'Text') },
      { pageIndex: 0, id: idOf(existing, 'ann shape') },
      { pageIndex: 0, id: idOf(existing, 'ann measure') },
    ];
    const popupId = idOf(existing, 'ann note', 'Popup');

    // The same annotation twice is one removal, not two.
    const outcome = await removePdfAnnotations(bytes, { targets: [...targets, highlight] }, CONTEXT);

    expect(outcome.removed).toEqual(targets.map((target) => target.id));
    expect(outcome.report.engine).toBe('mupdf');
    expect(outcome.report.steps).toEqual(STEPS);
    expect(outcome.report.incremental).toBe(false);
    expect(outcome.report.pageCount).toBe(2);
    // The report states the result the caller asked for, with its count.
    expect(outcome.report.notes).toContainEqual({
      kind: 'changed',
      key: 'ann.removed',
      params: { count: targets.length },
    });
    expect(outcome.bytes).not.toBe(bytes);

    const after = await annotationsOf(outcome.bytes);
    const ids = after.map((annotation) => annotation.id);
    const comments = after.map((annotation) => annotation.contents);

    for (const target of targets) expect(ids).not.toContain(target.id);
    // The comment's own popup went with the comment.
    expect(ids).not.toContain(popupId);
    expect(comments).not.toContain('ann highlight');
    expect(comments).not.toContain('ann ink');
    expect(comments).not.toContain('ann shape');
    expect(comments).not.toContain('ann measure');
    expect(comments).not.toContain('ann note');

    // Same-kind, same-page survivors: a broad erase cannot pass this.
    expect(comments).toContain('keep circle');
    expect(comments).toContain('keep highlight');
    expect(comments).toContain('keep note');
    expect(comments).toContain('keep second page');
    expect(ids).toContain(idOf(existing, 'keep highlight'));
    // pdf.js reports a popup under its *parent's* comment, so the pair is found by the
    // parent's text plus the subtype.
    expect(ids).toContain(idOf(existing, 'keep highlight', 'Popup'));
    expect(ids).toContain(idOf(existing, 'keep second page'));

    await withDocument(outcome.bytes, (reopened) => {
      expect(reopened.countPages()).toBe(2);
      // The field the file already had keeps its value, and its widget is still listed.
      expect(fieldValue(reopened, 'customer')).toBe('Ada Lovelace');
      // The removed objects are gone from the file, not merely unlinked from the page.
      expect(dictionariesWith(reopened, 'ann ink')).toHaveLength(0);
      expect(dictionariesWith(reopened, 'ann highlight')).toHaveLength(0);
      expect(dictionariesWith(reopened, 'ann note')).toHaveLength(0);
      expect(dictionariesWith(reopened, 'keep circle')).toHaveLength(1);
      // The survivor that pointed at the removed comment's popup keeps a live reference:
      // the popup object is retained precisely so that reference cannot dangle.
      const survivor = dictionariesWith(reopened, 'keep note')[0];
      const referenced = survivor?.get('Popup');
      if (referenced === undefined || !referenced.isIndirect()) {
        throw new Error('the surviving comment lost its /Popup reference');
      }
      expect(referenced.resolve().isDictionary()).toBe(true);
    });
    expect(after.some((annotation) => annotation.annotationType === 20)).toBe(true);
  });

  it('keeps the raw PDF geometry selection hit-tests with', async () => {
    const existing = await annotationsOf(await annotatedDocument());

    const highlight = existing.find((annotation) => annotation.contents === 'ann highlight');
    expect(highlight?.subtype).toBe('Highlight');
    expect(highlight?.annotationType).toBe(9);
    expect(highlight?.quadPoints).toEqual([40, 430, 200, 430, 40, 400, 200, 400]);
    expect(highlight?.color).toBe('#ffff00');
    expect(highlight?.opacity).toBe(0.5);
    expect(highlight?.rect).toEqual([40, 400, 200, 430]);
    expect(highlight?.pageBox).toEqual([0, 0, PAGE_WIDTH, PAGE_HEIGHT]);

    const ink = existing.find((annotation) => annotation.contents === 'ann ink');
    expect(ink?.inkLists).toEqual([[50, 310, 90, 330, 130, 310]]);
    expect(ink?.thickness).toBe(3);

    // A `/Line` has no `/Vertices`; its `/L` endpoints arrive in the same field.
    const measure = existing.find((annotation) => annotation.contents === 'ann measure');
    expect(measure?.vertices).toEqual([50, 110, 190, 130]);

    // The two kinds a selection has to be able to tell apart from a comment.
    expect(existing.find((annotation) => annotation.annotationType === 20)?.subtype).toBe('Widget');
    expect(existing.find((annotation) => annotation.subtype === 'Popup')?.annotationType).toBe(16);

    // Absent data stays absent: nothing invents geometry for a plain shape.
    const circle = existing.find((annotation) => annotation.contents === 'keep circle');
    // Without this the four checks below would also pass for a circle that was never read.
    expect(circle?.subtype).toBe('Circle');
    expect(circle?.quadPoints).toBeUndefined();
    expect(circle?.inkLists).toBeUndefined();
    expect(circle?.vertices).toBeUndefined();
    expect(circle?.opacity).toBeUndefined();
  });

  it('refuses stale, unknown and unaddressable targets without writing anything', async () => {
    const bytes = await annotatedDocument();
    const existing = await annotationsOf(bytes);
    const highlightId = idOf(existing, 'ann highlight');
    const widgetId = idOf(existing, '', 'Widget');

    // The id resolves on page 1, and the target says page 2: a stale target must fail
    // rather than resolve to whatever shares its id, and page 1 keeps its annotation.
    const stale = await refusalOf(bytes, { targets: [{ pageIndex: 1, id: highlightId }] });
    expect(stale.code).toBe('selection-empty');
    expect(stale.details.pageIndex).toBe(1);

    const unknown = await refusalOf(bytes, { targets: [{ pageIndex: 0, id: '9999R' }] });
    expect(unknown.code).toBe('selection-empty');

    // pdf.js's synthetic id for an annotation the file stores as a direct dictionary
    // cannot be addressed by reference: refused loudly, never skipped.
    const synthetic = await refusalOf(bytes, { targets: [{ pageIndex: 0, id: 'annot_12' }] });
    expect(synthetic.code).toBe('unsupported');

    // A widget is a form field's visible half; deleting a mark must not delete the field.
    const widget = await refusalOf(bytes, { targets: [{ pageIndex: 0, id: widgetId }] });
    expect(widget.code).toBe('unsupported');

    const missingPage = await refusalOf(bytes, { targets: [{ pageIndex: 9, id: highlightId }] });
    expect(missingPage.code).toBe('range-invalid');

    // Nothing was written and nothing was unlinked: the input still lists every mark.
    expect((await annotationsOf(bytes)).map((annotation) => annotation.id)).toEqual(
      existing.map((annotation) => annotation.id),
    );
  });

  it('takes a popup with its comment, and only when the comment owns it', async () => {
    const bytes = await annotatedDocument();
    const existing = await annotationsOf(bytes);
    const noteId = idOf(existing, 'ann note', 'Text');
    const popupId = idOf(existing, 'ann note', 'Popup');
    const keepPopupId = idOf(existing, 'keep highlight', 'Popup');

    const owned = await removePdfAnnotations(bytes, { targets: [{ pageIndex: 0, id: noteId }] }, CONTEXT);
    const afterOwned = (await annotationsOf(owned.bytes)).map((annotation) => annotation.id);
    expect(afterOwned).not.toContain(popupId);
    // The other comment's popup pair is untouched.
    expect(afterOwned).toContain(keepPopupId);

    // The survivor points at the *first* comment's popup but does not own it: removing
    // the survivor must leave that popup (and its owner) in the file.
    const keepNoteId = idOf(existing, 'keep note', 'Text');
    const foreign = await removePdfAnnotations(
      bytes,
      { targets: [{ pageIndex: 0, id: keepNoteId }] },
      CONTEXT,
    );
    const remaining = (await annotationsOf(foreign.bytes)).map((annotation) => annotation.id);
    expect(remaining).not.toContain(keepNoteId);
    expect(remaining).toContain(popupId);
    expect(remaining).toContain(noteId);
  });

  it('clears the comment popup reference when only the popup is removed, instead of leaving it dangling', async () => {
    const bytes = await annotatedDocument();
    const existing = await annotationsOf(bytes);
    const popupId = idOf(existing, 'ann note', 'Popup');

    const outcome = await removePdfAnnotations(bytes, { targets: [{ pageIndex: 0, id: popupId }] }, CONTEXT);
    expect(outcome.removed).toEqual([popupId]);
    await withDocument(outcome.bytes, (reopened) => {
      const owner = dictionariesWith(reopened, 'ann note').find(
        (dict) => dict.get('Subtype').asName() === 'Text',
      );
      expect(owner).toBeDefined();
      expect(owner?.get('Popup').isNull()).toBe(true);
    });
    const after = await annotationsOf(outcome.bytes);
    expect(after.map((annotation) => annotation.id)).not.toContain(popupId);
    expect(after.map((annotation) => annotation.contents)).toContain('ann note');
  });

  it('leaves no empty /Annots shell behind when a page loses its last annotation', async () => {
    const bytes = await annotatedDocument();
    const existing = await annotationsOf(bytes);
    const secondId = idOf(existing, 'keep second page');

    const outcome = await removePdfAnnotations(bytes, { targets: [{ pageIndex: 1, id: secondId }] }, CONTEXT);
    await withDocument(outcome.bytes, (reopened) => {
      expect(reopened.findPage(1).get('Annots').isNull()).toBe(true);
    });

    // Page 2 lost its annotation; page 1 kept every one of its own.
    const after = await annotationsOf(outcome.bytes);
    expect(after.every((annotation) => annotation.pageIndex === 0)).toBe(true);
    expect(after.map((annotation) => annotation.contents)).toContain('keep circle');
    expect(after.map((annotation) => annotation.contents)).toContain('ann highlight');
  });

  it('returns the input untouched for an empty request', async () => {
    const bytes = await annotatedDocument();
    const outcome = await removePdfAnnotations(bytes, { targets: [] }, CONTEXT);

    expect(outcome.bytes).toBe(bytes);
    expect(outcome.removed).toEqual([]);
    expect(outcome.report.steps).toEqual([]);
    expect(outcome.report.incremental).toBe(true);
    expect(outcome.report.inputBytes).toBe(bytes.byteLength);
    expect(outcome.report.outputBytes).toBe(bytes.byteLength);
  });
});
