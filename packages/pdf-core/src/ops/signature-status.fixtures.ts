/**
 * **Test-only.** Raw-bytes builders for `signature-status.test.ts`: DER (so a hostile CMS or
 * certificate can be written one field at a time), a PDF writer that lays down real
 * cross-reference sections (table or stream) and incremental revisions, and fixed-width
 * `/ByteRange` + `/Contents` placeholders that are sealed after the file is written — the
 * way a real signer works, byte for byte.
 *
 * The verifier under test reads the file's own bytes; nothing here goes through MuPDF's
 * writer, so every offset in the file is the one this module computed.
 */

import { fromBER } from 'asn1js';
import { RelativeDistinguishedNames } from 'pkijs';
import { type CertificateFixture, ecdsaRawToDer } from '../signature-trust.fixtures';

/* ------------------------------------------------------------------ *
 * Bytes
 * ------------------------------------------------------------------ */

export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

export function fromLatin1(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export async function digest(
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512',
  bytes: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes.slice()));
}

/** `bytes` with every occurrence of the ASCII run `from` replaced by the same-width run `to`. */
export function swapAscii(bytes: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error('swapAscii keeps the file width');
  return fromLatin1(latin1(bytes).split(from).join(to));
}

/* ------------------------------------------------------------------ *
 * DER
 * ------------------------------------------------------------------ */

function lengthOctets(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  if (length < 0x100) return Uint8Array.of(0x81, length);
  if (length < 0x10000) return Uint8Array.of(0x82, length >> 8, length & 0xff);
  return Uint8Array.of(0x83, length >> 16, (length >> 8) & 0xff, length & 0xff);
}

export function tlv(tag: number, ...content: readonly Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(Uint8Array.of(tag), lengthOctets(body.length), body);
}

export const sequence = (...content: readonly Uint8Array[]): Uint8Array => tlv(0x30, ...content);
export const set = (...content: readonly Uint8Array[]): Uint8Array => tlv(0x31, ...content);
export const octetString = (bytes: Uint8Array): Uint8Array => tlv(0x04, bytes);
export const nullValue = (): Uint8Array => tlv(0x05);
/** `[n]` constructed, context-specific. */
export const contextual = (index: number, ...content: readonly Uint8Array[]): Uint8Array =>
  tlv(0xa0 | index, ...content);
/** An INTEGER carrying exactly these content octets (so a malformed one can be written). */
export const integerBytes = (bytes: Uint8Array): Uint8Array => tlv(0x02, bytes);
export const smallInteger = (value: number): Uint8Array => integerBytes(Uint8Array.of(value));
export const bitString = (bytes: Uint8Array): Uint8Array => tlv(0x03, Uint8Array.of(0), bytes);

export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map(Number);
  const [first = 0, second = 0, ...rest] = arcs;
  const out: number[] = [first * 40 + second];
  for (const arc of rest) {
    const groups: number[] = [arc & 0x7f];
    for (let remaining = Math.floor(arc / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
      groups.unshift((remaining & 0x7f) | 0x80);
    }
    out.push(...groups);
  }
  return tlv(0x06, Uint8Array.from(out));
}

/** `AlgorithmIdentifier` with the given OID and NULL parameters (or none). */
export function algorithmIdentifier(dotted: string, parameters: 'null' | 'none' = 'null'): Uint8Array {
  return sequence(oid(dotted), ...(parameters === 'null' ? [nullValue()] : []));
}

/** A string element: UTF-8 for the UTF8String tag, latin-1 otherwise; raw bytes are written as given. */
export function textString(tag: number, value: string | Uint8Array): Uint8Array {
  if (typeof value !== 'string') return tlv(tag, value);
  return tlv(tag, tag === 0x0c ? new Uint8Array(Buffer.from(value, 'utf8')) : fromLatin1(value));
}

export const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  commonName: '2.5.4.3',
  organizationalUnit: '2.5.4.11',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  md5: '1.2.840.113549.2.5',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  p256: '1.2.840.10045.3.1.7',
  p192: '1.2.840.10045.3.1.1',
  ed25519: '1.3.101.112',
} as const;

/** `Name` with one RDN per entry: `[oid, tag, value]` (a value of any string type). */
export function name(...entries: readonly (readonly [string, number, string | Uint8Array])[]): Uint8Array {
  return sequence(...entries.map(([type, tag, value]) => set(sequence(oid(type), textString(tag, value)))));
}

/** A certificate subject for `issueCertificate`, read from the DER of a hand-written `Name`. */
export function subjectFromDer(der: Uint8Array): RelativeDistinguishedNames {
  return new RelativeDistinguishedNames({ schema: fromBER(der.slice().buffer).result });
}

export const commonNameOf = (value: string): Uint8Array => name([OID.commonName, 0x0c, value]);

/* ------------------------------------------------------------------ *
 * CMS and certificates written by hand
 * ------------------------------------------------------------------ */

/** One signed attribute: `SEQUENCE { type OID, values SET OF ANY }`. */
export function attribute(type: string, ...values: readonly Uint8Array[]): Uint8Array {
  return sequence(oid(type), set(...values));
}

/** `[0] signedAttrs` with `contentType` and (unless `null`) a `messageDigest` attribute. */
export function signedAttributesBlock(messageDigest: Uint8Array | null): Uint8Array {
  return contextual(
    0,
    attribute(OID.contentType, oid(OID.data)),
    ...(messageDigest === null ? [] : [attribute(OID.messageDigest, octetString(messageDigest))]),
  );
}

export interface SignerInfoParts {
  /** The whole `[0]` block; `null` leaves it out. */
  readonly attributes: Uint8Array | null;
  /** The whole `AlgorithmIdentifier`; `null` leaves it out. */
  readonly signatureAlgorithm: Uint8Array | null;
  /** The signature OCTET STRING's content; `null` leaves the OCTET STRING out. */
  readonly signature: Uint8Array | null;
  readonly digestOid?: string;
}

export function signerInfo(parts: SignerInfoParts): Uint8Array {
  return sequence(
    smallInteger(1),
    sequence(commonNameOf('issuer'), smallInteger(1)),
    algorithmIdentifier(parts.digestOid ?? OID.sha256),
    ...(parts.attributes === null ? [] : [parts.attributes]),
    ...(parts.signatureAlgorithm === null ? [] : [parts.signatureAlgorithm]),
    ...(parts.signature === null ? [] : [octetString(parts.signature)]),
  );
}

export interface SignedDataParts {
  /** The `digestAlgorithms` entries; `null` leaves the SET out altogether. */
  readonly digestOids: readonly string[] | null;
  /** The `[0]` certificates; `null` leaves the block out. */
  readonly certificates: readonly Uint8Array[] | null;
  /** The `signerInfos` entries; `null` leaves the SET out altogether. */
  readonly signerInfos: readonly Uint8Array[] | null;
}

export function signedData(parts: SignedDataParts): Uint8Array {
  return sequence(
    smallInteger(1),
    ...(parts.digestOids === null
      ? []
      : [set(...parts.digestOids.map((digestOid) => algorithmIdentifier(digestOid)))]),
    sequence(oid(OID.data)),
    ...(parts.certificates === null ? [] : [contextual(0, ...parts.certificates)]),
    ...(parts.signerInfos === null ? [] : [set(...parts.signerInfos)]),
  );
}

/** `ContentInfo { contentType, [0] EXPLICIT content }`. */
export function contentInfo(
  content: Uint8Array,
  options: { readonly type?: string; readonly wrapperTag?: number } = {},
): Uint8Array {
  return sequence(oid(options.type ?? OID.signedData), tlv(options.wrapperTag ?? 0xa0, content));
}

export interface CertificateParts {
  /** `false` writes a v1-shaped TBSCertificate (no `[0] version`). */
  readonly versioned?: boolean;
  readonly issuer: Uint8Array | null;
  readonly subject: Uint8Array | null;
  /** The whole `SubjectPublicKeyInfo`; `null` leaves it out. */
  readonly spki: Uint8Array | null;
}

/** A certificate-shaped DER whose signature is not one: the CMS walk reads the shape only. */
export function certificateShape(parts: CertificateParts): Uint8Array {
  const validity = sequence(textString(0x17, '260101000000Z'), textString(0x17, '270101000000Z'));
  const fields: Uint8Array[] = [
    ...(parts.versioned === false ? [] : [contextual(0, smallInteger(2))]),
    smallInteger(1),
    algorithmIdentifier(OID.ecdsaSha256, 'none'),
  ];
  if (parts.issuer === null)
    return sequence(sequence(...fields), algorithmIdentifier(OID.ecdsaSha256, 'none'));
  fields.push(parts.issuer, validity);
  if (parts.subject !== null) {
    fields.push(parts.subject);
    if (parts.spki !== null) fields.push(parts.spki);
  }
  return sequence(
    sequence(...fields),
    algorithmIdentifier(OID.ecdsaSha256, 'none'),
    bitString(new Uint8Array(8)),
  );
}

/** `SubjectPublicKeyInfo` whose `AlgorithmIdentifier` holds exactly these children. */
export function spkiWith(...algorithmChildren: readonly Uint8Array[]): Uint8Array {
  return sequence(sequence(...algorithmChildren), bitString(new Uint8Array(8).fill(4)));
}

export type HashName = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

const HASH_OID: Readonly<Record<HashName, string>> = {
  'SHA-1': OID.sha1,
  'SHA-256': OID.sha256,
  'SHA-384': OID.sha384,
  'SHA-512': OID.sha512,
};

export interface HandSignedOptions {
  readonly signer: CertificateFixture;
  readonly chain?: readonly Uint8Array[];
  /** The ByteRange bytes the CMS is over. */
  readonly covered: Uint8Array;
  readonly hash?: HashName;
  /** The signature algorithm OID written into the SignerInfo; ECDSA-with-SHA256 for EC keys, RSA otherwise. */
  readonly signatureOid?: string;
  /** Replaces the `messageDigest` (default: the real digest of `covered`). */
  readonly messageDigest?: Uint8Array;
  /** Picks the raw ECDSA `r || s` the CMS carries: signing repeats until this accepts one. */
  readonly acceptRaw?: (raw: Uint8Array) => boolean;
  /** Replaces the signature value written (after signing). */
  readonly signatureValue?: (signature: Uint8Array) => Uint8Array;
}

/**
 * A complete, genuinely signed detached CMS assembled field by field (so one field can be
 * bent): signed attributes with the real digest, signed with the signer's own key.
 */
export async function handSignedCms(options: HandSignedOptions): Promise<Uint8Array> {
  const hash = options.hash ?? 'SHA-256';
  const key = options.signer.keyPair.privateKey;
  const isEc = key.algorithm.name === 'ECDSA';
  const messageDigest = options.messageDigest ?? (await digest(hash, options.covered));
  const attributes = signedAttributesBlock(messageDigest);
  // RFC 5652 §5.4: the signature is over the SET OF form, not the implicit `[0]` form.
  const signedBytes = attributes.slice();
  signedBytes[0] = 0x31;
  const algorithm: AlgorithmIdentifier | EcdsaParams = isEc
    ? { name: 'ECDSA', hash }
    : { name: 'RSASSA-PKCS1-v1_5' };
  let signature: Uint8Array;
  if (isEc) {
    let raw = new Uint8Array(await crypto.subtle.sign(algorithm, key, signedBytes));
    for (let attempt = 0; options.acceptRaw !== undefined && !options.acceptRaw(raw); attempt += 1) {
      if (attempt > 50_000) throw new Error('no ECDSA signature of the wanted shape in 50000 attempts');
      raw = new Uint8Array(await crypto.subtle.sign(algorithm, key, signedBytes));
    }
    signature = ecdsaRawToDer(raw);
  } else {
    signature = new Uint8Array(await crypto.subtle.sign(algorithm, key, signedBytes));
  }
  const written = options.signatureValue === undefined ? signature : options.signatureValue(signature);
  const signatureOid = options.signatureOid ?? (isEc ? OID.ecdsaSha256 : OID.rsaEncryption);
  return contentInfo(
    signedData({
      digestOids: [HASH_OID[hash]],
      certificates: [options.signer.der, ...(options.chain ?? [])],
      signerInfos: [
        signerInfo({
          attributes,
          signatureAlgorithm: algorithmIdentifier(signatureOid, isEc ? 'none' : 'null'),
          signature: written,
          digestOid: HASH_OID[hash],
        }),
      ],
    }),
  );
}

/* ------------------------------------------------------------------ *
 * PDF files
 * ------------------------------------------------------------------ */

export interface PdfObjectSource {
  readonly number: number;
  /** Everything between `N 0 obj` and `endobj`, as latin-1 text (a stream included). */
  readonly body: string;
}

/** `'none'` writes a bare trailer and no cross-reference section or `startxref` (a reader has to repair the file). */
export type XrefKind = 'table' | 'none' | { readonly stream: number };

export interface Revision {
  readonly objects: readonly PdfObjectSource[];
  /** `/Size` of the trailer. */
  readonly size: number;
  readonly root?: number;
  /** The previous cross-reference section's offset; omitted for the first revision. */
  readonly prev?: number;
  /** Text written into the trailer dictionary as it stands (a second `/Prev`, a decoy string…). */
  readonly trailerExtra?: string;
  readonly xref?: XrefKind;
  /** The whole text after `trailer` (a table's trailer only), verbatim; `null` writes no `trailer` at all. */
  readonly trailer?: string | null;
}

export interface WrittenRevision {
  readonly bytes: Uint8Array;
  /** Where this revision's cross-reference section starts: what `startxref` names. */
  readonly xrefAt: number;
  readonly offsets: ReadonlyMap<number, number>;
}

const HEADER = '%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n';

/** `existing` followed by one more revision: its objects, a cross-reference section, `%%EOF`. */
export function appendRevision(existing: Uint8Array, revision: Revision): WrittenRevision {
  const first = existing.length === 0;
  const base = existing.length;
  let text = first ? HEADER : '';
  const offsets = new Map<number, number>();
  for (const object of revision.objects) {
    offsets.set(object.number, base + text.length);
    text += `${object.number} 0 obj\n${object.body}\nendobj\n`;
  }
  const xrefAt = base + text.length;
  const root = revision.root ?? 1;
  const dictionary = (extra: string): string =>
    `/Size ${revision.size} /Root ${root} 0 R${revision.prev === undefined ? '' : ` /Prev ${revision.prev}`}${
      revision.trailerExtra ?? ''
    }${extra}`;
  const kind = revision.xref ?? 'table';
  const numbers = [...offsets.keys()].sort((left, right) => left - right);
  if (kind === 'none') {
    text += `trailer\n<< ${dictionary('')} >>\n%%EOF\n`;
    return { bytes: concat(existing, fromLatin1(text)), xrefAt, offsets };
  }
  if (kind === 'table') {
    text += 'xref\n';
    if (first) text += '0 1\n0000000000 65535 f \n';
    for (const number of numbers) {
      text += `${number} 1\n${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`;
    }
    if (revision.trailer !== null) {
      text += `trailer\n${revision.trailer ?? `<< ${dictionary('')} >>`}\n`;
    }
  } else {
    offsets.set(kind.stream, xrefAt);
    const listed = [...(first ? [0] : []), ...numbers, kind.stream];
    const data = listed
      .map((number) => {
        if (number === 0) return `\u0000\u0000\u0000\u0000\u0000\u00ff\u00ff`;
        const at = offsets.get(number) ?? 0;
        return `\u0001${String.fromCharCode((at >> 24) & 0xff, (at >> 16) & 0xff, (at >> 8) & 0xff, at & 0xff)}\u0000\u0000`;
      })
      .join('');
    const index = listed.map((number) => `${number} 1`).join(' ');
    text += `${kind.stream} 0 obj\n<< /Type /XRef ${dictionary(` /W [1 4 2] /Index [${index}] /Length ${data.length}`)} >>\nstream\n${data}\nendstream\nendobj\n`;
  }
  text += `startxref\n${xrefAt}\n%%EOF\n`;
  return { bytes: concat(existing, fromLatin1(text)), xrefAt, offsets };
}

export interface DocumentOptions {
  /** Text added to the catalog dictionary (a `/DSS`, say). */
  readonly catalogExtra?: string;
  /** The `/T` of the field; `null` leaves it out. */
  readonly fieldName?: string | null;
  /** Object number of the signature dictionary the field's `/V` names. */
  readonly signatureObject?: number;
}

/**
 * The five objects of a one-page document with one signature field: catalog (1), pages (2),
 * page (3), field + widget (4) and the signature dictionary itself (5).
 */
export function documentObjects(signatureBody: string, options: DocumentOptions = {}): PdfObjectSource[] {
  const name = options.fieldName === null ? '' : ` /T (${options.fieldName ?? 'Sig1'})`;
  return [
    {
      number: 1,
      body: `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /SigFlags 3 >>${options.catalogExtra ?? ''} >>`,
    },
    { number: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { number: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >>' },
    {
      number: 4,
      body: `<< /Type /Annot /Subtype /Widget /FT /Sig${name} /Rect [0 0 0 0] /F 132 /P 3 0 R /V ${options.signatureObject ?? 5} 0 R >>`,
    },
    { number: options.signatureObject ?? 5, body: signatureBody },
  ];
}

/* ------------------------------------------------------------------ *
 * Placeholders, and sealing them
 * ------------------------------------------------------------------ */

export type ContentsEncoding = 'hex' | 'literal';

/** Four ten-digit numbers: wide enough for any offset, and fixed so sealing never moves a byte. */
export const BYTE_RANGE_PLACEHOLDER = `[${Array.from({ length: 4 }, () => '0000000000').join(' ')}]`;

/** The `/Contents` value of `capacity` bytes before it is sealed: hex digits or spaces in a literal string. */
export function contentsPlaceholder(capacity: number, encoding: ContentsEncoding): string {
  return encoding === 'hex' ? `<${'0'.repeat(capacity * 2)}>` : `(${' '.repeat(capacity)})`;
}

export interface SignatureDictionaryOptions {
  readonly capacity: number;
  readonly encoding: ContentsEncoding;
  /** The `/SubFilter` name, `null` for none. */
  readonly subFilter?: string | null;
  /** Written instead of the `/SubFilter /name` entry (a text-string SubFilter, say). */
  readonly subFilterEntry?: string;
  /** The text of `/M` between its parentheses; `null` leaves `/M` out. */
  readonly date?: string | null;
  /** Written between the dictionary's other keys and `/ByteRange`. */
  readonly extra?: string;
  /** `'contents-first'` writes `/Contents` before `/ByteRange`. */
  readonly order?: 'range-first' | 'contents-first';
}

/** The signature dictionary a signer writes: both placeholders. */
export function signatureDictionary(options: SignatureDictionaryOptions): string {
  const subFilter =
    options.subFilterEntry ??
    (options.subFilter === null ? '' : ` /SubFilter /${options.subFilter ?? 'adbe.pkcs7.detached'}`);
  const date = options.date === null ? '' : ` /M (${options.date ?? 'D:20260601120000Z'})`;
  const range = `/ByteRange ${BYTE_RANGE_PLACEHOLDER}`;
  const contents = `/Contents ${contentsPlaceholder(options.capacity, options.encoding)}`;
  const keys = options.order === 'contents-first' ? `${contents} ${range}` : `${range} ${contents}`;
  return `<< /Type /Sig /Filter /Adobe.PPKLite${subFilter}${date}${options.extra ?? ''} ${keys} >>`;
}

/**
 * A literal string's bytes (§7.3.4.2): backslashes and carriage returns always escaped;
 * parentheses escaped (`'all'`) or, when they pair up, left bare for the reader to count
 * (`'balanced'` — only the unpaired ones are escaped).
 */
export function escapeLiteral(bytes: Uint8Array, parentheses: 'all' | 'balanced' = 'all'): string {
  const paired = new Set<number>();
  if (parentheses === 'balanced') {
    const open: number[] = [];
    bytes.forEach((byte, index) => {
      if (byte === 0x28) open.push(index);
      else if (byte === 0x29) {
        const match = open.pop();
        if (match !== undefined) {
          paired.add(match);
          paired.add(index);
        }
      }
    });
  }
  let out = '';
  bytes.forEach((byte, index) => {
    const parenthesis = byte === 0x28 || byte === 0x29;
    if (byte === 0x5c || (parenthesis && !paired.has(index))) out += `\\${String.fromCharCode(byte)}`;
    else if (byte === 0x0d) out += '\\r';
    else out += String.fromCharCode(byte);
  });
  return out;
}

export interface SealOptions {
  readonly capacity: number;
  readonly encoding: ContentsEncoding;
  /** Where to start looking for the placeholders (the signature object's offset). */
  readonly from?: number;
  /** The end of the signed range: the end of the file by default. */
  readonly end?: number;
  /** How a literal string escapes parentheses; `escapeLiteral`'s default. */
  readonly parentheses?: 'all' | 'balanced';
}

/**
 * Fills the first unsealed placeholders at or after `from`: the `/ByteRange` with the two
 * ranges around the `/Contents` value, and the `/Contents` with whatever `produce` answers
 * for the covered bytes (zero-padded in hex, space-padded in a literal string).
 */
export async function seal(
  bytes: Uint8Array,
  options: SealOptions,
  produce: (covered: Uint8Array) => Promise<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  const text = latin1(bytes);
  const from = options.from ?? 0;
  const rangeAt = text.indexOf(BYTE_RANGE_PLACEHOLDER, from);
  const placeholder = contentsPlaceholder(options.capacity, options.encoding);
  const contentsAt = text.indexOf(placeholder, from);
  if (rangeAt < 0 || contentsAt < 0) throw new Error('no placeholder to seal');
  const contentsEnd = contentsAt + placeholder.length;
  const end = options.end ?? bytes.length;
  const range = [0, contentsAt, contentsEnd, end - contentsEnd];
  const out = bytes.slice();
  out.set(fromLatin1(`[${range.map((value) => String(value).padStart(10, '0')).join(' ')}]`), rangeAt);
  const covered = concat(out.subarray(0, contentsAt), out.subarray(contentsEnd, end));
  const produced = await produce(covered);
  if (produced.length > options.capacity) throw new Error('the signature does not fit its placeholder');
  const value =
    options.encoding === 'hex'
      ? `<${Buffer.from(produced)
          .toString('hex')
          .padEnd(options.capacity * 2, '0')}>`
      : `(${escapeLiteral(produced, options.parentheses)})`.padEnd(placeholder.length, ' ');
  if (value.length !== placeholder.length)
    throw new Error('the escaped signature does not fit its placeholder');
  out.set(fromLatin1(value), contentsAt);
  return out;
}
