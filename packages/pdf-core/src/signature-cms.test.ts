/**
 * `detachedCmsSignature`: the CMS a PAdES B-B signature carries. The wrong answers that
 * matter: a signature a reader cannot verify (checked here by pkijs's verifier, apart from
 * the code that wrote it), a digest that is not the digest of the content, signed attributes
 * in the wrong DER order, an algorithm taken from the caller instead of the key, and a key
 * or certificate this build cannot use that is accepted anyway.
 */

import type { OctetString } from 'asn1js';
import { Certificate, RelativeDistinguishedNames } from 'pkijs';
import { describe, expect, it } from 'vitest';
import { detachedCmsSignature, type SignatureDigest } from './signature-cms';
import { readSignedData } from './signature-evidence';
import { generateKey, issueCertificate, type KeySpec } from './signature-trust.fixtures';

const CONTENT = new TextEncoder().encode('the signed byte range');

/** An RSA key bound to `hash`, as the PKCS#12 import creates it for the chosen digest. */
function rsaKey(hash: SignatureDigest): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]), hash },
    true,
    ['sign', 'verify'],
  );
}

async function identity(spec: KeySpec, hash: SignatureDigest = 'SHA-256') {
  const keyPair = spec.kind === 'RSA' ? await rsaKey(hash) : await generateKey(spec);
  const certificate = await issueCertificate({
    subject: 'İmzacı',
    keyPair,
    notBefore: new Date(Date.UTC(2026, 0, 1)),
    notAfter: new Date(Date.UTC(2027, 0, 1)),
    keyUsage: ['digitalSignature'],
  });
  return { certificate, privateKey: keyPair.privateKey };
}

describe('detachedCmsSignature', () => {
  it('signs with each key type and digest so an independent verifier accepts the CMS', async () => {
    const cases: readonly [KeySpec, SignatureDigest][] = [
      [{ kind: 'EC', curve: 'P-256' }, 'SHA-256'],
      [{ kind: 'EC', curve: 'P-384' }, 'SHA-384'],
      [{ kind: 'EC', curve: 'P-521' }, 'SHA-512'],
      [{ kind: 'RSA' }, 'SHA-256'],
      [{ kind: 'RSA' }, 'SHA-512'],
    ];
    for (const [spec, digest] of cases) {
      const { certificate, privateKey } = await identity(spec, digest);
      const signedAt = new Date(Date.UTC(2026, 5, 1, 12, 30, 15));
      const cms = await detachedCmsSignature(
        CONTENT,
        { certificate: certificate.der, privateKey },
        { digest, signedAt },
      );
      expect(cms.digest).toBe(digest);

      const signedData = readSignedData(cms.der);
      expect(signedData, `${JSON.stringify(spec)} ${digest}`).not.toBeNull();
      if (signedData === null) continue;
      expect(
        await signedData.verify({ signer: 0, data: CONTENT.slice().buffer, checkChain: false }),
        `${JSON.stringify(spec)} ${digest}`,
      ).toBe(true);
      // The same bytes with one flipped do not verify.
      const tampered = CONTENT.slice();
      tampered[0] = (tampered[0] ?? 0) ^ 0x01;
      await expect(
        signedData.verify({ signer: 0, data: tampered.buffer, checkChain: false }),
      ).rejects.toThrow("Message digest doesn't match");

      const info = signedData.signerInfos[0];
      const attributes = info?.signedAttrs?.attributes ?? [];
      const messageDigest = attributes.find((attribute) => attribute.type === '1.2.840.113549.1.9.4');
      const statedValue = messageDigest?.values[0] as OctetString | undefined;
      const stated = statedValue?.valueBlock.valueHexView ?? new Uint8Array();
      const actual = new Uint8Array(await crypto.subtle.digest(digest, CONTENT));
      expect(Array.from(stated)).toEqual(Array.from(actual));
      expect(signedData.certificates?.length).toBe(1);
    }
  });

  it('defaults to SHA-256 and the current time, and carries the chain along', async () => {
    const { certificate, privateKey } = await identity({ kind: 'EC', curve: 'P-256' });
    const issuer = await identity({ kind: 'EC', curve: 'P-256' });
    const before = Date.now();
    const cms = await detachedCmsSignature(CONTENT, {
      certificate: certificate.der,
      chain: [issuer.certificate.der],
      privateKey,
    });
    expect(cms.digest).toBe('SHA-256');
    const signedData = readSignedData(cms.der);
    expect(signedData?.certificates).toHaveLength(2);
    const second = signedData?.certificates?.[1] as Certificate | undefined;
    expect(second?.subject.typesAndValues[0]?.value.valueBlock.value).toBe('İmzacı');
    const time = signedData?.signerInfos[0]?.signedAttrs?.attributes.find(
      (attribute) => attribute.type === '1.2.840.113549.1.9.5',
    )?.values[0] as { toDate(): Date } | undefined;
    expect(time?.toDate().getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 - 1000);
    expect(time?.toDate().getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('writes the signed attributes in DER set order', async () => {
    const { certificate, privateKey } = await identity({ kind: 'RSA' }, 'SHA-384');
    const cms = await detachedCmsSignature(
      CONTENT,
      { certificate: certificate.der, privateKey },
      { digest: 'SHA-384' },
    );
    const attributes = readSignedData(cms.der)?.signerInfos[0]?.signedAttrs?.attributes ?? [];
    expect(attributes).toHaveLength(4);
    const encoded = attributes.map((attribute) => new Uint8Array(attribute.toSchema().toBER(false)));
    const asText = (bytes: Uint8Array): string => String.fromCharCode(...bytes);
    expect(encoded.map(asText)).toEqual([...encoded.map(asText)].sort());
    // SHA-384 is not the default of ESSCertIDv2, so the hash algorithm is spelled out.
    const essCertId = attributes.find((attribute) => attribute.type === '1.2.840.113549.1.9.16.2.47');
    const essEncoded = essCertId === undefined ? new ArrayBuffer(0) : essCertId.toSchema().toBER(false);
    expect(essEncoded.byteLength).toBeGreaterThan(60);
  });

  it('refuses an RSA key whose hash is not the digest the CMS would state', async () => {
    const { certificate, privateKey } = await identity({ kind: 'RSA' }, 'SHA-256');
    await expect(
      detachedCmsSignature(CONTENT, { certificate: certificate.der, privateKey }, { digest: 'SHA-512' }),
    ).rejects.toThrow('the RSA key signs with SHA-256, so the CMS digest cannot be SHA-512');
  });

  it('refuses a key that is neither RSA nor ECDSA, naming it', async () => {
    const certificate = await identity({ kind: 'EC', curve: 'P-256' });
    const agreement = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]);
    await expect(
      detachedCmsSignature(CONTENT, {
        certificate: certificate.certificate.der,
        privateKey: agreement.privateKey,
      }),
    ).rejects.toThrow(
      'signing needs an RSASSA-PKCS1-v1_5 or ECDSA key; this key is "ECDH", which this build cannot sign with',
    );
  });

  it('refuses a certificate without a subject', async () => {
    const { certificate, privateKey } = await identity({ kind: 'EC', curve: 'P-256' });
    const anonymous = Certificate.fromBER(certificate.der.slice());
    anonymous.subject = new RelativeDistinguishedNames({ typesAndValues: [] });
    await expect(
      detachedCmsSignature(CONTENT, {
        certificate: new Uint8Array(anonymous.toSchema(true).toBER(false)),
        privateKey,
      }),
    ).rejects.toThrow('the signing certificate has an empty subject');
  });
});
