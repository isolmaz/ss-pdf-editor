import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODE_CHANGE_EVENT, readStoredMode, storeMode } from './interface-mode';

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

  it('announces the choice on the window even when persisting it fails', () => {
    vi.stubGlobal('localStorage', blockedStorage);
    const seen: unknown[] = [];
    vi.stubGlobal('dispatchEvent', (event: CustomEvent<{ mode: string }>) => {
      seen.push([event.type, event.detail.mode]);
      return true;
    });
    storeMode('advanced');
    expect(seen).toEqual([[MODE_CHANGE_EVENT, 'advanced']]);
  });
});
