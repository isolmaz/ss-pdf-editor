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
 */

import type { BaseBlock } from 'asn1js';
import { fromBER } from 'asn1js';
import type { Attribute, SignerInfo } from 'pkijs';
import { ContentInfo, SignedData } from 'pkijs';

const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
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

/** The DER of an asn1js value, or `null` when it cannot be re-encoded. */
function derOf(block: BaseBlock): Uint8Array | null {
  try {
    return new Uint8Array(block.toBER(false));
  } catch {
    return null;
  }
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
      const der = derOf(item);
      if (der !== null) (tagNumber === 0 ? into.crls : into.ocsps).push(der);
    }
  }
}

/** The attribute values of one type among signed and unsigned attributes. */
function attributesOf(signer: SignerInfo): readonly Attribute[] {
  return [...(signer.signedAttrs?.attributes ?? []), ...(signer.unsignedAttrs?.attributes ?? [])];
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
        const der = derOf(entry.otherRevInfo as BaseBlock);
        if (der !== null) ocsps.push(der);
      }
    } catch {
      // Skipped, like any other unreadable revocation entry.
    }
  }

  const tokens: Uint8Array[] = [];
  let signingTime: Date | null = null;
  const signer = signedData.signerInfos.find((info) => info.signedAttrs !== undefined);
  if (signer !== undefined) {
    for (const attribute of attributesOf(signer)) {
      const [value] = attribute.values;
      if (value === undefined) continue;
      if (attribute.type === OID_TIMESTAMP_TOKEN) {
        for (const token of attribute.values.slice(0, MAX_ITEMS)) {
          const der = derOf(token as BaseBlock);
          if (der !== null) tokens.push(der);
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
