/**
 * Clearing the selection: an empty click clears it, a modifier-click on empty page keeps it,
 * and a press that travels less than the drag threshold is still a click.
 */

import { expect, test } from './test';
import { openPdf, pageFrame, rail, toClient } from './ui-helpers';
import { placePicture } from './ui-marks-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 120_000 });

test('a Shift-click on empty page keeps the selected picture; a plain click, even with a slight move, clears it', async ({
  page,
}) => {
  await openPdf(page);
  await placePicture(page, 400, 200, 300, 400);
  await rail(page, 'Selection Tool').click();
  const handles = page.locator('[data-mark-resize]');
  await expect(handles).toHaveCount(4);

  const frame = await pageFrame(page);
  const empty = toClient(frame, 20, 830);

  await page.keyboard.down('Shift');
  await page.mouse.click(empty.x, empty.y);
  await page.keyboard.up('Shift');
  await expect(handles).toHaveCount(4);

  // The layer arms itself against the inventory of the rewritten file, so the press is
  // retried until it answers.
  await expect(async () => {
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.move(empty.x + 1, empty.y + 1);
    await page.mouse.up();
    await expect(handles).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
});
