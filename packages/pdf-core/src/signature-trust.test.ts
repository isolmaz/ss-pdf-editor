/**
 * `signature-trust.ts` against real cryptography.
 *
 * Nothing here is mocked. Every certificate is generated with WebCrypto and encoded by
 * `signature-trust.fixtures.ts`, every chain is a real chain, and every claim about the
 * encoding is checked a second time by **OpenSSL** through Node's
 * `X509Certificate.verify()` — a different implementation from the `SubtleCrypto.verify`
 * the product code calls. A test that only asked the repository's own verifier would pass
 * for a wrong conversion that the same conversion produced.
 *
 * The first block is the reproduced defect: a DER `ECDSA-Sig-Value` handed straight to
 * `SubtleCrypto.verify` is not the fixed-width pair that API takes, so a valid P-256
 * certificate chain came back `untrusted`.
 */

import { createPublicKey, X509Certificate } from 'node:crypto';
import { fromBER, OctetString, Utf8String } from 'asn1js';
import {
  AttributeTypeAndValue,
  CertificateChainValidationEngine,
  type Extension,
  Certificate as PkijsCertificate,
  RelativeDistinguishedNames,
} from 'pkijs';
import { describe, expect, it, vi } from 'vitest';
import {
  certificateName,
  checkTrust,
  ecdsaDerToRaw,
  NO_TRUST,
  parseAsn1,
  type TrustCheck,
  validityOf,
  verifyDataSignature,
} from './signature-trust';
import type { CertificateFixture, GeneralNameSpec, IssueOptions } from './signature-trust.fixtures';
import {
  authorityKeyIdentifierExtension,
  commonNames,
  derIntegers,
  ecdsaRawToDer,
  fakeSpki,
  generateKey,
  issueCertificate,
  parse,
  rawExtension,
  subjectKeyIdentifierExtension,
  unknownCriticalExtension,
} from './signature-trust.fixtures';

const NOW = new Date(Date.UTC(2026, 5, 1));
const VALID = { notBefore: new Date(Date.UTC(2026, 0, 1)), notAfter: new Date(Date.UTC(2027, 0, 1)) };

/** A CA that can issue, with both extensions a path validator looks for. */
async function makeCa(
  subject: string,
  curve: 'P-256' | 'P-384' | 'P-521' = 'P-256',
): Promise<CertificateFixture> {
  const keyPair = await generateKey({ kind: 'EC', curve });
  return await issueCertificate({
    subject,
    keyPair,
    ...VALID,
    basicConstraints: { cA: true },
    keyUsage: ['keyCertSign', 'cRLSign'],
  });
}

/** A leaf, signed by `ca` unless an explicit issuer is given. */
async function makeLeaf(
  subject: string,
  ca: CertificateFixture,
  extra: Partial<IssueOptions> = {},
): Promise<CertificateFixture> {
  const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
  return await issueCertificate(
    {
      subject,
      keyPair,
      ...VALID,
      basicConstraints: { cA: false },
      keyUsage: ['digitalSignature'],
      ...extra,
    },
    ca,
  );
}

/** The independent verifier: OpenSSL, through Node, over the same DER bytes. */
function opensslSaysSigned(child: CertificateFixture, issuer: CertificateFixture): boolean {
  const certificate = new X509Certificate(Buffer.from(child.der));
  return certificate.verify(
    createPublicKey({
      key: Buffer.from(issuer.parsed.subjectPublicKeyInfo.toSchema().toBER(false)),
      format: 'der',
      type: 'spki',
    }),
  );
}

describe('ECDSA certificate signature encoding', () => {
  it.each(['P-256', 'P-384', 'P-521'] as const)(
    'validates a real %s chain, and OpenSSL agrees with the bytes',
    async (curve) => {
      const ca = await makeCa(`${curve} Test Root`, curve);
      const leaf = await makeLeaf(`${curve} Test Leaf`, ca);

      // Independent first: if OpenSSL does not accept the fixture, the rest proves nothing.
      expect(opensslSaysSigned(leaf, ca)).toBe(true);
      expect(opensslSaysSigned(ca, ca)).toBe(true);

      const verdict = await checkTrust({ signer: leaf.der, roots: [ca.der], now: NOW });
      expect(verdict).toMatchObject({ verdict: 'trusted', reason: null });
      expect(verdict.path).toEqual([`${curve} Test Leaf`, `${curve} Test Root`]);
    },
  );

  it('converts a DER pair to the fixed-width representation WebCrypto verifies', () => {
    // Neither integer has its high bit set, so the DER encoding is shorter than the field
    // and the conversion has to left-pad — the case a naive `slice` gets wrong.
    const short = ecdsaRawToDer(
      Uint8Array.from([...new Array(31).fill(0), 0x01, ...new Array(31).fill(0), 0x02]),
    );
    expect(ecdsaDerToRaw(short, 32)).toEqual(
      Uint8Array.from([...new Array(31).fill(0), 0x01, ...new Array(31).fill(0), 0x02]),
    );

    // High bit set on both: DER adds a `0x00` sign pad that must not survive the round trip.
    const padded = Uint8Array.from([0x80, ...new Array(31).fill(0xa5), 0xff, ...new Array(31).fill(0x5a)]);
    const der = ecdsaRawToDer(padded);
    expect(derIntegers(der).r[0]).toBe(0x00);
    expect(ecdsaDerToRaw(der, 32)).toEqual(padded);
    expect(ecdsaDerToRaw(der, 32)?.length).toBe(64);

    // Every field width the three supported curves use.
    for (const [fieldBytes, curve] of [
      [32, 'P-256'],
      [48, 'P-384'],
      [66, 'P-521'],
    ] as const) {
      const raw = new Uint8Array(fieldBytes * 2);
      for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 7 + 3) & 0xff;
      expect(ecdsaDerToRaw(ecdsaRawToDer(raw), fieldBytes), curve).toEqual(raw);
    }
  });

  it('refuses malformed encodings instead of truncating them into a match', () => {
    const valid = ecdsaRawToDer(new Uint8Array(64).fill(0x11));

    // Wrong outer type: a `SET` where the signature is a `SEQUENCE`.
    expect(valid[0]).toBe(0x30);
    expect(ecdsaDerToRaw(Uint8Array.from([0x31, ...valid.subarray(1)]), 32)).toBeNull();
    // Truncated, and with a trailing byte that is not part of the signature.
    expect(ecdsaDerToRaw(valid.slice(0, valid.length - 1), 32)).toBeNull();
    expect(ecdsaDerToRaw(Uint8Array.from([...valid, 0x00]), 32)).toBeNull();
    // Not ASN.1 at all.
    expect(ecdsaDerToRaw(new Uint8Array([0xff, 0xff, 0xff]), 32)).toBeNull();
    expect(ecdsaDerToRaw(new Uint8Array(0), 32)).toBeNull();
    // One integer, and three.
    expect(ecdsaDerToRaw(ecdsaRawToDer(new Uint8Array(64).fill(1)).subarray(2, 6), 32)).toBeNull();
    expect(
      ecdsaDerToRaw(Uint8Array.from([0x30, 0x09, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0x02, 0x01, 0x03]), 32),
    ).toBeNull();
    // A negative integer: `r` and `s` are magnitudes, so a top bit without the sign pad is
    // not a value — a validator that accepted it would be reading a different number.
    expect(ecdsaDerToRaw(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x82]), 32)).toBeNull();
    // An integer wider than the curve's field cannot be one of the pair's halves.
    const tooWide = Uint8Array.from([
      0x30,
      0x27,
      0x02,
      0x22,
      0x00,
      ...new Array(33).fill(0x01),
      0x02,
      0x01,
      0x01,
    ]);
    expect(ecdsaDerToRaw(tooWide, 32)).toBeNull();
  });

  it('reports a real signature under the wrong key as a definite failure', async () => {
    const ca = await makeCa('Mismatch Root');
    // Same subject name, different key: the leaf's issuer name matches the imported root, so
    // a chain is attempted and can only fail on the real signature check — not on “no
    // issuer”, and not as an indeterminate result.
    const impostor = await makeCa('Mismatch Root');
    const leaf = await makeLeaf('Mismatch Leaf', ca);
    expect(opensslSaysSigned(leaf, impostor)).toBe(false);
    const verdict = await checkTrust({ signer: leaf.der, roots: [impostor.der], now: NOW });
    expect(verdict).toMatchObject({ verdict: 'untrusted', reason: 'signature-mismatch' });

    // The unrelated name is a different fact: nobody in the pool names itself the issuer.
    const other = await makeCa('Unrelated Root');
    expect(await checkTrust({ signer: leaf.der, roots: [other.der], now: NOW })).toMatchObject({
      verdict: 'untrusted',
      reason: 'no-issuer',
    });
  });

  it('refuses a certificate signed with an algorithm it does not implement', async () => {
    const ca = await makeCa('Ed25519 Root');
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const leaf = await issueCertificate(
      {
        subject: 'Ed25519 Leaf',
        keyPair,
        ...VALID,
        basicConstraints: { cA: false },
        signature: { name: 'unsupported' },
      },
      ca,
    );
    const verdict = await checkTrust({ signer: leaf.der, roots: [ca.der], now: NOW });
    expect(verdict.verdict).toBe('indeterminate');
    expect(verdict.reason).toBe('unsupported-signature');
  });
});

describe('certificate path validation', () => {
  it('tries every issuer alternative, not just the first name match', async () => {
    const root = await makeCa('Alternatives Root');
    // Two certificates with the *same* subject name; only the second may issue.
    const decoyKeyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const decoy = await issueCertificate(
      {
        subject: 'Alternatives Intermediate',
        keyPair: decoyKeyPair,
        ...VALID,
        basicConstraints: { cA: false },
        keyUsage: ['digitalSignature'],
      },
      root,
    );
    const usableKeyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const usable = await issueCertificate(
      {
        subject: 'Alternatives Intermediate',
        keyPair: usableKeyPair,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign', 'cRLSign'],
      },
      root,
    );
    const leaf = await makeLeaf('Alternatives Leaf', usable);

    // The decoy is listed first and names itself the issuer, so a walk that stopped at the
    // first match would stop here.
    const verdict = await checkTrust({
      signer: leaf.der,
      chain: [decoy.der, usable.der],
      roots: [root.der],
      now: NOW,
    });
    expect(verdict).toMatchObject({ verdict: 'trusted', reason: null });
    expect(verdict.path).toEqual(['Alternatives Leaf', 'Alternatives Intermediate', 'Alternatives Root']);
  });

  it('enforces validity periods', async () => {
    const root = await makeCa('Validity Root');
    const expired = await makeLeaf('Expired Leaf', root, {
      notBefore: new Date(Date.UTC(2020, 0, 1)),
      notAfter: new Date(Date.UTC(2021, 0, 1)),
    });
    const expiredVerdict = await checkTrust({ signer: expired.der, roots: [root.der], now: NOW });
    expect(expiredVerdict).toMatchObject({ verdict: 'untrusted', reason: 'validity', validity: 'expired' });

    const future = await makeLeaf('Future Leaf', root, {
      notBefore: new Date(Date.UTC(2030, 0, 1)),
      notAfter: new Date(Date.UTC(2031, 0, 1)),
    });
    const futureVerdict = await checkTrust({ signer: future.der, roots: [root.der], now: NOW });
    expect(futureVerdict).toMatchObject({
      verdict: 'untrusted',
      reason: 'validity',
      validity: 'not-yet-valid',
      // The window is reported whole: a certificate not yet valid is shown with its first day.
      notBefore: '2030-01-01T00:00:00.000Z',
      notAfter: '2031-01-01T00:00:00.000Z',
    });
  });

  it('enforces the CA bit and the certificate-signing key usage', async () => {
    const root = await makeCa('Constraints Root');

    const notCaKeyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const notCa = await issueCertificate(
      { subject: 'Not A CA', keyPair: notCaKeyPair, ...VALID, basicConstraints: { cA: false } },
      root,
    );
    const leafUnderNotCa = await makeLeaf('Leaf Under Not A CA', notCa);
    expect(
      await checkTrust({ signer: leafUnderNotCa.der, chain: [notCa.der], roots: [root.der], now: NOW }),
    ).toMatchObject({ verdict: 'untrusted', reason: 'not-a-ca' });

    const noBasicKeyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const noBasic = await issueCertificate(
      { subject: 'No Basic Constraints', keyPair: noBasicKeyPair, ...VALID },
      root,
    );
    const leafUnderNoBasic = await makeLeaf('Leaf Under No Basic', noBasic);
    expect(
      await checkTrust({ signer: leafUnderNoBasic.der, chain: [noBasic.der], roots: [root.der], now: NOW }),
    ).toMatchObject({ verdict: 'untrusted', reason: 'not-a-ca' });

    const wrongUsageKeyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const wrongUsage = await issueCertificate(
      {
        subject: 'Wrong Usage Intermediate',
        keyPair: wrongUsageKeyPair,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['digitalSignature'],
      },
      root,
    );
    const leafUnderWrongUsage = await makeLeaf('Leaf Under Wrong Usage', wrongUsage);
    expect(
      await checkTrust({
        signer: leafUnderWrongUsage.der,
        chain: [wrongUsage.der],
        roots: [root.der],
        now: NOW,
      }),
    ).toMatchObject({ verdict: 'untrusted', reason: 'key-usage' });
  });

  it('enforces pathLenConstraint on the certificates it applies to', async () => {
    const root = await makeCa('Path Length Root');
    const shortKeyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const shortCa = await issueCertificate(
      {
        subject: 'Short Intermediate',
        keyPair: shortKeyPair,
        ...VALID,
        basicConstraints: { cA: true, pathLen: 0 },
        keyUsage: ['keyCertSign'],
      },
      root,
    );
    const middleKeyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const middle = await issueCertificate(
      {
        subject: 'Middle Intermediate',
        keyPair: middleKeyPair,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign'],
      },
      shortCa,
    );
    const leaf = await makeLeaf('Path Length Leaf', middle);

    // One intermediate below a CA that allows none: rejected, and the reason is named.
    expect(
      await checkTrust({ signer: leaf.der, chain: [middle.der, shortCa.der], roots: [root.der], now: NOW }),
    ).toMatchObject({ verdict: 'untrusted', reason: 'path-length' });

    // The same CA directly over a leaf is exactly what `pathLen: 0` permits.
    const directLeaf = await makeLeaf('Direct Leaf', shortCa);
    expect(
      await checkTrust({ signer: directLeaf.der, chain: [shortCa.der], roots: [root.der], now: NOW }),
    ).toMatchObject({ verdict: 'trusted', reason: null });
  });

  it('applies permitted and excluded name constraints to subordinates', async () => {
    const restrictedKeyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const restricted = await issueCertificate(
      {
        subject: 'Restricted Intermediate',
        keyPair: restrictedKeyPair,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign'],
        nameConstraints: {
          permitted: [{ kind: 'dns', value: 'example.com' }],
          excluded: [{ kind: 'dns', value: 'blocked.example.com' }],
        },
      },
      undefined,
    );

    const inside = await makeLeaf('Inside Leaf', restricted, {
      subjectAltNames: [{ kind: 'dns', value: 'a.host.example.com' }],
    });
    expect(await checkTrust({ signer: inside.der, roots: [restricted.der], now: NOW })).toMatchObject({
      verdict: 'trusted',
      reason: null,
    });

    const outside = await makeLeaf('Outside Leaf', restricted, {
      subjectAltNames: [{ kind: 'dns', value: 'a.host.example.org' }],
    });
    expect(await checkTrust({ signer: outside.der, roots: [restricted.der], now: NOW })).toMatchObject({
      verdict: 'untrusted',
      reason: 'name-constraint',
    });

    const excluded = await makeLeaf('Excluded Leaf', restricted, {
      subjectAltNames: [{ kind: 'dns', value: 'blocked.example.com' }],
    });
    expect(await checkTrust({ signer: excluded.der, roots: [restricted.der], now: NOW })).toMatchObject({
      verdict: 'untrusted',
      reason: 'name-constraint',
    });

    // `example.com` itself is the boundary: RFC 5280 §4.2.1.10 makes the constraint a
    // subtree of labels added to the *left*, so the bare name matches and `notexample.com`
    // does not.
    const bare = await makeLeaf('Bare Leaf', restricted, {
      subjectAltNames: [{ kind: 'dns', value: 'example.com' }],
    });
    expect(await checkTrust({ signer: bare.der, roots: [restricted.der], now: NOW })).toMatchObject({
      verdict: 'trusted',
    });
    const lookalike = await makeLeaf('Lookalike Leaf', restricted, {
      subjectAltNames: [{ kind: 'dns', value: 'notexample.com' }],
    });
    expect(await checkTrust({ signer: lookalike.der, roots: [restricted.der], now: NOW })).toMatchObject({
      verdict: 'untrusted',
      reason: 'name-constraint',
    });
  });

  it('refuses a critical extension it cannot process, instead of guessing', async () => {
    const root = await makeCa('Critical Root');
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const leaf = await issueCertificate(
      {
        subject: 'Critical Leaf',
        keyPair,
        ...VALID,
        basicConstraints: { cA: false },
        extraExtensions: [unknownCriticalExtension()],
      },
      root,
    );
    const verdict = await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW });
    expect(verdict.verdict).toBe('indeterminate');
    expect(verdict.reason).toBe('unsupported-critical-extension');
  });

  it('separates an imported anchor from an unknown issuer', async () => {
    const root = await makeCa('Anchor Root');
    const leaf = await makeLeaf('Anchor Leaf', root);

    // Nothing imported: the honest answer is that no check was performed.
    expect(await checkTrust({ signer: leaf.der, roots: [], now: NOW })).toMatchObject({
      verdict: 'not-checked',
      reason: 'no-roots',
    });

    // The user imported the signer's own certificate: that *is* the trust statement.
    expect(await checkTrust({ signer: root.der, roots: [root.der], now: NOW })).toMatchObject({
      verdict: 'trusted',
    });

    // A self-signed certificate the user has not named is not an unknown issuer; it is a
    // fact about the certificate, and a different sentence from "untrusted".
    const strangerCa = await makeCa('Stranger Root');
    const strangerLeaf = await makeLeaf('Stranger Leaf', strangerCa);
    expect(await checkTrust({ signer: strangerCa.der, roots: [root.der], now: NOW })).toMatchObject({
      verdict: 'self-signed',
    });
    expect(await checkTrust({ signer: strangerLeaf.der, roots: [root.der], now: NOW })).toMatchObject({
      verdict: 'untrusted',
      reason: 'no-issuer',
    });
  });

  it('keeps malformed input out of the verdicts it cannot support', async () => {
    const root = await makeCa('Malformed Root');
    expect(await checkTrust({ signer: new Uint8Array(0), roots: [root.der], now: NOW })).toMatchObject({
      verdict: 'not-checked',
    });
    const garbage = await checkTrust({ signer: new Uint8Array([1, 2, 3, 4]), roots: [root.der], now: NOW });
    expect(garbage).toMatchObject({ verdict: 'indeterminate', reason: 'malformed' });
    // A certificate that will not parse is skipped, not fatal: the chain still fails to
    // reach the anchor, and the walk says so instead of throwing.
    const leaf = await makeLeaf('Malformed Leaf', root);
    expect(
      await checkTrust({
        signer: leaf.der,
        chain: [new Uint8Array([0xff, 0x00])],
        roots: [root.der],
        now: NOW,
      }),
    ).toMatchObject({ verdict: 'trusted' });
  });

  it('agrees with pkijs chain validation on the same real chains', async () => {
    const root = await makeCa('Cross-check Root');
    const leaf = await makeLeaf('Cross-check Leaf', root);

    const engine = new CertificateChainValidationEngine({
      trustedCerts: [PkijsCertificate.fromBER(root.der.slice())],
      certs: [PkijsCertificate.fromBER(leaf.der.slice())],
      checkDate: NOW,
    });
    const independent = await engine.verify();
    expect(independent.result).toBe(true);

    const ours = await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW });
    expect(ours.verdict).toBe('trusted');

    // And on a chain pkijs must reject too: the leaf under an unrelated root.
    const other = await makeCa('Cross-check Other Root');
    const rejected = await new CertificateChainValidationEngine({
      trustedCerts: [PkijsCertificate.fromBER(other.der.slice())],
      certs: [PkijsCertificate.fromBER(leaf.der.slice())],
      checkDate: NOW,
    }).verify();
    expect(rejected.result).toBe(false);
    expect((await checkTrust({ signer: leaf.der, roots: [other.der], now: NOW })).verdict).not.toBe(
      'trusted',
    );
  });
});

const OID_KEY_USAGE = '2.5.29.15';
const OID_NAME_CONSTRAINTS = '2.5.29.30';

/** Bytes asn1js cannot decode at all (it throws rather than reporting an offset): a GeneralizedTime that is not a date. */
const HOSTILE_DER = Uint8Array.from([0x18, 0x06, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46]);

/** A self-signed CA carrying `nameConstraints`, and a leaf under it asserting `leaf`'s names. */
async function constrainedVerdict(
  constraints: NonNullable<IssueOptions['nameConstraints']>,
  leaf: Partial<IssueOptions> = {},
): Promise<TrustCheck> {
  const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
  const root = await issueCertificate({
    subject: 'Constrained Root',
    keyPair,
    ...VALID,
    basicConstraints: { cA: true },
    keyUsage: ['keyCertSign'],
    nameConstraints: constraints,
  });
  const signer = await makeLeaf('Constrained Leaf', root, leaf);
  return await checkTrust({ signer: signer.der, roots: [root.der], now: NOW });
}

type Expected = 'trusted' | 'name-constraint';

async function expectNames(
  constraints: NonNullable<IssueOptions['nameConstraints']>,
  leaf: Partial<IssueOptions>,
  expected: Expected,
): Promise<void> {
  const verdict = await constrainedVerdict(constraints, leaf);
  expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual(
    expected === 'trusted'
      ? { verdict: 'trusted', reason: null }
      : { verdict: 'untrusted', reason: 'name-constraint' },
  );
}

describe('DNS name constraints', () => {
  const dns = (value: string): GeneralNameSpec => ({ kind: 'dns', value });
  const alt = (value: string): Partial<IssueOptions> => ({ subjectAltNames: [dns(value)] });

  it.each<[string, string, string, Expected]>([
    ['an empty permitted constraint matches every name', 'permitted', '', 'trusted'],
    ['an empty excluded constraint excludes every name', 'excluded', '', 'name-constraint'],
  ])('%s', async (_name, group, constraint, expected) => {
    const constraints =
      group === 'permitted' ? { permitted: [dns(constraint)] } : { excluded: [dns(constraint)] };
    await expectNames(constraints, alt('a.example.com'), expected);
  });

  it.each<[string, string, string, Expected]>([
    ['the name itself', 'example.com', 'example.com', 'trusted'],
    ['a label added to the left', 'example.com', 'a.b.example.com', 'trusted'],
    ['a different case', 'Example.COM', 'A.example.com', 'trusted'],
    ['a trailing dot on the name', 'example.com', 'a.example.com.', 'trusted'],
    ['a trailing dot on the constraint', 'example.com.', 'a.example.com', 'trusted'],
    ['a name that only ends with the same letters', 'example.com', 'notexample.com', 'name-constraint'],
    ['another domain', 'example.com', 'example.org', 'name-constraint'],
    ['a leading-dot constraint and a subdomain', '.example.com', 'a.example.com', 'trusted'],
    ['a leading-dot constraint and the bare domain', '.example.com', 'example.com', 'trusted'],
    ['a leading-dot constraint and another domain', '.example.com', 'notexample.com', 'name-constraint'],
  ])('permits %s', async (_name, constraint, name, expected) => {
    await expectNames({ permitted: [dns(constraint)] }, alt(name), expected);
  });

  it('excludes a name inside an excluded subtree and keeps the rest', async () => {
    await expectNames(
      { excluded: [dns('blocked.example.com')] },
      alt('x.blocked.example.com'),
      'name-constraint',
    );
    await expectNames({ excluded: [dns('blocked.example.com')] }, alt('x.example.com'), 'trusted');
  });

  it('checks every subject alternative name, not just the first', async () => {
    await expectNames(
      { permitted: [dns('example.com')] },
      { subjectAltNames: [dns('a.example.com'), dns('evil.example.org')] },
      'name-constraint',
    );
  });

  it('lets any permitted subtree of the kind admit the name', async () => {
    await expectNames(
      { permitted: [dns('example.org'), dns('example.com')] },
      alt('a.example.com'),
      'trusted',
    );
  });
});

describe('mailbox and URI name constraints', () => {
  const email = (value: string): GeneralNameSpec => ({ kind: 'email', value });
  const uri = (value: string): GeneralNameSpec => ({ kind: 'uri', value });

  it.each<[string, string, string, Expected]>([
    ['the exact mailbox', 'alice@example.com', 'alice@example.com', 'trusted'],
    ['the exact mailbox in another case', 'Alice@Example.COM', 'alice@example.com', 'trusted'],
    ['another mailbox at the same host', 'alice@example.com', 'bob@example.com', 'name-constraint'],
    ['a mailbox at the host of a host constraint', 'example.com', 'bob@example.com', 'trusted'],
    ['a mailbox in a subdomain of a host constraint', 'example.com', 'bob@mail.example.com', 'trusted'],
    ['a mailbox at another host', 'example.com', 'bob@example.org', 'name-constraint'],
    ['a mailbox at a look-alike host', 'example.com', 'bob@notexample.com', 'name-constraint'],
    [
      'a leading-dot host constraint and a subdomain mailbox',
      '.example.com',
      'bob@mail.example.com',
      'trusted',
    ],
  ])('permits %s', async (_name, constraint, name, expected) => {
    await expectNames({ permitted: [email(constraint)] }, { subjectAltNames: [email(name)] }, expected);
  });

  it('excludes the mailboxes an excluded host constraint covers', async () => {
    await expectNames(
      { excluded: [email('example.com')] },
      { subjectAltNames: [email('bob@mail.example.com')] },
      'name-constraint',
    );
    await expectNames(
      { excluded: [email('example.com')] },
      { subjectAltNames: [email('bob@example.org')] },
      'trusted',
    );
  });

  it.each<[string, string, string, Expected]>([
    ['the host of the URI', 'example.com', 'https://example.com/path?q=1', 'trusted'],
    ['a subdomain host', 'example.com', 'https://www.Example.com:8443/x', 'trusted'],
    ['another host', 'example.com', 'https://example.org/', 'name-constraint'],
    ['a look-alike host', 'example.com', 'https://notexample.com/', 'name-constraint'],
    ['a URI with no host to compare', 'example.com', 'not a uri', 'name-constraint'],
    ['a leading-dot constraint', '.example.com', 'https://a.example.com/', 'trusted'],
  ])('permits %s', async (_name, constraint, name, expected) => {
    await expectNames({ permitted: [uri(constraint)] }, { subjectAltNames: [uri(name)] }, expected);
  });

  it('does not treat a URI with no host as excluded', async () => {
    await expectNames(
      { excluded: [uri('example.com')] },
      { subjectAltNames: [uri('https://a.example.com/')] },
      'name-constraint',
    );
    await expectNames({ excluded: [uri('example.com')] }, { subjectAltNames: [uri('not a uri')] }, 'trusted');
  });
});

describe('IP address name constraints', () => {
  const ip = (value: string): GeneralNameSpec => ({ kind: 'ip', value });
  const alt = (value: string): Partial<IssueOptions> => ({ subjectAltNames: [ip(value)] });

  it.each<[string, string, string, Expected]>([
    ['an address inside a /16', '192.168.0.0/255.255.0.0', '192.168.7.9', 'trusted'],
    ['an address outside a /16', '192.168.0.0/255.255.0.0', '192.169.7.9', 'name-constraint'],
    ['the lower half of a /25', '10.0.0.0/255.255.255.128', '10.0.0.5', 'trusted'],
    ['the upper half of a /25', '10.0.0.0/255.255.255.128', '10.0.0.200', 'name-constraint'],
    ['exactly one host under a /32', '10.1.2.3/255.255.255.255', '10.1.2.3', 'trusted'],
    ['a neighbour of a /32 host', '10.1.2.3/255.255.255.255', '10.1.2.4', 'name-constraint'],
    ['any address under a /0', '0.0.0.0/0.0.0.0', '203.0.113.9', 'trusted'],
    ['an address inside an IPv6 /32', '2001:db8::/ffff:ffff::', '2001:db8:1:2::5', 'trusted'],
    ['an address outside an IPv6 /32', '2001:db8::/ffff:ffff::', '2001:db9::1', 'name-constraint'],
    ['an IPv4 address against an IPv6 constraint', '2001:db8::/ffff:ffff::', '10.0.0.1', 'name-constraint'],
    ['an IPv6 address against an IPv4 constraint', '10.0.0.0/255.0.0.0', '2001:db8::1', 'name-constraint'],
  ])('permits %s', async (_name, constraint, name, expected) => {
    await expectNames({ permitted: [ip(constraint)] }, alt(name), expected);
  });

  it.each<[string, string, string, Expected]>([
    ['an address inside an excluded /8', '10.0.0.0/255.0.0.0', '10.1.2.3', 'name-constraint'],
    ['an address outside an excluded /8', '10.0.0.0/255.0.0.0', '11.1.2.3', 'trusted'],
    ['an address inside an excluded IPv6 /32', '2001:db8::/ffff:ffff::', '2001:db8::7', 'name-constraint'],
    ['an address outside an excluded IPv6 /32', '2001:db8::/ffff:ffff::', '2001:db9::7', 'trusted'],
    ['an IPv4 address next to an excluded IPv6 range', '::/::', '10.0.0.1', 'trusted'],
  ])('excludes %s', async (_name, constraint, name, expected) => {
    await expectNames({ excluded: [ip(constraint)] }, alt(name), expected);
  });

  it('checks every address of the certificate against the subtrees of its own kind', async () => {
    await expectNames(
      { permitted: [ip('10.0.0.0/255.0.0.0'), ip('2001:db8::/ffff:ffff::')] },
      { subjectAltNames: [ip('10.2.3.4'), ip('2001:db8::1')] },
      'trusted',
    );
    await expectNames(
      { permitted: [ip('10.0.0.0/255.0.0.0'), ip('2001:db8::/ffff:ffff::')] },
      { subjectAltNames: [ip('10.2.3.4'), ip('2001:db9::1')] },
      'name-constraint',
    );
  });
});

describe('directory name constraints', () => {
  const directory = (value: string): GeneralNameSpec => ({ kind: 'directory', value });
  const subject = (...names: string[]): Partial<IssueOptions> => ({ subjectName: commonNames(names) });

  it.each<[string, string, string[], Expected]>([
    ['a subject that is the constraint', 'Org', ['Org'], 'trusted'],
    ['a subject under the constraint', 'Org', ['Org', 'Unit', 'Leaf'], 'trusted'],
    ['a subject under a two-RDN constraint', 'Org/Unit', ['Org', 'Unit', 'Leaf'], 'trusted'],
    ['a subject with another first RDN', 'Org', ['Other', 'Leaf'], 'name-constraint'],
    ['a subject that differs below the prefix', 'Org/Unit', ['Org', 'Other', 'Leaf'], 'name-constraint'],
    ['a subject shorter than the constraint', 'Org/Unit/Deep', ['Org', 'Unit'], 'name-constraint'],
    ['an empty constraint', '', ['Anything'], 'trusted'],
  ])('permits %s', async (_name, constraint, names, expected) => {
    await expectNames({ permitted: [directory(constraint)] }, subject(...names), expected);
  });

  it.each<[string, string, string[], Expected]>([
    ['a subject under an excluded subtree', 'Org', ['Org', 'Leaf'], 'name-constraint'],
    ['a subject outside an excluded subtree', 'Org', ['Other', 'Leaf'], 'trusted'],
    ['an empty excluded constraint', '', ['Anything'], 'name-constraint'],
  ])('excludes %s', async (_name, constraint, names, expected) => {
    await expectNames({ excluded: [directory(constraint)] }, subject(...names), expected);
  });

  it('compares a subject alternative directory name too', async () => {
    await expectNames(
      { permitted: [directory('Org')] },
      { ...subject('Org', 'Leaf'), subjectAltNames: [directory('Elsewhere/Leaf')] },
      'name-constraint',
    );
  });
});

describe('name constraints across a path', () => {
  it('leaves a name of a kind the extension does not mention unconstrained', async () => {
    await expectNames(
      { permitted: [{ kind: 'dns', value: 'example.com' }] },
      { subjectAltNames: [{ kind: 'email', value: 'anyone@anywhere.test' }] },
      'trusted',
    );
  });

  it('cannot evaluate a name of a kind it does not compare, under a CA that constrains that kind', async () => {
    const registered: GeneralNameSpec = { kind: 'registeredId', value: '1.2.3.4' };
    for (const constraints of [{ permitted: [registered] }, { excluded: [registered] }]) {
      const verdict = await constrainedVerdict(constraints, { subjectAltNames: [registered] });
      expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual({
        verdict: 'indeterminate',
        reason: 'unsupported-critical-extension',
      });
    }
    // The same kind of name under constraints that do not name its kind is nothing to evaluate.
    await expectNames(
      { permitted: [{ kind: 'dns', value: 'example.com' }] },
      { subjectAltNames: [registered] },
      'trusted',
    );
  });

  it('applies a root’s constraints to every certificate between it and the signer', async () => {
    const rootKey = await generateKey({ kind: 'EC', curve: 'P-256' });
    const root = await issueCertificate({
      subject: 'Deep Root',
      keyPair: rootKey,
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign'],
      nameConstraints: { permitted: [{ kind: 'dns', value: 'example.com' }] },
    });
    const middleKey = await generateKey({ kind: 'EC', curve: 'P-256' });
    const middle = await issueCertificate(
      {
        subject: 'Deep Intermediate',
        keyPair: middleKey,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign'],
        subjectAltNames: [{ kind: 'dns', value: 'ca.example.org' }],
      },
      root,
    );
    const leaf = await makeLeaf('Deep Leaf', middle, {
      subjectAltNames: [{ kind: 'dns', value: 'a.example.com' }],
    });
    // The leaf is fine; the intermediate in the middle asserts a name the root forbids.
    expect(
      await checkTrust({ signer: leaf.der, chain: [middle.der], roots: [root.der], now: NOW }),
    ).toMatchObject({ verdict: 'untrusted', reason: 'name-constraint' });
  });

  it.each([
    ['not a NameConstraints structure', Uint8Array.from([0x05, 0x00])],
    ['a SEQUENCE holding something other than subtrees', Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x01])],
    ['a value asn1js refuses to decode', HOSTILE_DER],
  ])('reports an unreadable nameConstraints extension (%s) instead of ignoring it', async (_name, inner) => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const root = await issueCertificate({
      subject: 'Unreadable Root',
      keyPair,
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign'],
      extraExtensions: [rawExtension(OID_NAME_CONSTRAINTS, true, inner.slice().buffer)],
    });
    const leaf = await makeLeaf('Unreadable Leaf', root);
    const verdict = await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW });
    expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual({
      verdict: 'indeterminate',
      reason: 'malformed',
    });
  });
});

describe('hostile DER inside certificate extensions', () => {
  const OID_SUBJECT_ALT_NAME = '2.5.29.17';
  const OID_BASIC_CONSTRAINTS = '2.5.29.19';
  const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
  const OID_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';

  /** Well-formed DER that is not the type the extension needs. */
  const NOT_A_BIT_STRING = Uint8Array.from([0x05, 0x00]);
  const EMPTY_BIT_STRING = Uint8Array.from([0x03, 0x01, 0x00]);

  it('has asn1js throw, not report an offset, on the bytes used here', () => {
    expect(() => fromBER(HOSTILE_DER.slice().buffer)).toThrow();
    expect(parseAsn1(HOSTILE_DER)).toBeNull();
    expect(parseAsn1(Uint8Array.from([0xff, 0xff]))).toBeNull();
    expect(parseAsn1(Uint8Array.from([0x05, 0x00]))?.offset).toBe(2);
  });

  it('answers null for a signature asn1js throws on', () => {
    expect(ecdsaDerToRaw(Uint8Array.from([24, 6, 168, 24, 126, 23, 208, 191]), 32)).toBeNull();
    expect(ecdsaDerToRaw(HOSTILE_DER, 32)).toBeNull();
  });

  it('refuses a signature pair that is not two integers', () => {
    // SEQUENCE { INTEGER 1, OCTET STRING 2 } and SEQUENCE { OCTET STRING, INTEGER }.
    expect(ecdsaDerToRaw(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x04, 0x01, 0x02]), 32)).toBeNull();
    expect(ecdsaDerToRaw(Uint8Array.from([0x30, 0x06, 0x04, 0x01, 0x01, 0x02, 0x01, 0x02]), 32)).toBeNull();
  });

  it.each([
    ['a keyUsage asn1js throws on', HOSTILE_DER],
    ['a keyUsage that is not a BIT STRING', NOT_A_BIT_STRING],
    ['a keyUsage with no bits at all', EMPTY_BIT_STRING],
  ])('refuses a CA with %s as one that may not sign certificates', async (_name, inner) => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const root = await issueCertificate({
      subject: 'Hostile Usage Root',
      keyPair,
      ...VALID,
      basicConstraints: { cA: true },
      extraExtensions: [rawExtension(OID_KEY_USAGE, true, inner.slice().buffer)],
    });
    const leaf = await makeLeaf('Hostile Usage Leaf', root);
    const verdict = await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW });
    expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual({
      verdict: 'untrusted',
      reason: 'key-usage',
    });
  });

  it('refuses a CA whose basicConstraints asn1js throws on, as no CA', async () => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const root = await issueCertificate({
      subject: 'Hostile Constraints Root',
      keyPair,
      ...VALID,
      keyUsage: ['keyCertSign'],
      extraExtensions: [rawExtension(OID_BASIC_CONSTRAINTS, true, HOSTILE_DER.slice().buffer)],
    });
    const leaf = await makeLeaf('Hostile Constraints Leaf', root);
    const verdict = await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW });
    expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual({
      verdict: 'untrusted',
      reason: 'not-a-ca',
    });
  });

  it.each([
    ['asn1js throws on', HOSTILE_DER],
    ['is not a SEQUENCE', NOT_A_BIT_STRING],
    ['is a SEQUENCE of the wrong shape', Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x01])],
  ])('cannot evaluate name constraints against a subjectAltName that %s', async (_name, inner) => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const root = await issueCertificate({
      subject: 'Hostile Names Root',
      keyPair,
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign'],
      nameConstraints: { permitted: [{ kind: 'dns', value: 'example.com' }] },
    });
    const leaf = await makeLeaf('Hostile Names Leaf', root, {
      extraExtensions: [rawExtension(OID_SUBJECT_ALT_NAME, false, inner.slice().buffer)],
    });
    const verdict = await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW });
    expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual({
      verdict: 'indeterminate',
      reason: 'malformed',
    });
  });

  it('ignores a subjectAltName nobody constrains, however broken', async () => {
    const root = await makeCa('Unconstrained Root');
    const leaf = await makeLeaf('Unconstrained Leaf', root, {
      extraExtensions: [rawExtension(OID_SUBJECT_ALT_NAME, false, HOSTILE_DER.slice().buffer)],
    });
    expect(await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW })).toMatchObject({
      verdict: 'trusted',
    });
  });

  describe('key identifiers', () => {
    const ID_A = Uint8Array.from([1, 1, 1, 1]);
    const ID_B = Uint8Array.from([2, 2, 2, 2]);

    /**
     * Two CAs with one name and one key, both signed by the root, that fail differently: `A` lacks
     * `keyCertSign` and `B` is no CA. The reason a failed walk reports is the first one it met, so
     * the order the issuers are tried in is observable.
     */
    async function verdictWith(
      leafAuthority: Extension | null,
      subjectA: Extension,
      subjectB: Extension,
    ): Promise<string | null> {
      const root = await makeCa('Identified Root');
      const shared = await generateKey({ kind: 'EC', curve: 'P-256' });
      const a = await issueCertificate(
        {
          subject: 'Identified CA',
          keyPair: shared,
          ...VALID,
          basicConstraints: { cA: true },
          keyUsage: ['digitalSignature'],
          extraExtensions: [subjectA],
        },
        root,
      );
      const b = await issueCertificate(
        {
          subject: 'Identified CA',
          keyPair: shared,
          ...VALID,
          basicConstraints: { cA: false },
          extraExtensions: [subjectB],
        },
        root,
      );
      const leaf = await makeLeaf('Identified Leaf', a, {
        extraExtensions: leafAuthority === null ? [] : [leafAuthority],
      });
      const verdict = await checkTrust({
        signer: leaf.der,
        chain: [a.der, b.der],
        roots: [root.der],
        now: NOW,
      });
      expect(verdict.verdict).toBe('untrusted');
      return verdict.reason;
    }

    const ski = subjectKeyIdentifierExtension;
    const aki = authorityKeyIdentifierExtension;

    it('tries the issuer a leaf names by key identifier first', async () => {
      expect(await verdictWith(aki(ID_B), ski(ID_A), ski(ID_B))).toBe('not-a-ca');
      expect(await verdictWith(aki(ID_A), ski(ID_A), ski(ID_B))).toBe('key-usage');
    });

    it('tries the issuers in the order they were given without a leaf key identifier', async () => {
      expect(await verdictWith(null, ski(ID_A), ski(ID_B))).toBe('key-usage');
    });

    it('keeps the order for an authorityKeyIdentifier that names nobody here', async () => {
      expect(await verdictWith(aki(Uint8Array.from([9, 9])), ski(ID_A), ski(ID_B))).toBe('key-usage');
    });

    it.each([
      ['asn1js throws on', HOSTILE_DER],
      ['is not a SEQUENCE', NOT_A_BIT_STRING],
      ['has no [0] keyIdentifier', Uint8Array.from([0x30, 0x00])],
    ])('ignores an authorityKeyIdentifier that %s', async (_name, inner) => {
      const broken = rawExtension(OID_AUTHORITY_KEY_IDENTIFIER, false, inner.slice().buffer);
      expect(await verdictWith(broken, ski(ID_A), ski(ID_B))).toBe('key-usage');
    });

    it.each([
      ['asn1js throws on', HOSTILE_DER],
      ['is not an OCTET STRING', NOT_A_BIT_STRING],
    ])('does not match an issuer whose subjectKeyIdentifier %s', async (_name, inner) => {
      const broken = rawExtension(OID_SUBJECT_KEY_IDENTIFIER, false, inner.slice().buffer);
      // `B` is named by the leaf; `A` has the broken identifier and so is tried after it.
      expect(await verdictWith(aki(ID_B), broken, ski(ID_B))).toBe('not-a-ca');
      // `A` is the one named, but its identifier cannot be read: `B` (matching nothing either) keeps the order.
      expect(await verdictWith(aki(ID_A), broken, ski(ID_B))).toBe('key-usage');
    });
  });

  it('accepts a pathLenConstraint wider than 32 bits as no limit', async () => {
    const rootKey = await generateKey({ kind: 'EC', curve: 'P-256' });
    const root = await issueCertificate({
      subject: 'Wide Path Root',
      keyPair: rootKey,
      ...VALID,
      basicConstraints: { cA: true, pathLen: 2 ** 33 },
      keyUsage: ['keyCertSign'],
    });
    const first = await makeCaUnder('Wide Path One', root);
    const second = await makeCaUnder('Wide Path Two', first);
    const leaf = await makeLeaf('Wide Path Leaf', second);
    expect(
      await checkTrust({
        signer: leaf.der,
        chain: [second.der, first.der],
        roots: [root.der],
        now: NOW,
      }),
    ).toMatchObject({ verdict: 'trusted', reason: null });
  });
});

/** An intermediate CA under `issuer`. */
async function makeCaUnder(subject: string, issuer: CertificateFixture): Promise<CertificateFixture> {
  const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
  return await issueCertificate(
    { subject, keyPair, ...VALID, basicConstraints: { cA: true }, keyUsage: ['keyCertSign'] },
    issuer,
  );
}

describe('certificate names', () => {
  const OID_ORGANIZATION = '2.5.4.10';

  it('has no common name to show for a subject without one, and prints a dash for it', async () => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const subjectName = new RelativeDistinguishedNames({
      typesAndValues: [
        new AttributeTypeAndValue({
          type: OID_ORGANIZATION,
          value: new Utf8String({ value: 'Only An Org' }),
        }),
      ],
    });
    const root = await issueCertificate({
      subject: 'Nameless Root',
      keyPair,
      ...VALID,
      subjectName,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign'],
    });
    expect(certificateName(root.parsed)).toBeNull();
    const leaf = await makeLeaf('Named Leaf', root);
    expect(certificateName(leaf.parsed)).toBe('Named Leaf');
    // The issuer's name is the subject's, so the chain is findable and the path shows the dash.
    const verdict = await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW });
    expect(verdict.path).toEqual(['Named Leaf', '—']);
    expect((await checkTrust({ signer: root.der, roots: [root.der], now: NOW })).path).toEqual(['—']);
  });

  it('skips attributes that are not a common name and common names that are not text', async () => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const subjectName = new RelativeDistinguishedNames({
      typesAndValues: [
        new AttributeTypeAndValue({ type: OID_ORGANIZATION, value: new Utf8String({ value: 'An Org' }) }),
        new AttributeTypeAndValue({
          type: '2.5.4.3',
          value: new OctetString({ valueHex: new Uint8Array([1]).buffer }) as unknown as Utf8String,
        }),
        new AttributeTypeAndValue({
          type: '2.5.4.3',
          value: new Utf8String({ value: 'Second Common Name' }),
        }),
      ],
    });
    const certificate = await issueCertificate({ subject: 'Skipping', keyPair, ...VALID, subjectName });
    expect(certificateName(certificate.parsed)).toBe('Second Common Name');
  });

  it('reports a validity it cannot read as unknown rather than valid', async () => {
    const root = await makeCa('Unreadable Dates Root');
    const certificate = parse(root.der);
    expect(validityOf(certificate, NOW)).toBe('valid');
    certificate.notAfter.value = new Date(Number.NaN);
    expect(validityOf(certificate, NOW)).toBe('unknown');
    const other = parse(root.der);
    other.notBefore.value = new Date(Number.NaN);
    expect(validityOf(other, NOW)).toBe('unknown');
  });
});

describe('certificate signatures by other key types', () => {
  const OID_EC_KEY = '1.2.840.10045.2.1';
  const OID_P256 = '1.2.840.10045.3.1.7';
  const OID_P192 = '1.2.840.10045.3.1.1';
  const OID_ED25519 = '1.3.101.112';

  async function rsaCa(
    subject: string,
    hash: 'SHA-256' | 'SHA-384' | 'SHA-512',
  ): Promise<CertificateFixture> {
    const keyPair = await generateKey({ kind: 'RSA', hash });
    return await issueCertificate({
      subject,
      keyPair,
      ...VALID,
      signature: { name: 'RSA-PKCS1', hash },
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign'],
    });
  }

  it.each(['SHA-256', 'SHA-384', 'SHA-512'] as const)(
    'trusts a leaf an RSA root signed with %s',
    async (hash) => {
      const root = await rsaCa(`RSA ${hash} Root`, hash);
      const leafKey = await generateKey({ kind: 'EC', curve: 'P-256' });
      const leaf = await issueCertificate(
        {
          subject: `RSA ${hash} Leaf`,
          keyPair: leafKey,
          ...VALID,
          signature: { name: 'RSA-PKCS1', hash },
          basicConstraints: { cA: false },
        },
        root,
      );
      expect(await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW })).toMatchObject({
        verdict: 'trusted',
        reason: null,
      });
    },
  );

  it('reports a leaf signed by another RSA key under the same name as a signature mismatch', async () => {
    const real = await rsaCa('RSA Same Name', 'SHA-256');
    const impostor = await rsaCa('RSA Same Name', 'SHA-256');
    const leafKey = await generateKey({ kind: 'EC', curve: 'P-256' });
    const leaf = await issueCertificate(
      {
        subject: 'RSA Mismatch Leaf',
        keyPair: leafKey,
        ...VALID,
        signature: { name: 'RSA-PKCS1', hash: 'SHA-256' },
      },
      real,
    );
    expect(await checkTrust({ signer: leaf.der, roots: [impostor.der], now: NOW })).toMatchObject({
      verdict: 'untrusted',
      reason: 'signature-mismatch',
    });
  });

  it('leaves the hash of a bare rsaEncryption signature to the caller', async () => {
    const subtle = globalThis.crypto.subtle;
    const keyPair = await generateKey({ kind: 'RSA' });
    const signer = await issueCertificate({ subject: 'Bare RSA', keyPair, ...VALID });
    const message = new TextEncoder().encode('signed attributes');
    const signature = new Uint8Array(
      await subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, keyPair.privateKey, message),
    );
    const rsaEncryption = '1.2.840.113549.1.1.1';

    expect(
      await verifyDataSignature(subtle, signer.parsed, rsaEncryption, signature, message, 'SHA-256'),
    ).toBe('ok');
    expect(
      await verifyDataSignature(subtle, signer.parsed, rsaEncryption, signature, message, 'SHA-384'),
    ).toBe('mismatch');
    expect(
      await verifyDataSignature(
        subtle,
        signer.parsed,
        rsaEncryption,
        signature,
        new Uint8Array([1]),
        'SHA-256',
      ),
    ).toBe('mismatch');
    // No fallback hash named: nothing says which hash was used, and a guess is not a check.
    expect(await verifyDataSignature(subtle, signer.parsed, rsaEncryption, signature, message)).toBe(
      'unsupported',
    );
    // A fallback never rescues an algorithm that is not plain RSA.
    expect(
      await verifyDataSignature(subtle, signer.parsed, '1.3.101.112', signature, message, 'SHA-256'),
    ).toBe('unsupported');
  });

  it.each([
    ['a curve WebCrypto cannot verify', fakeSpki(OID_EC_KEY, OID_P192, new Uint8Array(49).fill(4))],
    ['an elliptic-curve key that names no curve', fakeSpki(OID_EC_KEY, null, new Uint8Array(65).fill(4))],
    ['a key algorithm it does not implement', fakeSpki(OID_ED25519, null, new Uint8Array(32).fill(1))],
    ['a point that is not on the curve', fakeSpki(OID_EC_KEY, OID_P256, new Uint8Array(65).fill(4))],
  ])('cannot check a signature against %s, and says so', async (_name, spki) => {
    const realKey = await generateKey({ kind: 'EC', curve: 'P-256' });
    const root = await issueCertificate({
      subject: 'Fake Key Root',
      keyPair: realKey,
      spki,
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign'],
    });
    const leaf = await makeLeaf('Fake Key Leaf', root);
    const verdict = await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW });
    expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual({
      verdict: 'indeterminate',
      reason: 'unsupported-signature',
    });
  });

  it('reports a signature that is not a DER pair as malformed, not as a forgery', async () => {
    const root = await makeCa('Malformed Signature Root');
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const leaf = await issueCertificate(
      { subject: 'Malformed Signature Leaf', keyPair, ...VALID, signature: { name: 'malformed' } },
      root,
    );
    const verdict = await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW });
    expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual({
      verdict: 'indeterminate',
      reason: 'malformed',
    });
  });

  it('refuses an ECDSA integer with no content', () => {
    // SEQUENCE { INTEGER (empty), INTEGER 1 }
    expect(ecdsaDerToRaw(Uint8Array.from([0x30, 0x05, 0x02, 0x00, 0x02, 0x01, 0x01]), 32)).toBeNull();
  });
});

describe('the walk over candidate issuers', () => {
  it('gives up on a chain longer than the depth limit', async () => {
    const root = await makeCa('Long Root');
    let issuer = root;
    const intermediates: CertificateFixture[] = [];
    for (let level = 0; level < 10; level += 1) {
      issuer = await makeCaUnder(`Long Intermediate ${level}`, issuer);
      intermediates.push(issuer);
    }
    const leaf = await makeLeaf('Long Leaf', issuer);
    const verdict = await checkTrust({
      signer: leaf.der,
      chain: intermediates.map((entry) => entry.der),
      roots: [root.der],
      now: NOW,
    });
    expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual({
      verdict: 'untrusted',
      reason: 'no-issuer',
    });
    // The same chain, short enough, is fine: the limit is the only thing in the way.
    const shortLeaf = await makeLeaf('Short Leaf', intermediates[1] as CertificateFixture);
    expect(
      await checkTrust({
        signer: shortLeaf.der,
        chain: intermediates.slice(0, 2).map((entry) => entry.der),
        roots: [root.der],
        now: NOW,
      }),
    ).toMatchObject({ verdict: 'trusted' });
  });

  it('does not loop on certificates that issue each other', async () => {
    const keyA = await generateKey({ kind: 'EC', curve: 'P-256' });
    const keyB = await generateKey({ kind: 'EC', curve: 'P-256' });
    const anchor = await makeCa('Cycle Anchor');
    const a = await issueCertificate({
      subject: 'Cycle A',
      keyPair: keyA,
      ...VALID,
      basicConstraints: { cA: true },
      keyUsage: ['keyCertSign'],
    });
    // `b` is issued by `a`; and a certificate named "Cycle A" issued by `b` closes the loop.
    const b = await issueCertificate(
      {
        subject: 'Cycle B',
        keyPair: keyB,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign'],
      },
      a,
    );
    const aAgain = await issueCertificate(
      {
        subject: 'Cycle A',
        keyPair: keyA,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign'],
      },
      b,
    );
    const leaf = await makeLeaf('Cycle Leaf', a);
    const verdict = await checkTrust({
      signer: leaf.der,
      chain: [a.der, b.der, aAgain.der],
      roots: [anchor.der],
      now: NOW,
    });
    expect({ verdict: verdict.verdict, reason: verdict.reason }).toEqual({
      verdict: 'untrusted',
      reason: 'no-issuer',
    });
  });

  it('keeps the definite failure when an indeterminate one was found first', async () => {
    const root = await makeCa('Precedence Root');
    const shared = await generateKey({ kind: 'EC', curve: 'P-256' });
    // Same name, same key: the first cannot be finished (a critical extension nobody handles),
    // the second is a definite failure (not a CA).
    const unfinished = await issueCertificate(
      {
        subject: 'Precedence CA',
        keyPair: shared,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign'],
        extraExtensions: [unknownCriticalExtension()],
      },
      root,
    );
    const definite = await issueCertificate(
      { subject: 'Precedence CA', keyPair: shared, ...VALID, basicConstraints: { cA: false } },
      root,
    );
    const leaf = await makeLeaf('Precedence Leaf', unfinished);
    const both = await checkTrust({
      signer: leaf.der,
      chain: [unfinished.der, definite.der],
      roots: [root.der],
      now: NOW,
    });
    expect({ verdict: both.verdict, reason: both.reason }).toEqual({
      verdict: 'untrusted',
      reason: 'not-a-ca',
    });
    // The other way round the definite one is already recorded, and stays.
    const reversed = await checkTrust({
      signer: leaf.der,
      chain: [definite.der, unfinished.der],
      roots: [root.der],
      now: NOW,
    });
    expect({ verdict: reversed.verdict, reason: reversed.reason }).toEqual({
      verdict: 'untrusted',
      reason: 'not-a-ca',
    });
    // Alone, the unfinished path stays indeterminate.
    const alone = await checkTrust({
      signer: leaf.der,
      chain: [unfinished.der],
      roots: [root.der],
      now: NOW,
    });
    expect({ verdict: alone.verdict, reason: alone.reason }).toEqual({
      verdict: 'indeterminate',
      reason: 'unsupported-critical-extension',
    });
  });

  it('uses the current time when none is given', async () => {
    const root = await makeCa('Clock Root');
    const day = 86_400_000;
    const current = await makeLeaf('Clock Current Leaf', root, {
      notBefore: new Date(Date.now() - day),
      notAfter: new Date(Date.now() + day),
    });
    expect(await checkTrust({ signer: current.der, roots: [root.der] })).toMatchObject({
      verdict: 'trusted',
      validity: 'valid',
    });
    const lapsed = await makeLeaf('Clock Lapsed Leaf', root, {
      notBefore: new Date(Date.now() - 3 * day),
      notAfter: new Date(Date.now() - day),
    });
    expect(await checkTrust({ signer: lapsed.der, roots: [root.der] })).toMatchObject({
      verdict: 'untrusted',
      reason: 'validity',
      validity: 'expired',
    });
  });

  it('reports nothing was checked when no roots are given at all', async () => {
    const root = await makeCa('Omitted Roots Root');
    const leaf = await makeLeaf('Omitted Roots Leaf', root);
    expect(await checkTrust({ signer: leaf.der, now: NOW })).toMatchObject({
      verdict: 'not-checked',
      reason: 'no-roots',
    });
  });

  it('checks nothing without WebCrypto', async () => {
    const root = await makeCa('No Crypto Root');
    const leaf = await makeLeaf('No Crypto Leaf', root);
    vi.stubGlobal('crypto', {});
    try {
      expect(await checkTrust({ signer: leaf.der, roots: [root.der], now: NOW })).toEqual(NO_TRUST);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets the caller excuse a critical extension of the signer only', async () => {
    const root = await makeCa('Excuse Root');
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const leaf = await issueCertificate(
      {
        subject: 'Excuse Leaf',
        keyPair,
        ...VALID,
        basicConstraints: { cA: false },
        extraExtensions: [unknownCriticalExtension('1.3.6.1.4.1.99999.2')],
      },
      root,
    );
    const input = { signer: leaf.der, roots: [root.der], now: NOW };
    expect(await checkTrust(input)).toMatchObject({ verdict: 'indeterminate' });
    expect(await checkTrust({ ...input, leafCriticalExtensions: ['1.3.6.1.4.1.99999.2'] })).toMatchObject({
      verdict: 'trusted',
    });

    // The same extension on a CA is never excused.
    const caKey = await generateKey({ kind: 'EC', curve: 'P-256' });
    const ca = await issueCertificate(
      {
        subject: 'Excuse CA',
        keyPair: caKey,
        ...VALID,
        basicConstraints: { cA: true },
        keyUsage: ['keyCertSign'],
        extraExtensions: [unknownCriticalExtension('1.3.6.1.4.1.99999.2')],
      },
      root,
    );
    const under = await makeLeaf('Excuse Under CA', ca);
    expect(
      await checkTrust({
        signer: under.der,
        chain: [ca.der],
        roots: [root.der],
        now: NOW,
        leafCriticalExtensions: ['1.3.6.1.4.1.99999.2'],
      }),
    ).toMatchObject({ verdict: 'indeterminate', reason: 'unsupported-critical-extension' });
  });
});
