/**
 * Certificate revocation, decided from lists that are **already on the device** (“revocation
 * from user-imported CRLs and from the CRLs and OCSP responses embedded in the PDF — no online
 * service”).
 *
 * Revocation is normally a network question: a certificate says where its CRL lives and where
 * its OCSP responder answers, and a validator fetches them. This build never does — there is
 * no network at runtime, so a "not revoked" answer can only come from a list somebody hands
 * it: one the user imported, one the signer's tool archived inside the signature
 * (`adbe-revocationInfoArchival`), or one in the document's `/DSS`. Everything that cannot be
 * answered from those is reported as **unknown**, never as "not revoked".
 *
 * **Which list may speak for which certificate.** A list is accepted for a certificate only
 * when it is signed by the very certificate that *issued* it — the issuer found by checking
 * the certificate's own signature, not by matching a name. A PDF can embed any certificate it
 * likes; without this rule an attacker could ship a "CA" with the real CA's name and a CRL
 * saying nothing is revoked. The CRL's name, signature, `cRLSign` key usage and the issuer's
 * validity at `thisUpdate` are all checked; an OCSP response must be signed by the issuer or
 * by a delegate the issuer signed and marked `id-kp-OCSPSigning`.
 *
 * **What the three answers mean.**
 *  - `revoked` — a verified list names this certificate. The date and reason come from the
 *    list. Whether that happened before or after the signature is *separate*: it is compared
 *    against the validation time, and the verdict only calls a later revocation harmless when
 *    that time is a trusted timestamp (the signer's own claimed time proves nothing).
 *  - `good` — a verified list that covers this certificate does not name it. This is evidence
 *    **as of the list's `thisUpdate`**; the check records whether that moment is after the
 *    validation time (it excludes a revocation before signing) and whether the list is past
 *    its `nextUpdate` today.
 *  - `unknown` — nothing verified speaks for this certificate: no list for the issuer, the
 *    issuer's certificate is not available, or the lists that exist failed a check or use a
 *    feature (indirect, delta or partitioned CRLs) this build does not process. The reason is
 *    kept so the panel can say which.
 *
 * Not implemented, and therefore answered `unknown` rather than guessed: indirect CRLs,
 * delta CRLs standing alone, `onlySomeReasons` scopes, and OCSP certificate-ID forms other
 * than the issuer's name and key hashed with a supported digest.
 */

import {
  type BaseBlock,
  BitString,
  type Constructed,
  type Enumerated,
  type GeneralizedTime,
  Integer,
  ObjectIdentifier,
  Sequence,
} from 'asn1js';
import type { Extension, Extensions } from 'pkijs';
import {
  BasicConstraints,
  BasicOCSPResponse,
  Certificate,
  CertificateRevocationList,
  IssuingDistributionPoint,
  OCSPResponse,
} from 'pkijs';
import {
  certificateName,
  parseAsn1,
  parsedValueOf,
  validityOf,
  verifyDataSignature,
} from './signature-trust';

export type ListOrigin = 'imported' | 'embedded';

export type RevocationReason =
  | 'unspecified'
  | 'keyCompromise'
  | 'cACompromise'
  | 'affiliationChanged'
  | 'superseded'
  | 'cessationOfOperation'
  | 'certificateHold'
  | 'privilegeWithdrawn'
  | 'aACompromise';

const REASONS: Readonly<Record<number, RevocationReason>> = {
  0: 'unspecified',
  1: 'keyCompromise',
  2: 'cACompromise',
  3: 'affiliationChanged',
  4: 'superseded',
  5: 'cessationOfOperation',
  6: 'certificateHold',
  9: 'privilegeWithdrawn',
  10: 'aACompromise',
};
/** `removeFromCRL` (RFC 5280 §5.3.1): a hold that has been lifted, i.e. *not* revoked. */
const REASON_REMOVE_FROM_CRL = 8;

const OID_CRL_NUMBER = '2.5.29.20';
const OID_REASON_CODE = '2.5.29.21';
const OID_DELTA_CRL_INDICATOR = '2.5.29.27';
const OID_ISSUING_DISTRIBUTION_POINT = '2.5.29.28';
const OID_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_CRL_DISTRIBUTION_POINTS = '2.5.29.31';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';
const OID_BASIC_OCSP_RESPONSE = '1.3.6.1.5.5.7.48.1.1';

/** Critical CRL extensions this module acts on; any other critical one makes the list unusable. */
const KNOWN_CRL_EXTENSIONS: ReadonlySet<string> = new Set([
  OID_CRL_NUMBER,
  OID_DELTA_CRL_INDICATOR,
  OID_ISSUING_DISTRIBUTION_POINT,
  OID_AUTHORITY_KEY_IDENTIFIER,
]);

const KEY_USAGE_CRL_SIGN = 6;
const MAX_CHAIN = 8;

const HASHES: Readonly<Record<string, string>> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** An integer's magnitude as lower-case hex with no leading zero octets, so serials compare. */
function integerKey(view: Uint8Array): string {
  let start = 0;
  while (start < view.length - 1 && view[start] === 0) start += 1;
  return Array.from(view.subarray(start), (octet) => octet.toString(16).padStart(2, '0')).join('');
}

function serialOf(certificate: Certificate): string {
  return integerKey(new Uint8Array(certificate.serialNumber.valueBlock.valueHexView));
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function digest(subtle: SubtleCrypto, algorithm: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest(algorithm, buffer(data)));
}

function parseCertificate(der: Uint8Array): Certificate | null {
  try {
    return Certificate.fromBER(der.slice());
  } catch {
    return null;
  }
}

function extensionsOf(extensions: Extensions | undefined): Extension[] {
  return extensions?.extensions ?? [];
}

function rawExtension(extension: Extension): Uint8Array {
  return new Uint8Array(extension.extnValue.valueBlock.valueHexView);
}

/** Whether one bit of the certificate's `keyUsage` is set; `null` when it has no `keyUsage`. */
function keyUsageBit(certificate: Certificate, bit: number): boolean | null {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_KEY_USAGE);
  if (extension === undefined) return null;
  const parsed = parseAsn1(rawExtension(extension));
  if (parsed === null || !(parsed.result instanceof BitString)) return false;
  const octet = parsed.result.valueBlock.valueHexView[bit >> 3];
  return octet === undefined ? false : (octet & (0x80 >> (bit & 7))) !== 0;
}

/** The `extKeyUsage` purposes of a certificate; `null` when it has no such extension. */
export function extendedKeyUsage(certificate: Certificate): readonly string[] | null {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_EXT_KEY_USAGE);
  if (extension === undefined) return null;
  const parsed = parseAsn1(rawExtension(extension));
  if (parsed === null || !(parsed.result instanceof Sequence)) return [];
  return parsed.result.valueBlock.value
    .filter((member): member is ObjectIdentifier => member instanceof ObjectIdentifier)
    .map((member) => member.getValue());
}

/** Whether the certificate may issue certificates (`basicConstraints cA`). */
function isCa(certificate: Certificate): boolean {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_BASIC_CONSTRAINTS);
  const parsed = parsedValueOf(extension);
  return parsed instanceof BasicConstraints && parsed.cA === true;
}

/** `true` for a reason that does not end the certificate's life (a hold). */
function isHold(reason: RevocationReason | null): boolean {
  return reason === 'certificateHold';
}

/* ------------------------------------------------------------------ *
 * CRLs
 * ------------------------------------------------------------------ */

interface CrlEntry {
  readonly date: Date;
  readonly reason: RevocationReason | null;
  /** `removeFromCRL`: the entry lifts a hold, so the certificate is not revoked. */
  readonly lifted: boolean;
}

export interface ParsedCrl {
  readonly crl: CertificateRevocationList;
  readonly origin: ListOrigin;
  readonly issuerName: string | null;
  readonly thisUpdate: Date;
  readonly nextUpdate: Date | null;
  readonly entries: ReadonlyMap<string, CrlEntry>;
  /** A delta CRL names only changes: absence from it proves nothing. */
  readonly delta: boolean;
  readonly indirect: boolean;
  readonly onlyUserCerts: boolean;
  readonly onlyCaCerts: boolean;
  readonly onlyAttributeCerts: boolean;
  readonly onlySomeReasons: boolean;
  /** URIs of the `distributionPoint` the list is scoped to; `null` when it is not partitioned. */
  readonly distributionPoint: readonly string[] | null;
  /** A critical extension outside {@link KNOWN_CRL_EXTENSIONS}: the list cannot be processed. */
  readonly unsupportedCritical: boolean;
}

function uriNames(point: unknown): string[] {
  if (!Array.isArray(point)) return [];
  const out: string[] = [];
  for (const name of point) {
    const entry = name as { type?: number; value?: unknown };
    if (entry.type === 6 && typeof entry.value === 'string') out.push(entry.value);
  }
  return out;
}

/** Reads one CRL. `null` when `der` is not a CRL — never a guess at what it might be. */
export function parseCrl(der: Uint8Array, origin: ListOrigin): ParsedCrl | null {
  let crl: CertificateRevocationList;
  try {
    crl = CertificateRevocationList.fromBER(der.slice());
  } catch {
    return null;
  }
  const entries = new Map<string, CrlEntry>();
  for (const revoked of crl.revokedCertificates ?? []) {
    let reason: RevocationReason | null = null;
    let lifted = false;
    for (const extension of extensionsOf(revoked.crlEntryExtensions)) {
      if (extension.extnID !== OID_REASON_CODE) continue;
      const parsed = parseAsn1(rawExtension(extension));
      if (parsed !== null && parsed.result instanceof Integer) {
        const code = parsed.result.valueBlock.valueDec;
        lifted = code === REASON_REMOVE_FROM_CRL;
        reason = REASONS[code] ?? null;
      }
    }
    const key = integerKey(new Uint8Array(revoked.userCertificate.valueBlock.valueHexView));
    entries.set(key, { date: revoked.revocationDate.value, reason, lifted });
  }

  let delta = false;
  let indirect = false;
  let onlyUserCerts = false;
  let onlyCaCerts = false;
  let onlyAttributeCerts = false;
  let onlySomeReasons = false;
  let distributionPoint: string[] | null = null;
  let unsupportedCritical = false;
  for (const extension of extensionsOf(crl.crlExtensions)) {
    if (extension.critical && !KNOWN_CRL_EXTENSIONS.has(extension.extnID)) unsupportedCritical = true;
    if (extension.extnID === OID_DELTA_CRL_INDICATOR) delta = true;
    if (extension.extnID !== OID_ISSUING_DISTRIBUTION_POINT) continue;
    const scope = parsedValueOf(extension);
    // A scope that does not parse is never read as "no scope": pkijs hands back an empty object.
    if (
      !(scope instanceof IssuingDistributionPoint) ||
      (scope as { parsingError?: string }).parsingError !== undefined
    ) {
      unsupportedCritical = true;
      continue;
    }
    indirect = scope.indirectCRL === true;
    onlyUserCerts = scope.onlyContainsUserCerts === true;
    onlyCaCerts = scope.onlyContainsCACerts === true;
    onlyAttributeCerts = scope.onlyContainsAttributeCerts === true;
    onlySomeReasons = scope.onlySomeReasons !== undefined;
    if (scope.distributionPoint !== undefined) distributionPoint = uriNames(scope.distributionPoint);
  }
  return {
    crl,
    origin,
    issuerName: crlIssuerName(crl),
    thisUpdate: crl.thisUpdate.value,
    nextUpdate: crl.nextUpdate?.value ?? null,
    entries,
    delta,
    indirect,
    onlyUserCerts,
    onlyCaCerts,
    onlyAttributeCerts,
    onlySomeReasons,
    distributionPoint,
    unsupportedCritical,
  };
}

function crlIssuerName(crl: CertificateRevocationList): string | null {
  for (const rdn of crl.issuer.typesAndValues) {
    if (rdn.type !== '2.5.4.3') continue;
    const value = (rdn.value as { valueBlock?: { value?: unknown } }).valueBlock?.value;
    if (typeof value === 'string') return value;
  }
  return null;
}

/** What the panel shows for an imported CRL, before any certificate is involved. */
export interface CrlDescription {
  readonly issuer: string | null;
  readonly thisUpdate: string;
  readonly nextUpdate: string | null;
  readonly revokedCount: number;
  readonly delta: boolean;
}

export function describeCrl(der: Uint8Array): CrlDescription | null {
  const parsed = parseCrl(der, 'imported');
  if (parsed === null) return null;
  return {
    issuer: parsed.issuerName,
    thisUpdate: parsed.thisUpdate.toISOString(),
    nextUpdate: parsed.nextUpdate?.toISOString() ?? null,
    revokedCount: parsed.entries.size,
    delta: parsed.delta,
  };
}

type ListFailure = 'invalid-list' | 'unsupported-list' | 'list-scope';

/** Whether `crl` is a well-formed statement by `issuer`; the failure says which check broke. */
async function verifyCrl(
  subtle: SubtleCrypto,
  parsed: ParsedCrl,
  issuer: Certificate,
): Promise<'ok' | ListFailure> {
  if (parsed.unsupportedCritical || parsed.indirect) return 'unsupported-list';
  const outcome = await verifyDataSignature(
    subtle,
    issuer,
    parsed.crl.signatureAlgorithm.algorithmId,
    new Uint8Array(parsed.crl.signatureValue.valueBlock.valueHexView),
    new Uint8Array(parsed.crl.tbsView),
  );
  if (outcome === 'unsupported') return 'unsupported-list';
  if (outcome !== 'ok') return 'invalid-list';
  if (keyUsageBit(issuer, KEY_USAGE_CRL_SIGN) === false) return 'invalid-list';
  if (validityOf(issuer, parsed.thisUpdate) !== 'valid') return 'invalid-list';
  return 'ok';
}

/** The URIs a certificate's own `cRLDistributionPoints` names, for partitioned-CRL matching. */
function certificateDistributionPoints(certificate: Certificate): string[] {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_CRL_DISTRIBUTION_POINTS);
  const parsed = parsedValueOf(extension) as
    | { distributionPoints?: { distributionPoint?: unknown }[] }
    | undefined;
  return (parsed?.distributionPoints ?? []).flatMap((point) => uriNames(point.distributionPoint));
}

/* ------------------------------------------------------------------ *
 * OCSP
 * ------------------------------------------------------------------ */

export interface ParsedOcsp {
  readonly basic: BasicOCSPResponse;
  readonly origin: ListOrigin;
}

/** Reads one `OCSPResponse`; `null` unless it is a successful `id-pkix-ocsp-basic` response. */
export function parseOcsp(der: Uint8Array, origin: ListOrigin): ParsedOcsp | null {
  try {
    const response = OCSPResponse.fromBER(der.slice());
    if (response.responseStatus.valueBlock.valueDec !== 0) return null;
    if (
      response.responseBytes === undefined ||
      response.responseBytes.responseType !== OID_BASIC_OCSP_RESPONSE
    )
      return null;
    const basic = BasicOCSPResponse.fromBER(response.responseBytes.response.valueBlock.valueHexView.slice());
    return { basic, origin };
  } catch {
    return null;
  }
}

/** Whether `issuer` is a responder this response can be trusted to speak through. */
async function responderCandidates(
  subtle: SubtleCrypto,
  ocsp: ParsedOcsp,
  issuer: Certificate,
): Promise<Certificate[]> {
  const out: Certificate[] = [issuer];
  for (const delegate of ocsp.basic.certs ?? []) {
    if (!extendedKeyUsage(delegate)?.includes(OID_OCSP_SIGNING)) continue;
    if (!delegate.issuer.isEqual(issuer.subject)) continue;
    const signedByIssuer = await verifyDataSignature(
      subtle,
      issuer,
      delegate.signatureAlgorithm.algorithmId,
      new Uint8Array(delegate.signatureValue.valueBlock.valueHexView),
      new Uint8Array(delegate.tbsView),
    );
    if (signedByIssuer !== 'ok') continue;
    if (validityOf(delegate, ocsp.basic.tbsResponseData.producedAt) !== 'valid') continue;
    out.push(delegate);
  }
  return out;
}

async function ocspSignatureOk(
  subtle: SubtleCrypto,
  ocsp: ParsedOcsp,
  issuer: Certificate,
): Promise<boolean> {
  const signature = new Uint8Array(ocsp.basic.signature.valueBlock.valueHexView);
  const signed = new Uint8Array(ocsp.basic.tbsResponseData.tbsView);
  for (const candidate of await responderCandidates(subtle, ocsp, issuer)) {
    const outcome = await verifyDataSignature(
      subtle,
      candidate,
      ocsp.basic.signatureAlgorithm.algorithmId,
      signature,
      signed,
    );
    if (outcome === 'ok') return true;
  }
  return false;
}

async function certIdMatches(
  subtle: SubtleCrypto,
  id: {
    hashAlgorithm: { algorithmId: string };
    issuerNameHash: { valueBlock: { valueHexView: Uint8Array } };
    issuerKeyHash: { valueBlock: { valueHexView: Uint8Array } };
    serialNumber: { valueBlock: { valueHexView: Uint8Array } };
  },
  certificate: Certificate,
  issuer: Certificate,
): Promise<boolean> {
  const algorithm = HASHES[id.hashAlgorithm.algorithmId];
  if (algorithm === undefined) return false;
  if (integerKey(new Uint8Array(id.serialNumber.valueBlock.valueHexView)) !== serialOf(certificate))
    return false;
  const nameHash = await digest(
    subtle,
    algorithm,
    new Uint8Array(certificate.issuer.toSchema().toBER(false)),
  );
  if (!sameBytes(nameHash, new Uint8Array(id.issuerNameHash.valueBlock.valueHexView))) return false;
  const keyBits = new Uint8Array(issuer.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView);
  const keyHash = await digest(subtle, algorithm, keyBits);
  return sameBytes(keyHash, new Uint8Array(id.issuerKeyHash.valueBlock.valueHexView));
}

/** What an OCSP `certStatus` says. A revoked status always carries its time. */
type CertStatus =
  | { readonly kind: 'good' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'revoked'; readonly date: Date; readonly reason: RevocationReason | null };

/**
 * `certStatus` is `[0] good | [1] revoked { time, [0] reason } | [2] unknown`. The pkijs schema
 * that parsed the response only lets those three through, and a `[1]` is always a time and an
 * optional `[0]` holding the reason code.
 */
function readCertStatus(status: BaseBlock): CertStatus {
  const tag = status.idBlock.tagNumber;
  if (tag === 0) return { kind: 'good' };
  if (tag !== 1) return { kind: 'unknown' };
  const [time, reason] = (status as Constructed).valueBlock.value as [GeneralizedTime, Constructed?];
  const code = (reason?.valueBlock.value[0] as Enumerated | undefined)?.valueBlock.valueDec;
  return {
    kind: 'revoked',
    date: time.toDate(),
    reason: code === undefined ? null : (REASONS[code] ?? null),
  };
}

/* ------------------------------------------------------------------ *
 * The chain and the per-certificate verdict
 * ------------------------------------------------------------------ */

export type RevocationRole = 'signer' | 'intermediate' | 'timestamp';

export type RevocationStatus = 'good' | 'revoked' | 'unknown';

/** Why nothing verified speaks for a certificate (status `unknown`). */
export type RevocationUnknownReason = 'no-list' | 'no-issuer' | ListFailure;

/** One certificate's revocation answer, with the evidence it rests on. */
export interface RevocationCertCheck {
  readonly role: RevocationRole;
  /** Common name of the certificate checked. */
  readonly subject: string;
  readonly status: RevocationStatus;
  /** What the answer came from; `null` for `unknown`. */
  readonly source: 'crl' | 'ocsp' | null;
  readonly origin: ListOrigin | null;
  /** When the list or response was issued, ISO. */
  readonly thisUpdate: string | null;
  /** When it says the next one is due, ISO. */
  readonly nextUpdate: string | null;
  /** `good`: the list was issued at or after the validation time, so it excludes an earlier revocation. */
  readonly coversValidationTime: boolean | null;
  /** The list is past its `nextUpdate` on today's clock. */
  readonly stale: boolean;
  /** `revoked`: the date and reason the list gives. */
  readonly revokedAt: string | null;
  readonly reason: RevocationReason | null;
  /** `revoked`: before or after the validation time (`before-signing` also covers "at"). */
  readonly timing: 'before-signing' | 'after-signing' | null;
  readonly unknownReason: RevocationUnknownReason | null;
}

export interface RevocationSources {
  readonly crls: readonly ParsedCrl[];
  readonly ocsps: readonly ParsedOcsp[];
}

/** Parse every list once; what does not parse is dropped (it cannot speak for anything). */
export function parseRevocationSources(input: {
  readonly imported?: readonly Uint8Array[];
  readonly embeddedCrls?: readonly Uint8Array[];
  readonly embeddedOcsps?: readonly Uint8Array[];
}): RevocationSources {
  const crls: ParsedCrl[] = [];
  for (const [list, origin] of [
    [input.imported ?? [], 'imported'],
    [input.embeddedCrls ?? [], 'embedded'],
  ] as const) {
    for (const der of list) {
      const parsed = parseCrl(der, origin);
      if (parsed !== null) crls.push(parsed);
    }
  }
  const ocsps: ParsedOcsp[] = [];
  for (const der of input.embeddedOcsps ?? []) {
    const parsed = parseOcsp(der, 'embedded');
    if (parsed !== null) ocsps.push(parsed);
  }
  return { crls, ocsps };
}

interface Link {
  readonly certificate: Certificate;
  /** The certificate whose key verifies this one's signature; `null` when none is known. */
  readonly issuer: Certificate | null;
  readonly selfSigned: boolean;
}

async function issuedBy(subtle: SubtleCrypto, child: Certificate, parent: Certificate): Promise<boolean> {
  const outcome = await verifyDataSignature(
    subtle,
    parent,
    child.signatureAlgorithm.algorithmId,
    new Uint8Array(child.signatureValue.valueBlock.valueHexView),
    new Uint8Array(child.tbsView),
  );
  return outcome === 'ok';
}

/** From the leaf up: each certificate's issuer, found by its signature and not its name. */
async function buildChain(
  subtle: SubtleCrypto,
  leaf: Certificate,
  pool: readonly Certificate[],
): Promise<Link[]> {
  const links: Link[] = [];
  let current = leaf;
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    let found: Certificate | null = null;
    for (const candidate of [current, ...pool]) {
      if (!current.issuer.isEqual(candidate.subject)) continue;
      if (await issuedBy(subtle, current, candidate)) {
        found = candidate;
        break;
      }
    }
    const selfSigned =
      found !== null && sameBytes(new Uint8Array(found.tbsView), new Uint8Array(current.tbsView));
    links.push({ certificate: current, issuer: found, selfSigned });
    if (found === null || selfSigned) break;
    current = found;
  }
  return links;
}

/** A statement from one verified list or response about one certificate. */
type Evidence = {
  readonly source: 'crl' | 'ocsp';
  readonly origin: ListOrigin;
  readonly thisUpdate: Date;
  readonly nextUpdate: Date | null;
} & (
  | { readonly status: 'good' }
  | { readonly status: 'revoked'; readonly revokedAt: Date; readonly reason: RevocationReason | null }
);

type RevokedEvidence = Extract<Evidence, { status: 'revoked' }>;

export interface RevocationContext {
  readonly sources: RevocationSources;
  /** The moment the signature is judged at: a timestamp's `genTime`, else a claimed time, else now. */
  readonly validationTime: Date;
  readonly now: Date;
}

/** What one certificate's issuer-scoped lists say, and why nothing was said when it is silent. */
async function evidenceFor(
  subtle: SubtleCrypto,
  link: Link & { readonly issuer: Certificate },
  context: RevocationContext,
): Promise<{
  readonly evidence: Evidence[];
  readonly failure: ListFailure | null;
  readonly seenList: boolean;
}> {
  const { certificate, issuer } = link;
  const serial = serialOf(certificate);
  const evidence: Evidence[] = [];
  let failure: ListFailure | null = null;
  let seenList = false;
  const note = (reason: ListFailure): void => {
    // `invalid-list` is the most useful thing to tell a user; the others describe a limit.
    if (failure === null || reason === 'invalid-list') failure = reason;
  };

  for (const parsed of context.sources.crls) {
    if (!parsed.crl.issuer.isEqual(certificate.issuer)) continue;
    seenList = true;
    const verdict = await verifyCrl(subtle, parsed, issuer);
    if (verdict !== 'ok') {
      note(verdict);
      continue;
    }
    // Scope (RFC 5280 §5.2.5): a list that covers only some certificates cannot clear others.
    const ca = isCa(certificate);
    if ((parsed.onlyUserCerts && ca) || (parsed.onlyCaCerts && !ca) || parsed.onlyAttributeCerts) continue;
    if (parsed.distributionPoint !== null) {
      const own = certificateDistributionPoints(certificate);
      if (!parsed.distributionPoint.some((uri) => own.includes(uri))) {
        note('list-scope');
        continue;
      }
    }
    const entry = parsed.entries.get(serial);
    if (entry !== undefined && !entry.lifted) {
      evidence.push({
        status: 'revoked',
        source: 'crl',
        origin: parsed.origin,
        thisUpdate: parsed.thisUpdate,
        nextUpdate: parsed.nextUpdate,
        revokedAt: entry.date,
        reason: entry.reason,
      });
      continue;
    }
    // Not named: only a complete list can say "not revoked". A delta CRL lists changes and
    // `onlySomeReasons` hides the other reasons, so neither can.
    if (parsed.delta || parsed.onlySomeReasons) {
      note('list-scope');
      continue;
    }
    evidence.push({
      status: 'good',
      source: 'crl',
      origin: parsed.origin,
      thisUpdate: parsed.thisUpdate,
      nextUpdate: parsed.nextUpdate,
    });
  }

  for (const parsed of context.sources.ocsps) {
    const responses = parsed.basic.tbsResponseData.responses;
    let relevant: (typeof responses)[number] | null = null;
    for (const single of responses) {
      if (await certIdMatches(subtle, single.certID, certificate, issuer)) {
        relevant = single;
        break;
      }
    }
    if (relevant === null) continue;
    seenList = true;
    if (!(await ocspSignatureOk(subtle, parsed, issuer))) {
      note('invalid-list');
      continue;
    }
    const status = readCertStatus(relevant.certStatus);
    if (status.kind === 'unknown') {
      note('list-scope');
      continue;
    }
    const stated = {
      source: 'ocsp',
      origin: parsed.origin,
      thisUpdate: relevant.thisUpdate,
      nextUpdate: relevant.nextUpdate ?? null,
    } as const;
    evidence.push(
      status.kind === 'good'
        ? { status: 'good', ...stated }
        : { status: 'revoked', ...stated, revokedAt: status.date, reason: status.reason },
    );
  }
  return { evidence, failure, seenList };
}

/** The evidence that decides: a lasting revocation wins, otherwise the newest statement. */
function decisive(evidence: readonly Evidence[], validationTime: Date): Evidence | null {
  const lasting = evidence.filter(
    (entry): entry is RevokedEvidence => entry.status === 'revoked' && !isHold(entry.reason),
  );
  const [first, ...others] = lasting;
  if (first !== undefined) {
    return others.reduce(
      (earliest, entry) => (entry.revokedAt < earliest.revokedAt ? entry : earliest),
      first,
    );
  }
  const newest = [...evidence].sort((a, b) => b.thisUpdate.getTime() - a.thisUpdate.getTime());
  // Among equally recent statements prefer one that excludes an earlier revocation.
  const covering = newest.find((entry) => entry.thisUpdate >= validationTime);
  return covering ?? newest[0] ?? null;
}

/** The answer when nothing verified speaks for the certificate. */
function unknownCheck(
  link: Link,
  role: RevocationRole,
  unknownReason: RevocationUnknownReason,
): RevocationCertCheck {
  return {
    role,
    subject: certificateName(link.certificate) ?? '—',
    status: 'unknown',
    source: null,
    origin: null,
    thisUpdate: null,
    nextUpdate: null,
    coversValidationTime: null,
    stale: false,
    revokedAt: null,
    reason: null,
    timing: null,
    unknownReason,
  };
}

/** The answer a verified list or response gives. */
function decidedCheck(
  link: Link,
  role: RevocationRole,
  decided: Evidence,
  context: RevocationContext,
): RevocationCertCheck {
  const common = {
    role,
    subject: certificateName(link.certificate) ?? '—',
    source: decided.source,
    origin: decided.origin,
    thisUpdate: decided.thisUpdate.toISOString(),
    nextUpdate: decided.nextUpdate?.toISOString() ?? null,
    stale: decided.nextUpdate !== null && decided.nextUpdate < context.now,
    unknownReason: null,
  } as const;
  if (decided.status === 'good') {
    return {
      ...common,
      status: 'good',
      coversValidationTime: decided.thisUpdate >= context.validationTime,
      revokedAt: null,
      reason: null,
      timing: null,
    };
  }
  return {
    ...common,
    status: 'revoked',
    coversValidationTime: null,
    revokedAt: decided.revokedAt.toISOString(),
    reason: decided.reason,
    timing: decided.revokedAt <= context.validationTime ? 'before-signing' : 'after-signing',
  };
}

/**
 * Check `leaf` and every certificate between it and the root of the chain it sits on.
 *
 * The pool is every certificate known for the signature (the CMS's own, the `/DSS`'s and the
 * ones the user imported as roots); the chain is rebuilt from signatures, so a certificate in
 * the pool that does not actually sign the one below it is simply not used. A self-signed
 * certificate at the top is not checked (nothing above it publishes a list for it) unless it
 * is the leaf itself, where an absent list is an honest `unknown`.
 */
export async function checkRevocation(input: {
  readonly leaf: Uint8Array;
  readonly leafRole: 'signer' | 'timestamp';
  readonly pool: readonly Uint8Array[];
  readonly context: RevocationContext;
}): Promise<readonly RevocationCertCheck[]> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return [];
  const leaf = parseCertificate(input.leaf);
  if (leaf === null) return [];
  const pool = input.pool.map(parseCertificate).filter((entry): entry is Certificate => entry !== null);

  const links = await buildChain(subtle, leaf, pool);
  const checks: RevocationCertCheck[] = [];
  for (const [index, link] of links.entries()) {
    if (link.selfSigned && index > 0) continue;
    const role: RevocationRole = index === 0 ? input.leafRole : 'intermediate';
    if (link.issuer === null) {
      checks.push(unknownCheck(link, role, 'no-issuer'));
      continue;
    }
    const { evidence, failure, seenList } = await evidenceFor(
      subtle,
      { ...link, issuer: link.issuer },
      input.context,
    );
    const decided = decisive(evidence, input.context.validationTime);
    checks.push(
      decided === null
        ? unknownCheck(link, role, seenList ? (failure ?? 'list-scope') : 'no-list')
        : decidedCheck(link, role, decided, input.context),
    );
  }
  return checks;
}

/* ------------------------------------------------------------------ *
 * The one-word summary
 * ------------------------------------------------------------------ */

/**
 * `'not-revoked'` — every checked certificate was cleared by a verified list that speaks for
 * the validation time.
 * `'not-revoked-outdated'` — every checked certificate was cleared, but some list is too old to
 * rule out a revocation: it was issued before the validation time, or it is past its
 * `nextUpdate` while the validation time is not a trusted timestamp (a signer's own claimed
 * time can be back-dated to sit before an old list, so only a current list then proves
 * anything).
 * `'revoked'` — one was revoked, and either the revocation is not provably later than the
 * signature or it is.
 * `'revoked-after-signing'` — every revocation found is dated after a **trusted** validation
 * time: the signature was made while the certificate was good.
 * `'partial'` — nothing was revoked and at least one certificate was cleared, but another has no
 * answer (typically the CA above the signer, when only the signer's issuer published a list).
 * `'indeterminate'` — nothing was revoked, and nothing was cleared either.
 */
export type RevocationSummary =
  | 'not-revoked'
  | 'not-revoked-outdated'
  | 'revoked'
  | 'revoked-after-signing'
  | 'partial'
  | 'indeterminate';

export function summarizeRevocation(
  checks: readonly RevocationCertCheck[],
  trustedTime: boolean,
): RevocationSummary {
  if (checks.length === 0) return 'indeterminate';
  const revoked = checks.filter((check) => check.status === 'revoked');
  if (revoked.length > 0) {
    // A later revocation is only harmless when the time it is compared with cannot be moved
    // by the signer: the signer's own claimed time says nothing about when the file was made.
    const allLater = revoked.every((check) => check.timing === 'after-signing');
    return allLater && trustedTime ? 'revoked-after-signing' : 'revoked';
  }
  if (checks.every((check) => check.status === 'good')) {
    // A list issued before the signature cannot exclude a revocation in between; a list past
    // its nextUpdate proves nothing about a time the signer could have chosen.
    const outdated = checks.some(
      (check) => check.coversValidationTime === false || (check.stale && !trustedTime),
    );
    return outdated ? 'not-revoked-outdated' : 'not-revoked';
  }
  return checks.some((check) => check.status === 'good') ? 'partial' : 'indeterminate';
}
