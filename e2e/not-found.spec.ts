import type { Page } from 'playwright/test';
import { expect, test } from './test';

/**
 * The not-found pages (`public/404.html`, `public/en/404.html`). The landing and legal pages are
 * another Worker on the same host (the ss-pdf-editor-site repository), so every path it does not
 * claim, an unknown one included, is answered by this build. The links to the landing are only
 * checked for their target: the landing is not part of this `dist/`.
 */

/** Wait until the page is at `target` (path plus optional hash) on this origin. */
const at = (page: Page, target: string) => page.waitForURL((url) => url.pathname + url.hash === target);

// Each test asks for a page that does not exist: the 404 response is the subject, and the only
// console error it may leave.
test.use({
  allowedErrors: [
    /status of 404 \(Not Found\) \(http:\/\/localhost:\d+\/(en\/)?(boyle-bir-sayfa-yok|no-such-page)\)$/,
  ],
});

test('an unknown path gets the styled 404 page with working exits', async ({ page }) => {
  await page.goto('/boyle-bir-sayfa-yok');
  expect(await page.evaluate(async () => (await fetch('/boyle-bir-sayfa-yok')).status)).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sayfa Bulunamadı');
  await expect(page.getByRole('link', { name: 'Ana Sayfaya Dön', exact: true })).toHaveAttribute('href', '/');
  await page.getByRole('link', { name: 'PDF Düzenleyiciyi Başlat', exact: true }).click();
  await at(page, '/editor/');
});

test('an unknown path under /en/ gets the English 404 page, whose exits stay in English', async ({
  page,
}) => {
  // The host serves the nearest 404.html: `/en/404.html` here, the Turkish one at the root.
  await page.goto('/en/no-such-page');
  expect(await page.evaluate(async () => (await fetch('/en/no-such-page')).status)).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page Not Found');
  await expect(page.getByRole('link', { name: 'Back to Home', exact: true })).toHaveAttribute('href', '/en/');
  await page.getByRole('link', { name: 'Launch the PDF Editor', exact: true }).click();
  await at(page, '/editor/');
});
