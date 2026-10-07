/**
 * The page list of the left dock: selection by click, Ctrl/Shift click, keyboard and the
 * list's own space; the toolbar that acts on the selection (rotate, duplicate, delete, extract,
 * move up and down, move to a position); drag and drop; page labels; and the marks a thumbnail
 * shows. Every action is checked on the file it produces, read back page by page.
 */

import type { Locator, Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry, readProducedPageTexts } from './tool-fixture';
import { clickPage, exportBytes, openDockTab, openPdf, rail } from './ui-helpers';
import { withPageLabels } from './ui-panels9-helpers';
import { viewingOnlyFixture } from './ui-tags-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const options = (page: Page): Locator => page.getByRole('option');
const list = (page: Page): Locator => page.getByRole('listbox', { name: 'Pages' });
const toolbar = (page: Page): Locator => page.getByRole('toolbar');
const pageNumber = (page: Page): Locator => page.getByRole('textbox', { name: 'Page number' });

/** The text of every page of the exported file, trimmed: the order the user would read. */
async function order(page: Page, name: string): Promise<readonly string[]> {
  return (await readProducedPageTexts(await exportBytes(page, name))).map((text) => text.trim());
}

/** The pages the list shows as selected, by number. */
async function selectedPages(page: Page): Promise<readonly number[]> {
  const flags = await options(page).evaluateAll((items) =>
    items.map((item) => item.getAttribute('aria-selected') === 'true'),
  );
  return flags.flatMap((flag, index) => (flag ? [index + 1] : []));
}

test('clicks select: a click one page, Ctrl toggles, Shift takes a range, the list’s own space clears', async ({
  page,
}) => {
  await openPdf(page, 'six.pdf', labelledPdf('Doc', 6));
  await expect(options(page)).toHaveCount(6);
  await expect(page.getByText('0 page(s) selected')).toBeAttached();
  await expect(toolbar(page)).toHaveCount(0);

  await options(page).nth(1).click();
  expect(await selectedPages(page)).toEqual([2]);
  await expect(pageNumber(page)).toHaveValue('2');
  await expect(toolbar(page)).toHaveAccessibleName('Selection: 1 page(s)');
  await expect(page.getByText('1 page(s) selected')).toBeAttached();

  await options(page)
    .nth(4)
    .click({ modifiers: ['Control'] });
  expect(await selectedPages(page)).toEqual([2, 5]);
  await expect(toolbar(page)).toHaveAccessibleName('Selection: 2 page(s)');
  // Ctrl on a selected page takes it out; the page the viewer shows does not change.
  await options(page)
    .nth(1)
    .click({ modifiers: ['Control'] });
  expect(await selectedPages(page)).toEqual([5]);
  await expect(pageNumber(page)).toHaveValue('2');

  // Shift takes everything between the last page clicked and this one.
  await options(page)
    .nth(2)
    .click({ modifiers: ['Shift'] });
  // The anchor is the page Ctrl last toggled (2): the range runs from there.
  expect(await selectedPages(page)).toEqual([2, 3]);
  // Shift with no anchor is a plain click.
  await list(page).click({ position: { x: 3, y: 3 } });
  expect(await selectedPages(page)).toEqual([]);
  await expect(toolbar(page)).toHaveCount(0);
  await options(page)
    .nth(5)
    .click({ modifiers: ['Shift'] });
  expect(await selectedPages(page)).toEqual([6]);
});

test('the keyboard walks the list, selects with Space, goes to a page with Enter, and Ctrl+A and Escape take all and none', async ({
  page,
}) => {
  await openPdf(page, 'six.pdf', labelledPdf('Doc', 6));
  await expect(options(page)).toHaveCount(6);
  await options(page).first().focus();
  // One tab stop: the page in focus, the others are reached with the arrows.
  await expect(options(page).first()).toHaveAttribute('tabindex', '0');
  await expect(options(page).nth(1)).toHaveAttribute('tabindex', '-1');

  await page.keyboard.press('ArrowDown');
  await expect(options(page).nth(1)).toBeFocused();
  await expect(options(page).nth(1)).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(options(page).nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(options(page).nth(5)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(options(page).nth(5)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(options(page).nth(0)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(options(page).nth(0)).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  expect(await selectedPages(page)).toEqual([2]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  expect(await selectedPages(page)).toEqual([2, 3]);
  await page.keyboard.press('Space');
  expect(await selectedPages(page)).toEqual([2]);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(pageNumber(page)).toHaveValue('4');

  await page.keyboard.press('Control+a');
  expect(await selectedPages(page)).toEqual([1, 2, 3, 4, 5, 6]);
  await page.keyboard.press('Escape');
  expect(await selectedPages(page)).toEqual([]);
  // Any other key is left alone.
  await page.keyboard.press('x');
  expect(await selectedPages(page)).toEqual([]);
});

test('Alt+Arrow and the toolbar move the selection one place, and stop at the ends', async ({ page }) => {
  await openPdf(page, 'four.pdf', labelledPdf('Doc', 4));
  await options(page).nth(1).click();
  const up = toolbar(page).getByRole('button', { name: 'Move up' });
  const down = toolbar(page).getByRole('button', { name: 'Move down' });
  await expect(up).toBeEnabled();

  await page.keyboard.press('Alt+ArrowDown');
  await expect(notice(page, '1 page(s) moved')).toBeVisible();
  // The highlight follows the page it was on.
  await expect.poll(() => selectedPages(page)).toEqual([3]);
  expect(await order(page, 'down.pdf')).toEqual(['Doc 1', 'Doc 3', 'Doc 2', 'Doc 4']);

  await down.click();
  await expect.poll(() => selectedPages(page)).toEqual([4]);
  await expect(down).toBeDisabled();
  // At the end the keys do nothing: no step, no change of selection.
  await page.keyboard.press('Control+ArrowDown');
  expect(await selectedPages(page)).toEqual([4]);

  await up.click();
  await up.click();
  await up.click();
  await expect.poll(() => selectedPages(page)).toEqual([1]);
  await expect(up).toBeDisabled();
  await page.keyboard.press('Alt+ArrowUp');
  expect(await selectedPages(page)).toEqual([1]);
  expect(await order(page, 'up.pdf')).toEqual(['Doc 2', 'Doc 1', 'Doc 3', 'Doc 4']);
});

test('Move to puts the selection at a position, clamped to the pages that remain', async ({ page }) => {
  await openPdf(page, 'five.pdf', labelledPdf('Doc', 5));
  await options(page).nth(0).click();
  await options(page)
    .nth(1)
    .click({ modifiers: ['Control'] });
  const field = toolbar(page).getByRole('spinbutton', { name: 'Move to…' });
  const go = toolbar(page).getByRole('button', { name: 'Move to…' });
  await expect(go).toBeDisabled();
  await field.fill('3');
  await go.click();
  await expect(notice(page, '2 page(s) moved')).toBeVisible();
  await expect(field).toHaveValue('');
  await expect.poll(() => selectedPages(page)).toEqual([3, 4]);
  expect(await order(page, 'moved.pdf')).toEqual(['Doc 3', 'Doc 4', 'Doc 1', 'Doc 2', 'Doc 5']);

  // The field holds the position inside the pages that remain: a value outside it is refused
  // by the browser and nothing moves.
  await field.fill('99');
  await go.click();
  await expect(field).toHaveValue('99');
  await expect
    .poll(() => field.evaluate((input: HTMLInputElement) => input.validity.rangeOverflow))
    .toBe(true);
  expect(await selectedPages(page)).toEqual([3, 4]);
  await field.fill('4');
  await expect.poll(() => field.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
  await field.press('Enter');
  await expect.poll(() => selectedPages(page)).toEqual([4, 5]);
  expect(await order(page, 'end.pdf')).toEqual(['Doc 3', 'Doc 4', 'Doc 5', 'Doc 1', 'Doc 2']);
  await field.fill('1');
  await go.click();
  await expect.poll(() => selectedPages(page)).toEqual([1, 2]);
  expect(await order(page, 'front.pdf')).toEqual(['Doc 1', 'Doc 2', 'Doc 3', 'Doc 4', 'Doc 5']);
});

test('the toolbar rotates, duplicates, deletes and extracts the selection', async ({ page }) => {
  await openPdf(page, 'four.pdf', labelledPdf('Doc', 4));
  await options(page).nth(1).click();
  await options(page)
    .nth(2)
    .click({ modifiers: ['Control'] });

  await toolbar(page).getByRole('button', { name: 'Rotate right' }).click();
  await expect(notice(page, '2 page(s) rotated')).toBeVisible();
  const bytes = await exportBytes(page, 'rot-right.pdf');
  expect(await readProducedEntry(bytes, 1, 'Rotate')).toBe('90');
  expect(await readProducedEntry(bytes, 2, 'Rotate')).toBe('90');
  expect(await readProducedEntry(bytes, 0, 'Rotate')).toMatch(/^0?$/);
  expect(await readProducedEntry(bytes, 3, 'Rotate')).toMatch(/^0?$/);
  await toolbar(page).getByRole('button', { name: 'Rotate left' }).click();
  await expect
    .poll(async () => readProducedEntry(await exportBytes(page, 'rot-left.pdf'), 1, 'Rotate'))
    .toMatch(/^0?$/);

  await toolbar(page).getByRole('button', { name: 'Duplicate pages' }).click();
  await expect(options(page)).toHaveCount(6);
  expect(await order(page, 'dup.pdf')).toEqual(['Doc 1', 'Doc 2', 'Doc 2', 'Doc 3', 'Doc 3', 'Doc 4']);

  await options(page).nth(0).click();
  await options(page)
    .nth(0)
    .click({ modifiers: ['Shift'] });
  await toolbar(page).getByRole('button', { name: 'Delete pages' }).click();
  await expect(options(page)).toHaveCount(5);

  // The last pages of a document are not offered for deletion.
  await options(page).nth(0).click();
  await options(page)
    .nth(4)
    .click({ modifiers: ['Shift'] });
  await expect(toolbar(page).getByRole('button', { name: 'Delete pages' })).toBeDisabled();
});

test('Extract Pages in the selection toolbar opens the extract form', async ({ page }) => {
  await openPdf(page, 'two.pdf', labelledPdf('Doc', 2));
  await options(page).nth(1).click();
  await toolbar(page).getByRole('button', { name: 'Extract Pages' }).click();
  await expect(page.getByRole('region', { name: 'Extract Pages' })).toBeVisible({ timeout: 30_000 });
});

test('dragging a page to a gap moves it; a drag that never lands changes nothing', async ({ page }) => {
  await openPdf(page, 'three.pdf', labelledPdf('Doc', 3));
  await options(page).nth(2).dragTo(options(page).nth(0));
  await expect(notice(page, '1 page(s) moved')).toBeVisible();
  expect(await order(page, 'drag.pdf')).toEqual(['Doc 3', 'Doc 1', 'Doc 2']);

  // The lower half of a row means "after it".
  const last = options(page).nth(2);
  const box = await last.boundingBox();
  if (box === null) throw new Error('no thumbnail box');
  await options(page)
    .nth(0)
    .dragTo(last, { targetPosition: { x: box.width / 2, y: box.height - 4 } });
  await expect.poll(() => order(page, 'tail.pdf')).toEqual(['Doc 1', 'Doc 2', 'Doc 3']);

  // Dropped on the list's own padding: after the last page.
  await options(page)
    .nth(0)
    .dragTo(list(page), { targetPosition: { x: 2, y: 2 } });
  await expect.poll(() => order(page, 'padding.pdf')).toEqual(['Doc 2', 'Doc 3', 'Doc 1']);

  // A drag that ends outside the list: the document stays as it was.
  await options(page).nth(1).dragTo(pageNumber(page));
  expect(await order(page, 'same.pdf')).toEqual(['Doc 2', 'Doc 3', 'Doc 1']);
});

test('a thumbnail’s own buttons act on that page, and deleting the last page is not offered', async ({
  page,
}) => {
  await openPdf(page, 'two.pdf', labelledPdf('Doc', 2));
  await options(page).nth(1).hover();
  await options(page).nth(1).getByRole('button', { name: 'Rotate left' }).click();
  await expect(notice(page, '1 page(s) rotated')).toBeVisible();
  await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  expect(await readProducedEntry(await exportBytes(page, 'left.pdf'), 1, 'Rotate')).toBe('270');
  expect(await readProducedEntry(await exportBytes(page, 'left0.pdf'), 0, 'Rotate')).toMatch(/^0?$/);

  await options(page).nth(1).hover();
  await options(page).nth(1).getByRole('button', { name: 'Delete pages' }).click();
  await expect(options(page)).toHaveCount(1);
  await options(page).nth(0).hover();
  await expect(options(page).nth(0).getByRole('button', { name: 'Delete pages' })).toBeDisabled();
});

test('a page the file labels is captioned by its label, with its number beside it when they differ', async ({
  page,
}) => {
  await openPdf(
    page,
    'labelled.pdf',
    await withPageLabels(labelledPdf('Doc', 4), [
      { from: 0, style: 'r' },
      { from: 2, style: 'D', prefix: 'App-' },
    ]),
  );
  await expect(options(page)).toHaveCount(4);
  await expect(options(page).nth(0)).toContainText('i (1)');
  await expect(options(page).nth(1)).toContainText('ii (2)');
  await expect(options(page).nth(2)).toContainText('App-1 (3)');
  await expect(options(page).nth(3)).toContainText('App-2 (4)');

  // A label equal to the number, or none, shows the number alone.
  await openPdf(page, 'plain.pdf', labelledPdf('Doc', 2), { navigate: false, advanced: false });
  await expect(options(page).nth(0)).toHaveText('1');
  await expect(options(page).nth(1)).toHaveText('2');
});

test('a mark the file does not hold yet is drawn on its page’s thumbnail', async ({ page }) => {
  await openPdf(page, 'two.pdf', labelledPdf('Doc', 2));
  await expect(options(page).nth(0).locator('canvas')).toBeAttached();
  await expect(page.locator('[data-thumbnail-marks]')).toHaveCount(0);
  await rail(page, 'Add comment / Note').click();
  await clickPage(page, 300, 400);
  await expect(options(page).nth(0).locator('[data-thumbnail-marks]')).toBeAttached();
  await expect(options(page).nth(1).locator('[data-thumbnail-marks]')).toHaveCount(0);
});

test.describe('a document that is only viewed', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });

  test('still selects, but offers no action and no drag', async ({ page }) => {
    await openPdf(page, 'long.pdf', await viewingOnlyFixture());
    await openDockTab(page, 'Pages');
    await options(page).first().click();
    await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Rotate left', 'Rotate right', 'Duplicate pages', 'Delete pages', 'Extract Pages']) {
      await expect(toolbar(page).getByRole('button', { name })).toBeDisabled();
    }
    await expect(toolbar(page).getByRole('spinbutton', { name: 'Move to…' })).toBeDisabled();
    await expect(options(page).first()).toHaveAttribute('draggable', 'false');
    await expect(options(page).first().getByRole('button', { name: 'Rotate right' })).toHaveCount(0);
    // A drag that is refused starts nothing.
    await options(page).first().dragTo(options(page).nth(2));
    await expect(notice(page, 'moved')).toHaveCount(0);
  });
});
