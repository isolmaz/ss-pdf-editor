/**
 * Driving code of the `app15-*.spec.ts` specs: a save picker the test holds open, and files
 * handed to the home screen's input that are too big to ship through the test protocol.
 */

import { createServer } from 'node:http';
import type { Page } from 'playwright/test';

/**
 * Wrap the save picker `installPickers` put on the page so it stays open until the test
 * releases it: a user can leave the real one open for minutes. Must run after `installPickers`
 * and before the page loads. `window.__saveCalls` counts the pickers the application opened;
 * `window.__releaseSave()` answers the open one the way the plain stand-in would (the next
 * staged file, or a cancelled picker when none is queued).
 */
export async function holdSavePicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const inner: (options: unknown) => Promise<unknown> = Reflect.get(window, 'showSaveFilePicker');
    const gate = Promise.withResolvers<void>();
    Object.assign(window, {
      __saveCalls: 0,
      __releaseSave: () => gate.resolve(),
      showSaveFilePicker: async (options: unknown) => {
        Reflect.set(window, '__saveCalls', Number(Reflect.get(window, '__saveCalls')) + 1);
        await gate.promise;
        return inner(options);
      },
    });
  });
}

/**
 * Hand the home screen's file input a zero-filled file of `bytes` bytes, built inside the
 * page: the browser's own `File`, never read by the test process.
 */
export async function offerHugeFile(page: Page, name: string, bytes: number): Promise<void> {
  await page.evaluate(
    ({ name, bytes }) => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*="application/pdf"]');
      if (input === null) throw new Error('the home screen has no file input');
      const transfer = new DataTransfer();
      // Repeated references to one 1 MiB blob: the file is large without ever holding that much memory.
      const mebibyte = new Blob([new ArrayBuffer(1024 * 1024)]);
      const whole = Math.floor(bytes / mebibyte.size);
      const parts = [
        ...Array.from({ length: whole }, () => mebibyte),
        new Uint8Array(bytes - whole * mebibyte.size),
      ];
      transfer.items.add(new File(parts, name, { type: 'application/pdf' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { name, bytes },
  );
}

/**
 * The preview server, fronted by a second origin that can ship "a new release": once
 * `release()` is called it serves `/sw.js` with extra bytes, which is all a deploy is to the
 * browser. Playwright's own routing cannot stand in for this: a worker's script fetch (and its
 * periodic update check) never passes through `page.route`.
 */
export async function deployableOrigin(upstream: string): Promise<{
  readonly origin: string;
  readonly release: () => void;
  readonly close: () => Promise<void>;
}> {
  let released = false;
  const server = createServer((request, response) => {
    void (async () => {
      const answer = await fetch(new URL(request.url ?? '/', upstream), {
        headers: { accept: request.headers.accept ?? '*/*' },
      });
      const headers = Object.fromEntries(
        [...answer.headers].filter(
          ([name]) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(name),
        ),
      );
      let body = Buffer.from(await answer.arrayBuffer());
      if (released && new URL(request.url ?? '/', upstream).pathname === '/sw.js') {
        body = Buffer.concat([body, Buffer.from('\n// release 2\n')]);
      }
      response.writeHead(answer.status, headers);
      response.end(body);
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stand-in origin has no port');
  return {
    origin: `http://localhost:${address.port}`,
    release: () => {
      released = true;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
