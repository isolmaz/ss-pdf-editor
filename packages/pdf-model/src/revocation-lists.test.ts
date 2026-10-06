/**
 * `revocation-lists.ts`: the imported-CRL store file.
 *
 * It protects the round trip (the stored base64 decodes to exactly the imported DER, checked
 * against Node's own base64), that one CRL imported twice is one entry, and that a stored file
 * is untrusted input when read back: wrong version, wrong shapes and implausibly short DER are
 * dropped instead of guessed at.
 */

import { describe, expect, it } from 'vitest';
import {
  addRevocationList,
  EMPTY_REVOCATION_LISTS,
  parseRevocationLists,
  removeRevocationList,
  revocationListDer,
  revocationListFrom,
} from './revocation-lists';

const SUMMARY = {
  thisUpdate: '2026-05-01T00:00:00.000Z',
  nextUpdate: '2026-07-01T00:00:00.000Z',
  revokedCount: 2,
  delta: false,
};

/** A stand-in for a CRL's DER: this module never interprets it, only keeps it and size-checks it. */
function der(seed: number, length = 120): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 7 + seed) & 0xff);
}

describe('imported CRL store', () => {
  it('keeps the DER exactly, base64 as Node writes it, and survives a JSON round trip', () => {
    const bytes = der(1, 121); // not a multiple of 3: exercises the padding
    const list = revocationListFrom(bytes, 'My CA', SUMMARY, 1234);
    expect(list.derBase64).toBe(Buffer.from(bytes).toString('base64'));
    expect(Array.from(revocationListDer(list) ?? [])).toEqual(Array.from(bytes));
    expect(list).toMatchObject({ label: 'My CA', addedAt: 1234, ...SUMMARY });
    expect(list.id).toMatch(/^crl-[0-9a-f]+$/);

    const file = addRevocationList(EMPTY_REVOCATION_LISTS, list);
    expect(parseRevocationLists(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });

  it('gives one CRL one entry however often it is added, and tells different CRLs apart', () => {
    const first = revocationListFrom(der(1), 'first', SUMMARY, 1);
    const again = revocationListFrom(der(1), 'renamed', SUMMARY, 2);
    const other = revocationListFrom(der(2), 'other', SUMMARY, 3);
    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);

    let file = addRevocationList(EMPTY_REVOCATION_LISTS, first);
    file = addRevocationList(file, again);
    expect(file.lists.map((entry) => entry.label)).toEqual(['renamed']);
    file = addRevocationList(file, other);
    expect(file.lists.map((entry) => entry.label)).toEqual(['renamed', 'other']);

    const removed = removeRevocationList(file, first.id);
    expect(removed.lists.map((entry) => entry.label)).toEqual(['other']);
    expect(removed.version).toBe(1);
    expect(removeRevocationList(removed, 'no-such-id')).toEqual(removed);
    expect(file.lists).toHaveLength(2); // the input file is never mutated
  });
});

describe('parseRevocationLists on untrusted input', () => {
  const good = revocationListFrom(der(3), 'good', SUMMARY, 9);

  it('answers the empty file for anything that is not a version-1 file', () => {
    for (const raw of [
      null,
      undefined,
      'text',
      42,
      [],
      {},
      { version: 2, lists: [good] },
      { version: 1, lists: 'x' },
    ]) {
      expect(parseRevocationLists(raw)).toEqual(EMPTY_REVOCATION_LISTS);
    }
  });

  it('drops entries of the wrong shape or with too little DER, and defaults the display fields', () => {
    const file = parseRevocationLists({
      version: 1,
      lists: [
        good,
        null,
        'x',
        { id: 'a', label: 'no der' },
        { id: 5, label: 'bad id', derBase64: good.derBase64 },
        { id: 'tiny', label: 'tiny', derBase64: Buffer.from(der(4, 31)).toString('base64') },
        {
          id: 'bare',
          label: 'bare',
          derBase64: good.derBase64,
          addedAt: 'yesterday',
          revokedCount: '3',
          delta: 'yes',
          thisUpdate: 7,
        },
        {
          id: 'delta',
          label: 'delta',
          derBase64: good.derBase64,
          delta: true,
          revokedCount: 4,
          addedAt: 5,
          nextUpdate: 'n',
        },
      ],
    });
    expect(file.lists.map((entry) => entry.id)).toEqual([good.id, 'bare', 'delta']);
    expect(file.lists[1]).toEqual({
      id: 'bare',
      label: 'bare',
      derBase64: good.derBase64,
      addedAt: 0,
      thisUpdate: null,
      nextUpdate: null,
      revokedCount: 0,
      delta: false,
    });
    expect(file.lists[2]).toMatchObject({ delta: true, revokedCount: 4, addedAt: 5, nextUpdate: 'n' });
  });
});
