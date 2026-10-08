/**
 * The viewer pane when its window changes size: a preset zoom is a promise about the pane,
 * so a narrower or wider window re-fits the pages instead of cutting them off.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { FORM_FIELD, readProducedPdf } from './tool-fixture';
import { exportBytes, menuItem, openPdf, pageFrame, toClient } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const PAGE = '.pdfViewer[data-active-viewer] .page';

function scroller(page: Page): Locator {
  return page.locator(PAGE).first().locator('xpath=../..');
}

/**
 * Page one's drawn size; zero while pdf.js swaps the canvas for a re-render at the new
 * scale, so a poll reads "not there yet" and asks again instead of failing.
 */
async function pageSize(page: Page): Promise<{ width: number; height: number }> {
  const box = await page.locator(`${PAGE} canvas`).first().boundingBox();
  return box === null ? { width: 0, height: 0 } : { width: box.width, height: box.height };
}

test('fit width and fit page follow the window when it is resized; a fixed zoom does not', async ({
  page,
}) => {
  await openPdf(page);
  const pane = scroller(page);
  const paneSize = () =>
    pane.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));

  const fitsWidth = async () => {
    const [size, around] = [await pageSize(page), await paneSize()];
    return size.width > around.width - 60 && size.width <= around.width;
  };

  // Fit width: the page keeps filling the pane as the window narrows and widens again.
  await menuItem(page, 'View', 'Fit width');
  await expect.poll(fitsWidth).toBe(true);
  const wide = await paneSize();
  await page.setViewportSize({ width: 1000, height: 900 });
  // The pane is not narrower at 1000 px: the dock folds away below a breakpoint and gives it room.
  await expect.poll(async () => Math.abs((await paneSize()).width - wide.width)).toBeGreaterThan(100);
  await expect.poll(fitsWidth).toBe(true);
  const resized = await paneSize();
  expect(resized.width).not.toBe(wide.width);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => Math.abs((await paneSize()).width - resized.width)).toBeGreaterThan(100);
  await expect.poll(fitsWidth).toBe(true);

  // Fit page: a window of a different size re-fits the whole page into the pane.
  const fitsPage = async () => {
    const [size, around] = [await pageSize(page), await paneSize()];
    return size.height > around.height - 60 && size.height <= around.height;
  };
  await menuItem(page, 'View', 'Fit page');
  await expect.poll(fitsPage).toBe(true);
  const tall = await paneSize();
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect.poll(async () => Math.abs((await paneSize()).height - tall.height)).toBeGreaterThan(100);
  await expect.poll(fitsPage).toBe(true);
  const small = await paneSize();

  // Actual size is not a preset: the window changing leaves the page at 96 dpi.
  await page.keyboard.press('Control+1');
  await expect.poll(async () => Math.round((await pageSize(page)).width)).toBe(Math.round((595 * 96) / 72));
  await page.setViewportSize({ width: 1300, height: 700 });
  await expect.poll(async () => Math.abs((await paneSize()).width - small.width)).toBeGreaterThan(50);
  await expect.poll(async () => Math.round((await pageSize(page)).width)).toBe(Math.round((595 * 96) / 72));
});

test('a value typed into a form widget of the page is what the export holds', async ({ page }) => {
  await openPdf(page);
  const field = page.locator(`.annotationLayer input[name="${FORM_FIELD.name}"]`);
  const frame = await pageFrame(page);
  const centre = toClient(
    frame,
    (FORM_FIELD.rect[0] + FORM_FIELD.rect[2]) / 2,
    (FORM_FIELD.rect[1] + FORM_FIELD.rect[3]) / 2,
  );
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Katherine Johnson');
  await expect(field).toHaveValue('Katherine Johnson');
  await page.keyboard.press('Tab');

  // The typed value lives only in the viewer's form storage until the export writes it.
  const direct = await readProducedPdf(await exportBytes(page, 'form.pdf'));
  expect(direct.formValue).toBe('Katherine Johnson');
});
