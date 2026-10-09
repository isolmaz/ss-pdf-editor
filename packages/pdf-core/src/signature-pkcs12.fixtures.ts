/**
 * A signing identity as the user brings it: a `.p12` container built with `pkijs` around a
 * certificate and an EC key made with WebCrypto (`signature-trust.fixtures.ts`). The key is
 * written in a password-shrouded bag, the certificate in a plain one — the layout
 * `importPkcs12` reads first.
 */

import { Utf8String } from 'asn1js';
import {
  AttributeTypeAndValue,
  AuthenticatedSafe,
  CertBag,
  Certificate,
  type ContentEncryptionAlgorithm,
  PFX,
  PKCS8ShroudedKeyBag,
  PrivateKeyInfo,
  RelativeDistinguishedNames,
  SafeBag,
  SafeContents,
  setEngine,
} from 'pkijs';
import { generateKey, issueCertificate } from './signature-trust.fixtures';

setEngine('webcrypto', globalThis.crypto, globalThis.crypto.subtle);

const AES_256 = { name: 'AES-CBC', length: 256 } as ContentEncryptionAlgorithm;
const BAG_KEY = '1.2.840.113549.1.12.10.1.2';
const BAG_CERT = '1.2.840.113549.1.12.10.1.3';

/** A subject of `O=Örgüt` alone. */
function organisationOnly(): RelativeDistinguishedNames {
  return new RelativeDistinguishedNames({
    typesAndValues: [
      new AttributeTypeAndValue({ type: '2.5.4.10', value: new Utf8String({ value: 'Örgüt' }) }),
    ],
  });
}

export interface Pkcs12Fixture {
  /** The container's bytes. */
  readonly bytes: Uint8Array;
  /** The certificate inside it, DER. */
  readonly certificate: Uint8Array;
}

/**
 * A `.p12` valid for the whole of 2026 (so it expires `2027-01-01T00:00:00.000Z`).
 * `subject: null` writes a certificate whose subject is an organisation only: no common name.
 */
export async function pkcs12Fixture(
  options: { readonly subject?: string | null; readonly password?: string } = {},
): Promise<Pkcs12Fixture> {
  const subject = options.subject === undefined ? 'İmza Deneme' : options.subject;
  const password = new TextEncoder().encode(options.password ?? 'gizli').slice().buffer;
  const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
  const certificate = await issueCertificate({
    subject: subject ?? '',
    ...(subject === null ? { subjectName: organisationOnly() } : {}),
    keyPair,
    notBefore: new Date(Date.UTC(2026, 0, 1)),
    notAfter: new Date(Date.UTC(2027, 0, 1)),
    keyUsage: ['digitalSignature'],
  });

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const keyBag = new PKCS8ShroudedKeyBag({ parsedValue: PrivateKeyInfo.fromBER(pkcs8.slice()) });
  await keyBag.makeInternalValues({
    password,
    contentEncryptionAlgorithm: AES_256,
    hmacHashAlgorithm: 'SHA-256',
    iterationCount: 2048,
  });
  const certificateBag = new SafeBag({
    bagId: BAG_CERT,
    bagValue: new CertBag({ parsedValue: Certificate.fromBER(certificate.der.slice()) }),
  });
  const keySafe = new SafeBag({ bagId: BAG_KEY, bagValue: keyBag });

  const pfx = new PFX({
    parsedValue: {
      integrityMode: 0,
      authenticatedSafe: new AuthenticatedSafe({
        parsedValue: {
          safeContents: [
            { privacyMode: 0, value: new SafeContents({ safeBags: [certificateBag] }) },
            { privacyMode: 0, value: new SafeContents({ safeBags: [keySafe] }) },
          ],
        },
      }),
    },
  });
  await pfx.parsedValue?.authenticatedSafe?.makeInternalValues({ safeContents: [{}, {}] });
  await pfx.makeInternalValues({
    password,
    iterations: 2048,
    pbkdf2HashAlgorithm: 'SHA-256',
    hmacHashAlgorithm: 'SHA-256',
  });
  return { bytes: new Uint8Array(pfx.toSchema().toBER(false)), certificate: certificate.der };
}
