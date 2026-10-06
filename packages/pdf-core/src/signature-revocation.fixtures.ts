/**
 * **Test-only.** CRLs, RFC 3161 tokens and CMS wrappers built at runtime with WebCrypto,
 * `pkijs` and `asn1js`, on top of the certificates `signature-trust.fixtures.ts` issues. Used
 * by the revocation, timestamp, evidence and validation tests, which therefore run the real
 * parsers over real signatures. Nothing is committed as bytes (see the note there), and the
 * module never reaches the application bundle.
 */

import {
  BitString,
  Constructed,
  Enumerated,
  fromBER,
  Integer,
  ObjectIdentifier,
  OctetString,
  Sequence,
} from 'asn1js';
import {
  AlgorithmIdentifier,
  Attribute,
  CertificateRevocationList,
  ContentInfo,
  EncapsulatedContentInfo,
  Extension,
  Extensions,
  GeneralName,
  IssuerAndSerialNumber,
  IssuingDistributionPoint,
  MessageImprint,
  RevokedCertificate,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
  Time,
  TSTInfo,
} from 'pkijs';
import { detachedCmsSignature } from './signature-cms';
import { readSignedData } from './signature-evidence';
import type { CertificateFixture } from './signature-trust.fixtures';

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_REASON_CODE = '2.5.29.21';
const OID_DELTA_CRL_INDICATOR = '2.5.29.27';
const OID_ISSUING_DISTRIBUTION_POINT = '2.5.29.28';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';
const OID_REVOCATION_ARCHIVAL = '1.2.840.113583.1.1.8';

export const KP_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';
export const KP_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';

/** RFC 5280 §5.3.1 reason codes by name, for the entries a test puts into a CRL. */
export const CRL_REASON = { keyCompromise: 1, superseded: 4, certificateHold: 6, removeFromCRL: 8 } as const;

function ext(oid: string, critical: boolean, inner: ArrayBuffer): Extension {
  return new Extension({ extnID: oid, critical, extnValue: inner });
}

/** A critical `extKeyUsage` listing `purposes`, the way a time-stamping certificate carries it. */
export function extKeyUsageExtension(purposes: readonly string[]): Extension {
  const sequence = new Sequence({ value: purposes.map((value) => new ObjectIdentifier({ value })) });
  return ext(OID_EXT_KEY_USAGE, true, sequence.toBER(false));
}

/** `deltaCRLIndicator` (critical): the list names only changes since CRL number `base`. */
export function deltaIndicatorExtension(base = 1): Extension {
  return ext(OID_DELTA_CRL_INDICATOR, true, new Integer({ value: base }).toBER(false));
}

/** `issuingDistributionPoint` (critical) with the scope bits a test wants. */
export function scopeExtension(scope: {
  readonly indirect?: boolean;
  readonly onlySomeReasons?: boolean;
  readonly distributionPointUri?: string;
}): Extension {
  const point = new IssuingDistributionPoint({
    ...(scope.indirect === true ? { indirectCRL: true } : {}),
    ...(scope.onlySomeReasons === true
      ? { onlySomeReasons: new BitString({ valueHex: new Uint8Array([0x40]).buffer }) }
      : {}),
  } as ConstructorParameters<typeof IssuingDistributionPoint>[0]);
  if (scope.distributionPointUri !== undefined) {
    point.distributionPoint = [new GeneralName({ type: 6, value: scope.distributionPointUri })];
  }
  return ext(OID_ISSUING_DISTRIBUTION_POINT, true, point.toSchema().toBER(false));
}

export interface RevokedEntry {
  readonly cert: CertificateFixture;
  readonly at: Date;
  readonly reason?: number;
}

export interface CrlOptions {
  /** Names the CRL's issuer and, unless `signedBy` is given, signs it. */
  readonly issuer: CertificateFixture;
  /** Signs with this certificate's key instead: a CRL that claims one issuer and is signed by another. */
  readonly signedBy?: CertificateFixture;
  readonly thisUpdate: Date;
  readonly nextUpdate?: Date;
  readonly revoked?: readonly RevokedEntry[];
  readonly extensions?: readonly Extension[];
}

/** A signed X.509 CRL, DER. */
export async function issueCrl(options: CrlOptions): Promise<Uint8Array> {
  const crl = new CertificateRevocationList();
  crl.version = 1;
  crl.signature = new AlgorithmIdentifier({ algorithmId: OID_ECDSA_SHA256 });
  crl.issuer = options.issuer.parsed.subject;
  crl.thisUpdate = new Time({ type: 0, value: options.thisUpdate });
  if (options.nextUpdate !== undefined) crl.nextUpdate = new Time({ type: 0, value: options.nextUpdate });
  const revoked = (options.revoked ?? []).map((entry) => {
    const item = new RevokedCertificate({
      userCertificate: entry.cert.parsed.serialNumber,
      revocationDate: new Time({ type: 0, value: entry.at }),
    });
    if (entry.reason !== undefined) {
      item.crlEntryExtensions = new Extensions({
        extensions: [ext(OID_REASON_CODE, false, new Enumerated({ value: entry.reason }).toBER(false))],
      });
    }
    return item;
  });
  if (revoked.length > 0) crl.revokedCertificates = revoked;
  if (options.extensions !== undefined && options.extensions.length > 0) {
    crl.crlExtensions = new Extensions({ extensions: [...options.extensions] });
  }
  await crl.sign((options.signedBy ?? options.issuer).keyPair.privateKey, 'SHA-256');
  return new Uint8Array(crl.toSchema(true).toBER(false));
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function wrapSignedData(signedData: SignedData): Uint8Array {
  const info = new ContentInfo({ contentType: OID_SIGNED_DATA, content: signedData.toSchema(true) });
  return new Uint8Array(info.toSchema().toBER(false));
}

export interface TokenOptions {
  readonly tsa: CertificateFixture;
  /** The bytes the token's imprint is the SHA-256 of. */
  readonly covered: Uint8Array;
  readonly genTime: Date;
  /** Other certificates the token carries (the TSA's issuer, usually). */
  readonly extraCertificates?: readonly CertificateFixture[];
  /** Signs with this key instead of the TSA's own: a token whose signature the TSA certificate cannot verify. */
  readonly signWith?: CryptoKey;
}

/** An RFC 3161 `TimeStampToken` (a `ContentInfo` over `SignedData` over a `TSTInfo`), DER. */
export async function issueTimestampToken(options: TokenOptions): Promise<Uint8Array> {
  const imprint = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(options.covered)));
  const tst = new TSTInfo({
    version: 1,
    policy: '1.2.3.4.5',
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
      hashedMessage: new OctetString({ valueHex: buffer(imprint) }),
    }),
    serialNumber: new Integer({ value: 7 }),
    genTime: options.genTime,
  });
  const certificate = options.tsa.parsed;
  const signedData = new SignedData({
    version: 3,
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: OID_TST_INFO,
      eContent: new OctetString({ valueHex: tst.toSchema().toBER(false) }),
    }),
    signerInfos: [
      new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({
          issuer: certificate.issuer,
          serialNumber: certificate.serialNumber,
        }),
      }),
    ],
    certificates: [certificate, ...(options.extraCertificates ?? []).map((entry) => entry.parsed)],
  });
  await signedData.sign(options.signWith ?? options.tsa.keyPair.privateKey, 0, 'SHA-256');
  return wrapSignedData(signedData);
}

export interface Unsigned {
  readonly timestampToken?: Uint8Array;
  /** CRLs for `SignedData.crls`. */
  readonly crls?: readonly Uint8Array[];
  /** CRLs and OCSP responses for the Adobe `revocationInfoArchival` unsigned attribute. */
  readonly archival?: { readonly crls?: readonly Uint8Array[]; readonly ocsps?: readonly Uint8Array[] };
}

function derBlock(der: Uint8Array) {
  const parsed = fromBER(buffer(der));
  if (parsed.offset < 0) throw new Error('fixture DER does not parse');
  return parsed.result;
}

/** `cms` with unsigned material added; the signature value is untouched. */
export function withUnsigned(cms: Uint8Array, extra: Unsigned): Uint8Array {
  const signedData = readSignedData(cms);
  if (signedData === null) throw new Error('fixture CMS does not parse');
  const attributes: Attribute[] = [];
  if (extra.timestampToken !== undefined) {
    attributes.push(new Attribute({ type: OID_TIMESTAMP_TOKEN, values: [derBlock(extra.timestampToken)] }));
  }
  if (extra.archival !== undefined) {
    const section = (tag: number, ders: readonly Uint8Array[] | undefined) =>
      ders === undefined || ders.length === 0
        ? []
        : [
            new Constructed({
              idBlock: { tagClass: 3, tagNumber: tag },
              value: [new Sequence({ value: ders.map(derBlock) })],
            }),
          ];
    attributes.push(
      new Attribute({
        type: OID_REVOCATION_ARCHIVAL,
        values: [
          new Sequence({
            value: [...section(0, extra.archival.crls), ...section(1, extra.archival.ocsps)],
          }),
        ],
      }),
    );
  }
  const signer = signedData.signerInfos[0];
  if (signer === undefined) throw new Error('fixture CMS has no signer');
  if (attributes.length > 0) {
    signer.unsignedAttrs = new SignedAndUnsignedAttributes({ type: 1, attributes });
  }
  if (extra.crls !== undefined) {
    signedData.crls = extra.crls.map((der) => CertificateRevocationList.fromBER(buffer(der)));
  }
  return wrapSignedData(signedData);
}

/** The CMS signature value (what a signature timestamp's imprint covers). */
export function signatureValueOf(cms: Uint8Array): Uint8Array {
  const signer = readSignedData(cms)?.signerInfos[0];
  if (signer === undefined) throw new Error('fixture CMS has no signer');
  return new Uint8Array(signer.signature.valueBlock.valueHexView);
}

/** A detached CMS signature by `signer` over a fixed payload, with `chain` travelling along. */
export async function signedCms(
  signer: CertificateFixture,
  chain: readonly CertificateFixture[],
  signedAt: Date,
): Promise<Uint8Array> {
  const { der } = await detachedCmsSignature(
    new TextEncoder().encode('the signed byte range'),
    {
      certificate: signer.der,
      chain: chain.map((entry) => entry.der),
      privateKey: signer.keyPair.privateKey,
    },
    { signedAt },
  );
  return der;
}
