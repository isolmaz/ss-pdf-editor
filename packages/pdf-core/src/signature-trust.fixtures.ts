/**
 * **Test-only.** A miniature PKI built at runtime with WebCrypto and `pkijs`, used by
 * `signature-trust.test.ts` to exercise the real parser and the real verifier.
 *
 * Why generate instead of committing fixtures: a chain is a *cryptographic* statement, and
 * the bytes that matter are the ones the encoder produced for the key it actually holds.
 * Committed DER blobs would let an encoder bug hide behind a stale file, and `.gitignore`
 * in this repository deliberately refuses `*.pem`/`*.key`, so a committed private key would
 * be a policy violation rather than a fixture. Everything here is deterministic in
 * structure (serial numbers are a counter, names are explicit) and re-generated per run.
 *
 * The module is imported only by tests: it never reaches the application bundle.
 *
 * `INDEPENDENT` verification lives in the test, not here: every generated certificate is
 * checked with Node's OpenSSL-backed `crypto.X509Certificate.verify()` so the DER this
 * builder emits is validated by a second implementation, not by the same code path that
 * consumes it.
 */

import {
  Set as AsnSet,
  BitString,
  fromBER,
  Integer,
  Null,
  ObjectIdentifier,
  OctetString,
  Primitive,
  Sequence,
  Utf8String,
} from 'asn1js';
import type { Certificate as PkijsCertificate } from 'pkijs';
import {
  AlgorithmIdentifier,
  AttributeTypeAndValue,
  BasicConstraints,
  Certificate,
  Extension,
  GeneralName,
  GeneralNames,
  GeneralSubtree,
  NameConstraints,
  PublicKeyInfo,
  RelativeDistinguishedNames,
  Time,
} from 'pkijs';

const OID_COMMON_NAME = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_NAME_CONSTRAINTS = '2.5.29.30';

const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_RSA_SHA256 = '1.2.840.113549.1.1.11';
const OID_RSA_SHA384 = '1.2.840.113549.1.1.12';
const OID_RSA_SHA512 = '1.2.840.113549.1.1.13';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_ECDSA_SHA384 = '1.2.840.10045.4.3.3';
const OID_ECDSA_SHA512 = '1.2.840.10045.4.3.4';

/** `KeyUsage` bits, named the way RFC 5280 §4.2.1.3 orders them. */
export const KEY_USAGE_BITS = {
  digitalSignature: 0,
  nonRepudiation: 1,
  keyEncipherment: 2,
  dataEncipherment: 3,
  keyAgreement: 4,
  keyCertSign: 5,
  cRLSign: 6,
  encipherOnly: 7,
  decipherOnly: 8,
} as const;

export type KeyUsageName = keyof typeof KEY_USAGE_BITS;

export type CurveName = 'P-256' | 'P-384' | 'P-521';

export type KeySpec =
  | { readonly kind: 'EC'; readonly curve: CurveName }
  | { readonly kind: 'RSA'; readonly hash?: HashName };

/** `directory` is `directoryName` (a `CN=` name) and `registeredId` a kind no validator here compares. */
export type NameKind = 'dns' | 'email' | 'uri' | 'ip' | 'directory' | 'registeredId';

export interface GeneralNameSpec {
  readonly kind: NameKind;
  readonly value: string;
}

export interface IssueOptions {
  /** The subject common name; also what `certificateName` must read back. */
  readonly subject: string;
  readonly keyPair: CryptoKeyPair;
  /**
   * Certificate signature algorithm. `'unsupported'` writes an OID no validator in this
   * repository recognises, so the fixture can prove that "cannot verify" is reported as
   * such instead of masquerading as "not trusted".
   */
  readonly signature?:
    | { readonly name: 'ECDSA'; readonly hash: 'SHA-256' | 'SHA-384' | 'SHA-512' }
    | {
        readonly name: 'RSA-PKCS1';
        readonly hash: 'SHA-256' | 'SHA-384' | 'SHA-512';
      }
    | { readonly name: 'unsupported' }
    /** An ECDSA OID over bytes that are not a DER signature at all. */
    | { readonly name: 'malformed' };
  /** The SubjectPublicKeyInfo DER written into the certificate instead of the key pair's own. */
  readonly spki?: Uint8Array;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
  /** Writes this subject name instead of `CN=<subject>` (a name with no common name, say). */
  readonly subjectName?: RelativeDistinguishedNames;
  /** The serial number's content octets, as written (a leading zero octet is kept); a counter by default. */
  readonly serial?: Uint8Array;
  /** Omit for no `basicConstraints` extension at all (the v1-style default). */
  readonly basicConstraints?: { readonly cA: boolean; readonly pathLen?: number };
  /** Omit for no `keyUsage` extension at all. */
  readonly keyUsage?: readonly KeyUsageName[];
  readonly subjectAltNames?: readonly GeneralNameSpec[];
  readonly nameConstraints?: {
    readonly permitted?: readonly GeneralNameSpec[];
    readonly excluded?: readonly GeneralNameSpec[];
  };
  /** Extra extensions, verbatim, for the cases the named options do not cover. */
  readonly extraExtensions?: readonly Extension[];
}

export interface CertificateFixture {
  readonly der: Uint8Array;
  /** The parsed form, exactly as the product code parses it. */
  readonly parsed: PkijsCertificate;
  readonly keyPair: CryptoKeyPair;
  readonly subject: string;
  /** `true` when this certificate signed itself. */
  readonly selfSigned: boolean;
}

let serialCounter = 0;

/** A counter, so a failing run can be reproduced from the serial numbers it printed. */
function nextSerial(): Uint8Array {
  serialCounter += 1;
  return Uint8Array.from([0x60, 0x00, serialCounter & 0xff, (serialCounter >> 8) & 0xff]);
}

export async function generateKey(spec: KeySpec): Promise<CryptoKeyPair> {
  if (spec.kind === 'RSA') {
    return await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: Uint8Array.from([1, 0, 1]),
        hash: spec.hash ?? 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
  }
  return await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: spec.curve }, true, ['sign', 'verify']);
}

/** The `rawToDer` half of the ECDSA pair: exactly what `signature-cms` does when signing. */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length % 2 !== 0) throw new Error('an ECDSA signature is an even number of bytes');
  const half = raw.length / 2;
  const part = (bytes: Uint8Array): Integer => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    return new Integer({ valueHex: bytes.subarray(start).slice().buffer }).convertToDER();
  };
  return new Uint8Array(
    new Sequence({ value: [part(raw.subarray(0, half)), part(raw.subarray(half))] }).toBER(false),
  );
}

type HashName = 'SHA-256' | 'SHA-384' | 'SHA-512';

/**
 * How this certificate will be signed. A closed union rather than an `Algorithm` object:
 * WebCrypto's `AlgorithmIdentifier` cannot describe Ed25519 here, and the `'unsupported'`
 * case exists precisely to emit an algorithm the product code must refuse.
 */
type SignaturePlan =
  | { readonly kind: 'ecdsa'; readonly oid: string; readonly hash: HashName }
  | { readonly kind: 'rsa'; readonly oid: string; readonly hash: HashName }
  | { readonly kind: 'unsupported'; readonly oid: string }
  | { readonly kind: 'garbage'; readonly oid: string };

function planFor(options: IssueOptions, keyPair: CryptoKeyPair): SignaturePlan {
  const requested = options.signature;
  if (requested?.name === 'malformed') return { kind: 'garbage', oid: OID_ECDSA_SHA256 };
  if (requested?.name === 'unsupported') {
    // `1.3.101.112` is Ed25519: a real algorithm this repository does not implement.
    return { kind: 'unsupported', oid: '1.3.101.112' };
  }
  const algorithm = keyPair.privateKey.algorithm;
  if (algorithm.name === 'ECDSA') {
    const hash = requested?.name === 'ECDSA' ? requested.hash : 'SHA-256';
    const oid =
      hash === 'SHA-256' ? OID_ECDSA_SHA256 : hash === 'SHA-384' ? OID_ECDSA_SHA384 : OID_ECDSA_SHA512;
    return { kind: 'ecdsa', oid, hash };
  }
  // A plain `rsaEncryption` OID leaves the hash to the caller (the CMS case); asking for
  // `RSA-PKCS1` writes the `shaNWithRSAEncryption` OID a real certificate carries.
  if (requested?.name === 'RSA-PKCS1') {
    const oid = { 'SHA-256': OID_RSA_SHA256, 'SHA-384': OID_RSA_SHA384, 'SHA-512': OID_RSA_SHA512 }[
      requested.hash
    ];
    return { kind: 'rsa', oid, hash: requested.hash };
  }
  return { kind: 'rsa', oid: OID_RSA_ENCRYPTION, hash: 'SHA-256' };
}

/** The bytes a signature is computed over, and the DER a certificate must carry. */
async function signTbs(plan: SignaturePlan, signingKey: CryptoKey, tbs: Uint8Array): Promise<Uint8Array> {
  const input = new ArrayBuffer(tbs.byteLength);
  new Uint8Array(input).set(tbs);
  if (plan.kind === 'rsa')
    return new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, signingKey, input));
  if (plan.kind === 'ecdsa') {
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: plan.hash }, signingKey, input),
    );
    return ecdsaRawToDer(raw);
  }
  // Deliberately not a signature: the fixture exists to prove that "unsupported" (and, with an
  // ECDSA OID, "malformed") is
  // reported as such, and these bytes must never accidentally verify.
  return new Uint8Array(64).fill(0x5a);
}

/**
 * A name of one `CN=` RDN per entry, outermost first; no entries is the empty name.
 *
 * `RelativeDistinguishedNames` built from its fields writes every attribute into **one** `SET`
 * (a multi-valued RDN); only a name read from DER keeps the `SEQUENCE OF SET` it was written
 * with, so the name is encoded first and read back.
 */
export function commonNames(commonNameList: readonly string[]): RelativeDistinguishedNames {
  const encoded = new Sequence({
    value: commonNameList.map(
      (commonName) =>
        new AsnSet({
          value: [
            new AttributeTypeAndValue({
              type: OID_COMMON_NAME,
              value: new Utf8String({ value: commonName }),
            }).toSchema(),
          ],
        }),
    ),
  }).toBER(false);
  return new RelativeDistinguishedNames({ schema: fromBER(encoded).result });
}

/** The octets of a dotted-quad or colon-hex address (one `::` allowed), as an `iPAddress` holds them. */
function addressOctets(text: string): number[] {
  if (!text.includes(':')) return text.split('.').map((part) => Number.parseInt(part, 10));
  const [head = '', tail] = text.split('::');
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros = Array.from<string>({ length: 8 - left.length - right.length }).fill('0');
  return [...left, ...zeros, ...right].flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

/** The `GeneralName` a fixture spec names, built the way RFC 5280 tags each choice. */
function generalName(spec: GeneralNameSpec): GeneralName {
  if (spec.kind === 'dns') return new GeneralName({ type: 2, value: spec.value });
  if (spec.kind === 'email') return new GeneralName({ type: 1, value: spec.value });
  if (spec.kind === 'uri') return new GeneralName({ type: 6, value: spec.value });
  if (spec.kind === 'directory') {
    // `Outer/Inner` is two RDNs, outermost first; the empty value is the empty name.
    return new GeneralName({
      type: 4,
      value: commonNames(spec.value === '' ? [] : spec.value.split('/')),
    });
  }
  if (spec.kind === 'registeredId') return new GeneralName({ type: 8, value: spec.value });
  // An address is dotted-quad or colon-hex; a constraint's mask follows after a `/`.
  const octets = spec.value.split('/').flatMap(addressOctets);
  return new GeneralName({
    type: 7,
    value: new OctetString({ valueHex: Uint8Array.from(octets).buffer as ArrayBuffer }),
  });
}

/**
 * `pkijs` wraps `extnValue` into the `OCTET STRING` itself, so it takes the *inner* DER —
 * handing it a ready-made `OctetString` is the classic "not a BufferSource" failure.
 */
function extension(oid: string, critical: boolean, inner: ArrayBuffer): Extension {
  return new Extension({ extnID: oid, critical, extnValue: inner });
}

function keyUsageExtension(bits: readonly KeyUsageName[]): Extension {
  const highest = Math.max(...bits.map((bit) => KEY_USAGE_BITS[bit]));
  const octets = new Uint8Array(Math.ceil((highest + 1) / 8));
  for (const bit of bits) {
    const index = KEY_USAGE_BITS[bit];
    octets[index >> 3] = (octets[index >> 3] ?? 0) | (0x80 >> (index & 7));
  }
  // The BIT STRING's trailing zero bits are "unused", and DER says how many.
  const encoded = new BitString({ unusedBits: 7 - (highest & 7), valueHex: octets.buffer as ArrayBuffer });
  return extension(OID_KEY_USAGE, true, encoded.toBER(false));
}

function extensionsOf(options: IssueOptions): Extension[] {
  const extensions: Extension[] = [];
  if (options.basicConstraints !== undefined) {
    const constraints = new BasicConstraints({
      cA: options.basicConstraints.cA,
      ...(options.basicConstraints.pathLen === undefined
        ? {}
        : { pathLenConstraint: options.basicConstraints.pathLen }),
    });
    extensions.push(extension(OID_BASIC_CONSTRAINTS, true, constraints.toSchema().toBER(false)));
  }
  if (options.keyUsage !== undefined && options.keyUsage.length > 0)
    extensions.push(keyUsageExtension(options.keyUsage));
  if (options.subjectAltNames !== undefined && options.subjectAltNames.length > 0) {
    const names = new GeneralNames({ names: options.subjectAltNames.map(generalName) });
    extensions.push(extension(OID_SUBJECT_ALT_NAME, false, names.toSchema().toBER(false)));
  }
  if (options.nameConstraints !== undefined) {
    const constraints = new NameConstraints({
      ...(options.nameConstraints.permitted === undefined
        ? {}
        : {
            permittedSubtrees: options.nameConstraints.permitted.map(
              (entry) => new GeneralSubtree({ base: generalName(entry), minimum: 0 }),
            ),
          }),
      ...(options.nameConstraints.excluded === undefined
        ? {}
        : {
            excludedSubtrees: options.nameConstraints.excluded.map(
              (entry) => new GeneralSubtree({ base: generalName(entry), minimum: 0 }),
            ),
          }),
    });
    extensions.push(extension(OID_NAME_CONSTRAINTS, true, constraints.toSchema().toBER(false)));
  }
  extensions.push(...(options.extraExtensions ?? []));
  return extensions;
}

/** `subjectKeyIdentifier` holding exactly these octets. */
export function subjectKeyIdentifierExtension(identifier: Uint8Array): Extension {
  return extension('2.5.29.14', false, new OctetString({ valueHex: identifier.slice().buffer }).toBER(false));
}

/** `authorityKeyIdentifier` with its `[0] keyIdentifier` set to these octets. */
export function authorityKeyIdentifierExtension(identifier: Uint8Array): Extension {
  const inner = new Sequence({
    value: [new Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: identifier.slice().buffer })],
  });
  return extension('2.5.29.35', false, inner.toBER(false));
}

/** An extension carrying exactly these inner bytes, however wrong they are for its OID. */
export function rawExtension(oid: string, critical: boolean, inner: ArrayBuffer): Extension {
  return extension(oid, critical, inner);
}

/** A SubjectPublicKeyInfo for an algorithm and parameters OID with a made-up key (never imported). */
export function fakeSpki(
  algorithmOid: string,
  parametersOid: string | null,
  keyBytes: Uint8Array,
): Uint8Array {
  const algorithm = new Sequence({
    value: [
      new ObjectIdentifier({ value: algorithmOid }),
      ...(parametersOid === null ? [] : [new ObjectIdentifier({ value: parametersOid })]),
    ],
  });
  const key = new BitString({ valueHex: keyBytes.slice().buffer });
  return new Uint8Array(new Sequence({ value: [algorithm, key] }).toBER(false));
}

/** An extension whose OID no validator here knows, marked critical. */
export function unknownCriticalExtension(oid = '1.3.6.1.4.1.99999.1'): Extension {
  return extension(oid, true, new Uint8Array([0x05, 0x00]).buffer as ArrayBuffer);
}

/**
 * Issues one certificate. `issuer` is the certificate that signs it; omit it for a
 * self-signed certificate, in which case `options.keyPair` must hold the signing key.
 */
export async function issueCertificate(
  options: IssueOptions,
  issuer?: CertificateFixture,
): Promise<CertificateFixture> {
  const signer = issuer ?? null;
  const signingKey = signer === null ? options.keyPair.privateKey : signer.keyPair.privateKey;
  const plan = planFor(options, signer?.keyPair ?? options.keyPair);

  const spki =
    options.spki ?? new Uint8Array(await crypto.subtle.exportKey('spki', options.keyPair.publicKey));
  const certificate = new Certificate();
  certificate.version = 2;
  certificate.serialNumber = new Integer({
    valueHex: (options.serial ?? nextSerial()).slice().buffer as ArrayBuffer,
  });
  const algorithmIdentifier = new AlgorithmIdentifier({
    algorithmId: plan.oid,
    // RSA wants an explicit NULL; ECDSA and Ed25519 must not have parameters. Getting this
    // backwards is a classic source of "valid signature, unverifiable certificate".
    ...(plan.oid === OID_RSA_ENCRYPTION ? { algorithmParams: new Null() } : {}),
  });
  certificate.signature = algorithmIdentifier;
  certificate.signatureAlgorithm = algorithmIdentifier;
  certificate.issuer = signer === null ? commonNames([options.subject]) : signer.parsed.subject;
  const notBefore = options.notBefore ?? new Date(Date.UTC(2026, 0, 1));
  const notAfter = options.notAfter ?? new Date(Date.UTC(2027, 0, 1));
  certificate.notBefore = new Time({ type: 0, value: notBefore });
  certificate.notAfter = new Time({ type: 0, value: notAfter });
  certificate.subject = options.subjectName ?? commonNames([options.subject]);
  certificate.subjectPublicKeyInfo = PublicKeyInfo.fromBER(
    spki.slice().buffer as ArrayBuffer,
  ) as unknown as PublicKeyInfo;
  const extensions = extensionsOf(options);
  if (extensions.length > 0) certificate.extensions = extensions;

  certificate.tbsView = new Uint8Array(certificate.encodeTBS().toBER(false));
  const signed = await signTbs(plan, signingKey, certificate.tbsView);
  certificate.signatureValue = new BitString({ valueHex: signed.slice().buffer as ArrayBuffer });

  const der = new Uint8Array(certificate.toSchema(false).toBER(false));
  return {
    der,
    parsed: Certificate.fromBER(der.slice().buffer as ArrayBuffer),
    keyPair: options.keyPair,
    subject: options.subject,
    selfSigned: signer === null,
  };
}

/** A certificate from raw DER, for the malformed-input cases. */
export function parse(der: Uint8Array): PkijsCertificate {
  return Certificate.fromBER(der.slice().buffer as ArrayBuffer);
}

/** `SEQUENCE { r INTEGER, s INTEGER }` read back, for asserting the conversion's inverse. */
export function derIntegers(der: Uint8Array): { readonly r: Uint8Array; readonly s: Uint8Array } {
  const parsed = fromBER(der.slice().buffer as ArrayBuffer);
  if (parsed.offset < 0) throw new Error('not DER');
  const sequence = parsed.result as Sequence;
  const [r, s] = sequence.valueBlock.value as Integer[];
  if (r === undefined || s === undefined) throw new Error('not a signature pair');
  return {
    r: new Uint8Array(r.valueBlock.valueHexView),
    s: new Uint8Array(s.valueBlock.valueHexView),
  };
}
