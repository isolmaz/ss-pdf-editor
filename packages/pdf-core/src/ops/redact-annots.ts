/**
 * What redaction has to remove besides page content: annotations and form fields.
 *
 * MuPDF's `applyRedactions` erases glyphs, images and line art, and deletes the links it
 * touches — nothing else. A text field's widget keeps its `/V` and its appearance stream,
 * a sticky note keeps its `/Contents`, a highlight keeps the words it highlighted, and the
 * form's `/AcroForm /Fields` tree keeps pointing at the widget. Measured in the built app:
 * after "Apply" the field value and the note text were still in the saved file while the
 * report said the targeted content no longer existed.
 *
 * So the writer sweeps each marked page itself, **in PDF user space**: a mark is turned
 * into the page box's coordinates once (`topLeftRectToUserSpace`) and compared with the
 * annotation's own `/Rect`, which is stored in that space whatever the page's `/Rotate`
 * is. An annotation goes when its rectangle shares *area* with a mark — two rectangles
 * that only touch along an edge do not meet — and it goes whole: an annotation is one
 * thing the reader draws, there is no half of a sticky note to keep.
 *
 *  - Everything that is not a `/Redact` annotation is a candidate: widgets, comments,
 *    markup, stamps, whatever `applyRedactions` left behind.
 *  - What hangs off a removed annotation goes with it: its popup window (`/Parent`
 *    names it) and every reply (`/IRT` names it, a reply's replies too) — a reply that
 *    quotes the removed comment is the same content under another object. A popup that
 *    is removed on its own clears its surviving owner's `/Popup` key instead of leaving
 *    it dangling.
 *  - A removed widget leaves the form: its entry leaves `/AcroForm /Fields` or its
 *    parent's `/Kids`, a parent that thereby has no kid left is dropped the same way
 *    (its `/V` is the field's value), and `/CO` forgets it. A parent that still has a
 *    kid keeps the field, and the value with it — the surviving widget shows it.
 *  - The removed objects are then *deleted*, not just unlinked: a structure tree's
 *    `/OBJR`, a `/ParentTree` entry or a surviving dictionary may still hold a reference,
 *    and a reference keeps an object — and the secret in it — in the written file. Those
 *    references dangle, which PDF reads as null.
 *
 * `annotationUnder` is the same test run on the produced file: a verification that looked
 * at the text only would report a clean redaction over a form field that still holds its
 * value.
 */

import type { PDFDocument, PDFObject, Rect } from 'mupdf';
import { readName, readNumbers, resolved } from '../engines/mupdf-write';

/** How deep the field tree is followed; real forms are a handful of levels, a cycle or a hostile file is not. */
const FIELD_TREE_DEPTH = 64;

/** What a redaction run has removed so far, across pages. */
export interface AnnotationTally {
  /** Widgets removed — the visible half of a form field. */
  fields: number;
  /** Other annotations removed; popup windows are not counted, they follow their comment. */
  annotations: number;
  /** Object numbers of everything removed (and of the field parents it emptied). */
  readonly gone: Set<number>;
}

export function newTally(): AnnotationTally {
  return { fields: 0, annotations: 0, gone: new Set() };
}

/** One entry of a page's `/Annots` that is a dictionary. */
interface Listed {
  /** The `/Annots` array and the entry's position in it. */
  readonly list: PDFObject;
  readonly index: number;
  readonly dict: PDFObject;
  readonly subtype: string | null;
  /** The object number when the array entry is an indirect reference. */
  readonly number: number | null;
}

/** The dictionaries a page's `/Annots` lists, in order; none for a page without the array. */
function listedAnnotations(page: PDFObject): Listed[] {
  const items: Listed[] = [];
  const list = resolved(page.get('Annots'));
  if (list === null || !list.isArray()) return items;
  for (let index = 0; index < list.length; index += 1) {
    const entry = list.get(index);
    const dict = resolved(entry);
    if (dict === null || !dict.isDictionary()) continue;
    items.push({
      list,
      index,
      dict,
      subtype: readName(dict.get('Subtype')),
      number: entry.isIndirect() ? entry.asIndirect() : null,
    });
  }
  return items;
}

/** Whether the annotation's `/Rect` shares area with one of the rectangles (PDF user space). */
function isUnder(item: Listed, rects: readonly Rect[]): boolean {
  if (item.subtype === 'Redact') return false;
  const corners = readNumbers(item.dict.get('Rect'));
  if (corners.length < 4) return false;
  // `/Rect` may name any two opposite corners.
  const [a, b, c, d] = corners as [number, number, number, number];
  const x0 = Math.min(a, c);
  const x1 = Math.max(a, c);
  const y0 = Math.min(b, d);
  const y1 = Math.max(b, d);
  return rects.some((rect) => x0 < rect[2] && x1 > rect[0] && y0 < rect[3] && y1 > rect[1]);
}

/** Does an annotation other than `/Redact` still lie under any of the rectangles (PDF user space)? */
export function annotationUnder(page: PDFObject, rects: readonly Rect[]): boolean {
  return listedAnnotations(page).some((item) => isUnder(item, rects));
}

/**
 * Remove the annotations of one page that lie under `rects` (PDF user space), with their
 * popups and replies, and add them to `tally`. The form is pruned and the objects deleted
 * once, after every page, by `finishSweep`. Returns whether anything was removed.
 */
export function sweepPage(page: PDFObject, rects: readonly Rect[], tally: AnnotationTally): boolean {
  const items = listedAnnotations(page);
  const doomed = new Map<number, Listed>();
  const doomedNumbers = new Set<number>();
  const doom = (item: Listed): void => {
    doomed.set(item.index, item);
    if (item.number !== null) doomedNumbers.add(item.number);
  };
  for (const item of items) if (isUnder(item, rects)) doom(item);
  if (doomed.size === 0) return false;

  // Popups and replies of a doomed annotation are doomed, and so are the replies to those.
  const pointsAtDoomed = (item: Listed, key: string): boolean => {
    const reference = item.dict.get(key);
    return reference.isIndirect() && doomedNumbers.has(reference.asIndirect());
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of items) {
      if (doomed.has(item.index)) continue;
      if ((item.subtype === 'Popup' && pointsAtDoomed(item, 'Parent')) || pointsAtDoomed(item, 'IRT')) {
        doom(item);
        grew = true;
      }
    }
  }

  for (const item of doomed.values()) {
    if (item.subtype === 'Widget') tally.fields += 1;
    else if (item.subtype !== 'Popup') tally.annotations += 1;
    if (item.number !== null) tally.gone.add(item.number);
    // A popup removed on its own: its owner survives, so its `/Popup` key must not dangle.
    if (item.subtype === 'Popup') {
      const owner = resolved(item.dict.get('Parent'));
      if (owner?.isDictionary() === true) {
        const popup = owner.get('Popup');
        if (popup.isIndirect() && popup.asIndirect() === item.number) owner.delete('Popup');
      }
    }
  }
  // Descending, so the positions read before the first deletion stay valid.
  for (const item of [...doomed.values()].sort((left, right) => right.index - left.index)) {
    item.list.delete(item.index);
  }
  return true;
}

/**
 * Take the removed widgets out of the form, then delete every removed object.
 *
 * The walk starts at `/AcroForm /Fields`, not at the widgets' `/Parent`: a field tree whose
 * `/Parent` keys are missing or wrong is still pruned. A node that loses its last kid is
 * dropped and joins `gone`; a node that never had a kid is left alone.
 */
export function finishSweep(doc: PDFDocument, tally: AnnotationTally): void {
  const { gone } = tally;
  if (tally.fields > 0) {
    const form = resolved(doc.getTrailer().get('Root').get('AcroForm'));
    if (form?.isDictionary() === true) {
      const fields = resolved(form.get('Fields'));
      if (fields?.isArray() === true) pruneFieldList(fields, gone, new Set(), 0);
      const order = resolved(form.get('CO'));
      if (order?.isArray() === true) {
        for (let index = order.length - 1; index >= 0; index -= 1) {
          const entry = order.get(index);
          if (entry.isIndirect() && gone.has(entry.asIndirect())) order.delete(index);
        }
      }
    }
  }
  for (const number of gone) doc.deleteObject(number);
}

function pruneFieldList(list: PDFObject, gone: Set<number>, seen: Set<number>, depth: number): void {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list.get(index);
    const number = entry.isIndirect() ? entry.asIndirect() : null;
    if (number !== null && gone.has(number)) {
      list.delete(index);
      continue;
    }
    // A node reached twice (a cycle, or a kid listed under two parents) is pruned once.
    if (number !== null) {
      if (seen.has(number)) continue;
      seen.add(number);
    }
    const node = resolved(entry);
    if (node === null || !node.isDictionary() || depth >= FIELD_TREE_DEPTH) continue;
    const kids = resolved(node.get('Kids'));
    if (kids === null || !kids.isArray()) continue;
    const before = kids.length;
    pruneFieldList(kids, gone, seen, depth + 1);
    if (before > 0 && kids.length === 0) {
      list.delete(index);
      if (number !== null) gone.add(number);
    }
  }
}
