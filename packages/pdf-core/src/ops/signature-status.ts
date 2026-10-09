/**
 * Signature status ("verification status of existing
 * signatures") — and the parts a browser with
 * **no network** can honestly deliver: cryptographic integrity over the bytes
 * the document actually ships, the certificate's own issuer/subject relationship, and
 * what the `/ByteRange` covers.
 *
 * The product never shows a single "valid" badge, so nothing here returns one: integrity, trust,
 * revocation evidence and post-signing modification are four separate fields, and
 * `trust` is `'not-checked'` until the user has imported a root. `revocation` is
 * `'indeterminate'` unless a CRL or OCSP response **already on the device** — one the user
 * imported, or one embedded in the signature or the document's `/DSS` — speaks for the
 * certificates (`signature-revocation.ts`); nothing is ever fetched. Timestamp tokens, in a
 * signature or as `ETSI.RFC3161` document timestamps, are verified offline
 * (`signature-timestamp.ts`), and a trusted one is the time the signature is judged at
 * (`signature-validation.ts`).
 *
 * Path implemented (ISO 32000-2 keys read, and where):
 *  - §12.8.1: a signature dictionary carries `/ByteRange` (four integers,
 *    `[start1 len1 start2 len2]`) and `/Contents` (the CMS blob). The two covered
 *    ranges are concatenated and hashed **as they lie in the file** — `start2` is the
 *    end of the gap the `/Contents` value sits in, so the digest covers everything
 *    except the signature's own bytes (which is what makes the check meaningful).
 *  - The dictionary is located by scanning the raw file for `/ByteRange` and pairing
 *    it with the `/Contents` value **whose own offset falls inside that gap**: the
 *    gap is the one part of the file the ByteRange excludes, which makes the pairing
 *    self-validating and finds the dictionary without trusting any parser.
 *  - §12.8.2.1: `/SubFilter` decides whether the `/Contents` blob is a detached CMS
 *    `SignedData` (`adbe.pkcs7.detached`, `ETSI.CAdES.detached`). The legacy
 *    `adbe.pkcs7.sha1` and the PKCS#1 shape (`adbe.x509.rsa_sha1`) are *not* the same
 *    digest relation and are reported `unchecked` rather than guessed at. `ETSI.RFC3161`
 *    is a timestamp token over the ByteRange, not a signature: its own check runs.
 *  - §12.8.1: `/M` (signing date) and the field's name for display.
 *  - §7.5.6 / §7.5.8.4: the revision chain. `startxref` at the end of the file gives
 *    the newest cross-reference section; each one's trailer `/Prev` gives the previous
 *    one. The signature's revision is the newest section that starts no later than the
 *    end of its ByteRange, and `changesAfterSigning` counts the sections after it. When
 *    the chain cannot be read, the count of `%%EOF` markers after the covered range is
 *    used instead (each revision ends with one, §7.5.5) — the same number by a
 *    different measurement, and never a silently smaller one.
 *
 * CMS walk (RFC 5652 §5.1, §5.3, §11.2), bounded and dependency-free: `ContentInfo`
 * SEQUENCE → OID `1.2.840.113549.1.7.2` (signedData) → `[0]` EXPLICIT → `SignedData`
 * SEQUENCE → its `digestAlgorithms` SET (the hash actually used, so a SHA-1 signature
 * is hashed with SHA-1 rather than reported as a false `invalid`) → `signerInfos` SET
 * → per `SignerInfo` the `[0]` signedAttrs → OID `1.2.840.113549.1.9.4`
 * (messageDigest) → OCTET STRING. The certificate's `issuer` and `subject` are
 * compared as DER for the self-signed case, and the subject's first CN
 * (OID `2.5.4.3`) becomes `signer`.
 *
 * Everything is bounded: `MAX_SIGNATURES` dictionaries, `MAX_REVISIONS` `startxref`
 * links, `MAX_ASN1_NODES` ASN.1 nodes, a 64 KiB window for the `/Contents` search, and
 * a `throwIfAborted` per signature.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import type { MessageKey } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError, openPdf } from '../engines/mupdf';
import { pageObjects, readName, readNumbers, readText, resolved } from '../engines/mupdf-write';
import type { RevocationCertCheck, RevocationSummary } from '../signature-revocation';
import type { TimestampCheck } from '../signature-timestamp';
import type { CertificateValidity, TrustCheck, TrustReason } from '../signature-trust';
import type { DssData, EvidenceOutcome, ValidationTimeSource } from '../signature-validation';
import { throwIfAborted } from './types';

// Consumers of `SignatureVerification` need the reason vocabulary without reaching past
// this module into the ASN.1-heavy ones it is built on.
export type { RevocationCertCheck, TimestampCheck, TrustReason, ValidationTimeSource };

export type SignatureIntegrity = 'valid' | 'invalid' | 'unchecked';
/**
 * Where the certificate's trust stands.
 *
 * `'trusted'` is only reachable through a chain that ends at a certificate the **user**
 * imported (`signature-trust.ts`); `'untrusted'` means such a chain was attempted and a
 * check on it actually failed; `'self-signed'` is a fact about the certificate alone;
 * `'indeterminate'` means a required validation step could not be completed at all —
 * an unsupported signature algorithm, an unsupported critical extension, a malformed
 * structure — and is deliberately **not** folded into `'untrusted'`, which would claim
 * the chain is broken when the truth is that this build cannot finish the check; and
 * `'not-checked'` is what a document says when no root has been imported at all — an
 * absence of evidence rather than a verdict.
 */
export type SignatureTrust = 'trusted' | 'untrusted' | 'self-signed' | 'indeterminate' | 'not-checked';
/**
 * What lists already on the device say about the signer's certificate and the ones above it:
 * `'not-revoked'` (cleared by a verified list), `'not-revoked-outdated'` (cleared, but by a list
 * too old to rule out a revocation), `'revoked'`, `'revoked-after-signing'` (only
 * ever for a **trusted** timestamp that predates the revocation), or `'indeterminate'` — no
 * verified list speaks for at least one certificate. Per-certificate detail is
 * `SignatureVerification.revocationChecks`.
 */
export type SignatureRevocation = RevocationSummary;
export type SignatureCoverage = 'covers-whole-document' | 'covers-partial' | 'unknown';

export interface SignatureVerification {
  readonly fieldName: string;
  /** `adbe.pkcs7.detached` | `ETSI.CAdES.detached` | … */
  readonly subFilter: string;
  /** `/Name` from the certificate subject when readable, else `null`. */
  readonly signer: string | null;
  /** `/M` as ISO 8601. */
  readonly signedAt: string | null;
  readonly integrity: SignatureIntegrity;
  readonly trust: SignatureTrust;
  readonly revocation: SignatureRevocation;
  /** What the ByteRange actually covers, and what lies outside it. */
  readonly coverage: SignatureCoverage;
  /** Incremental revisions after the signed one. */
  readonly changesAfterSigning: number;
  /** The common names from the signer to the root the chain reached, when it reached one. */
  readonly trustPath: readonly string[];
  /** The signer certificate's own window against the machine's clock. */
  readonly certificateValidity: CertificateValidity;
  /** `notBefore` and `notAfter` of the signer certificate, ISO; `null` when the CMS carried none. */
  readonly certificateNotBefore: string | null;
  readonly certificateNotAfter: string | null;
  /** Which check produced the trust verdict, or `null` when the chain was validated. */
  readonly trustReason: TrustReason | null;
  /** i18n key explaining the verdict in one sentence, never a bare badge. */
  readonly reasonKey: MessageKey;
  /**
   * The RFC 3161 token: the signature's own timestamp (an unsigned attribute), or — for an
   * `ETSI.RFC3161` entry — the document timestamp the entry *is*. `null` when there is none.
   */
  readonly timestamp: TimestampCheck | null;
  /** One answer per certificate checked (signer, then the intermediates above it). */
  readonly revocationChecks: readonly RevocationCertCheck[];
  /** The moment the signature is judged at, ISO, and how far it can be believed. */
  readonly validationTime: string | null;
  readonly validationTimeSource: ValidationTimeSource;
}

const MAX_SIGNATURES = 64;
const MAX_REVISIONS = 1024;
const MAX_ASN1_NODES = 4096;
/** How far from `/ByteRange` the `/Contents` key may sit (both directions). */
const CONTENTS_WINDOW = 64 * 1024;
/** How far the `startxref` scan may reach for a trailer dictionary. */
const DICT_WINDOW = 64 * 1024;

/** Longest integer token read from the raw bytes: 15 digits are always a safe integer. */
const MAX_NUMBER_DIGITS = 15;

const BYTE_RANGE_KEY = '/ByteRange';
const CONTENTS_KEY = '/Contents';
const STARTXREF_KEY = 'startxref';
const PREV_KEY = '/Prev';
const EOF_MARKER = '%%EOF';
const TRAILER_KEY = 'trailer';

/* ------------------------------------------------------------------ *
 * ASCII / byte helpers
 * ------------------------------------------------------------------ */

/** Forward search for an ASCII needle; `-1` when it is not there. */
function indexOfAscii(bytes: Uint8Array, needle: string, from: number): number {
  const last = bytes.length - needle.length;
  for (let at = Math.max(from, 0); at <= last; at += 1) {
    if (bytes[at] !== needle.charCodeAt(0)) continue;
    let offset = 1;
    while (offset < needle.length && bytes[at + offset] === needle.charCodeAt(offset)) offset += 1;
    if (offset === needle.length) return at;
  }
  return -1;
}

/** Backward search: the highest start index `<= from` that carries the needle. */
function lastIndexOfAscii(bytes: Uint8Array, needle: string, from: number): number {
  for (let at = Math.min(from, bytes.length - needle.length); at >= 0; at -= 1) {
    if (bytes[at] !== needle.charCodeAt(0)) continue;
    let offset = 1;
    while (offset < needle.length && bytes[at + offset] === needle.charCodeAt(offset)) offset += 1;
    if (offset === needle.length) return at;
  }
  return -1;
}

function asciiAt(bytes: Uint8Array, at: number, length: number): string {
  return Array.from(bytes.subarray(at, at + length), (byte) => String.fromCharCode(byte)).join('');
}

/** PDF whitespace (`ISO 32000-2` §7.2.2). */
const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

function skipWhitespace(bytes: Uint8Array, at: number): number {
  const rest = bytes.subarray(at);
  const length = rest.findIndex((byte) => !PDF_WHITESPACE.has(byte));
  return at + (length < 0 ? rest.length : length);
}

/** One unsigned decimal integer of at most 15 digits at `at`, or `null` when the token is not one. */
function readNumber(bytes: Uint8Array, at: number): { readonly value: number; readonly next: number } | null {
  const start = skipWhitespace(bytes, at);
  let value = 0;
  let digits = 0;
  for (const byte of bytes.subarray(start, start + MAX_NUMBER_DIGITS + 1)) {
    const digit = byte - 0x30;
    if (digit < 0 || digit > 9) break;
    value = value * 10 + digit;
    digits += 1;
  }
  return digits === 0 || digits > MAX_NUMBER_DIGITS ? null : { value, next: start + digits };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Raw scan: signature dictionaries in the file's own bytes
 * ------------------------------------------------------------------ */

type ByteRangeTuple = readonly [number, number, number, number];

/** Where a `/Contents` string sits in the file: `start` is its opening delimiter, `end` one past its closing one. */
interface ContentsSpan {
  readonly start: number;
  readonly end: number;
}

function readByteRange(
  bytes: Uint8Array,
  from: number,
): { readonly range: ByteRangeTuple; readonly next: number } | null {
  let cursor = skipWhitespace(bytes, from);
  if (bytes[cursor] !== 0x5b) return null;
  cursor += 1;
  const range: [number, number, number, number] = [0, 0, 0, 0];
  for (let index = 0; index < range.length; index += 1) {
    const number = readNumber(bytes, cursor);
    if (number === null) return null;
    range[index] = number.value;
    cursor = number.next;
  }
  return { range, next: cursor };
}

function readStringSpan(bytes: Uint8Array, at: number): ContentsSpan | null {
  const start = skipWhitespace(bytes, at);
  if (bytes[start] === 0x3c) {
    const close = indexOfAscii(bytes, '>', start + 1);
    return close < 0 ? null : { start, end: close + 1 };
  }
  if (bytes[start] !== 0x28) return null;
  const end = literalStringEnd(bytes, start);
  return end < 0 ? null : { start, end };
}

/**
 * The `/Contents` value that sits in the ByteRange's gap. Producers write
 * `/ByteRange` and `/Contents` in either order, so both directions are tried, and
 * only a value whose own offsets fall inside the gap is accepted — that is what makes
 * a match trustworthy without a parser.
 */
function findContentsValue(bytes: Uint8Array, keywordAt: number, range: ByteRangeTuple): ContentsSpan | null {
  const gapStart = range[0] + range[1];
  const gapEnd = range[2];
  const candidates = [
    indexOfAscii(bytes, CONTENTS_KEY, keywordAt),
    lastIndexOfAscii(bytes, CONTENTS_KEY, keywordAt),
  ];
  for (const at of candidates) {
    if (at < 0 || Math.abs(at - keywordAt) > CONTENTS_WINDOW) continue;
    const value = readStringSpan(bytes, at + CONTENTS_KEY.length);
    if (value === null) continue;
    if (value.start >= gapStart && value.end <= gapEnd) return value;
  }
  return null;
}

/** The `/ByteRange` of every signature dictionary reachable by scanning the raw bytes. */
function scanByteRanges(bytes: Uint8Array): readonly ByteRangeTuple[] {
  const found: ByteRangeTuple[] = [];
  let cursor = 0;
  while (found.length < MAX_SIGNATURES) {
    const at = indexOfAscii(bytes, BYTE_RANGE_KEY, cursor);
    if (at < 0) break;
    cursor = at + BYTE_RANGE_KEY.length;
    const parsed = readByteRange(bytes, cursor);
    if (parsed === null) continue;
    const contents = findContentsValue(bytes, at, parsed.range);
    if (contents === null) continue;
    found.push(parsed.range);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Revision chain (`startxref` → trailer `/Prev`)
 * ------------------------------------------------------------------ */

/** Bytes that end a PDF name (§7.2.3). */
const NAME_DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** Whether the name that ends at `at` is complete: the next byte, if any, is whitespace or a delimiter. */
function endsName(bytes: Uint8Array, at: number): boolean {
  return bytes.subarray(at, at + 1).every((byte) => PDF_WHITESPACE.has(byte) || NAME_DELIMITERS.has(byte));
}

/** The end of the literal string whose `(` sits at `at`: balanced parentheses, `\\` escapes (§7.3.4.2). */
function literalStringEnd(bytes: Uint8Array, at: number): number {
  let depth = 0;
  let cursor = at;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    if (byte === 0x5c) {
      cursor += 2;
      continue;
    }
    if (byte === 0x28) depth += 1;
    if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return -1;
}

/** Whether `byte` ends a regular token: whitespace or a delimiter (§7.2.3). */
function endsToken(byte: number): boolean {
  return PDF_WHITESPACE.has(byte) || NAME_DELIMITERS.has(byte);
}

/** The end of the regular token (a number, a keyword or the text of a name) that starts at `at`. */
function tokenEnd(bytes: Uint8Array, at: number): number {
  let cursor = at;
  while (cursor < bytes.length && !endsToken(bytes[cursor] ?? 0)) cursor += 1;
  return cursor;
}

/** The end of the comment whose `%` sits at `at`: it runs to the next CR or LF, or to the end (§7.2.4). */
function commentEnd(bytes: Uint8Array, at: number): number {
  let cursor = at;
  while (cursor < bytes.length && bytes[cursor] !== 0x0a && bytes[cursor] !== 0x0d) cursor += 1;
  return cursor;
}

/** Whether the bytes from `start` to `end` are an unsigned decimal integer: the number part of an `n g R`. */
function isDigits(bytes: Uint8Array, start: number, end: number): boolean {
  return end > start && bytes.subarray(start, end).every((byte) => byte >= 0x30 && byte <= 0x39);
}

/** The end of the `g R` that follows the object number ending at `at`, or `at` when there is none. */
function referenceEnd(bytes: Uint8Array, at: number): number {
  const generationStart = skipWhitespace(bytes, at);
  const generationEnd = tokenEnd(bytes, generationStart);
  if (!isDigits(bytes, generationStart, generationEnd)) return at;
  const markerAt = skipWhitespace(bytes, generationEnd);
  return bytes[markerAt] === 0x52 && endsName(bytes, markerAt + 1) ? markerAt + 1 : at;
}

/**
 * The value of the `/Prev` entry of the dictionary that starts at `at`. Only a key of that
 * dictionary itself counts — never text inside a string or a comment, a nested dictionary, a
 * longer name such as `/Previous`, or a name that is the *value* of another entry. So the top
 * level is read as alternating keys and values (a value is a number, `n g R`, name, string,
 * array or dictionary). `null` when there is none or the dictionary cannot be read.
 */
function dictionaryPrev(bytes: Uint8Array, at: number): number | null {
  let depth = 0;
  let arrays = 0;
  let expectKey = true;
  let cursor = at;
  while (cursor < bytes.length && cursor - at < DICT_WINDOW) {
    const byte = bytes[cursor] ?? 0x20;
    // At the top level, a token that completes a value makes the next name a key again.
    const topLevel = depth === 1 && arrays === 0;
    if (PDF_WHITESPACE.has(byte)) {
      cursor += 1;
    } else if (byte === 0x25) {
      cursor = commentEnd(bytes, cursor);
    } else if (byte === 0x28) {
      const end = literalStringEnd(bytes, cursor);
      if (end < 0) return null;
      cursor = end;
      if (topLevel) expectKey = true;
    } else if (byte === 0x3c && bytes[cursor + 1] === 0x3c) {
      depth += 1;
      cursor += 2;
    } else if (byte === 0x3c) {
      const close = indexOfAscii(bytes, '>', cursor + 1);
      if (close < 0) return null;
      cursor = close + 1;
      if (topLevel) expectKey = true;
    } else if (byte === 0x3e && bytes[cursor + 1] === 0x3e) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) return null;
      if (depth === 1 && arrays === 0) expectKey = true;
    } else if (byte === 0x5b) {
      arrays += 1;
      cursor += 1;
    } else if (byte === 0x5d) {
      arrays = Math.max(0, arrays - 1);
      cursor += 1;
      if (depth === 1 && arrays === 0) expectKey = true;
    } else if (byte === 0x2f) {
      const end = tokenEnd(bytes, cursor + 1);
      if (topLevel && expectKey) {
        if (end - cursor === PREV_KEY.length && asciiAt(bytes, cursor, PREV_KEY.length) === PREV_KEY) {
          const number = readNumber(bytes, end);
          return number === null ? null : number.value;
        }
        expectKey = false;
      } else if (topLevel) {
        expectKey = true;
      }
      cursor = end;
    } else {
      // A number, a keyword, or a stray delimiter that cannot start a value.
      const end = tokenEnd(bytes, cursor);
      if (end === cursor) {
        cursor += 1;
      } else {
        cursor = isDigits(bytes, cursor, end) ? referenceEnd(bytes, end) : end;
        if (topLevel && !expectKey) expectKey = true;
      }
    }
  }
  return null;
}

/**
 * The `/Prev` offset of the cross-reference section at `offset`: a table's `trailer`
 * dictionary, or an xref stream's own dictionary (§7.5.8). `limit` is the start of the
 * next newer section, so the scan cannot wander into another revision.
 */
function previousOffset(bytes: Uint8Array, offset: number, limit: number): number | null {
  const at = skipWhitespace(bytes, offset);
  let dictAt: number;
  if (asciiAt(bytes, at, 4) === 'xref') {
    const trailer = indexOfAscii(bytes, TRAILER_KEY, at);
    if (trailer < 0 || trailer >= limit) return null;
    dictAt = skipWhitespace(bytes, trailer + TRAILER_KEY.length);
  } else {
    // `N G obj << … >>`: the number and `obj`, then the dictionary.
    const object = indexOfAscii(bytes, ' obj', at);
    if (object < 0 || object >= limit) return null;
    dictAt = skipWhitespace(bytes, object + 4);
  }
  if (bytes[dictAt] !== 0x3c || bytes[dictAt + 1] !== 0x3c) return null;
  return dictionaryPrev(bytes, dictAt);
}

/** Cross-reference section offsets, oldest first; empty when the chain is unreadable. */
function revisionStarts(bytes: Uint8Array): readonly number[] {
  const lastStartxref = lastIndexOfAscii(bytes, STARTXREF_KEY, bytes.length - 1);
  if (lastStartxref < 0) return [];
  const first = readNumber(bytes, lastStartxref + STARTXREF_KEY.length);
  const starts: number[] = [];
  const visited = new Set<number>();
  let offset = first === null ? null : first.value;
  let limit = bytes.length;
  while (
    offset !== null &&
    offset >= 0 &&
    offset < bytes.length &&
    !visited.has(offset) &&
    starts.length < MAX_REVISIONS
  ) {
    visited.add(offset);
    starts.push(offset);
    const previous = previousOffset(bytes, offset, limit);
    limit = offset;
    offset = previous;
  }
  return starts.reverse();
}

/** `%%EOF` markers after `from` — one per revision a document gained (§7.5.5). */
function revisionsAfter(bytes: Uint8Array, from: number): number {
  let count = 0;
  let cursor = Math.max(from, 0);
  while (count < MAX_REVISIONS) {
    const at = indexOfAscii(bytes, EOF_MARKER, cursor);
    if (at < 0) return count;
    count += 1;
    cursor = at + EOF_MARKER.length;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * ASN.1 (bounded), CMS and X.509
 * ------------------------------------------------------------------ */

const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_PRINTABLE_STRING = 0x13;
const TAG_T61_STRING = 0x14;
const TAG_IA5_STRING = 0x16;
const TAG_BMP_STRING = 0x1e;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;
const TAG_CONTEXT_0 = 0xa0;

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_COMMON_NAME = '2.5.4.3';

/** RFC 5652 §11.2 / PKCS#9, mapped onto the hash names WebCrypto accepts. */
const DIGEST_ALGORITHMS: Readonly<Record<string, string>> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

interface Tlv {
  readonly tag: number;
  readonly constructed: boolean;
  readonly start: number;
  readonly headerLength: number;
  readonly length: number;
}

function readTlv(bytes: Uint8Array, at: number): Tlv | null {
  const tag = bytes[at];
  if (tag === undefined || (tag & 0x1f) === 0x1f) return null;
  const first = bytes[at + 1];
  if (first === undefined) return null;
  let length = first & 0x7f;
  let headerLength = 2;
  if ((first & 0x80) !== 0) {
    // Indefinite lengths (0x80) are BER and do not occur in the CMS a PDF signer
    // writes; refusing them keeps the walk bounded.
    if (length === 0 || length > 4) return null;
    length = 0;
    for (let index = 0; index < (first & 0x7f); index += 1) {
      const byte = bytes[at + 2 + index];
      if (byte === undefined) return null;
      length = length * 256 + byte;
    }
    headerLength = 2 + (first & 0x7f);
  }
  if (at + headerLength + length > bytes.length) return null;
  return { tag, constructed: (tag & 0x20) !== 0, start: at, headerLength, length };
}

function contentStart(tlv: Tlv): number {
  return tlv.start + tlv.headerLength;
}

function contentBytes(bytes: Uint8Array, tlv: Tlv): Uint8Array {
  const start = contentStart(tlv);
  return bytes.subarray(start, start + tlv.length);
}

/** Direct children of a constructed value, with a shared node budget. */
function children(bytes: Uint8Array, parent: Tlv, budget: { nodes: number }): readonly Tlv[] {
  const out: Tlv[] = [];
  let at = contentStart(parent);
  const end = at + parent.length;
  while (at < end && budget.nodes > 0) {
    const child = readTlv(bytes, at);
    if (child === null) break;
    budget.nodes -= 1;
    out.push(child);
    at = child.start + child.headerLength + child.length;
  }
  return out;
}

function firstChild(bytes: Uint8Array, parent: Tlv): Tlv | null {
  const [first] = children(bytes, parent, { nodes: 1 });
  return first ?? null;
}

/** `1.2.840.113549.1.7.2`, decoded from the OID's base-128 arcs. */
function oidText(bytes: Uint8Array, tlv: Tlv): string {
  const [first, ...rest] = contentBytes(bytes, tlv);
  if (first === undefined) return '';
  const arcs: number[] = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (const byte of rest) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join('.');
}

interface CmsCertificate {
  readonly issuer: Tlv;
  readonly subject: Tlv;
  /** The certificate's own DER, header included — what the trust walk parses. */
  readonly der: Uint8Array;
  /** `SubjectPublicKeyInfo`, the exact bytes `crypto.subtle.importKey('spki', …)` wants. */
  readonly spki: Tlv | null;
  /** The key algorithm inside that SPKI: `rsaEncryption` or `id-ecPublicKey`. */
  readonly keyAlgorithm: string;
  /** The named curve of an EC key, when the SPKI names one. */
  readonly curve: EcCurve | null;
}

interface CmsInfo {
  readonly messageDigest: Uint8Array | null;
  readonly digestAlgorithm: string | null;
  readonly certificate: CmsCertificate | null;
  /**
   * The signed attributes **as they are signed** — the `SET OF` form (RFC 5652 §5.4), not
   * the implicit `[0]` form the structure stores them in — or `null` when the SignerInfo
   * carries none.
   */
  readonly signedAttributes: Uint8Array | null;
  readonly signature: Uint8Array | null;
  readonly signatureAlgorithm: string;
  /** Every other certificate the CMS carried, DER: the candidate chain. */
  readonly others: readonly Uint8Array[];
}

const NO_CMS: CmsInfo = {
  messageDigest: null,
  digestAlgorithm: null,
  certificate: null,
  signedAttributes: null,
  signature: null,
  signatureAlgorithm: '',
  others: [],
};

/** Who may verify a signature, and with what. */
const SIGNATURE_ALGORITHMS: Record<string, 'RSASSA-PKCS1-v1_5' | 'ECDSA'> = {
  '1.2.840.113549.1.1.1': 'RSASSA-PKCS1-v1_5', // rsaEncryption
  '1.2.840.113549.1.1.11': 'RSASSA-PKCS1-v1_5', // sha256WithRSAEncryption
  '1.2.840.113549.1.1.12': 'RSASSA-PKCS1-v1_5',
  '1.2.840.113549.1.1.13': 'RSASSA-PKCS1-v1_5',
  '1.2.840.10045.4.3.2': 'ECDSA', // ecdsa-with-SHA256
  '1.2.840.10045.4.3.3': 'ECDSA',
  '1.2.840.10045.4.3.4': 'ECDSA',
};

/** The named curves WebCrypto verifies and this verifier recognises, with the byte size of one scalar. */
type EcCurve = 'P-256' | 'P-384' | 'P-521';

const EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';
const RSA_KEY_OID = '1.2.840.113549.1.1.1';

const CURVE_SIZES: Readonly<Record<EcCurve, number>> = { 'P-256': 32, 'P-384': 48, 'P-521': 66 };

const CURVE_OIDS: Readonly<Record<string, EcCurve>> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

/** The empty trust verdict: what a document with no readable CMS reports. */
const NO_TRUST: TrustCheck = {
  verdict: 'not-checked',
  path: [],
  validity: 'unknown',
  notBefore: null,
  notAfter: null,
  reason: null,
};

interface SignerInfoFacts {
  readonly messageDigest: Uint8Array | null;
  readonly signedAttributes: Uint8Array | null;
  readonly signature: Uint8Array | null;
  readonly signatureAlgorithm: string;
}

const NO_SIGNER_INFO: SignerInfoFacts = {
  messageDigest: null,
  signedAttributes: null,
  signature: null,
  signatureAlgorithm: '',
};

/**
 * The first `SignerInfo` that carries signed attributes, and the three things under it
 * this verdict needs: the `messageDigest` attribute, the attributes' own bytes as they
 * were signed, and the signature value with the algorithm that made it.
 */
function readSignerInfo(bytes: Uint8Array, signedData: Tlv, budget: { nodes: number }): SignerInfoFacts {
  for (const child of children(bytes, signedData, budget)) {
    // `digestAlgorithms` and `signerInfos` are both SETs; only the second kind holds
    // SignerInfos with a `[0]` signedAttrs block, which the loop below requires.
    if (child.tag !== TAG_SET || !child.constructed) continue;
    for (const signerInfo of children(bytes, child, budget)) {
      if (signerInfo.tag !== TAG_SEQUENCE) continue;
      const parts = children(bytes, signerInfo, budget);
      const signedAttrs = parts.find((tlv) => tlv.tag === TAG_CONTEXT_0);
      if (signedAttrs === undefined) continue;

      const messageDigest = readMessageDigest(bytes, signedAttrs, budget);
      /**
       * The signed bytes are the attributes with the universal `SET OF` tag: the structure
       * stores them under an implicit `[0]`, and RFC 5652 §5.4 signs the `SET OF` form.
       * The header length is the same for both tags, so the first byte is the only change.
       * (Measured: OpenSSL's `cms -verify` re-encodes the attributes and hashes that.)
       */
      const signed = bytes.slice(
        signedAttrs.start,
        signedAttrs.start + signedAttrs.headerLength + signedAttrs.length,
      );
      signed[0] = TAG_SET;

      // `SignerInfo ::= SEQUENCE { version, sid, digestAlgorithm, [0] signedAttrs,
      //  signatureAlgorithm, signature }` — the OCTET STRING is the value, and the
      // AlgorithmIdentifier right after the attributes names the algorithm.
      const after = parts.slice(parts.indexOf(signedAttrs) + 1);
      const algorithm = after.find((tlv) => tlv.tag === TAG_SEQUENCE);
      const algorithmOid = algorithm === undefined ? null : firstChild(bytes, algorithm);
      const signature = after.find((tlv) => tlv.tag === TAG_OCTET_STRING);
      return {
        messageDigest,
        signedAttributes: signed,
        signature: signature === undefined ? null : contentBytes(bytes, signature),
        signatureAlgorithm:
          algorithmOid === null || algorithmOid.tag !== TAG_OID ? '' : oidText(bytes, algorithmOid),
      };
    }
  }
  return NO_SIGNER_INFO;
}

/** The `messageDigest` attribute (`OID 1.2.840.113549.1.9.4`) of a signed-attrs block. */
function readMessageDigest(
  bytes: Uint8Array,
  signedAttrs: Tlv,
  budget: { nodes: number },
): Uint8Array | null {
  for (const attribute of children(bytes, signedAttrs, budget)) {
    // `Attribute ::= SEQUENCE { attrType OID, attrValues SET OF ANY }` (RFC 5652 §5.3).
    const [type, values] = children(bytes, attribute, budget);
    if (type === undefined || values === undefined) continue;
    if (type.tag !== TAG_OID || oidText(bytes, type) !== OID_MESSAGE_DIGEST) continue;
    const digest = children(bytes, values, budget).find((tlv) => tlv.tag === TAG_OCTET_STRING);
    if (digest !== undefined) return contentBytes(bytes, digest);
  }
  return null;
}

/** `SignedData`'s first `certificates` entry, as `issuer` and `subject` TLVs. */
function readCertificate(
  bytes: Uint8Array,
  signedData: Tlv,
  budget: { nodes: number },
): CmsInfo['certificate'] {
  const certificates = children(bytes, signedData, budget).find((child) => child.tag === TAG_CONTEXT_0);
  if (certificates === undefined) return null;
  const certificate = firstChild(bytes, certificates);
  if (certificate === null) return null;
  const tbs = firstChild(bytes, certificate);
  if (tbs === null) return null;

  // `TBSCertificate ::= SEQUENCE { [0] version DEFAULT v1, serialNumber, signature,
  //  issuer, validity, subject, … }` (RFC 5280 §4.1) — the version tag shifts the
  //  two names by one position.
  const fields = children(bytes, tbs, budget);
  const base = fields[0]?.tag === TAG_CONTEXT_0 ? 1 : 0;
  const issuer = fields[base + 2];
  const subject = fields[base + 4];
  // `subjectPublicKeyInfo` follows `subject` (RFC 5280 §4.1): its AlgorithmIdentifier's
  // first child is the key algorithm, and for an EC key the second is the named curve.
  const spki = fields[base + 5];
  if (issuer === undefined || subject === undefined) return null;

  let keyAlgorithm = '';
  let curve: EcCurve | null = null;
  const spkiFields = spki === undefined ? [] : children(bytes, spki, budget);
  const spkiAlgorithm = spkiFields[0];
  const algorithmFields = spkiAlgorithm === undefined ? [] : children(bytes, spkiAlgorithm, budget);
  const keyOid = algorithmFields[0];
  if (keyOid !== undefined && keyOid.tag === TAG_OID) {
    keyAlgorithm = oidText(bytes, keyOid);
    const parameters = algorithmFields[1];
    if (parameters !== undefined && parameters.tag === TAG_OID)
      curve = CURVE_OIDS[oidText(bytes, parameters)] ?? null;
  }
  return {
    issuer,
    subject,
    der: tlvBytes(bytes, certificate),
    spki: spki ?? null,
    keyAlgorithm,
    curve,
  };
}

/** The first CN of a Name (`RDNSequence`), decoded from the string type it uses. */
function commonName(bytes: Uint8Array, name: Tlv, budget: { nodes: number }): string | null {
  for (const set of children(bytes, name, budget)) {
    if (set.tag !== TAG_SET) continue;
    for (const attribute of children(bytes, set, budget)) {
      const [type, value] = children(bytes, attribute, budget);
      if (type === undefined || value === undefined || type.tag !== TAG_OID) continue;
      if (oidText(bytes, type) !== OID_COMMON_NAME) continue;
      const content = contentBytes(bytes, value);
      if (value.tag === TAG_UTF8_STRING) return new TextDecoder('utf-8').decode(content);
      if (value.tag === TAG_BMP_STRING) return new TextDecoder('utf-16be').decode(content);
      if (
        value.tag === TAG_PRINTABLE_STRING ||
        value.tag === TAG_IA5_STRING ||
        value.tag === TAG_T61_STRING
      ) {
        return asciiAt(content, 0, content.length);
      }
      return null;
    }
  }
  return null;
}

/** The CMS `SignedData` facts this check needs, or {@link NO_CMS}. */
function readCms(der: Uint8Array): CmsInfo {
  const budget = { nodes: MAX_ASN1_NODES };
  const contentInfo = readTlv(der, 0);
  if (contentInfo === null || contentInfo.tag !== TAG_SEQUENCE) return NO_CMS;

  const fields = children(der, contentInfo, budget);
  const type = fields[0];
  const wrapper = fields[1];
  if (type === undefined || wrapper === undefined || type.tag !== TAG_OID) return NO_CMS;
  if (oidText(der, type) !== OID_SIGNED_DATA) return NO_CMS;
  if (wrapper.tag !== TAG_CONTEXT_0) return NO_CMS;

  const signedData = firstChild(der, wrapper);
  if (signedData === null || signedData.tag !== TAG_SEQUENCE) return NO_CMS;
  const signedFields = children(der, signedData, budget);
  // `digestAlgorithms ::= SET OF AlgorithmIdentifier` is the first SET of the three
  // (`§5.1` field order); `AlgorithmIdentifier.algorithm` is its first child.
  const algorithms = signedFields.find((child) => child.tag === TAG_SET);
  const identifier = algorithms === undefined ? null : firstChild(der, algorithms);
  const algorithm = identifier === null ? null : firstChild(der, identifier);
  const digestOid = algorithm === null ? '' : oidText(der, algorithm);

  const certificate = readCertificate(der, signedData, budget);
  const signer = readSignerInfo(der, signedData, budget);
  // Every certificate after the signer's own is a chain candidate; the walk decides which
  // of them actually signs which.
  const others: Uint8Array[] = [];
  const certificates = children(der, signedData, budget).find((child) => child.tag === TAG_CONTEXT_0);
  if (certificates !== undefined) {
    for (const entry of children(der, certificates, budget)) {
      const bytesOf = tlvBytes(der, entry);
      if (certificate !== null && bytesOf.length === certificate.der.length) {
        let same = true;
        for (let index = 0; index < bytesOf.length && same; index += 1)
          same = bytesOf[index] === certificate.der[index];
        if (same) continue;
      }
      // Only certificate-shaped entries: `CertificateChoices` also allows the attribute
      // certificate and "other" forms, and those are not chain candidates.
      if (entry.tag === TAG_SEQUENCE) others.push(bytesOf);
    }
  }
  return {
    messageDigest: signer.messageDigest,
    digestAlgorithm: DIGEST_ALGORITHMS[digestOid] ?? null,
    certificate,
    signedAttributes: signer.signedAttributes,
    signature: signer.signature,
    signatureAlgorithm: signer.signatureAlgorithm,
    others,
  };
}

/* ------------------------------------------------------------------ *
 * The document side: signature fields and what they carry
 * ------------------------------------------------------------------ */

/** One signature field, read out of the document before it is closed. */
interface SignatureField {
  readonly name: string;
  /** `/Contents` as bytes; `null` when it is not a string. */
  readonly contents: Uint8Array | null;
  /** `/ByteRange` as the object graph has it; the raw scan is what makes it trustworthy. */
  readonly byteRange: ByteRangeTuple | null;
  readonly subFilter: string | null;
  /** `/M`, the text as written. */
  readonly signedAt: string | null;
}

function textOf(object: PDFObject | null | undefined): string | null {
  const text = readText(object);
  return text === null || text === '' ? null : text;
}

/** The `/V` of a field or widget, when it is a signature dictionary. */
function signatureValue(dict: PDFObject): PDFObject | null {
  const value = resolved(dict.get('V'));
  // `/ByteRange` is the one key every signature dictionary carries (§12.8.1) and no
  // ordinary field value does; it is the cheapest honest test for "this is a signature".
  return value?.isDictionary() === true && !value.get('ByteRange').isNull() ? value : null;
}

/** What a signature dictionary carries, as plain values. */
function readSignature(name: string, dictionary: PDFObject): SignatureField {
  const range = readNumbers(dictionary.get('ByteRange'));
  const [first, second, third, fourth] = range;
  const contents = resolved(dictionary.get('Contents'));
  return {
    name,
    contents: contents?.isString() === true ? new Uint8Array(contents.asByteString()) : null,
    byteRange:
      range.length === 4 &&
      first !== undefined &&
      second !== undefined &&
      third !== undefined &&
      fourth !== undefined
        ? [first, second, third, fourth]
        : null,
    subFilter: readName(dictionary.get('SubFilter')) ?? textOf(dictionary.get('SubFilter')),
    signedAt: textOf(dictionary.get('M')),
  };
}

/**
 * A key that tells one signature dictionary from another: its own object number, or — for a
 * dictionary written inline in its field — the object number of the field that holds it, so
 * a merged field and widget reached twice (once through `/Fields`, once through a page's
 * `/Annots`) is one signature, not two. `holder` is the unresolved reference to that field.
 */
function identityOf(holder: PDFObject, entry: PDFObject, value: PDFObject): string | PDFObject {
  const reference = entry.get('V');
  if (reference.isIndirect()) return `value ${reference.asIndirect()}`;
  return holder.isIndirect() ? `field ${holder.asIndirect()}` : value;
}

function walkField(
  object: PDFObject,
  prefix: string,
  collected: SignatureField[],
  seen: Set<string | PDFObject>,
  depth: number,
): void {
  const dict = resolved(object);
  if (dict === null || !dict.isDictionary() || depth > 32) return;

  const own = textOf(dict.get('T'));
  const name = own === null ? prefix : prefix === '' ? own : `${prefix}.${own}`;

  const kids = resolved(dict.get('Kids'));
  if (kids?.isArray() === true) {
    for (let index = 0; index < kids.length && collected.length < MAX_SIGNATURES; index += 1) {
      walkField(kids.get(index), name, collected, seen, depth + 1);
    }
  }

  const value = signatureValue(dict);
  if (value === null) return;
  const key = identityOf(object, dict, value);
  if (seen.has(key)) return;
  seen.add(key);
  collected.push(readSignature(name, value));
}

/**
 * Signature fields of the document, by qualified field name: the `/AcroForm /Fields`
 * tree first, then any widget annotation whose `/V` no field claimed (a producer that
 * keeps the widget outside `/Fields` still ships a signature a reader must show).
 */
function collectSignatureFields(
  doc: PDFDocument,
  signal: AbortSignal | undefined,
): readonly SignatureField[] {
  const collected: SignatureField[] = [];
  const seen = new Set<string | PDFObject>();

  const catalog = resolved(doc.getTrailer().get('Root'));
  const acroForm = catalog === null ? null : resolved(catalog.get('AcroForm'));
  const roots = acroForm === null ? null : resolved(acroForm.get('Fields'));
  if (roots?.isArray() === true) {
    for (let index = 0; index < roots.length && collected.length < MAX_SIGNATURES; index += 1) {
      walkField(roots.get(index), '', collected, seen, 0);
    }
  }

  for (const page of pageObjects(doc)) {
    if (collected.length >= MAX_SIGNATURES) break;
    if (signal !== undefined) throwIfAborted(signal);
    const annots = resolved(page.get('Annots'));
    if (annots?.isArray() !== true) continue;
    for (let index = 0; index < annots.length; index += 1) {
      const annotReference = annots.get(index);
      const annot = resolved(annotReference);
      if (annot === null || !annot.isDictionary()) continue;
      const value = signatureValue(annot);
      if (value === null) continue;
      const key = identityOf(annotReference, annot, value);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(readSignature(textOf(annot.get('T')) ?? '', value));
    }
  }
  return collected;
}

/**
 * How many signature fields an opened document carries, counted by the same walk
 * {@link verifySignatures} uses — so "this file is signed" means one thing everywhere.
 */
export function countSignedFields(doc: PDFDocument): number {
  return collectSignatureFields(doc, undefined).length;
}

/** How much validation data a `/DSS` may hand over: a hostile file cannot make this unbounded. */
const MAX_DSS_ITEMS = 256;
const MAX_DSS_BYTES = 16 * 1024 * 1024;

/**
 * The document security store (`/Root /DSS`, ISO 32000-2 §12.8.4.3): the certificates, CRLs
 * and OCSP responses a signer's tool archived so the signature can be validated later,
 * offline. Each entry is a stream, read by reference; an entry that is not one is skipped.
 * Nothing in it is believed — every list is checked against the certificate that issued it.
 */
function readDss(doc: PDFDocument): DssData {
  const catalog = resolved(doc.getTrailer().get('Root'));
  const dss = catalog === null ? null : resolved(catalog.get('DSS'));
  if (dss === null || !dss.isDictionary()) return { certs: [], crls: [], ocsps: [] };
  const budget = { bytes: MAX_DSS_BYTES };
  const streams = (key: string): Uint8Array[] => {
    const array = resolved(dss.get(key));
    if (array?.isArray() !== true) return [];
    const out: Uint8Array[] = [];
    for (let index = 0; index < array.length && out.length < MAX_DSS_ITEMS; index += 1) {
      const entry = array.get(index);
      if (entry.isNull() || !entry.isStream()) continue;
      const data = entry.readStream().asUint8Array().slice();
      budget.bytes -= data.length;
      if (budget.bytes < 0) break;
      out.push(data);
    }
    return out;
  };
  return { certs: streams('Certs'), crls: streams('CRLs'), ocsps: streams('OCSPs') };
}

/** Whether the raw bytes carry a `/ByteRange` key at all: without one, nothing is signed. */
function mentionsByteRange(bytes: Uint8Array): boolean {
  const needle = [0x2f, 0x42, 0x79, 0x74, 0x65, 0x52, 0x61, 0x6e, 0x67, 0x65]; // "/ByteRange"
  outer: for (let at = 0; at + needle.length <= bytes.length; at += 1) {
    for (let step = 0; step < needle.length; step += 1) {
      if (bytes[at + step] !== needle[step]) continue outer;
    }
    return true;
  }
  return false;
}

const PDF_DATE = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?'?/;

/** `/M` (`D:YYYYMMDDHHmmSS+hh'mm'`) → ISO 8601; an unreadable value stays `null`. */
function isoFromPdfDate(value: string | null): string | null {
  if (value === null) return null;
  const match = PDF_DATE.exec(value.trim());
  if (match === null) return null;
  const [
    ,
    year,
    month = '01',
    day = '01',
    hour = '00',
    minute = '00',
    second = '00',
    sign,
    tzHour,
    tzMinute,
  ] = match;
  const zone = sign === 'Z' || sign === undefined ? 'Z' : `${sign}${tzHour ?? '00'}:${tzMinute ?? '00'}`;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`;
}

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */

interface SigningFacts {
  readonly subFilter: string;
  readonly signedAt: string | null;
  readonly signer: string | null;
  readonly selfSigned: boolean;
  readonly messageDigest: Uint8Array | null;
  readonly digestAlgorithm: string | null;
  readonly signedAttributes: Uint8Array | null;
  readonly signature: Uint8Array | null;
  readonly signatureAlgorithm: string;
  readonly signerKey: {
    readonly spki: Uint8Array;
    readonly algorithm: string;
    readonly curve: EcCurve | null;
  } | null;
  /** The chain walk against the imported roots; `NO_TRUST` when it could not be run. */
  readonly trust: TrustCheck;
  /** Whether the caller supplied any roots at all: without one there is no verdict to give. */
  readonly hasRoots: boolean;
  /** Timestamp, revocation and validation time; `null` for a subfilter that is not verified. */
  readonly evidence: EvidenceOutcome | null;
}

/**
 * The signature value itself, against the signer certificate's public key.
 *
 * The digest comparison alone is not integrity: an attacker who edits the file can
 * recompute the `messageDigest` attribute to match — that attribute is *inside* the blob
 * they are editing — while the signature over it stays what it was. Only verifying the
 * signature with the public key closes that hole, and it is the half this verifier was
 * missing (the OpenSSL check in `tools/spikes/sign-check.mts` is what exposed it).
 */
function ecdsaSignatureBytes(der: Uint8Array, curve: EcCurve): Uint8Array | null {
  const size = CURVE_SIZES[curve];
  const sequence = readTlv(der, 0);
  if (sequence?.tag !== TAG_SEQUENCE || sequence.headerLength + sequence.length !== der.length) return null;
  const parts = children(der, sequence, { nodes: 3 });
  if (parts.length !== 2) return null;
  const raw = new Uint8Array(size * 2);
  for (const [index, part] of parts.entries()) {
    if (part.tag !== 0x02) return null;
    let scalar = contentBytes(der, part);
    const [first, second] = scalar;
    if (first === undefined || (first & 0x80) !== 0) return null;
    if (first === 0 && second !== undefined) {
      if ((second & 0x80) === 0) return null;
      scalar = scalar.subarray(1);
    }
    if (scalar.length > size || scalar.every((byte) => byte === 0)) return null;
    raw.set(scalar, (index + 1) * size - scalar.length);
  }
  return raw;
}

/**
 * Imports `spki` and verifies `signature` over `data`. An algorithm this context cannot
 * provide is an absence of evidence, not evidence of tampering — the same rule the digest
 * follows — so a failure of the engine itself is `unsupported`, not `invalid`.
 */
async function verifyWithKey(
  subtle: SubtleCrypto,
  spki: Uint8Array,
  keyAlgorithm: RsaHashedImportParams | EcKeyImportParams,
  verifyAlgorithm: AlgorithmIdentifier | EcdsaParams,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<'valid' | 'invalid' | 'unsupported'> {
  try {
    const key = await subtle.importKey('spki', spki as unknown as ArrayBuffer, keyAlgorithm, false, [
      'verify',
    ]);
    const ok = await subtle.verify(
      verifyAlgorithm,
      key,
      signature as unknown as ArrayBuffer,
      data as unknown as ArrayBuffer,
    );
    return ok ? 'valid' : 'invalid';
  } catch {
    return 'unsupported';
  }
}

async function verifySignatureValue(
  subtle: SubtleCrypto,
  facts: SigningFacts,
  digestAlgorithm: string,
): Promise<'valid' | 'invalid' | 'unsupported'> {
  const { signedAttributes, signature, signatureAlgorithm, signerKey } = facts;
  if (signedAttributes === null || signature === null || signerKey === null) return 'unsupported';
  const kind = SIGNATURE_ALGORITHMS[signatureAlgorithm];
  if (kind === undefined) return 'unsupported';
  // The algorithm the SignerInfo names and the key the certificate carries must agree:
  // nothing here can verify a mismatched pairing, so the verdict stays unchecked rather
  // than claiming a mismatch.
  if (kind === 'ECDSA') {
    const curve = signerKey.curve;
    if (curve === null || signerKey.algorithm !== EC_PUBLIC_KEY_OID) return 'unsupported';
    const raw = ecdsaSignatureBytes(signature, curve);
    if (raw === null) return 'invalid';
    return await verifyWithKey(
      subtle,
      signerKey.spki,
      { name: 'ECDSA', namedCurve: curve },
      { name: 'ECDSA', hash: digestAlgorithm },
      raw,
      signedAttributes,
    );
  }
  if (signerKey.algorithm !== RSA_KEY_OID) return 'unsupported';
  return await verifyWithKey(
    subtle,
    signerKey.spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: digestAlgorithm },
    { name: 'RSASSA-PKCS1-v1_5' },
    signature,
    signedAttributes,
  );
}

function verdictKey(integrity: SignatureIntegrity, cause: string | null): MessageKey {
  if (integrity === 'valid') return 'props.sig.reason.valid';
  if (integrity === 'invalid') return 'props.sig.reason.invalid';
  if (cause === 'layout') return 'props.sig.reason.unchecked.layout';
  if (cause === 'subfilter') return 'props.sig.reason.unchecked.subFilter';
  if (cause === 'digest') return 'props.sig.reason.unchecked.digest';
  if (cause === 'webcrypto') return 'props.sig.reason.unchecked.webCrypto';
  return 'props.sig.reason.unchecked.der';
}

/** The detached CMS subfilters whose `/Contents` is a `SignedData` over the byte range. */
const DETACHED_SUBFILTERS = new Set(['adbe.pkcs7.detached', 'ETSI.CAdES.detached']);

/** A document timestamp (ISO 32000-2 §12.8.5): `/Contents` is an RFC 3161 token, not a signature. */
const TIMESTAMP_SUBFILTER = 'ETSI.RFC3161';

/** The DER of one TLV, header included — how `issuer` and `subject` are compared. */
function tlvBytes(der: Uint8Array, tlv: Tlv): Uint8Array {
  return der.subarray(tlv.start, tlv.start + tlv.headerLength + tlv.length);
}

/** The four ByteRange integers are identical. */
function sameRange(left: ByteRangeTuple, right: ByteRangeTuple): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2] && left[3] === right[3];
}

/**
 * The scanned range a field's `/ByteRange` stands for. The object graph hands numbers over as
 * 32-bit floats, so above 2^24 (a file of more than 16 MiB) an integer comes back rounded to
 * the nearest float; the file's own digits are exact, and they are what gets hashed. A field is
 * paired with the scanned range whose four numbers round to what the object graph read. When
 * no scanned range does, or when ranges that differ round alike (two candidates the object
 * graph cannot tell apart), nothing is paired and the signature stays unchecked.
 */
function pairedRange(scanned: readonly ByteRangeTuple[], read: ByteRangeTuple): ByteRangeTuple | null {
  const candidates = scanned.filter((entry) =>
    entry.every((number, index) => Math.fround(number) === read[index]),
  );
  const [first] = candidates;
  return first !== undefined && candidates.every((entry) => sameRange(entry, first)) ? first : null;
}

/**
 * One signature's verdict. The digest is computed over the bytes **the file ships**,
 * never over a re-serialised document: a signature that does not match the bytes on
 * disk is `invalid` even when the object graph still looks intact.
 */
async function verifyOne(
  bytes: Uint8Array,
  field: SignatureField,
  facts: SigningFacts,
  byteRange: ByteRangeTuple | null,
  revisions: readonly number[],
): Promise<SignatureVerification> {
  /**
   * The trust column, decided from the chain and the imported roots. A self-signed
   * certificate is named as such because the certificate itself says so; anything else
   * needs a root to compare against, and with none imported the honest answer is
   * `not-checked` — never `untrusted`, which would be a claim this build cannot support.
   */
  const trust: SignatureTrust =
    facts.trust.verdict === 'trusted'
      ? 'trusted'
      : facts.trust.verdict === 'indeterminate'
        ? 'indeterminate'
        : facts.selfSigned
          ? 'self-signed'
          : facts.hasRoots
            ? 'untrusted'
            : 'not-checked';
  const base = {
    fieldName: field.name,
    subFilter: facts.subFilter,
    signer: facts.signer,
    signedAt: facts.signedAt,
    trust,
    revocation: (facts.evidence?.revocation ?? 'indeterminate') as SignatureRevocation,
    trustPath: facts.trust.path,
    certificateValidity: facts.trust.validity,
    certificateNotBefore: facts.trust.notBefore,
    certificateNotAfter: facts.trust.notAfter,
    trustReason: facts.trust.reason,
    timestamp: facts.evidence?.timestamp ?? null,
    revocationChecks: facts.evidence?.revocationChecks ?? [],
    validationTime: facts.evidence === null ? null : facts.evidence.validationTime.toISOString(),
    validationTimeSource: facts.evidence?.validationTimeSource ?? ('clock' as ValidationTimeSource),
  };

  // Coverage and the revision count come from the raw layout, so they are reported even
  // when the cryptographic verdict cannot be reached: "the signature does not cover what
  // it should" is a different fact from "the digest did not match".
  const coverage: SignatureCoverage = byteRange === null ? 'unknown' : coverageOf(bytes, byteRange);
  const signedRevisions = byteRange === null ? 0 : changesAfterSigning(bytes, byteRange, revisions);
  const unchecked = (cause: string): SignatureVerification => ({
    ...base,
    integrity: 'unchecked',
    coverage,
    changesAfterSigning: signedRevisions,
    reasonKey: verdictKey('unchecked', cause),
  });

  if (!DETACHED_SUBFILTERS.has(facts.subFilter)) return unchecked('subfilter');
  if (byteRange === null) return unchecked('layout');
  if (facts.messageDigest === null) return unchecked('der');
  if (facts.digestAlgorithm === null) return unchecked('digest');

  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return unchecked('webcrypto');

  // WebCrypto digests one buffer, so the two covered ranges are joined once.
  const covered = coveredBytes(bytes, byteRange);
  if (covered === null) return unchecked('layout');

  let computed: Uint8Array;
  try {
    computed = new Uint8Array(await subtle.digest(facts.digestAlgorithm, covered));
  } catch {
    // An algorithm the context cannot provide (an old build without SHA-384, say) is
    // an absence of evidence, not evidence of tampering.
    return unchecked('digest');
  }

  let integrity: SignatureIntegrity = bytesEqual(computed, facts.messageDigest) ? 'valid' : 'invalid';
  if (integrity === 'valid') {
    const signature = await verifySignatureValue(subtle, facts, facts.digestAlgorithm);
    if (signature === 'invalid') integrity = 'invalid';
    if (signature === 'unsupported') return unchecked('webcrypto');
  }
  return {
    ...base,
    integrity,
    coverage,
    changesAfterSigning: signedRevisions,
    reasonKey: verdictKey(integrity, null),
  };
}

/** The two covered segments of a ByteRange, joined; `null` when the range leaves the file. */
function coveredBytes(bytes: Uint8Array, range: ByteRangeTuple): Uint8Array<ArrayBuffer> | null {
  const [start1, length1, start2, length2] = range;
  if (start1 + length1 > bytes.length || start2 + length2 > bytes.length) return null;
  const covered = new Uint8Array(length1 + length2);
  covered.set(bytes.subarray(start1, start1 + length1), 0);
  covered.set(bytes.subarray(start2, start2 + length2), length1);
  return covered;
}

interface TimestampEntryOptions {
  readonly roots: readonly Uint8Array[];
  readonly crls: readonly Uint8Array[];
  readonly dss: DssData;
  readonly now: Date;
}

/**
 * An `ETSI.RFC3161` entry is a **document timestamp** (ISO 32000-2 §12.8.5), not a signature:
 * its `/Contents` is a time-stamp token whose imprint is the hash of the ByteRange. The four
 * fields keep their meaning for it — `integrity` says whether the token is what it claims
 * (imprint, CMS signature, TSA certificate), `trust` is the TSA's chain against the imported
 * roots at the token's own time, and `signer` is the TSA — and `timestamp` carries the rest.
 */
async function verifyTimestampEntry(
  bytes: Uint8Array,
  field: SignatureField,
  byteRange: ByteRangeTuple | null,
  revisions: readonly number[],
  options: TimestampEntryOptions,
): Promise<SignatureVerification> {
  const coverage: SignatureCoverage = byteRange === null ? 'unknown' : coverageOf(bytes, byteRange);
  const changes = byteRange === null ? 0 : changesAfterSigning(bytes, byteRange, revisions);
  const unchecked: SignatureVerification = {
    fieldName: field.name,
    subFilter: TIMESTAMP_SUBFILTER,
    signer: null,
    signedAt: null,
    integrity: 'unchecked',
    trust: 'not-checked',
    revocation: 'indeterminate',
    coverage,
    changesAfterSigning: changes,
    trustPath: [],
    certificateValidity: 'unknown',
    certificateNotBefore: null,
    certificateNotAfter: null,
    trustReason: null,
    reasonKey: verdictKey('unchecked', 'layout'),
    timestamp: null,
    revocationChecks: [],
    validationTime: null,
    validationTimeSource: 'clock',
  };
  const covered = byteRange === null ? null : coveredBytes(bytes, byteRange);
  if (covered === null || field.contents === null) return unchecked;

  const { timestamp, revocation } = await (await import('../signature-validation')).evaluateDocumentTimestamp(
    {
      token: field.contents,
      covered,
      roots: options.roots,
      importedCrls: options.crls,
      dss: options.dss,
      now: options.now,
    },
  );
  const trust: SignatureTrust =
    timestamp.tsaTrust === 'trusted'
      ? 'trusted'
      : timestamp.tsaTrust === 'indeterminate'
        ? 'indeterminate'
        : timestamp.tsaSelfSigned
          ? 'self-signed'
          : options.roots.length > 0
            ? 'untrusted'
            : 'not-checked';
  return {
    ...unchecked,
    signer: timestamp.tsa,
    signedAt: timestamp.genTime,
    integrity: timestamp.status,
    trust,
    revocation,
    trustPath: timestamp.tsaPath,
    // The TSA certificate is judged at the token's own time (`signature-timestamp.ts`).
    certificateValidity: timestamp.status === 'valid' ? 'valid' : 'unknown',
    certificateNotBefore: timestamp.tsaNotBefore,
    certificateNotAfter: timestamp.tsaNotAfter,
    trustReason: timestamp.tsaTrustReason,
    reasonKey: `props.sig.reason.timestamp.${timestamp.status}`,
    timestamp,
    revocationChecks: timestamp.tsaRevocation,
    validationTime: timestamp.genTime,
    validationTimeSource:
      timestamp.status !== 'valid' ? 'clock' : timestamp.trusted ? 'timestamp' : 'timestamp-untrusted',
  };
}

/**
 * What the ByteRange covers (§12.8.1), and what lies outside it. The raw scan only yields a range
 * whose `/Contents` sits in its gap, so the two segments never overlap.
 */
function coverageOf(bytes: Uint8Array, range: ByteRangeTuple): SignatureCoverage {
  const end = range[2] + range[3];
  if (end > bytes.length) return 'unknown';
  // Anything before the first range, or after the last one, is not covered by the
  // signature: that is exactly "partial coverage", whatever wrote those bytes.
  if (range[0] !== 0 || end < bytes.length) return 'covers-partial';
  return 'covers-whole-document';
}

/**
 * Revisions after the signature's own. The chain answers it directly when it reaches the
 * signature's revision; a chain that stops short of it (a newer section whose `/Prev` could
 * not be read) lists only the newest sections and would undercount, so `%%EOF` markers after
 * the covered range answer the same question instead (§7.5.5).
 */
function changesAfterSigning(bytes: Uint8Array, range: ByteRangeTuple, revisions: readonly number[]): number {
  const end = range[2] + range[3];
  const signed = revisions.filter((start) => start <= end).length;
  if (signed > 0) return revisions.length - signed;
  return end < bytes.length ? revisionsAfter(bytes, end) : 0;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * The document's signatures, each with its four separate states. A document without a
 * signature field is an empty list, not an error.
 */
export interface VerifySignaturesOptions {
  /**
   * Certificates the user imported (`pdf-model/trust-roots`). An empty list is a valid
   * call: it produces `not-checked` trust, which is the truth about a document whose
   * chain nobody has vouched for.
   */
  readonly roots?: readonly Uint8Array[];
  /**
   * CRLs the user imported, DER (`pdf-model/revocation-lists`). With none, revocation is read
   * only from what the file itself embeds; with neither it stays `'indeterminate'`.
   */
  readonly crls?: readonly Uint8Array[];
  /** The clock, so a check can pin “expired” to a date instead of to today. */
  readonly now?: Date;
}

export async function verifySignatures(
  bytes: Uint8Array,
  signal?: AbortSignal,
  options: VerifySignaturesOptions = {},
): Promise<readonly SignatureVerification[]> {
  // Every document is asked for its verdicts as soon as it opens: a file whose bytes
  // never name a `/ByteRange` carries no signature a range could cover, and it is
  // answered without loading an engine at all. (A signature dictionary inside a
  // compressed object stream could not cover its own bytes either.)
  if (!mentionsByteRange(bytes)) return [];

  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  let fields: readonly SignatureField[];
  let dss: DssData = { certs: [], crls: [], ocsps: [] };
  try {
    if (doc.needsPassword()) {
      throw new ToolError('encrypted-unsupported', {
        engine: 'mupdf',
        engineMessage: 'verify signatures: the document needs a password to be read',
      });
    }
    fields = collectSignatureFields(doc, signal);
    dss = readDss(doc);
  } catch (error) {
    // `throwIfAborted` raises a plain `Error` named `AbortError`; mapping it would turn
    // a cancellation into a failure the caller has to report.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'verify signatures');
  } finally {
    doc.destroy();
  }
  if (fields.length === 0) return [];

  const scanned = scanByteRanges(bytes);
  const revisions = revisionStarts(bytes);
  const results: SignatureVerification[] = [];
  const now = options.now ?? new Date();
  const roots = options.roots ?? [];

  for (const field of fields) {
    if (signal !== undefined) throwIfAborted(signal);

    const contents = field.contents;
    const range = field.byteRange;
    // A raw entry is only accepted when its four numbers are the ones the object graph read
    // (to float precision): a dictionary that arrived inside an object stream carries numbers
    // for a file this scan never saw, and hashing those ranges would be nonsense.
    const match = range === null ? null : pairedRange(scanned, range);
    if (field.subFilter === TIMESTAMP_SUBFILTER) {
      results.push(
        await verifyTimestampEntry(bytes, field, match, revisions, {
          roots,
          crls: options.crls ?? [],
          dss,
          now,
        }),
      );
      continue;
    }
    const cms = contents === null ? NO_CMS : readCms(contents);
    const certificate = contents === null ? null : cms.certificate;
    // The timestamp, the lists that can speak for the certificates, and the moment the
    // signature is judged at — before the trust walk, because a trusted timestamp is the date
    // the certificate path is validated at. Only the detached formats are verified at all.
    const evidence =
      contents === null || !DETACHED_SUBFILTERS.has(field.subFilter ?? '')
        ? null
        : await (await import('../signature-validation')).evaluateEvidence({
            contents,
            signatureValue: cms.signature,
            signer: certificate?.der ?? new Uint8Array(),
            chain: cms.others,
            claimedAt: isoFromPdfDate(field.signedAt),
            roots,
            importedCrls: options.crls ?? [],
            dss,
            now,
          });
    // The chain walk runs on the certificates the CMS carried, against the imported
    // roots: a verdict about trust is only meaningful when both sides exist.
    /**
     * `signature-trust` carries pkijs and asn1js, and this module is on the **first paint**
     * (the shell asks for the document's verdicts as soon as a document opens). Loading it
     * here keeps ~900 kB of ASN.1 machinery out of the entry chunk — measured: a static
     * import put the entry at 302.66 KiB gzip against a locked ≤ 250 KiB budget.
     */
    const trust =
      contents === null
        ? NO_TRUST
        : await (await import('../signature-trust')).checkTrust({
            signer: certificate?.der ?? new Uint8Array(),
            chain: cms.others,
            roots,
            now: evidence?.trustAt ?? now,
          });
    const facts: SigningFacts = {
      subFilter: field.subFilter ?? '',
      signedAt: isoFromPdfDate(field.signedAt),
      signer:
        contents === null || certificate === null
          ? null
          : commonName(contents, certificate.subject, { nodes: MAX_ASN1_NODES }),
      // `issuer == subject` is the whole of the claim: a locally self-signed
      // certificate. Whether the signature under it verifies is a trust question this
      // build cannot answer (no trust store, no network).
      selfSigned:
        contents !== null &&
        certificate !== null &&
        bytesEqual(tlvBytes(contents, certificate.issuer), tlvBytes(contents, certificate.subject)),
      messageDigest: cms.messageDigest,
      digestAlgorithm: cms.digestAlgorithm,
      signedAttributes: cms.signedAttributes,
      signature: cms.signature,
      signatureAlgorithm: cms.signatureAlgorithm,
      signerKey:
        contents === null || cms.certificate?.spki == null
          ? null
          : {
              spki: tlvBytes(contents, cms.certificate.spki),
              algorithm: cms.certificate.keyAlgorithm,
              curve: cms.certificate.curve,
            },
      trust,
      hasRoots: roots.length > 0,
      evidence,
    };

    results.push(await verifyOne(bytes, field, facts, match, revisions));
  }
  return results;
}
