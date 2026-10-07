/**
 * A stall in the one place startup recovery waits on that nothing else does: the browser's
 * IndexedDB store of file handles (`recent-handles.ts`). Recovery reads it for every draft it
 * brings back, between deciding to restore and putting the tab in, so holding the answer opens
 * the window in which the user can open a document of their own — deterministically, where a
 * real browser answers in a millisecond and the overlap is a coin toss.
 *
 * `holdRecentHandlesOnNextLoad(page)` installs an init script. The hold is only active in a page
 * load that started after `armed` was set (a `sessionStorage` flag, which survives `reload()`),
 * so the first load, where the document is opened and its draft written, behaves as shipped.
 */

import type { Page } from 'playwright/test';

const FLAG = 'hold-recent-handles';

function installGate(flag: string): void {
  if (window.sessionStorage.getItem(flag) !== '1') return;
  const open = Promise.withResolvers<void>();
  const held = new WeakSet<IDBRequest>();
  Reflect.set(window, '__recentHandlesRelease', () => open.resolve());

  const originalOpen = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
    const request = originalOpen.call(this, name, version);
    if (name === 'pdf-editor-recent') {
      held.add(request);
      Reflect.set(window, '__recentHandlesReached', true);
    }
    return request;
  };

  const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
  if (success?.set === undefined || success.get === undefined) throw new Error('no onsuccess accessor');
  const { get, set } = success;
  Object.defineProperty(IDBRequest.prototype, 'onsuccess', {
    configurable: true,
    enumerable: true,
    get() {
      return get.call(this);
    },
    set(this: IDBRequest, handler: ((event: Event) => unknown) | null) {
      if (handler === null || !held.has(this)) {
        set.call(this, handler);
        return;
      }
      set.call(this, (event: Event) => {
        void open.promise.then(() => handler.call(this, event));
      });
    },
  });
}

export interface RecentHandlesGate {
  /** Resolves once recovery is waiting on the handle store. */
  reached(): Promise<void>;
  release(): Promise<void>;
}

/** Install before the first navigation; call `arm()` right before the reload that should stall. */
export async function holdRecentHandlesOnNextLoad(
  page: Page,
): Promise<RecentHandlesGate & { arm(): Promise<void> }> {
  await page.addInitScript(installGate, FLAG);
  return {
    arm: async () => {
      await page.evaluate((flag) => window.sessionStorage.setItem(flag, '1'), FLAG);
    },
    reached: async () => {
      await page.waitForFunction(() => Reflect.get(window, '__recentHandlesReached') === true, undefined, {
        timeout: 30_000,
      });
    },
    release: async () => {
      await page.evaluate(() => {
        const release: unknown = Reflect.get(window, '__recentHandlesRelease');
        if (typeof release !== 'function') throw new Error('the handle store is not held');
        release();
      });
    },
  };
}
