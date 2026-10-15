/**
 * The organize grid (the Organize pages command): every page as a large thumbnail over the editor.
 * Selection by click and Ctrl, a drag that moves the whole selection, the keyboard route (Alt and
 * an arrow, Escape, Enter), the actions of the toolbar, undo, and the phone layout. Every change is
 * checked on the file the app exports, read back page by page.
 */

import type { Locator, Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry, readProducedPageTexts } from './tool-fixture';
import { exportBytes, openPdf, runCommand } from './ui-helpers';

test.describe.configure({ timeout: 180_000 });

const grid = (page: Page): Locator => page.getByRole('listbox', { name: 'Organize pages' });
const cards = (page: Page): Locator => grid(page).getByRole('option');
const card = (page: Page, number: number): Locator =>
  grid(page).getByRole('option', { name: `Page ${number}`, exact: true });
const toolbar = (page: Page): Locator =>
  page.getByRole('region', { name: 'Organize pages' }).getByRole('toolbar');
const pageNumber = (page: Page): Locator => page.getByRole('textbox', { name: 'Page number' });

/** The text of every page of the exported file, trimmed: the order the user would read. */
async function order(page: Page, name: string): Promise<readonly string[]> {
  return (await readProducedPageTexts(await exportBytes(page, name))).map((text) => text.trim());
}

/** The pages the grid shows as selected, by number. */
async function selectedPages(page: Page): Promise<readonly number[]> {
  const flags = await cards(page).evaluateAll((items) =>
    items.map((item) => item.getAttribute('aria-selected') === 'true'),
  );
  return flags.flatMap((flag, index) => (flag ? [index + 1] : []));
}

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens over the editor, drags a selection of two pages to a new place and undoes it', async ({
    page,
  }) => {
    await openPdf(page, 'six.pdf', labelledPdf('Doc', 6));
    await runCommand(page, 'Organize pages');
    await expect(cards(page)).toHaveCount(6);
    // The editor under the grid is out of reach: it takes no focus and is not read out.
    await expect(page.locator('[inert]')).toHaveCount(1);

    await card(page, 2).click();
    await card(page, 3).click({ modifiers: ['Control'] });
    expect(await selectedPages(page)).toEqual([2, 3]);
    await expect(page.getByText('2 of 6 page(s) selected')).toBeVisible();

    // Dropped on the right half of page 5: after it.
    const target = card(page, 5);
    const box = await target.boundingBox();
    if (box === null) throw new Error('no card box');
    await card(page, 3).dragTo(target, { targetPosition: { x: box.width - 6, y: box.height / 2 } });
    await expect(notice(page, '2 page(s) moved')).toBeVisible();
    await expect.poll(() => selectedPages(page)).toEqual([4, 5]);
    expect(await order(page, 'dragged.pdf')).toEqual(['Doc 1', 'Doc 4', 'Doc 5', 'Doc 2', 'Doc 3', 'Doc 6']);

    // One undo puts the pages back, and the grid is still there.
    await page.keyboard.press('Control+z');
    await expect(notice(page, 'Undone:')).toBeVisible({ timeout: 30_000 });
    await expect(cards(page)).toHaveCount(6);
    expect(await order(page, 'undone.pdf')).toEqual(['Doc 1', 'Doc 2', 'Doc 3', 'Doc 4', 'Doc 5', 'Doc 6']);
  });

  test('moves with Alt and the arrows, acts on the selection from the toolbar, and closes with Escape', async ({
    page,
  }) => {
    await openPdf(page, 'five.pdf', labelledPdf('Doc', 5));
    await pageNumber(page).fill('3');
    await pageNumber(page).press('Enter');
    await expect(pageNumber(page)).toHaveValue('3');

    await runCommand(page, 'Organize pages');
    // It opens on the page that was on screen, which the focus is on.
    await expect(card(page, 3)).toBeFocused();
    await expect(card(page, 3)).toHaveAttribute('aria-current', 'page');

    await page.keyboard.press('Space');
    expect(await selectedPages(page)).toEqual([3]);
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => selectedPages(page)).toEqual([4]);
    await expect(card(page, 4)).toBeFocused();
    expect(await order(page, 'alt.pdf')).toEqual(['Doc 1', 'Doc 2', 'Doc 4', 'Doc 3', 'Doc 5']);

    await toolbar(page).getByRole('button', { name: 'Rotate right' }).click();
    await expect(notice(page, '1 page(s) rotated')).toBeVisible();
    const rotated = await exportBytes(page, 'rotated.pdf');
    expect(await readProducedEntry(rotated, 3, 'Rotate')).toBe('90');
    expect(await readProducedEntry(rotated, 2, 'Rotate')).toMatch(/^0?$/);

    await toolbar(page).getByRole('button', { name: 'Delete pages' }).click();
    await expect(cards(page)).toHaveCount(4);

    // Escape leaves for the document, on the page it was on.
    await page.keyboard.press('Escape');
    await expect(grid(page)).toHaveCount(0);
    await expect(page.locator('[inert]')).toHaveCount(0);
    await expect(pageNumber(page)).toHaveValue('3');
  });

  test('opens the page that is chosen with Enter, and the button gives the document back', async ({
    page,
  }) => {
    await openPdf(page, 'four.pdf', labelledPdf('Doc', 4));
    await runCommand(page, 'Organize pages');
    await card(page, 4).focus();
    await page.keyboard.press('Enter');
    await expect(grid(page)).toHaveCount(0);
    await expect(pageNumber(page)).toHaveValue('4');

    await runCommand(page, 'Organize pages');
    await page.getByRole('button', { name: 'Back to document' }).click();
    await expect(grid(page)).toHaveCount(0);
    await expect(pageNumber(page)).toHaveValue('4');
  });

  test('the size slider changes how many thumbnails fit in a row', async ({ page }) => {
    await openPdf(page, 'many.pdf', labelledPdf('Doc', 12));
    await runCommand(page, 'Organize pages');
    const perRow = async () => {
      const tops = await cards(page).evaluateAll((items) =>
        items.map((item) => item.getBoundingClientRect().top),
      );
      return tops.filter((top) => top === tops[0]).length;
    };
    const slider = page.getByRole('slider', { name: 'Thumbnail size' });
    await slider.fill('0');
    const small = await perRow();
    await slider.fill('3');
    const large = await perRow();
    expect(small).toBeGreaterThan(large);
    expect(large).toBeGreaterThan(0);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('shows two columns, selects with the "Select several" mode and moves without dragging', async ({
    page,
  }) => {
    await openPdf(page, 'six.pdf', labelledPdf('Doc', 6));
    await runCommand(page, 'Organize pages');
    await expect(cards(page)).toHaveCount(6);
    const tops = await cards(page).evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().top),
    );
    expect(tops.filter((top) => top === tops[0])).toHaveLength(2);
    // Nothing spills sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    await page.getByRole('button', { name: 'Select several' }).click();
    await card(page, 1).tap();
    await card(page, 2).tap();
    expect(await selectedPages(page)).toEqual([1, 2]);

    await toolbar(page).getByRole('button', { name: 'Move later' }).tap();
    await expect(notice(page, '2 page(s) moved')).toBeVisible();
    await expect.poll(() => selectedPages(page)).toEqual([2, 3]);
    expect(await order(page, 'phone.pdf')).toEqual(['Doc 3', 'Doc 1', 'Doc 2', 'Doc 4', 'Doc 5', 'Doc 6']);

    await page.getByRole('button', { name: 'Back to document' }).tap();
    await expect(grid(page)).toHaveCount(0);
  });
});
