/**
 * Driving code of the `ui-marks-*.spec.ts` specs: pictures placed through the image picker,
 * the selection chrome and handles read from the page, and the exported file read back.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { encodePng, exportBytes, pageFrame, toClient } from './ui-helpers';
import { ofSubtype, readAnnotations, type WrittenAnnotation } from './ui-layers-helpers';

/** The exported file's annotations of `subtypes`, read back by MuPDF. */
export async function exported(
  page: Page,
  name: string,
  ...subtypes: readonly string[]
): Promise<readonly WrittenAnnotation[]> {
  return ofSubtype(await readAnnotations(await exportBytes(page, name)), ...subtypes);
}

/**
 * Place a flat red picture of `width × height` px (96 dpi: 0.75 pt per pixel) centred on the
 * page point (`x`, `y`) of page `index`, through the image picker and one click.
 */
export async function placePicture(
  page: Page,
  width: number,
  height: number,
  x: number,
  y: number,
  index = 0,
): Promise<void> {
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({
    name: 'picture.png',
    mimeType: 'image/png',
    buffer: encodePng(width, height, () => [200, 30, 30]),
  });
  await expect(page.locator('[data-stamp-placement]')).toBeAttached();
  const frame = await pageFrame(page, undefined, index);
  const point = toClient(frame, x, y);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);
  // The re-read inventory lists the new picture and selects it: its four handles are the sign.
  await expect(page.locator('[data-mark-resize]')).toHaveCount(4);
}

/** The rectangle of the `at`-th stamp of the exported file. */
export function rectOf(
  stamps: readonly WrittenAnnotation[],
  at = 0,
): readonly [number, number, number, number] {
  const [left, bottom, right, top] = stamps[at]?.rect ?? [];
  if (left === undefined || bottom === undefined || right === undefined || top === undefined) {
    throw new Error(`the exported file has no stamp number ${at} with a rectangle`);
  }
  return [left, bottom, right, top];
}

/** A client-space press, travel and release started at the centre of `from`. */
export async function dragFrom(
  page: Page,
  from: Locator,
  deltaX: number,
  deltaY: number,
  steps = 8,
): Promise<void> {
  const box = await from.boundingBox();
  if (box === null) throw new Error('nothing to drag from');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps });
  await page.mouse.up();
}

/** Click `button`, take the download it starts and keep the file under the test's output. */
export async function download(
  page: Page,
  button: Locator,
  name: string,
): Promise<{ readonly name: string; readonly text: string; readonly path: string }> {
  const started = page.waitForEvent('download');
  await button.click();
  const file = await started;
  const path = test.info().outputPath(name);
  await file.saveAs(path);
  return { name: file.suggestedFilename(), text: readFileSync(path, 'utf8'), path };
}
