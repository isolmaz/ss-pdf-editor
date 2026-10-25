/**
 * `signature-validation.ts`: the order the offline evidence is put together in.
 *
 * Real CMS, timestamp tokens and CRLs (`signature-revocation.fixtures.ts`). These tests
 * protect docs/architecture.md §5.3.2: the validation time is `timestamp` > `timestamp-untrusted` >
 * claimed `signing-time` > `clock`, a revocation after the signature is excused only by a
 * trusted timestamp (a back-dated claimed time never earns it), and a document timestamp is
 * judged at its own time.
 */

import { BitString, fromBER } from 'asn1js';
import { Certificate } from 'pkijs';
import { describe, expect, it } from 'vitest';
import {
  CRL_REASON,
  extKeyUsageExtension,
  issueCrl,
  issueOcspResponse,
  issueTimestampToken,
  KP_TIME_STAMPING,
  signatureValueOf,
  signedCms,
  withEditedCms,
  withUnsigned,
} from './signature-revocation.fixtures';
import type { CertificateFixture } from './signature-trust.fixtures';
import { ecdsaRawToDer, generateKey, issueCertificate } from './signature-trust.fixtures';
import { evaluateDocumentTimestamp, evaluateEvidence, NO_DSS } from './signature-validation';

const day = (month: number, date: number): Date => new Date(Date.UTC(2026, month - 1, date));
const VALID = { notBefore: day(1, 1), notAfter: new Date(Date.UTC(2030, 0, 1)) };
const NOW = day(6, 1);
/** Claimed and stamped at 1 March; the signer's certificate is revoked on 1 April. */
const SIGNED_AT = day(3, 1);
const REVOKED_AT = day(4, 1);

async function pki() {
  const ca = await issueCertificate({
    subject: 'CA',
    keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
    ...VALID,
    basicConstraints: { cA: true },
    keyUsage: ['keyCertSign', 'cRLSign'],
  });
  const issue = async (subject: string, stamping: boolean) =>
    await issueCertificate(
      {
        subject,
        keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
        ...VALID,
        basicConstraints: { cA: false },
        keyUsage: ['digitalSignature'],
        ...(stamping ? { extraExtensions: [extKeyUsageExtension([KP_TIME_STAMPING])] } : {}),
      },
      ca,
    );
  const signer = await issue('Signer', false);
  const tsa = await issue('TSA', true);
  const crl = await issueCrl({
    issuer: ca,
    thisUpdate: day(5, 1),
    nextUpdate: day(7, 1),
    revoked: [{ cert: signer, at: REVOKED_AT }],
  });
  return { ca, signer, tsa, crl };
}

function input(
  cms: Uint8Array,
  signer: CertificateFixture,
  ca: CertificateFixture,
  extra: { claimedAt?: string | null; roots?: Uint8Array[]; importedCrls?: Uint8Array[] } = {},
) {
  return {
    contents: cms,
    signatureValue: signatureValueOf(cms),
    signer: signer.der,
    chain: [ca.der],
    claimedAt: extra.claimedAt ?? null,
    roots: extra.roots ?? [],
    importedCrls: extra.importedCrls ?? [],
    dss: NO_DSS,
    now: NOW,
  };
}

describe('evaluateEvidence', () => {
  it('falls back from the claimed signing time to the clock, and never beyond now', async () => {
    const { ca, signer } = await pki();
    const cms = await signedCms(signer, [ca], SIGNED_AT);

    const claimed = await evaluateEvidence(input(cms, signer, ca));
    expect(claimed).toMatchObject({ validationTimeSource: 'signing-time', timestamp: null });
    expect(claimed.validationTime.toISOString()).toBe(SIGNED_AT.toISOString());
    expect(claimed.trustAt.toISOString()).toBe(NOW.toISOString()); // a claim never moves the trust date
    expect(claimed.trust).toMatchObject({ verdict: 'not-checked', reason: 'no-roots' });

    // `/M` only (junk CMS), a future date: clamped to now.
    const future = await evaluateEvidence({
      ...input(cms, signer, ca, { claimedAt: day(12, 1).toISOString() }),
      contents: new Uint8Array([1, 2, 3]),
    });
    expect(future.validationTimeSource).toBe('signing-time');
    expect(future.validationTime.toISOString()).toBe(NOW.toISOString());

    const none = await evaluateEvidence({ ...input(cms, signer, ca), contents: new Uint8Array([1, 2, 3]) });
    expect(none.validationTimeSource).toBe('clock');
    expect(none.validationTime.toISOString()).toBe(NOW.toISOString());
  });

  it('excuses a later revocation only through a timestamp from an imported TSA', async () => {
    const { ca, signer, tsa, crl } = await pki();
    const base = await signedCms(signer, [ca], SIGNED_AT);
    const token = await issueTimestampToken({
      tsa,
      covered: signatureValueOf(base),
      genTime: SIGNED_AT,
      extraCertificates: [ca],
    });
    const cms = withUnsigned(base, { timestampToken: token });

    const trusted = await evaluateEvidence(input(cms, signer, ca, { roots: [ca.der], importedCrls: [crl] }));
    expect(trusted.timestamp).toMatchObject({ status: 'valid', trusted: true });
    expect(trusted.validationTimeSource).toBe('timestamp');
    expect(trusted.trustAt.toISOString()).toBe(SIGNED_AT.toISOString());
    expect(trusted.trust).toMatchObject({ verdict: 'trusted', path: ['Signer', 'CA'] });
    expect(trusted.revocationChecks[0]).toMatchObject({ status: 'revoked', timing: 'after-signing' });
    expect(trusted.revocation).toBe('revoked-after-signing');

    // The same kind of token from a TSA whose root nobody imported (the signer's is): the time is
    // shown and used, and excuses nothing.
    const strangerCa = await issueCertificate({
      subject: 'Stranger CA',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign', 'cRLSign'],
    });
    const strangerTsa = await issueCertificate(
      {
        subject: 'Stranger TSA',
        keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
        ...VALID,
        basicConstraints: { cA: false },
        keyUsage: ['digitalSignature'],
        extraExtensions: [extKeyUsageExtension([KP_TIME_STAMPING])],
      },
      strangerCa,
    );
    const strangerToken = await issueTimestampToken({
      tsa: strangerTsa,
      covered: signatureValueOf(base),
      genTime: SIGNED_AT,
      extraCertificates: [strangerCa],
    });
    const untrusted = await evaluateEvidence(
      input(withUnsigned(base, { timestampToken: strangerToken }), signer, ca, {
        roots: [ca.der],
        importedCrls: [crl],
      }),
    );
    expect(untrusted.timestamp).toMatchObject({ status: 'valid', trusted: false });
    expect(untrusted.validationTimeSource).toBe('timestamp-untrusted');
    expect(untrusted.validationTime.toISOString()).toBe(SIGNED_AT.toISOString());
    expect(untrusted.trustAt.toISOString()).toBe(NOW.toISOString());
    expect(untrusted.revocation).toBe('revoked');
  });

  it('does not let a back-dated signing time excuse a revocation, and reads CRLs from the DSS', async () => {
    const { ca, signer, crl } = await pki();
    const cms = await signedCms(signer, [ca], SIGNED_AT);

    const imported = await evaluateEvidence(input(cms, signer, ca, { roots: [ca.der], importedCrls: [crl] }));
    expect(imported.revocationChecks[0]).toMatchObject({ status: 'revoked', timing: 'after-signing' });
    expect(imported.revocation).toBe('revoked');

    // A revocation signed by the key that issued the signer stands before a root vouches for that key.
    const unanchored = await evaluateEvidence(input(cms, signer, ca, { importedCrls: [crl] }));
    expect(unanchored.revocationChecks[0]).toMatchObject({ status: 'revoked', unknownReason: null });
    expect(unanchored.revocation).toBe('revoked');

    const viaDss = await evaluateEvidence({
      ...input(cms, signer, ca, { roots: [ca.der] }),
      dss: { certs: [], crls: [crl], ocsps: [] },
    });
    expect(viaDss.revocationChecks[0]).toMatchObject({ status: 'revoked', origin: 'embedded' });

    const noLists = await evaluateEvidence(input(cms, signer, ca, { roots: [ca.der] }));
    expect(noLists.revocation).toBe('indeterminate');
    expect(noLists.revocationChecks[0]).toMatchObject({ status: 'unknown', unknownReason: 'no-list' });

    const noSigner = await evaluateEvidence({ ...input(cms, signer, ca), signer: new Uint8Array(0) });
    expect(noSigner).toMatchObject({ revocationChecks: [], revocation: 'indeterminate' });
  });
});

describe('evaluateEvidence with several timestamp tokens', () => {
  type Pki = Awaited<ReturnType<typeof pki>>;

  /** A CMS whose timestamp attribute carries every token given, in that order. */
  async function stamped(setup: Pki, tokens: (covered: Uint8Array) => Promise<Uint8Array[]>) {
    const { ca, signer } = setup;
    const base = await signedCms(signer, [ca], SIGNED_AT);
    const [first, ...rest] = await tokens(signatureValueOf(base));
    if (first === undefined) throw new Error('at least one token');
    const cms = withEditedCms(withUnsigned(base, { timestampToken: first }), (signedData) => {
      const attribute = signedData.signerInfos[0]?.unsignedAttrs?.attributes[0];
      if (attribute === undefined) throw new Error('fixture has no unsigned attribute');
      for (const token of rest) attribute.values.push(fromBER(token.slice().buffer).result);
    });
    return { cms, signer, ca };
  }

  /** A token from the one TSA under the one CA of `setup`: a single PKI per test, not one per token. */
  const stampOf = async ({ ca, tsa }: Pki, covered: Uint8Array, genTime: Date) =>
    await issueTimestampToken({ tsa, covered, genTime, extraCertificates: [ca] });

  // Four scenarios of real CMS building and verification: ~0.3 s alone, but over the 5 s default
  // when the whole unit suite saturates the machine (the CPU-bound work is slowed ~15x).
  it('uses the first token that verifies, and keeps it when a later one also verifies or fails', {
    timeout: 60_000,
  }, async () => {
    // Every scenario shares this PKI: each `pki()` is six key generations and signatures, and
    // building one per token made the test take 13 of them.
    const setup = await pki();
    const wrong = new Uint8Array([1, 2, 3]);
    // A bad token first: the good one after it wins.
    const badFirst = await stamped(setup, async (covered) => [
      await stampOf(setup, wrong, day(2, 1)),
      await stampOf(setup, covered, day(3, 2)),
    ]);
    const chosen = await evaluateEvidence(input(badFirst.cms, badFirst.signer, badFirst.ca));
    expect(chosen.timestamp?.status).toBe('valid');
    expect(chosen.timestamp?.genTime).toBe(day(3, 2).toISOString());

    // A good token first stays, whether the next one is good or bad.
    const goodThenGood = await stamped(setup, async (covered) => [
      await stampOf(setup, covered, day(3, 2)),
      await stampOf(setup, covered, day(3, 3)),
    ]);
    expect(
      (await evaluateEvidence(input(goodThenGood.cms, goodThenGood.signer, goodThenGood.ca))).timestamp
        ?.genTime,
    ).toBe(day(3, 2).toISOString());
    const goodThenBad = await stamped(setup, async (covered) => [
      await stampOf(setup, covered, day(3, 2)),
      await stampOf(setup, wrong, day(3, 3)),
    ]);
    expect(
      (await evaluateEvidence(input(goodThenBad.cms, goodThenBad.signer, goodThenBad.ca))).timestamp?.genTime,
    ).toBe(day(3, 2).toISOString());

    // Nothing verifies: the first failing token is still reported, never silently dropped.
    const allBad = await stamped(setup, async () => [
      await stampOf(setup, wrong, day(2, 1)),
      await stampOf(setup, new Uint8Array([9]), day(2, 2)),
    ]);
    const reported = await evaluateEvidence(input(allBad.cms, allBad.signer, allBad.ca));
    expect(reported.timestamp).toMatchObject({ status: 'invalid', genTime: day(2, 1).toISOString() });
    expect(reported.validationTimeSource).not.toBe('timestamp');
  });

  it('prefers a token from a trusted TSA over an earlier valid one nobody vouched for, and keeps the first of equals', async () => {
    const setup = await pki();
    const { ca, crl } = setup;
    // A second PKI no one imported: its token verifies, but is not trusted.
    const rogueCa = await issueCertificate({
      subject: 'Rogue CA',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign', 'cRLSign'],
    });
    const rogueTsa = await issueCertificate(
      {
        subject: 'Rogue TSA',
        keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
        ...VALID,
        basicConstraints: { cA: false },
        keyUsage: ['digitalSignature'],
        extraExtensions: [extKeyUsageExtension([KP_TIME_STAMPING])],
      },
      rogueCa,
    );
    const rogue = async (covered: Uint8Array, genTime: Date) =>
      await issueTimestampToken({ tsa: rogueTsa, covered, genTime, extraCertificates: [rogueCa] });
    const trustedConfig = { roots: [ca.der], importedCrls: [crl] };

    const untrustedFirst = await stamped(setup, async (covered) => [
      await rogue(covered, day(3, 2)),
      await stampOf(setup, covered, day(3, 3)),
    ]);
    const chosen = await evaluateEvidence({
      ...input(untrustedFirst.cms, untrustedFirst.signer, untrustedFirst.ca),
      ...trustedConfig,
    });
    expect(chosen.timestamp).toMatchObject({ status: 'valid', tsa: 'TSA', trusted: true });
    expect(chosen.timestamp?.genTime).toBe(day(3, 3).toISOString());
    expect(chosen.validationTimeSource).toBe('timestamp');

    // Two trusted tokens: the first stays. Two untrusted ones (nothing imported): the first stays too.
    const bothTrusted = await stamped(setup, async (covered) => [
      await stampOf(setup, covered, day(3, 2)),
      await stampOf(setup, covered, day(3, 3)),
    ]);
    const first = await evaluateEvidence({
      ...input(bothTrusted.cms, bothTrusted.signer, bothTrusted.ca),
      ...trustedConfig,
    });
    expect(first.timestamp?.genTime).toBe(day(3, 2).toISOString());
    const noRoots = await evaluateEvidence(
      input(untrustedFirst.cms, untrustedFirst.signer, untrustedFirst.ca),
    );
    expect(noRoots.timestamp).toMatchObject({ status: 'valid', tsa: 'Rogue TSA', trusted: false });
    expect(noRoots.validationTimeSource).toBe('timestamp-untrusted');
  });

  it('ignores timestamp tokens when the signature value is unknown', async () => {
    const setup = await pki();
    const { cms, signer, ca } = await stamped(setup, async (covered) => [
      await stampOf(setup, covered, day(3, 2)),
    ]);
    const outcome = await evaluateEvidence({ ...input(cms, signer, ca), signatureValue: null });
    expect(outcome.timestamp).toBeNull();
    expect(outcome.validationTimeSource).toBe('signing-time');
  });
});

describe('evaluateDocumentTimestamp', () => {
  it('verifies a document timestamp and summarises its TSA chain, never excusing a revoked TSA as "later"', async () => {
    const { ca, tsa } = await pki();
    const covered = new TextEncoder().encode('the byte range of the document');
    const token = await issueTimestampToken({ tsa, covered, genTime: SIGNED_AT, extraCertificates: [ca] });
    const base = { token, covered, roots: [ca.der], importedCrls: [], dss: NO_DSS, now: NOW };

    // No list speaks for the TSA: its time is shown, but unknown is never clean.
    const unlisted = await evaluateDocumentTimestamp(base);
    expect(unlisted.timestamp).toMatchObject({ kind: 'document', status: 'valid', trusted: false });
    expect(unlisted.revocation).toBe('indeterminate');

    const empty = await issueCrl({ issuer: ca, thisUpdate: day(5, 1), nextUpdate: day(7, 1) });
    const clean = await evaluateDocumentTimestamp({ ...base, importedCrls: [empty] });
    expect(clean.timestamp).toMatchObject({ kind: 'document', status: 'valid', trusted: true });
    expect(clean.revocation).toBe('not-revoked');

    // Revoked after genTime: still `revoked`, because a document timestamp has no trusted time to compare with.
    const crl = await issueCrl({
      issuer: ca,
      thisUpdate: day(5, 1),
      nextUpdate: day(7, 1),
      revoked: [{ cert: tsa, at: REVOKED_AT }],
    });
    const revoked = await evaluateDocumentTimestamp({ ...base, importedCrls: [crl] });
    expect(revoked.timestamp).toMatchObject({ status: 'valid', trusted: false });
    expect(revoked.revocation).toBe('revoked');

    const mismatch = await evaluateDocumentTimestamp({ ...base, covered: new Uint8Array([1, 2, 3]) });
    expect(mismatch.timestamp).toMatchObject({ status: 'invalid', reason: 'imprint-mismatch' });
  });
});

describe('evaluateEvidence along the trusted path', () => {
  const key = () => generateKey({ kind: 'EC', curve: 'P-256' });
  const authority = async (
    subject: string,
    keyPair: CryptoKeyPair,
    issuer?: CertificateFixture,
    notAfter?: Date,
  ) =>
    await issueCertificate(
      {
        subject,
        keyPair,
        ...VALID,
        ...(notAfter === undefined ? {} : { notAfter }),
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign', 'cRLSign'],
      },
      issuer,
    );
  const holder = async (
    subject: string,
    issuer: CertificateFixture,
    notAfter = VALID.notAfter,
    stamping = false,
  ) =>
    await issueCertificate(
      {
        subject,
        keyPair: await key(),
        notBefore: VALID.notBefore,
        notAfter,
        basicConstraints: { cA: false },
        keyUsage: ['digitalSignature'],
        ...(stamping ? { extraExtensions: [extKeyUsageExtension([KP_TIME_STAMPING])] } : {}),
      },
      issuer,
    );
  const LIST_DATES = { thisUpdate: day(5, 1), nextUpdate: day(7, 1) };
  const evidence = (
    signer: CertificateFixture,
    chain: readonly Uint8Array[],
    roots: readonly CertificateFixture[],
    extra: { importedCrls?: Uint8Array[]; dss?: Partial<typeof NO_DSS> } = {},
  ) =>
    evaluateEvidence({
      contents: new Uint8Array([1, 2, 3]),
      signatureValue: null,
      signer: signer.der,
      chain: [...chain],
      claimedAt: SIGNED_AT.toISOString(),
      roots: roots.map((entry) => entry.der),
      importedCrls: extra.importedCrls ?? [],
      dss: { ...NO_DSS, ...extra.dss },
      now: NOW,
    });
  const rows = (checks: readonly { subject: string; status: string }[]) =>
    checks.map((entry) => [entry.subject, entry.status]);

  /** The root's own tbsCertificate, signed again with `keyPair`: a copy anyone can make. */
  async function resigned(root: CertificateFixture, keyPair: CryptoKeyPair): Promise<Uint8Array> {
    const copy = Certificate.fromBER(root.der.slice().buffer);
    const raw = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      new Uint8Array(copy.tbsView).slice().buffer,
    );
    copy.signatureValue = new BitString({ valueHex: ecdsaRawToDer(new Uint8Array(raw)).slice().buffer });
    return new Uint8Array(copy.toSchema(false).toBER(false));
  }

  it('lets no list speak for an imported root through a copy of it that another key signed', async () => {
    const root = await authority('Root', await key());
    const intermediate = await authority('Intermediate', await key(), root);
    const importedCrls = [
      await issueCrl({ issuer: intermediate, ...LIST_DATES }),
      await issueCrl({ issuer: root, ...LIST_DATES }),
    ];
    // A certificate named like the root under another key, the root's tbsCertificate signed with
    // that key, and a list in the root's name saying the root is revoked.
    const attackerKey = await key();
    const namesake = await authority('Root', attackerKey);
    const copy = await resigned(root, attackerKey);
    const forged = await issueCrl({
      issuer: namesake,
      ...LIST_DATES,
      revoked: [{ cert: root, at: day(2, 1), reason: CRL_REASON.keyCompromise }],
    });

    const signer = await holder('Signer', intermediate);
    const alongPath = await evidence(signer, [intermediate.der, copy], [root], {
      importedCrls,
      dss: { certs: [namesake.der], crls: [forged] },
    });
    expect(alongPath.trust).toMatchObject({ verdict: 'trusted', path: ['Signer', 'Intermediate', 'Root'] });
    expect(rows(alongPath.revocationChecks)).toEqual([
      ['Signer', 'good'],
      ['Intermediate', 'good'],
    ]);
    expect(alongPath.revocation).toBe('not-revoked');

    // Expired by now, with no timestamp: no trusted path, so the chain is built by signatures.
    const expired = await holder('Signer', intermediate, day(4, 1));
    const withoutPath = await evidence(expired, [intermediate.der], [root], {
      importedCrls,
      dss: { certs: [copy, namesake.der], crls: [forged] },
    });
    expect(withoutPath.trust?.verdict).not.toBe('trusted');
    expect(rows(withoutPath.revocationChecks)).toEqual([
      ['Signer', 'good'],
      ['Intermediate', 'good'],
    ]);
    expect(withoutPath.revocation).toBe('not-revoked');
  });

  it('checks no certificate above the intermediate when the path runs through a re-issued copy of the root', async () => {
    const rootKey = await key();
    const root = await authority('Root', rootKey);
    // The same name and key with a longer validity: another tbsCertificate, signed by the root's key.
    const reissued = await authority('Root', rootKey, undefined, new Date(Date.UTC(2031, 0, 1)));
    const intermediate = await authority('Intermediate', await key(), root);
    const signer = await holder('Signer', intermediate);
    const ocsps = [
      await issueOcspResponse({
        issuer: intermediate,
        producedAt: day(5, 1),
        singles: [{ cert: signer, status: 'good', ...LIST_DATES }],
      }),
      await issueOcspResponse({
        issuer: root,
        producedAt: day(5, 1),
        singles: [{ cert: intermediate, status: 'good', ...LIST_DATES }],
      }),
    ];

    const outcome = await evidence(signer, [reissued.der, intermediate.der], [root], { dss: { ocsps } });
    expect(outcome.trust).toMatchObject({
      verdict: 'trusted',
      path: ['Signer', 'Intermediate', 'Root', 'Root'],
    });
    expect(rows(outcome.revocationChecks)).toEqual([
      ['Signer', 'good'],
      ['Intermediate', 'good'],
    ]);
    expect(outcome.revocation).toBe('not-revoked');
  });

  it('checks the signer and a document timestamp along the paths their trust walks validated', async () => {
    const root = await authority('Root', await key());
    const intermediate = await authority('Intermediate', await key(), root);
    // Another root certified the intermediate's key, and has replaced that certificate since.
    const other = await authority('Other Root', await key());
    const cross = await issueCertificate(
      {
        subject: 'Intermediate',
        keyPair: intermediate.keyPair,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign', 'cRLSign'],
      },
      other,
    );
    const importedCrls = [
      await issueCrl({ issuer: intermediate, ...LIST_DATES }),
      await issueCrl({ issuer: root, ...LIST_DATES }),
      await issueCrl({
        issuer: other,
        ...LIST_DATES,
        revoked: [{ cert: cross, at: day(2, 1), reason: CRL_REASON.superseded }],
      }),
    ];

    const signer = await holder('Signer', intermediate);
    const signature = await evidence(signer, [cross.der, other.der, intermediate.der], [root], {
      importedCrls,
    });
    expect(signature.trust).toMatchObject({ verdict: 'trusted', path: ['Signer', 'Intermediate', 'Root'] });
    expect(rows(signature.revocationChecks)).toEqual([
      ['Signer', 'good'],
      ['Intermediate', 'good'],
    ]);
    expect(signature.revocation).toBe('not-revoked');

    const tsa = await holder('TSA', intermediate, VALID.notAfter, true);
    const covered = new TextEncoder().encode('the byte range of the document');
    const token = await issueTimestampToken({
      tsa,
      covered,
      genTime: SIGNED_AT,
      extraCertificates: [cross, other, intermediate],
    });
    const stamp = await evaluateDocumentTimestamp({
      token,
      covered,
      roots: [root.der],
      importedCrls,
      dss: NO_DSS,
      now: NOW,
    });
    expect(stamp.timestamp).toMatchObject({
      status: 'valid',
      trusted: true,
      tsaPath: ['TSA', 'Intermediate', 'Root'],
    });
    expect(rows(stamp.timestamp.tsaRevocation)).toEqual([
      ['TSA', 'good'],
      ['Intermediate', 'good'],
    ]);
    expect(stamp.revocation).toBe('not-revoked');
  });
});
