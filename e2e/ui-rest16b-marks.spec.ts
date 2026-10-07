/**
 * A selected picture: a press that travels less than the drag threshold is a click, not a
 * move, so the file keeps the picture where it was; a real drag moves it.
 */

import { expect, test } from './test';
import { openPdf } from './ui-helpers';
import { exported, placePicture, rectOf } from './ui-marks-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 120_000 });

test('a press on the selected picture that moves a pixel or two moves nothing; a real drag does', async ({
  page,
}) => {
  await openPdf(page);
  await placePicture(page, 400, 200, 300, 400);
  const before = rectOf(await exported(page, 'placed.pdf', 'Stamp'));

  const selection = page.locator('[data-mark-selection]').first();
  const box = await selection.boundingBox();
  if (box === null) throw new Error('the placed picture has no selection box');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 2, centre.y + 1);
  await page.mouse.up();
  expect(rectOf(await exported(page, 'nudged.pdf', 'Stamp'))).toEqual(before);

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => rectOf(await exported(page, 'moved.pdf', 'Stamp'))[0], { timeout: 30_000 })
    .toBeGreaterThan(before[0] + 20);
});
