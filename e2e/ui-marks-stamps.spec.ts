/**
 * A placed picture is a mark in the file (`/Stamp`) that the selection layer owns: it is
 * selected with the pointer, scaled from its four corner handles or with the arrow keys on a
 * focused handle, moved by a drag or the strip's nudge, deleted with the key, and every
 * step is undone and redone. The exported file is read back after each one.
 */

import { expect, test } from './test';
import { openPdf, rail } from './ui-helpers';
import { clickAt, expectNear, framed } from './ui-layers-helpers';
import { dragFrom, exported, placePicture, rectOf } from './ui-marks-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

const HANDLE_LABEL = 'Resize';

test('a picture is selected on placement; a corner drag scales it about the opposite corner, aspect kept; undo and redo restore the file', async ({
  page,
}) => {
  await openPdf(page);
  await framed(page);
  await placePicture(page, 400, 200, 300, 400);
  const selection = page.locator('[data-mark-selection="existing"]');
  await expect(selection).toHaveCount(1);
  const handles = page.locator('[data-mark-resize]');
  await expect(handles).toHaveCount(4);
  await expect(handles.first()).toHaveAccessibleName(HANDLE_LABEL);

  const placed = rectOf(await exported(page, 'placed.pdf', 'Stamp'));
  expectNear(placed[0], 150);
  expectNear(placed[1], 325);
  expectNear(placed[2], 450);
  expectNear(placed[3], 475);

  // Drag the south-east handle out by 60 pt right and 30 pt down: the north-west corner stays.
  const frame = await framed(page);
  await dragFrom(page, page.locator('[data-mark-resize="se"]'), 60 * frame.scale, 30 * frame.scale);
  await expect.poll(async () => rectOf(await exported(page, 'grown.pdf', 'Stamp'))[2]).toBeGreaterThan(500);
  const grown = rectOf(await exported(page, 'grown.pdf', 'Stamp'));
  expectNear(grown[0], 150);
  expectNear(grown[3], 475);
  expectNear(grown[2] - grown[0], 360, 2);
  expectNear(grown[3] - grown[1], 180, 2);
  await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);

  // Undo takes the stamp back to where it was placed, redo to the grown box.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => rectOf(await exported(page, 'undone.pdf', 'Stamp'))[2]).toBeCloseTo(450, 0);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => rectOf(await exported(page, 'redone.pdf', 'Stamp'))[2]).toBeCloseTo(510, 0);

  // A handle dragged inwards past the least size stops at the minimum side.
  await page.locator('[data-mark-resize="nw"]').focus();
  await dragFrom(page, page.locator('[data-mark-resize="nw"]'), 600, 600, 6);
  const least = rectOf(await exported(page, 'least.pdf', 'Stamp'));
  expect(Math.min(least[2] - least[0], least[3] - least[1])).toBeGreaterThanOrEqual(8 - 0.01);
  expectNear(least[2], 510);
  expectNear(least[1], 295);
});

test('the arrow keys on a focused handle grow and shrink the picture by a twentieth about the opposite corner', async ({
  page,
}) => {
  await openPdf(page);
  await framed(page);
  await placePicture(page, 400, 200, 300, 400);
  const nw = page.locator('[data-mark-resize="nw"]');
  await nw.focus();
  await page.keyboard.press('ArrowRight');
  // Grown by 5 %: the south-east corner (450, 325) stays, the box is 315 × 157.5.
  await expect.poll(async () => rectOf(await exported(page, 'grow.pdf', 'Stamp'))[0]).toBeLessThan(140);
  const grown = rectOf(await exported(page, 'grow.pdf', 'Stamp'));
  expectNear(grown[2], 450);
  expectNear(grown[1], 325);
  expectNear(grown[2] - grown[0], 315, 1);
  expectNear(grown[3] - grown[1], 157.5, 1);

  // A key that is not an arrow resizes nothing and stays with the handle.
  await page.locator('[data-mark-resize="ne"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => {
      const rect = rectOf(await exported(page, 'shrunk.pdf', 'Stamp'));
      return rect[2] - rect[0];
    })
    .toBeLessThan(314);
  const shrunk = rectOf(await exported(page, 'shrunk.pdf', 'Stamp'));
  // The north-east handle holds the opposite (south-west) corner.
  expectNear(shrunk[0], grown[0]);
  expectNear(shrunk[1], grown[1]);
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
});

test('a drag on the picture moves it, the strip nudges it, Delete removes it and undo brings it back; Ctrl-click adds a second picture', async ({
  page,
}) => {
  await openPdf(page);
  await framed(page);
  await placePicture(page, 400, 200, 300, 400);
  await placePicture(page, 160, 160, 120, 250);

  // The second placement selected only the second picture.
  await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
  // A Ctrl-click on the first picture adds it to the selection; the handles go (not one mark).
  await page.keyboard.down('Control');
  await clickAt(page, 380, 440);
  await page.keyboard.up('Control');
  await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(2);
  await expect(page.locator('[data-mark-resize]')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Selection' })).toHaveText('2 mark(s) selected');

  // A plain press on a mark that is already selected keeps the whole selection: the drag
  // that follows carries all of it.
  await clickAt(page, 380, 440);
  await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(2);
  // A Ctrl-click on a selected mark takes it out again; one picture is left, with its handles.
  await page.keyboard.down('Control');
  await clickAt(page, 380, 440);
  await page.keyboard.up('Control');
  await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
  await expect(page.locator('[data-mark-resize]')).toHaveCount(4);
  // A click on blank page clears it, and a click on the first picture selects just that one.
  await clickAt(page, 20, 830);
  await expect(page.locator('[data-mark-selection]')).toHaveCount(0);
  await clickAt(page, 380, 440);
  await expect(page.locator('[data-mark-selection="existing"]')).toHaveCount(1);
  await expect(page.locator('[data-mark-resize]')).toHaveCount(4);

  // The drag carries the picture 50 pt left and 20 pt up on the screen: rect x-50, y+20 (PDF up).
  const frame = await framed(page);
  const selected = page.locator('[data-mark-selection="existing"]');
  await dragFrom(page, selected, -50 * frame.scale, -20 * frame.scale);
  await expect
    .poll(async () =>
      (await exported(page, 'moved.pdf', 'Stamp')).map((stamp) => Math.round(stamp.rect[0] ?? 0)),
    )
    .toContain(100);
  const moved = (await exported(page, 'moved.pdf', 'Stamp')).map((stamp) => stamp.rect);
  const first = moved.find((rect) => (rect[2] ?? 0) - (rect[0] ?? 0) > 200);
  expectNear(first?.[0], 100);
  expectNear(first?.[1], 345);
  expectNear(first?.[2], 400);
  expectNear(first?.[3], 495);

  // The strip's nudge is five points up.
  await page.getByRole('button', { name: 'Move up (5 pt)', exact: true }).click();
  await expect
    .poll(async () => {
      const rects = (await exported(page, 'nudged.pdf', 'Stamp')).map((stamp) => stamp.rect);
      return Math.round(rects.find((rect) => (rect[2] ?? 0) - (rect[0] ?? 0) > 200)?.[1] ?? 0);
    })
    .toBe(350);

  // Delete removes the selected picture only.
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await exported(page, 'deleted.pdf', 'Stamp')).length).toBe(1);
  const left = rectOf(await exported(page, 'deleted.pdf', 'Stamp'));
  expectNear(left[2] - left[0], 120, 1);

  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await exported(page, 'restored.pdf', 'Stamp')).length).toBe(2);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await exported(page, 'again.pdf', 'Stamp')).length).toBe(1);
  await expect(rail(page, 'Selection Tool')).toBeVisible();
});
