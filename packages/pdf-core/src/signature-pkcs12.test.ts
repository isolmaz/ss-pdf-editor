/**
 * `importPkcs12`: a signing identity enters the product as a `.p12` container. The containers
 * here are built with `pkijs` around certificates and keys made with WebCrypto, in the two
 * shapes the format has for a bag (a plain `data` content and a password-encrypted
 * `encryptedData` content, which is what OpenSSL 3 writes for certificates). What is proven is
 * the outcome that matters: the certificate, the chain, the name and a private key that really
 * signs for the certificate's public key, and the refusals for everything that is not a usable
 * identity.
 */

import { BmpString, Integer, ObjectIdentifier, OctetString, Utf8String } from 'asn1js';
import type { ContentEncryptionAlgorithm } from 'pkijs';
import {
  AttributeTypeAndValue,
  AuthenticatedSafe,
  CertBag,
  Certificate,
  ContentInfo,
  PFX,
  PKCS8ShroudedKeyBag,
  PrivateKeyInfo,
  SafeBag,
  SafeContents,
  setEngine,
} from 'pkijs';
import { describe, expect, it, vi } from 'vitest';
import { signPdf } from './ops/sign';
import { verifySignatures } from './ops/signature-status';
import { describeCertificate, importPkcs12 } from './signature-pkcs12';
import { type CurveName, generateKey, issueCertificate, type KeySpec } from './signature-trust.fixtures';

setEngine('webcrypto', globalThis.crypto, globalThis.crypto.subtle);

const PASSWORD = 'gizli-şifre';
/** pkijs derives the IV itself, but its type asks for one that WebCrypto's own type requires. */
const AES_256 = { name: 'AES-CBC', length: 256 } as ContentEncryptionAlgorithm;
const BAG_KEY = '1.2.840.113549.1.12.10.1.2';
const BAG_CERT = '1.2.840.113549.1.12.10.1.3';
/** A key stored unshrouded: a bag that is neither a certificate nor an encrypted key. */
const BAG_PLAIN_KEY = '1.2.840.113549.1.12.10.1.1';
const VALID = { notBefore: new Date(Date.UTC(2026, 0, 1)), notAfter: new Date(Date.UTC(2027, 0, 1)) };

interface Identity {
  readonly der: Uint8Array;
  readonly pkcs8: Uint8Array;
  readonly keyPair: CryptoKeyPair;
}

async function identityFor(spec: KeySpec, subject = 'İmza Deneme'): Promise<Identity> {
  const keyPair = await generateKey(spec);
  const certificate = await issueCertificate({
    subject,
    keyPair,
    ...VALID,
    keyUsage: ['digitalSignature'],
  });
  return {
    der: certificate.der,
    pkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
    keyPair,
  };
}

interface Layout {
  /** `0` = a `data` content, `1` = a password-encrypted `encryptedData` content. */
  readonly certificatePrivacy: 0 | 1;
  readonly keyPrivacy: 0 | 1;
}

/** A PKCS#12 container with one content per group of bags. */
async function container(
  identity: Identity,
  options: {
    readonly chain?: readonly Uint8Array[];
    readonly extraBags?: readonly SafeBag[];
    readonly layout?: Layout;
    readonly password?: string;
    readonly certificateDer?: Uint8Array;
    /** Every certificate bag, in this order, instead of the identity's own followed by `chain`. */
    readonly certificates?: readonly Uint8Array[];
    /** Leave this half out; a stray bag takes its place so the container stays well-formed. */
    readonly omit?: 'certificate' | 'key';
    /** Add a data content whose bytes are not ASN.1. */
    readonly garbageContent?: boolean;
    /** Add a content of a type the format keeps for public-key privacy, which is not read. */
    readonly foreignContent?: boolean;
  } = {},
): Promise<Uint8Array> {
  const password = new TextEncoder().encode(options.password ?? PASSWORD).slice().buffer;
  const layout = options.layout ?? { certificatePrivacy: 1, keyPrivacy: 0 };
  const keyBag = new PKCS8ShroudedKeyBag({ parsedValue: PrivateKeyInfo.fromBER(identity.pkcs8.slice()) });
  await keyBag.makeInternalValues({
    password,
    contentEncryptionAlgorithm: AES_256,
    hmacHashAlgorithm: 'SHA-256',
    iterationCount: 2048,
  });
  const certificateBag = (der: Uint8Array): SafeBag =>
    new SafeBag({
      bagId: BAG_CERT,
      bagValue: new CertBag({ parsedValue: Certificate.fromBER(der.slice()) }),
    });
  const stray = new SafeBag({
    bagId: BAG_PLAIN_KEY,
    bagValue: PrivateKeyInfo.fromBER(identity.pkcs8.slice()),
  });
  const certificates: SafeBag[] =
    options.omit === 'certificate'
      ? [stray]
      : (options.certificates ?? [options.certificateDer ?? identity.der, ...(options.chain ?? [])]).map(
          certificateBag,
        );
  const keys = [
    ...(options.omit === 'key' ? [stray] : [new SafeBag({ bagId: BAG_KEY, bagValue: keyBag })]),
    ...(options.extraBags ?? []),
  ];
  const groups = [
    { privacy: layout.certificatePrivacy, bags: certificates },
    { privacy: layout.keyPrivacy, bags: keys },
  ];
  const pfx = new PFX({
    parsedValue: {
      integrityMode: 0,
      authenticatedSafe: new AuthenticatedSafe({
        parsedValue: {
          safeContents: groups.map((group) => ({
            privacyMode: group.privacy,
            value: new SafeContents({ safeBags: group.bags }),
          })),
        },
      }),
    },
  });
  await pfx.parsedValue?.authenticatedSafe?.makeInternalValues({
    safeContents: groups.map((group) =>
      group.privacy === 0
        ? {}
        : {
            password,
            contentEncryptionAlgorithm: AES_256,
            hmacHashAlgorithm: 'SHA-256',
            iterationCount: 2048,
          },
    ),
  });
  if (options.foreignContent === true) {
    pfx.parsedValue?.authenticatedSafe?.safeContents.push(
      new ContentInfo({ contentType: '1.2.840.113549.1.7.3', content: new OctetString() }),
    );
  }
  if (options.garbageContent === true) {
    pfx.parsedValue?.authenticatedSafe?.safeContents.push(
      new ContentInfo({
        contentType: ContentInfo.DATA,
        content: new OctetString({ valueHex: new Uint8Array([0xff, 0xff]).buffer }),
      }),
    );
  }
  await pfx.makeInternalValues({
    password,
    iterations: 2048,
    pbkdf2HashAlgorithm: 'SHA-256',
    hmacHashAlgorithm: 'SHA-256',
  });
  return new Uint8Array(pfx.toSchema().toBER(false));
}

/** The same certificate with its subject rewritten by `change`, re-encoded. */
function rewritten(der: Uint8Array, change: (certificate: Certificate) => void): Uint8Array {
  const certificate = Certificate.fromBER(der.slice());
  change(certificate);
  // pkijs re-emits a name from the bytes it parsed unless they are dropped.
  certificate.subject.valueBeforeDecode = new ArrayBuffer(0);
  certificate.issuer.valueBeforeDecode = new ArrayBuffer(0);
  return new Uint8Array(certificate.toSchema(true).toBER(false));
}

/** Prove a key really is the private half of `certificate`: its signature verifies. */
async function signsFor(privateKey: CryptoKey, publicKey: CryptoKey, hash = 'SHA-256'): Promise<boolean> {
  const data = new TextEncoder().encode('imzalanacak');
  const algorithm =
    privateKey.algorithm.name === 'ECDSA' ? { name: 'ECDSA', hash } : privateKey.algorithm.name;
  const signature = await crypto.subtle.sign(algorithm, privateKey, data);
  return await crypto.subtle.verify(algorithm, publicKey, signature, data);
}

describe('importPkcs12', () => {
  it('reads the certificate, the chain and the name, and gives a key that signs for the certificate', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    const ca = await identityFor({ kind: 'EC', curve: 'P-256' }, 'Kök CA');
    const other = await identityFor({ kind: 'EC', curve: 'P-256' }, 'Ara CA');
    const imported = await importPkcs12(await container(identity, { chain: [ca.der, other.der] }), PASSWORD);
    expect(Array.from(imported.certificate)).toEqual(Array.from(identity.der));
    expect(imported.chain.map((der) => Array.from(der))).toEqual([Array.from(ca.der), Array.from(other.der)]);
    expect(imported.commonName).toBe('İmza Deneme');
    expect(imported.privateKey.extractable).toBe(false);
    expect(await signsFor(imported.privateKey, identity.keyPair.publicKey)).toBe(true);
  });

  it('reads containers whose bags are stored plain, encrypted, or both ways round', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    for (const layout of [
      { certificatePrivacy: 0, keyPrivacy: 0 },
      { certificatePrivacy: 1, keyPrivacy: 1 },
      { certificatePrivacy: 0, keyPrivacy: 1 },
    ] as const) {
      const imported = await importPkcs12(await container(identity, { layout }), PASSWORD);
      expect(Array.from(imported.certificate)).toEqual(Array.from(identity.der));
      expect(await signsFor(imported.privateKey, identity.keyPair.publicKey)).toBe(true);
    }
  });

  it('imports EC keys on every supported curve with the curve of the certificate', async () => {
    for (const curve of ['P-256', 'P-384', 'P-521'] as const satisfies readonly CurveName[]) {
      const identity = await identityFor({ kind: 'EC', curve });
      const imported = await importPkcs12(await container(identity), PASSWORD);
      expect(imported.privateKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: curve });
      expect(await signsFor(imported.privateKey, identity.keyPair.publicKey, 'SHA-256')).toBe(true);
    }
  });

  it('binds an RSA key to the digest the CMS will use', async () => {
    const identity = await identityFor({ kind: 'RSA' });
    const container256 = await container(identity);
    const byDefault = await importPkcs12(container256, PASSWORD);
    expect(byDefault.privateKey.algorithm).toMatchObject({
      name: 'RSASSA-PKCS1-v1_5',
      hash: { name: 'SHA-256' },
    });
    const sha512 = await importPkcs12(container256, PASSWORD, 'SHA-512');
    expect(sha512.privateKey.algorithm).toMatchObject({ hash: { name: 'SHA-512' } });
  });

  it('reads a common name stored as a BMPString and finds it behind other name parts', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    const der = rewritten(identity.der, (certificate) => {
      certificate.subject.typesAndValues = [
        new AttributeTypeAndValue({ type: '2.5.4.10', value: new Utf8String({ value: 'Kurum' }) }),
        new AttributeTypeAndValue({ type: '2.5.4.3', value: new BmpString({ value: 'Çağrı İmza' }) }),
      ];
    });
    const imported = await importPkcs12(await container(identity, { certificateDer: der }), PASSWORD);
    expect(imported.commonName).toBe('Çağrı İmza');
  });

  it('reports no common name when the subject has none or an empty one', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    for (const typesAndValues of [
      [new AttributeTypeAndValue({ type: '2.5.4.10', value: new Utf8String({ value: 'Kurum' }) })],
      [new AttributeTypeAndValue({ type: '2.5.4.3', value: new Utf8String({ value: '' }) })],
    ]) {
      const der = rewritten(identity.der, (certificate) => {
        certificate.subject.typesAndValues = typesAndValues;
      });
      const imported = await importPkcs12(await container(identity, { certificateDer: der }), PASSWORD);
      expect(imported.commonName).toBeNull();
    }
  });

  it('skips bags that are neither a certificate nor a key', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    const stray = new SafeBag({
      bagId: BAG_PLAIN_KEY,
      bagValue: PrivateKeyInfo.fromBER(identity.pkcs8.slice()),
    });
    const imported = await importPkcs12(await container(identity, { extraBags: [stray] }), PASSWORD);
    expect(Array.from(imported.certificate)).toEqual(Array.from(identity.der));
  });

  it('refuses a wrong password', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    await expect(importPkcs12(await container(identity), 'yanlis')).rejects.toThrow();
  });

  it('refuses bytes that are not ASN.1 at all', async () => {
    await expect(importPkcs12(new Uint8Array([0xff, 0xff, 0xff]), PASSWORD)).rejects.toThrow(
      'the file is not a PKCS#12 container: its ASN.1 does not parse',
    );
  });

  it('refuses a container without a certificate and one without a private key', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    await expect(importPkcs12(await container(identity, { omit: 'certificate' }), PASSWORD)).rejects.toThrow(
      'the container carries no certificate',
    );
    await expect(importPkcs12(await container(identity, { omit: 'key' }), PASSWORD)).rejects.toThrow(
      'the container carries no private key',
    );
  });

  it('refuses a private key whose algorithm or curve is not supported', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    /** The same identity with the algorithm identifier of its key changed by `change`. */
    const withKeyAlgorithm = (change: (info: PrivateKeyInfo) => void): Identity => {
      const info = PrivateKeyInfo.fromBER(identity.pkcs8.slice());
      change(info);
      return { ...identity, pkcs8: new Uint8Array(info.toSchema().toBER(false)) };
    };
    const ed25519 = withKeyAlgorithm((info) => {
      info.privateKeyAlgorithm.algorithmId = '1.3.101.112';
    });
    await expect(importPkcs12(await container(ed25519), PASSWORD)).rejects.toThrow(
      'unsupported signing key algorithm or named curve',
    );
    const unknownCurve = withKeyAlgorithm((info) => {
      info.privateKeyAlgorithm.algorithmParams = new Integer({ value: 1 });
    });
    await expect(importPkcs12(await container(unknownCurve), PASSWORD)).rejects.toThrow(
      'unsupported signing key algorithm or named curve',
    );
  });

  it('passes over certificates whose public key it cannot read when it looks for the key’s own', async () => {
    const leaf = await identityFor({ kind: 'EC', curve: 'P-256' });
    const other = await identityFor({ kind: 'EC', curve: 'P-256' }, 'Başka CA');
    // secp256k1: a named curve, but not one WebCrypto signs with.
    const foreign = rewritten(other.der, (certificate) => {
      certificate.subjectPublicKeyInfo.algorithm.algorithmParams = new ObjectIdentifier({
        value: '1.3.132.0.10',
      });
    });
    const imported = await importPkcs12(
      await container(leaf, { certificates: [foreign, leaf.der] }),
      PASSWORD,
    );
    expect(Array.from(imported.certificate)).toEqual(Array.from(leaf.der));
    expect(imported.chain.map((der) => Array.from(der))).toEqual([Array.from(foreign)]);
  });

  it('takes the certificate the private key belongs to when the container lists CAs first', async () => {
    const leaf = await identityFor({ kind: 'EC', curve: 'P-256' });
    const rsaCa = await identityFor({ kind: 'RSA' }, 'RSA Kök CA');
    const ecCa = await identityFor({ kind: 'EC', curve: 'P-256' }, 'EC Ara CA');
    const imported = await importPkcs12(
      await container(leaf, { certificates: [rsaCa.der, ecCa.der, leaf.der] }),
      PASSWORD,
    );
    expect(Array.from(imported.certificate)).toEqual(Array.from(leaf.der));
    expect(imported.chain.map((der) => Array.from(der))).toEqual([
      Array.from(rsaCa.der),
      Array.from(ecCa.der),
    ]);
    expect(imported.commonName).toBe('İmza Deneme');
    expect(await signsFor(imported.privateKey, leaf.keyPair.publicKey)).toBe(true);
  });

  it('signs a PDF whose signature verifies when the container lists a CA before the leaf', async () => {
    const leaf = await identityFor({ kind: 'EC', curve: 'P-256' });
    const ca = await identityFor({ kind: 'EC', curve: 'P-256' }, 'Kök CA');
    const imported = await importPkcs12(
      await container(leaf, { certificates: [ca.der, leaf.der] }),
      PASSWORD,
    );
    const mupdf = await import('mupdf');
    const document = new mupdf.PDFDocument();
    document.insertPage(0, document.addPage([0, 0, 300, 400], 0, {}, ''));
    const blank = new Uint8Array(document.saveToBuffer('').asUint8Array());
    document.destroy();

    const signed = await signPdf(blank, { identity: imported }, { signal: new AbortController().signal });
    const [verdict, ...others] = await verifySignatures(signed.bytes);
    expect(others).toEqual([]);
    expect(verdict).toMatchObject({ integrity: 'valid', signer: 'İmza Deneme' });
  });

  it('refuses a container whose private key belongs to none of its certificates', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    const stranger = await identityFor({ kind: 'EC', curve: 'P-256' }, 'Başkası');
    await expect(
      importPkcs12(await container(identity, { certificates: [stranger.der] }), PASSWORD),
    ).rejects.toThrow('the container carries no certificate for its private key');
  });

  it('overwrites the password bytes and the plain key with zeros, whatever the outcome', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    const bytes = await container(identity);
    for (const password of [PASSWORD, 'yanlis']) {
      const encode = vi.spyOn(TextEncoder.prototype, 'encode');
      const parse = vi.spyOn(PFX.prototype, 'parseInternalValues');
      const importKey = vi.spyOn(crypto.subtle, 'importKey');
      let imported = true;
      try {
        await importPkcs12(bytes, password);
      } catch {
        imported = false;
      }
      const encodedAt = encode.mock.calls.findIndex(([value]) => value === password);
      const encoded = encode.mock.results[encodedAt]?.value as Uint8Array;
      const handed = parse.mock.calls[0]?.[0].password as ArrayBuffer;
      const plainKey = importKey.mock.calls.find(([format]) => format === 'pkcs8')?.[1] as
        | ArrayBuffer
        | undefined;
      encode.mockRestore();
      parse.mockRestore();
      importKey.mockRestore();

      expect(imported).toBe(password === PASSWORD);
      const length = new TextEncoder().encode(password).length;
      const zeros = new Array<number>(length).fill(0);
      // The password's UTF-8 bytes, and the buffer pkijs was handed, hold nothing any more.
      expect(Array.from(encoded)).toEqual(zeros);
      expect(Array.from(new Uint8Array(handed))).toEqual(zeros);
      // The key's plain PKCS#8 exists only once the password was right, and is wiped too.
      if (imported) {
        expect(plainKey?.byteLength ?? 0).toBeGreaterThan(0);
        expect(new Uint8Array(plainKey as ArrayBuffer).every((byte) => byte === 0)).toBe(true);
      } else {
        expect(plainKey).toBeUndefined();
      }
    }
  });

  it('ignores a data content that holds no ASN.1', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    const imported = await importPkcs12(await container(identity, { garbageContent: true }), PASSWORD);
    expect(Array.from(imported.certificate)).toEqual(Array.from(identity.der));
  });

  it('ignores a content of a type the format keeps for public-key privacy', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    const imported = await importPkcs12(await container(identity, { foreignContent: true }), PASSWORD);
    expect(Array.from(imported.certificate)).toEqual(Array.from(identity.der));
  });
});

describe('describeCertificate', () => {
  it('names the subject, the issuer and the end of validity', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    expect(describeCertificate(identity.der)).toEqual({
      commonName: 'İmza Deneme',
      issuer: 'İmza Deneme',
      notAfter: '2027-01-01T00:00:00.000Z',
    });
  });

  it('answers null for a name part the certificate does not have', async () => {
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    const der = rewritten(identity.der, (certificate) => {
      certificate.subject.typesAndValues = [
        new AttributeTypeAndValue({ type: '2.5.4.10', value: new Utf8String({ value: 'Kurum' }) }),
      ];
      certificate.issuer.typesAndValues = [];
    });
    expect(describeCertificate(der)).toMatchObject({ commonName: null, issuer: null });
  });

  it('answers null for a common name that is not text', async () => {
    // An INTEGER where a string belongs: pkijs types the value as a string, the bytes say otherwise.
    const notText = new Integer({ value: 5 }) as unknown as Utf8String;
    const identity = await identityFor({ kind: 'EC', curve: 'P-256' });
    const der = rewritten(identity.der, (certificate) => {
      certificate.subject.typesAndValues = [new AttributeTypeAndValue({ type: '2.5.4.3', value: notText })];
    });
    expect(describeCertificate(der).commonName).toBeNull();
    const imported = await importPkcs12(await container(identity, { certificateDer: der }), PASSWORD);
    expect(imported.commonName).toBeNull();
  });
});
