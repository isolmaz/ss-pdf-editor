/**
 * Full-screen presentation: one page at a time, the keys that turn pages, the view the reader
 * had before it back on exit, and every way out — Escape, the button again, the browser leaving
 * full screen, the document closing. A browser that refuses (or lacks) full screen still
 * presents in the page.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { openPdf, runCommand } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const PRESENT = 'Full-screen presentation';
const presenting = (page: Page) => page.locator('.pdfPresentationMode');

/** The index of the page whose top is at the top of the viewer, as the viewer is scrolled. */
const topPage = (page: Page) =>
  page.evaluate(() => {
    const container = document.querySelector('.pdfViewer[data-active-viewer]')?.parentElement;
    const pages = [...document.querySelectorAll('.pdfViewer[data-active-viewer] .page')];
    if (!container) return -1;
    const top = container.getBoundingClientRect().top;
    return pages.findIndex((entry) => Math.abs(entry.getBoundingClientRect().top - top) < 40);
  });

const pageWidth = (page: Page) =>
  page.evaluate(
    () => document.querySelector('.pdfViewer[data-active-viewer] .page')?.getBoundingClientRect().width ?? 0,
  );

const fullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement !== null);

async function begin(page: Page, pages = 4): Promise<void> {
  await openPdf(page, 'slides.pdf', labelledPdf('Slide', pages));
  await expect.poll(() => topPage(page)).toBe(0);
}

test('the page keys turn one page each and stop at the ends; Escape ends the presentation', async ({
  page,
}) => {
  await begin(page);
  await page.getByRole('button', { name: PRESENT }).click();
  await expect.poll(() => fullscreen(page)).toBe(true);
  await expect(presenting(page)).toHaveCount(1);
  await expect.poll(() => topPage(page)).toBe(0);

  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => topPage(page)).toBe(0);
  await page.keyboard.press('Space');
  await expect.poll(() => topPage(page)).toBe(1);
  await page.keyboard.press('PageDown');
  await expect.poll(() => topPage(page)).toBe(2);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => topPage(page)).toBe(3);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => topPage(page)).toBe(3);
  await page.keyboard.press('PageUp');
  await expect.poll(() => topPage(page)).toBe(2);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => topPage(page)).toBe(1);
  await page.keyboard.press('End');
  await expect.poll(() => topPage(page)).toBe(3);
  await page.keyboard.press('Home');
  await expect.poll(() => topPage(page)).toBe(0);
  // A key that is no page key is left to the shell.
  await page.keyboard.press('x');
  await expect.poll(() => topPage(page)).toBe(0);

  // In full screen only the viewer is shown — the toolbar button is behind it — so the way out
  // is Escape; the button ends an in-page presentation (the tests below).
  await page.keyboard.press('Escape');
  await expect.poll(() => fullscreen(page)).toBe(false);
  await expect(presenting(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: PRESENT })).toBeVisible();
});

test('it starts on the page being looked at and gives the reader’s zoom back on exit', async ({ page }) => {
  await begin(page);
  const pageNumber = page.getByRole('textbox', { name: 'Page number' });
  await pageNumber.fill('3');
  await pageNumber.press('Enter');
  await expect.poll(() => topPage(page)).toBe(2);

  // Zoom in past the width fit: a fixed scale of the reader's own.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const before = await pageWidth(page);

  await page.getByRole('button', { name: PRESENT }).click();
  await expect(presenting(page)).toHaveCount(1);
  await expect.poll(() => topPage(page)).toBe(2);
  // Presenting fits the page to the width of the screen.
  await expect.poll(() => pageWidth(page)).not.toBe(before);

  await page.keyboard.press('Escape');
  await expect(presenting(page)).toHaveCount(0);
  await expect.poll(async () => Math.abs((await pageWidth(page)) - before)).toBeLessThan(3);
});

test('a reader who was fitting the width is fitted again on exit', async ({ page }) => {
  await begin(page, 2);
  const before = await pageWidth(page);
  await page.getByRole('button', { name: PRESENT }).click();
  await expect(presenting(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(presenting(page)).toHaveCount(0);
  await expect.poll(async () => Math.abs((await pageWidth(page)) - before)).toBeLessThan(3);
  // The presentation can be started again after leaving it.
  await page.getByRole('button', { name: PRESENT }).click();
  await expect(presenting(page)).toHaveCount(1);
});

test('the browser leaving full screen ends the presentation', async ({ page }) => {
  await begin(page, 2);
  await page.getByRole('button', { name: PRESENT }).click();
  await expect.poll(() => fullscreen(page)).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect(presenting(page)).toHaveCount(0);
});

test('closing the document while presenting in the page ends the presentation', async ({ page }) => {
  // In real full screen only the viewer is shown and the palette cannot be reached; a browser that
  // keeps the page around the presentation (refusing full screen) can.
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('Fullscreen is not allowed.'));
  });
  await begin(page, 2);
  await page.getByRole('button', { name: PRESENT }).click();
  await expect(presenting(page)).toHaveCount(1);
  await runCommand(page, 'Close tab');
  await expect(page.locator('.pdfViewer[data-active-viewer]')).toHaveCount(0, { timeout: 30_000 });
  await expect(presenting(page)).toHaveCount(0);
});

test.describe('without full screen', () => {
  test('a browser that refuses it still presents in the page, and Escape leaves', async ({ page }) => {
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('Fullscreen is not allowed.'));
    });
    await begin(page);
    await page.getByRole('button', { name: PRESENT }).click();
    await expect(presenting(page)).toHaveCount(1);
    expect(await fullscreen(page)).toBe(false);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => topPage(page)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(presenting(page)).toHaveCount(0);
  });

  test('a browser without the API presents in the page too', async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(Element.prototype, 'requestFullscreen');
    });
    await begin(page);
    await page.getByRole('button', { name: PRESENT }).click();
    await expect(presenting(page)).toHaveCount(1);
    await page.keyboard.press('End');
    await expect.poll(() => topPage(page)).toBe(3);
    await page.getByRole('button', { name: PRESENT }).click();
    await expect(presenting(page)).toHaveCount(0);
  });
});
