/**
 * The viewer pane as a user lives in it: the zoom modes by the size the pages really take,
 * the page turned in the view, the scroll position a tab keeps while another one is in front,
 * and what a click on an external link does.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry } from './tool-fixture';
import { exportBytes, menuItem, openPdf, rail, toClient } from './ui-helpers';
import { clickAt, framed } from './ui-layers-helpers';
import { EXTERNAL_LINK, exported, linkedFixture } from './ui-marks-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const PAGE = '.pdfViewer[data-active-viewer] .page';

/** The scrolled area that holds the pages: its box and its own scroll offset. */
function scroller(page: Page): Locator {
  return page.locator(PAGE).first().locator('xpath=../..');
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function firstPage(page: Page): Promise<Box> {
  // A turn or a zoom replaces the page element; `toPass` asks again for the one now on screen.
  const found: Box[] = [];
  await expect(async () => {
    await page.locator(PAGE).first().scrollIntoViewIfNeeded({ timeout: 2_000 });
    const box = await page.locator(`${PAGE} canvas`).first().boundingBox({ timeout: 2_000 });
    if (box === null) throw new Error('page one has no box');
    found.push(box);
  }).toPass({ timeout: 15_000 });
  // `toPass` returned, so its last attempt got as far as pushing a box.
  return found.at(-1) as Box;
}

test('fit width fills the pane, fit page fits the whole page in it, and actual size is 96 dpi', async ({
  page,
}) => {
  await openPdf(page);
  const pane = scroller(page);
  const { clientWidth, clientHeight } = await pane.evaluate((element) => ({
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
  }));

  await menuItem(page, 'View', 'Fit width');
  await expect.poll(async () => (await firstPage(page)).width).toBeGreaterThan(clientWidth - 60);
  const wide = await firstPage(page);
  expect(wide.width).toBeLessThanOrEqual(clientWidth);
  expect(wide.height / wide.width).toBeCloseTo(842 / 595, 2);

  await menuItem(page, 'View', 'Fit page');
  await expect.poll(async () => (await firstPage(page)).height).toBeLessThanOrEqual(clientHeight);
  const whole = await firstPage(page);
  expect(whole.height).toBeGreaterThan(clientHeight - 60);
  expect(whole.width / whole.height).toBeCloseTo(595 / 842, 2);

  // Actual size: a point is 96/72 CSS pixels, and zooming in 25 % more is 25 % wider.
  await page.keyboard.press('Control+1');
  await expect.poll(async () => Math.round((await firstPage(page)).width)).toBe(Math.round((595 * 96) / 72));
  await page.keyboard.press('Control+=');
  await expect
    .poll(async () => Math.abs((await firstPage(page)).width - ((595 * 96) / 72) * 1.25) < 1.5)
    .toBe(true);
});

test('turning the page in the view swaps its sides and the exported page is turned too', async ({ page }) => {
  await openPdf(page);
  await menuItem(page, 'View', 'Fit width');
  const before = await firstPage(page);
  expect(before.height).toBeGreaterThan(before.width);

  await page.getByRole('button', { name: 'Rotate Page (90°)' }).click();
  await expect.poll(async () => (await firstPage(page)).width).toBeGreaterThan(before.width * 0.99);
  await expect
    .poll(async () => {
      const turned = await firstPage(page);
      return turned.width / turned.height;
    })
    .toBeCloseTo(842 / 595, 2);

  const bytes = await exportBytes(page, 'turned.pdf');
  expect(await readProducedEntry(bytes, 0, 'Rotate')).toBe('90');
  expect(await readProducedEntry(bytes, 1, 'Rotate')).toMatch(/^0?$/);
});

test('a write to the file keeps the reader on the same page, scroll and zoom; another tab starts at its own top', async ({
  page,
}) => {
  await openPdf(page, 'first.pdf');
  await expect(page.locator(PAGE)).toHaveCount(2);
  const pane = scroller(page);
  const field = page.getByRole('textbox', { name: 'Page number' });
  const scrolled = () => pane.evaluate((element) => element.scrollTop);

  // Actual size, then the file's own right-hand stroke selected.
  await page.keyboard.press('Control+1');
  await expect.poll(async () => Math.round((await firstPage(page)).width)).toBe(793);
  await framed(page);
  await clickAt(page, 420, 700);
  await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
  // Scrolled down 300 px: the stroke (at 92 px from the top at this zoom) is out of view, the page is not.
  await pane.evaluate((element) => {
    element.scrollTop += 300;
  });
  const before = await scrolled();
  expect(before).toBeGreaterThan(300);
  await expect(field).toHaveValue('1');

  // Deleting the file's own stroke rewrites the document; the view is rebuilt in place.
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-mark-selection]')).toHaveCount(0);
  await expect
    .poll(async () => (await exported(page, 'rewritten.pdf', 'Ink')).map((annotation) => annotation.contents))
    .toEqual(['Saved ink left']);
  await expect(field).toHaveValue('1');
  expect(Math.abs((await scrolled()) - before)).toBeLessThan(4);
  expect(Math.round((await firstPage(page)).width)).toBe(793);

  // A second document opens at its own top; coming back, the first one starts afresh (page 1,
  // fit width): the pane keeps a place for a rewrite of the same document, not for a tab.
  await openPdf(page, 'second.pdf', labelledPdf('Other', 3), { navigate: false, advanced: false });
  const switcher = page.getByRole('button', { name: /^second\.pdf/ }).first();
  await expect(switcher).toBeVisible();
  await expect(page.locator(PAGE)).toHaveCount(3);
  await expect.poll(scrolled).toBeLessThan(40);
  await switcher.click();
  await page.getByRole('button', { name: 'first.pdf', exact: true }).click();
  await expect(page.getByRole('button', { name: /^first\.pdf/ }).first()).toBeVisible();
  await expect(page.locator(PAGE)).toHaveCount(2);
  await expect(field).toHaveValue('1');
  await expect.poll(scrolled).toBeLessThan(40);
  expect(Math.round((await firstPage(page)).width)).not.toBe(793);
});

test('an external link opens in a new tab and leaves the editor on its document; the selection tool does not follow it', async ({
  page,
}) => {
  // On the context, so the new tab the link opens is answered too.
  await page
    .context()
    .route('https://example.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>linked</title>linked' }),
    );
  await openPdf(page, 'linked.pdf', await linkedFixture());
  const anchor = page.locator(`.annotationLayer a[href="${EXTERNAL_LINK.uri}"]`);
  await expect(anchor).toHaveAttribute('target', '_blank');
  await expect(anchor).toHaveAttribute('rel', /noopener/);

  const frame = await framed(page);
  const link = toClient(frame, 175, 510);
  const popups: string[] = [];
  page.context().on('page', (opened) => popups.push(opened.url()));

  // With the selection tool the press belongs to the marks layer: the link is selected as one of
  // the file's annotations (it can be deleted like any other), and nothing opens.
  await page.mouse.click(link.x, link.y);
  await expect(page.locator('[data-mark-selection]')).toHaveCount(1);
  expect(popups).toEqual([]);
  expect(page.url()).toContain('/editor/');
  await page.keyboard.press('Escape');

  // With the hand tool the link is the click's: a new tab opens on the address.
  await rail(page, 'Hand / Pan Tool').click();
  const opened = page.waitForEvent('popup');
  await page.mouse.click(link.x, link.y);
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toBe(EXTERNAL_LINK.uri);
  await tab.close();
  expect(page.url()).toContain('/editor/');
  await expect(page.locator(PAGE).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^linked\.pdf/ }).first()).toBeVisible();
});
