/**
 * The marks the annotation layer drew, edited on the page afterwards: a free text box with its
 * chosen colour and size is moved, a note is moved and re-worded, a shape is moved and
 * survives an interrupted drag, and a Shift-marquee merges its hits into the selection.
 * Each result is read back from the exported file.
 */

import { expect, test } from './test';
import { drag, dragPage, exportBytes, openPdf, rail, toClient } from './ui-helpers';
import { clickAt, expectNear, framed, ofSubtype, readAnnotations } from './ui-layers-helpers';
import { dragFrom, exported, freeTextAppearances } from './ui-marks-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 120_000 });

const SAVED_NOTE = 'Saved source note body';

test('a free text box keeps the colour and size chosen in the strip, and a drag moves it with its undo', async ({
  page,
}) => {
  await openPdf(page);
  await framed(page);
  await rail(page, 'Add Text').click();
  await page.getByLabel('Color', { exact: true }).first().fill('#ff0000');
  await page.getByLabel('Size', { exact: true }).fill('24');
  await clickAt(page, 100, 300);
  await page.keyboard.type('Styled words');
  await page.keyboard.press('Control+Enter');

  const own = async (name: string) =>
    ofSubtype(await readAnnotations(await exportBytes(page, name)), 'FreeText').filter(
      (annotation) => annotation.contents === 'Styled words',
    );
  const [placed] = await own('styled.pdf');
  expectNear(placed?.rect[0], 100, 2);
  expectNear(placed?.rect[3], 300, 2);
  // The text is 24 pt tall at least, in red.
  expect((placed?.rect[3] ?? 0) - (placed?.rect[1] ?? 0)).toBeGreaterThanOrEqual(24);
  const appearances = await freeTextAppearances(await exportBytes(page, 'styled-da.pdf'));
  // The file's own note keeps its 10 pt black; the new box is 24 pt red.
  expect(appearances).toEqual(['/F1 10 Tf 0 g', '/Helv 24.000 Tf 1.000 0.000 0.000 rg']);

  // Select it with the selection tool and drag it 60 pt right, 40 pt down.
  await clickAt(page, 110, 290);
  const selected = page.locator('[data-mark-selection="annotation"]');
  await expect(selected).toHaveCount(1);
  const frame = await framed(page);
  await dragFrom(page, selected, 60 * frame.scale, 40 * frame.scale);
  await expect.poll(async () => (await own('moved.pdf'))[0]?.rect[0]).toBeGreaterThan(150);
  const [moved] = await own('moved.pdf');
  expectNear(moved?.rect[0], 160, 2);
  expectNear(moved?.rect[3], 260, 2);
  expectNear(
    (moved?.rect[2] ?? 0) - (moved?.rect[0] ?? 0),
    (placed?.rect[2] ?? 0) - (placed?.rect[0] ?? 0),
    0.5,
  );

  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await own('undone.pdf'))[0]?.rect[0]).toBeLessThan(110);
  expectNear((await own('undone.pdf'))[0]?.rect[3], 300, 2);
});

test('a note is moved by a drag and its comment re-worded in the panel; the file holds the new place and words', async ({
  page,
}) => {
  await openPdf(page);
  await framed(page);
  await rail(page, 'Add comment / Note').click();
  await clickAt(page, 250, 300);
  await page.getByRole('tab', { name: 'Comments' }).click();
  const row = page.locator('ul[aria-label="Comments"] > li').filter({ hasText: 'unsaved' }).first();
  await row.getByRole('button', { name: 'Edit comment' }).click();
  const body = page.getByLabel('Comment text').first();
  await body.fill('First wording');
  await body.blur();
  await expect(row).toContainText('First wording');

  const notes = async (name: string) =>
    ofSubtype(await readAnnotations(await exportBytes(page, name)), 'Text');
  const [first] = await notes('note-1.pdf');
  expect(first?.contents).toBe('First wording');
  const centre = (rect: readonly number[] | undefined) => [
    ((rect?.[0] ?? 0) + (rect?.[2] ?? 0)) / 2,
    ((rect?.[1] ?? 0) + (rect?.[3] ?? 0)) / 2,
  ];
  expectNear(centre(first?.rect)[0], 250, 3);
  expectNear(centre(first?.rect)[1], 300, 3);

  // The note is selected on creation; dragging it 80 pt right and 50 pt up moves it.
  const frame = await framed(page);
  await clickAt(page, 250, 300);
  const selected = page.locator('[data-mark-selection="annotation"]');
  await expect(selected).toHaveCount(1);
  await dragFrom(page, selected, 80 * frame.scale, -50 * frame.scale);
  await expect.poll(async () => centre((await notes('note-2.pdf'))[0]?.rect)[0]).toBeGreaterThan(300);
  const [moved] = await notes('note-3.pdf');
  expectNear(centre(moved?.rect)[0], 330, 3);
  expectNear(centre(moved?.rect)[1], 350, 3);
  expect(moved?.contents).toBe('First wording');

  // Re-worded in the panel: the file keeps the place and takes the new words.
  await row.getByRole('button', { name: 'Edit comment' }).click();
  await page.getByLabel('Comment text').first().fill('Second wording');
  await page.getByLabel('Comment text').first().blur();
  await expect(row).toContainText('Second wording');
  const [reworded] = await notes('note-4.pdf');
  expect(reworded?.contents).toBe('Second wording');
  expectNear(centre(reworded?.rect)[0], 330, 3);
});

test('a shape is moved by a drag, an interrupted drag leaves it where it was, and Delete takes it out of the file', async ({
  page,
}) => {
  await openPdf(page);
  const frame = await framed(page);
  await rail(page, 'Draw Shape (Rectangle)').click();
  await dragPage(page, [380, 360], [500, 400]);
  const squares = (name: string) => exported(page, name, 'Square');
  const [placed] = await squares('square-1.pdf');
  expectNear(placed?.rect[0], 380, 3);
  expectNear(placed?.rect[3], 400, 3);

  const stroke = toClient(frame, 380, 380);
  await clickAt(page, 380, 380);
  await expect(page.locator('[data-mark-selection="annotation"]')).toHaveCount(1);

  // A pointer cancel in the middle of the drag: the outline goes, the release moves nothing.
  await page.mouse.move(stroke.x, stroke.y);
  await page.mouse.down();
  await page.mouse.move(stroke.x + 50, stroke.y + 50, { steps: 8 });
  await expect(page.locator('[data-mark-move-preview]')).toHaveCount(1);
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })),
  );
  await expect(page.locator('[data-mark-move-preview]')).toHaveCount(0);
  await page.mouse.up();
  const [stayed] = await squares('square-2.pdf');
  expectNear(stayed?.rect[0], 380, 3);
  expectNear(stayed?.rect[1], 360, 3);

  // A completed drag by 40 pt right, 30 pt down.
  await drag(
    page,
    { x: stroke.x, y: stroke.y },
    { x: stroke.x + 40 * frame.scale, y: stroke.y + 30 * frame.scale },
    8,
  );
  await expect.poll(async () => (await squares('square-3.pdf'))[0]?.rect[0]).toBeGreaterThan(400);
  const [moved] = await squares('square-4.pdf');
  expectNear(moved?.rect[0], 420, 3);
  expectNear(moved?.rect[1], 330, 3);
  expectNear(
    (moved?.rect[2] ?? 0) - (moved?.rect[0] ?? 0),
    (placed?.rect[2] ?? 0) - (placed?.rect[0] ?? 0),
    0.5,
  );

  await page.keyboard.press('Delete');
  await expect.poll(async () => (await squares('square-5.pdf')).length).toBe(0);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await squares('square-6.pdf')).length).toBe(1);
});

test('a Shift-marquee adds what it covers to the selection; Delete removes the file’s marks and undo returns them', async ({
  page,
}) => {
  await openPdf(page);
  await framed(page);
  // The saved note on the right, taken by a marquee over its box.
  await dragPage(page, [385, 545], [575, 612]);
  await expect(page.getByRole('status', { name: 'Selection' })).toHaveText('1 mark(s) selected');
  // A Shift-marquee over the highlight's right end keeps the note and adds the highlight.
  await page.keyboard.down('Shift');
  await dragPage(page, [230, 736], [330, 795]);
  await page.keyboard.up('Shift');
  await expect(page.getByRole('status', { name: 'Selection' })).toHaveText('3 mark(s) selected');

  await page.keyboard.press('Delete');
  // What is left of those kinds is the second page's own highlight.
  await expect
    .poll(async () =>
      (await exported(page, 'gone.pdf', 'Highlight', 'FreeText')).map((a) => [a.subtype, a.pageIndex]),
    )
    .toEqual([['Highlight', 1]]);
  const left = await exported(page, 'left.pdf', 'Ink');
  expect(left).toHaveLength(2);

  await page.keyboard.press('Control+z');
  await expect
    .poll(async () =>
      (await exported(page, 'back.pdf', 'Highlight', 'FreeText')).map((annotation) => annotation.contents),
    )
    .toContain(SAVED_NOTE);
});
