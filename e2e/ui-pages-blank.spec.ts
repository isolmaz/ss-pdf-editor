/**
 * Remove blank pages: the run finds them and lists their count and numbers before anything
 * is removed, the removal is one undoable step, and a document with no blank page is left
 * alone and says so. Results are read back from the exported file.
 */

import type { Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { tidyPdf } from './tidy-fixture';
import { readProducedPageTexts } from './tool-fixture';
import { exportBytes, openPdf, reviewHeading, runCommand } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const thumbs = (page: Page) => page.getByRole('option');
const form = (page: Page) => page.getByRole('region', { name: 'Remove blank pages' });

async function order(page: Page, name: string): Promise<readonly string[]> {
  return (await readProducedPageTexts(await exportBytes(page, name))).map((text) => text.trim());
}

test('lists the blank pages first, removes them on apply, and undoes the removal', async ({ page }) => {
  await openPdf(page, 'scan.pdf', tidyPdf([{ text: 'One' }, {}, { text: 'Three' }, {}, {}]));
  await expect(thumbs(page)).toHaveCount(5);
  await runCommand(page, 'Remove blank pages');
  await expect(form(page)).toBeVisible({ timeout: 30_000 });
  await form(page).getByRole('button', { name: 'Find blank pages', exact: true }).click();

  await expect(reviewHeading(form(page))).toBeVisible({ timeout: 60_000 });
  await expect(form(page)).toContainText('Blank pages removed: 3 (pages 2, 4-5).');
  // Nothing has changed yet: the document is read, not written, until the result is applied.
  await expect(thumbs(page)).toHaveCount(5);

  await form(page).getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(notice(page, '3 blank page(s) removed.')).toBeVisible({ timeout: 60_000 });
  await expect(thumbs(page)).toHaveCount(2);
  expect(await order(page, 'tidy.pdf')).toEqual(['One', 'Three']);

  await page.keyboard.press('Control+z');
  await expect(thumbs(page)).toHaveCount(5);
  expect(await order(page, 'restored.pdf')).toEqual(['One', '', 'Three', '', '']);
});

test('leaves a document with no blank page as it is and says so', async ({ page }) => {
  await openPdf(page, 'full.pdf', tidyPdf([{ text: 'One' }, { text: 'Two' }]));
  await runCommand(page, 'Remove blank pages');
  await form(page).getByRole('button', { name: 'Find blank pages', exact: true }).click();
  await expect(reviewHeading(form(page))).toBeVisible({ timeout: 60_000 });
  await expect(form(page)).toContainText('No blank pages found. Nothing changed.');
  await form(page).getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(notice(page, 'No blank pages found. Nothing changed.')).toBeVisible({ timeout: 30_000 });
  await expect(thumbs(page)).toHaveCount(2);
  expect(await order(page, 'same.pdf')).toEqual(['One', 'Two']);
});

test('does not empty the document when every page is blank', async ({ page }) => {
  await openPdf(page, 'empty.pdf', tidyPdf([{}, {}]));
  await runCommand(page, 'Remove blank pages');
  await form(page).getByRole('button', { name: 'Find blank pages', exact: true }).click();
  await expect(reviewHeading(form(page))).toBeVisible({ timeout: 60_000 });
  await expect(form(page)).toContainText('Every page looks blank, so none were removed.');
  await form(page).getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(thumbs(page)).toHaveCount(2);
});
