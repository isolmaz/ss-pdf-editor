/**
 * The two XMP facts PDF/UA asks for, as pure string functions: a `dc:title` and the
 * `pdfuaid:part` identifier.
 *
 * `metadata.ts` owns the full RDF scanner for the properties it edits; PDF/UA needs two
 * more properties in two more namespaces, and those are read and written here with the
 * narrowest edit that does the job — a property added to (or replaced inside) the **first**
 * `rdf:Description`, with everything else in the packet left byte for byte as it was. A
 * packet this module cannot find a description in is not edited: the caller builds a fresh
 * one and says so.
 *
 * ## Reading is textual on purpose
 *
 * There is no XML parser here. Both properties are found by pattern in either of the two
 * shapes RDF/XML allows (an attribute on the description, or a child element), which is
 * enough to answer "is it there, and what does it say" — and the report that uses this says
 * it read the packet that way.
 */

export const NS_DC = 'http://purl.org/dc/elements/1.1/';
export const NS_PDFUAID = 'http://www.aiim.org/pdfua/ns/id/';
const NS_RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body] ?? match;
  });
}

function escapeXml(value: string): string {
  let clean = '';
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    clean += char;
  }
  return clean
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The packet's `dc:title`, the `x-default` entry when there is one; `null` when absent or empty. */
export function readXmpTitle(packet: string): string | null {
  const attribute = /\bdc:title\s*=\s*"([^"]*)"/.exec(packet);
  if (attribute !== null) {
    const value = decodeEntities(attribute[1] as string).trim();
    return value === '' ? null : value;
  }
  const element = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/.exec(packet);
  if (element === null) return null;
  const inner = element[1] as string;
  const items = [...inner.matchAll(/<rdf:li\b([^>]*)>([\s\S]*?)<\/rdf:li>/g)];
  const preferred = items.find((item) => /xml:lang\s*=\s*"x-default"/.test(item[1] as string)) ?? items[0];
  const raw = preferred === undefined ? inner.replace(/<[^>]*>/g, '') : (preferred[2] as string);
  const value = decodeEntities(raw.replace(/<[^>]*>/g, '')).trim();
  return value === '' ? null : value;
}

/** The `pdfuaid:part` value (`1`, `2`), or `null` when the packet declares none. */
export function readUaPart(packet: string): number | null {
  const attribute = /\bpdfuaid:part\s*=\s*"\s*(\d+)\s*"/.exec(packet);
  if (attribute !== null) return Number(attribute[1]);
  const element = /<pdfuaid:part\b[^>]*>\s*(\d+)\s*<\/pdfuaid:part>/.exec(packet);
  return element === null ? null : Number(element[1]);
}

const FIRST_DESCRIPTION = /<rdf:Description\b([^>]*?)(\/?)>/;

interface DescriptionAt {
  readonly start: number;
  readonly openEnd: number;
  readonly selfClosing: boolean;
  readonly attributes: string;
}

function firstDescription(packet: string): DescriptionAt | null {
  const match = FIRST_DESCRIPTION.exec(packet);
  if (match === null) return null;
  return {
    start: match.index,
    openEnd: match.index + match[0].length,
    selfClosing: match[2] === '/',
    attributes: match[1] as string,
  };
}

/** A fresh packet carrying the given properties (used when the file has no `/Metadata`). */
export function buildUaPacket(properties: { readonly title?: string; readonly uaPart?: number }): string {
  const lines: string[] = [];
  if (properties.title !== undefined) {
    lines.push(
      '   <dc:title>',
      '    <rdf:Alt>',
      `     <rdf:li xml:lang="x-default">${escapeXml(properties.title)}</rdf:li>`,
      '    </rdf:Alt>',
      '   </dc:title>',
    );
  }
  if (properties.uaPart !== undefined)
    lines.push(`   <pdfuaid:part>${String(properties.uaPart)}</pdfuaid:part>`);
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ` <rdf:RDF xmlns:rdf="${NS_RDF}">`,
    `  <rdf:Description rdf:about="" xmlns:dc="${NS_DC}" xmlns:pdfuaid="${NS_PDFUAID}">`,
    ...lines,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
    '',
  ].join('\n');
}

/**
 * Put a `dc:title` and/or a `pdfuaid:part` into an existing packet. Returns the new packet,
 * or `null` when the packet has no `rdf:Description` to put them in (the caller then builds
 * a fresh packet and reports it). A `pdfuaid:part` that is already there is left as it is —
 * a file that declares part 2 is not rewritten into part 1 by a part-1 tool.
 */
export function editUaPacket(
  packet: string,
  properties: { readonly title?: string; readonly uaPart?: number },
): string | null {
  const description = firstDescription(packet);
  if (description === null) return null;
  let result = packet;

  const additions: string[] = [];
  const declarations: string[] = [];
  const declared = (prefix: string): boolean =>
    new RegExp(`xmlns:${prefix}\\s*=`).test(description.attributes);

  if (properties.title !== undefined) {
    const lang = `<rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(properties.title)}</rdf:li></rdf:Alt>`;
    const element = `<dc:title>${lang}</dc:title>`;
    const existing = /<dc:title\b[^>]*>[\s\S]*?<\/dc:title>|<dc:title\b[^>]*\/>/.exec(result);
    if (existing !== null) {
      result = result.slice(0, existing.index) + element + result.slice(existing.index + existing[0].length);
    } else if (/\bdc:title\s*=\s*"[^"]*"/.test(description.attributes)) {
      const escaped = escapeXml(properties.title);
      result = result.replace(
        /(\bdc:title\s*=\s*")[^"]*(")/,
        (_m, open: string, close: string) => `${open}${escaped}${close}`,
      );
    } else {
      additions.push(element);
      if (!declared('dc')) declarations.push(` xmlns:dc="${NS_DC}"`);
    }
  }
  if (properties.uaPart !== undefined && readUaPart(result) === null) {
    additions.push(`<pdfuaid:part>${String(properties.uaPart)}</pdfuaid:part>`);
    if (!declared('pdfuaid')) declarations.push(` xmlns:pdfuaid="${NS_PDFUAID}"`);
  }
  if (additions.length === 0 && declarations.length === 0) return result;

  // The description may have moved when the title was replaced above; find it again.
  const at = firstDescription(result);
  if (at === null) return null;
  const head = result.slice(at.start, at.openEnd - (at.selfClosing ? 2 : 1));
  const body = additions.join('\n   ');
  if (at.selfClosing) {
    const about = /rdf:about\s*=/.test(at.attributes) ? '' : ' rdf:about=""';
    return `${result.slice(0, at.start)}${head}${about}${declarations.join('')}>\n   ${body}\n  </rdf:Description>${result.slice(at.openEnd)}`;
  }
  const close = result.indexOf('</rdf:Description>', at.openEnd);
  if (close < 0) return null;
  return `${result.slice(0, at.start)}${head}${declarations.join('')}>${result.slice(at.openEnd, close)}   ${body}\n  ${result.slice(close)}`;
}
