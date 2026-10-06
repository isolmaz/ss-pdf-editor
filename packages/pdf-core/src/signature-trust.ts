/**
 * Certificate trust, decided **locally** against roots the user imported (`PLAN.md §5`
 * Phase 4: “certificate validation against user-imported trust roots (no online service)”;
 * `K9`, `K17`).
 *
 * There is no trust store in the browser and no network to ask: a certificate is trusted
 * here only because a certificate the user put in the list signs it, and the path is
 * validated the way RFC 5280 §6.1 says a path is validated — signatures checked
 * cryptographically over the child's `tbsCertificate`, every issuer's validity window and
 * CA constraints enforced, path length bounded, and name constraints applied to every
 * subordinate certificate. A name match is never enough.
 *
 * **What it cannot say.** A signature that verifies against an imported root is trusted
 * *by that root* — nothing more. Revocation is a question for a CRL or an OCSP responder
 * and this build has neither (`SignatureRevocation` is always `'indeterminate'`), and a
 * certificate that expired last week may have been revoked yesterday. The verdicts here
 * therefore name the root they reached (`path`), and the caller shows it.
 *
 * **Three answers, not two.** “The chain is broken” and “this build cannot finish the
 * check” are different facts, and collapsing them into `untrusted` would state something
 * the evidence does not support. A certificate signed with an algorithm this module does
 * not implement, an unsupported *critical* extension, or a malformed structure is
 * `'indeterminate'` with a `reason`; only a check that actually ran and failed is
 * `'untrusted'`. Policy processing (RFC 5280 §6.1.5) is deliberately **not** implemented,
 * so a critical policy extension lands in the same honest bucket rather than pretending
 * to be validated. What each reason means:
 *
 * - `'unsupported-signature'` — the certificate's signature algorithm, or the curve under
 *   it, is not one of the ones WebCrypto can verify here.
 * - `'unsupported-critical-extension'` — the certificate carries a critical extension this
 *   validator does not act on, which RFC 5280 §4.2 forbids it to ignore.
 * - `'malformed'` — a certificate or a signature value could not be decoded.
 * - `'no-issuer'` — no certificate in the pool names itself the issuer.
 * - `'signature-mismatch'` — a candidate issuer's key does not verify its subject.
 * - `'validity'` — a certificate in the path is expired or not yet valid at the check date.
 * - `'not-a-ca'` — an issuer has no `basicConstraints` with `cA` set.
 * - `'key-usage'` — an issuer's `keyUsage` is present and does not assert `keyCertSign`.
 * - `'path-length'` — an issuer's `pathLenConstraint` is exceeded.
 * - `'name-constraint'` — a subordinate certificate's names fall outside the permitted
 *   subtrees, or inside an excluded one.
 * - `'no-roots'` — the user has imported nothing, so there is nothing to check against.
 */

import type { FromBerResult } from 'asn1js';
import { fromBER, Integer, ObjectIdentifier, Sequence } from 'asn1js';
import { BasicConstraints, Certificate, NameConstraints } from 'pkijs';

/** A depth limit, because a chain longer than this is either broken or hostile. */
const MAX_DEPTH = 8;
/** The import of one SPKI per check is the only allocation worth bounding. */
const MAX_CANDIDATES = 32;

/** The signature algorithms a certificate may be signed with, named by their OID. */
const CERTIFICATE_SIGNATURE_HASH: Record<string, string> = {
  '1.2.840.113549.1.1.5': 'SHA-1',
  '1.2.840.113549.1.1.11': 'SHA-256',
  '1.2.840.113549.1.1.12': 'SHA-384',
  '1.2.840.113549.1.1.13': 'SHA-512',
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
  '1.2.840.10045.4.3.4': 'SHA-512',
};

const RSA_KEY = '1.2.840.113549.1.1.1';
const EC_KEY = '1.2.840.10045.2.1';

const CURVE_OIDS: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

/**
 * The field width of each curve, in bytes — the width WebCrypto's ECDSA signature
 * representation is fixed to. P-521 is 521 bits, which is 66 bytes and **not** the 64 a
 * byte-count of the curve's name would suggest.
 */
const CURVE_FIELD_BYTES: Record<string, number> = { 'P-256': 32, 'P-384': 48, 'P-521': 66 };

const OID_COMMON_NAME = '2.5.4.3';
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_NAME_CONSTRAINTS = '2.5.29.30';
const OID_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';

/**
 * The critical extensions this validator *acts on*, and the only ones it may ignore.
 *
 * RFC 5280 §4.2: “A certificate-using system MUST reject the certificate if it encounters
 * a critical extension it does not recognize or a critical extension that it recognizes
 * but cannot process.” Everything outside this set — including `certificatePolicies`,
 * `policyConstraints` and `inhibitAnyPolicy`, whose processing is not implemented here —
 * therefore makes a path `indeterminate`. That is a refusal to answer, never a claim.
 */
const APPLIED_CRITICAL_EXTENSIONS: Readonly<Record<string, true>> = {
  [OID_SUBJECT_KEY_IDENTIFIER]: true,
  [OID_KEY_USAGE]: true,
  [OID_SUBJECT_ALT_NAME]: true,
  [OID_BASIC_CONSTRAINTS]: true,
  [OID_NAME_CONSTRAINTS]: true,
  [OID_AUTHORITY_KEY_IDENTIFIER]: true,
};

/** Key-usage bit numbers, in the order RFC 5280 §4.2.1.3 assigns them. */
const KEY_USAGE_KEY_CERT_SIGN = 5;

export type TrustVerdict = 'trusted' | 'untrusted' | 'self-signed' | 'indeterminate' | 'not-checked';
export type CertificateValidity = 'valid' | 'expired' | 'not-yet-valid' | 'unknown';

/** Why the verdict came out the way it did; `null` when the verdict is `'trusted'`. */
export type TrustReason =
  | 'no-roots'
  | 'no-issuer'
  | 'unsupported-signature'
  | 'unsupported-critical-extension'
  | 'malformed'
  | 'signature-mismatch'
  | 'validity'
  | 'not-a-ca'
  | 'key-usage'
  | 'path-length'
  | 'name-constraint';

export interface TrustCheck {
  readonly verdict: TrustVerdict;
  /** The common names from the signer up to the root the chain reached, when it reached one. */
  readonly path: readonly string[];
  /** The signer certificate's own validity window, against the machine's clock. */
  readonly validity: CertificateValidity;
  /** `notAfter` of the signer certificate, ISO — what the user needs to see *with* the date. */
  readonly notAfter: string | null;
  /** The first check that did not pass, or `null` for `'trusted'`. */
  readonly reason: TrustReason | null;
}

export const NO_TRUST: TrustCheck = {
  verdict: 'not-checked',
  path: [],
  validity: 'unknown',
  notAfter: null,
  reason: null,
};

/** The common name of a certificate's subject, for display; `null` when it has none. */
export function certificateName(certificate: Certificate): string | null {
  for (const rdn of certificate.subject.typesAndValues) {
    if (rdn.type !== OID_COMMON_NAME) continue;
    const value = rdn.value as { valueBlock?: { value?: unknown } };
    if (typeof value?.valueBlock?.value === 'string') return value.valueBlock.value;
  }
  return null;
}

/** The name to print for a certificate, never empty: the path list must stay readable. */
function displayName(certificate: Certificate): string {
  return certificateName(certificate) ?? '—';
}

/** Byte equality, without `Buffer`: this module is part of the browser bundle. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * An `ArrayBuffer` holding exactly these bytes.
 *
 * WebCrypto's `BufferSource` is an `ArrayBufferView<ArrayBuffer>` in current TypeScript,
 * while a view over a larger or shared allocation is not assignable to it; copying here
 * keeps the call sites free of casts *and* keeps the engines from ever seeing a window
 * into a buffer the caller still owns.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * `fromBER` over a byte array, never throwing and never mutating the caller's buffer.
 *
 * `asn1js` copies from an `ArrayBuffer` it is handed, but the copy still has to be exact:
 * `.slice()` on a `Uint8Array` here is deliberate, because `der.buffer` may be a larger,
 * shared allocation and reading past the view would decode somebody else's bytes.
 */
function parseAsn1(bytes: Uint8Array): FromBerResult | null {
  try {
    const copies = bytes.slice();
    return fromBER(copies.buffer.slice(copies.byteOffset, copies.byteOffset + copies.byteLength));
  } catch {
    return null;
  }
}

/**
 * The public key a certificate carries, as the SPKI DER WebCrypto imports.
 *
 * The named curve is read through `ObjectIdentifier.getValue()` rather than from the
 * value block: since `asn1js` 3 an identifier's `valueBlock.value` is an array of
 * sub-identifier blocks, so a check for a *string* there silently answers “no curve” for
 * every elliptic-curve certificate. `instanceof` is used for the same reason — a class
 * *name* is not stable once the bundle is minified.
 */
function publicKeyOf(certificate: Certificate): {
  readonly spki: Uint8Array;
  readonly key: string;
  readonly curve: string | null;
} {
  const spki = new Uint8Array(certificate.subjectPublicKeyInfo.toSchema().toBER(false));
  const algorithm = certificate.subjectPublicKeyInfo.algorithm;
  const parameters = algorithm.algorithmParams;
  const curveOid = parameters instanceof ObjectIdentifier ? parameters.getValue() : null;
  return {
    spki,
    key: algorithm.algorithmId,
    curve: curveOid === null ? null : (CURVE_OIDS[curveOid] ?? null),
  };
}

/** The raw bytes of an extension, or `undefined` when the certificate does not carry it. */
function extensionValue(certificate: Certificate, oid: string): Uint8Array | undefined {
  const extension = certificate.extensions?.find((entry) => entry.extnID === oid);
  return extension === undefined ? undefined : new Uint8Array(extension.extnValue.valueBlock.valueHexView);
}

/**
 * The ECDSA signature WebCrypto verifies, from the one DER carries.
 *
 * `ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }` (RFC 3279 §2.2.3) is a
 * *variable-length* pair, while `SubtleCrypto.verify` for ECDSA takes IEEE P1363
 * `r ‖ s` — each integer left-padded to the curve's field width. Handing the DER straight
 * to WebCrypto is the classic silent failure: the call throws or, worse, answers `false`
 * for a signature that is perfectly valid.
 *
 * Returns `null` for anything that is not a DER pair of non-negative integers no wider
 * than the field: a malformed signature must make the check *fail*, and must never be
 * truncated into an accidental match. A negative integer is not a valid `r` or `s`, and
 * an integer wider than the field cannot be one either.
 */
export function ecdsaDerToRaw(der: Uint8Array, fieldBytes: number): Uint8Array | null {
  const parsed = parseAsn1(der);
  if (parsed === null) return null;
  // Trailing bytes after the SEQUENCE are not part of a signature: the encoding is exact.
  if (parsed.offset < 0 || parsed.offset !== der.length) return null;
  if (!(parsed.result instanceof Sequence)) return null;
  const parts = parsed.result.valueBlock.value;
  if (parts.length !== 2) return null;
  const [r, s] = parts as unknown[];
  if (!(r instanceof Integer) || !(s instanceof Integer)) return null;

  const out = new Uint8Array(fieldBytes * 2);
  for (const [index, node] of [r, s].entries()) {
    const encoded = node.valueBlock.valueHexView;
    // A leading high bit without a `0x00` pad is a negative integer, not a magnitude.
    if (encoded.length === 0 || (encoded[0] ?? 0) >= 0x80) return null;
    // `convertFromDER` drops the DER sign pad; what is left is the magnitude.
    const magnitude = node.convertFromDER().valueBlock.valueHexView;
    if (magnitude.length > fieldBytes) return null;
    out.set(magnitude, index * fieldBytes + (fieldBytes - magnitude.length));
  }
  return out;
}

/** Which of the three answers a signature check produced. */
type SignatureOutcome = 'ok' | 'mismatch' | 'unsupported' | 'malformed';

/** Whether `child`'s `tbsCertificate` verifies with `parent`'s public key. */
async function signedBy(
  subtle: SubtleCrypto,
  child: Certificate,
  parent: Certificate,
): Promise<SignatureOutcome> {
  const hash = CERTIFICATE_SIGNATURE_HASH[child.signatureAlgorithm.algorithmId];
  if (hash === undefined) return 'unsupported';
  const { spki, key, curve } = publicKeyOf(parent);
  const der = new Uint8Array(child.signatureValue.valueBlock.valueHexView);
  const signed = new Uint8Array(child.tbsView);
  try {
    if (key === RSA_KEY) {
      const imported = await subtle.importKey(
        'spki',
        bufferOf(spki),
        { name: 'RSASSA-PKCS1-v1_5', hash },
        false,
        ['verify'],
      );
      return (await subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, imported, bufferOf(der), bufferOf(signed)))
        ? 'ok'
        : 'mismatch';
    }
    if (key !== EC_KEY || curve === null) return 'unsupported';
    const fieldBytes = CURVE_FIELD_BYTES[curve];
    if (fieldBytes === undefined) return 'unsupported';
    const raw = ecdsaDerToRaw(der, fieldBytes);
    if (raw === null) return 'malformed';
    const imported = await subtle.importKey(
      'spki',
      bufferOf(spki),
      { name: 'ECDSA', namedCurve: curve },
      false,
      ['verify'],
    );
    return (await subtle.verify({ name: 'ECDSA', hash }, imported, bufferOf(raw), bufferOf(signed)))
      ? 'ok'
      : 'mismatch';
  } catch {
    // An unusable key is an absence of evidence, not a forgery: the caller reports
    // `indeterminate` (or `untrusted` when another candidate already failed a real check),
    // and the panel never says “forged”.
    return 'unsupported';
  }
}

function validityOf(certificate: Certificate, now: Date): CertificateValidity {
  const from = certificate.notBefore.value;
  const to = certificate.notAfter.value;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'unknown';
  if (now < from) return 'not-yet-valid';
  if (now > to) return 'expired';
  return 'valid';
}

/** `basicConstraints` as this validator reads it; `null` when the extension is absent. */
function basicConstraintsOf(certificate: Certificate): BasicConstraints | null {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_BASIC_CONSTRAINTS);
  const parsed = extension?.parsedValue;
  return parsed instanceof BasicConstraints ? parsed : null;
}

/** `pathLenConstraint`, or `null` when the extension carries none. */
function pathLengthOf(constraints: BasicConstraints): number | null {
  const value = constraints.pathLenConstraint;
  if (typeof value === 'number') return value;
  if (value === undefined) return null;
  const decoded = (value as unknown as { valueBlock?: { valueDec?: number } }).valueBlock?.valueDec;
  return typeof decoded === 'number' && decoded >= 0 ? decoded : null;
}

/**
 * `keyUsage`'s `keyCertSign` bit, or `null` when the extension is absent.
 *
 * `pkijs` hands the extension over as the raw `BIT STRING` rather than a decoded object,
 * so the bit is read the way RFC 5280 §4.2.1.3 defines it: bit 0 is the most significant
 * bit of the first content octet.
 */
function keyCertSignOf(certificate: Certificate): boolean | null {
  const raw = extensionValue(certificate, OID_KEY_USAGE);
  if (raw === undefined) return null;
  const parsed = parseAsn1(raw);
  if (parsed === null || parsed.offset < 0) return false;
  const bits = parsed.result as unknown as { valueBlock?: { valueHexView?: Uint8Array } };
  const octets = bits.valueBlock?.valueHexView;
  if (octets === undefined) return false;
  const index = KEY_USAGE_KEY_CERT_SIGN;
  const octet = octets[index >> 3];
  if (octet === undefined) return false;
  return (octet & (0x80 >> (index & 7))) !== 0;
}

/** The `subjectKeyIdentifier` / `authorityKeyIdentifier` key ids, for path building. */
function keyIdentifierOf(certificate: Certificate, oid: string): Uint8Array | null {
  const raw = extensionValue(certificate, oid);
  if (raw === undefined) return null;
  const parsed = parseAsn1(raw);
  if (parsed === null || parsed.offset < 0) return null;
  if (oid === OID_AUTHORITY_KEY_IDENTIFIER) {
    // `AuthorityKeyIdentifier ::= SEQUENCE { keyIdentifier [0] IMPLICIT OCTET STRING OPTIONAL … }`
    const children =
      (parsed.result as unknown as { valueBlock?: { value?: unknown[] } }).valueBlock?.value ?? [];
    for (const child of children) {
      const block = (
        child as {
          idBlock?: { tagClass?: number; tagNumber?: number };
          valueBlock?: { valueHexView?: Uint8Array };
        }
      ).idBlock;
      if (block?.tagClass !== 3 || block.tagNumber !== 0) continue;
      const bytes = (child as { valueBlock?: { valueHexView?: Uint8Array } }).valueBlock?.valueHexView;
      if (bytes !== undefined) return new Uint8Array(bytes);
    }
    return null;
  }
  const bytes = (parsed.result as unknown as { valueBlock?: { valueHexView?: Uint8Array } }).valueBlock
    ?.valueHexView;
  return bytes === undefined ? null : new Uint8Array(bytes);
}

/** One name a certificate asserts, in the form a name constraint is compared against. */
interface AssertedName {
  readonly kind: 'dns' | 'email' | 'uri' | 'ip' | 'directory' | 'other';
  readonly text: string;
  readonly bytes: Uint8Array | null;
}

const GENERAL_NAME_KINDS: Record<number, AssertedName['kind']> = {
  1: 'email',
  2: 'dns',
  4: 'directory',
  6: 'uri',
  7: 'ip',
};

/** Every name a certificate asserts: its subject, then each `subjectAltName` entry. */
function assertedNames(certificate: Certificate): AssertedName[] {
  const names: AssertedName[] = [
    { kind: 'directory', text: '', bytes: new Uint8Array(certificate.subject.toSchema().toBER(false)) },
  ];
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_SUBJECT_ALT_NAME);
  const parsed = extension?.parsedValue as { altNames?: unknown[] } | undefined;
  for (const entry of parsed?.altNames ?? []) {
    const type = (entry as { type?: unknown }).type;
    const value = (entry as { value?: unknown }).value;
    const kind = typeof type === 'number' ? (GENERAL_NAME_KINDS[type] ?? 'other') : 'other';
    if (kind === 'directory') {
      const schema = (entry as { toSchema?: () => { toBER(sizeOnly?: boolean): ArrayBuffer } }).toSchema;
      names.push({
        kind,
        text: '',
        bytes: schema === undefined ? null : new Uint8Array(schema().toBER(false)),
      });
      continue;
    }
    if (typeof value === 'string') {
      names.push({ kind, text: value, bytes: null });
      continue;
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const view = new Uint8Array(
        value instanceof ArrayBuffer ? value : (value as Uint8Array).buffer,
        0,
        value.byteLength,
      );
      names.push({ kind, text: '', bytes: new Uint8Array(view) });
      continue;
    }
    names.push({ kind, text: '', bytes: null });
  }
  return names;
}

/** One `GeneralSubtree`, reduced to the two fields the comparisons need. */
interface Constraint {
  readonly kind: AssertedName['kind'];
  readonly text: string;
  readonly bytes: Uint8Array | null;
}

/**
 * A CA's name constraints, kept in the two groups RFC 5280 gives them: `permitted` says
 * what a subordinate *may* assert, `excluded` says what it may not. Merging them would
 * invert the meaning of one group, so they never travel together.
 */
interface NameConstraintSet {
  readonly permitted: readonly Constraint[];
  readonly excluded: readonly Constraint[];
}

const NO_CONSTRAINTS: NameConstraintSet = { permitted: [], excluded: [] };

function constraintsOf(certificate: Certificate): NameConstraintSet {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_NAME_CONSTRAINTS);
  const parsed = extension?.parsedValue;
  if (!(parsed instanceof NameConstraints)) return NO_CONSTRAINTS;
  return {
    permitted: (parsed.permittedSubtrees ?? []).map(constraintOf),
    excluded: (parsed.excludedSubtrees ?? []).map(constraintOf),
  };
}

/**
 * A subtree's base name. An entry this validator cannot reduce to a comparable form keeps
 * `bytes === null`, and the comparison treats it as unsatisfiable rather than as a pass —
 * being unable to evaluate a constraint is not the same as satisfying it.
 */
function constraintOf(subtree: { base: unknown }): Constraint {
  const base = subtree.base as {
    type?: unknown;
    value?: unknown;
    toSchema?: () => { toBER(sizeOnly?: boolean): ArrayBuffer };
  };
  const kind = typeof base.type === 'number' ? (GENERAL_NAME_KINDS[base.type] ?? 'other') : 'other';
  if (kind === 'directory') {
    const schema = base.toSchema;
    return { kind, text: '', bytes: schema === undefined ? null : new Uint8Array(schema().toBER(false)) };
  }
  if (typeof base.value === 'string') return { kind, text: base.value, bytes: null };
  if (base.value instanceof ArrayBuffer || ArrayBuffer.isView(base.value)) {
    return { kind, text: '', bytes: new Uint8Array(base.value as ArrayBuffer) };
  }
  return { kind, text: '', bytes: null };
}

/** RFC 5280 §4.2.1.10: `host.example.com` matches itself and anything to its left. */
function dnsWithin(name: string, constraint: string): boolean {
  const target = name.toLowerCase().replace(/\.$/, '');
  const base = constraint.toLowerCase().replace(/\.$/, '');
  if (base.length === 0) return target.length === 0;
  if (base.startsWith('.')) return target === base.slice(1) || target.endsWith(base);
  return target === base || target.endsWith(`.${base}`);
}

/** RFC 5280 §4.2.1.10: a mailbox constraint is exact; a host constraint is a suffix. */
function emailWithin(name: string, constraint: string): boolean {
  const target = name.toLowerCase();
  const base = constraint.toLowerCase();
  const host = target.slice(target.indexOf('@') + 1);
  if (base.includes('@')) return target === base;
  return dnsWithin(host, base);
}

/** RFC 5280 §4.2.1.10: the URI's host, constrained like a DNS name. */
function uriWithin(name: string, constraint: string): boolean {
  let host: string;
  try {
    host = new URL(name).hostname.toLowerCase();
  } catch {
    return false;
  }
  return dnsWithin(host, constraint.toLowerCase());
}

/** The address half of an `iPAddress` constraint is followed by its mask. */
function ipWithin(address: Uint8Array, constraint: Uint8Array): boolean {
  const half = constraint.length / 2;
  if (address.length !== half) return false;
  for (let index = 0; index < half; index += 1) {
    const mask = constraint[half + index] ?? 0;
    if (((address[index] ?? 0) ^ (constraint[index] ?? 0)) & mask) return false;
  }
  return true;
}

/** Whether one asserted name satisfies one subtree of the matching kind. */
function nameWithin(name: AssertedName, constraint: Constraint): boolean {
  if (name.kind !== constraint.kind) return false;
  if (name.kind === 'dns') return dnsWithin(name.text, constraint.text);
  if (name.kind === 'email') return emailWithin(name.text, constraint.text);
  if (name.kind === 'uri') return uriWithin(name.text, constraint.text);
  if (name.kind === 'ip') {
    return name.bytes !== null && constraint.bytes !== null && ipWithin(name.bytes, constraint.bytes);
  }
  if (name.kind === 'directory') {
    if (name.bytes === null || constraint.bytes === null) return false;
    // `directoryName` constrains a *subtree*: the constraint's RDNs are a prefix of the
    // name's (RFC 5280 §4.2.1.10, RFC 4514 ordering).
    const constraintRdns = rdnSequence(constraint.bytes);
    const nameRdns = rdnSequence(name.bytes);
    if (constraintRdns === null || nameRdns === null) return false;
    if (constraintRdns.length === 0 || constraintRdns.length > nameRdns.length) return false;
    return constraintRdns.every((rdn, index) => rdn === nameRdns[index]);
  }
  return false;
}

/** The RDN sequence of a `Name`, as comparable strings; `null` when it will not parse. */
function rdnSequence(der: Uint8Array): string[] | null {
  const parsed = parseAsn1(der);
  if (parsed === null || parsed.offset < 0) return null;
  const sequence = parsed.result as Sequence;
  const value = sequence.valueBlock.value;
  if (value === undefined) return null;
  return value.map((rdn) => {
    const set = rdn as unknown as { valueBlock?: { value?: { toBER(sizeOnly?: boolean): ArrayBuffer }[] } };
    const members = set.valueBlock?.value ?? [];
    return members
      .map((member) => Array.from(new Uint8Array(member.toBER(false))).join(','))
      .sort()
      .join('|');
  });
}

/**
 * Whether every name `certificate` asserts survives `set`.
 *
 * A name of a kind this validator cannot compare, under a CA that constrains that kind,
 * is an unfinished check — the answer is `'unevaluable'`, never a pass. A constraint that
 * cannot be compared to anything is treated the same way, for the same reason.
 */
function namesAllowed(certificate: Certificate, set: NameConstraintSet): boolean | 'unevaluable' {
  if (set.permitted.length === 0 && set.excluded.length === 0) return true;
  for (const name of assertedNames(certificate)) {
    const excluded = set.excluded.filter((constraint) => constraint.kind === name.kind);
    const permitted = set.permitted.filter((constraint) => constraint.kind === name.kind);
    if (name.kind === 'other') {
      if (excluded.length > 0 || permitted.length > 0) return 'unevaluable';
      continue;
    }
    if (
      [...excluded, ...permitted].some((constraint) => constraint.bytes === null && constraint.kind !== 'dns')
    ) {
      if ([...excluded, ...permitted].some((constraint) => !comparable(constraint))) return 'unevaluable';
    }
    if (excluded.some((constraint) => nameWithin(name, constraint))) return false;
    // An empty `permitted` list constrains nothing: RFC 5280's subtree state starts as
    // “unbounded”, and a kind the extension does not mention stays unbounded.
    if (permitted.length === 0) continue;
    if (!permitted.some((constraint) => nameWithin(name, constraint))) return false;
  }
  return true;
}

/** Whether a constraint carries the value a comparison needs at all. */
function comparable(constraint: Constraint): boolean {
  if (constraint.kind === 'ip' || constraint.kind === 'directory') return constraint.bytes !== null;
  if (constraint.kind === 'other') return false;
  return constraint.text.length > 0;
}

/** Everything one candidate path produced: a verdict, or the first check that stopped it. */
type PathOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TrustReason; readonly indeterminate: boolean };

/**
 * RFC 5280 §6.1's path-validation steps, for one already-built path.
 *
 * `path[0]` is the signer and the last entry is the trust anchor. The anchor is the
 * user's own input, so two of §6.1.3's checks do not apply to it: its own validity window
 * is not re-litigated (an anchor is trusted *as of* the check, which is what “I imported
 * this certificate” means), and it is not required to carry `basicConstraints` because
 * the user's import *is* the statement that it may issue.
 *
 * Its `keyUsage`, `pathLenConstraint` and name constraints **are** enforced. §4.2.1.3 is
 * explicit that a key MUST NOT verify certificate signatures without `keyCertSign`, and
 * the other two are declarations the certificate itself makes about what may sit below
 * it; ignoring them would let a root say “end entities only” while a whole intermediate
 * chain hangs under it. RFC 5280 §6.1.1 folds an anchor's name constraints into the
 * permitted/excluded subtree state, and is silent on its `pathLenConstraint`; applying
 * both is the *stricter* reading, so it can only turn a `'trusted'` into a refusal with a
 * named reason, never the other way round.
 */
async function validatePath(
  subtle: SubtleCrypto,
  path: readonly Certificate[],
  now: Date,
): Promise<PathOutcome> {
  const last = path.length - 1;

  for (const [index, certificate] of path.entries()) {
    if (
      certificate.extensions?.some(
        (entry) => entry.critical && APPLIED_CRITICAL_EXTENSIONS[entry.extnID] !== true,
      )
    ) {
      return { ok: false, reason: 'unsupported-critical-extension', indeterminate: true };
    }
    // The anchor is trusted input; §6.1.3(b) checks validity for the rest of the path.
    if (index === last) continue;
    if (validityOf(certificate, now) !== 'valid')
      return { ok: false, reason: 'validity', indeterminate: false };
  }

  for (let index = 0; index < last; index += 1) {
    const child = path[index];
    const parent = path[index + 1];
    if (child === undefined || parent === undefined)
      return { ok: false, reason: 'malformed', indeterminate: true };
    const outcome = await signedBy(subtle, child, parent);
    if (outcome === 'unsupported' || outcome === 'malformed') {
      return {
        ok: false,
        reason: outcome === 'malformed' ? 'malformed' : 'unsupported-signature',
        indeterminate: true,
      };
    }
    if (outcome === 'mismatch') return { ok: false, reason: 'signature-mismatch', indeterminate: false };
  }

  for (let index = 1; index <= last; index += 1) {
    const issuer = path[index];
    if (issuer === undefined) return { ok: false, reason: 'malformed', indeterminate: true };
    const usage = keyCertSignOf(issuer);
    if (usage === false) return { ok: false, reason: 'key-usage', indeterminate: false };
    const constraints = basicConstraintsOf(issuer);
    if (constraints === null || (index !== last && !constraints.cA)) {
      return { ok: false, reason: 'not-a-ca', indeterminate: false };
    }
    const limit = pathLengthOf(constraints);
    // §4.2.1.9 / §6.1.4(l): `pathLenConstraint` bounds the *intermediate* certificates
    // that follow toward the end entity — the ones between this issuer and the subject,
    // the end entity itself excluded. In this array, “below” is a lower index.
    if (limit !== null && index - 1 > limit)
      return { ok: false, reason: 'path-length', indeterminate: false };
  }

  for (let index = 1; index <= last; index += 1) {
    const issuer = path[index];
    if (issuer === undefined) return { ok: false, reason: 'malformed', indeterminate: true };
    const constraints = constraintsOf(issuer);
    if (constraints.permitted.length === 0 && constraints.excluded.length === 0) continue;
    for (let below = 0; below < index; below += 1) {
      const subject = path[below];
      if (subject === undefined) return { ok: false, reason: 'malformed', indeterminate: true };
      const allowed = namesAllowed(subject, constraints);
      if (allowed === 'unevaluable') {
        return { ok: false, reason: 'unsupported-critical-extension', indeterminate: true };
      }
      if (!allowed) return { ok: false, reason: 'name-constraint', indeterminate: false };
    }
  }

  return { ok: true };
}

/** The certificates that could have issued `child`, best key-identifier match first. */
function candidatesFor(child: Certificate, pool: readonly Certificate[]): Certificate[] {
  const authorityKeyId = keyIdentifierOf(child, OID_AUTHORITY_KEY_IDENTIFIER);
  const named = pool.filter((candidate) => child.issuer.isEqual(candidate.subject));
  if (authorityKeyId === null) return named;
  const matching: Certificate[] = [];
  const rest: Certificate[] = [];
  for (const candidate of named) {
    const subjectKeyId = keyIdentifierOf(candidate, OID_SUBJECT_KEY_IDENTIFIER);
    if (subjectKeyId !== null && sameBytes(subjectKeyId, authorityKeyId)) matching.push(candidate);
    else rest.push(candidate);
  }
  // Trying every candidate is the point: the first issuer that *names* itself is not
  // necessarily the one that can verify the signature, and cross-signed roots exist.
  return [...matching, ...rest];
}

export interface TrustInput {
  /** The signer certificate, DER. */
  readonly signer: Uint8Array;
  /** Any other certificates that travelled with the signature, DER. */
  readonly chain?: readonly Uint8Array[];
  /** The certificates the **user** imported; only these can make a chain trusted. */
  readonly roots?: readonly Uint8Array[];
  /** The clock is passed in so the verdict is reproducible in a check. */
  readonly now?: Date;
}

/** One walk over the candidate issuers, collecting the best failure seen on the way. */
interface WalkState {
  /** A path ended at a trust anchor and every check ran: the answer is above argument. */
  reachableFailure: { reason: TrustReason; indeterminate: boolean } | null;
  /** No path reached an anchor; the pool simply does not contain the issuer. */
  sawCandidate: boolean;
}

/** Depth-first over the candidate paths, bounded by `MAX_DEPTH` and a visited set. */
async function walk(
  subtle: SubtleCrypto,
  anchorSet: readonly Certificate[],
  current: Certificate,
  pool: readonly Certificate[],
  now: Date,
  path: Certificate[],
  seen: ReadonlySet<Certificate>,
  state: WalkState,
): Promise<readonly Certificate[] | null> {
  const anchored = anchorSet.some((anchor) => sameBytes(anchor.tbsView, current.tbsView));
  if (anchored) {
    const outcome = await validatePath(subtle, path, now);
    if (outcome.ok) return path;
    // A definite failure on a path that *did* reach an anchor outranks an indeterminate
    // one: “this chain is broken” is a stronger statement than “this chain could not be
    // finished”, and the reason the user sees should be the strongest one available.
    const previous = state.reachableFailure;
    if (previous === null || (previous.indeterminate && !outcome.indeterminate)) {
      state.reachableFailure = { reason: outcome.reason, indeterminate: outcome.indeterminate };
    }
    return null;
  }
  if (path.length > MAX_DEPTH) return null;

  for (const candidate of candidatesFor(current, pool)) {
    if (seen.has(candidate)) continue;
    state.sawCandidate = true;
    const nextSeen = new Set(seen);
    nextSeen.add(candidate);
    const found = await walk(subtle, anchorSet, candidate, pool, now, [...path, candidate], nextSeen, state);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The chain the signer's certificate sits on, and where it ends.
 *
 * A root that is the signer's own certificate is `trusted` — the user has said “this
 * certificate is one I recognise”, which is the whole meaning of an imported root here —
 * and a self-signed certificate that is *not* in the list is `self-signed`, which is a
 * different statement from `untrusted`.
 */
export async function checkTrust(input: TrustInput): Promise<TrustCheck> {
  if (input.signer.length === 0) return NO_TRUST;
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return NO_TRUST;
  const now = input.now ?? new Date();

  let signer: Certificate;
  try {
    signer = Certificate.fromBER(input.signer.slice());
  } catch {
    return { verdict: 'indeterminate', path: [], validity: 'unknown', notAfter: null, reason: 'malformed' };
  }
  const validity = validityOf(signer, now);
  const notAfter = signer.notAfter.value.toISOString();
  const name = displayName(signer);

  const parse = (ders: readonly Uint8Array[]): Certificate[] => {
    const out: Certificate[] = [];
    for (const der of ders.slice(0, MAX_CANDIDATES)) {
      try {
        out.push(Certificate.fromBER(der.slice()));
      } catch {
        // A certificate this reader cannot parse is skipped: it can neither extend nor
        // break a chain.
      }
    }
    return out;
  };
  const roots = parse(input.roots ?? []);
  const pool = [...parse(input.chain ?? []), ...roots];

  // An imported root that *is* the signer: trusted, with nothing to verify.
  for (const root of roots) {
    if (sameBytes(root.tbsView, signer.tbsView)) {
      return { verdict: 'trusted', path: [name], validity, notAfter, reason: null };
    }
  }
  if (roots.length === 0) {
    return { verdict: 'not-checked', path: [name], validity, notAfter, reason: 'no-roots' };
  }

  const state: WalkState = { reachableFailure: null, sawCandidate: false };
  const found = await walk(subtle, roots, signer, pool, now, [signer], new Set([signer]), state);
  if (found !== null) {
    return {
      verdict: 'trusted',
      path: found.map(displayName),
      validity,
      notAfter,
      reason: null,
    };
  }

  if (signer.issuer.isEqual(signer.subject)) {
    return { verdict: 'self-signed', path: [name], validity, notAfter, reason: 'no-issuer' };
  }
  if (state.reachableFailure !== null) {
    const { reason, indeterminate } = state.reachableFailure;
    return {
      verdict: indeterminate ? 'indeterminate' : 'untrusted',
      path: [name],
      validity,
      notAfter,
      reason,
    };
  }
  // A candidate existed but none of its paths reached an anchor: the chain stops short.
  return { verdict: 'untrusted', path: [name], validity, notAfter, reason: 'no-issuer' };
}
