/**
 * `signature-revocation.ts` against real CRLs.
 *
 * Every certificate and CRL is generated and signed here with WebCrypto/pkijs
 * (`signature-revocation.fixtures.ts`), so the real parser and verifier run over real
 * signatures. These tests protect the documented answers (architecture.md §5.3.1): a verified
 * list names a certificate (`revoked`, with the date compared against the validation time) or
 * clears it (`good`); a list that did not issue the certificate, or that a PDF forged under a
 * real CA's name, can never clear or hide anything; and the CRL forms this build does not
 * process are `unknown`, never "not revoked".
 */

import { describe, expect, it } from 'vitest';
import {
  checkRevocation,
  describeCrl,
  parseCrl,
  parseRevocationSources,
  type RevocationCertCheck,
  summarizeRevocation,
} from './signature-revocation';
import {
  CRL_REASON,
  deltaIndicatorExtension,
  issueCrl,
  scopeExtension,
} from './signature-revocation.fixtures';
import type { CertificateFixture } from './signature-trust.fixtures';
import { generateKey, issueCertificate } from './signature-trust.fixtures';

const day = (month: number, date: number): Date => new Date(Date.UTC(2026, month - 1, date));
const VALID = { notBefore: day(1, 1), notAfter: new Date(Date.UTC(2027, 0, 1)) };
/** The signature is judged at 1 March; the CRLs below are issued on 1 May; "today" is 1 June. */
const SIGNED_AT = day(3, 1);
const NOW = day(6, 1);
const CRL_DATES = { thisUpdate: day(5, 1), nextUpdate: day(7, 1) };

async function makeCa(subject: string, issuer?: CertificateFixture): Promise<CertificateFixture> {
  return await issueCertificate(
    {
      subject,
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign', 'cRLSign'],
    },
    issuer,
  );
}

async function makeLeaf(subject: string, ca: CertificateFixture): Promise<CertificateFixture> {
  return await issueCertificate(
    {
      subject,
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      ...VALID,
      basicConstraints: { cA: false },
      keyUsage: ['digitalSignature'],
    },
    ca,
  );
}

async function check(
  leaf: CertificateFixture,
  pool: readonly CertificateFixture[],
  crls: readonly Uint8Array[],
  validationTime = SIGNED_AT,
): Promise<readonly RevocationCertCheck[]> {
  return await checkRevocation({
    leaf: leaf.der,
    leafRole: 'signer',
    pool: pool.map((entry) => entry.der),
    context: {
      sources: parseRevocationSources({ imported: crls }),
      validationTime,
      now: NOW,
    },
  });
}

describe('revocation answers from a verified CRL', () => {
  it('answers good for a list that does not name the certificate, with its coverage and age', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const other = await makeLeaf('Someone else', ca);
    const crl = await issueCrl({ issuer: ca, ...CRL_DATES, revoked: [{ cert: other, at: day(2, 1) }] });

    const [only, ...rest] = await check(leaf, [ca], [crl]);
    // The self-signed CA above the signer is not checked: nothing publishes a list for it.
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      role: 'signer',
      subject: 'Signer',
      status: 'good',
      source: 'crl',
      origin: 'imported',
      thisUpdate: CRL_DATES.thisUpdate.toISOString(),
      nextUpdate: CRL_DATES.nextUpdate.toISOString(),
      coversValidationTime: true,
      stale: false,
      revokedAt: null,
      timing: null,
      unknownReason: null,
    });
    expect(summarizeRevocation([only as RevocationCertCheck], false)).toBe('not-revoked');
  });

  it('reports the date and reason, and whether the revocation came before or after the validation time', async () => {
    const ca = await makeCa('CA');
    const early = await makeLeaf('Revoked early', ca);
    const late = await makeLeaf('Revoked late', ca);
    const crl = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      revoked: [
        { cert: early, at: day(2, 1), reason: CRL_REASON.keyCompromise },
        { cert: late, at: day(4, 1), reason: CRL_REASON.superseded },
      ],
    });

    const [before] = await check(early, [ca], [crl]);
    expect(before).toMatchObject({
      status: 'revoked',
      revokedAt: day(2, 1).toISOString(),
      reason: 'keyCompromise',
      timing: 'before-signing',
      coversValidationTime: null,
    });
    const [after] = await check(late, [ca], [crl]);
    expect(after).toMatchObject({
      status: 'revoked',
      revokedAt: day(4, 1).toISOString(),
      reason: 'superseded',
      timing: 'after-signing',
    });
    // The summary: a later revocation is harmless only against a trusted time.
    expect(summarizeRevocation([after as RevocationCertCheck], true)).toBe('revoked-after-signing');
    expect(summarizeRevocation([after as RevocationCertCheck], false)).toBe('revoked');
    expect(summarizeRevocation([before as RevocationCertCheck], true)).toBe('revoked');
  });

  it('treats removeFromCRL as not revoked, and a list issued before the signature as not covering it', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const lifted = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      revoked: [{ cert: leaf, at: day(2, 1), reason: CRL_REASON.removeFromCRL }],
    });
    expect((await check(leaf, [ca], [lifted]))[0]).toMatchObject({ status: 'good', timing: null });

    // Signed in June, list issued in May: it cannot exclude a revocation between the two.
    const [old] = await check(leaf, [ca], [lifted], day(6, 1));
    expect(old).toMatchObject({ status: 'good', coversValidationTime: false });
  });

  it('marks a list past its nextUpdate as stale instead of refusing it', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const expired = await issueCrl({ issuer: ca, thisUpdate: day(3, 15), nextUpdate: day(4, 15) });
    expect((await check(leaf, [ca], [expired]))[0]).toMatchObject({
      status: 'good',
      stale: true,
      nextUpdate: day(4, 15).toISOString(),
    });
  });
});

describe('which list may speak for which certificate', () => {
  it('ignores a CRL from a different issuer, even one that names the certificate', async () => {
    const ca = await makeCa('CA');
    const otherCa = await makeCa('Another CA');
    const leaf = await makeLeaf('Signer', ca);
    const foreign = await issueCrl({
      issuer: otherCa,
      ...CRL_DATES,
      revoked: [{ cert: leaf, at: day(2, 1) }],
    });

    expect((await check(leaf, [ca], [foreign]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'no-list',
      revokedAt: null,
    });
  });

  it('rejects a CRL signed by a lookalike CA with the real name, so it cannot hide a real revocation', async () => {
    const ca = await makeCa('CA');
    const impostor = await makeCa('CA'); // same name, different key
    const leaf = await makeLeaf('Signer', ca);
    const real = await issueCrl({ issuer: ca, ...CRL_DATES, revoked: [{ cert: leaf, at: day(2, 1) }] });
    const forgedClean = await issueCrl({ issuer: impostor, ...CRL_DATES });

    expect((await check(leaf, [ca, impostor], [forgedClean]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'invalid-list',
    });
    expect((await check(leaf, [ca, impostor], [forgedClean, real]))[0]).toMatchObject({
      status: 'revoked',
      timing: 'before-signing',
    });
  });

  it('rejects a CRL whose signature is not by the issuer it names, and one from an issuer without cRLSign', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const stranger = await makeCa('Stranger');
    const wrongKey = await issueCrl({ issuer: ca, signedBy: stranger, ...CRL_DATES });
    expect((await check(leaf, [ca], [wrongKey]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'invalid-list',
    });

    const noCrlSign = await issueCertificate({
      subject: 'Cert signer only',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign'],
    });
    const child = await makeLeaf('Child', noCrlSign);
    const crl = await issueCrl({ issuer: noCrlSign, ...CRL_DATES });
    expect((await check(child, [noCrlSign], [crl]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'invalid-list',
    });
  });
});

describe('CRL forms this build does not process', () => {
  it('answers unknown, never good, for indirect, delta, partitioned and reason-scoped lists', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
      [
        'indirect',
        await issueCrl({ issuer: ca, ...CRL_DATES, extensions: [scopeExtension({ indirect: true })] }),
        'unsupported-list',
      ],
      [
        'delta',
        await issueCrl({ issuer: ca, ...CRL_DATES, extensions: [deltaIndicatorExtension()] }),
        'list-scope',
      ],
      [
        'partitioned',
        await issueCrl({
          issuer: ca,
          ...CRL_DATES,
          extensions: [scopeExtension({ distributionPointUri: 'http://example.test/part-2.crl' })],
        }),
        'list-scope',
      ],
      [
        'only some reasons',
        await issueCrl({ issuer: ca, ...CRL_DATES, extensions: [scopeExtension({ onlySomeReasons: true })] }),
        'list-scope',
      ],
    ];
    for (const [label, crl, reason] of cases) {
      const [answer] = await check(leaf, [ca], [crl]);
      expect(answer, label).toMatchObject({ status: 'unknown', unknownReason: reason });
    }
  });

  it('still reports a revocation a delta list names, and a CRL the pool cannot verify as no-issuer', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const delta = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      extensions: [deltaIndicatorExtension()],
      revoked: [{ cert: leaf, at: day(2, 1) }],
    });
    expect((await check(leaf, [ca], [delta]))[0]).toMatchObject({ status: 'revoked' });
    // With the issuer missing from the pool there is no key to verify any list with.
    expect((await check(leaf, [], [delta]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'no-issuer',
    });
  });
});

describe('the chain and the summary', () => {
  it('checks the intermediate too, and calls a signer cleared above an unanswered CA partial', async () => {
    const root = await makeCa('Root');
    const intermediate = await makeCa('Intermediate', root);
    const leaf = await makeLeaf('Signer', intermediate);
    const crl = await issueCrl({ issuer: intermediate, ...CRL_DATES });

    const checks = await check(leaf, [intermediate, root], [crl]);
    expect(checks.map((entry) => [entry.role, entry.subject, entry.status])).toEqual([
      ['signer', 'Signer', 'good'],
      ['intermediate', 'Intermediate', 'unknown'],
    ]);
    expect(summarizeRevocation(checks, false)).toBe('partial');

    const rootCrl = await issueCrl({ issuer: root, ...CRL_DATES });
    const full = await check(leaf, [intermediate, root], [crl, rootCrl]);
    expect(full.map((entry) => entry.status)).toEqual(['good', 'good']);
    expect(summarizeRevocation(full, false)).toBe('not-revoked');
  });

  it('summarises the empty and the all-unknown cases as indeterminate', () => {
    expect(summarizeRevocation([], true)).toBe('indeterminate');
    const unknown = { status: 'unknown' } as RevocationCertCheck;
    expect(summarizeRevocation([unknown, unknown], true)).toBe('indeterminate');
  });
});

describe('reading a CRL', () => {
  it('describes an imported CRL and rejects bytes that are not one', async () => {
    const ca = await makeCa('Describe CA');
    const leaf = await makeLeaf('Signer', ca);
    const crl = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      revoked: [{ cert: leaf, at: day(2, 1) }],
      extensions: [deltaIndicatorExtension()],
    });
    expect(describeCrl(crl)).toEqual({
      issuer: 'Describe CA',
      thisUpdate: CRL_DATES.thisUpdate.toISOString(),
      nextUpdate: CRL_DATES.nextUpdate.toISOString(),
      revokedCount: 1,
      delta: true,
    });
    expect(describeCrl(ca.der)).toBeNull(); // a certificate is not a CRL
    expect(parseCrl(new Uint8Array([1, 2, 3, 4]), 'imported')).toBeNull();
    expect(parseCrl(new Uint8Array(0), 'embedded')).toBeNull();
    // Unparseable inputs are dropped from the sources instead of speaking for anything.
    const sources = parseRevocationSources({ imported: [crl, new Uint8Array([9, 9])], embeddedCrls: [crl] });
    expect(sources.crls.map((entry) => entry.origin)).toEqual(['imported', 'embedded']);
  });
});
