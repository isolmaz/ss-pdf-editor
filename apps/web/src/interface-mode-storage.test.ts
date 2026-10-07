import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredMode, storeMode } from './interface-mode';

/** A `localStorage` whose every call fails, as a blocked or full store does. */
const blockedStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('the stored interface mode', () => {
  it('reads advanced only when advanced was stored, simple for anything else', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    expect(readStoredMode()).toBe('simple');
    storeMode('advanced');
    expect(readStoredMode()).toBe('advanced');
    values.set('pdf_editor_interface_mode_v1', 'something-else');
    expect(readStoredMode()).toBe('simple');
  });

  it('falls back to simple when storage is blocked on read', () => {
    vi.stubGlobal('localStorage', blockedStorage);
    expect(readStoredMode()).toBe('simple');
  });

  it('contains a full storage on write: the call returns and the earlier choice stays stored', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'advanced',
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    storeMode('simple');
    expect(readStoredMode()).toBe('advanced');
  });
});
