// @vitest-environment happy-dom
/**
 * The update banner's hook in a mounted component: it follows the update the page learned
 * of, and dismissing hides the banner for that mount. The worker plumbing itself is covered
 * in `serviceWorkerUpdate.test.tsx`.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initServiceWorkerUpdates, useServiceWorkerUpdate } from './serviceWorkerUpdate';

afterEach(() => vi.unstubAllGlobals());

describe('useServiceWorkerUpdate', () => {
  it('offers the update that became available after mount, and hides the banner when dismissed', async () => {
    const waiting = { postMessage: vi.fn() };
    const registration = Object.assign(new EventTarget(), { waiting, installing: null, update: vi.fn() });
    vi.stubGlobal('navigator', {
      serviceWorker: Object.assign(new EventTarget(), {
        controller: {},
        register: () => Promise.resolve(registration),
      }),
    });

    const { result } = renderHook(() => useServiceWorkerUpdate());
    expect(result.current.updateAvailable).toBe(false);

    await act(async () => {
      initServiceWorkerUpdates();
      await Promise.resolve();
    });
    expect(result.current.updateAvailable).toBe(true);

    act(() => result.current.dismissUpdate());
    expect(result.current.updateAvailable).toBe(false);

    act(() => result.current.reloadToUpdate());
    expect(waiting.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });
  });
});
