/** Hand-built XFA forms: an `/AcroForm /XFA` array or one XDP stream, with the widgets of a static form. */

import type { PDFDocument, PDFObject } from 'mupdf';
import { loadMupdf } from '../engines/mupdf';

export const TEMPLATE = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"><subform><field name="Name"><ui><textEdit/></ui></field><field name="Agree"><ui><checkButton/></ui><items><integer>1</integer><integer>0</integer></items></field><field name="Birth"><ui><dateTimeEdit/></ui><format><picture>date{DD/MM/YYYY}</picture></format></field></subform></subform></template>`;
export const DATASETS = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Old</Name><Agree>0</Agree><Birth>2000-01-01</Birth><City>Ankara</City></form1></xfa:data></xfa:datasets>`;
const PREAMBLE = '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">';

export interface Build {
  /** `static` has AcroForm widgets; `dynamic` has none. */
  readonly kind: 'static' | 'dynamic' | 'none';
  readonly layout?: 'array' | 'stream';
  /** `false` leaves the packet out; text replaces the datasets packet. */
  readonly datasets?: boolean | string;
  /** `null` leaves the packet out. */
  readonly template?: string | null;
}

export async function xfaPdf({ kind, layout = 'array', datasets = true, template = TEMPLATE }: Build) {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 300], 0, {}, ''));
  const page = doc.findPage(0);
  const box = (width: number, height: number) =>
    doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height] });
  const widget = (extra: Record<string, unknown>, rect: number[]) =>
    doc.addObject({ Type: 'Annot', Subtype: 'Widget', Rect: rect, P: page, F: 4, ...extra });

  const fields: PDFObject[] = [];
  if (kind !== 'dynamic') {
    const root = doc.addObject({ T: doc.newString('form1[0]'), Kids: [] });
    const inner = doc.addObject({ T: doc.newString('#subform[0]'), Parent: root, Kids: [] });
    root.get('Kids').push(inner);
    const name = widget(
      { FT: 'Tx', T: doc.newString('Name[0]'), Parent: inner, AP: { N: box(160, 20) } },
      [20, 250, 180, 270],
    );
    const agree = widget(
      {
        FT: 'Btn',
        T: doc.newString('Agree[0]'),
        Parent: inner,
        V: 'Off',
        AS: 'Off',
        AP: { N: { Yes: box(20, 20), Off: box(20, 20) } },
      },
      [20, 210, 40, 230],
    );
    const birth = widget(
      { FT: 'Tx', T: doc.newString('Birth[0]'), Parent: inner, AP: { N: box(100, 20) } },
      [20, 170, 120, 190],
    );
    for (const entry of [name, agree, birth]) inner.get('Kids').push(entry);
    page.put('Annots', [name, agree, birth]);
    fields.push(root);
  }
  const form = doc.addObject({ Fields: fields });
  doc.getTrailer().get('Root').put('AcroForm', form);

  if (kind !== 'none') {
    const packets: [string, string][] = [
      ['preamble', PREAMBLE],
      ...(template === null ? [] : ([['template', template]] as [string, string][])),
      ...(datasets === false
        ? []
        : ([['datasets', datasets === true ? DATASETS : datasets]] as [string, string][])),
      ['postamble', '<xfa:postamble/>'],
    ];
    if (layout === 'array') {
      const array = doc.newArray();
      for (const [name, body] of packets) {
        array.push(doc.newString(name));
        array.push(doc.addStream(body, doc.newDictionary()));
      }
      form.put('XFA', array);
    } else {
      const body = packets
        .filter(([name]) => name === 'template' || name === 'datasets')
        .map(([, text]) => text)
        .join('');
      form.put(
        'XFA',
        doc.addStream(`<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">${body}</xdp:xdp>`, doc.newDictionary()),
      );
    }
    if (kind === 'dynamic') doc.getTrailer().get('Root').put('NeedsRendering', true);
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Run `body` on the document, as an independent reader opening the bytes. */
export async function withPdf<T>(bytes: Uint8Array, body: (doc: PDFDocument) => T): Promise<T> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return body(doc);
  } finally {
    doc.destroy();
  }
}

/** The XFA as the file holds it: packet name → text for an array, `{ xdp: text }` for one stream. */
export function xfaTexts(bytes: Uint8Array): Promise<Record<string, string>> {
  return withPdf(bytes, (doc) => {
    const entry = doc.getTrailer().get('Root').get('AcroForm').resolve().get('XFA');
    const text = (stream: PDFObject) => new TextDecoder().decode(stream.readStream().asUint8Array());
    const xfa = entry.resolve();
    if (!xfa.isArray()) return { xdp: text(entry) };
    const out: Record<string, string> = {};
    for (let at = 0; at + 1 < xfa.length; at += 2) out[xfa.get(at).asString()] = text(xfa.get(at + 1));
    return out;
  });
}

/** Set widget values the way an editor that knows nothing of XFA does: straight into `/V`. */
export function editWidgets(bytes: Uint8Array, values: Record<string, string>): Promise<Uint8Array> {
  return withPdf(bytes, (doc) => {
    const annots = doc.findPage(0).get('Annots').resolve();
    for (let at = 0; at < annots.length; at += 1) {
      const widget = annots.get(at).resolve();
      const value = values[widget.get('T').asString()];
      if (value === undefined) continue;
      if (widget.get('FT').asName() === 'Btn') {
        widget.put('V', value);
        widget.put('AS', value);
      } else widget.put('V', doc.newString(value));
    }
    return new Uint8Array(doc.saveToBuffer('').asUint8Array());
  });
}

/** The text of the `datasets` packet of an array-layout form; fails the test when there is none. */
export async function datasetsOf(bytes: Uint8Array): Promise<string> {
  const datasets = (await xfaTexts(bytes)).datasets;
  if (datasets === undefined) throw new Error('the form has no datasets packet');
  return datasets;
}
