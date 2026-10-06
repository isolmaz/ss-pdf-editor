/**
 * `signature-evidence.ts`: what a signature's CMS carries besides the signature.
 *
 * The CMS is a real `detachedCmsSignature`, with a real RFC 3161 token, CRLs and an Adobe
 * revocation archive added to it. These tests protect where each thing is looked for
 * (architecture.md §5.3.1/§5.3.2): the timestamp in the unsigned attributes, CRLs in
 * `SignedData.crls` and in the archive attribute, the signing time in the signed attributes,
 * and that bytes which are not a CMS answer `null` instead of an invented empty result.
 */

import { describe, expect, it } from 'vitest';
import { readSignatureEvidence, readSignedData } from './signature-evidence';
import {
  extKeyUsageExtension,
  issueCrl,
  issueTimestampToken,
  KP_TIME_STAMPING,
  signatureValueOf,
  signedCms,
  withUnsigned,
} from './signature-revocation.fixtures';
import { generateKey, issueCertificate } from './signature-trust.fixtures';

const day = (month: number, date: number): Date => new Date(Date.UTC(2026, month - 1, date));
const VALID = { notBefore: day(1, 1), notAfter: new Date(Date.UTC(2027, 0, 1)) };

async function pki() {
  const ca = await issueCertificate({
    subject: 'CA',
    keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
    ...VALID,
    basicConstraints: { cA: true },
    keyUsage: ['keyCertSign', 'cRLSign'],
  });
  const signer = await issueCertificate(
    {
      subject: 'Signer',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      ...VALID,
      basicConstraints: { cA: false },
      keyUsage: ['digitalSignature'],
    },
    ca,
  );
  const tsa = await issueCertificate(
    {
      subject: 'TSA',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      ...VALID,
      basicConstraints: { cA: false },
      keyUsage: ['digitalSignature'],
      extraExtensions: [extKeyUsageExtension([KP_TIME_STAMPING])],
    },
    ca,
  );
  return { ca, signer, tsa };
}

describe('readSignatureEvidence', () => {
  it('reads the certificates and the signing time of a plain signature, and nothing it does not carry', async () => {
    const { ca, signer } = await pki();
    const cms = await signedCms(signer, [ca], day(3, 1));

    const evidence = readSignatureEvidence(cms);
    expect(evidence?.certificates.map((der) => Array.from(der))).toEqual([
      Array.from(signer.der),
      Array.from(ca.der),
    ]);
    expect(evidence?.signingTime?.toISOString()).toBe(day(3, 1).toISOString());
    expect(evidence?.timestampTokens).toEqual([]);
    expect(evidence?.crls).toEqual([]);
    expect(evidence?.ocspResponses).toEqual([]);

    // `/Contents` is zero-padded past the CMS; the first TLV decides where it ends.
    const padded = new Uint8Array(cms.length + 100);
    padded.set(cms);
    expect(readSignatureEvidence(padded)?.signingTime?.toISOString()).toBe(day(3, 1).toISOString());
  });

  it('finds the signature timestamp token in the unsigned attributes, byte for byte', async () => {
    const { ca, signer, tsa } = await pki();
    const cms = await signedCms(signer, [ca], day(3, 1));
    const token = await issueTimestampToken({ tsa, covered: signatureValueOf(cms), genTime: day(3, 2) });

    const evidence = readSignatureEvidence(withUnsigned(cms, { timestampToken: token }));
    expect(evidence?.timestampTokens).toHaveLength(1);
    expect(Array.from(evidence?.timestampTokens[0] ?? [])).toEqual(Array.from(token));
    // The token is a ContentInfo that `readSignedData` reads as the TSA's SignedData.
    expect(readSignedData(evidence?.timestampTokens[0] ?? new Uint8Array(0))?.signerInfos).toHaveLength(1);
  });

  it('finds CRLs in SignedData.crls and in the Adobe archive, and OCSP responses in the archive', async () => {
    const { ca, signer } = await pki();
    const inCms = await issueCrl({ issuer: ca, thisUpdate: day(4, 1) });
    const archived = await issueCrl({
      issuer: ca,
      thisUpdate: day(5, 1),
      revoked: [{ cert: signer, at: day(4, 1) }],
    });
    const ocsp = new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x00]); // a well-formed TLV: only its position matters
    const cms = withUnsigned(await signedCms(signer, [ca], day(3, 1)), {
      crls: [inCms],
      archival: { crls: [archived], ocsps: [ocsp] },
    });

    const evidence = readSignatureEvidence(cms);
    expect(evidence?.crls.map((der) => Array.from(der))).toEqual([Array.from(inCms), Array.from(archived)]);
    expect(evidence?.ocspResponses.map((der) => Array.from(der))).toEqual([Array.from(ocsp)]);
  });

  it('answers null for bytes that are not a CMS SignedData', () => {
    expect(readSignatureEvidence(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readSignatureEvidence(new Uint8Array(0))).toBeNull();
    // A well-formed DER that is a different structure (an OCTET STRING).
    expect(readSignedData(new Uint8Array([0x04, 0x01, 0x00]))).toBeNull();
  });
});
