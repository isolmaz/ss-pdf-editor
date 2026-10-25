/**
 * Certificate trust, decided **locally** against roots the user imported (“certificate
 * validation against user-imported trust roots (no online service)”).
 *
 * There is no trust store in the browser and no network to ask: a certificate is trusted
 * here only because a certificate the user put in the list signs it, and the path is
 * validated the way RFC 5280 §6.1 says a path is validated — signatures checked
 * cryptographically over the child's `tbsCertificate`, every issuer's validity window and
 * CA constraints enforced, path length bounded, and name constraints applied to every
 * subordinate certificate. A name match is never enough.
 *
 * **What it cannot say.** A signature that verifies against an imported root is trusted
 * *by that root* — nothing more. Revocation is a different question, answered from lists
 * already on the device by `signature-revocation.ts`; trust here says nothing about it, and a
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
 * - `'not-a-ca'` — an intermediate issuer has no `basicConstraints` with `cA` set. A trust
 *   anchor is exempt: the user's import is the statement that it may issue, and a v1
 *   self-signed root has no extensions at all.
 * - `'key-usage'` — an issuer's `keyUsage` is present and does not assert `keyCertSign`.
 * - `'signer-usage'` — the signer's own `keyUsage` is present and asserts neither
 *   `digitalSignature` nor `nonRepudiation`, or its `extKeyUsage` is present and names no purpose
 *   that allows signing a document (`SIGNING_PURPOSES`): a TLS server or key-encipherment
 *   certificate does not vouch for a document however well its chain is built.
 * - `'path-length'` — an issuer's `pathLenConstraint` is exceeded.
 * - `'name-constraint'` — a subordinate certificate's names fall outside the permitted
 *   subtrees, or inside an excluded one.
 * - `'no-roots'` — the user has imported nothing, so there is nothing to check against.
 * - `'search-limit'` — the search for a path spent its work budget ({@link MAX_WALK_STEPS}
 *   expansions or {@link MAX_SIGNATURE_CHECKS} signature verifications) before it found a
 *   path or ran out of candidates. Always `'indeterminate'`: a pool of certificates that all
 *   name each other as issuer has factorially many paths, and an unfinished search proves
 *   neither that a chain exists nor that none does.
 */

import type { FromBerResult } from 'asn1js';
import {
  type Set as AsnSet,
  BitString,
  fromBER,
  Integer,
  ObjectIdentifier,
  OctetString,
  type Primitive,
  Sequence,
} from 'asn1js';
import {
  AltName,
  BasicConstraints,
  Certificate,
  type Extension,
  type GeneralName,
  NameConstraints,
  type RelativeDistinguishedNames,
} from 'pkijs';

/** A depth limit, because a chain longer than this is either broken or hostile. */
const MAX_DEPTH = 8;
/** The import of one SPKI per check is the only allocation worth bounding. */
const MAX_CANDIDATES = 32;
/**
 * The most certificates the path search may expand in one check. Depth and candidate counts
 * bound a single path, not the *number* of paths: `n` certificates that all name each other
 * as issuer have `n!/(n-k)!` simple paths of length `k`, which for the 32 a pool may hold is
 * about 4·10¹¹ at depth 8. A real chain, even with a few cross-signed alternatives, needs a
 * few dozen expansions; this is two orders of magnitude above that.
 */
const MAX_WALK_STEPS = 2048;
/**
 * The most certificate-signature verifications one check may start. Each is a WebCrypto
 * import and verify, the one expensive operation of the search; a pair is verified once and
 * remembered, so this counts *distinct* (certificate, issuer) pairs. Go's `crypto/x509` bounds
 * the same cost at 100 per chain build for the same reason.
 */
const MAX_SIGNATURE_CHECKS = 128;
/**
 * Expansions between two real yields to the event loop. Awaiting an already-settled promise
 * only queues a microtask: a search of thousands of steps whose paths fail before any
 * WebCrypto call would otherwise run to its budget without letting rendering or input
 * through. A yield every 64 steps costs one timer turn per ~64 cheap steps and never more
 * than `MAX_WALK_STEPS / 64` of them.
 */
const YIELD_EVERY = 64;

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

/**
 * The curves WebCrypto can verify here, by the OID a key names them with. `fieldBytes` is the
 * width WebCrypto's ECDSA signature representation is fixed to: P-521 is 521 bits, which is 66
 * bytes and **not** the 64 a byte-count of the curve's name would suggest.
 */
const CURVES: Record<string, { readonly name: string; readonly fieldBytes: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', fieldBytes: 32 },
  '1.3.132.0.34': { name: 'P-384', fieldBytes: 48 },
  '1.3.132.0.35': { name: 'P-521', fieldBytes: 66 },
};

const OID_COMMON_NAME = '2.5.4.3';
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
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
const KEY_USAGE_DIGITAL_SIGNATURE = 0;
const KEY_USAGE_NON_REPUDIATION = 1;
const KEY_USAGE_KEY_CERT_SIGN = 5;

/**
 * The `extKeyUsage` purposes that let a certificate sign a document: `anyExtendedKeyUsage`,
 * e-mail protection (what S/MIME and PAdES signers carry), Adobe's and Microsoft's document
 * signing and `id-kp-documentSigning` (RFC 9336).
 */
const SIGNING_PURPOSES: ReadonlySet<string> = new Set([
  '2.5.29.37.0',
  '1.3.6.1.5.5.7.3.4',
  '1.2.840.113583.1.1.5',
  '1.3.6.1.4.1.311.10.3.12',
  '1.3.6.1.5.5.7.3.36',
]);

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
  | 'signer-usage'
  | 'path-length'
  | 'name-constraint'
  | 'search-limit';

export interface TrustCheck {
  readonly verdict: TrustVerdict;
  /** The common names from the signer up to the root the chain reached, when it reached one. */
  readonly path: readonly string[];
  /** The signer certificate's own validity window, against the machine's clock. */
  readonly validity: CertificateValidity;
  /**
   * `notBefore` and `notAfter` of the signer certificate, ISO — what the user needs to see
   * *with* the validity: a certificate not yet valid is valid from the first, any other until
   * the second.
   */
  readonly notBefore: string | null;
  readonly notAfter: string | null;
  /** The first check that did not pass, or `null` for `'trusted'`. */
  readonly reason: TrustReason | null;
}

export const NO_TRUST: TrustCheck = {
  verdict: 'not-checked',
  path: [],
  validity: 'unknown',
  notBefore: null,
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
 * `fromBER` over a byte array: `null` for bytes that are not BER (asn1js both reports an
 * error offset and throws, on a string type with an impossible value, say), and it never mutates
 * the caller's buffer.
 *
 * `asn1js` copies from an `ArrayBuffer` it is handed, but the copy still has to be exact:
 * `.slice()` on a `Uint8Array` here is deliberate, because `der.buffer` may be a larger,
 * shared allocation and reading past the view would decode somebody else's bytes.
 */
export function parseAsn1(bytes: Uint8Array): FromBerResult | null {
  try {
    const copies = bytes.slice();
    const parsed = fromBER(copies.buffer.slice(copies.byteOffset, copies.byteOffset + copies.byteLength));
    return parsed.offset < 0 ? null : parsed;
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
  readonly curve: { readonly name: string; readonly fieldBytes: number } | null;
} {
  const spki = new Uint8Array(certificate.subjectPublicKeyInfo.toSchema().toBER(false));
  const algorithm = certificate.subjectPublicKeyInfo.algorithm;
  const parameters = algorithm.algorithmParams;
  const curveOid = parameters instanceof ObjectIdentifier ? parameters.getValue() : null;
  return {
    spki,
    key: algorithm.algorithmId,
    curve: curveOid === null ? null : (CURVES[curveOid] ?? null),
  };
}

/**
 * `extension.parsedValue`, or `undefined` for a value pkijs's decoder cannot read. The getter
 * decodes on first use and lets asn1js's exception through for hostile DER (a string type with an
 * impossible value, say), so every read of it from a certificate or list on the wire goes here.
 */
export function parsedValueOf(extension: Extension | undefined): unknown {
  try {
    return extension?.parsedValue;
  } catch {
    return undefined;
  }
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
  if (parsed.offset !== der.length) return null;
  if (!(parsed.result instanceof Sequence)) return null;
  const parts = parsed.result.valueBlock.value;
  if (parts.length !== 2) return null;
  const [r, s] = parts as unknown[];
  if (!(r instanceof Integer) || !(s instanceof Integer)) return null;

  const out = new Uint8Array(fieldBytes * 2);
  for (const [index, node] of [r, s].entries()) {
    const encoded = node.valueBlock.valueHexView;
    // A leading high bit without a `0x00` pad is a negative integer, not a magnitude.
    // (`encoded[0]` exists: the length is checked first.)
    if (encoded.length === 0 || (encoded[0] as number) >= 0x80) return null;
    // `convertFromDER` drops the DER sign pad; what is left is the magnitude.
    const magnitude = node.convertFromDER().valueBlock.valueHexView;
    if (magnitude.length > fieldBytes) return null;
    out.set(magnitude, index * fieldBytes + (fieldBytes - magnitude.length));
  }
  return out;
}

/** Which of the three answers a signature check produced. */
export type SignatureOutcome = 'ok' | 'mismatch' | 'unsupported' | 'malformed';

/**
 * Whether `signature` is `parent`'s signature over `signed`, for the algorithm named by
 * `algorithmId`.
 *
 * Shared by every signed structure that is checked against a certificate's key: a
 * certificate's `tbsCertificate` here, and a CRL, an OCSP response or a timestamp token's
 * signed attributes in the revocation and timestamp checks. `hashFallback` serves the CMS
 * case, where the signature algorithm is plain `rsaEncryption` and the hash is named by the
 * SignerInfo's own `digestAlgorithm` instead of by the signature OID.
 */
export async function verifyDataSignature(
  subtle: SubtleCrypto,
  parent: Certificate,
  algorithmId: string,
  signature: Uint8Array,
  signed: Uint8Array,
  hashFallback?: string,
): Promise<SignatureOutcome> {
  const hash =
    CERTIFICATE_SIGNATURE_HASH[algorithmId] ?? (algorithmId === RSA_KEY ? hashFallback : undefined);
  if (hash === undefined) return 'unsupported';
  const { spki, key, curve } = publicKeyOf(parent);
  try {
    if (key === RSA_KEY) {
      const imported = await subtle.importKey(
        'spki',
        bufferOf(spki),
        { name: 'RSASSA-PKCS1-v1_5', hash },
        false,
        ['verify'],
      );
      return (await subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        imported,
        bufferOf(signature),
        bufferOf(signed),
      ))
        ? 'ok'
        : 'mismatch';
    }
    if (key !== EC_KEY || curve === null) return 'unsupported';
    const raw = ecdsaDerToRaw(signature, curve.fieldBytes);
    if (raw === null) return 'malformed';
    const imported = await subtle.importKey(
      'spki',
      bufferOf(spki),
      { name: 'ECDSA', namedCurve: curve.name },
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

/**
 * Whether `child`'s `tbsCertificate` verifies with `parent`'s public key, or `'budget'` when
 * the search has no verification left to spend on a pair it has not seen.
 *
 * The answer is a pure function of the two certificates, so it is remembered for the whole
 * search: the same pair turns up on every path through it, and only the first time costs a
 * WebCrypto call (and a unit of {@link MAX_SIGNATURE_CHECKS}).
 */
async function signedBy(
  subtle: SubtleCrypto,
  child: Certificate,
  parent: Certificate,
  state: WalkState,
): Promise<SignatureOutcome | 'budget'> {
  let byParent = state.signatures.get(child);
  if (byParent === undefined) {
    byParent = new Map();
    state.signatures.set(child, byParent);
  }
  const known = byParent.get(parent);
  if (known !== undefined) return known;
  if (state.signatureChecks >= MAX_SIGNATURE_CHECKS) {
    state.exhausted = true;
    return 'budget';
  }
  state.signatureChecks += 1;
  const outcome = await verifyDataSignature(
    subtle,
    parent,
    child.signatureAlgorithm.algorithmId,
    new Uint8Array(child.signatureValue.valueBlock.valueHexView),
    new Uint8Array(child.tbsView),
  );
  byParent.set(parent, outcome);
  return outcome;
}

export function validityOf(certificate: Certificate, now: Date): CertificateValidity {
  const from = certificate.notBefore.value;
  const to = certificate.notAfter.value;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'unknown';
  if (now < from) return 'not-yet-valid';
  if (now > to) return 'expired';
  return 'valid';
}

/** `basicConstraints` as this validator reads it; `null` when the extension is absent or cannot be read. */
function basicConstraintsOf(certificate: Certificate): BasicConstraints | null {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_BASIC_CONSTRAINTS);
  const parsed = parsedValueOf(extension);
  return parsed instanceof BasicConstraints ? parsed : null;
}

/**
 * `pathLenConstraint`, or `null` when the extension carries none. pkijs hands back an `Integer`
 * instead of a number for a value wider than 32 bits: no chain is that long, so it is no limit.
 */
function pathLengthOf(constraints: BasicConstraints): number | null {
  const value = constraints.pathLenConstraint;
  return value === undefined || value instanceof Integer ? null : value;
}

/**
 * One bit of `keyUsage`, or `null` when the extension is absent.
 *
 * `pkijs` hands the extension over as the raw `BIT STRING` rather than a decoded object,
 * so the bit is read the way RFC 5280 §4.2.1.3 defines it: bit 0 is the most significant
 * bit of the first content octet. An extension that cannot be read asserts nothing.
 */
export function keyUsageBit(certificate: Certificate, bit: number): boolean | null {
  const raw = extensionValue(certificate, OID_KEY_USAGE);
  if (raw === undefined) return null;
  const parsed = parseAsn1(raw);
  if (parsed === null || !(parsed.result instanceof BitString)) return false;
  const octet = parsed.result.valueBlock.valueHexView[bit >> 3];
  if (octet === undefined) return false;
  return (octet & (0x80 >> (bit & 7))) !== 0;
}

/** The `extKeyUsage` purposes of a certificate; `null` when it has no such extension. */
export function extendedKeyUsage(certificate: Certificate): readonly string[] | null {
  const raw = extensionValue(certificate, OID_EXT_KEY_USAGE);
  if (raw === undefined) return null;
  const parsed = parseAsn1(raw);
  if (parsed === null || !(parsed.result instanceof Sequence)) return [];
  return parsed.result.valueBlock.value
    .filter((member): member is ObjectIdentifier => member instanceof ObjectIdentifier)
    .map((member) => member.getValue());
}

/**
 * Whether the signer certificate's own `keyUsage` and `extKeyUsage` leave room for signing a
 * document. An extension that is absent limits nothing; one that is present has to name a way.
 * `purposesChecked` is true when the caller judges the purposes itself.
 */
function allowsSigning(certificate: Certificate, purposesChecked: boolean): boolean {
  const digitalSignature = keyUsageBit(certificate, KEY_USAGE_DIGITAL_SIGNATURE);
  const nonRepudiation = keyUsageBit(certificate, KEY_USAGE_NON_REPUDIATION);
  if (digitalSignature === false && nonRepudiation === false) return false;
  if (purposesChecked) return true;
  const purposes = extendedKeyUsage(certificate);
  return purposes === null || purposes.some((purpose) => SIGNING_PURPOSES.has(purpose));
}

/** The `subjectKeyIdentifier` / `authorityKeyIdentifier` key ids, for path building. */
function keyIdentifierOf(certificate: Certificate, oid: string): Uint8Array | null {
  const raw = extensionValue(certificate, oid);
  if (raw === undefined) return null;
  const parsed = parseAsn1(raw);
  if (parsed === null) return null;
  if (oid === OID_AUTHORITY_KEY_IDENTIFIER) {
    // `AuthorityKeyIdentifier ::= SEQUENCE { keyIdentifier [0] IMPLICIT OCTET STRING OPTIONAL … }`
    if (!(parsed.result instanceof Sequence)) return null;
    const keyId = parsed.result.valueBlock.value.find(
      (child) => child.idBlock.tagClass === 3 && child.idBlock.tagNumber === 0,
    );
    return keyId === undefined ? null : new Uint8Array((keyId as Primitive).valueBlock.valueHexView);
  }
  return parsed.result instanceof OctetString ? new Uint8Array(parsed.result.valueBlock.valueHexView) : null;
}

/**
 * A name in the form a name constraint compares: text for DNS names, mailboxes and URIs, the
 * address (and mask, in a constraint) for `iPAddress`, the RDN sequence for a directory name.
 */
interface NameForm {
  readonly kind: 'dns' | 'email' | 'uri' | 'ip' | 'directory' | 'other';
  readonly text: string;
  /** `iPAddress` only (empty otherwise): the address, and in a constraint its mask. */
  readonly bytes: Uint8Array;
  /** `directoryName` only: each RDN as a comparable string, in order. */
  readonly rdns: readonly string[];
}

const GENERAL_NAME_KINDS: Record<number, NameForm['kind']> = {
  1: 'email',
  2: 'dns',
  4: 'directory',
  6: 'uri',
  7: 'ip',
};

const NO_BYTES = new Uint8Array(0);

/** The RDNs of a `Name`, each as the sorted DER of its attributes so `SET` order cannot matter. */
function rdnStrings(name: RelativeDistinguishedNames): string[] {
  // `toSchema()` of a name is a SEQUENCE of SETs of attributes.
  return name.toSchema().valueBlock.value.map((rdn) =>
    (rdn as AsnSet).valueBlock.value
      .map((member) => Array.from(new Uint8Array(member.toBER(false))).join(','))
      .sort()
      .join('|'),
  );
}

/** One `GeneralName` in comparable form. pkijs reads every other kind into a block this does not compare. */
function nameForm(name: GeneralName): NameForm {
  const kind = GENERAL_NAME_KINDS[name.type] ?? 'other';
  if (kind === 'directory') {
    return { kind, text: '', bytes: NO_BYTES, rdns: rdnStrings(name.value as RelativeDistinguishedNames) };
  }
  if (kind === 'ip') {
    return {
      kind,
      text: '',
      bytes: new Uint8Array((name.value as OctetString).valueBlock.valueHexView),
      rdns: [],
    };
  }
  if (kind === 'other') return { kind, text: '', bytes: NO_BYTES, rdns: [] };
  return { kind, text: name.value as string, bytes: NO_BYTES, rdns: [] };
}

/**
 * Every name a certificate asserts: its subject, then each `subjectAltName` entry; `null` when
 * the `subjectAltName` is there but cannot be read, because the names it asserts are then unknown.
 */
function assertedNames(certificate: Certificate): NameForm[] | null {
  const names: NameForm[] = [
    { kind: 'directory', text: '', bytes: NO_BYTES, rdns: rdnStrings(certificate.subject) },
  ];
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_SUBJECT_ALT_NAME);
  if (extension === undefined) return names;
  const parsed = parsedValueOf(extension);
  if (!(parsed instanceof AltName) || (parsed as { parsingError?: string }).parsingError !== undefined)
    return null;
  names.push(...parsed.altNames.map(nameForm));
  return names;
}

/**
 * A CA's name constraints, kept in the two groups RFC 5280 gives them: `permitted` says
 * what a subordinate *may* assert, `excluded` says what it may not. Merging them would
 * invert the meaning of one group, so they never travel together.
 */
interface NameConstraintSet {
  readonly permitted: readonly NameForm[];
  readonly excluded: readonly NameForm[];
}

const NO_CONSTRAINTS: NameConstraintSet = { permitted: [], excluded: [] };

/** `null` when the extension is there but cannot be read: that is not "no constraints". */
function constraintsOf(certificate: Certificate): NameConstraintSet | null {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_NAME_CONSTRAINTS);
  if (extension === undefined) return NO_CONSTRAINTS;
  const parsed = parsedValueOf(extension);
  if (
    !(parsed instanceof NameConstraints) ||
    (parsed as { parsingError?: string }).parsingError !== undefined
  )
    return null;
  return {
    permitted: (parsed.permittedSubtrees ?? []).map((subtree) => nameForm(subtree.base)),
    excluded: (parsed.excludedSubtrees ?? []).map((subtree) => nameForm(subtree.base)),
  };
}

/**
 * RFC 5280 §4.2.1.10: `host.example.com` matches itself and anything to its left. An empty
 * constraint matches every name (NSS, OpenSSL and Go agree; the RFC leaves it open).
 */
function dnsWithin(name: string, constraint: string): boolean {
  const target = name.toLowerCase().replace(/\.$/, '');
  const base = constraint.toLowerCase().replace(/\.$/, '');
  if (base.length === 0) return true;
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
  // `index < half`, so both the constraint's address octet and its mask octet exist.
  return Array.from(address).every(
    (octet, index) => ((octet ^ (constraint[index] as number)) & (constraint[half + index] as number)) === 0,
  );
}

/**
 * Whether one asserted name satisfies one subtree of the same kind. `namesAllowed` hands over
 * only a constraint of the name's own kind, and never a name of kind `'other'`.
 */
function nameWithin(name: NameForm, constraint: NameForm): boolean {
  if (name.kind === 'dns') return dnsWithin(name.text, constraint.text);
  if (name.kind === 'email') return emailWithin(name.text, constraint.text);
  if (name.kind === 'uri') return uriWithin(name.text, constraint.text);
  if (name.kind === 'ip') return ipWithin(name.bytes, constraint.bytes);
  // `directoryName` constrains a *subtree*: the constraint's RDNs are a prefix of the
  // name's (RFC 5280 §4.2.1.10, RFC 4514 ordering). An empty constraint is a prefix of all.
  return (
    constraint.rdns.length <= name.rdns.length &&
    constraint.rdns.every((rdn, index) => rdn === name.rdns[index])
  );
}

/**
 * Whether every name `certificate` asserts survives `set`.
 *
 * A name of a kind this validator cannot compare, under a CA that constrains that kind,
 * is an unfinished check — the answer is `'unevaluable'`, never a pass; so is a
 * `subjectAltName` that cannot be read (`'unreadable'`).
 */
function namesAllowed(
  certificate: Certificate,
  set: NameConstraintSet,
): boolean | 'unevaluable' | 'unreadable' {
  const names = assertedNames(certificate);
  if (names === null) return 'unreadable';
  for (const name of names) {
    const excluded = set.excluded.filter((constraint) => constraint.kind === name.kind);
    const permitted = set.permitted.filter((constraint) => constraint.kind === name.kind);
    if (name.kind === 'other') {
      if (excluded.length > 0 || permitted.length > 0) return 'unevaluable';
      continue;
    }
    if (excluded.some((constraint) => nameWithin(name, constraint))) return false;
    // An empty `permitted` list constrains nothing: RFC 5280's subtree state starts as
    // “unbounded”, and a kind the extension does not mention stays unbounded.
    if (permitted.length === 0) continue;
    if (!permitted.some((constraint) => nameWithin(name, constraint))) return false;
  }
  return true;
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
  state: WalkState,
): Promise<PathOutcome> {
  const last = path.length - 1;
  const leafApplied = state.leafApplied;

  for (const [index, certificate] of path.entries()) {
    if (
      certificate.extensions?.some(
        (entry) =>
          entry.critical &&
          APPLIED_CRITICAL_EXTENSIONS[entry.extnID] !== true &&
          // A critical extension the **caller** applies to the end-entity certificate itself
          // (a timestamp check enforces the critical `extKeyUsage` that RFC 3161 §2.3 requires),
          // and the signer's `extKeyUsage`, which `allowsSigning` below applies.
          !(index === 0 && (leafApplied.includes(entry.extnID) || entry.extnID === OID_EXT_KEY_USAGE)),
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
    // `index < last`: both ends of the pair are on the path.
    const outcome = await signedBy(subtle, path[index] as Certificate, path[index + 1] as Certificate, state);
    if (outcome === 'budget') return { ok: false, reason: 'search-limit', indeterminate: true };
    if (outcome === 'unsupported' || outcome === 'malformed') {
      return {
        ok: false,
        reason: outcome === 'malformed' ? 'malformed' : 'unsupported-signature',
        indeterminate: true,
      };
    }
    if (outcome === 'mismatch') return { ok: false, reason: 'signature-mismatch', indeterminate: false };
  }

  if (!allowsSigning(path[0] as Certificate, leafApplied.includes(OID_EXT_KEY_USAGE))) {
    return { ok: false, reason: 'signer-usage', indeterminate: false };
  }

  for (let index = 1; index <= last; index += 1) {
    const issuer = path[index] as Certificate; // `index <= last`
    const usage = keyUsageBit(issuer, KEY_USAGE_KEY_CERT_SIGN);
    if (usage === false) return { ok: false, reason: 'key-usage', indeterminate: false };
    const constraints = basicConstraintsOf(issuer);
    if (index !== last) {
      // An intermediate has to say it is a CA.
      if (constraints === null || !constraints.cA) {
        return { ok: false, reason: 'not-a-ca', indeterminate: false };
      }
    } else if (
      constraints === null &&
      issuer.extensions?.some((entry) => entry.extnID === OID_BASIC_CONSTRAINTS) === true
    ) {
      // The anchor need not say anything: it is the user's own input, and a v1 certificate (a
      // self-signed root, typically) cannot carry extensions at all. What it does say must be
      // readable — an extension that cannot be decoded is not an absent one.
      return { ok: false, reason: 'not-a-ca', indeterminate: false };
    }
    const limit = constraints === null ? null : pathLengthOf(constraints);
    // §4.2.1.9 / §6.1.4(l): `pathLenConstraint` bounds the *intermediate* certificates
    // that follow toward the end entity — the ones between this issuer and the subject,
    // the end entity itself excluded. In this array, “below” is a lower index.
    if (limit !== null && index - 1 > limit)
      return { ok: false, reason: 'path-length', indeterminate: false };
  }

  for (let index = 1; index <= last; index += 1) {
    const issuer = path[index] as Certificate; // `index <= last`
    const constraints = constraintsOf(issuer);
    if (constraints === null) return { ok: false, reason: 'malformed', indeterminate: true };
    if (constraints.permitted.length === 0 && constraints.excluded.length === 0) continue;
    for (let below = 0; below < index; below += 1) {
      const allowed = namesAllowed(path[below] as Certificate, constraints); // `below < index`
      if (allowed === 'unreadable') return { ok: false, reason: 'malformed', indeterminate: true };
      if (allowed === 'unevaluable') {
        return { ok: false, reason: 'unsupported-critical-extension', indeterminate: true };
      }
      if (!allowed) return { ok: false, reason: 'name-constraint', indeterminate: false };
    }
  }

  return { ok: true };
}

/**
 * The certificates in `pool` whose subject is `child`'s issuer, best key-identifier match
 * first. A name match is only a candidate: every caller proves the issuer by its signature.
 */
export function candidatesFor(child: Certificate, pool: readonly Certificate[]): Certificate[] {
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
  /**
   * Critical extensions of the **signer** certificate the caller enforces itself, so the walk
   * need not refuse them: a time-stamping authority's certificate carries a critical
   * `extKeyUsage` (RFC 3161 §2.3), and `signature-timestamp` checks it. Applies to the
   * first certificate of the path only — a CA's critical extension is never excused. Naming
   * `extKeyUsage` here also leaves the signer's purposes to the caller: without it the walk
   * accepts only the ones that allow signing a document.
   */
  readonly leafCriticalExtensions?: readonly string[];
}

/**
 * One search over the candidate issuers: the graph it walks, what it has learned, and what
 * it has spent.
 */
interface WalkState {
  /** A path ended at a trust anchor and every check ran: the answer is above argument. */
  reachableFailure: { reason: TrustReason; indeterminate: boolean } | null;
  /** See {@link TrustInput.leafCriticalExtensions}. */
  readonly leafApplied: readonly string[];
  /** The candidate issuers of every certificate, in the order the walk tries them. */
  readonly issuers: ReadonlyMap<Certificate, readonly Certificate[]>;
  /** The certificates that *are* a user-imported root; a path ends at the first one it meets. */
  readonly anchors: ReadonlySet<Certificate>;
  /** Fewest issuer links from a certificate to an anchor; absent when no anchor is reachable. */
  readonly distance: ReadonlyMap<Certificate, number>;
  /** Every signature check made so far, so a pair is verified once however many paths use it. */
  readonly signatures: Map<Certificate, Map<Certificate, SignatureOutcome>>;
  /** Expansions made, against {@link MAX_WALK_STEPS}. */
  steps: number;
  /** Signature verifications started, against {@link MAX_SIGNATURE_CHECKS}. */
  signatureChecks: number;
  /** A budget ran out: the search stopped early and its silence proves nothing. */
  exhausted: boolean;
}

/**
 * Fewest issuer links from each certificate to an anchor, by a breadth-first search backwards
 * from the anchors; a certificate no anchor can be reached from has no entry.
 *
 * This is the memo of the states the search can already know are dead ends: a
 * (certificate, remaining depth) pair whose remaining depth is below this distance cannot
 * reach an anchor along *any* path, whatever came before it, so the depth-first walk never
 * enters it. It is deliberately a statement about the issuer graph alone. Remembering that a
 * depth-first descent from a certificate *failed* would be unsound, because whether a path
 * validates depends on the certificates below it — a name constraint on the anchor, say,
 * admits one prefix and refuses another — so a failure under one prefix is no evidence about
 * another. Unreachability has no such dependence, and it is exactly what makes the search
 * factorial when the pool is a clique of same-named certificates and none of them leads to a
 * root the user imported.
 */
function distancesToAnchor(
  nodes: readonly Certificate[],
  issuers: ReadonlyMap<Certificate, readonly Certificate[]>,
  anchors: ReadonlySet<Certificate>,
): Map<Certificate, number> {
  // The walk stops at an anchor, so an anchor has no outgoing issuer link to count.
  const children = new Map<Certificate, Certificate[]>();
  for (const node of nodes) {
    if (anchors.has(node)) continue;
    for (const issuer of issuers.get(node) as readonly Certificate[]) {
      const list = children.get(issuer);
      if (list === undefined) children.set(issuer, [node]);
      else list.push(node);
    }
  }
  const distance = new Map<Certificate, number>();
  const queue: Certificate[] = [];
  for (const node of nodes) {
    if (!anchors.has(node)) continue;
    distance.set(node, 0);
    queue.push(node);
  }
  for (const issuer of queue) {
    const next = (distance.get(issuer) as number) + 1; // every queued certificate has a distance
    for (const child of children.get(issuer) ?? []) {
      if (distance.has(child)) continue;
      distance.set(child, next);
      queue.push(child);
    }
  }
  return distance;
}

/**
 * Depth-first over the candidate paths, bounded by `MAX_DEPTH`, by the anchor-distance memo,
 * and by the step and signature budgets in `state`. A certificate already on `path` is never
 * a candidate again: a path with a repeated certificate contains a loop, and the path with
 * the loop cut out is shorter and strictly easier to validate.
 */
async function walk(
  subtle: SubtleCrypto,
  current: Certificate,
  now: Date,
  path: Certificate[],
  state: WalkState,
): Promise<readonly Certificate[] | null> {
  // No `exhausted` check here: a budget is only spent inside this function or `validatePath`,
  // and both callers below return as soon as they see the flag, so it is never set on entry.
  state.steps += 1;
  if (state.steps > MAX_WALK_STEPS) {
    state.exhausted = true;
    return null;
  }
  if (state.steps % YIELD_EVERY === 0) {
    // A timer is a task; a settled promise is only a microtask, which runs before rendering
    // and input. The executor form is what typechecks: the repository's `lib` is ES2023 and
    // `Promise.withResolvers` is ES2024 (`search.ts` yields the same way).
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  if (state.anchors.has(current)) {
    const outcome = await validatePath(subtle, path, now, state);
    if (outcome.ok) return path;
    // The budget ended this path's check, not the path: nothing was decided about it.
    if (state.exhausted) return null;
    // A definite failure on a path that *did* reach an anchor outranks an indeterminate
    // one: “this chain is broken” is a stronger statement than “this chain could not be
    // finished”, and the reason the user sees should be the strongest one available.
    const previous = state.reachableFailure;
    if (previous === null || (previous.indeterminate && !outcome.indeterminate)) {
      state.reachableFailure = { reason: outcome.reason, indeterminate: outcome.indeterminate };
    }
    return null;
  }

  // The depth limit is enforced below, by the anchor distance: a candidate is entered only when
  // `path.length + distance <= MAX_DEPTH`, and a certificate that is not an anchor is at
  // distance 1 or more, so `path.length` never exceeds `MAX_DEPTH` here.
  // Every certificate the walk reaches is a node of the graph, so it has an entry.
  for (const candidate of state.issuers.get(current) as readonly Certificate[]) {
    if (path.includes(candidate)) continue;
    // `candidate` would sit at position `path.length + 1`, and an anchor `distance` links
    // above it at `path.length + 1 + distance`; an anchor is accepted up to `MAX_DEPTH + 1`.
    const distance = state.distance.get(candidate);
    if (distance === undefined || path.length + distance > MAX_DEPTH) continue;
    const found = await walk(subtle, candidate, now, [...path, candidate], state);
    if (found !== null) return found;
    if (state.exhausted) return null;
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
    return {
      verdict: 'indeterminate',
      path: [],
      validity: 'unknown',
      notBefore: null,
      notAfter: null,
      reason: 'malformed',
    };
  }
  const validity = validityOf(signer, now);
  const notBefore = signer.notBefore.value.toISOString();
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

  // An imported root that *is* the signer: no chain to verify, but it still has to allow signing.
  for (const root of roots) {
    if (sameBytes(root.tbsView, signer.tbsView)) {
      const allowed = allowsSigning(signer, (input.leafCriticalExtensions ?? []).includes(OID_EXT_KEY_USAGE));
      return allowed
        ? { verdict: 'trusted', path: [name], validity, notBefore, notAfter, reason: null }
        : { verdict: 'untrusted', path: [name], validity, notBefore, notAfter, reason: 'signer-usage' };
    }
  }
  if (roots.length === 0) {
    return { verdict: 'not-checked', path: [name], validity, notBefore, notAfter, reason: 'no-roots' };
  }

  // The issuer graph is built once: candidate lookup (a name comparison and two key-id
  // parses per pair) is the same on every path, so the walk reads it instead of redoing it.
  const nodes = [signer, ...pool];
  const issuers = new Map(nodes.map((node) => [node, candidatesFor(node, pool)] as const));
  const anchors = new Set(
    nodes.filter((node) => roots.some((root) => sameBytes(root.tbsView, node.tbsView))),
  );
  const state: WalkState = {
    reachableFailure: null,
    leafApplied: input.leafCriticalExtensions ?? [],
    issuers,
    anchors,
    distance: distancesToAnchor(nodes, issuers, anchors),
    signatures: new Map(),
    steps: 0,
    signatureChecks: 0,
    exhausted: false,
  };
  const found = await walk(subtle, signer, now, [signer], state);
  if (found !== null) {
    return {
      verdict: 'trusted',
      path: found.map(displayName),
      validity,
      notBefore,
      notAfter,
      reason: null,
    };
  }

  // Checked before the self-signed and no-issuer answers: those say the search *ended*, and
  // a search that spent its budget did not.
  if (state.exhausted) {
    return {
      verdict: 'indeterminate',
      path: [name],
      validity,
      notBefore,
      notAfter,
      reason: 'search-limit',
    };
  }
  if (signer.issuer.isEqual(signer.subject)) {
    return { verdict: 'self-signed', path: [name], validity, notBefore, notAfter, reason: 'no-issuer' };
  }
  if (state.reachableFailure !== null) {
    const { reason, indeterminate } = state.reachableFailure;
    return {
      verdict: indeterminate ? 'indeterminate' : 'untrusted',
      path: [name],
      validity,
      notBefore,
      notAfter,
      reason,
    };
  }
  // A candidate existed but none of its paths reached an anchor: the chain stops short.
  return { verdict: 'untrusted', path: [name], validity, notBefore, notAfter, reason: 'no-issuer' };
}
