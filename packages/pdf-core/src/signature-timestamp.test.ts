/**
 * `signature-timestamp.ts` against real RFC 3161 tokens.
 *
 * Tokens are built with pkijs (`signature-revocation.fixtures.ts`) over certificates issued in
 * the test. These tests protect the documented checks (architecture.md §5.3.2): the imprint
 * must be the hash of the covered bytes, the CMS signature must verify with the TSA
 * certificate, that certificate must be allowed to stamp and valid at `genTime`, and a token
 * from a TSA nobody imported verifies but is never `trusted`.
 */

import { describe, expect, it } from 'vitest';
import { parseRevocationSources } from './signature-revocation';
import {
  extKeyUsageExtension,
  issueCrl,
  issueTimestampToken,
  KP_TIME_STAMPING,
} from './signature-revocation.fixtures';
import { verifyTimestampToken } from './signature-timestamp';
import type { CertificateFixture, IssueOptions } from './signature-trust.fixtures';
import { generateKey, issueCertificate } from './signature-trust.fixtures';

const day = (month: number, date: number): Date => new Date(Date.UTC(2026, month - 1, date));
const GEN_TIME = day(3, 1);
const NOW = day(6, 1);
const COVERED = new TextEncoder().encode('the signature value a timestamp stamps');
const NO_SOURCES = parseRevocationSources({});

async function makeRoot(): Promise<CertificateFixture> {
  return await issueCertificate({
    subject: 'TSA Root',
    keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
    notBefore: day(1, 1),
    notAfter: new Date(Date.UTC(2030, 0, 1)),
    basicConstraints: { cA: true },
    keyUsage: ['keyCertSign', 'cRLSign'],
  });
}

async function makeTsa(
  root: CertificateFixture,
  extra: Partial<IssueOptions> = {},
): Promise<CertificateFixture> {
  return await issueCertificate(
    {
      subject: 'Test TSA',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      notBefore: day(1, 1),
      notAfter: new Date(Date.UTC(2027, 0, 1)),
      basicConstraints: { cA: false },
      keyUsage: ['digitalSignature'],
      extraExtensions: [extKeyUsageExtension([KP_TIME_STAMPING])],
      ...extra,
    },
    root,
  );
}

describe('verifyTimestampToken', () => {
  it('verifies a token over the covered bytes and reads the time and TSA, trusted only through an imported root', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const token = await issueTimestampToken({
      tsa,
      covered: COVERED,
      genTime: GEN_TIME,
      extraCertificates: [root],
    });

    const untrusted = await verifyTimestampToken({
      kind: 'signature',
      token,
      covered: COVERED,
      sources: NO_SOURCES,
      now: NOW,
    });
    expect(untrusted).toMatchObject({
      kind: 'signature',
      status: 'valid',
      reason: null,
      genTime: GEN_TIME.toISOString(),
      tsa: 'Test TSA',
      hashAlgorithm: 'SHA-256',
      tsaSelfSigned: false,
      trusted: false,
      tsaTrust: 'not-checked',
      tsaTrustReason: 'no-roots',
    });

    const trusted = await verifyTimestampToken({
      kind: 'signature',
      token,
      covered: COVERED,
      roots: [root.der],
      sources: NO_SOURCES,
      now: NOW,
    });
    expect(trusted).toMatchObject({
      status: 'valid',
      tsaTrust: 'trusted',
      tsaPath: ['Test TSA', 'TSA Root'],
      tsaNotAfter: new Date(Date.UTC(2027, 0, 1)).toISOString(),
      trusted: true,
    });
  });

  it('accepts the zero padding a PDF /Contents carries after the token', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const token = await issueTimestampToken({ tsa, covered: COVERED, genTime: GEN_TIME });
    const padded = new Uint8Array(token.length + 64);
    padded.set(token);
    const result = await verifyTimestampToken({
      kind: 'document',
      token: padded,
      covered: COVERED,
      sources: NO_SOURCES,
      now: NOW,
    });
    expect(result).toMatchObject({ kind: 'document', status: 'valid' });
  });

  it('rejects a token whose message imprint does not match the covered bytes', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const token = await issueTimestampToken({ tsa, covered: COVERED, genTime: GEN_TIME });
    const other = new TextEncoder().encode('a different signature value');
    const result = await verifyTimestampToken({
      kind: 'signature',
      token,
      covered: other,
      roots: [root.der],
      sources: NO_SOURCES,
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'invalid', reason: 'imprint-mismatch', trusted: false });
    // Even though the token is otherwise well-formed, its time is still reported.
    expect(result.genTime).toBe(GEN_TIME.toISOString());
  });

  it('rejects a token signed by a key the TSA certificate does not hold', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const stranger = await generateKey({ kind: 'EC', curve: 'P-256' });
    const token = await issueTimestampToken({
      tsa,
      covered: COVERED,
      genTime: GEN_TIME,
      signWith: stranger.privateKey,
    });
    const result = await verifyTimestampToken({
      kind: 'signature',
      token,
      covered: COVERED,
      roots: [root.der],
      sources: NO_SOURCES,
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'invalid', reason: 'bad-signature', trusted: false });
  });

  it('rejects a TSA certificate that may not stamp, or that was not valid at genTime', async () => {
    const root = await makeRoot();
    const noPurpose = await makeTsa(root, { extraExtensions: [extKeyUsageExtension(['1.3.6.1.5.5.7.3.4'])] });
    const wrongPurpose = await issueTimestampToken({ tsa: noPurpose, covered: COVERED, genTime: GEN_TIME });
    expect(
      await verifyTimestampToken({
        kind: 'signature',
        token: wrongPurpose,
        covered: COVERED,
        roots: [root.der],
        sources: NO_SOURCES,
        now: NOW,
      }),
    ).toMatchObject({ status: 'invalid', reason: 'tsa-key-usage', trusted: false });

    const tsa = await makeTsa(root);
    const early = await issueTimestampToken({
      tsa,
      covered: COVERED,
      genTime: new Date(Date.UTC(2025, 11, 1)),
    });
    expect(
      await verifyTimestampToken({
        kind: 'signature',
        token: early,
        covered: COVERED,
        roots: [root.der],
        sources: NO_SOURCES,
        now: NOW,
      }),
    ).toMatchObject({ status: 'invalid', reason: 'tsa-validity' });
  });

  it('is not trusted when a CRL on the device revokes the TSA certificate, and is unchecked when not a token', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const token = await issueTimestampToken({ tsa, covered: COVERED, genTime: GEN_TIME });
    const crl = await issueCrl({
      issuer: root,
      thisUpdate: day(5, 1),
      nextUpdate: day(7, 1),
      revoked: [{ cert: tsa, at: day(2, 1) }],
    });
    const revoked = await verifyTimestampToken({
      kind: 'signature',
      token,
      covered: COVERED,
      roots: [root.der],
      sources: parseRevocationSources({ imported: [crl] }),
      now: NOW,
    });
    expect(revoked).toMatchObject({ status: 'valid', tsaTrust: 'trusted', trusted: false });
    expect(revoked.tsaRevocation[0]).toMatchObject({
      role: 'timestamp',
      status: 'revoked',
      timing: 'before-signing',
    });

    expect(
      await verifyTimestampToken({
        kind: 'signature',
        token: new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
        covered: COVERED,
        sources: NO_SOURCES,
        now: NOW,
      }),
    ).toMatchObject({ status: 'unchecked', reason: 'malformed', genTime: null, trusted: false });
  });
});
