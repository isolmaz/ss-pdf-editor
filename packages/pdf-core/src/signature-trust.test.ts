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
import { CertificateChainValidationEngine, Certificate as PkijsCertificate } from 'pkijs';
import { describe, expect, it } from 'vitest';
import { checkTrust, ecdsaDerToRaw } from './signature-trust';
import type { CertificateFixture, IssueOptions } from './signature-trust.fixtures';
import {
  derIntegers,
  ecdsaRawToDer,
  generateKey,
  issueCertificate,
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
