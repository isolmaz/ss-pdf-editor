// @vitest-environment happy-dom
/**
 * The update banner's hook in a mounted component: it follows the update the page learned
 * of, and dismissing closes the update for the page — every mounted banner and every banner
 * mounted afterwards — until a newer worker is offered. The worker plumbing itself is covered
 * in `serviceWorkerUpdate.test.tsx`.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initServiceWorkerUpdates, useServiceWorkerUpdate } from './serviceWorkerUpdate';

afterEach(() => vi.unstubAllGlobals());

describe('useServiceWorkerUpdate', () => {
  it('offers the update that became available after mount, and closes it for every banner, now and later', async () => {
    const waiting = { postMessage: vi.fn() };
    const registration = Object.assign(new EventTarget(), { waiting, installing: null, update: vi.fn() });
    vi.stubGlobal('navigator', {
      serviceWorker: Object.assign(new EventTarget(), {
        controller: {},
        register: () => Promise.resolve(registration),
      }),
    });

    const { result, unmount } = renderHook(() => useServiceWorkerUpdate());
    const other = renderHook(() => useServiceWorkerUpdate());
    expect(result.current.updateAvailable).toBe(false);
    expect(result.current.reloadHeld).toBe(false);

    await act(async () => {
      initServiceWorkerUpdates();
      await Promise.resolve();
    });
    expect(result.current.updateAvailable).toBe(true);
    expect(other.result.current.updateAvailable).toBe(true);

    act(() => result.current.dismissUpdate());
    expect(result.current.updateAvailable).toBe(false);
    expect(other.result.current.updateAvailable).toBe(false);
    // A banner that mounts again (the shell remounted it) does not bring back what was dismissed.
    const remounted = renderHook(() => useServiceWorkerUpdate());
    expect(remounted.result.current.updateAvailable).toBe(false);

    act(() => result.current.reloadToUpdate());
    expect(waiting.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });

    // A newer worker finishing its install is offered to the banner that is mounted then.
    const incoming = Object.assign(new EventTarget(), { state: 'installing', postMessage: vi.fn() });
    Object.assign(registration, { installing: incoming });
    act(() => {
      registration.dispatchEvent(new Event('updatefound'));
      incoming.state = 'installed';
      incoming.dispatchEvent(new Event('statechange'));
    });
    expect(remounted.result.current.updateAvailable).toBe(true);
    expect(result.current.updateAvailable).toBe(true);

    // An unmounted banner stops listening: a later update leaves what it last showed.
    unmount();
    act(() => result.current.dismissUpdate());
    expect(result.current.updateAvailable).toBe(true);
    expect(remounted.result.current.updateAvailable).toBe(false);
  });
});
