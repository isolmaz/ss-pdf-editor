/**
 * Engine fault injection for the browser specs: make one chosen MuPDF or pdf.js call fail, or
 * hold it until the test lets go, inside the real running app and without touching product code.
 * Unit tests prove the engine-failure guards of `pdf-core` by proxying `loadMupdf`; this is the
 * same seam for the interface, so the notices a user would read after an engine failure (and the
 * state the document keeps) can be asserted.
 *
 * How it works. `injectEngineFaults(page)` (before the first navigation) installs
 *  - a route on `/engines/mupdf/mupdf.js` that serves a small ESM wrapper in its place. The wrapper
 *    imports the real module under `?real` (a URL the route lets through), wraps every method of
 *    every exported MuPDF class (instance and static, inherited ones included: a rule on
 *    `PDFDocument.loadPage` also catches the `Document.loadPage` it inherits) and re-exports the
 *    whole module. A wrapped method looks into `window.__engineFaults` on each call; a rule that
 *    matches throws `Error(message)` in place of the call, exactly where MuPDF's own
 *    `Error` would surface. Nothing is wrapped for a call no rule names, so the engine behaves as
 *    shipped until a test arms a rule.
 *  - an init script that puts `window.__engineFaults` in place and wraps `window.Worker`: pdf.js
 *    runs in a worker and every engine request is a message `{ action, callbackId }`; a matching
 *    rule answers that request with pdf.js's own error reply (`UnknownErrorException`) instead of
 *    forwarding it, or forwards it only once the test releases it.
 *
 * Calls are named `Class.method` (`PDFDocument.saveToBuffer`, `PDFPage.getObject`, statics as
 * `Document.static.openDocument`) for MuPDF and by pdf.js's message action (`GetAttachments`,
 * `GetPage`, `GetDocRequest`, `SaveDocument`…) for pdf.js. The special call `module` is the
 * MuPDF module load itself.
 *
 * Limits.
 *  - MuPDF methods are synchronous WebAssembly calls: they can fail but cannot be held. Its
 *    only holdable point is the module load (`module`), which stalls the first thing in the page
 *    that needs MuPDF. pdf.js requests are asynchronous: any of them can be held, but only the
 *    ones answered with a promise or a stream can be made to fail (a streamed `GetTextContent`
 *    fails on its first read).
 *  - A rule fires once by default (`times` for more). Rules live in the page: a reload starts clean.
 *    Only `module` rules can be armed before the first navigation.
 *  - Use `test.use({ serviceWorkers: 'block' })`: requests that pass a service worker are not seen
 *    by `page.route`.
 */

import type { Page, Route } from 'playwright/test';

export type FaultEngine = 'mupdf' | 'pdfjs';

/** One armed rule, as the page holds it. */
interface FaultRule {
  readonly engine: FaultEngine;
  readonly call: string;
  readonly kind: 'fail' | 'hold';
  readonly message: string;
  times: number;
  /** Matching calls still to let through before the rule starts to act. */
  skip: number;
  held: number;
  fired: number;
  readonly gate: Promise<void>;
  readonly open: () => void;
}

/** What `window.__engineFaults` offers the wrappers and the test. */
interface FaultTable {
  readonly rules: FaultRule[];
  /** Every pdf.js request the page sent, by action. */
  readonly requests: Record<string, number>;
  arm(
    engine: FaultEngine,
    call: string,
    kind: 'fail' | 'hold',
    message: string,
    times: number,
    skip: number,
  ): number;
  take(engine: FaultEngine, call: string, kinds: readonly ('fail' | 'hold')[]): FaultRule | null;
}

const MUPDF_URL = '/engines/mupdf/mupdf.js';

/** Installed in the page before any script runs: the rule table and the worker wrapper. */
function installTable(): void {
  const rules: FaultRule[] = [];
  const table: FaultTable = {
    rules,
    requests: {},
    arm(engine, call, kind, message, times, skip) {
      const gate = Promise.withResolvers<void>();
      rules.push({
        engine,
        call,
        kind,
        message,
        times,
        skip,
        held: 0,
        fired: 0,
        gate: gate.promise,
        open: () => gate.resolve(),
      });
      return rules.length - 1;
    },
    take(engine, call, kinds) {
      for (const rule of rules) {
        if (rule.engine === engine && rule.call === call && rule.times > 0 && kinds.includes(rule.kind)) {
          if (rule.skip > 0) {
            rule.skip -= 1;
            continue;
          }
          rule.times -= 1;
          rule.fired += 1;
          return rule;
        }
      }
      return null;
    },
  };
  Reflect.set(window, '__engineFaults', table);

  const NativeWorker = window.Worker;
  class FaultWorker extends NativeWorker {
    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
      const forward = (): void => {
        if (transfer === undefined) super.postMessage(message);
        else if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      };
      if (typeof message !== 'object' || message === null) {
        forward();
        return;
      }
      const action: unknown = Reflect.get(message, 'action');
      const callbackId: unknown = Reflect.get(message, 'callbackId');
      const streamId: unknown = Reflect.get(message, 'streamId');
      const target: unknown = Reflect.get(message, 'targetName');
      const source: unknown = Reflect.get(message, 'sourceName');
      if (typeof action !== 'string') {
        forward();
        return;
      }
      table.requests[action] = (table.requests[action] ?? 0) + 1;
      const rule = table.take(
        'pdfjs',
        action,
        callbackId === undefined && streamId === undefined ? ['hold'] : ['fail', 'hold'],
      );
      if (rule === null) {
        forward();
        return;
      }
      if (rule.kind === 'hold') {
        rule.held += 1;
        void rule.gate.then(forward);
        return;
      }
      // pdf.js's `MessageHandler` turns `{ callback: 2 (ERROR), reason }` into a rejected request and
      // `{ stream: 8 (START_COMPLETE), success: false, reason }` into a stream that fails on its first read.
      const reason = { name: 'UnknownErrorException', message: rule.message, details: rule.message };
      setTimeout(() => {
        this.dispatchEvent(
          new MessageEvent('message', {
            data:
              streamId === undefined
                ? { sourceName: target, targetName: source, callback: 2, callbackId, reason }
                : { sourceName: target, targetName: source, stream: 8, streamId, success: false, reason },
          }),
        );
      }, 0);
    }
  }
  Reflect.set(window, 'Worker', FaultWorker);
}

/**
 * The module that stands in for `/engines/mupdf/mupdf.js`. Plain JavaScript served to the page;
 * it runs in the page, so it reads `window.__engineFaults` like the worker wrapper does.
 */
const MUPDF_WRAPPER = `
import * as real from '${MUPDF_URL}?real';
export * from '${MUPDF_URL}?real';
export default real.default;

const table = () => globalThis.__engineFaults;

function wrap(owner, name, label, isStatic) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor === undefined || typeof descriptor.value !== 'function' || name === 'constructor') return;
  const original = descriptor.value;
  Object.defineProperty(owner, name, {
    ...descriptor,
    value: function (...args) {
      const faults = table();
      if (faults !== undefined && faults.rules.length > 0) {
        // The receiver's class and each of its ancestors may carry the rule.
        let current = isStatic ? this : this?.constructor;
        while (typeof current === 'function' && current !== Function.prototype) {
          const key = current.name + (isStatic ? '.static.' : '.') + name;
          const rule = faults.take('mupdf', key, ['fail']);
          if (rule !== null) throw new Error(rule.message);
          current = Object.getPrototypeOf(current);
        }
      }
      return original.apply(this, args);
    },
  });
}

for (const exported of Object.values(real)) {
  if (typeof exported !== 'function' || exported.prototype === undefined) continue;
  for (const name of Object.getOwnPropertyNames(exported.prototype)) wrap(exported.prototype, name, exported.name, false);
  for (const name of Object.getOwnPropertyNames(exported)) wrap(exported, name, exported.name, true);
}
`;

interface ModuleHold {
  readonly gate: Promise<void>;
  readonly open: () => void;
  reached: boolean;
}

interface PageState {
  /** Pending holds of the MuPDF module load, oldest first, and loads to refuse. */
  readonly holds: ModuleHold[];
  failLoads: number;
}

const states = new WeakMap<Page, PageState>();

function stateOf(page: Page): PageState {
  const state = states.get(page);
  if (state === undefined) throw new Error('injectEngineFaults(page) must run before arming a fault');
  return state;
}

/** Route the MuPDF module through the fault wrapper and install the in-page table. Call before `goto`. */
export async function injectEngineFaults(page: Page): Promise<void> {
  const state: PageState = { holds: [], failLoads: 0 };
  states.set(page, state);
  await page.addInitScript(installTable);
  await page.route(
    (url) => url.pathname === MUPDF_URL && !url.searchParams.has('real'),
    async (route: Route) => {
      if (state.failLoads > 0) {
        state.failLoads -= 1;
        await route.abort('failed');
        return;
      }
      const hold = state.holds.shift();
      if (hold !== undefined) {
        hold.reached = true;
        await hold.gate;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        headers: { 'cache-control': 'no-store' },
        body: MUPDF_WRAPPER,
      });
    },
  );
}

/** How the test releases a held call; `reached()` resolves once the application is waiting on it. */
export interface Hold {
  (): Promise<void>;
  reached(): Promise<void>;
}

async function arm(
  page: Page,
  engine: FaultEngine,
  call: string,
  kind: 'fail' | 'hold',
  message: string,
  times: number,
  skip = 0,
): Promise<number> {
  stateOf(page);
  if (page.url() === 'about:blank')
    throw new Error('in-page faults can only be armed after the first navigation');
  return page.evaluate(
    ({ engine, call, kind, message, times, skip }) => {
      const table: FaultTable = Reflect.get(window, '__engineFaults');
      return table.arm(engine, call, kind, message, times, skip);
    },
    { engine, call, kind, message, times, skip },
  );
}

/**
 * The next `times` calls of `call` fail with `message` (MuPDF: an `Error` thrown by the call;
 * pdf.js: the request rejects with `UnknownErrorException`). For `module` on MuPDF the next load
 * of the engine file is refused by the network, and `message` is unused. `skip` lets that many
 * matching calls through first (a flow whose earlier call must succeed).
 */
export async function failNext(
  page: Page,
  engine: FaultEngine,
  call: string,
  message: string,
  times = 1,
  skip = 0,
): Promise<void> {
  if (engine === 'mupdf' && call === 'module') {
    stateOf(page).failLoads += times;
    return;
  }
  await arm(page, engine, call, 'fail', message, times, skip);
}

/** How many times the rule armed by `failNext`/`holdNext` for this call has fired so far. */
export async function firedCount(page: Page, engine: FaultEngine, call: string): Promise<number> {
  return page.evaluate(
    ({ engine, call }) => {
      const table: FaultTable = Reflect.get(window, '__engineFaults');
      return table.rules
        .filter((rule) => rule.engine === engine && rule.call === call)
        .reduce((sum, rule) => sum + rule.fired, 0);
    },
    { engine, call },
  );
}

/**
 * The next call of `call` does not proceed until the returned function is called. MuPDF can only
 * hold `module` (see the limits above); pdf.js can hold any request action. May be armed before
 * the first navigation only for `mupdf` `module`.
 */
export async function holdNext(page: Page, engine: FaultEngine, call: string): Promise<Hold> {
  if (engine === 'mupdf') {
    if (call !== 'module')
      throw new Error('MuPDF methods are synchronous and cannot be held; only "module" can');
    const gate = Promise.withResolvers<void>();
    const hold: ModuleHold = { gate: gate.promise, open: () => gate.resolve(), reached: false };
    stateOf(page).holds.push(hold);
    const release = async (): Promise<void> => hold.open();
    release.reached = async (): Promise<void> => {
      const started = Date.now();
      while (!hold.reached) {
        if (Date.now() - started > 30_000) throw new Error('the MuPDF load was never requested');
        await page.waitForTimeout(25);
      }
    };
    return release;
  }
  const id = await arm(page, engine, call, 'hold', '', 1);
  const release = async (): Promise<void> => {
    await page.evaluate((id) => {
      const table: FaultTable = Reflect.get(window, '__engineFaults');
      table.rules[id]?.open();
    }, id);
  };
  release.reached = async (): Promise<void> => {
    await page.waitForFunction((id) => {
      const table: FaultTable = Reflect.get(window, '__engineFaults');
      return (table.rules[id]?.held ?? 0) > 0;
    }, id);
  };
  return release;
}

/** How many requests of this pdf.js action the page has sent so far (held and failed ones included). */
export async function requestCount(page: Page, action: string): Promise<number> {
  return page.evaluate((action) => {
    const table: FaultTable = Reflect.get(window, '__engineFaults');
    return table.requests[action] ?? 0;
  }, action);
}
