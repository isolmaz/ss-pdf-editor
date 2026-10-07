/**
 * XFA packets in a PDF, on MuPDF's object model.
 *
 * An XFA form lives in `/AcroForm /XFA`: either an array of `(name) stream` pairs
 * (`preamble`, `config`, `template`, `datasets`, `postamble`, …) or one stream that holds
 * the whole XDP. This file reads and writes those packets and nothing else; what a
 * packet *means* is `xfa-data.ts`, and the operations built on both are `xfa-form.ts`.
 *
 * It is imported by `forms.ts` (a fill keeps a static form's data in step with its
 * widgets), so it must not import `forms.ts` back: the field list arrives as an argument.
 *
 * **Static or dynamic.** pdf.js decides the same way: a form with AcroForm fields is static
 * (the XFA is a second description of widgets that are already there); a form with none is
 * dynamic, and its pages are *only* the template — the PDF page is the "Please wait…"
 * placeholder an XFA-unaware reader shows.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { readText, resolved } from '../engines/mupdf-write';
import {
  dataElementOf,
  dataEntries,
  decodePacket,
  encodePacket,
  parseXml,
  planSync,
  resolveBindings,
  type SyncPlan,
  serializeNode,
  type XfaFieldSnapshot,
} from './xfa-data';

export type XfaKind = 'static' | 'dynamic';

export interface XfaPacketInfo {
  readonly name: string;
  readonly bytes: number;
}

export interface XfaInfo {
  readonly kind: XfaKind;
  /** `array` (`[(name) stream …]`) or `stream` (one XDP). */
  readonly layout: 'array' | 'stream';
  readonly packets: readonly XfaPacketInfo[];
  readonly hasTemplate: boolean;
  readonly hasDatasets: boolean;
  /** AcroForm fields other than signatures. */
  readonly fieldCount: number;
  /** The catalog's `/NeedsRendering`: the file asks the reader to render the form itself. */
  readonly needsRendering: boolean;
  /** Leaf values in the datasets. */
  readonly dataValues: number;
}

interface Located {
  readonly catalog: PDFObject;
  readonly acroForm: PDFObject;
  readonly xfa: PDFObject;
}

function locate(doc: PDFDocument): Located | null {
  const catalog = resolved(doc.getTrailer().get('Root'));
  if (catalog === null) return null;
  const acroForm = resolved(catalog.get('AcroForm'));
  if (acroForm === null || !acroForm.isDictionary()) return null;
  const entry = acroForm.get('XFA');
  if (entry.isNull()) return null;
  return { catalog, acroForm, xfa: entry };
}

function streamBytes(entry: PDFObject): Uint8Array | null {
  return entry.isStream() ? new Uint8Array(entry.readStream().asUint8Array()) : null;
}

interface PacketRead {
  readonly layout: 'array' | 'stream';
  readonly packets: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}

/** Every packet of the form, or `null` when the document has no XFA. */
export function readXfaPackets(doc: PDFDocument): PacketRead | null {
  const located = locate(doc);
  return located === null ? null : readPackets(located);
}

/** The packets of a located XFA entry: an array of name/stream pairs, or one XDP stream. */
function readPackets(located: Located): PacketRead | null {
  const { xfa } = located;
  const resolvedXfa = resolved(xfa);
  if (resolvedXfa?.isArray()) {
    const packets: { name: string; bytes: Uint8Array }[] = [];
    for (let index = 0; index + 1 < resolvedXfa.length; index += 2) {
      const name = readText(resolvedXfa.get(index));
      const bytes = streamBytes(resolvedXfa.get(index + 1));
      if (name !== null && bytes !== null) packets.push({ name, bytes });
    }
    return { layout: 'array', packets };
  }
  const whole = streamBytes(xfa);
  if (whole === null) return null;
  const document = parseXml(decodePacket(whole));
  if (document === null) return { layout: 'stream', packets: [] };
  const packets: { name: string; bytes: Uint8Array }[] = [];
  for (let node = document.documentElement.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    packets.push({
      name: element.localName,
      bytes: encodePacket(serializeNode(element)),
    });
  }
  return { layout: 'stream', packets };
}

/** One packet's text, or `null`. */
export function packetText(doc: PDFDocument, name: string): string | null {
  const packet = readXfaPackets(doc)?.packets.find((entry) => entry.name === name);
  return packet === undefined ? null : decodePacket(packet.bytes);
}

/** Summary of the form's XFA, or `null` when the document has none. */
export function describeXfa(doc: PDFDocument, snapshots: readonly XfaFieldSnapshot[]): XfaInfo | null {
  const located = locate(doc);
  if (located === null) return null;
  const read = readPackets(located);
  if (read === null) return null;
  const fieldCount = snapshots.filter((snapshot) => snapshot.kind !== 'signature').length;
  const datasets = read.packets.find((packet) => packet.name === 'datasets');
  const needs = resolved(located.catalog.get('NeedsRendering'));
  return {
    kind: fieldCount > 0 ? 'static' : 'dynamic',
    layout: read.layout,
    packets: read.packets.map((packet) => ({ name: packet.name, bytes: packet.bytes.byteLength })),
    hasTemplate: read.packets.some((packet) => packet.name === 'template'),
    hasDatasets: datasets !== undefined,
    fieldCount,
    needsRendering: needs?.isBoolean() === true && needs.asBoolean(),
    dataValues: datasets === undefined ? 0 : dataEntries(decodePacket(datasets.bytes)).length,
  };
}

const EMPTY_DATASETS =
  '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>';

/**
 * Replace the `datasets` packet with `xml`, creating it (after `template`, before
 * `postamble`) when the form has none. Both layouts.
 */
export function writeDatasets(doc: PDFDocument, xml: string): void {
  const located = locate(doc);
  if (located === null) throw new Error('the document has no XFA');
  const bytes = encodePacket(xml);
  const resolvedXfa = resolved(located.xfa);
  if (resolvedXfa?.isArray()) {
    for (let index = 0; index + 1 < resolvedXfa.length; index += 2) {
      if (readText(resolvedXfa.get(index)) !== 'datasets') continue;
      const entry = resolvedXfa.get(index + 1);
      if (entry.isStream()) {
        entry.writeStream(bytes);
        return;
      }
    }
    // No datasets packet: add one, keeping the packet order the specification gives
    // (the postamble stays last).
    const rebuilt = doc.newArray();
    const created = doc.addStream(bytes, doc.newDictionary());
    let inserted = false;
    for (let index = 0; index + 1 < resolvedXfa.length; index += 2) {
      const name = readText(resolvedXfa.get(index));
      if (name === 'postamble' && !inserted) {
        rebuilt.push(doc.newString('datasets'));
        rebuilt.push(created);
        inserted = true;
      }
      rebuilt.push(resolvedXfa.get(index));
      rebuilt.push(resolvedXfa.get(index + 1));
    }
    if (!inserted) {
      rebuilt.push(doc.newString('datasets'));
      rebuilt.push(created);
    }
    located.acroForm.put('XFA', rebuilt);
    return;
  }
  // One stream holding the whole XDP: swap the datasets element inside it.
  const whole = streamBytes(located.xfa);
  const document = whole === null ? null : parseXml(decodePacket(whole));
  const replacement = parseXml(xml);
  if (document === null || replacement === null) throw new Error('the XFA stream is not well-formed XML');
  const root = document.documentElement;
  const imported = document.importNode(replacement.documentElement, true);
  // The first datasets element: the one `readXfaPackets` (and so every reader here) takes.
  let existing: Element | null = null;
  for (let node = root.firstChild; node !== null && existing === null; node = node.nextSibling) {
    if (node.nodeType === 1 && (node as Element).localName === 'datasets') existing = node as Element;
  }
  if (existing === null) root.appendChild(imported);
  else root.replaceChild(imported, existing);
  located.xfa.writeStream(encodePacket(serializeNode(document)));
}

/**
 * Keep the datasets of a static form in step with its AcroForm fields.
 *
 * `only` limits the sync to the named fields (the ones a fill touched). Returns `null` when
 * the document has no XFA, otherwise the plan that was applied — `plan.xml === null` means
 * the data already agreed with the widgets and nothing was written.
 */
export function syncXfaInDocument(
  doc: PDFDocument,
  snapshots: readonly XfaFieldSnapshot[],
  only?: ReadonlySet<string>,
): SyncPlan | null {
  const read = readXfaPackets(doc);
  if (read === null) return null;
  const fields = snapshots.filter((snapshot) => snapshot.kind !== 'signature');
  if (fields.length === 0) return null;
  const template = read.packets.find((packet) => packet.name === 'template');
  const datasets = read.packets.find((packet) => packet.name === 'datasets');
  const bindings = resolveBindings(
    template === undefined ? null : decodePacket(template.bytes),
    fields.map((field) => ({ name: field.name, kind: field.kind })),
  );
  const plan = planSync(
    datasets === undefined ? EMPTY_DATASETS : decodePacket(datasets.bytes),
    bindings,
    fields,
    // A form with no data yet gets all of its widgets' values, not just the fill's: the
    // data is created here, and a field left out would show its template default.
    datasets === undefined ? undefined : only,
  );
  if (plan === null) return null;
  if (plan.xml !== null) writeDatasets(doc, plan.xml);
  return plan;
}

/**
 * Remove the XFA from the form: the AcroForm keeps every field and value, and a reader has
 * nothing but the AcroForm to use. The packets become unreferenced and the rewrite's
 * garbage pass drops them.
 */
export function removeXfaEntries(doc: PDFDocument): boolean {
  const located = locate(doc);
  if (located === null) return false;
  located.acroForm.delete('XFA');
  if (!located.catalog.get('NeedsRendering').isNull()) located.catalog.delete('NeedsRendering');
  return true;
}

/** The datasets of the document as text, or `null`. */
export function datasetsText(doc: PDFDocument): string | null {
  return packetText(doc, 'datasets');
}

/** Whether the datasets packet has an `xfa:data` element at all. */
export function hasDataElement(datasets: string): boolean {
  const document = parseXml(datasets);
  return document !== null && dataElementOf(document) !== null;
}
