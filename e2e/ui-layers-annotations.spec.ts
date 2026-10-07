/**
 * The annotation creation layer: typed text, notes, shapes, freehand strokes and the text
 * markups, each driven with the pointer and read back from the exported file in page
 * points (origin bottom-left).
 */

import { expect, test } from './test';
import { PAGE_ONE_LINES } from './tool-fixture';
import { drag, exportBytes, openPdf, pageFrame, rail, toClient } from './ui-helpers';
import { clickAt, expectNear, ofSubtype, readAnnotations } from './ui-layers-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

const FREETEXT_TOOL = 'Add Text';
const SHAPE_TOOL = 'Draw Shape (Rectangle)';
const INK_TOOL = 'Freehand drawing';
const MARKUP_TOOL = 'Mark Up Text (highlight, underline, strike)';

test('typed text is committed by Ctrl+Enter or by a press elsewhere; Escape and an empty box add nothing', async ({
  page,
}) => {
  await openPdf(page);
  const editor = page.getByRole('textbox', { name: 'Text to add to the page', exact: true });

  // Ctrl+Enter commits, and the one-shot tool is gone.
  await rail(page, FREETEXT_TOOL).click();
  await clickAt(page, 100, 450);
  await expect(editor).toBeFocused();
  await page.keyboard.type('Hello layers');
  await page.keyboard.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-ann]')).toHaveCount(1);
  await expect(rail(page, FREETEXT_TOOL)).toHaveAttribute('aria-pressed', 'false');

  // A press elsewhere blurs the box, which commits it; that press starts no second box.
  await rail(page, FREETEXT_TOOL).click();
  await clickAt(page, 100, 400);
  await page.keyboard.type('Second box');
  await clickAt(page, 450, 520);
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-ann]')).toHaveCount(2);

  // Escape drops the box with what was typed in it.
  await rail(page, FREETEXT_TOOL).click();
  await clickAt(page, 100, 350);
  await page.keyboard.type('Never kept');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-ann]')).toHaveCount(2);

  // A box with only blanks is no mark.
  await rail(page, FREETEXT_TOOL).click();
  await clickAt(page, 100, 320);
  await page.keyboard.type('   ');
  await page.keyboard.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-ann]')).toHaveCount(2);
  // Nothing was made, so the tool is still armed for the next box.
  await expect(rail(page, FREETEXT_TOOL)).toHaveAttribute('aria-pressed', 'true');

  // Disarming the tool with a box open drops the box.
  await clickAt(page, 100, 300);
  await expect(editor).toBeVisible();
  await rail(page, 'Selection Tool').click();
  await expect(editor).toHaveCount(0);

  const texts = ofSubtype(await readAnnotations(await exportBytes(page, 'text.pdf')), 'FreeText').filter(
    (annotation) => annotation.contents !== 'Saved source note body',
  );
  expect(texts.map((annotation) => annotation.contents).sort()).toEqual(['Hello layers', 'Second box']);
  const hello = texts.find((annotation) => annotation.contents === 'Hello layers');
  // The box's top-left corner is where the press was.
  expectNear(hello?.rect[0], 100, 2);
  expectNear(hello?.rect[3], 450, 2);
  expect((hello?.rect[2] ?? 0) - (hello?.rect[0] ?? 0)).toBeGreaterThanOrEqual(40);
});

test('a note is placed at the press and kept inside the page near an edge', async ({ page }) => {
  await openPdf(page);
  await rail(page, 'Add comment / Note').click();
  await clickAt(page, 594, 300);
  await expect(rail(page, 'Add comment / Note')).toHaveAttribute('aria-pressed', 'false');
  const notes = ofSubtype(await readAnnotations(await exportBytes(page, 'note.pdf')), 'Text');
  expect(notes).toHaveLength(1);
  const [note] = notes;
  expect(note?.rect[2]).toBeLessThanOrEqual(595.5);
  expect(note?.rect[0]).toBeGreaterThan(560);
  expectNear(((note?.rect[1] ?? 0) + (note?.rect[3] ?? 0)) / 2, 300, 2);
});

test('rectangle, circle and line are drawn by a drag; a click, a tiny drag or a right-button drag draws nothing', async ({
  page,
}) => {
  await openPdf(page);
  const frame = await pageFrame(page);
  const shapeKind = page.getByRole('combobox', { name: 'Shape', exact: true });

  await rail(page, SHAPE_TOOL).click();
  // None of these is a shape, and the tool stays armed.
  const start = toClient(frame, 120, 330);
  await page.mouse.click(start.x, start.y);
  await drag(page, start, { x: start.x + 2, y: start.y + 2 }, 2);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(start.x + 60, start.y + 60, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('[data-ann]')).toHaveCount(0);
  await expect(rail(page, SHAPE_TOOL)).toHaveAttribute('aria-pressed', 'true');

  // A window blur mid-drag discards the gesture: its release adds nothing.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 80, start.y + 50, { steps: 4 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await expect(page.locator('[data-ann]')).toHaveCount(0);

  // The live rectangle follows the drag.
  const end = toClient(frame, 220, 280);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  const preview = page.locator('span.pointer-events-none.border-kumo-focus');
  await expect(preview).toBeVisible();
  const live = await preview.boundingBox();
  expectNear(live?.width, end.x - start.x, 2);
  expectNear(live?.height, end.y - start.y, 2);
  await page.mouse.up();
  await expect(page.locator('[data-ann]')).toHaveCount(1);
  await expect(preview).toHaveCount(0);

  await rail(page, SHAPE_TOOL).click();
  await shapeKind.selectOption('circle');
  await drag(page, toClient(frame, 300, 330), toClient(frame, 400, 270));
  await rail(page, SHAPE_TOOL).click();
  await shapeKind.selectOption('line');
  await drag(page, toClient(frame, 120, 560), toClient(frame, 260, 500));
  await expect(page.locator('[data-ann]')).toHaveCount(3);
  await expect(page.locator('[data-ann] line')).toHaveCount(1);

  const marks = await readAnnotations(await exportBytes(page, 'shapes.pdf'));
  const square = ofSubtype(marks, 'Square')[0];
  expectNear(square?.rect[0], 120, 3);
  expectNear(square?.rect[1], 280, 3);
  expectNear(square?.rect[2], 220, 3);
  expectNear(square?.rect[3], 330, 3);
  const circle = ofSubtype(marks, 'Circle')[0];
  expectNear(circle?.rect[0], 300, 3);
  expectNear(circle?.rect[1], 270, 3);
  expectNear(circle?.rect[2], 400, 3);
  expectNear(circle?.rect[3], 330, 3);
  const line = ofSubtype(marks, 'Line')[0];
  expectNear(line?.line[0], 120, 3);
  expectNear(line?.line[1], 560, 3);
  expectNear(line?.line[2], 260, 3);
  expectNear(line?.line[3], 500, 3);
});

test('ink keeps the tool armed for the next stroke; a dot is not a stroke; the stroke is flat in the file', async ({
  page,
}) => {
  await openPdf(page);
  const frame = await pageFrame(page);
  await rail(page, INK_TOOL).click();

  const at = (x: number, y: number) => toClient(frame, x, y);
  await page.mouse.click(at(300, 300).x, at(300, 300).y);
  await expect(page.locator('[data-ann]')).toHaveCount(0);

  await page.mouse.move(at(100, 400).x, at(100, 400).y);
  await page.mouse.down();
  await page.mouse.move(at(150, 440).x, at(150, 440).y, { steps: 5 });
  await page.mouse.move(at(200, 400).x, at(200, 400).y, { steps: 5 });
  await expect(page.locator('svg polyline[stroke-linecap="round"]').first()).toBeVisible();
  await page.mouse.up();
  await expect(rail(page, INK_TOOL)).toHaveAttribute('aria-pressed', 'true');
  await drag(page, at(300, 400), at(400, 440), 6);
  await expect(page.locator('[data-ann]')).toHaveCount(2);

  const inks = ofSubtype(await readAnnotations(await exportBytes(page, 'ink.pdf')), 'Ink').filter(
    (annotation) => annotation.contents !== 'Saved ink left' && annotation.contents !== 'Saved ink right',
  );
  expect(inks).toHaveLength(2);
  const first = inks.find((annotation) => (annotation.inkLists[0]?.[0] ?? 0) < 250);
  // One continuous stroke, flat: x/y pairs from (100, 400) through (150, 440) to (200, 400).
  expect(first?.inkLists).toHaveLength(1);
  const run = first?.inkLists[0] ?? [];
  expect(run.length).toBeGreaterThan(10);
  expect(run.length % 2).toBe(0);
  expectNear(run[0], 100, 2);
  expectNear(run[1], 400, 2);
  expectNear(run[run.length - 2], 200, 2);
  expectNear(run[run.length - 1], 400, 2);
  expect(Math.max(...run.filter((_, index) => index % 2 === 1))).toBeGreaterThan(436);
});

test('the markup looks mark selected words as underline, strikeout and squiggly, and the marker draws freehand where there are no words', async ({
  page,
}) => {
  await openPdf(page);
  const select = async (text: string) => {
    const box = await page.locator('.textLayer span').filter({ hasText: text }).first().boundingBox();
    if (box === null) throw new Error(`no text line ${text}`);
    await drag(
      page,
      { x: box.x + 2, y: box.y + box.height / 2 },
      { x: box.x + box.width - 0.25, y: box.y + box.height / 2 },
    );
  };
  const look = (name: string) =>
    page.getByRole('group', { name: 'Style', exact: true }).getByRole('button', { name, exact: true });

  // Armed first, then selected: the release commits the selection.
  await rail(page, MARKUP_TOOL).click();
  await look('Underline').click();
  await select(PAGE_ONE_LINES[2].text);
  await expect(page.locator('[data-ann]')).toHaveCount(1);

  // Selected first, then armed from the context menu: arming marks what is already selected.
  await select(PAGE_ONE_LINES[3].text);
  const box = await page
    .locator('.textLayer span')
    .filter({ hasText: PAGE_ONE_LINES[3].text })
    .first()
    .boundingBox();
  if (box === null) throw new Error('no fourth line');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Strikethrough' }).click();
  await expect(page.locator('[data-ann]')).toHaveCount(2);

  await rail(page, MARKUP_TOOL).click();
  await look('Squiggly').click();
  await select(PAGE_ONE_LINES[2].text);
  await expect(page.locator('[data-ann]')).toHaveCount(3);

  // Highlight over a blank area: no words, so the drag is a freehand marker stroke.
  await rail(page, MARKUP_TOOL).click();
  await look('Highlight').click();
  const blank = await pageFrame(page);
  await drag(page, toClient(blank, 120, 300), toClient(blank, 320, 320));
  await expect(page.locator('[data-ann]')).toHaveCount(4);

  const marks = await readAnnotations(await exportBytes(page, 'markups.pdf'));
  for (const [subtype, baseline] of [
    ['Underline', 640],
    ['StrikeOut', 580],
    ['Squiggly', 640],
  ] as const) {
    const found = ofSubtype(marks, subtype);
    expect(found, subtype).toHaveLength(1);
    expectNear(found[0]?.rect[0], 72, 3);
    expect(found[0]?.rect[1]).toBeLessThan(baseline);
    expect(found[0]?.rect[3]).toBeGreaterThan(baseline);
  }
  // The freehand stroke is written as a highlight band along its path (quads per segment),
  // so its rectangle spans the drag from (120, 300) to (320, 320).
  // The fixture's own highlight over line one has a comment; the stroke has none.
  const marker = ofSubtype(marks, 'Highlight').filter(
    (annotation) => annotation.pageIndex === 0 && annotation.contents === '',
  );
  expect(marker).toHaveLength(1);
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = marker[0]?.rect ?? [];
  expect([x0 < 121, y0 < 301, x1 > 319, y1 > 319]).toEqual([true, true, true, true]);
  expect([x0 > 100, y0 > 280, x1 < 340, y1 < 340]).toEqual([true, true, true, true]);
  expect(marker[0]?.quadPoints.length).toBeGreaterThanOrEqual(8);
});
