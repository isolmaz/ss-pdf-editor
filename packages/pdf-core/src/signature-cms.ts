/**
 * The CMS `SignedData` a PAdES B-B signature carries.
 *
 * Why this file exists separately from `ops/sign.ts`: the PDF side decides *what* is
 * signed (a byte range, a field, an appearance); this side turns "these bytes, this
 * certificate, this key" into a detached CMS structure and nothing else knows about
 * ASN.1. The split also keeps the one thing that is easy to get subtly wrong — the
 * exact bytes the signature is computed over — in a function with no PDF in sight.
 *
 * **What B-B means here, precisely.** The signature is a detached `SignedData` over the
 * file's byte range, with the two signed attributes PAdES requires besides the mandatory
 * pair: `contentType` and `messageDigest` (CMS, RFC 5652 §11.1), and `signingCertificateV2`
 * (RFC 5035) binding the signer's certificate into the signature. There is **no**
 * timestamp: `B-T` needs an RFC 3161 TSA, the public ones are not CORS-enabled and
 * `connect-src 'self'` forbids reaching them anyway — that belongs to the helper,
 * never to this build. The signature is produced entirely locally with WebCrypto.
 *
 * **The signature algorithm comes from the key, never from the caller.** A `CryptoKey`
 * knows what it is; pairing an RSASSA key with an ECDSA algorithm name — or claiming
 * SHA-256 over a SHA-512 digest — is how a file ends up with a signature that no reader
 * can verify. So the key is asked, and a key this module does not support is refused by
 * name.
 */

import { Constructed, Null, ObjectIdentifier, OctetString, Sequence, UTCTime } from 'asn1js';
import {
  // Aliased: the DOM's own `AlgorithmIdentifier` is the WebCrypto one this module also
  // needs, and an unaliased import would shadow it.
  AlgorithmIdentifier as Asn1AlgorithmIdentifier,
  Attribute,
  Certificate,
  EncapsulatedContentInfo,
  IssuerAndSerialNumber,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
} from 'pkijs';

/**
 * Byte order, the way a `SET OF` must be sorted: shorter prefix first, then by value. Bytes
 * are compared as the code units of their latin-1 spelling, which orders exactly so.
 */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const first = String.fromCharCode(...left);
  const second = String.fromCharCode(...right);
  return Number(first > second) - Number(first < second);
}

/** One DER `TLV` with a minimal definite length (X.690 §8.1.3). */
function derTlv(tag: number, content: Uint8Array): Uint8Array {
  const lengthBytes: number[] = [];
  for (let rest = content.length; rest > 0; rest = Math.floor(rest / 256)) lengthBytes.unshift(rest % 256);
  const header =
    content.length < 0x80 ? [tag, content.length] : [tag, 0x80 | lengthBytes.length, ...lengthBytes];
  const out = new Uint8Array(header.length + content.length);
  out.set(header);
  out.set(content, header.length);
  return out;
}

/** An unsigned big-endian magnitude as a DER `INTEGER`: no redundant leading zero, one sign pad if needed. */
function derInteger(magnitude: Uint8Array): Uint8Array {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1;
  const significant = magnitude.subarray(start);
  const padded = new Uint8Array(significant.length + 1);
  padded.set(significant, 1);
  return derTlv(0x02, significant.subarray(0, 1).some((first) => first >= 0x80) ? padded : significant);
}

/**
 * The CMS form of a WebCrypto ECDSA signature: IEEE P1363 `r ‖ s`, each half as wide as the
 * curve's field, becomes `ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }` (RFC 3279
 * §2.2.3) in *minimal* DER.
 *
 * Why this is not pkijs's `createCMSECDSASignature`: that helper drops at most **one** leading
 * zero octet of each half, so a scalar with two or more (about 1 signature in 500 on P-521,
 * 1 in 65 536 on P-256) comes out as an `INTEGER` with a redundant `0x00` — not DER, and
 * refused by every strict reader, this repository's own verifier included. The signature was
 * right and the file still read as invalid, at random.
 */
export function ecdsaSignatureToDer(raw: Uint8Array): Uint8Array {
  if (raw.length === 0 || raw.length % 2 !== 0) {
    throw new Error(`an ECDSA signature is r and s of equal width; got ${raw.length} bytes`);
  }
  const half = raw.length / 2;
  const integers = [derInteger(raw.subarray(0, half)), derInteger(raw.subarray(half))];
  return derTlv(0x30, Uint8Array.from(integers.flatMap((integer) => [...integer])));
}

/** The digest algorithms a PAdES B-B signature may use, widest first. */
export type SignatureDigest = 'SHA-256' | 'SHA-384' | 'SHA-512';

/** OID per digest, as RFC 8017 / NIST name them. */
const DIGEST_OIDS: Readonly<Record<SignatureDigest, string>> = {
  'SHA-256': '2.16.840.1.101.3.4.2.1',
  'SHA-384': '2.16.840.1.101.3.4.2.2',
  'SHA-512': '2.16.840.1.101.3.4.2.3',
};

const OID_DATA = '1.2.840.113549.1.7.1';
/** `signedData` — the content type a PDF signature's `/Contents` is wrapped in. */
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
/** `signingCertificateV2` — RFC 5035, the attribute PAdES requires. */
const OID_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const OID_ECDSA_WITH_SHA384 = '1.2.840.10045.4.3.3';
const OID_ECDSA_WITH_SHA512 = '1.2.840.10045.4.3.4';

export interface SignatureIdentity {
  /** The signer's certificate, DER. */
  readonly certificate: Uint8Array;
  /** Certificates above the signer, DER, in any order; they only travel along. */
  readonly chain?: readonly Uint8Array[];
  /** A WebCrypto key the browser or Node can sign with. */
  readonly privateKey: CryptoKey;
}

export interface CmsSignature {
  /** The detached `SignedData`, DER — exactly what goes into `/Contents`. */
  readonly der: Uint8Array;
  readonly digest: SignatureDigest;
}

/**
 * What the key can do, as the algorithm identifiers CMS wants.
 *
 * `subtle.sign` needs the WebCrypto algorithm object; the CMS needs the OIDs. Both come
 * from the key's own `algorithm`, so a caller cannot describe a key it does not hold.
 */
async function algorithmFor(
  privateKey: CryptoKey,
  digest: SignatureDigest,
): Promise<{
  readonly webcrypto: AlgorithmIdentifier | EcdsaParams;
  readonly keyOid: string;
  readonly signatureOid: string;
  /** `null` writes the explicit ASN.1 `NULL` these algorithms are specified with. */
  readonly signatureParams?: 'null';
  readonly digestOid: string;
}> {
  const name = privateKey.algorithm.name;
  const digestOid = DIGEST_OIDS[digest];
  if (name === 'RSASSA-PKCS1-v1_5') {
    // WebCrypto signs with the hash the key was created for. A CMS that states another digest
    // would carry a signature no reader can verify, so the mismatch is refused here.
    const keyHash = (privateKey.algorithm as RsaHashedKeyAlgorithm).hash.name;
    if (keyHash !== digest) {
      throw new Error(`the RSA key signs with ${keyHash}, so the CMS digest cannot be ${digest}`);
    }
    return {
      webcrypto: { name: 'RSASSA-PKCS1-v1_5' },
      keyOid: OID_RSA_ENCRYPTION,
      /**
       * RSA signature algorithm per RFC 5652 §5.3 / RFC 8017: `rsaEncryption` **with `NULL`
       * parameters**. Measured with `openssl cms -verify`: leaving the parameters out makes
       * OpenSSL verify the key's raw RSA output instead of unwrapping the DigestInfo, and the
       * answer is “bad signature” — for a signature WebCrypto calls correct.
       */
      signatureOid: OID_RSA_ENCRYPTION,
      signatureParams: 'null' as const,
      digestOid,
    };
  }
  if (name === 'ECDSA') {
    const signatureOid =
      digest === 'SHA-256'
        ? OID_ECDSA_WITH_SHA256
        : digest === 'SHA-384'
          ? OID_ECDSA_WITH_SHA384
          : OID_ECDSA_WITH_SHA512;
    return {
      webcrypto: { name: 'ECDSA', hash: digest },
      keyOid: '1.2.840.10045.2.1',
      signatureOid,
      digestOid,
    };
  }
  throw new Error(
    `signing needs an RSASSA-PKCS1-v1_5 or ECDSA key; this key is "${name}", which this build cannot sign with`,
  );
}

/** The signed attributes CMS requires, the PAdES one, and the signing time. */
function signedAttributes(
  digestOid: string,
  messageDigest: Uint8Array,
  certHash: Uint8Array,
  signedAt: Date,
): Attribute[] {
  return [
    new Attribute({
      type: OID_CONTENT_TYPE,
      values: [new ObjectIdentifier({ value: OID_DATA })],
    }),
    new Attribute({
      /**
       * `signingTime` (RFC 5652 §11.3) — the moment the signature was made, alongside the
       * `/M` the PDF dictionary carries. It is the attribute a verifier shows when the
       * document's own date is missing, and PAdES expects it present.
       */
      type: OID_SIGNING_TIME,
      values: [new UTCTime({ valueDate: signedAt })],
    }),
    new Attribute({
      type: OID_MESSAGE_DIGEST,
      values: [new OctetString({ valueHex: messageDigest })],
    }),
    new Attribute({
      type: OID_SIGNING_CERTIFICATE_V2,
      // SigningCertificateV2 → certs SEQUENCE OF → ESSCertIDv2.
      // DER omits hashAlgorithm when it has the DEFAULT sha256 value.
      values: [
        new Sequence({
          value: [
            new Sequence({
              value: [
                new Sequence({
                  value: [
                    ...(digestOid === DIGEST_OIDS['SHA-256']
                      ? []
                      : [new Sequence({ value: [new ObjectIdentifier({ value: digestOid })] })]),
                    new OctetString({ valueHex: certHash }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ];
}

/**
 * Sign `content` (the file's byte range) with `identity` and answer the detached CMS.
 *
 * `content` is hashed once and that hash is what `messageDigest` states; the signature
 * itself is computed over the DER of the signed attributes, which is the rule CMS states
 * and the one every verifier checks.
 */
export async function detachedCmsSignature(
  content: Uint8Array,
  identity: SignatureIdentity,
  options: { readonly digest?: SignatureDigest; readonly signedAt?: Date } = {},
): Promise<CmsSignature> {
  const digest = options.digest ?? 'SHA-256';
  const signedAt = options.signedAt ?? new Date();
  const algorithm = await algorithmFor(identity.privateKey, digest);
  const certificate = Certificate.fromBER(identity.certificate.slice());
  if (certificate.subject.typesAndValues.length === 0) {
    throw new Error('the signing certificate has an empty subject');
  }

  const digestBytes = new Uint8Array(
    await crypto.subtle.digest(digest, content.slice() as unknown as ArrayBuffer),
  );
  const certHash = new Uint8Array(
    await crypto.subtle.digest(digest, identity.certificate.slice() as unknown as ArrayBuffer),
  );

  /**
   * DER requires a `SET OF` to be in **encoded order** (X.690 §11.6), and the signed
   * attributes are a `SET OF Attribute`. Measured with `openssl cms -verify`: a set written
   * in the order the attributes happened to be added is re-encoded by the verifier, the
   * bytes it hashes differ from the bytes that were signed, and the answer is “bad
   * signature” — while a digest-only check (this product's own verifier, before this change)
   * still said “valid”. Sorting here is what makes the file correct by the standard.
   */
  const attributes = new SignedAndUnsignedAttributes({
    // `type: 0` is the implicit `[0]` tag of `signedAttrs`; `1` would be `unsignedAttrs`.
    type: 0,
    attributes: signedAttributes(algorithm.digestOid, digestBytes, certHash, signedAt).sort((left, right) =>
      // Not `Buffer.compare`: this module runs in the **browser**, where `Buffer` does not
      // exist. The comparison is the same one, written where it is used.
      compareBytes(
        new Uint8Array(left.toSchema().toBER(false)),
        new Uint8Array(right.toSchema().toBER(false)),
      ),
    ),
  });
  const signerInfo = new SignerInfo({
    version: 1,
    /**
     * An `IssuerAndSerialNumber` instance, not the shape it looks like: pkijs puts `sid`
     * straight into its schema, and a plain object has no `toBER` — which surfaces as
     * “this.value[i].toBER is not a function” from inside asn1js, far from the cause.
     */
    sid: new IssuerAndSerialNumber({ issuer: certificate.issuer, serialNumber: certificate.serialNumber }),
    digestAlgorithm: new Asn1AlgorithmIdentifier({ algorithmId: algorithm.digestOid }),
    signatureAlgorithm: new Asn1AlgorithmIdentifier({
      algorithmId: algorithm.signatureOid,
      ...(algorithm.signatureParams === 'null' ? { algorithmParams: new Null() } : {}),
    }),
    signedAttrs: attributes,
  });

  const signedData = new SignedData({
    version: 1,
    /**
     * `digestAlgorithms ::= SET OF AlgorithmIdentifier` — the **one** entry every consumer
     * reads first, and the field a CMS without it is malformed in. Measured with
     * `openssl asn1parse`: without this line the produced structure carried an empty SET
     * where the digest belongs.
     */
    digestAlgorithms: [new Asn1AlgorithmIdentifier({ algorithmId: algorithm.digestOid })],
    encapContentInfo: new EncapsulatedContentInfo({ eContentType: OID_DATA }),
    certificates: [certificate, ...(identity.chain ?? []).map((der) => Certificate.fromBER(der.slice()))],
    signerInfos: [signerInfo],
  });

  /**
   * The bytes the signature covers: the DER of the signed attributes **as a `SET OF`**.
   * RFC 5652 §5.4 signs the `SignedAttributes` value with the universal `SET OF` tag — the
   * structure *carries* them under an implicit `[0]` tag, but that tag is not what is
   * signed. Measured with OpenSSL: `openssl dgst -verify` over the `SET`-tagged form says
   * “Verified OK”, over the `[0]`-tagged form “Verification failure” — and `cms -verify`
   * re-encodes the attributes, so a signature over the `[0]` form reads as “bad signature"
   * from every external verifier while a digest-only check stays happy.
   */
  const signedBytes = new Uint8Array(attributes.toSchema().toBER(false));
  signedBytes[0] = 0x31;
  const signature = await crypto.subtle.sign(
    // The WebCrypto algorithm object, not the ASN.1 one: RSA needs no hash here (the
    // DigestInfo carries it) while ECDSA does, and `algorithmFor` decided which.
    algorithm.webcrypto as AlgorithmIdentifier,
    identity.privateKey,
    signedBytes as unknown as ArrayBuffer,
  );
  // WebCrypto returns fixed-width r || s; CMS carries DER ECDSA-Sig-Value.
  signerInfo.signature = new OctetString({
    valueHex:
      identity.privateKey.algorithm.name === 'ECDSA'
        ? (ecdsaSignatureToDer(new Uint8Array(signature)).buffer as ArrayBuffer)
        : signature,
  });

  /**
   * A PDF's `/Contents` carries a **full `ContentInfo`**, not a bare `SignedData`:
   * `ContentInfo ::= SEQUENCE { contentType OID, content [0] EXPLICIT ANY }`, with the OID
   * naming `signedData` (RFC 5652 §5.2). pkijs's `SignedData.toSchema()` emits only the inner
   * structure, and measured: without this wrapper the file's own verifier answered
   * “unchecked: der”, because the first OID it reads was `pkcs7-data` where
   * `pkcs7-signedData` has to be.
   */
  const wrapped = new Sequence({
    value: [
      new ObjectIdentifier({ value: OID_SIGNED_DATA }),
      // `[0] EXPLICIT` — asn1js's tag class 3 is context-specific, and the explicit wrapper
      // is what carries the `SignedData` as an `ANY`.
      new Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [signedData.toSchema()] }),
    ],
  });
  return { der: new Uint8Array(wrapped.toBER(false)), digest };
}
