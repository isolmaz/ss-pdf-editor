/**
 * Reverse page order: the whole document, or only the selected pages among the places they
 * hold, as one undoable step; one page has nothing to reverse. Every result is read back from
 * the exported file.
 */

import type { Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { exportBytes, menuItem, openPdf, runCommand } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const thumbs = (page: Page) => page.getByRole('option');

async function order(page: Page, name: string): Promise<readonly string[]> {
  return (await readProducedPageTexts(await exportBytes(page, name))).map((text) => text.trim());
}

test('reverses every page from the palette and undoes it', async ({ page }) => {
  await openPdf(page, 'four.pdf', labelledPdf('Doc', 4));
  await expect(thumbs(page)).toHaveCount(4);
  await runCommand(page, 'Reverse page order');
  await expect(notice(page, 'Applied to document: Page order reversed.')).toBeVisible({ timeout: 30_000 });
  expect(await order(page, 'reversed.pdf')).toEqual(['Doc 4', 'Doc 3', 'Doc 2', 'Doc 1']);

  await page.keyboard.press('Control+z');
  await expect(notice(page, /Undone/)).toBeVisible({ timeout: 30_000 });
  expect(await order(page, 'restored.pdf')).toEqual(['Doc 1', 'Doc 2', 'Doc 3', 'Doc 4']);
});

test('reverses only the selected pages, among the places they hold, from the Page menu', async ({ page }) => {
  await openPdf(page, 'four.pdf', labelledPdf('Doc', 4));
  await thumbs(page).nth(1).click();
  await thumbs(page)
    .nth(3)
    .click({ modifiers: ['Control'] });
  await menuItem(page, 'Page', 'Reverse page order');
  await expect(notice(page, 'Applied to document: Page order reversed.')).toBeVisible({ timeout: 30_000 });
  expect(await order(page, 'some.pdf')).toEqual(['Doc 1', 'Doc 4', 'Doc 3', 'Doc 2']);
});

test('says so when a one-page document has nothing to reverse', async ({ page }) => {
  await openPdf(page, 'one.pdf', labelledPdf('Doc', 1));
  await runCommand(page, 'Reverse page order');
  await expect(notice(page, 'Nothing changed: no page to apply the action to.')).toBeVisible({
    timeout: 30_000,
  });
});
