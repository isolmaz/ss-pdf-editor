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

const pageBox = (page: Page) => page.getByRole('textbox', { name: 'Page number' });

test('the page number box takes a valid page, and an unusable or out-of-range entry leaves the page where it was', async ({
  page,
}) => {
  await openApp(page, 'nav.pdf', labelledPdf('Nav', 3), { advanced: false });
  await expect(page.getByText('/ 3', { exact: true })).toBeVisible();
  await expect(pageBox(page)).toHaveValue('1');

  for (const entry of ['99', '0', 'abc', '']) {
    await pageBox(page).fill(entry);
    await pageBox(page).press('Enter');
    await pageBox(page).blur();
    await expect(pageBox(page)).toHaveValue('1');
  }
  await pageBox(page).fill('3');
  await pageBox(page).press('Enter');
  await expect(pageBox(page)).toHaveValue('3');
  await expect(page.getByRole('button', { name: 'Next Page' })).toBeDisabled();
});

test('Fit Width puts the zoom back to the page width after zooming out', async ({ page }) => {
  await openApp(page, 'zoom.pdf', labelledPdf('Zoom', 1), { advanced: false });
  const fit = page.getByRole('button', { name: /^Fit Width \(\d+%\)$/ });
  const fitted = await fit.getAttribute('aria-label');
  await page.getByRole('button', { name: 'Zoom Out (-)' }).click();
  await page.getByRole('button', { name: 'Zoom Out (-)' }).click();
  await expect(fit).not.toHaveAttribute('aria-label', fitted ?? '');
  await fit.click();
  await expect(fit).toHaveAttribute('aria-label', fitted ?? '');
});

test('the header lists the open documents; Escape and a press outside close the list, and a choice switches document', async ({
  page,
}) => {
  await openApp(page, 'first.pdf', labelledPdf('First', 1), { advanced: false });
  await openApp(page, 'second.pdf', labelledPdf('Second', 2), { advanced: false, navigate: false });
  const switcher = page.getByRole('button', { name: /^second\.pdf/ }).first();
  const list = page.getByText(/Open documents \(2\)/);

  await switcher.click();
  await expect(list).toBeVisible();
  await expect(switcher).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(switcher).toHaveAttribute('aria-expanded', 'false');

  await switcher.click();
  await expect(list).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(list).toBeHidden();

  await switcher.click();
  await page.getByRole('button', { name: 'first.pdf', exact: true }).click();
  await expect(list).toBeHidden();
  await expect(page.getByRole('button', { name: /^first\.pdf/ }).first()).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByText('/ 1', { exact: true })).toBeVisible();
});

test('pressing the armed tool on the rail a second time puts the pointer back in select', async ({
  page,
}) => {
  await openApp(page, 'rail.pdf', labelledPdf('Rail', 1), { advanced: false });
  const rectangle = page.getByRole('button', { name: 'Draw Shape (Rectangle)', exact: true });
  const select = page.getByRole('button', { name: 'Selection Tool', exact: true });
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await rectangle.click();
  await expect(rectangle).toHaveAttribute('aria-pressed', 'true');
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  await rectangle.click();
  await expect(rectangle).toHaveAttribute('aria-pressed', 'false');
  await expect(select).toHaveAttribute('aria-pressed', 'true');
});

test('a key that reaches the window from the document itself still runs its shortcut, and one typed into an editable field does not', async ({
  page,
}) => {
  await openApp(page, 'keys.pdf', labelledPdf('Keys', 2), { advanced: false });
  const thumbnails = page.getByRole('option');
  await expect(thumbnails.first()).toBeVisible();

  // Fired at `document`, whose target is no element: the page panel still toggles.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F4', bubbles: true }));
  });
  await expect(thumbnails).toHaveCount(0);
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F4', bubbles: true }));
  });
  await expect(thumbnails.first()).toBeVisible();

  // Typed into a contenteditable region, the same key belongs to the field, not the shell.
  await page.evaluate(() => {
    const field = document.createElement('div');
    field.id = 'scratch-editor';
    field.contentEditable = 'true';
    field.tabIndex = 0;
    document.body.append(field);
    field.focus();
  });
  await page.keyboard.press('F4');
  await expect(thumbnails.first()).toBeVisible();
  await page.evaluate(() => {
    document.getElementById('scratch-editor')?.remove();
  });
  await page.locator('.pdfViewer[data-active-viewer]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('F4');
  await expect(thumbnails).toHaveCount(0);
});

test('Export Options in the header opens the export dialog and Escape closes it', async ({ page }) => {
  await openApp(page, 'export.pdf', labelledPdf('Export', 1), { advanced: false });
  await page.getByRole('button', { name: 'Export Options' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/Export/i);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('without requestIdleCallback or a network the shell still starts, and warms its chunks once the network is back', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'requestIdleCallback');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  });
  const chunks: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/editor/assets/') && pathname.endsWith('.js')) chunks.push(pathname);
  });
  await page.goto('/editor/');
  await expect(page.getByRole('tab', { name: 'Start' })).toHaveAttribute('aria-selected', 'true');
  // The idle fallback (a 2 s timer) has run: the worker registration it starts is the proof.
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/editor/')) !== undefined),
    )
    .toBe(true);
  const before = chunks.length;
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });
  await expect.poll(() => chunks.length, { timeout: 30_000 }).toBeGreaterThan(before);
});
