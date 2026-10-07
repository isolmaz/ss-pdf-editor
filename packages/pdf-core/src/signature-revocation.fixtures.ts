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
  GeneralizedTime,
  Integer,
  ObjectIdentifier,
  OctetString,
  Primitive,
  Sequence,
  Utf8String,
} from 'asn1js';
import {
  AlgorithmIdentifier,
  Attribute,
  AttributeTypeAndValue,
  BasicOCSPResponse,
  CertID,
  CertificateRevocationList,
  ContentInfo,
  CRLDistributionPoints,
  DistributionPoint,
  EncapsulatedContentInfo,
  Extension,
  Extensions,
  GeneralName,
  IssuerAndSerialNumber,
  IssuingDistributionPoint,
  MessageImprint,
  OCSPResponse,
  RelativeDistinguishedNames,
  ResponseBytes,
  ResponseData,
  RevokedCertificate,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
  SingleResponse,
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
export const OID_BASIC_OCSP_RESPONSE = '1.3.6.1.5.5.7.48.1.1';

export const KP_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';
export const KP_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';

/** RFC 5280 §5.3.1 reason codes by name, for the entries a test puts into a CRL. */
export const CRL_REASON = { keyCompromise: 1, superseded: 4, certificateHold: 6, removeFromCRL: 8 } as const;

function ext(oid: string, critical: boolean, inner: ArrayBuffer): Extension {
  return new Extension({ extnID: oid, critical, extnValue: inner });
}

/** `cRLDistributionPoints` naming the CRL URIs a certificate says its revocation list lives at. */
export function crlDistributionPointsExtension(uris: readonly string[]): Extension {
  const points = new CRLDistributionPoints({
    distributionPoints: uris.map(
      (uri) => new DistributionPoint({ distributionPoint: [new GeneralName({ type: 6, value: uri })] }),
    ),
  });
  return ext('2.5.29.31', false, points.toSchema().toBER(false));
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
  readonly onlyUserCerts?: boolean;
  readonly onlyCaCerts?: boolean;
  readonly onlyAttributeCerts?: boolean;
  readonly distributionPointUri?: string;
  /** The `distributionPoint` is a DNS name, which is not a URI. */
  readonly distributionPointDns?: string;
  /** The `distributionPoint` is `nameRelativeToCRLIssuer` (a relative name, not a list of general names). */
  readonly distributionPointRelativeName?: string;
  /** The value is not what an `issuingDistributionPoint` looks like. */
  readonly malformed?: boolean;
}): Extension {
  if (scope.malformed === true)
    return ext(OID_ISSUING_DISTRIBUTION_POINT, true, new Integer({ value: 5 }).toBER(false));
  const point = new IssuingDistributionPoint({
    ...(scope.indirect === true ? { indirectCRL: true } : {}),
    ...(scope.onlyUserCerts === true ? { onlyContainsUserCerts: true } : {}),
    ...(scope.onlyCaCerts === true ? { onlyContainsCACerts: true } : {}),
    ...(scope.onlyAttributeCerts === true ? { onlyContainsAttributeCerts: true } : {}),
    ...(scope.onlySomeReasons === true
      ? { onlySomeReasons: new BitString({ valueHex: new Uint8Array([0x40]).buffer }) }
      : {}),
  } as ConstructorParameters<typeof IssuingDistributionPoint>[0]);
  if (scope.distributionPointUri !== undefined) {
    point.distributionPoint = [new GeneralName({ type: 6, value: scope.distributionPointUri })];
  }
  if (scope.distributionPointDns !== undefined) {
    point.distributionPoint = [new GeneralName({ type: 2, value: scope.distributionPointDns })];
  }
  if (scope.distributionPointRelativeName !== undefined) {
    point.distributionPoint = new RelativeDistinguishedNames({
      typesAndValues: [
        new AttributeTypeAndValue({
          type: '2.5.4.3',
          value: new Utf8String({ value: scope.distributionPointRelativeName }),
        }),
      ],
    });
  }
  return ext(OID_ISSUING_DISTRIBUTION_POINT, true, point.toSchema().toBER(false));
}

export interface RevokedEntry {
  readonly cert: CertificateFixture;
  /** The serial number written into the entry instead of the certificate's (content octets, as given). */
  readonly serial?: Uint8Array;
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
  /** Writes this issuer name into the CRL instead of the issuer certificate's subject. */
  readonly issuerName?: RelativeDistinguishedNames;
  /** Written as the CRL's `signatureAlgorithm` after signing, so the list names an algorithm nobody implements. */
  readonly signatureAlgorithmOid?: string;
  /** Extensions written into every revoked entry besides the reason code. */
  readonly entryExtensions?: readonly Extension[];
}

/** A signed X.509 CRL, DER. */
export async function issueCrl(options: CrlOptions): Promise<Uint8Array> {
  const crl = new CertificateRevocationList();
  crl.version = 1;
  crl.signature = new AlgorithmIdentifier({ algorithmId: OID_ECDSA_SHA256 });
  crl.issuer = options.issuerName ?? options.issuer.parsed.subject;
  crl.thisUpdate = new Time({ type: 0, value: options.thisUpdate });
  if (options.nextUpdate !== undefined) crl.nextUpdate = new Time({ type: 0, value: options.nextUpdate });
  const revoked = (options.revoked ?? []).map((entry) => {
    const item = new RevokedCertificate({
      userCertificate:
        entry.serial === undefined
          ? entry.cert.parsed.serialNumber
          : new Integer({ valueHex: entry.serial.slice().buffer }),
      revocationDate: new Time({ type: 0, value: entry.at }),
    });
    const entryExtensions = [...(options.entryExtensions ?? [])];
    if (entry.reason !== undefined) {
      entryExtensions.push(ext(OID_REASON_CODE, false, new Enumerated({ value: entry.reason }).toBER(false)));
    }
    if (entryExtensions.length > 0) item.crlEntryExtensions = new Extensions({ extensions: entryExtensions });
    return item;
  });
  if (revoked.length > 0) crl.revokedCertificates = revoked;
  if (options.extensions !== undefined && options.extensions.length > 0) {
    crl.crlExtensions = new Extensions({ extensions: [...options.extensions] });
  }
  await crl.sign((options.signedBy ?? options.issuer).keyPair.privateKey, 'SHA-256');
  if (options.signatureAlgorithmOid !== undefined) {
    crl.signatureAlgorithm = new AlgorithmIdentifier({ algorithmId: options.signatureAlgorithmOid });
  }
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
  /** Written as the imprint's hash OID instead of SHA-256 (the imprint bytes stay a SHA-256 digest). */
  readonly imprintAlgorithmOid?: string;
  /** Names the signer by `[0] subjectKeyIdentifier` with these octets instead of by issuer and serial. */
  readonly keyIdentifier?: Uint8Array;
  /** `keyIdentifier` written as a BER-constructed `[0]` of two OCTET STRING segments instead of primitive DER. */
  readonly keyIdentifierConstructed?: boolean;
  /** Signs over signed attributes (RFC 5652 §5.4) instead of the TSTInfo itself. */
  readonly signedAttributes?: {
    /** `'omit'` leaves the attribute out; a string is the OID written. The TSTInfo content type by default. */
    readonly contentType?: string | 'omit';
    /** `'wrong'` is the digest of other bytes; `'not-octets'` a non-OCTET STRING; `'empty'` a SET with no value. */
    readonly messageDigest?: 'content' | 'wrong' | 'omit' | 'not-octets' | 'empty';
  };
}

/** `[0] IMPLICIT SubjectKeyIdentifier`: the identifier's octets under a context tag. */
function keyIdentifierBlock(octets: Uint8Array, constructed: boolean): Primitive | Constructed {
  if (!constructed)
    return new Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: buffer(octets) });
  const half = octets.length >> 1;
  return new Constructed({
    idBlock: { tagClass: 3, tagNumber: 0 },
    value: [
      new OctetString({ valueHex: buffer(octets.subarray(0, half)) }),
      new OctetString({ valueHex: buffer(octets.subarray(half)) }),
    ],
  });
}

async function signedAttributesFor(
  wanted: NonNullable<TokenOptions['signedAttributes']>,
  content: Uint8Array,
): Promise<SignedAndUnsignedAttributes> {
  const attributes: Attribute[] = [];
  const contentType = wanted.contentType ?? OID_TST_INFO;
  if (contentType !== 'omit') {
    attributes.push(
      new Attribute({ type: '1.2.840.113549.1.9.3', values: [new ObjectIdentifier({ value: contentType })] }),
    );
  }
  const digestType = '1.2.840.113549.1.9.4';
  const mode = wanted.messageDigest ?? 'content';
  if (mode === 'empty') attributes.push(new Attribute({ type: digestType, values: [] }));
  if (mode === 'not-octets')
    attributes.push(new Attribute({ type: digestType, values: [new Integer({ value: 1 })] }));
  if (mode === 'content' || mode === 'wrong') {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      buffer(mode === 'content' ? content : new Uint8Array([1, 2, 3])),
    );
    attributes.push(new Attribute({ type: digestType, values: [new OctetString({ valueHex: digest })] }));
  }
  return new SignedAndUnsignedAttributes({ type: 0, attributes });
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
  if (options.imprintAlgorithmOid !== undefined) {
    tst.messageImprint.hashAlgorithm = new AlgorithmIdentifier({ algorithmId: options.imprintAlgorithmOid });
  }
  const tstBytes = tst.toSchema().toBER(false);
  const signedData = new SignedData({
    version: 3,
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: OID_TST_INFO,
      eContent: new OctetString({ valueHex: tstBytes }),
    }),
    signerInfos: [
      new SignerInfo({
        version: 1,
        sid:
          options.keyIdentifier === undefined
            ? new IssuerAndSerialNumber({
                issuer: certificate.issuer,
                serialNumber: certificate.serialNumber,
              })
            : keyIdentifierBlock(options.keyIdentifier, options.keyIdentifierConstructed === true),
        ...(options.signedAttributes === undefined
          ? {}
          : { signedAttrs: await signedAttributesFor(options.signedAttributes, new Uint8Array(tstBytes)) }),
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

/** `cms` re-encoded after `change` edited its parsed `SignedData` (the signature value stays). */
export function withEditedCms(cms: Uint8Array, change: (signedData: SignedData) => void): Uint8Array {
  const signedData = readSignedData(cms);
  if (signedData === null) throw new Error('fixture CMS does not parse');
  change(signedData);
  return wrapSignedData(signedData);
}

const HASH_OIDS = {
  'SHA-1': '1.3.14.3.2.26',
  'SHA-256': OID_SHA256,
  'SHA-384': '2.16.840.1.101.3.4.2.2',
  'SHA-512': '2.16.840.1.101.3.4.2.3',
} as const;

export type OcspHash = keyof typeof HASH_OIDS;

export interface OcspSingle {
  /** The certificate whose status the entry reports. */
  readonly cert: CertificateFixture;
  readonly status: 'good' | 'revoked' | 'unknown';
  readonly thisUpdate: Date;
  readonly nextUpdate?: Date;
  /** `revoked` only. */
  readonly revokedAt?: Date;
  /** `revoked` only: the `CRLReason` code. */
  readonly reason?: number;
  /** The hash behind the CertID; SHA-256 by default. */
  readonly hash?: OcspHash;
  /** Written as the CertID's hash OID instead of the real one (the digests stay what `hash` made). */
  readonly hashOid?: string;
  /** The CA the CertID names (name and key hash); the response's `issuer` by default. */
  readonly idIssuer?: CertificateFixture;
  /** The CertID's issuer-name hash is that of this certificate's subject instead of the issuer's. */
  readonly idNameOf?: CertificateFixture;
  /** The CertID carries this certificate's serial number instead of `cert`'s. */
  readonly idSerialOf?: CertificateFixture;
}

export interface OcspOptions {
  /** The CA whose certificates the response speaks about. */
  readonly issuer: CertificateFixture;
  /** Signs the response (and is named as its responder); the issuer itself by default. */
  readonly responder?: CertificateFixture;
  /** Signs with this key instead of the responder's own: a response whose signature does not verify. */
  readonly signWith?: CryptoKey;
  readonly producedAt: Date;
  readonly singles: readonly OcspSingle[];
  /** Certificates travelling inside the response (a delegated responder's, usually). */
  readonly certs?: readonly CertificateFixture[];
  /** `responseStatus`; 0 (successful) by default. Anything else carries no response bytes. */
  readonly responseStatus?: number;
  /** `responseType` of the bytes; `id-pkix-ocsp-basic` by default. */
  readonly responseType?: string;
}

async function certId(single: OcspSingle, issuer: CertificateFixture): Promise<CertID> {
  const algorithm = single.hash ?? 'SHA-256';
  const idIssuer = single.idIssuer ?? issuer;
  const nameHash = await crypto.subtle.digest(
    algorithm,
    buffer(
      new Uint8Array((single.idNameOf?.parsed.subject ?? single.cert.parsed.issuer).toSchema().toBER(false)),
    ),
  );
  const keyHash = await crypto.subtle.digest(
    algorithm,
    buffer(new Uint8Array(idIssuer.parsed.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)),
  );
  return new CertID({
    hashAlgorithm: new AlgorithmIdentifier({ algorithmId: single.hashOid ?? HASH_OIDS[algorithm] }),
    issuerNameHash: new OctetString({ valueHex: nameHash }),
    issuerKeyHash: new OctetString({ valueHex: keyHash }),
    serialNumber: (single.idSerialOf ?? single.cert).parsed.serialNumber,
  });
}

function certStatus(single: OcspSingle): Primitive | Constructed {
  if (single.status === 'good') return new Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } });
  if (single.status === 'unknown') return new Primitive({ idBlock: { tagClass: 3, tagNumber: 2 } });
  const members: (GeneralizedTime | Constructed)[] = [
    new GeneralizedTime({ valueDate: single.revokedAt ?? single.thisUpdate }),
  ];
  if (single.reason !== undefined) {
    members.push(
      new Constructed({
        idBlock: { tagClass: 3, tagNumber: 0 },
        value: [new Enumerated({ value: single.reason })],
      }),
    );
  }
  return new Constructed({ idBlock: { tagClass: 3, tagNumber: 1 }, value: members });
}

/** A DER `OCSPResponse` carrying a `BasicOCSPResponse` signed with pkijs. */
export async function issueOcspResponse(options: OcspOptions): Promise<Uint8Array> {
  const responder = options.responder ?? options.issuer;
  const responses: SingleResponse[] = [];
  for (const single of options.singles) {
    responses.push(
      new SingleResponse({
        certID: await certId(single, options.issuer),
        certStatus: certStatus(single),
        thisUpdate: single.thisUpdate,
        ...(single.nextUpdate === undefined ? {} : { nextUpdate: single.nextUpdate }),
      }),
    );
  }
  const basic = new BasicOCSPResponse({
    tbsResponseData: new ResponseData({
      responderID: responder.parsed.subject,
      producedAt: options.producedAt,
      responses,
    }),
    ...(options.certs === undefined ? {} : { certs: options.certs.map((entry) => entry.parsed) }),
  });
  await basic.sign(options.signWith ?? responder.keyPair.privateKey, 'SHA-256');
  const status = options.responseStatus ?? 0;
  const response = new OCSPResponse({
    responseStatus: new Enumerated({ value: status }),
    ...(status === 0
      ? {
          responseBytes: new ResponseBytes({
            responseType: options.responseType ?? OID_BASIC_OCSP_RESPONSE,
            response: new OctetString({ valueHex: basic.toSchema().toBER(false) }),
          }),
        }
      : {}),
  });
  return new Uint8Array(response.toSchema().toBER(false));
}

/** An extension carrying exactly these inner bytes, however wrong they are for its OID. */
export function rawExtension(oid: string, critical: boolean, inner: ArrayBuffer): Extension {
  return ext(oid, critical, inner);
}
