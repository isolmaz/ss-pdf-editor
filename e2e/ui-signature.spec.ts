/**
 * The simple-signature dialog and the placement layer behind it: a signature drawn, typed or
 * photographed becomes a `/Stamp` annotation of the exported file at the size and place the
 * user clicked. The produced bytes are read back, not the dialog's own state.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedPdf } from './tool-fixture';
import { exportBytes, inkPng, menuItem, openPdf, pageFrame, toClient } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const SAVED_KEY = 'pdf-editor.signatures.v1';

async function openSignatureDialog(page: Page) {
  await menuItem(page, 'Tools', 'Add a signature (draw, type, picture)');
  const dialog = page.getByRole('dialog', { name: 'Add a signature' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Draw one stroke across the pad with the mouse. */
async function drawStroke(page: Page, from: readonly [number, number], to: readonly [number, number]) {
  const box = await page.getByRole('img', { name: 'Signature drawing area' }).boundingBox();
  if (box === null) throw new Error('the drawing pad is not on screen');
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

/** The stamps of the exported file, with their rectangle width/height and centre. */
async function stamps(page: Page, name: string) {
  const produced = await readProducedPdf(await exportBytes(page, name));
  return produced.annotations
    .filter((annotation) => annotation.subtype === 'Stamp')
    .map((annotation) => {
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = annotation.rect;
      return {
        width: x1 - x0,
        height: y1 - y0,
        centerX: (x0 + x1) / 2,
        centerY: (y0 + y1) / 2,
        pageIndex: annotation.pageIndex,
      };
    });
}

/** Move over the page, see the ghost, click: the placement of the armed picture. */
async function placeAt(page: Page, x: number, y: number) {
  const frame = await pageFrame(page);
  const point = toClient(frame, x, y);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await expect(page.locator('[data-stamp-placement] img')).toBeVisible();
  await page.mouse.click(point.x, point.y);
}

test('draw: the pad needs ink, undo and clear take it back, and the placed stroke becomes a 160 pt stamp where clicked', async ({
  page,
}) => {
  await openPdf(page);
  const dialog = await openSignatureDialog(page);
  const place = dialog.getByRole('button', { name: 'Place', exact: true });
  await expect(place).toBeDisabled();
  await expect(dialog.getByText('Draw, type or choose a signature first.')).toBeVisible();
  const undo = dialog.getByRole('button', { name: 'Undo the last stroke' });
  const clear = dialog.getByRole('button', { name: 'Clear', exact: true });
  await expect(undo).toBeDisabled();
  await expect(clear).toBeDisabled();

  await drawStroke(page, [0.1, 0.7], [0.5, 0.3]);
  await expect(place).toBeEnabled();
  await drawStroke(page, [0.5, 0.3], [0.9, 0.7]);
  await undo.click();
  await expect(place).toBeEnabled();
  await undo.click();
  await expect(place).toBeDisabled();
  await expect(undo).toBeDisabled();

  await drawStroke(page, [0.2, 0.5], [0.8, 0.5]);
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(place).toBeDisabled();

  // A tap is a dot: one sample, still ink.
  const pad = await page.getByRole('img', { name: 'Signature drawing area' }).boundingBox();
  if (pad === null) throw new Error('the drawing pad is not on screen');
  await page.mouse.click(pad.x + pad.width / 2, pad.y + pad.height / 2);
  await expect(place).toBeEnabled();
  await drawStroke(page, [0.1, 0.7], [0.9, 0.3]);

  await place.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-stamp-placement] [role=status]')).toHaveText(
    /Click on the page where it goes\./,
  );

  // Escape cancels: nothing is written.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);
  expect(await stamps(page, 'none.pdf')).toEqual([]);

  // Armed again from the dialog, a click outside the pages (the tools rail) places nothing,
  // and a click on the page puts the picture there.
  const second = await openSignatureDialog(page);
  await expect(second.getByRole('button', { name: 'Place', exact: true })).toBeDisabled();
  await drawStroke(page, [0.1, 0.7], [0.9, 0.3]);
  await second.getByRole('button', { name: 'Place', exact: true }).click();
  await page.mouse.click(5, 5);
  await expect(page.locator('[data-stamp-placement]')).toBeAttached();
  await placeAt(page, 300, 400);
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);
  await expect(page.getByText(/Signature added to the page/).first()).toBeVisible();
  const [stamp, ...rest] = await stamps(page, 'signed.pdf');
  expect(rest).toEqual([]);
  expect(stamp?.pageIndex).toBe(0);
  expect(stamp?.width).toBeCloseTo(160, 0);
  expect(stamp?.centerX).toBeCloseTo(300, 0);
  expect(stamp?.centerY).toBeCloseTo(400, 0);
});

test('type: the name is painted in the chosen style and ink, initials are 60 pt wide and a remembered one can be used and deleted', async ({
  page,
}) => {
  await openPdf(page);
  let dialog = await openSignatureDialog(page);
  await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
  const place = dialog.getByRole('button', { name: 'Place', exact: true });
  await expect(place).toBeDisabled();
  await dialog.getByLabel('Full name').fill('Ada Lovelace');
  await dialog.getByLabel('Style').selectOption('vibes');
  await expect(dialog.getByLabel('Style')).toHaveValue('vibes');
  await dialog.getByRole('radio', { name: 'Blue' }).check();
  await dialog.getByRole('radio', { name: 'Initials' }).check();
  // The preview canvas holds ink in the blue of the choice.
  const blue = await page.getByRole('img', { name: 'Preview' }).evaluate((canvas) => {
    const context = (canvas as HTMLCanvasElement).getContext('2d');
    const data = context?.getImageData(
      0,
      0,
      (canvas as HTMLCanvasElement).width,
      (canvas as HTMLCanvasElement).height,
    ).data;
    let hits = 0;
    for (let index = 0; data !== undefined && index < data.length; index += 4) {
      if ((data[index + 3] ?? 0) > 200 && (data[index + 2] ?? 0) > 150 && (data[index] ?? 255) < 80)
        hits += 1;
    }
    return hits;
  });
  expect(blue).toBeGreaterThan(200);
  await dialog.getByRole('checkbox', { name: /Remember on this device/ }).check();
  await place.click();
  await placeAt(page, 200, 300);
  await expect(page.getByText(/Initials added to the page/).first()).toBeVisible();

  const remembered = await page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? '[]'),
    SAVED_KEY,
  );
  expect(remembered).toHaveLength(1);
  expect(remembered[0].role).toBe('initials');
  expect(remembered[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);

  // The remembered picture is offered at the top of the dialog and placed without drawing.
  dialog = await openSignatureDialog(page);
  const use = dialog.getByRole('button', { name: 'Use: Initials' });
  await expect(use).toBeVisible();
  await use.click();
  await placeAt(page, 400, 500);
  const placed = await stamps(page, 'initials.pdf');
  expect(placed).toHaveLength(2);
  for (const stamp of placed) expect(stamp.width).toBeCloseTo(60, 0);
  expect(placed.map((stamp) => Math.round(stamp.centerX)).sort((a, b) => a - b)).toEqual([200, 400]);

  dialog = await openSignatureDialog(page);
  await dialog.getByRole('button', { name: 'Delete saved signature: Initials' }).click();
  await expect(dialog.getByRole('button', { name: 'Use: Initials' })).toHaveCount(0);
  expect(
    await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '[]'), SAVED_KEY),
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('picture: a photographed signature loses its paper, an unreadable file is named and the dialog closes on Escape', async ({
  page,
}) => {
  await openPdf(page);
  const dialog = await openSignatureDialog(page);
  await dialog.getByRole('tab', { name: 'From a picture' }).click();
  const place = dialog.getByRole('button', { name: 'Place', exact: true });
  await expect(place).toBeDisabled();
  const file = dialog.locator('input[type="file"]');

  await file.setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not a picture'),
  });
  await expect(dialog.getByText('The picture could not be read: broken.png')).toBeVisible();
  await expect(place).toBeDisabled();

  await file.setInputFiles({ name: 'ink.png', mimeType: 'image/png', buffer: inkPng() });
  const preview = dialog.getByRole('img', { name: 'Preview' });
  await expect(preview).toBeVisible();
  await expect(dialog.getByText('ink.png')).toBeVisible();
  const before = await preview.getAttribute('src');
  // A looser threshold keeps more of the picture; the preview is recomputed.
  await dialog.getByRole('slider').fill('95');
  await expect.poll(async () => preview.getAttribute('src')).not.toBe(before);
  // The ink is recoloured: navy.
  await dialog.getByRole('radio', { name: 'Navy' }).check();
  await expect(place).toBeEnabled();
  await place.click();
  await placeAt(page, 300, 600);
  const [stamp] = await stamps(page, 'photo.pdf');
  expect(stamp?.width).toBeCloseTo(160, 0);
  // The photo's own aspect (a trimmed 120 x 40 picture) is kept.
  expect(stamp?.height).toBeGreaterThan(0);
  expect(stamp?.height).toBeLessThan(160);

  const again = await openSignatureDialog(page);
  await page.keyboard.press('Escape');
  await expect(again).toHaveCount(0);
});
