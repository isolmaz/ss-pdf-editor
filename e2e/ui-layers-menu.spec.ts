/**
 * The viewer's right-click menu and the redaction marking layer, as a user meets them:
 * the menu is placed inside the window, closes on Escape or a press outside, and each
 * entry does what its label says (checked on the page and on the exported file); the
 * redaction tool draws a box, keeps the rectangle in page points, and ignores a click.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { PAGE_ONE_LINES, readProducedEntry } from './tool-fixture';
import { drag, exportBytes, openPdf, pageFrame, rail, toClient } from './ui-helpers';
import { clickAt, expectNear, ofSubtype, readAnnotations } from './ui-layers-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

const REDACT_TOOL = 'Redact (permanent removal)';

async function rightClick(page: Page, x: number, y: number) {
  await clickAt(page, x, y, { button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
}

test('the menu without a selection offers the page actions, stays inside the window and closes on Escape or an outside press', async ({
  page,
}) => {
  await openPdf(page);
  await rightClick(page, 300, 300);
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Page & Edit', { exact: true })).toBeVisible();
  await expect(menu.getByText('Text Selection Actions')).toHaveCount(0);
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Rotate Clockwise (90°)',
    'Rotate Counterclockwise (-90°)',
    'Delete Current Page',
    'Add Text',
    'Edit Text',
    'Freehand Draw',
    'Fit Width',
  ]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // A press near the bottom of the page area: the menu is moved up by its own measured size.
  await page.mouse.click(900, 960, { button: 'right' });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(1000 - 8 + 0.5);
  expect(box?.y).toBeLessThan(960);
  expect(box?.x).toBeCloseTo(900, 0);

  // A press anywhere else closes it without running anything.
  await page.mouse.click(600, 500);
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Freehand drawing', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('rotate, delete and the tool entries run the page action or arm the tool, and close the menu', async ({
  page,
}) => {
  await openPdf(page);
  const menu = page.getByRole('menu');

  await rightClick(page, 300, 300);
  await menu.getByRole('menuitem', { name: 'Freehand Draw' }).click();
  await expect(menu).toHaveCount(0);
  await expect(rail(page, 'Freehand drawing')).toHaveAttribute('aria-pressed', 'true');

  await rightClick(page, 300, 300);
  await menu.getByRole('menuitem', { name: 'Add Text' }).click();
  await expect(rail(page, 'Add Text')).toHaveAttribute('aria-pressed', 'true');

  await rightClick(page, 300, 300);
  await menu.getByRole('menuitem', { name: 'Edit Text' }).click();
  await expect(rail(page, 'Edit Text')).toHaveAttribute('aria-pressed', 'true');

  await rightClick(page, 300, 300);
  await menu.getByRole('menuitem', { name: 'Fit Width' }).click();
  await expect(page.getByRole('button', { name: /^Fit Width \(\d+%\)$/ })).toBeVisible();

  await rightClick(page, 300, 300);
  await menu.getByRole('menuitem', { name: 'Rotate Clockwise (90°)' }).click();
  await rightClick(page, 300, 300);
  await menu.getByRole('menuitem', { name: 'Rotate Clockwise (90°)' }).click();
  await rightClick(page, 300, 300);
  await menu.getByRole('menuitem', { name: 'Rotate Counterclockwise (-90°)' }).click();
  await expect(menu).toHaveCount(0);

  const turned = await exportBytes(page, 'turned.pdf');
  // Two turns right and one left: a quarter turn clockwise on the page shown.
  expect(await readProducedEntry(turned, 0, 'Rotate')).toBe('90');
});

test('Delete Current Page removes the page on screen from the exported file', async ({ page }) => {
  await openPdf(page);
  await rightClick(page, 300, 300);
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete Current Page' }).click();
  const bytes = await exportBytes(page, 'deleted.pdf');
  expect(await readProducedEntry(bytes, null, 'Pages', 'Count')).toBe('1');
});

test('with words selected the menu marks, copies and redacts that selection', async ({ page, context }) => {
  const menu = page.getByRole('menu');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openPdf(page);
  const line: string = PAGE_ONE_LINES[2].text;
  const lineBox = async () => {
    const box = await page.locator('.textLayer span').filter({ hasText: line }).first().boundingBox();
    if (box === null) throw new Error('the fixture text layer produced no line to select');
    return box;
  };
  const word = async () => {
    const box = await lineBox();
    await drag(
      page,
      { x: box.x + 2, y: box.y + box.height / 2 },
      { x: box.x + box.width - 0.25, y: box.y + box.height / 2 },
    );
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(line);
  };
  const rightClickLine = async () => {
    const box = await lineBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(menu).toBeVisible();
  };

  await word();
  await rightClickLine();
  await expect(menu.getByText('Text Selection Actions')).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Highlight',
    'Underline',
    'Strikethrough',
    'Copy Text',
    'Redact Selection',
    'Add Note',
    'Rotate Clockwise (90°)',
    'Rotate Counterclockwise (-90°)',
    'Delete Current Page',
    'Add Text',
    'Edit Text',
    'Freehand Draw',
    'Fit Width',
  ]);
  await menu.getByRole('menuitem', { name: 'Copy Text' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(line);

  // Redact Selection turns the words into a pending redaction area at once.
  await word();
  await rightClickLine();
  await menu.getByRole('menuitem', { name: 'Redact Selection' }).click();
  const areas = page.locator('[data-mark-family="redaction"]');
  await expect(areas).toHaveCount(1);
  const frame = await pageFrame(page);
  const left = toClient(frame, 72, 640).x;
  const shown = await areas.first().boundingBox();
  expect(Math.abs((shown?.x ?? 0) - left)).toBeLessThan(4);
  expect(shown?.width).toBeGreaterThan(100 * frame.scale);
  expect(shown?.width).toBeLessThan(200 * frame.scale);
  await expect(rail(page, REDACT_TOOL)).toHaveAttribute('aria-pressed', 'true');
});

test('Highlight in the menu marks the selected line in the exported file', async ({ page }) => {
  const menu = page.getByRole('menu');
  await openPdf(page);
  const line: string = PAGE_ONE_LINES[3].text;
  const box = await page.locator('.textLayer span').filter({ hasText: line }).first().boundingBox();
  if (box === null) throw new Error('the fixture text layer produced no line to select');
  await drag(
    page,
    { x: box.x + 2, y: box.y + box.height / 2 },
    { x: box.x + box.width - 0.25, y: box.y + box.height / 2 },
  );
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(line);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Highlight' }).click();
  const highlights = ofSubtype(await readAnnotations(await exportBytes(page, 'selection.pdf')), 'Highlight');
  // The fixture's own saved highlight is on line one; the new one covers the fourth line.
  const mine = highlights.filter((annotation) => annotation.pageIndex === 0 && annotation.contents === '');
  expect(mine).toHaveLength(1);
  expectNear(mine[0]?.rect[0], 72, 3);
  expectNear(mine[0]?.rect[1], 576, 6);
});
