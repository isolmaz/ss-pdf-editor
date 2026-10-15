import type { SessionStore } from 'pdf-model';
import { useEffect } from 'react';
import { guardReload } from '../../serviceWorkerUpdate';
import { isBusy, operationRunning } from '../core/core-store';
import { holdsUnprotectedWork } from './persistence-store';

/**
 * What the window does about work a draft does not protect (`holdsUnprotectedWork`):
 *
 * - closing or reloading it asks first, with the browser's own question. A document that is
 *   protected — its latest state is in the vault — never asks: the draft is the answer.
 * - a service worker that takes over does not reload it. The worker answers every open page of
 *   the editor at once, so one page's "Refresh" must not reload the others under work a reload
 *   would lose; the same goes for a page with an operation or a save still running. Its banner
 *   asks for a save and a reload instead (`serviceWorkerUpdate.ts`).
 *
 * Both read the session when the event arrives, never a value captured at render.
 */
export function useUnsavedGuard(store: SessionStore): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!holdsUnprotectedWork(store.getSnapshot())) return;
      // `preventDefault` is the standard request for the question; the empty `returnValue` is
      // what browsers that predate it still look for.
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    const releaseReload = guardReload(
      () => holdsUnprotectedWork(store.getSnapshot()) || isBusy() || operationRunning(),
    );
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      releaseReload();
    };
  }, [store]);
}
