import { useCallback, useEffect, useState } from 'react';

let waitingWorker: ServiceWorker | null = null;
let updateAvailableState = false;
const listeners = new Set<(available: boolean) => void>();

function notifyListeners(available: boolean) {
  updateAvailableState = available;
  for (const listener of listeners) {
    listener(available);
  }
}

export function initServiceWorkerUpdates(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const trackInstalling = (worker: ServiceWorker) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        waitingWorker = worker;
        notifyListeners(true);
      }
    });
  };

  navigator.serviceWorker
    .register('/sw.js', { scope: '/editor/' })
    .then((registration) => {
      // 1. Check if there is already a waiting worker
      if (registration.waiting && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting;
        notifyListeners(true);
      }

      // 2. Listen for newly installing workers
      registration.addEventListener('updatefound', () => {
        if (registration.installing) {
          trackInstalling(registration.installing);
        }
      });

      // 3. Periodic check for updates every 15 minutes
      const interval = setInterval(
        () => {
          registration.update().catch(() => undefined);
        },
        15 * 60 * 1000,
      );

      // 4. Check for updates when user returns to tab
      const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
          registration.update().catch(() => undefined);
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);

      window.addEventListener('beforeunload', () => {
        clearInterval(interval);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      });
    })
    .catch(() => undefined);

  // Reload only when a new service worker replaces an existing controller (update),
  // never on the initial claim of a first-time install. The first claim is what makes a
  // page controlled, so every change after it is a replacement: a visit that began
  // uncontrolled (the very first one) must reload on its first update too.
  let controlled = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const replacing = controlled;
    controlled = true;
    if (!refreshing && replacing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

export function reloadToUpdate(): void {
  if (waitingWorker) {
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  } else {
    window.location.reload();
  }
}

export function useServiceWorkerUpdate(): {
  updateAvailable: boolean;
  reloadToUpdate: () => void;
  dismissUpdate: () => void;
} {
  const [available, setAvailable] = useState(updateAvailableState);

  useEffect(() => {
    const listener = (next: boolean) => setAvailable(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const dismissUpdate = useCallback(() => {
    setAvailable(false);
  }, []);

  return {
    updateAvailable: available,
    reloadToUpdate,
    dismissUpdate,
  };
}
