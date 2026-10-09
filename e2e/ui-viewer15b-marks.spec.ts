/**
 * The resize handles of a selected picture: a press and release without a move changes
 * nothing, and an interrupted drag (pointercancel) leaves the picture where it was.
 */

import { expect, test } from './test';
import { openPdf } from './ui-helpers';
import { exported, placePicture, rectOf } from './ui-marks-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 120_000 });

test('pressing a resize handle without moving, and an interrupted drag, leave the picture as placed', async ({
  page,
}) => {
  await openPdf(page);
  await placePicture(page, 400, 200, 300, 400);
  const before = rectOf(await exported(page, 'placed.pdf', 'Stamp'));
  const handle = page.locator('[data-mark-resize="se"]');
  const handles = page.locator('[data-mark-resize]');

  // A press and release in place is no resize. The pointer is put on the handle with `hover`,
  // which waits until the handle has stopped moving (the export just before unmounts and
  // remounts the handles, and the page may still be laying out) and is what receives the
  // pointer: a press on coordinates read a moment earlier lands on the page behind the handle
  // when it has moved, and a press on the page clears the selection and the handles with it.
  await handle.hover();
  await page.mouse.down();
  await page.mouse.up();
  await expect(handles).toHaveCount(4);

  // A drag taken over by the system: the box follows the pointer until it is cancelled.
  await handle.hover();
  const box = await handle.boundingBox();
  if (box === null) throw new Error('the handle has no box');
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.down();
  await page.mouse.move(at.x + 80, at.y + 40, { steps: 5 });
  await handle.dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
  await page.mouse.up();

  await expect(page.locator('[data-mark-resize]')).toHaveCount(4);
  expect(rectOf(await exported(page, 'unchanged.pdf', 'Stamp'))).toEqual(before);
});
