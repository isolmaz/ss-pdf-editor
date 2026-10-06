/**
 * `signature-store.ts`: the opt-in memory of drawn signatures, in `localStorage`.
 *
 * The browser's storage is replaced by a small in-memory fake (Node has none). These tests
 * protect the stated limits: newest first, one entry per picture, at most six kept, a
 * picture over the size cap refused, an entry deleted by id, and a stored value that is
 * corrupt, of the wrong shape or not a PNG data URL never reaching the dialog. A failing
 * storage (quota, disabled) must not throw.
 */

import type { SavedSignature } from 'pdf-ui/dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetSignature, loadSavedSignatures, rememberSignature } from './signature-store';

const KEY = 'pdf-editor.signatures.v1';

let data: Map<string, string>;
let failWrites = false;

beforeEach(() => {
  data = new Map();
  failWrites = false;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new DOMException('full', 'QuotaExceededError');
      data.set(key, value);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function signature(id: string, role: 'signature' | 'initials' = 'signature', extra = ''): SavedSignature {
  return { id, role, dataUrl: `data:image/png;base64,${id}${extra}`, width: 200, height: 80 };
}

describe('saved signatures', () => {
  it('remembers newest first, replaces the same picture, and keeps at most six', () => {
    for (const id of ['a', 'b', 'c']) rememberSignature(signature(id));
    expect(loadSavedSignatures().map((item) => item.id)).toEqual(['c', 'b', 'a']);

    // The same picture again moves to the front under its new id instead of duplicating.
    rememberSignature({ ...signature('b'), id: 'b2' });
    expect(loadSavedSignatures().map((item) => item.id)).toEqual(['b2', 'c', 'a']);

    for (const id of ['d', 'e', 'f', 'g']) rememberSignature(signature(id));
    const kept = loadSavedSignatures().map((item) => item.id);
    expect(kept).toEqual(['g', 'f', 'e', 'd', 'b2', 'c']); // 'a' fell off the end
    expect(JSON.parse(data.get(KEY) ?? '[]')).toHaveLength(6);
  });

  it('forgets one entry by id and leaves the rest', () => {
    rememberSignature(signature('a'));
    rememberSignature(signature('b', 'initials'));
    expect(forgetSignature('a').map((item) => item.id)).toEqual(['b']);
    expect(loadSavedSignatures()).toEqual([signature('b', 'initials')]);
    expect(forgetSignature('missing').map((item) => item.id)).toEqual(['b']);
  });

  it('refuses a picture over the size cap, without touching what is stored', () => {
    rememberSignature(signature('a'));
    const huge = signature('big', 'signature', 'A'.repeat(512 * 1024));
    expect(rememberSignature(huge).map((item) => item.id)).toEqual(['a']);
    expect(loadSavedSignatures().map((item) => item.id)).toEqual(['a']);
  });

  it('reads corrupt or foreign storage as empty, and filters entries that are not signatures', () => {
    data.set(KEY, '{not json');
    expect(loadSavedSignatures()).toEqual([]);
    data.set(KEY, JSON.stringify({ id: 'a' }));
    expect(loadSavedSignatures()).toEqual([]);

    const good = signature('ok');
    data.set(
      KEY,
      JSON.stringify([
        good,
        null,
        'x',
        { ...good, id: 7 },
        { ...good, role: 'stamp' },
        { ...good, dataUrl: 'data:image/jpeg;base64,AAAA' },
        { ...good, dataUrl: 'https://example.test/sig.png' },
        { ...good, width: '200' },
        { ...good, id: 'ok2', role: 'initials' },
      ]),
    );
    expect(loadSavedSignatures().map((item) => item.id)).toEqual(['ok', 'ok2']);
  });

  it('still returns the list when the storage refuses the write, and when it is missing entirely', () => {
    failWrites = true;
    expect(rememberSignature(signature('a')).map((item) => item.id)).toEqual(['a']);
    expect(loadSavedSignatures()).toEqual([]); // not remembered, not thrown

    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', undefined);
    expect(loadSavedSignatures()).toEqual([]);
    expect(rememberSignature(signature('b')).map((item) => item.id)).toEqual(['b']);
  });
});
