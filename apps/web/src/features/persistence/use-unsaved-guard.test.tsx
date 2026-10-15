// @vitest-environment happy-dom
/**
 * What the window does about work no draft protects: the browser asks before it is closed or
 * reloaded, and a service worker that takes over leaves it on its old code. A window whose
 * changes a draft holds, or that has none, is never held back.
 */

import { cleanup, renderHook } from '@testing-library/react';
import { SessionStore } from 'pdf-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { draftWritten, resetPersistence } from './persistence-store';
import { useUnsavedGuard } from './use-unsaved-guard';
import { openTab } from './vault.fixtures';

const worker = vi.hoisted(() => ({ blocked: null as (() => boolean) | null, release: vi.fn() }));
vi.mock('../../serviceWorkerUpdate', () => ({
  guardReload: (blocked: () => boolean) => {
    worker.blocked = blocked;
    return worker.release;
  },
}));

let session: SessionStore;

/**
 * What the browser does when the window is about to go: the event (a `BeforeUnloadEvent` carries
 * its `returnValue` as a plain string), and whether a handler asked to stop it.
 */
function closeWindow(): { readonly asked: boolean; readonly returnValue: unknown } {
  const event = new Event('beforeunload', { cancelable: true });
  Object.defineProperty(event, 'returnValue', { value: undefined, writable: true });
  window.dispatchEvent(event);
  return { asked: event.defaultPrevented, returnValue: Reflect.get(event, 'returnValue') };
}

/** Whether the service worker's takeover would leave the page on its old code. */
function reloadHeld(): boolean {
  if (worker.blocked === null) throw new Error('no reload guard was registered');
  return worker.blocked();
}

/** A document with unsaved changes, in front. */
function openChanged(sensitive = false) {
  const tab = openTab(session);
  session.setDirty(tab.id, true);
  if (sensitive) session.setSensitive(tab.id, true);
  return tab;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  resetPersistence();
  worker.blocked = null;
  worker.release.mockReset();
  session = new SessionStore();
});
afterEach(cleanup);

describe('useUnsavedGuard', () => {
  it('lets a window with nothing changed close and reload', () => {
    renderHook(() => useUnsavedGuard(session));
    expect(closeWindow().asked).toBe(false);
    openTab(session);
    expect(closeWindow().asked).toBe(false);
    expect(reloadHeld()).toBe(false);
  });

  it('asks before a sensitive session with unsaved changes closes, and holds the reload', () => {
    renderHook(() => useUnsavedGuard(session));
    openChanged(true);
    expect(closeWindow()).toEqual({ asked: true, returnValue: '' });
    expect(reloadHeld()).toBe(true);
  });

  it('asks while the draft of the changes is not written yet, and stops asking once it is', () => {
    renderHook(() => useUnsavedGuard(session));
    const tab = openChanged();
    expect(closeWindow().asked).toBe(true);
    expect(reloadHeld()).toBe(true);

    const written = session.getSnapshot().tabs.find((item) => item.id === tab.id);
    if (written === undefined) throw new Error('no tab');
    draftWritten(written);
    expect(closeWindow().asked).toBe(false);
    expect(reloadHeld()).toBe(false);

    session.setOverlays(tab.id, { marks: 1 }, 'ann.engineEdit');
    expect(closeWindow().asked).toBe(true);
    expect(reloadHeld()).toBe(true);
  });

  it('holds the reload, but does not ask on close, while an operation or a save is running', () => {
    renderHook(() => useUnsavedGuard(session));
    openTab(session);
    coreStore.set({ busy: true });
    expect(reloadHeld()).toBe(true);
    expect(closeWindow().asked).toBe(false);
    coreStore.set({ busy: false, operation: new AbortController() });
    expect(reloadHeld()).toBe(true);
    expect(closeWindow().asked).toBe(false);
    coreStore.set({ operation: null });
    expect(reloadHeld()).toBe(false);
  });

  it('stops asking and withdraws the reload guard when the window’s shell unmounts', () => {
    const { unmount } = renderHook(() => useUnsavedGuard(session));
    openChanged(true);
    expect(closeWindow().asked).toBe(true);
    expect(worker.release).not.toHaveBeenCalled();
    unmount();
    expect(worker.release).toHaveBeenCalledOnce();
    expect(closeWindow().asked).toBe(false);
  });
});
