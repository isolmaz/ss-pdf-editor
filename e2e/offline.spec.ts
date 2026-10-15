import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright/test';
import { exportBytes, notice, openApp, rotateCurrentPage } from './app-helpers';
import { expect, test } from './test';
import { readProducedEntry, readProducedPageTexts, scannedPdf, toolFixturePdf } from './tool-fixture';
import { detailsButton, finishRun } from './ui-helpers';

/** Every script and style the build put under `/editor/assets/` — what the editor can load. */
const BUILT_CHUNKS = readdirSync(fileURLToPath(new URL('../dist/editor/assets/', import.meta.url)))
  .filter((name) => !name.endsWith('.map'))
  .map((name) => `/editor/assets/${name}`);

/** Wait for the worker to control the page, then open Settings → Offline use. */
async function openOfflineSettings(page: Page): Promise<Locator> {
  // Registration waits for an idle moment and the install fetches the shell: both stretch on a
  // busy machine, so the wait is generous and costs nothing when the worker is quick.
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
    timeout: 120_000,
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: /Settings/ });
  await expect(settings).toBeVisible();
  return settings;
}

/** Settings → Prepare, as a first-visit user does: the worker fetches, then says how many files. */
async function prepare(page: Page, settings: Locator): Promise<void> {
  await settings.getByRole('button', { name: 'Prepare', exact: true }).click();
  await expect(notice(page, /^\d+ file\(s\) prepared for offline use\.$/)).toBeVisible({ timeout: 180_000 });
}

/**
 * What the page asks the service worker the way the shell does (`apps/web/src/offline.ts`): a message with a reply
 * port. `PREPARE_PACKAGE` names capabilities of the build's manifest; `CHECK_READINESS` asks what the cache holds.
 */
const askWorker = <Reply>(page: Page, message: Record<string, unknown>): Promise<Reply> =>
  page.evaluate(
    (payload) =>
      new Promise<Reply>((resolve, reject) => {
        const worker = navigator.serviceWorker.controller;
        if (worker === null) {
          reject(new Error('no service worker controls the page'));
          return;
        }
        const channel = new MessageChannel();
        channel.port1.onmessage = (event: MessageEvent<Reply>) => resolve(event.data);
        worker.postMessage(payload, [channel.port2]);
      }),
    message,
  );

/** The worker's answer to `CHECK_READINESS`: for each capability, whether the cache holds all of it. */
interface Readiness {
  readonly capabilities: Record<string, { readonly ready: boolean; readonly missing: string[] }>;
}

/** The lines of the scanned page OCR has to read back with the network off. */
const SCAN_LINES = ['Invoice 2041', 'Total 318.40', 'Payment due Friday'] as const;

/** The OCR form, opened through the palette (the same steps `ocr.spec.ts` takes online). */
const ocrForm = (page: Page): Locator => page.getByRole('region', { name: /Metin tanıma|Text recognition/ });

async function openOcrForm(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder(/Komut veya araç ara|Search commands/);
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill('OCR');
  await expect(page.getByRole('option', { name: /Metin tanıma|Text recognition/ }).first()).toBeVisible({
    timeout: 10_000,
  });
  await page.keyboard.press('Enter');
  await expect(ocrForm(page)).toBeVisible({ timeout: 15_000 });
}

/** The pathnames the worker's cache holds. */
const cachedPaths = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });

/**
 * The offline contract against the built distribution.
 *
 * What is asserted is the real thing and not a plausibility check: the worker registers and
 * takes control, the build's own manifest names the release, the cache it opened carries
 * that release in its name, and a reload with the network switched off is served from it.
 * The manifest version and the cache name are produced together by `tools/assemble-dist.mjs`
 * from `tools/asset-pins.json`, so a drift between them is a real defect, not a test
 * detail. If the offline reload cannot be made reliable in an environment, that has to be
 * reported — not silenced by dropping the assertion.
 */
test.describe('offline shell', { tag: '@service-worker' }, () => {
  test('the worker controls the page and the versioned cache matches the manifest', async ({ page }) => {
    await page.goto('/editor/');
    await expect(page.getByText('SsPdfEditor')).toBeVisible();

    // Registration happens on idle, so this waits for install + activate + `clients.claim()`.
    await page.waitForFunction(
      async () => {
        const registration = await navigator.serviceWorker?.ready;
        return registration !== undefined && navigator.serviceWorker.controller !== null;
      },
      undefined,
      { timeout: 30_000 },
    );

    const manifest = await page.evaluate(async () => {
      const response = await fetch('/offline-manifest.json', { cache: 'no-store' });
      return (await response.json()) as { version: string; capabilities: Record<string, string[]> };
    });
    expect(manifest.version).toMatch(/^[\w.+-]+-[\da-f]{12}$/);
    expect(Object.keys(manifest.capabilities).length).toBeGreaterThan(0);

    const cacheKeys = await page.evaluate(() => caches.keys());
    expect(cacheKeys).toContain(`pdf-editor-static-${manifest.version}`);
  });

  test('a reload with the network off is served by the versioned cache', async ({ page, context }) => {
    await page.goto('/editor/');
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 30_000,
    });

    await context.setOffline(true);
    try {
      await page.reload();
      // The shell's own bytes came out of the cache: the document still paints and the home
      // screen's controls are interactive.
      await expect(page.getByText('SsPdfEditor')).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Start', exact: true })).toBeVisible();
      // And in its own type: the interface's fonts came out of the cache too. The first
      // visit fetched them before the worker controlled the page, so only the worker's
      // install can have cached them.
      const failedFaces = await page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts]
          .filter((face) => face.status === 'error')
          .map((face) => `${face.family} ${face.weight}`);
      });
      expect(failedFaces).toEqual([]);
      expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    } finally {
      await context.setOffline(false);
    }
  });

  // A first visit loads the editor's scripts before the worker controls the page, and a tool's
  // code is fetched only when the tool is opened: neither lands in the cache by itself. Prepare
  // is the promise that they do, and "ready" is only true when they are.
  test('a first-visit user who prepared opens, rotates and exports a PDF with the network off', async ({
    page,
    context,
  }) => {
    await page.goto('/editor/');
    const settings = await openOfflineSettings(page);
    await prepare(page, settings);
    await settings.getByRole('button', { name: 'Check status', exact: true }).click();
    await expect(notice(page, 'Every package offline use needs is ready.')).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    const unserved: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 503) unserved.push(new URL(response.url()).pathname);
    });
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByRole('tab', { name: 'Start', exact: true })).toBeVisible({ timeout: 30_000 });
      await openApp(page, 'offline.pdf', toolFixturePdf(), { navigate: false, advanced: false });
      await rotateCurrentPage(page);
      const out = await exportBytes(page, 'offline-out.pdf');
      expect(await readProducedEntry(out, 0, 'Rotate')).toBe('90');
    } catch (error) {
      throw new Error(
        `offline job failed; the worker answered 503 for: ${unserved.join(', ') || 'nothing'}`,
        {
          cause: error,
        },
      );
    } finally {
      await context.setOffline(false);
    }
    expect(unserved).toEqual([]);
  });

  // OCR is the one package Prepare leaves out (it is cached when first used), but the manifest lists it
  // as the `tesseract` capability and a device can hold it. Whether OCR then runs with the network off
  // is decided before the first page: the run starts by asking whether the language pack is there.
  // That question used to be a HEAD request, which the worker does not answer (it answers GETs only), so
  // a device holding the whole package was told the pack was missing.
  test('a device that holds the OCR package recognises a scanned page with the network off', async ({
    page,
    context,
  }) => {
    test.setTimeout(900_000);
    await page.goto('/editor/');
    const settings = await openOfflineSettings(page);
    await prepare(page, settings);
    const prepared = await askWorker<{ type: string; failed: string[] }>(page, {
      type: 'PREPARE_PACKAGE',
      capabilities: ['tesseract'],
    });
    expect(prepared).toMatchObject({ type: 'PREPARE_DONE', failed: [] });
    const readiness = await askWorker<Readiness>(page, { type: 'CHECK_READINESS' });
    expect(readiness.capabilities.tesseract).toEqual({ ready: true, missing: [] });
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    const unserved: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 503) unserved.push(new URL(response.url()).pathname);
    });
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByRole('tab', { name: 'Start', exact: true })).toBeVisible({ timeout: 30_000 });
      await openApp(page, 'scan.pdf', await scannedPdf([SCAN_LINES]), { navigate: false });
      await openOcrForm(page);
      const run = page.getByRole('button', { name: /^Uygula$|^Apply$/ }).first();
      await expect(run).toBeEnabled({ timeout: 120_000 });
      await run.click();

      // The run read the page: a refusal ("the language pack is missing") ends in no result at all.
      await finishRun(page, 300_000);
      await detailsButton(page).click();
      const report = page.getByRole('region', { name: /İşlem raporu|Operation report/ });
      await expect(report).toBeVisible();
      const layer = report.getByText(/Invisible text layer of \d+ word\(s\) added to \d+ page\(s\)/);
      await expect(layer).toBeVisible({ timeout: 30_000 });
      const counts = /of (\d+) word\(s\) added to (\d+) page\(s\)/.exec((await layer.textContent()) ?? '');
      expect(Number(counts?.[1] ?? 0)).toBeGreaterThan(4);
      expect(Number(counts?.[2] ?? 0)).toBe(1);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /^(Kapat|Close)$/ })
        .click();

      // The words are in the bytes the user takes away, in reading order: the scan had no text at all.
      const out = await exportBytes(page, 'offline-ocr-out.pdf');
      const [text] = await readProducedPageTexts(out, 1);
      expect((text ?? '').replace(/\s+/g, ' ')).toMatch(/Invoice 2041.*Total 318\.40.*Payment due Friday/);
    } catch (error) {
      throw new Error(
        `offline OCR failed; the worker answered 503 for: ${unserved.join(', ') || 'nothing'}`,
        { cause: error },
      );
    } finally {
      await context.setOffline(false);
    }
    expect(unserved).toEqual([]);
  });

  test('Prepare caches every chunk the build ships, and the readiness check names one the cache lost', async ({
    page,
  }) => {
    await page.goto('/editor/');
    const settings = await openOfflineSettings(page);
    await prepare(page, settings);
    expect(BUILT_CHUNKS.length).toBeGreaterThan(0);
    const held = new Set(await cachedPaths(page));
    expect(BUILT_CHUNKS.filter((path) => !held.has(path))).toEqual([]);

    // A chunk the cache lost (evicted storage, a half-finished earlier pass) is not "ready".
    const lost = BUILT_CHUNKS.find((path) => /\/pdf-[\w-]+\.js$/.test(path));
    if (lost === undefined) throw new Error('the build has no pdf chunk to lose');
    await page.evaluate(async (path) => {
      for (const name of await caches.keys()) await (await caches.open(name)).delete(path);
    }, lost);
    await settings.getByRole('button', { name: 'Check status', exact: true }).click();
    await expect(notice(page, /^Missing capabilities \(1\): app\.$/)).toBeVisible({ timeout: 60_000 });

    // And Prepare puts it back.
    await prepare(page, settings);
    await settings.getByRole('button', { name: 'Check status', exact: true }).click();
    await expect(notice(page, 'Every package offline use needs is ready.')).toBeVisible({ timeout: 60_000 });
    expect(await cachedPaths(page)).toContain(lost);
  });

  // A release has a cache of its own, but a run-time load can still leave a chunk the manifest does
  // not list: what the build no longer ships must not pile up.
  test('Prepare deletes editor chunks the build no longer ships and keeps the ones it does', async ({
    page,
  }) => {
    await page.goto('/editor/');
    const settings = await openOfflineSettings(page);
    await prepare(page, settings);

    const stale = ['/editor/assets/superseded-0a1b2c3d.js', '/editor/assets/superseded-0a1b2c3d.css'];
    await page.evaluate(async (paths) => {
      const name = (await caches.keys()).find((key) => key.startsWith('pdf-editor-static-'));
      if (name === undefined) throw new Error('the worker has no static cache');
      const cache = await caches.open(name);
      for (const path of paths) await cache.put(path, new Response('/* from an older build */'));
    }, stale);
    expect(await cachedPaths(page)).toEqual(expect.arrayContaining(stale));

    // The first pass's "prepared" notice is still on screen, so the second pass is awaited
    // through the cache itself rather than through that notice.
    await settings.getByRole('button', { name: 'Prepare', exact: true }).click();
    await expect
      .poll(async () => (await cachedPaths(page)).filter((path) => stale.includes(path)), {
        timeout: 180_000,
      })
      .toEqual([]);
    const held = new Set(await cachedPaths(page));
    expect(BUILT_CHUNKS.filter((path) => !held.has(path))).toEqual([]);
    expect(held.has('/editor/index.html')).toBe(true);
  });
});
