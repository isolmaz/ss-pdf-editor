import { expect, test } from './test';
import { toolFixturePdf } from './tool-fixture';
import { openDockTab, openPdf, pdfFile } from './ui-helpers';

/**
 * A chunk the browser cannot fetch (a release that replaced the hashed file, a 503 while the
 * origin is down) must never leave a white page. These specs serve a 404 for one chunk of the
 * built app and look at what the shell does: the root recovery screen for a surface nothing
 * narrower contains, the dock's own sentence for a panel, a message in the viewer pane.
 *
 * Playwright's routing does not see requests a service worker answers, so the worker is blocked.
 */

test.use({
  viewport: { width: 1440, height: 900 },
  serviceWorkers: 'block',
  allowedErrors: [/Failed to load resource|dynamically imported module|The above error occurred/],
});

const notFound = { status: 404, contentType: 'text/plain', body: 'gone' };

test('a lazy chunk that is gone ends in the recovery screen, and Reload brings the app back once it is served', async ({
  page,
}) => {
  const chunk = '**/assets/HomeToolGrid-*.js';
  await page.route(chunk, (route) => route.fulfill(notFound));
  await page.goto('/editor/');
  await page.getByRole('tab', { name: 'All tools', exact: true }).click();

  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { name: 'The editor stopped' })).toBeVisible();
  // Online, a chunk that cannot be fetched is a page that outlived its release.
  await expect(alert).toContainText('the app has probably been updated');
  await expect(alert).toContainText('kept on this device as drafts');
  await expect(page.getByRole('tab', { name: 'Start', exact: true })).toHaveCount(0);

  await page.unroute(chunk);
  await alert.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('tab', { name: 'Start', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a dock panel whose chunk is gone says so in its place, and the tabs and the document stay', async ({
  page,
}) => {
  await page.route('**/assets/DockPanels-*.js', (route) => route.fulfill(notFound));
  await openPdf(page, 'plain.pdf', toolFixturePdf());
  await openDockTab(page, 'Document information');

  await expect(page.getByRole('alert')).toContainText('the app has probably been updated');
  await expect(page.getByRole('heading', { name: 'The editor stopped' })).toHaveCount(0);
  // Another tab is a fresh start for the boundary, and the document is still painted.
  await openDockTab(page, 'History');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.pdfViewer[data-active-viewer] .page canvas').first()).toBeVisible();
});

test('a viewer engine chunk that is gone is a message in the pane, not "Preparing pages…" for ever', async ({
  page,
}) => {
  await page.route('**/assets/pdf_viewer-*.js', (route) => route.fulfill(notFound));
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles(pdfFile('plain.pdf', toolFixturePdf()));

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('the app has probably been updated', { timeout: 30_000 });
  await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByText('Preparing pages…')).toHaveCount(0);
});
