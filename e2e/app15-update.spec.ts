import { deployableOrigin } from './app15-helpers';
import { expect, test } from './test';

/** The update banner's other answer: not now. */

test('dismissing the update banner hides it, keeps the page as it is, and leaves the new worker waiting', {
  tag: '@service-worker',
}, async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const site = await deployableOrigin(baseURL ?? 'http://localhost:4178');
  try {
    await page.goto(`${site.origin}/editor/`);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 90_000,
    });
    const banner = page.getByRole('status').filter({ hasText: 'A new update is available' });
    await expect(banner).toBeHidden();
    await page.evaluate(() => {
      Reflect.set(window, 'loadedBeforeUpdate', true);
    });

    site.release();
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration('/editor/'))?.update();
    });
    await expect(banner).toBeVisible({ timeout: 90_000 });

    await banner.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(banner).toBeHidden();
    // Not reloaded, and the release is still there for the next Refresh.
    expect(await page.evaluate(() => Reflect.get(window, 'loadedBeforeUpdate'))).toBe(true);
    expect(
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/editor/');
        return registration?.waiting !== null;
      }),
    ).toBe(true);
  } finally {
    await site.close();
  }
});
