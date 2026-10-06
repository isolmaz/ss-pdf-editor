/**
 * Document properties: Info and XMP (`REPORT.md §3` A11, defect: XMP absent).
 *
 * Written through MuPDF's object model (`engines/mupdf-write.ts`). The engine
 * edits Info but knows nothing about the XMP fields we own, so the packet is
 * built and parsed by our own small reader/writer — no dependency, DOM-free, and
 * it keeps the `/Metadata` stream a **single** well-formed packet.
 *
 * The producer line is product policy (`PLAN.md §2.1/6`): `clean` never removes
 * it, and every write merges `SsPdfEditor (MuPDF 1.28)` back in.
 *
 * Facts this file depends on:
 *  - Info values are written with `doc.newString` (PDFDocEncoding when it fits,
 *    UTF-16BE otherwise), which is why Turkish titles survive; keywords are
 *    joined with a **space** — the form pdf-lib's `setKeywords` wrote before the
 *    consolidation — so the reader accepts both comma and space separated lists.
 *  - Nothing here writes an XMP packet unless asked, so `/Metadata` is ours end
 *    to end and a document without one stays without one. The packet is added
 *    as a raw stream and MuPDF's `compress` leaves XML metadata uncompressed;
 *    `metadata.test.ts` holds that.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  openForWrite,
  PRODUCER_LINE,
  pdfDate,
  readText,
  resolved,
  saveRewrite,
  text,
} from '../engines/mupdf-write';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

export interface DocumentMetadata {
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: readonly string[];
  readonly creator?: string;
  readonly producer?: string;
  readonly creationDate?: string;
  readonly modificationDate?: string;
  /** Raw XMP packet when the document carries one. */
  readonly xmp?: string;
}

export interface MetadataPatch {
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: readonly string[];
  readonly creator?: string;
  readonly creationDate?: string;
  readonly modificationDate?: string;
  /** Also mirror the writable fields into an XMP packet. */
  readonly writeXmp: boolean;
}

/** The producer line every writer merges back in (`PLAN.md §2.1/6`); owned by the writer. */
export { PRODUCER_LINE };

export interface MetadataWriteOptions {
  readonly patch: MetadataPatch;
  /** Remove Info keys the patch does not mention. */
  readonly clean: boolean;
  readonly cleanXmp: boolean;
}

/* ------------------------------------------------------------------ *
 * XMP: a minimal, dependency-free RDF/XML scanner
 * ------------------------------------------------------------------ */

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  /** Bound by definition, never by an `xmlns:` declaration. */
  xml: 'http://www.w3.org/XML/1998/namespace',
} as const;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

interface XmpAttribute {
  readonly value: string;
  /** Span of the value inside the packet (quotes excluded) — the in-place edit target. */
  readonly valueStart: number;
  readonly valueEnd: number;
  /** False for a malformed `name` without `=`; such an attribute is never edited. */
  readonly hasValue: boolean;
}

interface XmpNode {
  readonly name: string;
  readonly prefix: string;
  readonly local: string;
  readonly attributes: ReadonlyMap<string, XmpAttribute>;
  readonly children: XmpNode[];
  /** Direct text (entities already decoded), concatenated between child elements. */
  text: string;
  /** Offsets into the packet: `[start, openEnd)` is the opening tag, `[start, end)` the element. */
  readonly start: number;
  readonly openEnd: number;
  /** Known only once the whole element has been scanned. */
  end: number;
  readonly selfClosing: boolean;
}

function codePointText(codePoint: number, fallback: string): string {
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  return String.fromCodePoint(codePoint);
}

/** `&amp;` / `&#252;` / `&#xFC;`; an unknown entity is kept verbatim, never invented. */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointText(Number.parseInt(body.slice(2), 16), match);
    }
    if (body.startsWith('#')) return codePointText(Number(body.slice(1)), match);
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * XML 1.0 cannot carry most C0 control characters: a title typed with one would
 * make the packet unparseable for every reader, so they are dropped on the way
 * out. Tab/newline/carriage return stay (they are legal).
 */
function sanitizeXmlText(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    result += char;
  }
  return result;
}

function escapeText(value: string): string {
  return sanitizeXmlText(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function scanName(packet: string, from: number): number {
  if (!/[A-Za-z_:]/.test(packet[from] ?? '')) return -1;
  let index = from + 1;
  while (index < packet.length && /[A-Za-z0-9_:.-]/.test(packet[index] as string)) index += 1;
  return index;
}

function scanAttributes(
  packet: string,
  from: number,
): { attributes: Map<string, XmpAttribute>; openEnd: number; selfClosing: boolean } {
  const attributes = new Map<string, XmpAttribute>();
  let index = from;
  let selfClosing = false;
  for (;;) {
    while (index < packet.length && /\s/.test(packet[index] as string)) index += 1;
    const char = packet[index];
    if (char === undefined) {
      selfClosing = true;
      break;
    }
    if (char === '/') {
      selfClosing = true;
      index += 1;
      continue;
    }
    if (char === '>') {
      index += 1;
      break;
    }
    const nameEnd = scanName(packet, index);
    if (nameEnd < 0) {
      // Malformed attribute list: the rest of the tag is consumed as opaque text
      // rather than throwing — a packet we cannot edit is reported, not fatal.
      const close = packet.indexOf('>', index);
      index = close < 0 ? packet.length : close + 1;
      break;
    }
    const name = packet.slice(index, nameEnd);
    let cursor = nameEnd;
    while (cursor < packet.length && /\s/.test(packet[cursor] as string)) cursor += 1;
    if (packet[cursor] !== '=') {
      attributes.set(name, { value: '', valueStart: cursor, valueEnd: cursor, hasValue: false });
      index = cursor;
      continue;
    }
    cursor += 1;
    while (cursor < packet.length && /\s/.test(packet[cursor] as string)) cursor += 1;
    const quote = packet[cursor];
    if (quote !== '"' && quote !== "'") {
      index = cursor;
      continue;
    }
    const close = packet.indexOf(quote, cursor + 1);
    const stop = close < 0 ? packet.length : close;
    attributes.set(name, {
      value: decodeEntities(packet.slice(cursor + 1, stop)),
      valueStart: cursor + 1,
      valueEnd: stop,
      hasValue: true,
    });
    index = close < 0 ? packet.length : close + 1;
  }
  return { attributes, openEnd: index, selfClosing };
}

/** Read one element starting at `at` (which must be `<`). */
function scanElement(packet: string, at: number): XmpNode | null {
  const nameEnd = scanName(packet, at + 1);
  if (nameEnd < 0) return null;
  const name = packet.slice(at + 1, nameEnd);
  const { attributes, openEnd, selfClosing } = scanAttributes(packet, nameEnd);
  const colon = name.indexOf(':');
  const node: XmpNode = {
    name,
    prefix: colon < 0 ? '' : name.slice(0, colon),
    local: colon < 0 ? name : name.slice(colon + 1),
    attributes,
    children: [],
    text: '',
    start: at,
    openEnd,
    end: openEnd,
    selfClosing,
  };
  if (selfClosing) return node;

  let position = openEnd;
  for (;;) {
    const next = packet.indexOf('<', position);
    if (next < 0) break;
    node.text += decodeEntities(packet.slice(position, next));
    if (packet.startsWith('</', next)) {
      const close = packet.indexOf('>', next);
      node.end = close < 0 ? packet.length : close + 1;
      return node;
    }
    if (packet.startsWith('<!--', next)) {
      const close = packet.indexOf('-->', next);
      position = close < 0 ? packet.length : close + 3;
      continue;
    }
    if (packet.startsWith('<![CDATA[', next)) {
      const close = packet.indexOf(']]>', next);
      if (close < 0) break;
      node.text += packet.slice(next + 9, close);
      position = close + 3;
      continue;
    }
    if (packet.startsWith('<?', next) || packet.startsWith('<!', next)) {
      const close = packet.indexOf('>', next);
      if (close < 0) break;
      position = close + 1;
      continue;
    }
    const child = scanElement(packet, next);
    if (child === null) {
      position = next + 1;
      continue;
    }
    node.children.push(child);
    position = child.end;
  }
  node.end = packet.length;
  return node;
}

/** First element in the packet, skipping `<?xpacket?>`, comments and the doctype. */
function parseXmp(packet: string): XmpNode | null {
  let index = packet.indexOf('<');
  while (index >= 0) {
    if (packet.startsWith('<?', index) || packet.startsWith('<!', index)) {
      const close = packet.indexOf('>', index);
      if (close < 0) return null;
      index = packet.indexOf('<', close + 1);
      continue;
    }
    return scanElement(packet, index);
  }
  return null;
}

function walk(node: XmpNode): XmpNode[] {
  const result: XmpNode[] = [node];
  for (const child of node.children) result.push(...walk(child));
  return result;
}

function collectNamespaces(root: XmpNode): Map<string, string> {
  const namespaces = new Map<string, string>([['xml', NS.xml]]);
  for (const node of walk(root)) {
    for (const [name, attribute] of node.attributes) {
      if (name === 'xmlns') namespaces.set('', attribute.value);
      else if (name.startsWith('xmlns:')) namespaces.set(name.slice(6), attribute.value);
    }
  }
  return namespaces;
}

/**
 * Prefixes are matched through their URI, so a packet from another producer that
 * spells Dublin Core with a different prefix, or uses a default namespace, is
 * still read.
 */
function attributeNamespace(prefix: string, namespaces: ReadonlyMap<string, string>): string | undefined {
  if (prefix === 'xml') return NS.xml;
  if (prefix === '') return namespaces.get('');
  return namespaces.get(prefix);
}

/** `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">…` — the default language wins. */
function readPropertyText(node: XmpNode): string {
  const items = walk(node).filter((candidate) => candidate.local === 'li');
  if (items.length === 0) return node.text.trim();
  const preferred = items.find((item) => (item.attributes.get('xml:lang')?.value ?? '') === 'x-default');
  return (preferred ?? (items[0] as XmpNode)).text.trim();
}

/** Value of one property, in either the attribute shorthand or the element form. */
function readProperty(
  root: XmpNode,
  namespaces: ReadonlyMap<string, string>,
  uri: string,
  local: string,
): string | undefined {
  for (const node of walk(root)) {
    for (const [name, attribute] of node.attributes) {
      const colon = name.indexOf(':');
      const prefix = colon < 0 ? '' : name.slice(0, colon);
      const attributeLocal = colon < 0 ? name : name.slice(colon + 1);
      if (prefix === 'xmlns' || name === 'xmlns') continue;
      if (attributeLocal !== local) continue;
      if (attributeNamespace(prefix, namespaces) !== uri) continue;
      return attribute.value;
    }
  }
  for (const node of walk(root)) {
    if (node.local !== local || node.selfClosing) continue;
    if (attributeNamespace(node.prefix, namespaces) !== uri) continue;
    return readPropertyText(node);
  }
  return undefined;
}

interface XmpFields {
  readonly title?: string | undefined;
  readonly author?: string | undefined;
  readonly subject?: string | undefined;
  readonly keywords?: string | undefined;
  readonly creator?: string | undefined;
  readonly createDate?: string | undefined;
  readonly modifyDate?: string | undefined;
}

/** The fields we own; everything else in the packet is left alone. */
function readXmpFields(packet: string): XmpFields {
  const root = parseXmp(packet);
  if (root === null) return {};
  const namespaces = collectNamespaces(root);
  return {
    title: readProperty(root, namespaces, NS.dc, 'title'),
    author: readProperty(root, namespaces, NS.dc, 'creator'),
    subject: readProperty(root, namespaces, NS.dc, 'description'),
    keywords: readProperty(root, namespaces, NS.pdf, 'Keywords'),
    creator: readProperty(root, namespaces, NS.xmp, 'CreatorTool'),
    createDate: readProperty(root, namespaces, NS.xmp, 'CreateDate'),
    modifyDate: readProperty(root, namespaces, NS.xmp, 'ModifyDate'),
  };
}

type PropertyKey =
  | 'title'
  | 'creator'
  | 'description'
  | 'keywords'
  | 'creatorTool'
  | 'createDate'
  | 'modifyDate'
  | 'producer';

interface PropertySpec {
  readonly prefix: 'dc' | 'xmp' | 'pdf';
  readonly local: string;
  /** `lang-alt` = `rdf:Alt` with `x-default`, `seq` = `rdf:Seq`, `text` = plain element. */
  readonly kind: 'text' | 'lang-alt' | 'seq';
}

const XMP_PROPERTIES: Readonly<Record<PropertyKey, PropertySpec>> = {
  title: { prefix: 'dc', local: 'title', kind: 'lang-alt' },
  creator: { prefix: 'dc', local: 'creator', kind: 'seq' },
  description: { prefix: 'dc', local: 'description', kind: 'lang-alt' },
  keywords: { prefix: 'pdf', local: 'Keywords', kind: 'text' },
  creatorTool: { prefix: 'xmp', local: 'CreatorTool', kind: 'text' },
  createDate: { prefix: 'xmp', local: 'CreateDate', kind: 'text' },
  modifyDate: { prefix: 'xmp', local: 'ModifyDate', kind: 'text' },
  producer: { prefix: 'pdf', local: 'Producer', kind: 'text' },
};

function propertyXml(key: PropertyKey, value: string, indent: string): string {
  const spec = XMP_PROPERTIES[key];
  const open = `${spec.prefix}:${spec.local}`;
  if (spec.kind === 'text') return `${indent}<${open}>${escapeText(value)}</${open}>`;
  const list = spec.kind === 'lang-alt' ? 'Alt' : 'Seq';
  const language = spec.kind === 'lang-alt' ? ' xml:lang="x-default"' : '';
  return (
    `${indent}<${open}>\n` +
    `${indent} <rdf:${list}>\n` +
    `${indent}  <rdf:li${language}>${escapeText(value)}</rdf:li>\n` +
    `${indent} </rdf:${list}>\n` +
    `${indent}</${open}>`
  );
}

/** A fresh packet with just our properties — used when the document has none. */
function buildXmpPacket(fields: ReadonlyMap<PropertyKey, string>): string {
  const body = [...fields].map(([key, value]) => propertyXml(key, value, '    ')).join('\n');
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${escapeAttribute(PRODUCER_LINE)}">`,
    ` <rdf:RDF xmlns:rdf="${NS.rdf}">`,
    `  <rdf:Description rdf:about="" xmlns:dc="${NS.dc}" xmlns:xmp="${NS.xmp}" xmlns:pdf="${NS.pdf}">`,
    body,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
    '',
  ].join('\n');
}

/** `xmlns:` declarations for prefixes the packet does not define yet. */
function missingDeclarations(namespaces: ReadonlyMap<string, string>, needed: Iterable<PropertyKey>): string {
  const prefixes = new Set<'dc' | 'xmp' | 'pdf'>();
  for (const key of needed) prefixes.add(XMP_PROPERTIES[key].prefix);
  let declarations = '';
  for (const prefix of prefixes) {
    if (namespaces.has(prefix)) continue;
    declarations += ` xmlns:${prefix}="${NS[prefix]}"`;
  }
  // Our new elements contain `rdf:li`/`rdf:Alt`; the wrapper usually declares it.
  if (!namespaces.has('rdf')) declarations += ` xmlns:rdf="${NS.rdf}"`;
  return declarations;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Merge our properties into an existing packet.
 *
 * Per property, in preference order: replace the value of the attribute
 * shorthand, replace the property element, or append a new element to the
 * description. Everything the packet carries that we do not own is left
 * byte-for-byte untouched, which is what makes "XMP preserved" a true report.
 *
 * A packet that binds one of our canonical prefixes to a *different* namespace
 * cannot be edited in place (redeclaring `xmlns:dc` inside the same tag is
 * invalid XML), so it is rebuilt from our fields and the caller reports it.
 */
function mergeXmpPacket(packet: string, fields: ReadonlyMap<PropertyKey, string>): string {
  const root = parseXmp(packet);
  if (root === null) return buildXmpPacket(fields);
  const namespaces = collectNamespaces(root);
  const description = walk(root).find((node) => node.local === 'Description');
  if (description === undefined) return buildXmpPacket(fields);

  const edits: Edit[] = [];
  const missing = new Map<PropertyKey, string>();
  for (const [key, value] of fields) {
    const spec = XMP_PROPERTIES[key];
    const uri = NS[spec.prefix];
    if (namespaces.has(spec.prefix) && namespaces.get(spec.prefix) !== uri) return buildXmpPacket(fields);

    const attribute = [...description.attributes].find(([name, candidate]) => {
      const colon = name.indexOf(':');
      const prefix = colon < 0 ? '' : name.slice(0, colon);
      const local = colon < 0 ? name : name.slice(colon + 1);
      if (prefix === 'xmlns' || name === 'xmlns') return false;
      return candidate.hasValue && local === spec.local && attributeNamespace(prefix, namespaces) === uri;
    });
    if (attribute !== undefined) {
      const target = attribute[1];
      edits.push({ start: target.valueStart, end: target.valueEnd, text: escapeAttribute(value) });
      continue;
    }

    const element = walk(description).find(
      (node) => node.local === spec.local && attributeNamespace(node.prefix, namespaces) === uri,
    );
    if (element !== undefined) {
      edits.push({ start: element.start, end: element.end, text: propertyXml(key, value, '').trimStart() });
      continue;
    }
    missing.set(key, value);
  }

  if (missing.size > 0) {
    const additions = [...missing].map(([key, value]) => propertyXml(key, value, '   ')).join('\n');
    const declarations = missingDeclarations(namespaces, missing.keys());
    if (description.selfClosing) {
      // `<rdf:Description … />` has no body to append to: give it one. XMP requires
      // `rdf:about`, so a producer that omitted it gets it here.
      const head = packet.slice(description.start, description.openEnd - 2);
      const about = description.attributes.has('rdf:about') ? '' : ' rdf:about=""';
      edits.push({
        start: description.start,
        end: description.openEnd,
        text: `${head}${about}${declarations}>\n${additions}\n  </rdf:Description>`,
      });
    } else {
      edits.push({ start: description.end, end: description.end, text: `\n${additions}` });
      if (declarations !== '') {
        edits.push({ start: description.openEnd - 1, end: description.openEnd - 1, text: declarations });
      }
    }
  }

  let result = packet;
  // Applied back to front so the offsets recorded during the scan stay valid.
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Info and the `/Metadata` stream
 * ------------------------------------------------------------------ */

/** The Info dictionary, or `null` when the trailer has none (reading must not create one). */
function infoDictionary(doc: PDFDocument): PDFObject | null {
  const existing = resolved(doc.getTrailer().get('Info'));
  return existing?.isDictionary() === true ? existing : null;
}

/** The Info dictionary a write edits, created and linked from the trailer when absent. */
function ensureInfoDictionary(doc: PDFDocument): PDFObject {
  const existing = infoDictionary(doc);
  if (existing !== null) return existing;
  const created = doc.addObject(doc.newDictionary());
  doc.getTrailer().put('Info', created);
  return resolved(created) ?? created;
}

/**
 * Read one Info key as text. A value that is not a string (a hand-written name, a
 * number) reads as absent rather than failing: a merely odd document must not
 * turn into a failed properties panel.
 */
function infoText(doc: PDFDocument, key: string): string | undefined {
  const value = readText(infoDictionary(doc)?.get(key));
  return value === null || value === '' ? undefined : value;
}

function catalog(doc: PDFDocument): PDFObject {
  const root = resolved(doc.getTrailer().get('Root'));
  // MuPDF repairs or refuses a file without a catalog on open, so this is an engine fault.
  if (root === null) throw new ToolError('internal', { engine: 'mupdf', engineMessage: 'no /Root' });
  return root;
}

/** The raw `/Metadata` packet, inflated when the stream is compressed. */
function readXmpStream(doc: PDFDocument): string | undefined {
  // Tested on the reference: a resolved stream is only its dictionary (`engines/mupdf-write.ts`).
  const object = catalog(doc).get('Metadata');
  // A `/Metadata` entry that is not a stream cannot be an XMP packet; treating it
  // as absent is the honest reading, not a swallowed error.
  if (object.isNull() || !object.isStream()) return undefined;
  return new TextDecoder().decode(object.readStream().asUint8Array());
}

/**
 * XMP travels as a plain (uncompressed) stream so readers that look for the
 * packet without inflating the object — and validators — find it as written.
 */
function writeXmp(doc: PDFDocument, packet: string | null): void {
  const root = catalog(doc);
  if (packet === null) {
    root.delete('Metadata');
    return;
  }
  const stream = doc.addRawStream(new TextEncoder().encode(packet), { Type: 'Metadata', Subtype: 'XML' });
  root.put('Metadata', stream);
}

/**
 * Keyword lists arrive comma separated from our own dialog and space separated
 * from Info (`writeMetadata` joins with a space, as pdf-lib did); both are read back.
 */
function splitKeywords(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const parts = (/[,;]/.test(value) ? value.split(/[,;]/) : value.split(/\s+/))
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts;
}

/** Read Info + XMP without modifying anything (the properties panel's first render). */
export async function readMetadata(bytes: Uint8Array): Promise<DocumentMetadata> {
  const { doc } = await openForWrite(bytes);
  let xmp: string | undefined;
  let info: DocumentMetadata;
  try {
    xmp = readXmpStream(doc);
    info = readInfoValues(doc);
  } catch (error) {
    throw mapMupdfError(error, 'read metadata');
  } finally {
    doc.destroy();
  }
  const xmpFields = xmp === undefined ? {} : readXmpFields(xmp);
  return {
    ...info,
    title: info.title ?? xmpFields.title,
    author: info.author ?? xmpFields.author,
    subject: info.subject ?? xmpFields.subject,
    keywords: info.keywords ?? splitKeywords(xmpFields.keywords),
    creator: info.creator ?? xmpFields.creator,
    creationDate: info.creationDate ?? xmpFields.createDate,
    modificationDate: info.modificationDate ?? xmpFields.modifyDate,
    ...(xmp === undefined ? {} : { xmp }),
  };
}

const PDF_DATE = /^D:\d{4}/;

/** All Info keys as plain strings; `undefined` where the document has nothing. */
function readInfoValues(doc: PDFDocument): DocumentMetadata {
  return {
    title: infoText(doc, 'Title'),
    author: infoText(doc, 'Author'),
    subject: infoText(doc, 'Subject'),
    keywords: splitKeywords(infoText(doc, 'Keywords')),
    creator: infoText(doc, 'Creator'),
    producer: infoText(doc, 'Producer'),
    creationDate: infoText(doc, 'CreationDate'),
    modificationDate: infoText(doc, 'ModDate'),
  };
}

/** `D:YYYYMMDDHHmmSSZ` → ISO, for the round trip through a `Date`. */
function isoFromPdfDate(value: string): string {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value.trim());
  if (match === null) return value;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

/**
 * The dialog can hand us either form: an existing PDF date string is kept
 * verbatim (its exact form is part of the document), anything else has to parse
 * as a date — rejected loudly, never silently replaced with "now".
 */
function parseDateOrThrow(value: string, field: string): Date {
  const date = new Date(PDF_DATE.test(value.trim()) ? isoFromPdfDate(value.trim()) : value);
  if (Number.isNaN(date.getTime())) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `${field} is not a date`,
      path: value,
    });
  }
  return date;
}

/** XMP dates are ISO 8601 in UTC; a PDF date string is converted, other text is passed through. */
function toXmpDate(value: string): string {
  return PDF_DATE.test(value.trim()) ? isoFromPdfDate(value.trim()) : value;
}

export async function writeMetadata(
  bytes: Uint8Array,
  options: MetadataWriteOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  context.onProgress?.({ phase: 'metadata', labelKey: 'op.progress.metadata', done: 0, total: 1 });

  const { patch, clean, cleanXmp } = options;
  // Dates are checked before the engine is touched: a bad one is the caller's input error.
  const creationDate =
    patch.creationDate === undefined ? undefined : parseDateOrThrow(patch.creationDate, 'creationDate');
  const modificationDate =
    patch.modificationDate === undefined
      ? undefined
      : parseDateOrThrow(patch.modificationDate, 'modificationDate');

  const fields = new Map<PropertyKey, string>();
  if (patch.title !== undefined) fields.set('title', patch.title);
  if (patch.author !== undefined) fields.set('creator', patch.author);
  if (patch.subject !== undefined) fields.set('description', patch.subject);
  if (patch.keywords !== undefined) fields.set('keywords', patch.keywords.join(', '));
  if (patch.creator !== undefined) fields.set('creatorTool', patch.creator);
  if (patch.creationDate !== undefined) fields.set('createDate', toXmpDate(patch.creationDate));
  if (patch.modificationDate !== undefined) fields.set('modifyDate', toXmpDate(patch.modificationDate));
  fields.set('producer', PRODUCER_LINE);

  const { doc } = await openForWrite(bytes);
  const notes: OperationNote[] = [];
  const steps: string[] = ['load', 'metadata'];
  let out: Uint8Array;
  let pageCount: number;
  try {
    try {
      if (clean) {
        const info = ensureInfoDictionary(doc);
        const keys: string[] = [];
        info.forEach((_value, key) => {
          if (typeof key === 'string') keys.push(key);
        });
        // Everything but the producer line: that one is product policy, not user data.
        for (const key of keys) if (key !== 'Producer') info.delete(key);
        notes.push(note('lost', 'op.note.metadata.infoDropped'));
      }

      const values: readonly (readonly [string, string | undefined])[] = [
        ['Title', patch.title],
        ['Author', patch.author],
        ['Subject', patch.subject],
        ['Keywords', patch.keywords?.join(' ')],
        ['Creator', patch.creator],
        ['CreationDate', creationDate === undefined ? undefined : pdfDate(creationDate)],
        ['ModDate', modificationDate === undefined ? undefined : pdfDate(modificationDate)],
      ];
      for (const [key, value] of values) {
        if (value !== undefined) ensureInfoDictionary(doc).put(key, text(doc, value));
      }

      // `saveRewrite` sets the producer line; the step is declared here, where the policy is.
      steps.push('producer');
      notes.push(note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE }));

      let xmpTouched = false;
      if (cleanXmp) {
        writeXmp(doc, null);
        xmpTouched = true;
        notes.push(note('lost', 'op.note.metadata.xmpDropped'));
        if (patch.writeXmp) {
          writeXmp(doc, buildXmpPacket(fields));
          notes.push(note('changed', 'op.note.metadata.xmpCreated'));
        }
      } else if (patch.writeXmp) {
        const existing = readXmpStream(doc);
        const packet = existing === undefined ? buildXmpPacket(fields) : mergeXmpPacket(existing, fields);
        writeXmp(doc, packet);
        xmpTouched = true;
        notes.push(
          existing === undefined
            ? note('changed', 'op.note.metadata.xmpCreated')
            : note('preserved', 'op.note.metadata.xmpMerged'),
        );
      } else {
        notes.push(note('preserved', 'op.note.metadata.xmpUntouched'));
      }
      if (xmpTouched) steps.push('xmp');
      pageCount = doc.countPages();
    } catch (error) {
      throw mapMupdfError(error, 'write metadata');
    }

    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'write metadata');
  } finally {
    doc.destroy();
  }
  steps.push('save');
  context.onProgress?.({ phase: 'metadata', labelKey: 'op.progress.metadata', done: 1, total: 1 });

  const report: OperationReport = {
    engine: 'mupdf',
    steps,
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount,
    // Re-serialised: the incremental fast path is over (`PLAN.md §3.3` rule 3).
    incremental: false,
  };
  return { bytes: out, report };
}
