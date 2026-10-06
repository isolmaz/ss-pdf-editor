/**
 * RFC 3161 timestamp tokens, verified **offline** (“signature timestamps and document
 * timestamps, read from the file”).
 *
 * A timestamp is a third party's signed statement “this hash existed at this time”. This
 * build never asks a time-stamping authority for one (no network); it checks the ones that are
 * already in the file:
 *
 *  - a **signature timestamp** — the unsigned attribute `id-aa-signatureTimeStampToken` of a
 *    CMS signature, whose message imprint is the hash of that signature's *value*;
 *  - a **document timestamp** — a signature dictionary with `/SubFilter /ETSI.RFC3161`, whose
 *    `/Contents` is the token itself and whose imprint is the hash of the `/ByteRange` bytes.
 *
 * What is checked, in this order, each one a separate reason when it fails:
 *  1. the token is a CMS `SignedData` whose content is a `TSTInfo` (RFC 3161 §2.4.2);
 *  2. the `TSTInfo.messageImprint` equals the hash of the data it is meant to cover, with the
 *     hash the token itself names;
 *  3. the CMS signature: `messageDigest` over the `TSTInfo`, then the signature over the signed
 *     attributes, with the TSA certificate the token carries (found by its `sid`);
 *  4. the TSA certificate: `extKeyUsage` contains `id-kp-timeStamping` (RFC 3161 §2.3), and the
 *     certificate was inside its validity window **at `genTime`** — a time-stamping
 *     certificate that has since expired is the normal case, an expired one at issue is not;
 *  5. the TSA's trust path against the user's imported roots, evaluated at `genTime`, and its
 *     certificates' revocation against the lists on the device.
 *
 * `status` says whether the token is cryptographically what it claims; `trusted` says whether
 * its **time** may be used to judge the signature it stamps. They differ on purpose: a token
 * from a TSA nobody imported verifies, and shows its time, but anyone can run such a TSA — so
 * it does not earn the claim "the signature existed before the certificate was revoked".
 */

import { fromBER, ObjectIdentifier, OctetString } from 'asn1js';
import type { Certificate, SignerInfo } from 'pkijs';
import { IssuerAndSerialNumber, Certificate as PkijsCertificate, TSTInfo } from 'pkijs';
import { readSignedData } from './signature-evidence';
import {
  checkRevocation,
  extendedKeyUsage,
  type RevocationCertCheck,
  type RevocationSources,
} from './signature-revocation';
import {
  certificateName,
  checkTrust,
  type TrustReason,
  type TrustVerdict,
  validityOf,
  verifyDataSignature,
} from './signature-trust';

const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_KP_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const OID_EXT_KEY_USAGE = '2.5.29.37';

const HASHES: Readonly<Record<string, string>> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

export type TimestampKind = 'signature' | 'document';

/** `invalid` — a check ran and failed; `unchecked` — this build could not run it. */
export type TimestampStatus = 'valid' | 'invalid' | 'unchecked';

export type TimestampReason =
  | 'malformed'
  | 'imprint-mismatch'
  | 'unsupported-hash'
  | 'no-tsa-certificate'
  | 'digest-mismatch'
  | 'bad-signature'
  | 'unsupported-signature'
  | 'tsa-key-usage'
  | 'tsa-validity';

export interface TimestampCheck {
  readonly kind: TimestampKind;
  readonly status: TimestampStatus;
  readonly reason: TimestampReason | null;
  /** The time the TSA vouches for, ISO; `null` when the token could not be read that far. */
  readonly genTime: string | null;
  /** The TSA certificate's common name. */
  readonly tsa: string | null;
  /** The hash the token's imprint uses. */
  readonly hashAlgorithm: string | null;
  readonly tsaTrust: TrustVerdict;
  readonly tsaTrustReason: TrustReason | null;
  readonly tsaPath: readonly string[];
  /** `notAfter` of the TSA certificate, ISO. */
  readonly tsaNotAfter: string | null;
  /** The TSA certificate signed itself — a fact about the certificate, not a verdict. */
  readonly tsaSelfSigned: boolean;
  /** The TSA certificate chain's revocation answers, from the lists on the device. */
  readonly tsaRevocation: readonly RevocationCertCheck[];
  /** The token is valid, its TSA reaches an imported root and none of its certificates is revoked. */
  readonly trusted: boolean;
}

function failure(
  kind: TimestampKind,
  status: TimestampStatus,
  reason: TimestampReason,
  partial: Partial<TimestampCheck> = {},
): TimestampCheck {
  return {
    kind,
    status,
    reason,
    genTime: null,
    tsa: null,
    hashAlgorithm: null,
    tsaTrust: 'not-checked',
    tsaTrustReason: null,
    tsaPath: [],
    tsaNotAfter: null,
    tsaSelfSigned: false,
    tsaRevocation: [],
    trusted: false,
    ...partial,
  };
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** The content octets of an OCTET STRING, joining the segments of a constructed (BER) one. */
function octets(value: OctetString): Uint8Array {
  const block = value.valueBlock as unknown as { isConstructed?: boolean; value?: OctetString[] };
  if (block.isConstructed === true && Array.isArray(block.value)) {
    const parts = block.value.map(octets);
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
  return new Uint8Array(value.valueBlock.valueHexView);
}

/** The key identifier a certificate declares, or `null`. */
function subjectKeyIdentifier(certificate: Certificate): Uint8Array | null {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_SUBJECT_KEY_IDENTIFIER);
  if (extension === undefined) return null;
  const parsed = fromBER(buffer(new Uint8Array(extension.extnValue.valueBlock.valueHexView)));
  return parsed.offset >= 0 && parsed.result instanceof OctetString ? octets(parsed.result) : null;
}

/** The certificate a `SignerInfo` names (`IssuerAndSerialNumber` or `[0]` key identifier). */
function certificateFor(signer: SignerInfo, certificates: readonly Certificate[]): Certificate | null {
  const sid = signer.sid;
  if (sid instanceof IssuerAndSerialNumber) {
    return (
      certificates.find(
        (candidate) =>
          candidate.issuer.isEqual(sid.issuer) && candidate.serialNumber.isEqual(sid.serialNumber),
      ) ?? null
    );
  }
  if (sid instanceof OctetString) {
    const wanted = octets(sid);
    return (
      certificates.find((candidate) => {
        const identifier = subjectKeyIdentifier(candidate);
        return identifier !== null && sameBytes(identifier, wanted);
      }) ?? null
    );
  }
  return null;
}

/** The value of one signed attribute of `signer`, as the asn1js node. */
function signedAttribute(signer: SignerInfo, oid: string): unknown {
  return signer.signedAttrs?.attributes.find((attribute) => attribute.type === oid)?.values[0];
}

export interface VerifyTimestampInput {
  readonly kind: TimestampKind;
  /** The token: a `ContentInfo` DER, trailing zero padding allowed. */
  readonly token: Uint8Array;
  /** The bytes the token's imprint must be the hash of. */
  readonly covered: Uint8Array;
  /** Other certificates known for this signature (the `/DSS`, the signature's own). */
  readonly pool?: readonly Uint8Array[];
  readonly roots?: readonly Uint8Array[];
  readonly sources: RevocationSources;
  readonly now: Date;
}

export async function verifyTimestampToken(input: VerifyTimestampInput): Promise<TimestampCheck> {
  const { kind } = input;
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return failure(kind, 'unchecked', 'unsupported-signature');

  const signedData = readSignedData(input.token);
  const content = signedData?.encapContentInfo;
  if (signedData === null || content === undefined || content.eContentType !== OID_TST_INFO) {
    return failure(kind, 'unchecked', 'malformed');
  }
  const eContent = content.eContent;
  if (eContent === undefined) return failure(kind, 'unchecked', 'malformed');
  const tstBytes = octets(eContent);
  let info: TSTInfo;
  try {
    info = TSTInfo.fromBER(buffer(tstBytes));
  } catch {
    return failure(kind, 'unchecked', 'malformed');
  }
  const genTime = info.genTime;
  const base = { genTime: genTime.toISOString() };

  // 2. The imprint, with the hash the token names.
  const hash = HASHES[info.messageImprint.hashAlgorithm.algorithmId];
  if (hash === undefined) return failure(kind, 'unchecked', 'unsupported-hash', base);
  const covered = new Uint8Array(await subtle.digest(hash, buffer(input.covered)));
  const named = { ...base, hashAlgorithm: hash };
  if (!sameBytes(covered, octets(info.messageImprint.hashedMessage))) {
    return failure(kind, 'invalid', 'imprint-mismatch', named);
  }

  // 3. The CMS signature, with the TSA certificate the token carries.
  const certificates: Certificate[] = [];
  for (const entry of signedData.certificates ?? [])
    if (entry instanceof PkijsCertificate) certificates.push(entry);
  const signer = signedData.signerInfos[0];
  const tsa = signer === undefined ? null : certificateFor(signer, certificates);
  if (signer === undefined || tsa === null) return failure(kind, 'unchecked', 'no-tsa-certificate', named);
  const tsaName = certificateName(tsa);
  const withTsa = { ...named, tsa: tsaName };

  const digestHash = HASHES[signer.digestAlgorithm.algorithmId];
  let signed: Uint8Array;
  if (signer.signedAttrs === undefined) {
    // No signed attributes: the signature is over the content itself (RFC 5652 §5.4).
    signed = tstBytes;
  } else {
    if (digestHash === undefined) return failure(kind, 'unchecked', 'unsupported-hash', withTsa);
    const attributeType = signedAttribute(signer, OID_CONTENT_TYPE);
    const attributeDigest = signedAttribute(signer, OID_MESSAGE_DIGEST);
    if (
      !(attributeType instanceof ObjectIdentifier) ||
      attributeType.getValue() !== OID_TST_INFO ||
      !(attributeDigest instanceof OctetString)
    ) {
      return failure(kind, 'invalid', 'digest-mismatch', withTsa);
    }
    const contentDigest = new Uint8Array(await subtle.digest(digestHash, buffer(tstBytes)));
    if (!sameBytes(contentDigest, octets(attributeDigest))) {
      return failure(kind, 'invalid', 'digest-mismatch', withTsa);
    }
    // RFC 5652 §5.4: the signature covers the attributes with the universal `SET OF` tag,
    // not the implicit `[0]` they are stored under (the same rule `signature-status` applies).
    signed = new Uint8Array(signer.signedAttrs.encodedValue.slice(0));
    signed[0] = 0x31;
  }
  const outcome = await verifyDataSignature(
    subtle,
    tsa,
    signer.signatureAlgorithm.algorithmId,
    new Uint8Array(signer.signature.valueBlock.valueHexView),
    signed,
    digestHash,
  );
  if (outcome === 'unsupported') return failure(kind, 'unchecked', 'unsupported-signature', withTsa);
  if (outcome !== 'ok') return failure(kind, 'invalid', 'bad-signature', withTsa);

  // 4. The TSA certificate: allowed to stamp, and valid when it did.
  if (!(extendedKeyUsage(tsa)?.includes(OID_KP_TIME_STAMPING) ?? false)) {
    return failure(kind, 'invalid', 'tsa-key-usage', withTsa);
  }
  if (validityOf(tsa, genTime) !== 'valid') return failure(kind, 'invalid', 'tsa-validity', withTsa);

  // 5. Whether the user vouches for the TSA, and whether anything in its chain is revoked.
  const tsaDer = new Uint8Array(tsa.toSchema().toBER(false));
  const others = certificates.map((entry) => new Uint8Array(entry.toSchema().toBER(false)));
  const pool = [...others, ...(input.pool ?? [])];
  const trust = await checkTrust({
    signer: tsaDer,
    chain: pool,
    roots: input.roots ?? [],
    now: genTime,
    // RFC 3161 §2.3: the TSA certificate's `extKeyUsage` is critical; step 4 above enforces it.
    leafCriticalExtensions: [OID_EXT_KEY_USAGE],
  });
  const tsaRevocation = await checkRevocation({
    leaf: tsaDer,
    leafRole: 'timestamp',
    pool: [...pool, ...(input.roots ?? [])],
    context: { sources: input.sources, validationTime: genTime, now: input.now },
  });
  return {
    kind,
    status: 'valid',
    reason: null,
    ...withTsa,
    tsaTrust: trust.verdict,
    tsaTrustReason: trust.reason,
    tsaPath: trust.path,
    tsaNotAfter: tsa.notAfter.value.toISOString(),
    tsaSelfSigned: tsa.issuer.isEqual(tsa.subject),
    tsaRevocation,
    trusted: trust.verdict === 'trusted' && !tsaRevocation.some((check) => check.status === 'revoked'),
  };
}
