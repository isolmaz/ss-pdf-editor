/**
 * The XMP packet, read for the PDF/A checker (`ops/pdfa-check.ts`).
 *
 * PDF/A is largely a statement about the document's XMP: the `pdfaid` schema says which
 * part and conformance the file claims, every property has to belong to a schema the standard
 * predefines or one the packet itself describes (an extension schema), and the Document
 * Information dictionary has to agree with what the packet says. This module reads those
 * three things and nothing else; it does not validate value types, which the checker lists
 * among the rules it did not run.
 *
 * The packet is parsed with the XML parser the OOXML reader already uses. A packet that is
 * not well-formed XML is reported as such rather than guessed at.
 */

import { DOMParser } from '@xmldom/xmldom';

export const NS_PDFAID = 'http://www.aiim.org/pdfa/ns/id/';
const NS_RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const NS_XMLNS = 'http://www.w3.org/2000/xmlns/';
const NS_XML = 'http://www.w3.org/XML/1998/namespace';
const NS_PDFA_EXTENSION = 'http://www.aiim.org/pdfa/ns/extension/';
const NS_PDFA_SCHEMA = 'http://www.aiim.org/pdfa/ns/schema#';
const NS_PDFA_PROPERTY = 'http://www.aiim.org/pdfa/ns/property#';
const NS_PDFA_TYPE = 'http://www.aiim.org/pdfa/ns/type#';
const NS_PDFA_FIELD = 'http://www.aiim.org/pdfa/ns/field#';

export const NS_DC = 'http://purl.org/dc/elements/1.1/';
export const NS_XMP = 'http://ns.adobe.com/xap/1.0/';
export const NS_PDF = 'http://ns.adobe.com/pdf/1.3/';

/**
 * Namespaces whose properties a PDF/A file may use without describing them: the schemas
 * ISO 19005 predefines (Dublin Core, XMP basic, rights, media management, Adobe PDF, the
 * job ticket, paged text, Photoshop, TIFF and Exif) plus the PDF/A schemas themselves.
 */
const PREDEFINED_NAMESPACES: ReadonlySet<string> = new Set([
  NS_DC,
  NS_XMP,
  NS_PDF,
  'http://ns.adobe.com/xap/1.0/mm/',
  'http://ns.adobe.com/xap/1.0/rights/',
  'http://ns.adobe.com/xap/1.0/bj/',
  'http://ns.adobe.com/xap/1.0/t/pg/',
  'http://ns.adobe.com/xap/1.0/g/',
  'http://ns.adobe.com/photoshop/1.0/',
  'http://ns.adobe.com/tiff/1.0/',
  'http://ns.adobe.com/exif/1.0/',
  'http://ns.adobe.com/xmp/1.0/DynamicMedia/',
  NS_PDFAID,
  NS_PDFA_EXTENSION,
  NS_PDFA_SCHEMA,
  NS_PDFA_PROPERTY,
  NS_PDFA_TYPE,
  NS_PDFA_FIELD,
  NS_RDF,
  NS_XML,
]);

/** Namespaces that are packet machinery, never properties (`x:xmpmeta`, `xmlns`). */
const MACHINERY_NAMESPACES: ReadonlySet<string> = new Set([NS_XMLNS, 'adobe:ns:meta/']);

export interface XmpClaim {
  /** `pdfaid:part` exactly as written, or `null` when the packet has none. */
  readonly part: string | null;
  /** `pdfaid:conformance` exactly as written, or `null`. */
  readonly conformance: string | null;
}

export interface XmpPacket {
  /** The packet could be read as XML. */
  readonly wellFormed: boolean;
  readonly claim: XmpClaim;
  /** Namespaces some property uses that no predefined or extension schema covers. */
  readonly undescribedNamespaces: readonly string[];
  /** Every `rdf:Description` property value, by `namespace + local name`. */
  readonly properties: ReadonlyMap<string, readonly string[]>;
}

const EMPTY_CLAIM: XmpClaim = { part: null, conformance: null };

/** The packet's text: BOM and `xpacket` instructions are tolerated, as XMP allows. */
function decodePacket(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.replace(/^﻿/, '');
}

function elementChildren(node: Node): Element[] {
  const out: Element[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1) out.push(child as Element);
  }
  return out;
}

/** An element's trimmed text (`textContent` is only `null` on a document or a doctype). */
function textOf(element: Element): string {
  return (element.textContent as string).trim();
}

/** The text values a property carries: a leaf's text, or the `rdf:li` items of a Bag/Seq/Alt. */
function valuesOf(element: Element): string[] {
  const containers = elementChildren(element).filter(
    (child) => child.namespaceURI === NS_RDF && ['Bag', 'Seq', 'Alt'].includes(child.localName),
  );
  if (containers.length > 0) {
    const out: string[] = [];
    for (const container of containers) {
      for (const item of elementChildren(container)) {
        if (item.localName === 'li') out.push(textOf(item));
      }
    }
    return out;
  }
  return [textOf(element)];
}

/** Every attribute on `element` that is a property (not `xmlns`, `rdf:about` or `xml:*`). */
function propertyAttributes(element: Element): { ns: string; local: string; value: string }[] {
  const out: { ns: string; local: string; value: string }[] = [];
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    // `index` is below `length`: `item` cannot answer `null` here.
    const attribute = attributes.item(index) as Attr;
    const ns = attribute.namespaceURI;
    // The parser answers `undefined` (not `null`) for an attribute without a namespace.
    if (!ns || ns === NS_XMLNS || ns === NS_XML || ns === NS_RDF) continue;
    out.push({ ns, local: attribute.localName, value: attribute.value });
  }
  return out;
}

/** Namespaces the packet's extension schemas declare (`pdfaSchema:namespaceURI`). */
function describedNamespaces(root: Element): Set<string> {
  const described = new Set<string>();
  // Iterative: a packet nested deeper than the call stack must not be able to crash the reader.
  const pending: Element[] = [root];
  for (let element = pending.pop(); element !== undefined; element = pending.pop()) {
    if (element.namespaceURI === NS_PDFA_SCHEMA && element.localName === 'namespaceURI') {
      const value = textOf(element);
      if (value !== '') described.add(value);
    }
    for (const attribute of propertyAttributes(element)) {
      if (attribute.ns === NS_PDFA_SCHEMA && attribute.local === 'namespaceURI' && attribute.value !== '') {
        described.add(attribute.value.trim());
      }
    }
    for (const child of elementChildren(element)) pending.push(child);
  }
  return described;
}

/** Parse a metadata stream. Never throws: a broken packet is `wellFormed: false`. */
export function parseXmp(bytes: Uint8Array): XmpPacket {
  const broken: XmpPacket = {
    wellFormed: false,
    claim: EMPTY_CLAIM,
    undescribedNamespaces: [],
    properties: new Map(),
  };
  let failed = false;
  // xmldom returns `undefined` for an empty string rather than a document.
  let document: Document | undefined;
  try {
    const parser = new DOMParser({
      errorHandler: {
        // xmldom reports a closing tag that does not match its opening tag only as a warning
        // ("unclosed xml attribute") and goes on; a packet that triggers one is not well-formed.
        warning: () => {
          failed = true;
        },
        error: () => {
          failed = true;
        },
        fatalError: () => {
          failed = true;
        },
      },
    });
    document = parser.parseFromString(decodePacket(bytes), 'text/xml') as unknown as Document;
  } catch {
    return broken;
  }
  const root = document?.documentElement;
  if (failed || root === null || root === undefined) return broken;

  const descriptions: Element[] = [];
  // Document order, iteratively (see `describedNamespaces`): children go on the stack reversed.
  const pending: Element[] = [root];
  for (let element = pending.pop(); element !== undefined; element = pending.pop()) {
    if (element.namespaceURI === NS_RDF && element.localName === 'Description') {
      descriptions.push(element);
      continue;
    }
    const children = elementChildren(element);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index] as Element);
  }

  const properties = new Map<string, string[]>();
  const used = new Set<string>();
  const add = (ns: string, local: string, values: string[]): void => {
    if (MACHINERY_NAMESPACES.has(ns)) return;
    used.add(ns);
    const key = `${ns}${local}`;
    properties.set(key, [...(properties.get(key) ?? []), ...values]);
  };
  for (const description of descriptions) {
    for (const attribute of propertyAttributes(description))
      add(attribute.ns, attribute.local, [attribute.value]);
    for (const child of elementChildren(description)) {
      if (child.namespaceURI === null || child.namespaceURI === undefined) continue;
      add(child.namespaceURI, child.localName, valuesOf(child));
    }
  }

  const described = describedNamespaces(root);
  const undescribed = [...used].filter((ns) => !PREDEFINED_NAMESPACES.has(ns) && !described.has(ns)).sort();
  const first = (local: string): string | null => properties.get(`${NS_PDFAID}${local}`)?.[0] ?? null;
  return {
    wellFormed: true,
    claim: { part: first('part'), conformance: first('conformance') },
    undescribedNamespaces: undescribed,
    properties,
  };
}

/** One text property of the packet (`dc:title`'s default-language entry, `pdf:Producer`). */
export function xmpText(packet: XmpPacket, ns: string, local: string): string | null {
  const values = packet.properties.get(`${ns}${local}`);
  return values === undefined || values.length === 0 ? null : (values[0] as string);
}

/** A list property (`dc:creator`) as its items. */
export function xmpList(packet: XmpPacket, ns: string, local: string): readonly string[] | null {
  return packet.properties.get(`${ns}${local}`) ?? null;
}
