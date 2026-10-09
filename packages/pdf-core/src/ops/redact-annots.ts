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
 *    quotes the removed comment is the same content under another object. The way back
 *    holds as well: a popup window shows its owner's `/Contents`, so a window that lies
 *    under a mark takes the comment it belongs to along (and that comment's own popup
 *    and replies). Only an owner the page does not list survives; its `/Popup` key is
 *    cleared instead of being left to dangle.
 *  - A removed widget leaves the form: its entry leaves `/AcroForm /Fields` or its
 *    parent's `/Kids`, a parent that thereby has no kid left is dropped the same way
 *    (its `/V` is the field's value), and `/CO` forgets it. A parent that still has a
 *    kid keeps the field, and the value with it — the surviving widget shows it. A field
 *    is counted once however many widgets it has, and only when its last widget is gone.
 *  - The removed objects are then *deleted*, not just unlinked: a structure tree's
 *    `/OBJR`, a `/ParentTree` entry or a surviving dictionary may still hold a reference,
 *    and a reference keeps an object — and the secret in it — in the written file. Those
 *    references dangle, which PDF reads as null.
 *  - A form that carries XFA keeps each value a second time in its datasets packet, and an
 *    XFA-aware reader redraws the field from there. `formHasXfa` tells the writer to drop
 *    the XFA entries (`redact.ts`) when a widget went.
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
  widgets: number;
  /**
   * Form fields removed: a field counts once however many widgets it had, and only when its
   * last widget is gone. Final once `finishSweep` has run.
   */
  fields: number;
  /** Other annotations removed; popup windows are not counted, they follow their comment. */
  annotations: number;
  /** Object numbers of everything removed (and of the field parents it emptied). */
  readonly gone: Set<number>;
  /** The fields that lost a widget, by object number: whether one is gone is known after the last page. */
  readonly touched: Map<number, PDFObject>;
}

export function newTally(): AnnotationTally {
  return { widgets: 0, fields: 0, annotations: 0, gone: new Set(), touched: new Map() };
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
 * The field a widget belongs to: the widget itself when it carries `/T` (field and widget in
 * one dictionary) or has no parent to name, otherwise its `/Parent`. `null` for a widget
 * written inline, which has no object number to count it by.
 */
function fieldOf(item: Listed): { readonly number: number; readonly dict: PDFObject } | null {
  if (item.dict.get('T').isNull()) {
    const parent = item.dict.get('Parent');
    const dict = parent.isIndirect() ? resolved(parent) : null;
    if (dict?.isDictionary() === true) return { number: parent.asIndirect(), dict };
  }
  return item.number === null ? null : { number: item.number, dict: item.dict };
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
  // The comment a popup window belongs to: the listed annotation whose `/Popup` names it.
  const ownerOf = (popup: Listed): Listed | undefined => {
    const parent = popup.dict.get('Parent');
    if (popup.number === null || !parent.isIndirect()) return undefined;
    const owner = items.find((candidate) => candidate.number === parent.asIndirect());
    const window = owner?.dict.get('Popup');
    return window?.isIndirect() === true && window.asIndirect() === popup.number ? owner : undefined;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of items) {
      if (doomed.has(item.index)) {
        // The window shows its owner's `/Contents`: marking the window marks the comment.
        const owner = item.subtype === 'Popup' ? ownerOf(item) : undefined;
        if (owner !== undefined && !doomed.has(owner.index)) {
          doom(owner);
          grew = true;
        }
        continue;
      }
      if ((item.subtype === 'Popup' && pointsAtDoomed(item, 'Parent')) || pointsAtDoomed(item, 'IRT')) {
        doom(item);
        grew = true;
      }
    }
  }

  for (const item of doomed.values()) {
    if (item.subtype === 'Widget') {
      tally.widgets += 1;
      const field = fieldOf(item);
      // A widget that is written inline names no object: it is its own field, and gone.
      if (field === null) tally.fields += 1;
      else tally.touched.set(field.number, field.dict);
    } else if (item.subtype !== 'Popup') tally.annotations += 1;
    if (item.number !== null) tally.gone.add(item.number);
    // A popup whose owner the page does not list: the owner survives, so its `/Popup` key must not dangle.
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
 * Count the fields that lost their last widget (`tally.fields`), take the removed widgets
 * out of the form, then delete every removed object.
 *
 * The walk starts at `/AcroForm /Fields`, not at the widgets' `/Parent`: a field tree whose
 * `/Parent` keys are missing or wrong is still pruned. A node that loses its last kid is
 * dropped and joins `gone`; a node that never had a kid is left alone.
 */
export function finishSweep(doc: PDFDocument, tally: AnnotationTally): void {
  const { gone } = tally;
  // A field is removed when none of its widgets is left: its own `/Kids` say which are.
  for (const field of tally.touched.values()) {
    const kids = resolved(field.get('Kids'));
    let widgetLeft = false;
    for (let index = 0; kids?.isArray() === true && index < kids.length && !widgetLeft; index += 1) {
      const kid = kids.get(index);
      widgetLeft = resolved(kid) !== null && !(kid.isIndirect() && gone.has(kid.asIndirect()));
    }
    if (!widgetLeft) tally.fields += 1;
  }
  if (tally.widgets > 0) {
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

/**
 * Whether the form carries XFA (`/AcroForm /XFA`). A static XFA form holds every field's
 * value a second time, in its datasets packet, and an XFA-aware reader draws the form from
 * that data and the template — not from the widgets this sweep removes.
 */
export function formHasXfa(doc: PDFDocument): boolean {
  const form = resolved(doc.getTrailer().get('Root').get('AcroForm'));
  return form?.isDictionary() === true && !form.get('XFA').isNull();
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
