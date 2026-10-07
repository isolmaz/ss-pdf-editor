/**
 * The signature dialog's edges beside `ui-signature.spec.ts`: what each way of signing needs
 * before it can be placed, how a long typed name and a photographed one are fitted, what a
 * sensitive session refuses to keep, and what the pad keeps while the reader moves between tabs.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedPdf } from './tool-fixture';
import {
  encodePng,
  exportBytes,
  inkPng,
  menuItem,
  openPdf,
  pageFrame,
  runCommand,
  toClient,
} from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const SAVED_KEY = 'pdf-editor.signatures.v1';

async function openDialog(page: Page): Promise<Locator> {
  await menuItem(page, 'Tools', 'Add a signature (draw, type, picture)');
  const dialog = page.getByRole('dialog', { name: 'Add a signature' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function placeAt(page: Page, x: number, y: number): Promise<void> {
  const frame = await pageFrame(page);
  const point = toClient(frame, x, y);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await expect(page.locator('[data-stamp-placement] img')).toBeVisible();
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);
}

async function stamps(page: Page, name: string) {
  const produced = await readProducedPdf(await exportBytes(page, name));
  return produced.annotations
    .filter((annotation) => annotation.subtype === 'Stamp')
    .map((annotation) => {
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = annotation.rect;
      return { width: x1 - x0, height: y1 - y0 };
    });
}

/** How many pixels of a canvas are opaque, and how many of those are blue-dominant. */
function inkOf(canvas: Locator): Promise<{ opaque: number; blue: number }> {
  return canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('not a canvas');
    const data = element.getContext('2d')?.getImageData(0, 0, element.width, element.height).data;
    let opaque = 0;
    let blue = 0;
    for (let index = 0; data !== undefined && index < data.length; index += 4) {
      if ((data[index + 3] ?? 0) > 200) {
        opaque += 1;
        if ((data[index + 2] ?? 0) > 150 && (data[index] ?? 255) < 80) blue += 1;
      }
    }
    return { opaque, blue };
  });
}

async function drawStroke(page: Page, from: readonly [number, number], to: readonly [number, number]) {
  const box = await page.getByRole('img', { name: 'Signature drawing area' }).boundingBox();
  if (box === null) throw new Error('the drawing pad is not on screen');
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

test('a typed name of blanks is nothing to place; a long one is shrunk to fit the pad instead of cut', async ({
  page,
}) => {
  await openPdf(page);
  let dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
  const place = dialog.getByRole('button', { name: 'Place', exact: true });
  const name = dialog.getByLabel('Full name');
  await name.fill('   ');
  await expect(place).toBeDisabled();
  await expect(dialog.getByText('Draw, type or choose a signature first.')).toBeVisible();
  expect((await inkOf(page.getByRole('img', { name: 'Preview' }))).opaque).toBe(0);

  await name.fill('Ada');
  await expect(place).toBeEnabled();
  await place.click();
  await placeAt(page, 300, 300);

  dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
  await dialog.getByLabel('Full name').fill('W'.repeat(80));
  await dialog.getByRole('button', { name: 'Place', exact: true }).click();
  await placeAt(page, 300, 600);

  const [short, long] = await stamps(page, 'typed.pdf');
  // Both are 160 pt wide; the long name is a thin line of small letters.
  expect(short?.width).toBeCloseTo(160, 0);
  expect(long?.width).toBeCloseTo(160, 0);
  expect(long?.height).toBeLessThan((short?.height ?? 0) / 3);
});

test('the pad keeps its ink across tabs, takes a new ink colour, and a cancelled stroke still counts', async ({
  page,
}) => {
  await openPdf(page);
  const dialog = await openDialog(page);
  const pad = page.getByRole('img', { name: 'Signature drawing area' });
  const place = dialog.getByRole('button', { name: 'Place', exact: true });
  await drawStroke(page, [0.1, 0.7], [0.9, 0.3]);
  const black = await inkOf(pad);
  expect(black.opaque).toBeGreaterThan(200);
  expect(black.blue).toBe(0);

  await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
  await expect(pad).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'Draw', exact: true }).click();
  await expect(place).toBeEnabled();
  expect((await inkOf(pad)).opaque).toBe(black.opaque);

  await dialog.getByRole('radio', { name: 'Blue' }).check();
  await expect.poll(async () => (await inkOf(pad)).blue).toBe(black.opaque);

  // The stroke the browser cancels (a touch taken over by scrolling) is kept as drawn.
  await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(place).toBeDisabled();
  const box = await pad.boundingBox();
  if (box === null) throw new Error('the drawing pad is not on screen');
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await pad.dispatchEvent('pointercancel');
  await expect(place).toBeEnabled();
  await page.mouse.up();
  // Moving on after the cancel draws nothing more.
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9, { steps: 4 });
  expect((await inkOf(pad)).opaque).toBeGreaterThan(100);
});

test('a picture that is only paper has no ink to place; the role chosen after the picture sets the size', async ({
  page,
}) => {
  await openPdf(page);
  const dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'From a picture' }).click();
  const place = dialog.getByRole('button', { name: 'Place', exact: true });
  const file = dialog.locator('input[type="file"]');

  await file.setInputFiles({
    name: 'paper.png',
    mimeType: 'image/png',
    buffer: encodePng(60, 20, () => [255, 255, 255]),
  });
  await expect(dialog.getByText('paper.png')).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'Preview' })).toHaveCount(0);
  await expect(place).toBeDisabled();

  await file.setInputFiles({ name: 'ink.png', mimeType: 'image/png', buffer: inkPng() });
  await expect(dialog.getByRole('img', { name: 'Preview' })).toBeVisible();
  await expect(place).toBeEnabled();
  await dialog.getByRole('radio', { name: 'Initials' }).check();
  await expect(place).toBeEnabled();
  await place.click();
  await placeAt(page, 250, 500);
  const [stamp] = await stamps(page, 'initials-photo.pdf');
  expect(stamp?.width).toBeCloseTo(60, 0);
});

test('a picture can be remembered like a drawn signature and used again from the dialog', async ({
  page,
}) => {
  await openPdf(page);
  let dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'From a picture' }).click();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'ink.png',
    mimeType: 'image/png',
    buffer: inkPng(),
  });
  await expect(dialog.getByRole('img', { name: 'Preview' })).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Remember on this device/ }).check();
  await dialog.getByRole('button', { name: 'Place', exact: true }).click();
  await placeAt(page, 200, 500);
  const remembered = await page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? '[]'),
    SAVED_KEY,
  );
  expect(remembered).toHaveLength(1);
  expect(remembered[0].role).toBe('signature');

  dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'Use: Signature' }).click();
  await placeAt(page, 400, 600);
  const placed = await stamps(page, 'remembered.pdf');
  expect(placed).toHaveLength(2);
  for (const stamp of placed) expect(stamp.width).toBeCloseTo(160, 0);
});

test('a sensitive session offers no remembering, and nothing is stored', async ({ page }) => {
  await openPdf(page);
  await runCommand(page, 'Sensitive Session');
  const dialog = await openDialog(page);
  await expect(dialog.getByRole('checkbox', { name: /Remember on this device/ })).toHaveCount(0);
  await drawStroke(page, [0.1, 0.7], [0.9, 0.3]);
  await dialog.getByRole('button', { name: 'Place', exact: true }).click();
  await placeAt(page, 300, 300);
  expect(await stamps(page, 'sensitive.pdf')).toHaveLength(1);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVED_KEY)).toBeNull();
});
