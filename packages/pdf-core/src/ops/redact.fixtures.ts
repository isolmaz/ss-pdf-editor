/**
 * Pages built in a test for the redaction tests (`redact.test.ts`, `redact-find.test.ts`):
 * Helvetica lines on 400×500 pages, annotations and form fields hand-built onto them, and readers for
 * what the engine extracts back and for what the produced file still holds.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { loadMupdf } from '../engines/mupdf';
import { readNumbers, resolved } from '../engines/mupdf-write';
import type { RedactRect } from './redact';

/** A mark in the app's page space: x as in PDF user space, y counted down from the top. */
export const mark = (rect: readonly [number, number, number, number], pageIndex = 0): RedactRect => ({
  pageIndex,
  space: 'app-v1',
  rect,
});

/** 400×500 pages, Helvetica lines at (x, baseline y from the bottom); `rotate` is `/Rotate`. */
export async function build(
  pages: readonly {
    readonly lines: readonly (readonly [string, number, number])[];
    readonly rotate?: 0 | 90 | 180 | 270;
    readonly size?: number;
  }[],
  prepare?: (doc: PDFDocument) => void,
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  pages.forEach((page, index) => {
    const content = page.lines
      .map(([text, x, y]) => `BT /F1 ${page.size ?? 12} Tf ${x} ${y} Td (${text}) Tj ET`)
      .join('\n');
    doc.insertPage(index, doc.addPage([0, 0, 400, 500], page.rotate ?? 0, { Font: { F1: font } }, content));
  });
  prepare?.(doc);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Page texts of a document, as MuPDF extracts them. */
export async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf');
  const texts: string[] = [];
  for (let index = 0; index < doc.countPages(); index += 1) {
    const page = doc.loadPage(index);
    texts.push(page.toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' ').trim());
    page.destroy();
  }
  doc.destroy();
  return texts;
}

export const TWO_LINES = {
  lines: [
    ['Public line', 50, 400],
    ['Secret 4711', 50, 300],
  ] as const,
};

// ---- annotations and form fields ------------------------------------------------------------
// Hand-built the way a producer writes them: a text field is one dictionary that is both
// field and widget, a comment is a `/Text` annotation whose `/Popup` window points back
// through `/Parent`, a reply names the comment it answers in `/IRT`. Rectangles are in
// PDF user space (y up), like the annotation dictionaries themselves.

export const FIELD_SECRET = 'FIELDSECRET4';
export const NOTE_SECRET = 'NOTESECRET5';
export const LINK_SECRET = 'LINKSECRET6';
export const OUTSIDE_VALUE = 'OUTSIDEVALUE';
export const OUTSIDE_NOTE = 'OUTSIDENOTE';
export const OUTSIDE_LINK = 'OUTSIDELINK';

export type UserRect = readonly [number, number, number, number];

/**
 * A widget on page `pageIndex` (the first by default). With a `name` it is a field of its own
 * (`/FT /Tx`, `/T`); with a `value` it carries `/V` and an appearance stream that draws it.
 * A kid of a parent field has neither and names its `parent`.
 */
export function addWidget(
  doc: PDFDocument,
  spec: {
    readonly rect: UserRect;
    readonly name?: string;
    readonly value?: string;
    readonly parent?: PDFObject;
    readonly pageIndex?: number;
  },
): PDFObject {
  const [x0, y0, x1, y1] = spec.rect;
  const widget = doc.addObject({
    Type: 'Annot',
    Subtype: 'Widget',
    F: 4,
    Rect: [x0, y0, x1, y1],
    P: doc.findPage(spec.pageIndex ?? 0),
  });
  if (spec.name !== undefined) {
    widget.put('FT', 'Tx');
    widget.put('T', doc.newString(spec.name));
  }
  if (spec.value !== undefined) {
    const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    widget.put('V', doc.newString(spec.value));
    widget.put(
      'AP',
      doc.addObject({
        N: doc.addStream(`/Tx BMC BT /Helv 10 Tf 2 4 Td (${spec.value}) Tj ET EMC`, {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, x1 - x0, y1 - y0],
          Resources: { Font: { Helv: font } },
        }),
      }),
    );
  }
  if (spec.parent !== undefined) widget.put('Parent', spec.parent);
  return widget;
}

/** A sticky note on page 1; `popupRect` adds its popup window, `replyTo` makes it an answer to another note. */
export function addNote(
  doc: PDFDocument,
  spec: {
    readonly contents: string;
    readonly rect: UserRect;
    readonly popupRect?: UserRect;
    readonly replyTo?: PDFObject;
  },
): { readonly note: PDFObject; readonly popup: PDFObject | null } {
  const note = doc.addObject({
    Type: 'Annot',
    Subtype: 'Text',
    F: 4,
    Contents: doc.newString(spec.contents),
    Rect: [...spec.rect],
    P: doc.findPage(0),
    ...(spec.replyTo === undefined ? {} : { IRT: spec.replyTo, RT: 'R' }),
  });
  if (spec.popupRect === undefined) return { note, popup: null };
  const popup = doc.addObject({
    Type: 'Annot',
    Subtype: 'Popup',
    Rect: [...spec.popupRect],
    Parent: note,
    Open: false,
    P: doc.findPage(0),
  });
  note.put('Popup', popup);
  return { note, popup };
}

/** A link annotation to `https://example.test/<token>`. */
export function addLink(doc: PDFDocument, token: string, rect: UserRect): PDFObject {
  return doc.addObject({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [...rect],
    Border: [0, 0, 0],
    A: { S: 'URI', URI: doc.newString(`https://example.test/${token}`) },
  });
}

/** Make `annotations` the `/Annots` of page `pageIndex` (the first by default), in order. */
export function listOnPage(doc: PDFDocument, annotations: readonly PDFObject[], pageIndex = 0): void {
  doc.findPage(pageIndex).put('Annots', [...annotations]);
}

/** An `/AcroForm` whose `/Fields` are `fields`, with the default resources the fields' text needs. */
export function setForm(
  doc: PDFDocument,
  fields: readonly PDFObject[],
  extra: Record<string, unknown> = {},
): void {
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  doc
    .getTrailer()
    .get('Root')
    .put('AcroForm', {
      Fields: [...fields],
      DA: doc.newString('/Helv 10 Tf 0 g'),
      DR: { Font: { Helv: font } },
      ...extra,
    });
}

/**
 * The standard page for the annotation tests: "Secret 4711" sits under `SECRET_MARK` (user y
 * 290–315, x 40–200), and so do a text field, a comment (its popup window is off to the side)
 * and a link; a field, a comment with its popup and a link of the same kinds are far from it.
 */
export function formAndNotes(doc: PDFDocument): void {
  const secretField = addWidget(doc, { name: 'secretfield', value: FIELD_SECRET, rect: [60, 292, 150, 312] });
  const secret = addNote(doc, {
    contents: NOTE_SECRET,
    rect: [160, 292, 180, 312],
    popupRect: [300, 200, 380, 260],
  });
  const secretLink = addLink(doc, LINK_SECRET, [60, 296, 190, 308]);
  const otherField = addWidget(doc, { name: 'otherfield', value: OUTSIDE_VALUE, rect: [60, 100, 190, 120] });
  const other = addNote(doc, {
    contents: OUTSIDE_NOTE,
    rect: [210, 100, 230, 120],
    popupRect: [300, 40, 380, 90],
  });
  const otherLink = addLink(doc, OUTSIDE_LINK, [60, 60, 190, 80]);
  listOnPage(doc, [
    secretField,
    secret.note,
    secret.popup as PDFObject,
    secretLink,
    otherField,
    other.note,
    other.popup as PDFObject,
    otherLink,
  ]);
  setForm(doc, [secretField, otherField]);
}

/** One `/Annots` entry of a produced file, as the tests compare it (absent keys are left out). */
export interface AnnotationSummary {
  readonly subtype: string;
  readonly name?: string;
  readonly value?: string;
  readonly contents?: string;
  readonly uri?: string;
  readonly rect: readonly number[];
}

/** Open a produced file, run `read` on it at the object level, close it. */
export async function inProduced<T>(bytes: Uint8Array, read: (doc: PDFDocument) => T): Promise<T> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return read(doc);
  } finally {
    doc.destroy();
  }
}

const stringOf = (object: PDFObject): string | undefined =>
  object.isString() ? object.asString() : undefined;

/** Page `pageIndex`'s `/Annots`, read independently of the writer under test. */
export function annotationsOf(bytes: Uint8Array, pageIndex = 0): Promise<AnnotationSummary[]> {
  return inProduced(bytes, (doc) => {
    const list = resolved(doc.findPage(pageIndex).get('Annots'));
    const out: AnnotationSummary[] = [];
    for (let index = 0; list !== null && index < list.length; index += 1) {
      const annotation = resolved(list.get(index));
      if (annotation === null || !annotation.isDictionary()) continue;
      const action = resolved(annotation.get('A'));
      out.push({
        subtype: annotation.get('Subtype').asName(),
        name: stringOf(annotation.get('T')),
        value: stringOf(annotation.get('V')),
        contents: stringOf(annotation.get('Contents')),
        uri: action === null ? undefined : stringOf(action.get('URI')),
        rect: readNumbers(annotation.get('Rect')),
      });
    }
    return out;
  });
}

/** The `/T` of every node of the `/AcroForm /Fields` tree, depth first (unnamed widgets have none). */
export function fieldNames(bytes: Uint8Array): Promise<string[]> {
  return inProduced(bytes, (doc) => {
    const names: string[] = [];
    const seen = new Set<number>();
    const walk = (list: PDFObject): void => {
      for (let index = 0; index < list.length; index += 1) {
        const entry = list.get(index);
        // A looping tree is a fixture here: visit each object once. A reference the writer
        // dropped with the object it named is written as `null`.
        if (entry.isIndirect()) {
          if (seen.has(entry.asIndirect())) continue;
          seen.add(entry.asIndirect());
        }
        const node = resolved(entry);
        if (node === null || !node.isDictionary()) continue;
        const name = stringOf(node.get('T'));
        if (name !== undefined) names.push(name);
        const kids = resolved(node.get('Kids'));
        if (kids?.isArray() === true) walk(kids);
      }
    };
    const fields = resolved(doc.getTrailer().get('Root').get('AcroForm').get('Fields'));
    if (fields?.isArray() === true) walk(fields);
    return names;
  });
}

/** Every stream decompressed and every object spelled out: what a forensic read of the file sees. */
export function decompressed(bytes: Uint8Array): Promise<string> {
  return inProduced(bytes, (doc) =>
    new TextDecoder('latin1').decode(doc.saveToBuffer('decompress').asUint8Array()),
  );
}
