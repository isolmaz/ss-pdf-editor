/**
 * The view snapshot: the pages the viewport shows, composed into one PNG, handed over as a
 * download or on the clipboard. The picture is read back (its header, and its pixels drawn
 * into a canvas); the refusals are the sentences the user reads.
 *
 * Opened from View → Snapshot (`view.snapshot`).
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { CANVAS, menuItem, openPdf, runCommand } from './ui-helpers';
import { revokedUrls, trackRevocations } from './ui-panels9-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Snapshot' });

async function openSnapshot(page: Page): Promise<Locator> {
  await menuItem(page, 'View', 'Snapshot');
  const panel = dialog(page);
  await expect(panel).toBeVisible();
  return panel;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** How many pixels of a PNG are not paper-white, decoded by the browser. */
function inkOf(page: Page, bytes: Uint8Array): Promise<{ ink: number; paper: number }> {
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let ink = 0;
    let paper = 0;
    for (let at = 0; at < pixels.length; at += 4) {
      if ((pixels[at] ?? 255) < 160) ink += 1;
      else if ((pixels[at] ?? 0) > 235 && (pixels[at + 1] ?? 0) > 235 && (pixels[at + 2] ?? 0) > 235)
        paper += 1;
    }
    return { ink, paper };
  }, Array.from(bytes));
}

async function saveSnapshot(page: Page, panel: Locator) {
  const event = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download PNG' }).click();
  const file = await event;
  const path = test.info().outputPath(file.suggestedFilename());
  await file.saveAs(path);
  return { name: file.suggestedFilename(), url: file.url(), bytes: new Uint8Array(readFileSync(path)) };
}

test('Download PNG writes the visible page as a PNG named for its page and time, says so, and closes', async ({
  page,
}) => {
  await trackRevocations(page);
  await openPdf(page);
  const panel = await openSnapshot(page);
  // The actions wait for the picture: Download is enabled once it is encoded.
  const download = panel.getByRole('button', { name: 'Download PNG' });
  await expect(download).toBeEnabled();
  await expect(panel.locator('canvas')).toHaveJSProperty('width', await pageWidth(page));

  const saved = await saveSnapshot(page, panel);
  expect(saved.name).toMatch(/^snapshot-1-\d{8}-\d{6}\.png$/);
  expect(Array.from(saved.bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
  const size = pngSize(saved.bytes);
  expect(size.width).toBe(await pageWidth(page));
  expect(size.height).toBeGreaterThan(size.width);

  // The picture is the page: paper with the fixture's dark text on it.
  const pixels = await inkOf(page, saved.bytes);
  expect(pixels.ink).toBeGreaterThan(200);
  expect(pixels.paper).toBeGreaterThan(size.width * size.height * 0.5);

  await expect(notice(page, `Snapshot saved: ${saved.name}`)).toBeVisible();
  await expect(panel).toBeHidden();

  // The blob behind the file is released ten seconds after the download started.
  expect(saved.url).toMatch(/^blob:/);
  await expect.poll(() => revokedUrls(page), { timeout: 20_000, intervals: [500] }).toContain(saved.url);
});

/** The first page's painted width in device pixels, as the snapshot composes it: the page canvas, without the page's border. */
async function pageWidth(page: Page): Promise<number> {
  await expect(page.locator(CANVAS).first()).toBeVisible();
  return page
    .locator(CANVAS)
    .first()
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Math.round(bounds.width * window.devicePixelRatio);
    });
}

test('the snapshot starts at the page the viewport starts on', async ({ page }) => {
  await openPdf(page);
  const pageNumber = page.getByRole('textbox', { name: 'Page number' });
  await pageNumber.fill('2');
  await pageNumber.press('Enter');
  await expect(pageNumber).toHaveValue('2');
  const panel = await openSnapshot(page);
  await expect(panel.getByRole('button', { name: 'Download PNG' })).toBeEnabled();
  const saved = await saveSnapshot(page, panel);
  expect(saved.name).toMatch(/^snapshot-2-\d{8}-\d{6}\.png$/);
});

test('Escape and a click outside close the panel without saving anything', async ({ page }) => {
  await openPdf(page);
  const panel = await openSnapshot(page);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await runCommand(page, 'Snapshot');
  await expect(panel).toBeVisible();
  // A press inside the panel keeps it open; one on the page closes it.
  await panel.getByText('Snapshot', { exact: true }).first().click();
  await expect(panel).toBeVisible();
  // The page's text layer lies over its canvas: a press on the page lands there, as a reader's would.
  const box = await page.locator(CANVAS).first().boundingBox();
  if (box === null) throw new Error('the page canvas has no box');
  await page.mouse.click(box.x + 20, box.y + 20);
  await expect(panel).toBeHidden();
});

test.describe('the clipboard', () => {
  test('Copy to clipboard puts the PNG on the clipboard and says so', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPdf(page);
    const panel = await openSnapshot(page);
    const copy = panel.getByRole('button', { name: 'Copy to clipboard' });
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(notice(page, 'Snapshot copied to the clipboard.')).toBeVisible();
    await expect(panel).toBeHidden();

    const onClipboard = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      if (item === undefined) return null;
      const blob = await item.getType('image/png');
      return { types: [...item.types], bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
    });
    expect(onClipboard?.types).toEqual(['image/png']);
    expect(onClipboard?.bytes.slice(0, 8)).toEqual(PNG_SIGNATURE);
  });

  test('a clipboard that refuses the write is reported as a denied permission', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, 'write', {
        value: () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')),
      });
    });
    await openPdf(page);
    const panel = await openSnapshot(page);
    await panel.getByRole('button', { name: 'Copy to clipboard' }).click();
    await expect(notice(page, 'File access was denied.')).toBeVisible();
  });

  test('any other clipboard failure is reported as an unexpected one', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, 'write', {
        value: () => Promise.reject(new Error('the clipboard is busy')),
      });
    });
    await openPdf(page);
    const panel = await openSnapshot(page);
    await panel.getByRole('button', { name: 'Copy to clipboard' }).click();
    await expect(notice(page, 'Something unexpected went wrong.')).toBeVisible();
  });

  test('without the async clipboard there is no Copy action, only Download', async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'ClipboardItem');
    });
    await openPdf(page);
    const panel = await openSnapshot(page);
    await expect(panel.getByRole('button', { name: 'Download PNG' })).toBeEnabled();
    await expect(panel.getByRole('button', { name: 'Copy to clipboard' })).toHaveCount(0);
  });
});
