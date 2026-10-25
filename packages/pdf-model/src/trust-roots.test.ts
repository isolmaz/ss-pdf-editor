/**
 * `trust-roots.ts`: the imported-trust-root store file.
 *
 * It protects the round trip (the stored base64 decodes to exactly the imported DER; the base64
 * itself is `base64.test.ts`), that one certificate imported twice is one entry, and that a
 * stored file is untrusted input when read back: wrong version, wrong shapes and implausibly
 * short DER are dropped instead of guessed at.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64 } from './base64';
import {
  addTrustRoot,
  EMPTY_TRUST_ROOTS,
  parseTrustRoots,
  removeTrustRoot,
  toDer,
  trustRootFrom,
} from './trust-roots';

/** A stand-in for a certificate's DER: this module never interprets it, only keeps it and size-checks it. */
function der(seed: number, length = 200): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 13 + seed) & 0xff);
}

/** Two certificates that a 32-bit polynomial hash of the base64 cannot tell apart, though their SHA-256 can. */
const COLLIDING = [Uint8Array.of(121, 185, 0, 79, 100, 21), Uint8Array.of(2, 65, 8, 14, 163, 233)] as const;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

afterEach(() => {
  vi.useRealTimers();
});

describe('trust roots', () => {
  it('derives the id from the SHA-256 of the certificate, so the same DER under another label is the same root', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
    const root = await trustRootFrom(der(1), 'Root CA');
    expect(root.addedAt).toBe(Date.parse('2026-03-04T05:06:07.000Z'));
    expect(root.derBase64).toBe(Buffer.from(der(1)).toString('base64'));
    expect(root.id).toBe(`root-${sha256(der(1))}`);
    expect((await trustRootFrom(der(1), 'Another name', 5)).id).toBe(root.id);
    expect((await trustRootFrom(der(2), 'Root CA', 5)).id).not.toBe(root.id);
    expect([...toDer(root)]).toEqual([...der(1)]);
  });

  it('keeps two certificates that a short id could not tell apart', async () => {
    const [first, second] = COLLIDING;
    const one = await trustRootFrom(first, 'Root 0', 0);
    const other = await trustRootFrom(second, 'Root 1', 1);
    expect(one.id).not.toBe(other.id);

    const file = addTrustRoot(addTrustRoot(EMPTY_TRUST_ROOTS, one), other);

    expect(file.roots.map((root) => root.label)).toEqual(['Root 0', 'Root 1']);
  });

  it('replaces a root stored under an earlier id by the same certificate imported again, and keeps the others', async () => {
    const [bytes, otherBytes] = COLLIDING;
    const earlier = { id: 'root-f64adcb1', label: 'Earlier', derBase64: toBase64(bytes), addedAt: 1 };
    const unrelated = {
      id: 'root-0badf00d',
      label: 'Unrelated',
      derBase64: toBase64(otherBytes),
      addedAt: 2,
    };
    const again = await trustRootFrom(bytes, 'Again', 3);

    const file = addTrustRoot({ version: 1, roots: [earlier, unrelated] }, again);

    expect(file.roots.map((root) => root.label)).toEqual(['Unrelated', 'Again']);
    expect(removeTrustRoot(file, unrelated.id).roots.map((root) => root.label)).toEqual(['Again']);
  });

  it('adding the same certificate again replaces it; removing takes out only that id', async () => {
    const first = await trustRootFrom(der(1), 'First', 1);
    const second = await trustRootFrom(der(2), 'Second', 2);
    const again = await trustRootFrom(der(1), 'First, renamed', 3);
    let file = addTrustRoot(EMPTY_TRUST_ROOTS, first);
    file = addTrustRoot(file, second);
    file = addTrustRoot(file, again);
    expect(file.roots.map((root) => [root.label, root.addedAt])).toEqual([
      ['Second', 2],
      ['First, renamed', 3],
    ]);
    expect(removeTrustRoot(file, first.id).roots.map((root) => root.label)).toEqual(['Second']);
    expect(removeTrustRoot(file, 'root-unknown').roots).toHaveLength(2);
    expect(EMPTY_TRUST_ROOTS.roots).toHaveLength(0);
  });

  it('reads a stored file back and drops whatever is not a plausible root', async () => {
    const kept = await trustRootFrom(der(3), 'Kept', 42);
    const undated = { id: 'root-x', label: 'Undated', derBase64: toBase64(der(4)), addedAt: 'yesterday' };
    const stored = JSON.parse(
      JSON.stringify({
        version: 1,
        roots: [
          kept,
          null,
          'root',
          { id: 7, label: 'Bad id', derBase64: toBase64(der(5)) },
          { id: 'root-y', label: null, derBase64: toBase64(der(5)) },
          { id: 'root-z', label: 'No DER' },
          { id: 'root-short', label: 'Short', derBase64: toBase64(der(6, 63)) },
          undated,
        ],
      }),
    );
    expect(parseTrustRoots(stored)).toEqual({
      version: 1,
      roots: [kept, { ...undated, addedAt: 0 }],
    });
  });

  it('refuses a file of another version or shape as a whole', async () => {
    const roots = [await trustRootFrom(der(1), 'Root', 1)];
    for (const raw of [null, 'text', 7, { version: 2, roots }, { version: 1, roots: {} }, { roots }]) {
      expect(parseTrustRoots(raw)).toBe(EMPTY_TRUST_ROOTS);
    }
  });
});
