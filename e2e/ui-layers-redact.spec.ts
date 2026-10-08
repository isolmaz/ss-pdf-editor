/**
 * The redaction marking layer: a drag over the page becomes a pending area in page
 * points, a click or a right-button press is not a mark, and the tool leaves after a mark.
 */

import { expect, test } from './test';
import { drag, openPdf, pageFrame, rail, toClient } from './ui-helpers';
import { expectNear } from './ui-layers-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

const REDACT_TOOL = 'Redact (permanent removal)';

test('a drag marks a pending area where it was drawn and the tool is left; a click or a right-button drag marks nothing', async ({
  page,
}) => {
  await openPdf(page);
  const frame = await pageFrame(page);
  const layer = page.getByRole('application', { name: 'Draw rectangle', exact: true });
  const areas = page.locator('[data-mark-family="redaction"]');

  await rail(page, REDACT_TOOL).click();
  await expect(layer).toBeVisible();

  // A click is not a rectangle, and neither is a drag with the right button.
  const centre = toClient(frame, 300, 300);
  await page.mouse.click(centre.x, centre.y);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(centre.x + 80, centre.y + 40, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(areas).toHaveCount(0);
  await expect(layer).toBeVisible();

  // The preview follows the pointer while it is down.
  const from = toClient(frame, 72, 594);
  const to = toClient(frame, 320, 574);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  const preview = layer.locator('span[aria-hidden="true"]');
  await expect(preview).toBeVisible();
  const drawing = await preview.boundingBox();
  expect(drawing?.width).toBeCloseTo(to.x - from.x, 0);
  expect(drawing?.height).toBeCloseTo(to.y - from.y, 0);
  await page.mouse.up();

  // One mark in page points, and the one-shot tool is gone.
  await expect(areas).toHaveCount(1);
  await expect(layer).toHaveCount(0);
  const shown = await areas.first().boundingBox();
  expectNear(shown?.x, from.x, 2);
  expectNear(shown?.y, from.y, 2);
  expectNear(shown?.width, to.x - from.x, 2);
  expectNear(shown?.height, to.y - from.y, 2);

  // Armed again, a drag that ends off every page is not a mark.
  await rail(page, REDACT_TOOL).click();
  await drag(page, toClient(frame, 300, 300), { x: 5, y: 300 });
  await expect(areas).toHaveCount(1);
});
