import { expect, test } from './test';

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
});
