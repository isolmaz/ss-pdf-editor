/**
 * The page's side of a service-worker update, driven with an event-target fake of the
 * browser's `ServiceWorkerContainer` (Node has none). What matters: the banner is offered
 * only when a new worker waits behind a controlling one, the first-ever claim never
 * reloads the page, and the "update" action tells the waiting worker to take over.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWorker extends EventTarget {
  state = 'installing';
  readonly messages: unknown[] = [];
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updates = 0;
  failUpdate = false;
  update(): Promise<void> {
    this.updates += 1;
    return this.failUpdate ? Promise.reject(new Error('offline')) : Promise.resolve();
  }
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  registered: { url: string; options: unknown }[] = [];
  registration = new FakeRegistration();
  failRegister = false;
  register(url: string, options: unknown): Promise<FakeRegistration> {
    this.registered.push({ url, options });
    return this.failRegister ? Promise.reject(new Error('no sw')) : Promise.resolve(this.registration);
  }
}

class FakeDocument extends EventTarget {
  visibilityState = 'visible';
}

class FakeWindow extends EventTarget {
  reloads = 0;
  location = {
    reload: () => {
      this.reloads += 1;
    },
  };
}

let container: FakeContainer;
let fakeWindow: FakeWindow;
let fakeDocument: FakeDocument;

async function freshModule() {
  vi.resetModules();
  // Dynamic on purpose: the module keeps its state at module level, and each test needs a pristine copy.
  return await import('./serviceWorkerUpdate');
}

/** Lets the registration promise chain run; no clock involved. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** What the update banner's hook reports on first render. */
function bannerState(useServiceWorkerUpdate: () => { updateAvailable: boolean }): boolean {
  function Probe() {
    return <span>{String(useServiceWorkerUpdate().updateAvailable)}</span>;
  }
  return renderToStaticMarkup(<Probe />).includes('true');
}

beforeEach(() => {
  container = new FakeContainer();
  fakeWindow = new FakeWindow();
  fakeDocument = new FakeDocument();
  vi.stubGlobal('navigator', { serviceWorker: container });
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('document', fakeDocument);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('initServiceWorkerUpdates', () => {
  it('does nothing in a browser without service workers', async () => {
    vi.stubGlobal('navigator', {});
    const { initServiceWorkerUpdates } = await freshModule();
    initServiceWorkerUpdates();
    expect(container.registered).toEqual([]);
  });

  it('does nothing without a window', async () => {
    vi.stubGlobal('window', undefined);
    const { initServiceWorkerUpdates } = await freshModule();
    initServiceWorkerUpdates();
    expect(container.registered).toEqual([]);
  });

  it('registers the worker for the editor scope', async () => {
    const { initServiceWorkerUpdates } = await freshModule();
    initServiceWorkerUpdates();
    expect(container.registered).toEqual([{ url: '/sw.js', options: { scope: '/editor/' } }]);
  });

  it('swallows a failed registration', async () => {
    container.failRegister = true;
    const { initServiceWorkerUpdates } = await freshModule();
    initServiceWorkerUpdates();
    await settle();
    expect(container.registered).toHaveLength(1);
  });

  it('offers the update at once when a worker is already waiting behind a controller, and "update" skips its wait', async () => {
    container.controller = new FakeWorker();
    container.registration.waiting = new FakeWorker();
    const { initServiceWorkerUpdates, reloadToUpdate, useServiceWorkerUpdate } = await freshModule();
    expect(bannerState(useServiceWorkerUpdate)).toBe(false);
    initServiceWorkerUpdates();
    await settle();
    expect(bannerState(useServiceWorkerUpdate)).toBe(true);
    reloadToUpdate();
    expect(container.registration.waiting.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(fakeWindow.reloads).toBe(0);
  });

  it('ignores a waiting worker when nothing controls the page yet', async () => {
    container.registration.waiting = new FakeWorker();
    const { initServiceWorkerUpdates, reloadToUpdate, useServiceWorkerUpdate } = await freshModule();
    initServiceWorkerUpdates();
    await settle();
    expect(bannerState(useServiceWorkerUpdate)).toBe(false);
    reloadToUpdate();
    expect(container.registration.waiting.messages).toEqual([]);
    expect(fakeWindow.reloads).toBe(1);
  });

  it('tracks a new installing worker and offers the update once it is installed behind a controller', async () => {
    container.controller = new FakeWorker();
    const { initServiceWorkerUpdates, reloadToUpdate } = await freshModule();
    initServiceWorkerUpdates();
    await settle();
    // `updatefound` with nothing installing is ignored.
    container.registration.dispatchEvent(new Event('updatefound'));
    const incoming = new FakeWorker();
    container.registration.installing = incoming;
    container.registration.dispatchEvent(new Event('updatefound'));
    // Not yet installed: still nothing to skip.
    incoming.dispatchEvent(new Event('statechange'));
    reloadToUpdate();
    expect(incoming.messages).toEqual([]);
    expect(fakeWindow.reloads).toBe(1);
    incoming.state = 'installed';
    incoming.dispatchEvent(new Event('statechange'));
    reloadToUpdate();
    expect(incoming.messages).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('does not offer an installed worker when it is the first one on the page', async () => {
    const { initServiceWorkerUpdates, reloadToUpdate } = await freshModule();
    initServiceWorkerUpdates();
    await settle();
    const incoming = new FakeWorker();
    container.registration.installing = incoming;
    container.registration.dispatchEvent(new Event('updatefound'));
    incoming.state = 'installed';
    incoming.dispatchEvent(new Event('statechange'));
    reloadToUpdate();
    expect(incoming.messages).toEqual([]);
  });

  it('checks for an update every 15 minutes and when the tab becomes visible again, and stops on unload', async () => {
    vi.useFakeTimers();
    const { initServiceWorkerUpdates } = await freshModule();
    initServiceWorkerUpdates();
    await vi.advanceTimersByTimeAsync(0);
    expect(container.registration.updates).toBe(0);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(container.registration.updates).toBe(1);

    fakeDocument.visibilityState = 'hidden';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(container.registration.updates).toBe(1);
    fakeDocument.visibilityState = 'visible';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(container.registration.updates).toBe(2);

    container.registration.failUpdate = true;
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(container.registration.updates).toBe(4);

    fakeWindow.dispatchEvent(new Event('beforeunload'));
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(container.registration.updates).toBe(4);
  });

  it('reloads once when a new worker replaces the controller, never on the first claim', async () => {
    const { initServiceWorkerUpdates } = await freshModule();
    initServiceWorkerUpdates();
    await settle();
    // The page started uncontrolled: the first claim must not reload ...
    container.dispatchEvent(new Event('controllerchange'));
    expect(fakeWindow.reloads).toBe(0);
    // ... but the next change is a replacement, and it reloads exactly once.
    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));
    expect(fakeWindow.reloads).toBe(1);
  });

  it('reloads on the first controller change of a page that already had a controller', async () => {
    container.controller = new FakeWorker();
    const { initServiceWorkerUpdates } = await freshModule();
    initServiceWorkerUpdates();
    await settle();
    container.dispatchEvent(new Event('controllerchange'));
    expect(fakeWindow.reloads).toBe(1);
  });
});
