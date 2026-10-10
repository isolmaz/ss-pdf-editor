/**
 * `signature-revocation.ts` against real CRLs.
 *
 * Every certificate and CRL is generated and signed here with WebCrypto/pkijs
 * (`signature-revocation.fixtures.ts`), so the real parser and verifier run over real
 * signatures. These tests protect the documented answers (docs/architecture.md §5.3.1): a verified
 * list names a certificate (`revoked`, with the date compared against the validation time) or
 * clears it (`good`); a list that did not issue the certificate, or that a PDF forged under a
 * real CA's name, can never clear or hide anything; and the CRL forms this build does not
 * process are `unknown`, never "not revoked".
 */

import {
  BitString,
  Enumerated,
  GeneralizedTime,
  Integer,
  ObjectIdentifier,
  Sequence,
  Utf8String,
} from 'asn1js';
import { AttributeTypeAndValue, RelativeDistinguishedNames } from 'pkijs';
import { describe, expect, it, vi } from 'vitest';
import {
  checkRevocation,
  describeCrl,
  extendedKeyUsage,
  parseCrl,
  parseOcsp,
  parseRevocationSources,
  type RevocationCertCheck,
  summarizeRevocation,
} from './signature-revocation';
import {
  CRL_REASON,
  crlDistributionPointsExtension,
  deltaIndicatorExtension,
  extKeyUsageExtension,
  issueCrl,
  issueOcspResponse,
  KP_OCSP_SIGNING,
  KP_TIME_STAMPING,
  rawExtension,
  scopeExtension,
} from './signature-revocation.fixtures';
import type { CertificateFixture } from './signature-trust.fixtures';
import { generateKey, issueCertificate, unknownCriticalExtension } from './signature-trust.fixtures';

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

  it('does not call a certificate cleared only by a list too old to speak for the signature not revoked', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    // Issued after the signature (1 March), but past its nextUpdate today (1 June).
    const expired = await issueCrl({ issuer: ca, thisUpdate: day(3, 15), nextUpdate: day(4, 15) });
    const stale = await check(leaf, [ca], [expired]);
    expect(stale[0]).toMatchObject({ status: 'good', stale: true, coversValidationTime: true });
    // The signer's own time can be back-dated to sit before an old list: only a current list
    // proves anything then.
    expect(summarizeRevocation(stale, false)).toBe('not-revoked-outdated');
    // A trusted timestamp fixes the time, and a list issued after it still speaks for it.
    expect(summarizeRevocation(stale, true)).toBe('not-revoked');

    // Signed in June, list issued in May: not even a trusted time lets it exclude a revocation
    // in between.
    const current = await issueCrl({ issuer: ca, ...CRL_DATES });
    const early = await check(leaf, [ca], [current], day(6, 1));
    expect(early[0]).toMatchObject({ status: 'good', stale: false, coversValidationTime: false });
    expect(summarizeRevocation(early, true)).toBe('not-revoked-outdated');
    expect(summarizeRevocation(early, false)).toBe('not-revoked-outdated');
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

/** What the OCSP tests ask: the signature is judged at 1 March, responses are produced on 1 May. */
const PRODUCED = day(5, 1);
const OCSP_DATES = { thisUpdate: day(5, 1), nextUpdate: day(7, 1) };

async function checkOcsp(
  leaf: CertificateFixture,
  pool: readonly CertificateFixture[],
  ocsps: readonly Uint8Array[],
  crls: readonly Uint8Array[] = [],
  validationTime = SIGNED_AT,
): Promise<readonly RevocationCertCheck[]> {
  return await checkRevocation({
    leaf: leaf.der,
    leafRole: 'signer',
    pool: pool.map((entry) => entry.der),
    context: {
      sources: parseRevocationSources({ embeddedOcsps: ocsps, embeddedCrls: crls }),
      validationTime,
      now: NOW,
    },
  });
}

/** A certificate the CA allows to answer OCSP on its behalf. */
async function makeResponder(
  ca: CertificateFixture,
  options: {
    readonly purposes?: readonly string[] | null;
    readonly notAfter?: Date;
    readonly name?: string;
  } = {},
): Promise<CertificateFixture> {
  const purposes = options.purposes === undefined ? [KP_OCSP_SIGNING] : options.purposes;
  return await issueCertificate(
    {
      subject: options.name ?? 'Responder',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      notBefore: VALID.notBefore,
      notAfter: options.notAfter ?? VALID.notAfter,
      basicConstraints: { cA: false },
      keyUsage: ['digitalSignature'],
      ...(purposes === null ? {} : { extraExtensions: [extKeyUsageExtension(purposes)] }),
    },
    ca,
  );
}

describe('revocation answers from an OCSP response', () => {
  it('answers good with the response time, the next update and the OCSP source, whatever hash names the CertID', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    for (const hash of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const) {
      const response = await issueOcspResponse({
        issuer: ca,
        producedAt: PRODUCED,
        singles: [{ cert: leaf, status: 'good', hash, ...OCSP_DATES }],
      });
      const [only, ...rest] = await checkOcsp(leaf, [ca], [response]);
      expect(rest, hash).toEqual([]);
      expect(only, hash).toMatchObject({
        role: 'signer',
        subject: 'Signer',
        status: 'good',
        source: 'ocsp',
        origin: 'embedded',
        thisUpdate: OCSP_DATES.thisUpdate.toISOString(),
        nextUpdate: OCSP_DATES.nextUpdate.toISOString(),
        coversValidationTime: true,
        stale: false,
        revokedAt: null,
        reason: null,
        timing: null,
        unknownReason: null,
      });
    }
  });

  it('keeps a response without nextUpdate, which is never stale', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const response = await issueOcspResponse({
      issuer: ca,
      producedAt: PRODUCED,
      singles: [{ cert: leaf, status: 'good', thisUpdate: PRODUCED }],
    });
    expect((await checkOcsp(leaf, [ca], [response]))[0]).toMatchObject({
      status: 'good',
      nextUpdate: null,
      stale: false,
    });
  });

  it('reports a revocation with its date and reason, and its timing against the validation time', async () => {
    const ca = await makeCa('CA');
    const early = await makeLeaf('Revoked early', ca);
    const late = await makeLeaf('Revoked late', ca);
    const noReason = await makeLeaf('No reason', ca);
    const unlisted = await makeLeaf('Unlisted reason', ca);
    const response = await issueOcspResponse({
      issuer: ca,
      producedAt: PRODUCED,
      singles: [
        { cert: early, status: 'revoked', revokedAt: day(2, 1), reason: 1, ...OCSP_DATES },
        { cert: late, status: 'revoked', revokedAt: day(4, 1), reason: 4, ...OCSP_DATES },
        { cert: noReason, status: 'revoked', revokedAt: day(2, 15), ...OCSP_DATES },
        // Reason 7 is not assigned by RFC 5280: the revocation stands without a reason.
        { cert: unlisted, status: 'revoked', revokedAt: day(2, 20), reason: 7, ...OCSP_DATES },
      ],
    });

    expect((await checkOcsp(early, [ca], [response]))[0]).toMatchObject({
      status: 'revoked',
      source: 'ocsp',
      origin: 'embedded',
      revokedAt: day(2, 1).toISOString(),
      reason: 'keyCompromise',
      timing: 'before-signing',
      coversValidationTime: null,
    });
    expect((await checkOcsp(late, [ca], [response]))[0]).toMatchObject({
      status: 'revoked',
      revokedAt: day(4, 1).toISOString(),
      reason: 'superseded',
      timing: 'after-signing',
    });
    expect((await checkOcsp(noReason, [ca], [response]))[0]).toMatchObject({
      status: 'revoked',
      revokedAt: day(2, 15).toISOString(),
      reason: null,
      timing: 'before-signing',
    });
    expect((await checkOcsp(unlisted, [ca], [response]))[0]).toMatchObject({
      status: 'revoked',
      reason: null,
    });
  });

  it('answers unknown, never good, for a response that says it does not know the certificate', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const response = await issueOcspResponse({
      issuer: ca,
      producedAt: PRODUCED,
      singles: [{ cert: leaf, status: 'unknown', ...OCSP_DATES }],
    });
    expect((await checkOcsp(leaf, [ca], [response]))[0]).toMatchObject({
      status: 'unknown',
      source: null,
      unknownReason: 'list-scope',
    });
  });

  it('finds the entry for the certificate among several, and ignores one answering for a different serial', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const other = await makeLeaf('Other', ca);
    const response = await issueOcspResponse({
      issuer: ca,
      producedAt: PRODUCED,
      singles: [
        { cert: other, status: 'revoked', revokedAt: day(2, 1), ...OCSP_DATES },
        { cert: leaf, status: 'good', ...OCSP_DATES },
      ],
    });
    expect((await checkOcsp(leaf, [ca], [response]))[0]).toMatchObject({ status: 'good' });
    expect((await checkOcsp(other, [ca], [response]))[0]).toMatchObject({ status: 'revoked' });
  });

  it('does not let an entry with a foreign CertID speak for the certificate', async () => {
    const ca = await makeCa('CA');
    const stranger = await makeCa('Another CA');
    const leaf = await makeLeaf('Signer', ca);
    const other = await makeLeaf('Other', ca);
    const cases: ReadonlyArray<
      readonly [string, Parameters<typeof issueOcspResponse>[0]['singles'][number]]
    > = [
      [
        "a serial that is not the certificate's",
        { cert: leaf, idSerialOf: other, status: 'good', ...OCSP_DATES },
      ],
      [
        'an issuer name hash of another CA',
        { cert: leaf, idNameOf: stranger, status: 'good', ...OCSP_DATES },
      ],
      ['an issuer key hash of another CA', { cert: leaf, idIssuer: stranger, status: 'good', ...OCSP_DATES }],
      [
        'a hash algorithm this build does not know',
        { cert: leaf, hashOid: '1.2.840.113549.2.5', status: 'good', ...OCSP_DATES },
      ],
    ];
    for (const [label, single] of cases) {
      const response = await issueOcspResponse({ issuer: ca, producedAt: PRODUCED, singles: [single] });
      expect((await checkOcsp(leaf, [ca], [response]))[0], label).toMatchObject({
        status: 'unknown',
        unknownReason: 'no-list',
      });
    }
  });

  it('rejects a response whose signature is not by the issuer, so it can neither clear nor accuse', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const forger = await generateKey({ kind: 'EC', curve: 'P-256' });
    const forgedClean = await issueOcspResponse({
      issuer: ca,
      signWith: forger.privateKey,
      producedAt: PRODUCED,
      singles: [{ cert: leaf, status: 'good', ...OCSP_DATES }],
    });
    const forgedRevoked = await issueOcspResponse({
      issuer: ca,
      signWith: forger.privateKey,
      producedAt: PRODUCED,
      singles: [{ cert: leaf, status: 'revoked', revokedAt: day(2, 1), ...OCSP_DATES }],
    });
    const real = await issueOcspResponse({
      issuer: ca,
      producedAt: PRODUCED,
      singles: [{ cert: leaf, status: 'revoked', revokedAt: day(2, 1), reason: 1, ...OCSP_DATES }],
    });
    for (const forged of [forgedClean, forgedRevoked]) {
      expect((await checkOcsp(leaf, [ca], [forged]))[0]).toMatchObject({
        status: 'unknown',
        unknownReason: 'invalid-list',
      });
    }
    // The forged clean answer next to a real revocation hides nothing.
    expect((await checkOcsp(leaf, [ca], [forgedClean, real]))[0]).toMatchObject({
      status: 'revoked',
      reason: 'keyCompromise',
    });
  });

  it('accepts a delegated responder the CA certified for OCSP signing, and only that one', async () => {
    const ca = await makeCa('CA');
    const other = await makeCa('Other CA');
    const leaf = await makeLeaf('Signer', ca);
    const singles = [{ cert: leaf, status: 'good' as const, ...OCSP_DATES }];
    const answer = async (responder: CertificateFixture, carried: readonly CertificateFixture[]) =>
      (
        await checkOcsp(
          leaf,
          [ca],
          [await issueOcspResponse({ issuer: ca, responder, certs: carried, producedAt: PRODUCED, singles })],
        )
      )[0];

    const delegate = await makeResponder(ca);
    expect(await answer(delegate, [delegate])).toMatchObject({ status: 'good', source: 'ocsp' });

    const failures: ReadonlyArray<readonly [string, CertificateFixture]> = [
      ['a responder with no extKeyUsage', await makeResponder(ca, { purposes: null })],
      [
        'a responder certified for another purpose',
        await makeResponder(ca, { purposes: [KP_TIME_STAMPING] }),
      ],
      [
        'a responder that expired before the response was produced',
        await makeResponder(ca, { notAfter: day(4, 1) }),
      ],
      ['a responder issued by another CA with the same key purpose', await makeResponder(other)],
    ];
    for (const [label, responder] of failures) {
      expect(await answer(responder, [responder]), label).toMatchObject({
        status: 'unknown',
        unknownReason: 'invalid-list',
      });
    }
    // A responder that carries a certificate which is not actually signed by the CA.
    const impostor = await makeCa('CA');
    const lookalike = await makeResponder(impostor);
    expect(await answer(lookalike, [lookalike])).toMatchObject({
      status: 'unknown',
      unknownReason: 'invalid-list',
    });
    // A good delegate does not help a response it did not sign.
    const wrongKey = await issueOcspResponse({
      issuer: ca,
      signWith: (await generateKey({ kind: 'EC', curve: 'P-256' })).privateKey,
      certs: [delegate],
      producedAt: PRODUCED,
      singles,
    });
    expect((await checkOcsp(leaf, [ca], [wrongKey]))[0]).toMatchObject({ unknownReason: 'invalid-list' });
  });

  it('decides between OCSP and CRL evidence: a lasting revocation wins, otherwise the newest statement', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const ocspGood = await issueOcspResponse({
      issuer: ca,
      producedAt: day(5, 20),
      singles: [{ cert: leaf, status: 'good', thisUpdate: day(5, 20), nextUpdate: day(8, 1) }],
    });
    const crlRevoked = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      revoked: [{ cert: leaf, at: day(2, 1), reason: CRL_REASON.keyCompromise }],
    });
    expect((await checkOcsp(leaf, [ca], [ocspGood], [crlRevoked]))[0]).toMatchObject({
      status: 'revoked',
      source: 'crl',
      reason: 'keyCompromise',
    });

    const crlClean = await issueCrl({ issuer: ca, ...CRL_DATES });
    expect((await checkOcsp(leaf, [ca], [ocspGood], [crlClean]))[0]).toMatchObject({
      status: 'good',
      source: 'ocsp',
      thisUpdate: day(5, 20).toISOString(),
    });

    // A hold is not lasting: the newer clean statement outranks it.
    const onHold = await issueOcspResponse({
      issuer: ca,
      producedAt: PRODUCED,
      singles: [
        {
          cert: leaf,
          status: 'revoked',
          revokedAt: day(2, 1),
          reason: CRL_REASON.certificateHold,
          ...OCSP_DATES,
        },
      ],
    });
    expect((await checkOcsp(leaf, [ca], [onHold, ocspGood]))[0]).toMatchObject({
      status: 'good',
      thisUpdate: day(5, 20).toISOString(),
    });
    // Two lasting revocations: the earliest date is the decisive one.
    const second = await issueOcspResponse({
      issuer: ca,
      producedAt: PRODUCED,
      singles: [{ cert: leaf, status: 'revoked', revokedAt: day(2, 10), reason: 4, ...OCSP_DATES }],
    });
    expect((await checkOcsp(leaf, [ca], [second], [crlRevoked]))[0]).toMatchObject({
      status: 'revoked',
      source: 'crl',
      revokedAt: day(2, 1).toISOString(),
    });
    const first = await issueOcspResponse({
      issuer: ca,
      producedAt: PRODUCED,
      singles: [{ cert: leaf, status: 'revoked', revokedAt: day(1, 20), reason: 4, ...OCSP_DATES }],
    });
    expect((await checkOcsp(leaf, [ca], [first], [crlRevoked]))[0]).toMatchObject({
      status: 'revoked',
      source: 'ocsp',
      revokedAt: day(1, 20).toISOString(),
    });
  });
});

describe('reading an OCSP response', () => {
  it('reads a successful basic response and nothing else', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const singles = [{ cert: leaf, status: 'good' as const, ...OCSP_DATES }];
    const good = await issueOcspResponse({ issuer: ca, producedAt: PRODUCED, singles });
    const parsed = parseOcsp(good, 'imported');
    expect(parsed?.origin).toBe('imported');
    expect(parsed?.basic.tbsResponseData.producedAt).toEqual(PRODUCED);

    // `tryLater` (3) has no response bytes; another response type is not a basic response.
    expect(
      parseOcsp(
        await issueOcspResponse({ issuer: ca, producedAt: PRODUCED, singles, responseStatus: 3 }),
        'embedded',
      ),
    ).toBeNull();
    expect(
      parseOcsp(
        await issueOcspResponse({
          issuer: ca,
          producedAt: PRODUCED,
          singles,
          responseType: '1.3.6.1.5.5.7.48.1.2',
        }),
        'embedded',
      ),
    ).toBeNull();
    expect(parseOcsp(new Uint8Array([1, 2, 3]), 'embedded')).toBeNull();
    expect(parseOcsp(ca.der, 'embedded')).toBeNull();
    // Unparseable responses never reach the sources.
    const sources = parseRevocationSources({ embeddedOcsps: [good, new Uint8Array([9]), ca.der] });
    expect(sources.ocsps.map((entry) => entry.origin)).toEqual(['embedded']);
  });
});

const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_REASON_CODE = '2.5.29.21';

/** A distinguished name made of one attribute, to test names the helpers above never write. */
function nameWith(type: string, value: Utf8String): RelativeDistinguishedNames {
  return new RelativeDistinguishedNames({ typesAndValues: [new AttributeTypeAndValue({ type, value })] });
}

describe('CRL entries and the serial numbers they name', () => {
  it('matches a serial however many leading zero octets either side wrote', async () => {
    const ca = await makeCa('CA');
    const padded = await issueCertificate(
      {
        subject: 'Padded serial',
        keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
        ...VALID,
        serial: new Uint8Array([0x00, 0x00, 0x05]),
      },
      ca,
    );
    const plain = await issueCertificate(
      {
        subject: 'Plain serial',
        keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
        ...VALID,
        serial: new Uint8Array([0x00, 0x81, 0x02]),
      },
      ca,
    );
    const crl = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      revoked: [
        { cert: padded, serial: new Uint8Array([0x05]), at: day(2, 1) },
        { cert: plain, serial: new Uint8Array([0x00, 0x00, 0x00, 0x81, 0x02]), at: day(2, 2) },
      ],
    });
    expect((await check(padded, [ca], [crl]))[0]).toMatchObject({
      status: 'revoked',
      revokedAt: day(2, 1).toISOString(),
    });
    expect((await check(plain, [ca], [crl]))[0]).toMatchObject({
      status: 'revoked',
      revokedAt: day(2, 2).toISOString(),
    });
  });

  it('reads the reason code, and ignores other entry extensions and reason values that are not a code', async () => {
    const ca = await makeCa('CA');
    const leaves = {
      other: await makeLeaf('Other extension', ca),
      garbage: await makeLeaf('Garbage reason', ca),
      notInteger: await makeLeaf('Reason not an integer', ca),
      unassigned: await makeLeaf('Unassigned reason', ca),
    };
    const reasonCrl = (
      cert: CertificateFixture,
      entryExtensions: Parameters<typeof issueCrl>[0]['entryExtensions'],
    ) =>
      issueCrl({
        issuer: ca,
        ...CRL_DATES,
        revoked: [{ cert, at: day(2, 1) }],
        ...(entryExtensions === undefined ? {} : { entryExtensions }),
      });
    // invalidityDate (2.5.29.24) is not the reason code.
    const other = await reasonCrl(leaves.other, [
      rawExtension('2.5.29.24', false, new GeneralizedTime({ valueDate: day(1, 15) }).toBER(false)),
    ]);
    // Bytes that are not DER, and a SEQUENCE where an ENUMERATED belongs.
    const garbage = await reasonCrl(leaves.garbage, [
      rawExtension(OID_REASON_CODE, false, new Uint8Array([0x30, 0x05, 0x01]).buffer as ArrayBuffer),
    ]);
    const notInteger = await reasonCrl(leaves.notInteger, [
      rawExtension(OID_REASON_CODE, false, new Sequence().toBER(false)),
    ]);
    const unassigned = await reasonCrl(leaves.unassigned, [
      rawExtension(OID_REASON_CODE, false, new Enumerated({ value: 7 }).toBER(false)),
    ]);
    for (const [label, leaf, crl] of [
      ['another extension', leaves.other, other],
      ['garbage', leaves.garbage, garbage],
      ['not an integer', leaves.notInteger, notInteger],
      ['an unassigned code', leaves.unassigned, unassigned],
    ] as const) {
      expect((await check(leaf, [ca], [crl]))[0], label).toMatchObject({
        status: 'revoked',
        reason: null,
        timing: 'before-signing',
      });
    }
  });
});

describe('CRL scope and structure', () => {
  it('answers list-scope for lists limited to other kinds of certificates, never good', async () => {
    const root = await makeCa('Root');
    const intermediate = await makeCa('Intermediate', root);
    const leaf = await makeLeaf('Signer', intermediate);
    const userOnlyByRoot = await issueCrl({
      issuer: root,
      ...CRL_DATES,
      extensions: [scopeExtension({ onlyUserCerts: true })],
    });
    const caOnlyByIntermediate = await issueCrl({
      issuer: intermediate,
      ...CRL_DATES,
      extensions: [scopeExtension({ onlyCaCerts: true })],
    });
    const [signer, middle] = await check(leaf, [intermediate, root], [userOnlyByRoot, caOnlyByIntermediate]);
    expect(signer).toMatchObject({ status: 'unknown', unknownReason: 'list-scope' });
    expect(middle).toMatchObject({ status: 'unknown', unknownReason: 'list-scope' });

    const attributeOnly = await issueCrl({
      issuer: intermediate,
      ...CRL_DATES,
      extensions: [scopeExtension({ onlyAttributeCerts: true })],
    });
    expect((await check(leaf, [intermediate, root], [attributeOnly]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'list-scope',
    });

    // The matching kind still clears: a user-only list for a user certificate.
    const userOnly = await issueCrl({
      issuer: intermediate,
      ...CRL_DATES,
      extensions: [scopeExtension({ onlyUserCerts: true })],
    });
    expect((await check(leaf, [intermediate, root], [userOnly]))[0]).toMatchObject({ status: 'good' });
    const caOnly = await issueCrl({
      issuer: root,
      ...CRL_DATES,
      extensions: [scopeExtension({ onlyCaCerts: true })],
    });
    expect((await check(leaf, [intermediate, root], [caOnly]))[1]).toMatchObject({
      subject: 'Intermediate',
      status: 'good',
    });
  });

  it('uses a partitioned list only for a certificate that names that partition', async () => {
    const ca = await makeCa('CA');
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const leaf = await issueCertificate(
      {
        subject: 'Signer',
        keyPair,
        ...VALID,
        extraExtensions: [
          crlDistributionPointsExtension(['http://example.test/a.crl', 'http://example.test/b.crl']),
        ],
      },
      ca,
    );
    const partition = (uri: string) =>
      issueCrl({
        issuer: ca,
        ...CRL_DATES,
        revoked: [{ cert: leaf, at: day(2, 1) }],
        extensions: [scopeExtension({ distributionPointUri: uri })],
      });
    expect((await check(leaf, [ca], [await partition('http://example.test/b.crl')]))[0]).toMatchObject({
      status: 'revoked',
    });
    expect((await check(leaf, [ca], [await partition('http://example.test/c.crl')]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'list-scope',
    });
    // A partition that is a DNS name or a relative name is no URI, so no certificate matches it.
    for (const scope of [
      { distributionPointDns: 'crl.example.test' },
      { distributionPointRelativeName: 'Partition 1' },
    ]) {
      const crl = await issueCrl({ issuer: ca, ...CRL_DATES, extensions: [scopeExtension(scope)] });
      expect((await check(leaf, [ca], [crl]))[0], JSON.stringify(scope)).toMatchObject({
        status: 'unknown',
        unknownReason: 'list-scope',
      });
    }
    // A certificate that names no partition at all matches no partitioned list either.
    const bare = await makeLeaf('Bare', ca);
    expect((await check(bare, [ca], [await partition('http://example.test/a.crl')]))[0]).toMatchObject({
      unknownReason: 'list-scope',
    });
  });

  it('refuses a list with a critical extension it does not know and one whose scope extension is malformed', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    for (const extensions of [[unknownCriticalExtension()], [scopeExtension({ malformed: true })]]) {
      const crl = await issueCrl({
        issuer: ca,
        ...CRL_DATES,
        revoked: [{ cert: leaf, at: day(2, 1) }],
        extensions,
      });
      // Not "revoked" and certainly not "good": the list cannot be processed at all.
      expect((await check(leaf, [ca], [crl]))[0]).toMatchObject({
        status: 'unknown',
        unknownReason: 'unsupported-list',
      });
    }
  });

  it('refuses a list signed with an algorithm it does not implement, and one by an issuer not valid when it was issued', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const ed25519 = await issueCrl({ issuer: ca, ...CRL_DATES, signatureAlgorithmOid: '1.3.101.112' });
    expect((await check(leaf, [ca], [ed25519]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'unsupported-list',
    });

    const shortLived = await issueCertificate({
      subject: 'Short-lived CA',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      notBefore: VALID.notBefore,
      notAfter: day(4, 1),
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign', 'cRLSign'],
    });
    const child = await makeLeaf('Child', shortLived);
    const late = await issueCrl({ issuer: shortLived, ...CRL_DATES }); // issued 1 May, CA ended 1 April
    expect((await check(child, [shortLived], [late]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'invalid-list',
    });
  });

  it("judges the issuer's keyUsage only when it has one, and a keyUsage it cannot read as missing cRLSign", async () => {
    const issuerWith = async (extraExtensions?: ReturnType<typeof rawExtension>[]) => {
      const ca = await issueCertificate({
        subject: 'CA',
        keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
        ...VALID,
        basicConstraints: { cA: true },
        ...(extraExtensions === undefined ? {} : { extraExtensions }),
      });
      const leaf = await makeLeaf('Signer', ca);
      return { ca, leaf, crl: await issueCrl({ issuer: ca, ...CRL_DATES }) };
    };
    const none = await issuerWith();
    expect((await check(none.leaf, [none.ca], [none.crl]))[0]).toMatchObject({ status: 'good' });

    const unreadable: ReadonlyArray<readonly [string, ArrayBuffer]> = [
      ['not DER', new Uint8Array([0x03, 0x09]).buffer as ArrayBuffer],
      ['an empty bit string', new BitString({ valueHex: new ArrayBuffer(0) }).toBER(false)],
      ['a SEQUENCE', new Sequence().toBER(false)],
    ];
    for (const [label, inner] of unreadable) {
      const broken = await issuerWith([rawExtension(OID_KEY_USAGE, true, inner)]);
      expect((await check(broken.leaf, [broken.ca], [broken.crl]))[0], label).toMatchObject({
        status: 'unknown',
        unknownReason: 'invalid-list',
      });
    }
  });

  it('reports the first limit when lists fail in different ways, but an invalid list outranks it', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const indirect = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      extensions: [scopeExtension({ indirect: true })],
    });
    const delta = await issueCrl({ issuer: ca, ...CRL_DATES, extensions: [deltaIndicatorExtension()] });
    const forged = await issueCrl({ issuer: ca, signedBy: await makeCa('Stranger'), ...CRL_DATES });
    expect((await check(leaf, [ca], [indirect, delta]))[0]).toMatchObject({
      unknownReason: 'unsupported-list',
    });
    expect((await check(leaf, [ca], [delta, indirect]))[0]).toMatchObject({ unknownReason: 'list-scope' });
    expect((await check(leaf, [ca], [indirect, forged]))[0]).toMatchObject({ unknownReason: 'invalid-list' });
    expect((await check(leaf, [ca], [forged, indirect]))[0]).toMatchObject({ unknownReason: 'invalid-list' });
  });

  it('describes lists without a next update or a readable issuer name', async () => {
    const ca = await makeCa('CA');
    const noNext = await issueCrl({ issuer: ca, thisUpdate: CRL_DATES.thisUpdate });
    expect(describeCrl(noNext)).toEqual({
      issuer: 'CA',
      thisUpdate: CRL_DATES.thisUpdate.toISOString(),
      nextUpdate: null,
      revokedCount: 0,
      delta: false,
    });
    // Organisation only, and a "common name" that is not text: neither gives a name to show.
    const org = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      issuerName: nameWith('2.5.4.10', new Utf8String({ value: 'Org' })),
    });
    expect(describeCrl(org)?.issuer).toBeNull();
    const numeric = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      issuerName: nameWith('2.5.4.3', new Integer({ value: 4 }) as unknown as Utf8String),
    });
    expect(describeCrl(numeric)?.issuer).toBeNull();
    expect(parseCrl(noNext, 'imported')?.nextUpdate).toBeNull();
  });
});

describe('the certificate chain behind a check', () => {
  it('names a certificate with no common name with a dash', async () => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const ca = await issueCertificate({
      subject: 'ignored',
      subjectName: nameWith('2.5.4.10', new Utf8String({ value: 'Org only' })),
      keyPair,
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign', 'cRLSign'],
    });
    const leaf = await issueCertificate(
      {
        subject: 'ignored',
        subjectName: nameWith('2.5.4.10', new Utf8String({ value: 'Leaf org' })),
        keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
        ...VALID,
      },
      ca,
    );
    expect((await check(leaf, [ca], [await issueCrl({ issuer: ca, ...CRL_DATES })]))[0]).toMatchObject({
      subject: '—',
      status: 'good',
    });
  });

  it('builds the chain by signatures: a pool certificate with the right name and the wrong key is passed over', async () => {
    const ca = await makeCa('CA');
    const impostor = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const crl = await issueCrl({ issuer: ca, ...CRL_DATES });
    expect((await check(leaf, [impostor, ca], [crl]))[0]).toMatchObject({ status: 'good' });
  });

  it('yields nothing for a leaf that is not a certificate, skips pool entries that are not, and needs WebCrypto', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const crl = await issueCrl({ issuer: ca, ...CRL_DATES });
    const input = (leafDer: Uint8Array, pool: readonly Uint8Array[]) => ({
      leaf: leafDer,
      leafRole: 'signer' as const,
      pool,
      context: { sources: parseRevocationSources({ imported: [crl] }), validationTime: SIGNED_AT, now: NOW },
    });
    expect(await checkRevocation(input(new Uint8Array([1, 2, 3]), [ca.der]))).toEqual([]);
    const [answer] = await checkRevocation(input(leaf.der, [new Uint8Array([7, 7]), ca.der]));
    expect(answer).toMatchObject({ status: 'good' });

    vi.stubGlobal('crypto', {});
    try {
      expect(await checkRevocation(input(leaf.der, [ca.der]))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('extendedKeyUsage', () => {
  it('lists the purposes, and reads a value that is not a list of OIDs as no purposes', async () => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const issue = async (inner?: ArrayBuffer) =>
      (
        await issueCertificate({
          subject: 'EKU',
          keyPair,
          ...VALID,
          ...(inner === undefined
            ? {}
            : { extraExtensions: [rawExtension(OID_EXT_KEY_USAGE, false, inner)] }),
        })
      ).parsed;
    expect(extendedKeyUsage(await issue())).toBeNull();
    expect(
      extendedKeyUsage(
        await issue(
          new Sequence({
            value: [
              new ObjectIdentifier({ value: KP_OCSP_SIGNING }),
              new Integer({ value: 1 }),
              new ObjectIdentifier({ value: KP_TIME_STAMPING }),
            ],
          }).toBER(false),
        ),
      ),
    ).toEqual([KP_OCSP_SIGNING, KP_TIME_STAMPING]);
    expect(extendedKeyUsage(await issue(new Uint8Array([0x30, 0x09, 0x06]).buffer as ArrayBuffer))).toEqual(
      [],
    );
    expect(extendedKeyUsage(await issue(new Integer({ value: 3 }).toBER(false)))).toEqual([]);
  });
});

describe('DER that asn1js throws on, inside certificates and lists', () => {
  /** A GeneralizedTime that is not a date: asn1js throws on it instead of reporting an offset. */
  const HOSTILE = new Uint8Array([0x18, 0x06, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46]).buffer as ArrayBuffer;
  const OID_BASIC_CONSTRAINTS = '2.5.29.19';
  const OID_ISSUING_DISTRIBUTION_POINT = '2.5.29.28';
  const OID_CRL_DISTRIBUTION_POINTS = '2.5.29.31';

  async function leafWith(
    ca: CertificateFixture,
    extraExtensions: ReturnType<typeof rawExtension>[],
  ): Promise<CertificateFixture> {
    return await issueCertificate(
      {
        subject: 'Hostile Signer',
        keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
        ...VALID,
        extraExtensions,
      },
      ca,
    );
  }

  it('reads a reason code it cannot decode as no reason, and the entry as still revoked', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const crl = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      revoked: [{ cert: leaf, at: day(2, 1) }],
      entryExtensions: [rawExtension(OID_REASON_CODE, false, HOSTILE)],
    });
    expect((await check(leaf, [ca], [crl]))[0]).toMatchObject({ status: 'revoked', reason: null });
  });

  it('refuses a list from an issuer whose keyUsage it cannot decode', async () => {
    const ca = await issueCertificate({
      subject: 'CA',
      keyPair: await generateKey({ kind: 'EC', curve: 'P-256' }),
      ...VALID,
      basicConstraints: { cA: true },
      extraExtensions: [rawExtension(OID_KEY_USAGE, true, HOSTILE)],
    });
    const leaf = await makeLeaf('Signer', ca);
    const crl = await issueCrl({ issuer: ca, ...CRL_DATES });
    expect((await check(leaf, [ca], [crl]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'invalid-list',
    });
  });

  it('reads an extKeyUsage it cannot decode as no purposes', async () => {
    const ca = await makeCa('CA');
    const leaf = await leafWith(ca, [rawExtension(OID_EXT_KEY_USAGE, false, HOSTILE)]);
    expect(extendedKeyUsage(leaf.parsed)).toEqual([]);
  });

  it('refuses a list whose issuingDistributionPoint it cannot decode, and never reads it as unscoped', async () => {
    const ca = await makeCa('CA');
    const leaf = await makeLeaf('Signer', ca);
    const crl = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      extensions: [rawExtension(OID_ISSUING_DISTRIBUTION_POINT, true, HOSTILE)],
    });
    expect((await check(leaf, [ca], [crl]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'unsupported-list',
    });
  });

  it('takes a certificate whose basicConstraints it cannot decode for a non-CA when a list is scoped to users', async () => {
    const ca = await makeCa('CA');
    const leaf = await leafWith(ca, [rawExtension(OID_BASIC_CONSTRAINTS, true, HOSTILE)]);
    const userList = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      revoked: [{ cert: leaf, at: day(2, 1) }],
      extensions: [scopeExtension({ onlyUserCerts: true })],
    });
    const caList = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      revoked: [{ cert: leaf, at: day(2, 1) }],
      extensions: [scopeExtension({ onlyCaCerts: true })],
    });
    expect((await check(leaf, [ca], [userList]))[0]).toMatchObject({ status: 'revoked' });
    expect((await check(leaf, [ca], [caList]))[0]).toMatchObject({ status: 'unknown' });
  });

  it('matches a partitioned list to no certificate whose cRLDistributionPoints it cannot decode', async () => {
    const ca = await makeCa('CA');
    const leaf = await leafWith(ca, [rawExtension(OID_CRL_DISTRIBUTION_POINTS, false, HOSTILE)]);
    const crl = await issueCrl({
      issuer: ca,
      ...CRL_DATES,
      revoked: [{ cert: leaf, at: day(2, 1) }],
      extensions: [scopeExtension({ distributionPointUri: 'http://example.test/a.crl' })],
    });
    expect((await check(leaf, [ca], [crl]))[0]).toMatchObject({
      status: 'unknown',
      unknownReason: 'list-scope',
    });
  });
});
