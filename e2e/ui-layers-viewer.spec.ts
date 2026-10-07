/**
 * The viewer's own surfaces: the magnifier lens that follows the pointer over the page.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { menuItem, openPdf, pageFrame, toClient } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

const LENS = 'canvas.pdf-tools-lens';

/** The lens's pixels: how many are opaque dark ink, and whether its corners are clear. */
async function lensPixels(lens: Locator): Promise<{ ink: number; cornersClear: boolean }> {
  return lens.evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('the lens has no 2d context');
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let at = 0; at < data.length; at += 4) {
      if ((data[at + 3] ?? 0) > 200 && (data[at] ?? 255) < 100 && (data[at + 1] ?? 255) < 100) ink += 1;
    }
    const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3] ?? 255;
    return {
      ink,
      cornersClear:
        alphaAt(1, 1) === 0 &&
        alphaAt(width - 2, 1) === 0 &&
        alphaAt(1, height - 2) === 0 &&
        alphaAt(width - 2, height - 2) === 0,
    };
  });
}

async function overText(page: Page, x = 90, y = 773): Promise<void> {
  const frame = await pageFrame(page);
  const point = toClient(frame, x, y);
  await page.mouse.move(point.x - 20, point.y - 10);
  await page.mouse.move(point.x, point.y, { steps: 4 });
}

test('the lens follows the pointer over the page, shows the text under it magnified, and the wheel sets the magnification', async ({
  page,
}) => {
  await openPdf(page);
  await menuItem(page, 'View', /Magnifier/);
  const lens = page.locator(LENS);
  await expect(lens).toBeAttached();
  await expect(lens).toBeHidden();
  const zoomLabel = page.locator('.pdf-tools-magnifier span').last();
  await expect(zoomLabel).toHaveText('4×');

  // Over the first text line: the lens is centred on the pointer and holds dark glyph pixels.
  const frame = await pageFrame(page);
  const point = toClient(frame, 90, 773);
  await overText(page);
  await expect(lens).toBeVisible();
  const box = await lens.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0) / 2).toBeCloseTo(point.x, 0);
  expect((box?.y ?? 0) + (box?.height ?? 0) / 2).toBeCloseTo(point.y, 0);
  expect(box?.width).toBeCloseTo(180, 2);
  await expect.poll(async () => (await lensPixels(lens)).ink).toBeGreaterThan(200);
  expect((await lensPixels(lens)).cornersClear).toBe(true);

  // The wheel adjusts the magnification by half a step and does not scroll the page.
  const scroller = page.locator('.pdfViewer[data-active-viewer] .page').first().locator('xpath=../..');
  const before = await scroller.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, -100);
  await expect(zoomLabel).toHaveText('4.5×');
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await expect(zoomLabel).toHaveText('3.5×');
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before);
  for (let step = 0; step < 12; step += 1) await page.mouse.wheel(0, 100);
  await expect(zoomLabel).toHaveText('2×');
  await page.mouse.wheel(0, 100);
  await expect(zoomLabel).toHaveText('2×');
  for (let step = 0; step < 14; step += 1) await page.mouse.wheel(0, -100);
  await expect(zoomLabel).toHaveText('8×');
  await page.mouse.wheel(0, -100);
  await expect(zoomLabel).toHaveText('8×');

  // The slider sets it too, clamped to the lens's range.
  const slider = page.locator('.pdf-tools-magnifier input[type="range"]');
  await slider.fill('6');
  await expect(zoomLabel).toHaveText('6×');
  await expect(slider).toHaveValue('6');
});

test('Escape hides the lens until the pointer leaves the pages; leaving the pages or the window hides it too', async ({
  page,
}) => {
  await openPdf(page);
  await menuItem(page, 'View', /Magnifier/);
  const lens = page.locator(LENS);
  await overText(page);
  await expect(lens).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(lens).toBeHidden();
  // Still on the page: it stays dismissed.
  await overText(page, 200, 700);
  await expect(lens).toBeHidden();
  // Off the pages (over the tools rail) and back: it is armed again.
  await page.mouse.move(5, 300, { steps: 4 });
  await overText(page);
  await expect(lens).toBeVisible();

  // The pointer leaving the window: `pointerout` without a related target.
  await page.evaluate(() => {
    document.body.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
  });
  await expect(lens).toBeHidden();

  // Over a page corner the lens keeps working near the canvas edge.
  await overText(page, 3, 839);
  await expect(lens).toBeVisible();
  await page.mouse.move(5, 300, { steps: 4 });
  await expect(lens).toBeHidden();

  // Switching the magnifier off removes lens and control.
  await menuItem(page, 'View', /Magnifier/);
  await expect(lens).toHaveCount(0);
  await expect(page.locator('.pdf-tools-magnifier')).toHaveCount(0);
});
