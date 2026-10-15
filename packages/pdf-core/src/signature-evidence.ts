/**
 * What a signature's CMS carries besides the signature itself: the timestamp token, the
 * revocation data and the signing time (“RFC 3161 timestamps and revocation read from the
 * file, offline”).
 *
 * `ops/signature-status.ts` walks the CMS by hand for the facts the integrity check needs and
 * must stay light, because it runs when a document opens. The attributes here are the other
 * half — unsigned attributes, nested `ContentInfo`s, `RevocationInfoArchival` — and are read
 * with `pkijs`, which is why this module is loaded lazily, next to `signature-trust`, and
 * never from the shell.
 *
 * Where each thing lives:
 *  - the signature timestamp is the **unsigned** attribute `id-aa-signatureTimeStampToken`
 *    (RFC 3161 §A, ETSI EN 319 142), a complete `ContentInfo` holding a `TimeStampToken`;
 *  - Adobe's revocation data is the attribute `adbe-revocationInfoArchival`
 *    (`1.2.840.113583.1.1.8`), in the signed attributes for the signatures Acrobat writes and in
 *    the unsigned ones for some producers, so **both** positions are read;
 *  - CRLs may also sit in `SignedData.crls` (RFC 5652 §5.1), and an OCSP response there is an
 *    `OtherRevocationInfoFormat` with `id-ri-ocsp-response`.
 *
 * Nothing here decides whether anything is *valid*; it only finds the bytes. A malformed
 * attribute is skipped, never fatal: a file whose revocation archive cannot be read still has
 * a signature to report.
 *
 * It also answers which certificate of a CMS **signed** it: the one a `SignerInfo` names by its
 * `sid` (RFC 5652 §5.3), never "the first one the set happens to list" — the set is unordered
 * and a producer may list the CA before the signer. The matching is shared with the timestamp
 * check, which finds its TSA certificate the same way.
 */

import type { BaseBlock } from 'asn1js';
import { fromBER, OctetString } from 'asn1js';
import type { SignerInfo } from 'pkijs';
import { Certificate, ContentInfo, IssuerAndSerialNumber, SignedData } from 'pkijs';
import { parseAsn1 } from './signature-trust';

const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';
const OID_REVOCATION_ARCHIVAL = '1.2.840.113583.1.1.8';
const OID_OCSP_RESPONSE_FORMAT = '1.3.6.1.5.5.7.16.2';

/** Defensive bounds: a signature this crowded is hostile, and nothing legitimate needs more. */
const MAX_ITEMS = 64;

export interface SignatureEvidence {
  /** Every certificate the CMS carried, DER. */
  readonly certificates: readonly Uint8Array[];
  /** Signature timestamp tokens (`ContentInfo` DER), normally zero or one. */
  readonly timestampTokens: readonly Uint8Array[];
  /** CRLs found in the CMS (`SignedData.crls` and the Adobe archive), DER. */
  readonly crls: readonly Uint8Array[];
  /** OCSP responses found in the CMS (`OCSPResponse` DER). */
  readonly ocspResponses: readonly Uint8Array[];
  /** The `signingTime` signed attribute, when present and readable. */
  readonly signingTime: Date | null;
}

export const NO_EVIDENCE: SignatureEvidence = {
  certificates: [],
  timestampTokens: [],
  crls: [],
  ocspResponses: [],
  signingTime: null,
};

/** A fresh `Uint8Array` over exactly `bytes`' window — pkijs keeps the buffer it is given. */
function copyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** The DER of an asn1js value. A block that was parsed always re-encodes, so this cannot fail. */
function derOf(block: BaseBlock): Uint8Array {
  return new Uint8Array(block.toBER(false));
}

/** The length the first TLV of `bytes` declares: `/Contents` is zero-padded past it. */
function firstTlvLength(bytes: Uint8Array): number | null {
  const parsed = fromBER(copyOf(bytes).buffer as ArrayBuffer);
  return parsed.offset < 0 ? null : parsed.offset;
}

/** `SignedData` out of a `ContentInfo` DER, or `null` when it is not one. */
export function readSignedData(der: Uint8Array): SignedData | null {
  try {
    const length = firstTlvLength(der);
    if (length === null) return null;
    const exact = copyOf(der.subarray(0, length));
    const info = ContentInfo.fromBER(exact);
    return new SignedData({ schema: info.content });
  } catch {
    return null;
  }
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** The content octets of an OCTET STRING, or of a block tagged in its place, joining the segments of a constructed (BER) one. */
export function octets(value: BaseBlock): Uint8Array {
  if (!value.idBlock.isConstructed) {
    // asn1js: a primitive block always carries its content octets as `valueHexView`.
    const primitive = value.valueBlock as unknown as { valueHexView: Uint8Array };
    return new Uint8Array(primitive.valueHexView);
  }
  // asn1js: a constructed block always carries its members as `value`.
  const constructed = value.valueBlock as unknown as { value: BaseBlock[] };
  const parts = constructed.value.map(octets);
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The key identifier a certificate declares, or `null`. */
function subjectKeyIdentifier(certificate: Certificate): Uint8Array | null {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_SUBJECT_KEY_IDENTIFIER);
  if (extension === undefined) return null;
  const parsed = parseAsn1(new Uint8Array(extension.extnValue.valueBlock.valueHexView));
  return parsed !== null && parsed.result instanceof OctetString ? octets(parsed.result) : null;
}

/** The X.509 certificates of a `SignedData`, in the order it lists them; other certificate formats are not certificates. */
export function certificatesOf(signedData: SignedData): Certificate[] {
  const certificates: Certificate[] = [];
  for (const entry of signedData.certificates ?? []) {
    if (entry instanceof Certificate) certificates.push(entry);
  }
  return certificates;
}

/** The certificate a `SignerInfo` names (`IssuerAndSerialNumber` or `[0]` key identifier). */
export function certificateFor(signer: SignerInfo, certificates: readonly Certificate[]): Certificate | null {
  // `SignerIdentifier` is a CHOICE of those two, and the pkijs schema admits nothing else. A
  // `[0]` key identifier stays the tagged block it was read as: it is never an `OctetString`.
  const sid = signer.sid as IssuerAndSerialNumber | BaseBlock;
  if (sid instanceof IssuerAndSerialNumber) {
    return (
      certificates.find(
        (candidate) =>
          candidate.issuer.isEqual(sid.issuer) && candidate.serialNumber.isEqual(sid.serialNumber),
      ) ?? null
    );
  }
  const wanted = octets(sid);
  return (
    certificates.find((candidate) => {
      const identifier = subjectKeyIdentifier(candidate);
      return identifier !== null && sameBytes(identifier, wanted);
    }) ?? null
  );
}

/**
 * Which certificate signed a CMS, as a position among its X.509 certificates (the order
 * {@link certificatesOf} lists them, which is the order of the `SEQUENCE`-tagged entries of
 * `SignedData.certificates`): `found` when the `sid` of the `SignerInfo` that carries signed
 * attributes — the one `ops/signature-status.ts` verifies — names one of them, `absent` when
 * it names none, and `unreadable` when this reader cannot parse the CMS (or it has no such
 * `SignerInfo`), so nothing is known about its `sid`.
 */
export type SignerCertificate =
  | { readonly status: 'found'; readonly index: number }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' };

export function signerCertificate(contents: Uint8Array): SignerCertificate {
  const signedData = readSignedData(contents);
  const signer = signedData?.signerInfos.find((info) => info.signedAttrs !== undefined);
  if (signedData === null || signer === undefined) return { status: 'unreadable' };
  const certificates = certificatesOf(signedData);
  const named = certificateFor(signer, certificates);
  return named === null ? { status: 'absent' } : { status: 'found', index: certificates.indexOf(named) };
}

/** The members of an asn1js constructed value; empty for anything else. */
function membersOf(block: BaseBlock | undefined): BaseBlock[] {
  const value = (block as { valueBlock?: { value?: unknown } } | undefined)?.valueBlock?.value;
  return Array.isArray(value) ? (value as BaseBlock[]) : [];
}

function tagOf(block: BaseBlock): { readonly tagClass: number; readonly tagNumber: number } {
  const id = (block as unknown as { idBlock: { tagClass: number; tagNumber: number } }).idBlock;
  return { tagClass: id.tagClass, tagNumber: id.tagNumber };
}

/**
 * `RevocationInfoArchival ::= SEQUENCE { crl [0] EXPLICIT SEQUENCE OF CRL OPTIONAL,
 * ocsp [1] EXPLICIT SEQUENCE OF OCSPResponse OPTIONAL, otherRevInfo [2] … }`.
 */
function readArchival(value: BaseBlock | undefined, into: { crls: Uint8Array[]; ocsps: Uint8Array[] }): void {
  for (const section of membersOf(value)) {
    const { tagClass, tagNumber } = tagOf(section);
    if (tagClass !== 3 || (tagNumber !== 0 && tagNumber !== 1)) continue;
    // `[n] EXPLICIT SEQUENCE OF …`: the context tag wraps one SEQUENCE whose members are items.
    const list = membersOf(section)[0];
    for (const item of membersOf(list).slice(0, MAX_ITEMS)) {
      (tagNumber === 0 ? into.crls : into.ocsps).push(derOf(item));
    }
  }
}

/**
 * The evidence in a signature's `/Contents`. `null` when the blob is not a CMS `SignedData`
 * at all (the caller then has nothing to add and says nothing).
 */
export function readSignatureEvidence(contents: Uint8Array): SignatureEvidence | null {
  const signedData = readSignedData(contents);
  if (signedData === null) return null;

  const certificates: Uint8Array[] = [];
  for (const entry of signedData.certificates ?? []) {
    // `OtherCertificateFormat` has no `toSchema` that makes a certificate; only real ones count.
    if ('tbsView' in entry) {
      try {
        certificates.push(new Uint8Array(entry.toSchema().toBER(false)));
      } catch {
        // An unencodable certificate is not a chain candidate.
      }
    }
  }

  const crls: Uint8Array[] = [];
  const ocsps: Uint8Array[] = [];
  for (const entry of signedData.crls ?? []) {
    try {
      if ('tbsView' in entry) crls.push(new Uint8Array(entry.toSchema().toBER(false)));
      else if (entry.otherRevInfoFormat === OID_OCSP_RESPONSE_FORMAT) {
        ocsps.push(derOf(entry.otherRevInfo as BaseBlock));
      }
    } catch {
      // Skipped, like any other unreadable revocation entry.
    }
  }

  const tokens: Uint8Array[] = [];
  let signingTime: Date | null = null;
  const signer = signedData.signerInfos.find((info) => info.signedAttrs !== undefined);
  if (signer?.signedAttrs !== undefined) {
    for (const attribute of [...signer.signedAttrs.attributes, ...(signer.unsignedAttrs?.attributes ?? [])]) {
      // pkijs leaves `values` unset when the attribute carries an empty SET.
      const values: readonly unknown[] = attribute.values ?? [];
      const [value] = values;
      if (value === undefined) continue;
      if (attribute.type === OID_TIMESTAMP_TOKEN) {
        // The bound is on the whole signature, not on each attribute: a CMS can repeat the
        // attribute, and every token kept is verified in full by the caller.
        for (const token of values) {
          if (tokens.length >= MAX_ITEMS) break;
          tokens.push(derOf(token as BaseBlock));
        }
      } else if (attribute.type === OID_REVOCATION_ARCHIVAL) {
        readArchival(value as BaseBlock, { crls, ocsps });
      } else if (attribute.type === OID_SIGNING_TIME) {
        const date = (value as { toDate?: () => Date }).toDate?.();
        if (date !== undefined && !Number.isNaN(date.getTime())) signingTime = date;
      }
    }
  }
  return {
    certificates: certificates.slice(0, MAX_ITEMS),
    timestampTokens: tokens,
    crls: crls.slice(0, MAX_ITEMS),
    ocspResponses: ocsps.slice(0, MAX_ITEMS),
    signingTime,
  };
}
