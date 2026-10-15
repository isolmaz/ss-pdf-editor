/**
 * PKCS#12 (`.p12`/`.pfx`) import — how a signing identity enters this build.
 *
 * A certificate alone is not a signing identity: the user's file is a container holding the
 * certificate, its chain and the **private key**, protected by a password. The key never
 * leaves this function's caller — it is imported into WebCrypto as a non-extractable
 * handle that can only sign.
 *
 * What is wiped, and what is not: the working copies this function makes of the secrets —
 * the password's UTF-8 bytes (and the `ArrayBuffer` handed to `pkijs`) and the plain PKCS#8
 * of the key — are overwritten with zeros when the import ends, on success and on failure.
 * The `password` argument is a JavaScript string, which cannot be wiped, and the container's
 * own bytes belong to the caller (they are encrypted, and are only read here).
 *
 * The signing certificate is the one whose public key the private key signs for, not the
 * first certificate in the container: a bundle exported with its CA first is common.
 *
 * Everything happens locally: `pkijs` parses the ASN.1 and WebCrypto does the arithmetic,
 * with no network, no keychain and no OS integration. That is the whole reason this build
 * can sign at all (the document never leaves the device).
 */

import type { OctetString } from 'asn1js';
import { fromBER, ObjectIdentifier } from 'asn1js';
import type {
  // Aliased: the DOM's own `AlgorithmIdentifier` is the WebCrypto one.
  AlgorithmIdentifier as Asn1AlgorithmIdentifier,
  AttributeTypeAndValue,
  AuthenticatedSafe,
  CertBag,
  PrivateKeyInfo,
  SafeBag,
} from 'pkijs';
import { Certificate, ContentInfo, EncryptedData, PFX, SafeContents, setEngine } from 'pkijs';
import type { SignatureDigest } from './signature-cms';

export interface ImportedIdentity {
  /** The signer's certificate, DER. */
  readonly certificate: Uint8Array;
  /** Any other certificates the container carried, DER — the chain, in container order. */
  readonly chain: readonly Uint8Array[];
  /** A WebCrypto handle for the private key; signing is the only thing it can do. */
  readonly privateKey: CryptoKey;
  /** The subject's common name when the certificate has one, for `/Name` and the UI. */
  readonly commonName: string | null;
}

/**
 * The common name out of a certificate subject, decoded as text.
 *
 * The value inside an RDN is an ASN.1 string whose *type* varies (PrintableString,
 * UTF8String, IA5String…); `pkijs` hands it over as an `asn1js` object, so the text is read
 * from whichever of those it is rather than assumed.
 */
function commonNameOf(certificate: Certificate): string | null {
  for (const rdn of certificate.subject.typesAndValues) {
    const oid = rdn.type;
    if (oid !== '2.5.4.3') continue;
    // asn1js decodes every string type (Printable, UTF8, IA5, BMP, Universal, Teletex) to text.
    const value = rdn.value as { valueBlock?: { value?: unknown } };
    const direct = value?.valueBlock?.value;
    if (typeof direct === 'string' && direct.length > 0) return direct;
  }
  return null;
}

/**
 * The `SafeBag`s inside one `ContentInfo` of the container's `AuthenticatedSafe`.
 *
 * A container mixes two shapes and both occur in the wild (OpenSSL 3 writes one of each for
 * a certificate + key export): a `data` bag holds its `SafeContents` as an OCTET STRING,
 * while an `encryptedData` bag holds an `EncryptedData` that has to be decrypted with the
 * same password first. Both end in the same `SEQUENCE OF SafeBag`.
 */
async function bagsOf(content: ContentInfo, password: ArrayBuffer): Promise<SafeBag[]> {
  let der: Uint8Array;
  if (content.contentType === ContentInfo.ENCRYPTED_DATA) {
    der = new Uint8Array(await new EncryptedData({ schema: content.content }).decrypt({ password }));
  } else if (content.contentType === ContentInfo.DATA) {
    der = new Uint8Array((content.content as OctetString).valueBlock.valueHexView);
  } else {
    return [];
  }
  const parsed = fromBER(der);
  if (parsed.offset === -1) return [];
  return new SafeContents({ schema: parsed.result }).safeBags;
}

/** Bag ids, as RFC 7292 §4.2.3 names them. */
const BAG_PKCS8_SHROUDED_KEY = '1.2.840.113549.1.12.10.1.2';
const BAG_CERT = '1.2.840.113549.1.12.10.1.3';

/** The DER of a certificate bag: pkijs refuses to parse a `CertBag` whose value is not primitive bytes. */
function bagDer(bag: SafeBag): Uint8Array {
  // pkijs types the value loosely; an x509 `CertBag` holds its certificate as an OCTET STRING.
  const certValue = (bag.bagValue as CertBag).certValue as OctetString;
  return new Uint8Array(certValue.valueBlock.valueHexView);
}

const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
/** The named curves WebCrypto can sign with, by OID. */
const CURVES: Readonly<Record<string, string>> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

/**
 * The key family an algorithm identifier names, spelled as WebCrypto does: `RSA`, or the
 * curve (`P-256`…). `null` for a key or curve this build cannot sign with.
 */
function familyOf(algorithm: Asn1AlgorithmIdentifier): string | null {
  if (algorithm.algorithmId === OID_RSA_ENCRYPTION) return 'RSA';
  const parameters = algorithm.algorithmParams;
  if (algorithm.algorithmId !== OID_EC_PUBLIC_KEY || !(parameters instanceof ObjectIdentifier)) return null;
  return CURVES[parameters.valueBlock.toString()] ?? null;
}

/** Bytes the key signs once to find its certificate; what they say is of no consequence. */
const KEY_CHECK = new TextEncoder().encode('ss-pdf-editor: which certificate is this key for');

/**
 * The index of the certificate the private key belongs to, or `-1` when it belongs to none.
 *
 * The key signs one fixed message and every certificate of the key's own family is asked
 * whether its public key verifies that signature — the same proof the signature on the
 * produced PDF gives. It works for any key WebCrypto can import and exports no private
 * material (a PKCS#8 may leave out its public half, so that cannot always be read off).
 */
async function certificateOfKey(
  privateKey: CryptoKey,
  family: string,
  importAlgorithm: RsaHashedImportParams | EcKeyImportParams,
  certificates: readonly Uint8Array[],
): Promise<number> {
  const algorithm: AlgorithmIdentifier | EcdsaParams =
    family === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
  const signature = await crypto.subtle.sign(algorithm, privateKey, KEY_CHECK);
  for (const [index, der] of certificates.entries()) {
    const info = Certificate.fromBER(der.slice()).subjectPublicKeyInfo;
    if (familyOf(info.algorithm) !== family) continue;
    const spki = info.toSchema().toBER(false);
    const publicKey = await crypto.subtle.importKey('spki', spki, importAlgorithm, false, ['verify']);
    if (await crypto.subtle.verify(algorithm, publicKey, signature, KEY_CHECK)) return index;
  }
  return -1;
}

/**
 * Parse a PKCS#12 container and import its key into WebCrypto.
 *
 * The password is required by the format; a container exported “without” one carries the
 * empty string, which is what the caller passes.
 */
export async function importPkcs12(
  bytes: Uint8Array,
  password: string,
  digest: SignatureDigest = 'SHA-256',
): Promise<ImportedIdentity> {
  /**
   * pkijs 3.4 keeps its WebCrypto engine in a module-global registry, and the two calls
   * below (an `EncryptedData` decrypt and the key bag's own helper) use whichever engine is
   * registered. Registering is idempotent and touches nothing else; omitting it makes every
   * cryptographic call in pkijs throw “no crypto engine”.
   */
  setEngine('webcrypto', globalThis.crypto, globalThis.crypto.subtle);

  const parsed = fromBER(bytes.slice());
  if (parsed.offset === -1) {
    throw new Error('the file is not a PKCS#12 container: its ASN.1 does not parse');
  }
  const pfx = new PFX({ schema: parsed.result });
  const passwordBytes = new TextEncoder().encode(password);
  const passwordBuffer = passwordBytes.buffer.slice(
    passwordBytes.byteOffset,
    passwordBytes.byteOffset + passwordBytes.byteLength,
  ) as ArrayBuffer;
  // The key's plain PKCS#8, once it has been written out for WebCrypto to import.
  let plainKey: ArrayBuffer | null = null;

  try {
    // The MAC is what proves the password: a container whose MAC does not verify is either the
    // wrong password or a damaged file, and neither may be signed with.
    await pfx.parseInternalValues({ password: passwordBuffer, checkIntegrity: true });

    const certificates: Uint8Array[] = [];
    let rawKey: PrivateKeyInfo | null = null;

    // `parseInternalValues` above resolved, so pkijs has set both (it throws otherwise).
    const authenticated = pfx.parsedValue as { authenticatedSafe: AuthenticatedSafe };
    for (const content of authenticated.authenticatedSafe.safeContents) {
      for (const bag of await bagsOf(content, passwordBuffer)) {
        if (bag.bagId === BAG_CERT) {
          certificates.push(bagDer(bag));
          continue;
        }
        if (bag.bagId !== BAG_PKCS8_SHROUDED_KEY) continue;
        /**
         * pkijs keeps the PBES2 decrypt helper `protected` — reachable at runtime, invisible to
         * TypeScript. Calling it through a structural type reuses the library's own, tested
         * PBES2 (KDF + cipher handling) instead of a second implementation living here; the
         * signature on the produced PDF is what proves the decryption was right.
         */
        const shrouded = bag.bagValue as unknown as {
          parseInternalValues(parameters: { password: ArrayBuffer }): Promise<void>;
          /** Set by `parseInternalValues` when it resolves. */
          parsedValue: PrivateKeyInfo;
        };
        await shrouded.parseInternalValues({ password: passwordBuffer });
        rawKey = shrouded.parsedValue;
      }
    }

    if (certificates.length === 0) throw new Error('the container carries no certificate');
    if (rawKey === null) throw new Error('the container carries no private key');

    // Key family and curve come from the key itself; the certificate that goes with it is
    // found afterwards. WebCrypto binds RSA's digest at import, so it must match the digest
    // selected for the CMS.
    const family = familyOf(rawKey.privateKeyAlgorithm);
    if (family === null) throw new Error('unsupported signing key algorithm or named curve');
    // WebCrypto's own algorithm object; the key above decided which one.
    const importAlgorithm: RsaHashedImportParams | EcKeyImportParams =
      family === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5', hash: digest } : { name: 'ECDSA', namedCurve: family };
    plainKey = rawKey.toSchema().toBER(false);
    const privateKey = await crypto.subtle.importKey('pkcs8', plainKey, importAlgorithm, false, ['sign']);

    const signerAt = await certificateOfKey(privateKey, family, importAlgorithm, certificates);
    const certificateDer = certificates[signerAt];
    if (certificateDer === undefined) {
      throw new Error('the container carries no certificate for its private key');
    }
    return {
      certificate: certificateDer,
      chain: certificates.filter((_, index) => index !== signerAt),
      privateKey,
      commonName: commonNameOf(Certificate.fromBER(certificateDer.slice())),
    };
  } finally {
    passwordBytes.fill(0);
    new Uint8Array(passwordBuffer).fill(0);
    if (plainKey !== null) new Uint8Array(plainKey).fill(0);
  }
}

/** The issuer and serial of a certificate, for a UI that has to name an identity. */
export function describeCertificate(der: Uint8Array): {
  readonly commonName: string | null;
  readonly issuer: string | null;
  /** The last moment of validity, ISO 8601: every certificate has one. */
  readonly notAfter: string;
} {
  const certificate = Certificate.fromBER(der.slice());
  const nameOf = (rdns: readonly AttributeTypeAndValue[]): string | null => {
    for (const rdn of rdns) {
      if (rdn.type !== '2.5.4.3') continue;
      const value = rdn.value as { valueBlock?: { value?: unknown } };
      if (typeof value?.valueBlock?.value === 'string') return value.valueBlock.value;
    }
    return null;
  };
  return {
    commonName: nameOf([...certificate.subject.typesAndValues]),
    issuer: nameOf([...certificate.issuer.typesAndValues]),
    notAfter: certificate.notAfter.value.toISOString(),
  };
}
