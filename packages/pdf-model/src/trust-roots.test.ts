/**
 * `trust-roots.ts`: the imported-trust-root store file and the base64 both stores use.
 *
 * It protects the round trip (the stored base64 decodes to exactly the imported DER, checked
 * against Node's own base64, PEM line breaks and padding included), that one certificate
 * imported twice is one entry, and that a stored file is untrusted input when read back:
 * wrong version, wrong shapes and implausibly short DER are dropped instead of guessed at.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addTrustRoot,
  EMPTY_TRUST_ROOTS,
  fromBase64,
  parseTrustRoots,
  removeTrustRoot,
  toBase64,
  toDer,
  trustRootFrom,
} from './trust-roots';

/** A stand-in for a certificate's DER: this module never interprets it, only keeps it and size-checks it. */
function der(seed: number, length = 200): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 13 + seed) & 0xff);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('base64', () => {
  it('encodes and decodes every length remainder exactly as Node does', () => {
    for (let length = 0; length <= 6; length += 1) {
      const bytes = der(length * 17 + 1, length);
      const encoded = toBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
      expect([...fromBase64(encoded)]).toEqual([...bytes]);
    }
    const every = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(toBase64(every)).toBe(Buffer.from(every).toString('base64'));
    expect([...fromBase64(toBase64(every))]).toEqual([...every]);
  });

  it('decodes a PEM body: line breaks, indentation and padding are not data', () => {
    const bytes = der(5, 100);
    const wrapped = Buffer.from(bytes)
      .toString('base64')
      .replace(/.{1,64}/g, (line) => `  ${line}\r\n`);
    expect([...fromBase64(wrapped)]).toEqual([...bytes]);
    expect([...fromBase64('QQ==')]).toEqual([0x41]);
    expect(fromBase64('').length).toBe(0);
  });
});

describe('trust roots', () => {
  it('derives the id from the certificate, so the same DER under another label is the same root', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
    const root = trustRootFrom(der(1), 'Root CA');
    expect(root.addedAt).toBe(Date.parse('2026-03-04T05:06:07.000Z'));
    expect(root.derBase64).toBe(Buffer.from(der(1)).toString('base64'));
    expect(root.id).toMatch(/^root-[0-9a-f]+$/);
    expect(trustRootFrom(der(1), 'Another name', 5).id).toBe(root.id);
    expect(trustRootFrom(der(2), 'Root CA', 5).id).not.toBe(root.id);
    expect([...toDer(root)]).toEqual([...der(1)]);
  });

  it('adding the same certificate again replaces it; removing takes out only that id', () => {
    const first = trustRootFrom(der(1), 'First', 1);
    const second = trustRootFrom(der(2), 'Second', 2);
    const again = trustRootFrom(der(1), 'First, renamed', 3);
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

  it('reads a stored file back and drops whatever is not a plausible root', () => {
    const kept = trustRootFrom(der(3), 'Kept', 42);
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

  it('refuses a file of another version or shape as a whole', () => {
    const roots = [trustRootFrom(der(1), 'Root', 1)];
    for (const raw of [null, 'text', 7, { version: 2, roots }, { version: 1, roots: {} }, { roots }]) {
      expect(parseTrustRoots(raw)).toBe(EMPTY_TRUST_ROOTS);
    }
  });
});
