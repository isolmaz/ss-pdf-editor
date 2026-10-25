import { useEffect, useState } from 'react';

/** What the update banner shows. */
export interface UpdateState {
  /** A new version is waiting, or is already running behind a page that still holds the old one. */
  readonly available: boolean;
  /**
   * The new worker took over, but this page was not reloaded onto it: it holds work a reload
   * would lose, so the banner asks for a save and a reload instead of reloading by itself.
   */
  readonly held: boolean;
}

const NO_UPDATE: UpdateState = { available: false, held: false };

let waitingWorker: ServiceWorker | null = null;
let updateState: UpdateState = NO_UPDATE;
let reloadBlocked: (() => boolean) | null = null;
const listeners = new Set<(state: UpdateState) => void>();

function publish(state: UpdateState) {
  updateState = state;
  for (const listener of listeners) {
    listener(state);
  }
}

/**
 * Register the check that says whether a reload now would lose work: unsaved changes no draft
 * holds, or an operation still running. A worker that takes over while it answers `true` does
 * not reload the page (see `initServiceWorkerUpdates`). Returns the function that withdraws it,
 * which leaves a check registered since then alone.
 */
export function guardReload(blocked: () => boolean): () => void {
  reloadBlocked = blocked;
  return () => {
    if (reloadBlocked === blocked) reloadBlocked = null;
  };
}

export function initServiceWorkerUpdates(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const trackInstalling = (worker: ServiceWorker) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        waitingWorker = worker;
        publish({ available: true, held: false });
      }
    });
  };

  navigator.serviceWorker
    .register('/sw.js', { scope: '/editor/' })
    .then((registration) => {
      // 1. Check if there is already a waiting worker
      if (registration.waiting && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting;
        publish({ available: true, held: false });
      }

      // 2. Follow a worker that is already installing, and listen for newly installing ones
      if (registration.installing) {
        trackInstalling(registration.installing);
      }
      registration.addEventListener('updatefound', () => {
        if (registration.installing) {
          trackInstalling(registration.installing);
        }
      });

      // 3. Periodic check for updates every 15 minutes
      setInterval(
        () => {
          registration.update().catch(() => undefined);
        },
        15 * 60 * 1000,
      );

      // 4. Check for updates when user returns to tab
      //
      // Neither is torn down: a page that unloads takes its timer and listener with it, and
      // `beforeunload` is no sign of that any more — the user may decline the question
      // `useUnsavedGuard` asks and stay, and that page must keep looking for updates.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          registration.update().catch(() => undefined);
        }
      });
    })
    .catch(() => undefined);

  // Reload only when a new service worker replaces an existing controller (update),
  // never on the initial claim of a first-time install. The first claim is what makes a
  // page controlled, so every change after it is a replacement: a visit that began
  // uncontrolled (the very first one) must reload on its first update too.
  //
  // A worker that takes over answers *every* open page of the editor, not only the one whose
  // banner was pressed. A page that holds work a reload would lose (see `guardReload`) is left
  // on its old code instead, and its banner asks for a save and a reload.
  let controlled = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const replacing = controlled;
    controlled = true;
    if (refreshing || !replacing) return;
    // Whatever waited has taken over: nothing is left to skip the wait of.
    waitingWorker = null;
    if (reloadBlocked?.() === true) {
      publish({ available: true, held: true });
      return;
    }
    refreshing = true;
    window.location.reload();
  });
}

/** The banner's "refresh": let the waiting worker take over, or reload when none waits. */
export function reloadToUpdate(): void {
  if (waitingWorker) {
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  } else {
    window.location.reload();
  }
}

/**
 * The banner's "close". It closes the update for the whole page, not for the one banner that
 * rendered it: a banner mounted again later must not bring back what the user dismissed. The
 * next worker to finish installing offers its update again.
 */
export function dismissUpdate(): void {
  publish(NO_UPDATE);
}

export function useServiceWorkerUpdate(): {
  updateAvailable: boolean;
  /** The page was left on its old code because it holds unsaved work: save it, then reload. */
  reloadHeld: boolean;
  reloadToUpdate: () => void;
  dismissUpdate: () => void;
} {
  const [state, setState] = useState(updateState);

  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  return {
    updateAvailable: state.available,
    reloadHeld: state.held,
    reloadToUpdate,
    dismissUpdate,
  };
}
