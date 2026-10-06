/**
 * Audit helpers for spike #4 (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * Three independent evidence channels, deliberately kept apart:
 *  1. **Raw bytes** — the token as it literally sits in the file, in every
 *     encoding a writer realistically uses: ASCII/UTF-8, ASCII written as a PDF
 *     hex string (`<47495a…>`, how pdf-lib and the spike fixtures encode standard-font text),
 *     UTF-16LE/BE raw and UTF-16 hex strings. Plus revision markers (`/Prev`,
 *     `startxref`, `%%EOF`).
 *  2. **Decoded objects** — every indirect object's *decoded* stream contents and
 *     the `/Info` dictionary, so Flate-compressed content streams, XMP packets and
 *     attachment payloads are searched even though their bytes are not literal in
 *     the file. Each hit is classified (page content / XMP / attachment / other).
 *  3. **pdf.js** — text of every page, Info, XMP and attachments as an
 *     independent reader sees them.
 */
import * as pdfjs from 'pdfjs-dist';
import type { Mupdf, PdfDoc } from './engine';

pdfjs.GlobalWorkerOptions.workerSrc = '/engines/pdfjs/pdf.worker.mjs';

const PDFJS_ASSET_OPTIONS = {
  cMapUrl: '/engines/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/engines/pdfjs/standard_fonts/',
  wasmUrl: '/engines/pdfjs/wasm/',
} as const;

/* --------------------------------------------------------------- encodings */

/** The token byte patterns a real file can carry. */
export interface TokenEncodings {
  readonly ascii: Uint8Array;
  /** `47495a4c…` — a PDF hex string of the ASCII bytes (fixture and pdf-lib text). */
  readonly asciiHexUpper: Uint8Array;
  readonly asciiHexLower: Uint8Array;
  /** UTF-16 with a BOM-less byte order, as pdf-lib and Acrobat write Info. */
  readonly utf16be: Uint8Array;
  readonly utf16le: Uint8Array;
  /** The same UTF-16 bytes written as a PDF hex string (`<004700 49…>`). */
  readonly utf16beHex: Uint8Array;
  readonly utf16leHex: Uint8Array;
}

export interface TokenHits {
  readonly ascii: number;
  readonly asciiHexUpper: number;
  readonly asciiHexLower: number;
  readonly utf16be: number;
  readonly utf16le: number;
  readonly utf16beHex: number;
  readonly utf16leHex: number;
  readonly total: number;
}

function utf16Bytes(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i * 2] = littleEndian ? code & 0xff : code >> 8;
    out[i * 2 + 1] = littleEndian ? code >> 8 : code & 0xff;
  }
  return out;
}

function hexOf(bytes: Uint8Array, upper: boolean): Uint8Array {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return new TextEncoder().encode(upper ? hex.toUpperCase() : hex);
}

export function tokenEncodings(token: string): TokenEncodings {
  const ascii = new TextEncoder().encode(token);
  const utf16be = utf16Bytes(token, false);
  const utf16le = utf16Bytes(token, true);
  return {
    ascii,
    asciiHexUpper: hexOf(ascii, true),
    asciiHexLower: hexOf(ascii, false),
    utf16be,
    utf16le,
    utf16beHex: hexOf(utf16be, true),
    utf16leHex: hexOf(utf16le, true),
  };
}

export function countBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return 0;
  let count = 0;
  const last = haystack.length - needle.length;
  for (let i = 0; i <= last; i += 1) {
    if (haystack[i] !== needle[0]) continue;
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j += 1;
    if (j === needle.length) count += 1;
  }
  return count;
}

export function countEncodings(haystack: Uint8Array, encodings: TokenEncodings): TokenHits {
  const ascii = countBytes(haystack, encodings.ascii);
  const asciiHexUpper = countBytes(haystack, encodings.asciiHexUpper);
  const asciiHexLower = countBytes(haystack, encodings.asciiHexLower);
  const utf16be = countBytes(haystack, encodings.utf16be);
  const utf16le = countBytes(haystack, encodings.utf16le);
  const utf16beHex = countBytes(haystack, encodings.utf16beHex);
  const utf16leHex = countBytes(haystack, encodings.utf16leHex);
  return {
    ascii,
    asciiHexUpper,
    asciiHexLower,
    utf16be,
    utf16le,
    utf16beHex,
    utf16leHex,
    total: ascii + asciiHexUpper + asciiHexLower + utf16be + utf16le + utf16beHex + utf16leHex,
  };
}

/* ------------------------------------------------------------------ raw scan */

/** Revision/identification markers: **counted occurrences**, not booleans. */
export interface RevisionMarkers {
  /** `/Prev` entries — one per earlier revision the file still chains to. */
  readonly prev: number;
  /** `startxref` — one per revision in the file. */
  readonly startxref: number;
  readonly eof: number;
  readonly trailer: number;
  /** Object streams present (they hide objects from a naive byte scan). */
  readonly objStm: number;
  readonly encrypt: number;
}

export interface RawScan {
  readonly hits: TokenHits;
  readonly markers: RevisionMarkers;
}

export function scanRaw(bytes: Uint8Array, encodings: TokenEncodings): RawScan {
  const marker = (text: string) => countBytes(bytes, new TextEncoder().encode(text));
  return {
    hits: countEncodings(bytes, encodings),
    markers: {
      prev: marker('/Prev'),
      startxref: marker('startxref'),
      eof: marker('%%EOF'),
      trailer: marker('trailer'),
      objStm: marker('/ObjStm'),
      encrypt: marker('/Encrypt'),
    },
  };
}

/* ------------------------------------------------------------- object level */

/** Where a token-bearing object sits in the document's structure. */
export type TokenObjectKind = 'page-content' | 'xmp' | 'attachment' | 'info' | 'other';

export interface TokenObject {
  readonly number: number;
  readonly kind: TokenObjectKind;
  readonly page: number | null;
  readonly hits: number;
  /** First 120 decoded characters around the hit — the proof, human-readable. */
  readonly context: string;
}

export interface ObjectInventory {
  readonly countObjects: number;
  readonly nullObjects: number;
  readonly dictionaries: number;
  readonly streams: number;
  readonly pageCount: number;
  readonly trailerKeys: string[];
  /** Object numbers of every page's `/Contents`, in page order. */
  readonly pageContentRefs: number[][];
  /** Catalog `/Metadata` object number, when present. */
  readonly xmpRef: number | null;
  /** Trailer `/Info` object number, when present. */
  readonly infoRef: number | null;
  /** `/Info` dictionary, as text, with the token hits counted inside it. */
  readonly infoDigest: string;
  readonly infoTokenHits: number;
  /** Decoded stream objects carrying the token, classified. */
  readonly tokenObjects: TokenObject[];
  readonly decodedStreamBytes: number;
  readonly undecodableStreams: number;
}

function contextAround(text: string, token: string): string {
  let hexText = '';
  for (const byte of hexOf(new TextEncoder().encode(token), true)) hexText += String.fromCharCode(byte);
  const index = text.includes(token) ? text.indexOf(token) : text.indexOf(hexText);
  if (index < 0) return '';
  return text
    .slice(Math.max(0, index - 60), index + token.length + 60)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function inspectObjects(doc: PdfDoc, token: string): ObjectInventory {
  const encodings = tokenEncodings(token);
  const countObjects = doc.countObjects();

  // Structure first, so every hit can be classified.
  const pageContentRefs: number[][] = [];
  for (let page = 0; page < doc.countPages(); page += 1) {
    pageContentRefs.push(contentRefs(doc, page));
  }
  const catalog = doc.getTrailer().get('Root').resolve();
  const metadataObject = catalog.isNull() ? null : catalog.get('Metadata');
  const metadataRef = metadataObject?.isIndirect() ? metadataObject.asIndirect() : null;
  const infoObject = doc.getTrailer().get('Info');
  const infoRef = infoObject.isIndirect() ? infoObject.asIndirect() : null;
  let infoDigest = 'none';
  let infoTokenHits = 0;
  if (!infoObject.isNull()) {
    infoDigest = infoObject.toString(true).slice(0, 600);
    // Object-level Info check: read the string *values*, not the serialization.
    infoObject.resolve().forEach((value: unknown, key: string | number) => {
      if (typeof key !== 'string') return;
      if (typeof value !== 'object' || value === null || !('asString' in value)) return;
      if (typeof value.asString !== 'function') return;
      const text: unknown = value.asString();
      if (typeof text === 'string' && text.includes(token)) infoTokenHits += 1;
    });
  }

  let nullObjects = 0;
  let dictionaries = 0;
  let streams = 0;
  let decodedStreamBytes = 0;
  let undecodableStreams = 0;
  const tokenObjects: TokenObject[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });

  for (let number = 1; number < countObjects; number += 1) {
    const object = doc.newIndirect(number);
    if (object.isNull()) {
      nullObjects += 1;
      continue;
    }
    if (object.isDictionary()) dictionaries += 1;
    if (!object.isStream()) continue;
    streams += 1;
    const typeObject = object.get('Type');
    const typeName = typeObject.isName() ? typeObject.asName() : null;
    let decoded: Uint8Array;
    try {
      const buffer = object.readStream();
      decoded = new Uint8Array(buffer.asUint8Array());
      buffer.destroy();
    } catch {
      undecodableStreams += 1;
      continue;
    }
    decodedStreamBytes += decoded.length;
    const hits = countEncodings(decoded, encodings).total;
    if (hits === 0) continue;
    const text = decoder.decode(decoded);
    const page = pageContentRefs.findIndex((refs) => refs.includes(number));
    let kind: TokenObjectKind = 'other';
    if (number === metadataRef) kind = 'xmp';
    else if (typeName === 'EmbeddedFile') kind = 'attachment';
    else if (page >= 0) kind = 'page-content';
    tokenObjects.push({
      number,
      kind,
      page: page >= 0 ? page + 1 : null,
      hits,
      context: contextAround(text, token),
    });
  }

  const trailer = doc.getTrailer();
  const trailerKeys: string[] = [];
  if (!trailer.isNull()) {
    trailer.forEach((_value: unknown, key: string | number) => {
      trailerKeys.push(typeof key === 'string' ? key : String(key));
    });
  }
  trailerKeys.sort();

  return {
    countObjects,
    nullObjects,
    dictionaries,
    streams,
    pageCount: doc.countPages(),
    trailerKeys,
    pageContentRefs,
    xmpRef: metadataRef,
    infoRef,
    infoDigest,
    infoTokenHits,
    tokenObjects,
    decodedStreamBytes,
    undecodableStreams,
  };
}

/**
 * `/Contents` of a page as xref object numbers. `get("Contents")` already
 * resolves through the indirect reference, so the *elements* of a content array
 * are checked for indirectness without calling `resolve()` on them (MuPDF marks
 * a resolved reference as no longer indirect, which would lose the number).
 */
export function contentRefs(doc: PdfDoc, pageIndex: number): number[] {
  const refs: number[] = [];
  const page = doc.findPage(pageIndex);
  if (page.isNull()) return refs;
  const contents = page.get('Contents');
  if (contents.isArray()) {
    for (let i = 0; i < contents.length; i += 1) {
      const element = contents.get(i);
      if (element.isIndirect()) refs.push(element.asIndirect());
    }
  } else if (contents.isIndirect()) {
    refs.push(contents.asIndirect());
  }
  return refs;
}

/** Do the given object numbers still exist in a document, and as what? */
export function objectStatus(doc: PdfDoc, numbers: number[]): Array<{ number: number; status: string }> {
  const status = (number: number) => {
    const object = doc.newIndirect(number);
    if (object.isNull()) return 'freed/null';
    if (object.isStream()) return 'stream';
    if (object.isDictionary()) return 'dictionary';
    return 'other';
  };
  return numbers.map((number) => ({ number, status: status(number) }));
}

/** Decoded text of the objects named — small, readable proof of erasure. */
export function objectTexts(
  doc: PdfDoc,
  numbers: number[],
  limit = 300,
): Array<{ number: number; text: string }> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const out: Array<{ number: number; text: string }> = [];
  for (const number of numbers) {
    const object = doc.newIndirect(number);
    if (object.isNull() || !object.isStream()) {
      out.push({ number, text: '<not a stream>' });
      continue;
    }
    try {
      const buffer = object.readStream();
      const decoded = new Uint8Array(buffer.asUint8Array());
      buffer.destroy();
      out.push({ number, text: decoder.decode(decoded).replace(/\s+/g, ' ').slice(0, limit) });
    } catch (error) {
      out.push({ number, text: `<undecodable: ${error instanceof Error ? error.message : String(error)}>` });
    }
  }
  return out;
}

/** MuPDF's own metadata view (`getMetaData`), used for the Info fields. */
export function metadataView(doc: PdfDoc, mupdf: Mupdf): Record<string, string | null> {
  const keys = [
    'META_FORMAT',
    'META_INFO_TITLE',
    'META_INFO_AUTHOR',
    'META_INFO_SUBJECT',
    'META_INFO_KEYWORDS',
    'META_INFO_CREATOR',
    'META_INFO_PRODUCER',
    'META_INFO_CREATIONDATE',
    'META_INFO_MODIFICATIONDATE',
    'META_ENCRYPTION',
  ] as const;
  const out: Record<string, string | null> = {};
  for (const key of keys) {
    try {
      out[key] = doc.getMetaData(mupdf.Document[key]) ?? null;
    } catch (error) {
      out[key] = `<error: ${error instanceof Error ? error.message : String(error)}>`;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ pdf.js */

export interface PdfjsPageReport {
  readonly page: number;
  readonly occurrences: number;
  readonly text: string;
}

export interface PdfjsAttachmentReport {
  readonly key: string;
  readonly filename: string;
  readonly bytes: number;
  /** `-1` means pdf.js could not produce the payload at all. */
  readonly occurrences: number;
  readonly contentPrefix: string;
}

export interface PdfjsAudit {
  readonly pageCount: number;
  readonly pages: PdfjsPageReport[];
  readonly totalTextOccurrences: number;
  readonly infoJson: string;
  /** Raw XMP packet as pdf.js read it (`getRaw()`); null when its parser gave up. */
  readonly xmpRaw: string | null;
  /** Parsed XMP fields, collected by iterating `Metadata` (v6 has no `getAll()`). */
  readonly xmp: Record<string, unknown>;
  readonly xmpJson: string;
  readonly attachments: PdfjsAttachmentReport[];
}

export async function auditWithPdfjs(bytes: Uint8Array, token: string): Promise<PdfjsAudit> {
  // `slice()` keeps the caller's master copy safe: pdf.js may transfer it (`K15`).
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    ...PDFJS_ASSET_OPTIONS,
  });
  const doc = await task.promise;
  try {
    const pages: PdfjsPageReport[] = [];
    let totalTextOccurrences = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const occurrences = text.split(token).length - 1;
      totalTextOccurrences += occurrences;
      pages.push({ page: pageNumber, occurrences, text });
    }

    const { info, metadata } = await doc.getMetadata();
    // pdf.js types `info` as `Object`; the spike narrows it to a JSON view it can
    // also stringify and scan for the token.
    const infoJson = JSON.stringify(info);
    const rawXmp = metadata?.getRaw();
    const xmp: Record<string, unknown> = {};
    if (metadata) {
      for (const [key, value] of metadata) {
        if (typeof key === 'string') xmp[key] = value;
      }
    }

    const attachments: PdfjsAttachmentReport[] = [];
    const attachmentMap = await doc.getAttachments();
    if (attachmentMap) {
      for (const [key, value] of attachmentMap) {
        // pdf.js leaves `content` undefined when it only read the name tree; the
        // lazy fetch is what an attacker-side reader would do.
        const content = value.content ?? (await doc.getAttachmentContent(key));
        const text = content ? new TextDecoder().decode(content) : '';
        attachments.push({
          key,
          filename: value.filename,
          bytes: content ? content.length : 0,
          occurrences: content ? text.split(token).length - 1 : -1,
          contentPrefix: text.slice(0, 160),
        });
      }
    }

    return {
      pageCount: doc.numPages,
      pages,
      totalTextOccurrences,
      infoJson,
      xmpRaw: typeof rawXmp === 'string' ? rawXmp : null,
      xmp,
      xmpJson: JSON.stringify(xmp),
      attachments,
    };
  } finally {
    await task.destroy();
  }
}
