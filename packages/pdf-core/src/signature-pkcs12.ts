/**
 * PKCS#12 (`.p12`/`.pfx`) import — how a signing identity enters this build.
 *
 * A certificate alone is not a signing identity: the user's file is a container holding the
 * certificate, its chain and the **private key**, protected by a password. The key never
 * leaves this function's caller — it is imported into WebCrypto as a non-extractable
 * handle where the browser can help it, and the container's bytes are dropped immediately
 * after parsing.
 *
 * Everything happens locally: `pkijs` parses the ASN.1 and WebCrypto does the arithmetic,
 * with no network, no keychain and no OS integration. That is the whole reason this build
 * can sign at all (the document never leaves the device).
 */

import type { OctetString } from 'asn1js';
import { fromBER, ObjectIdentifier } from 'asn1js';
import type { AttributeTypeAndValue, PrivateKeyInfo, SafeBag } from 'pkijs';
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
    const value = rdn.value as {
      valueBlock?: { value?: unknown; isHexOnly?: boolean; valueHexView?: Uint8Array };
    };
    const direct = value?.valueBlock?.value;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    // A BMPString or UniversalString arrives as bytes rather than text.
    const bytes = value?.valueBlock?.valueHexView;
    if (bytes !== undefined && bytes.length > 0) {
      try {
        return new TextDecoder('utf-16be').decode(bytes).replace(/\0/g, '');
      } catch {
        return null;
      }
    }
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

/** The hex of a bag that carries DER. */
function bagDer(bag: SafeBag): Uint8Array {
  const value = bag.bagValue as { certValue?: OctetString; valueBlock?: { valueHexView?: Uint8Array } };
  const hex = value.certValue?.valueBlock.valueHexView ?? value.valueBlock?.valueHexView;
  if (hex === undefined) throw new Error(`a bag (${bag.bagId}) carries no bytes`);
  return new Uint8Array(hex);
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

  // The MAC is what proves the password: a container whose MAC does not verify is either the
  // wrong password or a damaged file, and neither may be signed with.
  await pfx.parseInternalValues({ password: passwordBuffer, checkIntegrity: true });

  let certificateDer: Uint8Array | null = null;
  let rawKey: PrivateKeyInfo | null = null;
  const chain: Uint8Array[] = [];

  for (const content of pfx.parsedValue?.authenticatedSafe?.safeContents ?? []) {
    for (const bag of await bagsOf(content, passwordBuffer)) {
      if (bag.bagId === BAG_CERT) {
        if (certificateDer === null) certificateDer = bagDer(bag);
        else chain.push(bagDer(bag));
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
        parsedValue?: PrivateKeyInfo;
      };
      await shrouded.parseInternalValues({ password: passwordBuffer });
      if (shrouded.parsedValue !== undefined) rawKey = shrouded.parsedValue;
    }
  }

  if (certificateDer === null) throw new Error('the container carries no certificate');
  if (rawKey === null) throw new Error('the container carries no private key');

  const certificate = Certificate.fromBER(certificateDer.slice());
  const algorithmId = certificate.subjectPublicKeyInfo.algorithm.algorithmId;
  const isRsa = algorithmId === '1.2.840.113549.1.1.1';
  // Key family and curve come from the certificate. WebCrypto binds RSA's
  // digest at import, so it must match the digest selected for the CMS.
  const curves: Readonly<Record<string, string>> = {
    '1.2.840.10045.3.1.7': 'P-256',
    '1.3.132.0.34': 'P-384',
    '1.3.132.0.35': 'P-521',
  };
  const curveParameters = certificate.subjectPublicKeyInfo.algorithm.algorithmParams;
  const namedCurve =
    curveParameters instanceof ObjectIdentifier ? curves[curveParameters.valueBlock.toString()] : undefined;
  if (!isRsa && (algorithmId !== '1.2.840.10045.2.1' || namedCurve === undefined)) {
    throw new Error('unsupported signing key algorithm or named curve');
  }
  const importAlgorithm: RsaHashedImportParams | EcKeyImportParams = isRsa
    ? { name: 'RSASSA-PKCS1-v1_5', hash: digest }
    : { name: 'ECDSA', namedCurve: namedCurve as string };

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    rawKey.toSchema().toBER(false),
    // WebCrypto's own algorithm object; the certificate above decided which one.
    importAlgorithm,
    false,
    ['sign'],
  );

  return { certificate: certificateDer, chain, privateKey, commonName: commonNameOf(certificate) };
}

/** The issuer and serial of a certificate, for a UI that has to name an identity. */
export function describeCertificate(der: Uint8Array): {
  readonly commonName: string | null;
  readonly issuer: string | null;
  readonly notAfter: string | null;
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
