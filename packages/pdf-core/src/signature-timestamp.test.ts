/**
 * `signature-timestamp.ts` against real RFC 3161 tokens.
 *
 * Tokens are built with pkijs (`signature-revocation.fixtures.ts`) over certificates issued in
 * the test. These tests protect the documented checks (docs/architecture.md §5.3.2): the imprint
 * must be the hash of the covered bytes, the CMS signature must verify with the TSA
 * certificate, that certificate must be allowed to stamp and valid at `genTime`, and a token
 * from a TSA nobody imported verifies but is never `trusted`.
 */

import { Integer, OctetString, Sequence } from 'asn1js';
import { AlgorithmIdentifier, OtherCertificateFormat } from 'pkijs';
import { describe, expect, it, vi } from 'vitest';
import { parseRevocationSources } from './signature-revocation';
import {
  extKeyUsageExtension,
  issueCrl,
  issueTimestampToken,
  KP_TIME_STAMPING,
  rawExtension,
  type TokenOptions,
  withEditedCms,
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

const OID_SKI = '2.5.29.14';
const OID_SHA512_UNKNOWN = '1.2.840.113549.2.5'; // MD5: a real hash this build does not use
const OID_ED25519 = '1.3.101.112';

/** The extension a certificate carries to say which key it holds. */
const keyIdentifierExtension = (octets: Uint8Array) =>
  rawExtension(OID_SKI, false, new OctetString({ valueHex: octets.slice().buffer }).toBER(false));

async function verify(token: Uint8Array, roots: readonly Uint8Array[] = []) {
  return await verifyTimestampToken({
    kind: 'signature',
    token,
    covered: COVERED,
    roots,
    sources: NO_SOURCES,
    now: NOW,
  });
}

describe('how the token names its signer', () => {
  it('finds the TSA certificate by key identifier among certificates that do not match', async () => {
    const root = await makeRoot();
    const ski = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    const tsa = await makeTsa(root, {
      extraExtensions: [extKeyUsageExtension([KP_TIME_STAMPING]), keyIdentifierExtension(ski)],
    });
    // The root has no key identifier at all; the others have one that is wrong, one that is not
    // an OCTET STRING, and one that is not DER.
    const decoy = (octets: Uint8Array, name: string) =>
      makeTsa(root, { subject: name, extraExtensions: [keyIdentifierExtension(octets)] });
    const wrong = await decoy(new Uint8Array([1, 2, 3, 4]), 'Wrong id');
    const notOctets = await makeTsa(root, {
      subject: 'Integer id',
      extraExtensions: [rawExtension(OID_SKI, false, new Integer({ value: 9 }).toBER(false))],
    });
    const notDer = await makeTsa(root, {
      subject: 'Broken id',
      extraExtensions: [rawExtension(OID_SKI, false, new Uint8Array([0x04, 0x09]).buffer as ArrayBuffer)],
    });
    // asn1js throws, rather than reporting an offset, on a GeneralizedTime that is not a date.
    const throwing = await makeTsa(root, {
      subject: 'Throwing id',
      extraExtensions: [
        rawExtension(
          OID_SKI,
          false,
          new Uint8Array([0x18, 0x06, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46]).buffer as ArrayBuffer,
        ),
      ],
    });
    const token = await issueTimestampToken({
      tsa,
      covered: COVERED,
      genTime: GEN_TIME,
      keyIdentifier: ski,
      extraCertificates: [root, wrong, notOctets, notDer, throwing],
    });
    expect(await verify(token, [root.der])).toMatchObject({
      status: 'valid',
      tsa: 'Test TSA',
      tsaTrust: 'trusted',
      trusted: true,
    });

    // A BER-constructed `[0]` (two OCTET STRING segments), against a certificate whose own
    // identifier is written in segments too, names the same key.
    const segmented = await makeTsa(root, {
      subject: 'Segmented TSA',
      extraExtensions: [
        extKeyUsageExtension([KP_TIME_STAMPING]),
        rawExtension(
          OID_SKI,
          false,
          new Uint8Array([0x24, 0x08, 0x04, 0x02, 0xca, 0xfe, 0x04, 0x02, 0xba, 0xbe]).buffer as ArrayBuffer,
        ),
      ],
    });
    const constructedToken = await issueTimestampToken({
      tsa: segmented,
      covered: COVERED,
      genTime: GEN_TIME,
      keyIdentifier: ski,
      keyIdentifierConstructed: true,
      extraCertificates: [wrong, segmented],
    });
    expect(await verify(constructedToken, [root.der])).toMatchObject({
      status: 'valid',
      tsa: 'Segmented TSA',
    });

    // The same token with only the decoys has no certificate for its signer.
    const nobody = withEditedCms(token, (signedData) => {
      signedData.certificates = (signedData.certificates ?? []).filter(
        (entry) => 'subject' in entry && entry.serialNumber.isEqual(tsa.parsed.serialNumber) === false,
      );
    });
    expect(await verify(nobody, [root.der])).toMatchObject({
      status: 'unchecked',
      reason: 'no-tsa-certificate',
      tsa: null,
      hashAlgorithm: 'SHA-256',
      genTime: GEN_TIME.toISOString(),
    });
  });

  it('reports no TSA certificate when the token carries none, matches none, or names no signer', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const token = await issueTimestampToken({ tsa, covered: COVERED, genTime: GEN_TIME });
    const expected = { status: 'unchecked', reason: 'no-tsa-certificate', trusted: false };

    const noCertificates = withEditedCms(token, (signedData) => {
      signedData.certificates = undefined;
    });
    expect(await verify(noCertificates, [root.der])).toMatchObject(expected);

    // A certificate set holding only another certificate format has no X.509 certificate either.
    const otherFormat = withEditedCms(token, (signedData) => {
      signedData.certificates = [
        new OtherCertificateFormat({ otherCertFormat: '1.2.3.4', otherCert: new Sequence() }),
      ];
    });
    expect(await verify(otherFormat, [root.der])).toMatchObject(expected);

    const otherTsa = await makeTsa(root, { subject: 'Another TSA' });
    const wrongCertificate = await issueTimestampToken({
      tsa,
      covered: COVERED,
      genTime: GEN_TIME,
      extraCertificates: [otherTsa],
    });
    const onlyOther = withEditedCms(wrongCertificate, (signedData) => {
      signedData.certificates = [otherTsa.parsed];
    });
    expect(await verify(onlyOther, [root.der])).toMatchObject(expected);

    const noSigner = withEditedCms(token, (signedData) => {
      signedData.signerInfos = [];
    });
    expect(await verify(noSigner, [root.der])).toMatchObject(expected);
  });
});

describe('the signed attributes of a token', () => {
  it('verifies a token whose signature covers signed attributes, and ties them to the TSTInfo', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const token = await issueTimestampToken({
      tsa,
      covered: COVERED,
      genTime: GEN_TIME,
      signedAttributes: {},
      extraCertificates: [root],
    });
    expect(await verify(token, [root.der])).toMatchObject({
      status: 'valid',
      reason: null,
      trusted: true,
      tsa: 'Test TSA',
    });
  });

  it('rejects attributes that do not name the TSTInfo or do not carry its digest', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const cases: ReadonlyArray<readonly [string, NonNullable<TokenOptions['signedAttributes']>]> = [
      ['no content type', { contentType: 'omit' }],
      ['the wrong content type', { contentType: '1.2.840.113549.1.7.1' }],
      ['no message digest', { messageDigest: 'omit' }],
      ['a message digest that is not an OCTET STRING', { messageDigest: 'not-octets' }],
      ['a message digest with no value', { messageDigest: 'empty' }],
      ['the digest of other bytes', { messageDigest: 'wrong' }],
    ];
    for (const [label, signedAttributes] of cases) {
      const token = await issueTimestampToken({ tsa, covered: COVERED, genTime: GEN_TIME, signedAttributes });
      expect(await verify(token, [root.der]), label).toMatchObject({
        status: 'invalid',
        reason: 'digest-mismatch',
        tsa: 'Test TSA',
        trusted: false,
      });
    }
  });

  it('is unchecked, not invalid, for a digest or signature algorithm this build does not implement', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const withAttributes = await issueTimestampToken({
      tsa,
      covered: COVERED,
      genTime: GEN_TIME,
      signedAttributes: {},
    });
    const oddDigest = withEditedCms(withAttributes, (signedData) => {
      const [signer] = signedData.signerInfos;
      if (signer !== undefined)
        signer.digestAlgorithm = new AlgorithmIdentifier({ algorithmId: OID_SHA512_UNKNOWN });
    });
    expect(await verify(oddDigest, [root.der])).toMatchObject({
      status: 'unchecked',
      reason: 'unsupported-hash',
      tsa: 'Test TSA',
    });

    const plain = await issueTimestampToken({ tsa, covered: COVERED, genTime: GEN_TIME });
    const oddSignature = withEditedCms(plain, (signedData) => {
      const [signer] = signedData.signerInfos;
      if (signer !== undefined)
        signer.signatureAlgorithm = new AlgorithmIdentifier({ algorithmId: OID_ED25519 });
    });
    expect(await verify(oddSignature, [root.der])).toMatchObject({
      status: 'unchecked',
      reason: 'unsupported-signature',
      tsa: 'Test TSA',
    });
  });
});

describe('the content of a token', () => {
  it('is unchecked for an imprint hash this build does not know, and invalid for an imprint of the wrong length', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const unknown = await issueTimestampToken({
      tsa,
      covered: COVERED,
      genTime: GEN_TIME,
      imprintAlgorithmOid: OID_SHA512_UNKNOWN,
    });
    expect(await verify(unknown, [root.der])).toMatchObject({
      status: 'unchecked',
      reason: 'unsupported-hash',
      genTime: GEN_TIME.toISOString(),
      hashAlgorithm: null,
    });

    // The token says SHA-384 but its imprint is a 32-byte SHA-256 digest.
    const short = await issueTimestampToken({
      tsa,
      covered: COVERED,
      genTime: GEN_TIME,
      imprintAlgorithmOid: '2.16.840.1.101.3.4.2.2',
    });
    expect(await verify(short, [root.der])).toMatchObject({
      status: 'invalid',
      reason: 'imprint-mismatch',
      hashAlgorithm: 'SHA-384',
    });
  });

  it('is unchecked as malformed when the TSTInfo is missing, is not a TSTInfo, or is another content type', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const token = await issueTimestampToken({ tsa, covered: COVERED, genTime: GEN_TIME });
    const edits: ReadonlyArray<readonly [string, Parameters<typeof withEditedCms>[1]]> = [
      [
        'no content',
        (signedData) => {
          signedData.encapContentInfo.eContent = undefined;
        },
      ],
      [
        'content that is not DER',
        (signedData) => {
          signedData.encapContentInfo.eContent = new OctetString({
            valueHex: new Uint8Array([0x30, 0x7f, 0x01]).buffer as ArrayBuffer,
          });
        },
      ],
      [
        'another content type',
        (signedData) => {
          signedData.encapContentInfo.eContentType = '1.2.840.113549.1.7.1';
        },
      ],
    ];
    for (const [label, change] of edits) {
      expect(await verify(withEditedCms(token, change), [root.der]), label).toMatchObject({
        status: 'unchecked',
        reason: 'malformed',
        genTime: null,
        trusted: false,
      });
    }
  });

  it('rejects a TSA certificate with no extended key usage at all', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root, { extraExtensions: [] });
    const token = await issueTimestampToken({ tsa, covered: COVERED, genTime: GEN_TIME });
    expect(await verify(token, [root.der])).toMatchObject({ status: 'invalid', reason: 'tsa-key-usage' });
  });

  it('is unchecked when the runtime has no WebCrypto', async () => {
    const root = await makeRoot();
    const tsa = await makeTsa(root);
    const token = await issueTimestampToken({ tsa, covered: COVERED, genTime: GEN_TIME });
    vi.stubGlobal('crypto', {});
    try {
      expect(await verify(token, [root.der])).toMatchObject({
        status: 'unchecked',
        reason: 'unsupported-signature',
        genTime: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
