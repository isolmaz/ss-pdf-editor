/**
 * Driving code of the `app15-*.spec.ts` specs: a save picker the test holds open, and files
 * handed to the home screen's input that are too big to ship through the test protocol.
 */

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
