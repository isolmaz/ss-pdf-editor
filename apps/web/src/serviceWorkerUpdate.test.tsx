/**
 * The page's side of a service-worker update, driven with an event-target fake of the
 * browser's `ServiceWorkerContainer` (Node has none). What matters: the banner is offered
 * only when a new worker waits behind a controlling one, the first-ever claim never
 * reloads the page, the "update" action tells the waiting worker to take over, a page that
 * holds work a reload would lose is left on its old code, and "close" closes the update for
 * the whole page until the next worker arrives.
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

/** Whether a banner rendered now asks for a save and a reload instead of offering the update. */
function bannerHeld(useServiceWorkerUpdate: () => { reloadHeld: boolean }): boolean {
  function Probe() {
    return <span>{String(useServiceWorkerUpdate().reloadHeld)}</span>;
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

  it('checks for an update every 15 minutes and when the tab becomes visible again, and a declined beforeunload question does not stop either', async () => {
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

    // The user declined the question `useUnsavedGuard` asked and stayed: the page keeps looking.
    fakeWindow.dispatchEvent(new Event('beforeunload'));
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(container.registration.updates).toBe(5);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(container.registration.updates).toBe(6);
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

describe('a worker that takes over a page holding work a reload would lose', () => {
  /** A page controlled by a worker, with a newer one waiting behind it. */
  async function controlledWithUpdate() {
    container.controller = new FakeWorker();
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;
    const module = await freshModule();
    return { ...module, waiting };
  }

  it('is left on its old code, and the banner asks for a save and a reload instead of offering the update', async () => {
    const { initServiceWorkerUpdates, guardReload, reloadToUpdate, useServiceWorkerUpdate, waiting } =
      await controlledWithUpdate();
    guardReload(() => true);
    initServiceWorkerUpdates();
    await settle();
    expect(bannerHeld(useServiceWorkerUpdate)).toBe(false);

    // Another window pressed "Refresh": the worker takes over every window of the editor.
    container.dispatchEvent(new Event('controllerchange'));

    expect(fakeWindow.reloads).toBe(0);
    expect(bannerState(useServiceWorkerUpdate)).toBe(true);
    expect(bannerHeld(useServiceWorkerUpdate)).toBe(true);
    // Nothing waits any more, so the banner's button reloads instead of skipping a wait again.
    reloadToUpdate();
    expect(waiting.messages).toEqual([]);
    expect(fakeWindow.reloads).toBe(1);
  });

  it('is asked at the moment the worker takes over, and a page left behind reloads once it may', async () => {
    const { initServiceWorkerUpdates, guardReload } = await controlledWithUpdate();
    let blocked = true;
    guardReload(() => blocked);
    initServiceWorkerUpdates();
    await settle();

    container.dispatchEvent(new Event('controllerchange'));
    expect(fakeWindow.reloads).toBe(0);
    blocked = false;
    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));
    expect(fakeWindow.reloads).toBe(1);
  });

  it('reloads as ever once its guard was withdrawn', async () => {
    const { initServiceWorkerUpdates, guardReload } = await controlledWithUpdate();
    initServiceWorkerUpdates();
    await settle();
    const withdraw = guardReload(() => true);
    withdraw();
    container.dispatchEvent(new Event('controllerchange'));
    expect(fakeWindow.reloads).toBe(1);
  });

  it('is still guarded when an older guard is withdrawn after a newer one replaced it', async () => {
    const { initServiceWorkerUpdates, guardReload } = await controlledWithUpdate();
    initServiceWorkerUpdates();
    await settle();
    const withdrawOlder = guardReload(() => false);
    guardReload(() => true);
    withdrawOlder();
    container.dispatchEvent(new Event('controllerchange'));
    expect(fakeWindow.reloads).toBe(0);
  });
});

describe('closing the update', () => {
  it('closes it for the whole page: a banner rendered later does not bring it back, the next worker does', async () => {
    container.controller = new FakeWorker();
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;
    const { initServiceWorkerUpdates, dismissUpdate, reloadToUpdate, useServiceWorkerUpdate } =
      await freshModule();
    initServiceWorkerUpdates();
    await settle();
    expect(bannerState(useServiceWorkerUpdate)).toBe(true);

    dismissUpdate();
    expect(bannerState(useServiceWorkerUpdate)).toBe(false);
    expect(bannerHeld(useServiceWorkerUpdate)).toBe(false);
    // Closing the banner is not skipping the wait: the worker is still there for a later "Refresh".
    reloadToUpdate();
    expect(waiting.messages).toEqual([{ type: 'SKIP_WAITING' }]);

    const incoming = new FakeWorker();
    container.registration.installing = incoming;
    container.registration.dispatchEvent(new Event('updatefound'));
    incoming.state = 'installed';
    incoming.dispatchEvent(new Event('statechange'));
    expect(bannerState(useServiceWorkerUpdate)).toBe(true);
    expect(bannerHeld(useServiceWorkerUpdate)).toBe(false);
  });

  it('closes a page left on its old code too, and a worker installed after offers the update plainly', async () => {
    container.controller = new FakeWorker();
    container.registration.waiting = new FakeWorker();
    const { initServiceWorkerUpdates, guardReload, dismissUpdate, useServiceWorkerUpdate } =
      await freshModule();
    guardReload(() => true);
    initServiceWorkerUpdates();
    await settle();
    container.dispatchEvent(new Event('controllerchange'));
    expect(bannerHeld(useServiceWorkerUpdate)).toBe(true);

    dismissUpdate();
    expect(bannerState(useServiceWorkerUpdate)).toBe(false);
    expect(bannerHeld(useServiceWorkerUpdate)).toBe(false);

    const incoming = new FakeWorker();
    container.registration.installing = incoming;
    container.registration.dispatchEvent(new Event('updatefound'));
    incoming.state = 'installed';
    incoming.dispatchEvent(new Event('statechange'));
    expect(bannerState(useServiceWorkerUpdate)).toBe(true);
    expect(bannerHeld(useServiceWorkerUpdate)).toBe(false);
  });
});
