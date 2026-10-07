import type { Page } from 'playwright/test';
import { openApp } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { deployableOrigin } from './web-shell-helpers';

/**
 * The shell around the editor: the update banner a new release raises, and the home screen's
 * recent list as it reads entries of every age and size.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const RECENT_KEY = 'pdf_editor_recent_docs_v1';

/** A service worker controls the page and a banner can be asked for. */
async function controlledPage(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/editor/`);
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
    timeout: 30_000,
  });
}

const checkForUpdate = (page: Page) =>
  page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration('/editor/'))?.update();
  });

test('a new release raises the update banner, which can be dismissed while the new worker keeps waiting', async ({
  page,
  baseURL,
}) => {
  const site = await deployableOrigin(baseURL ?? 'http://localhost:4178');
  try {
    await controlledPage(page, site.origin);
    const banner = page.getByRole('status').filter({ hasText: 'A new update is available' });
    await expect(banner).toBeHidden();

    site.release();
    await checkForUpdate(page);
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner.getByRole('button', { name: 'Refresh' })).toBeVisible();

    await banner.getByRole('button', { name: 'Close' }).click();
    await expect(banner).toBeHidden();
    // The worker is still waiting: dismissing the banner did not activate it.
    expect(
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/editor/');
        return registration?.waiting?.state;
      }),
    ).toBe('installed');
  } finally {
    await site.close();
  }
});

test('Refresh on the update banner hands over to the waiting worker and reloads onto it', async ({
  page,
  baseURL,
}) => {
  const site = await deployableOrigin(baseURL ?? 'http://localhost:4178');
  try {
    await controlledPage(page, site.origin);
    await page.evaluate(() => {
      Reflect.set(window, 'loadedBeforeUpdate', true);
    });
    site.release();
    await checkForUpdate(page);
    const banner = page.getByRole('status').filter({ hasText: 'A new update is available' });
    await expect(banner).toBeVisible({ timeout: 30_000 });

    await banner.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForFunction(() => !('loadedBeforeUpdate' in window), undefined, { timeout: 30_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await expect(banner).toBeHidden();
    expect(
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/editor/');
        return { waiting: registration?.waiting ?? null, active: registration?.active?.state };
      }),
    ).toEqual({ waiting: null, active: 'activated' });
  } finally {
    await site.close();
  }
});

test("the recent list words each entry's age and size the way a person would read them", async ({ page }) => {
  const now = Date.now();
  const entries = [
    { id: 'a', name: 'moments.pdf', sizeBytes: 900, openedAt: now - 10_000, pageCount: 2 },
    { id: 'b', name: 'minutes.pdf', sizeBytes: 2048, openedAt: now - 5 * 60_000 },
    { id: 'c', name: 'hours.pdf', sizeBytes: 3 * 1024 * 1024, openedAt: now - 3 * 3_600_000 },
    { id: 'd', name: 'days.pdf', sizeBytes: 1536, openedAt: now - 2 * 86_400_000 },
    { id: 'e', name: 'long-ago.pdf', sizeBytes: 10, openedAt: Date.UTC(2020, 5, 15, 12) },
  ];
  await page.addInitScript(
    ([key, value]) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    [RECENT_KEY, JSON.stringify(entries)] as const,
  );
  await page.goto('/editor/');

  const row = (name: string) => page.getByRole('row').filter({ hasText: name });
  await expect(row('moments.pdf')).toContainText('now');
  await expect(row('moments.pdf')).toContainText('900 B');
  await expect(row('moments.pdf').getByRole('cell').nth(2)).toHaveText('2');
  await expect(row('minutes.pdf')).toContainText('5 minutes ago');
  await expect(row('minutes.pdf')).toContainText('2.0 KB');
  // An entry written before page counts were stored shows a dash, not a zero.
  await expect(row('minutes.pdf').getByRole('cell').nth(2)).toHaveText('—');
  await expect(row('hours.pdf')).toContainText('3 hours ago');
  await expect(row('hours.pdf')).toContainText('3.0 MB');
  await expect(row('days.pdf')).toContainText('2 days ago');
  await expect(row('days.pdf')).toContainText('1.5 KB');
  await expect(row('long-ago.pdf')).toContainText('Jun 15, 2020');
  await expect(row('long-ago.pdf').locator('time')).toHaveAttribute('datetime', /^2020-06-15T/);

  // Size sort orders by bytes, largest first.
  await page.getByRole('combobox', { name: 'Sort' }).selectOption('size');
  await expect(page.locator('tbody tr td:nth-child(2) span.truncate')).toHaveText([
    'hours.pdf',
    'minutes.pdf',
    'days.pdf',
    'moments.pdf',
    'long-ago.pdf',
  ]);
});

test('the start cards for images, merging, converting, scanning and batches each open their own workflow', async ({
  page,
}) => {
  await page.goto('/editor/');
  const cards: readonly (readonly [string, RegExp])[] = [
    ['PDF from images', /Images/i],
    ['Merge PDFs', /Merge/i],
    ['Convert to PDF', /Convert/i],
    ['Scan with camera', /Scan/i],
    ['Batch processing', /Batch/i],
  ];
  for (const [card, heading] of cards) {
    await page.getByRole('button', { name: new RegExp(`^${card}`) }).click();
    const surface = page.getByRole('dialog').or(page.getByRole('region', { name: heading }));
    await expect(surface.first()).toBeVisible({ timeout: 30_000 });
    await expect(surface.first()).toContainText(heading);
    await page.keyboard.press('Escape');
    await expect(surface.first()).toBeHidden();
  }
});

test('a document opened and then listed shows its page count and size on the home screen', async ({
  page,
}) => {
  await openApp(page, 'counted.pdf', labelledPdf('Counted', 3), { advanced: false });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'counted.pdf' });
  await expect(row.getByRole('cell').nth(2)).toHaveText('3');
  await expect(row.getByRole('cell').nth(4)).toContainText(/\d+(\.\d)? KB/);
});
