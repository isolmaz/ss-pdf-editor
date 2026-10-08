/**
 * The document-comparison panel: a second PDF is picked, compared with the open one by text
 * and by pixels, and the page-by-page table says what changed, what only one document has and
 * what could not be compared; a row jumps to its page, a running comparison can be cancelled,
 * and a file that is no PDF is reported. The table is read as a user reads it.
 */

import type { Locator, Page } from 'playwright/test';
import { pdfFile } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf, toolFixturePdf } from './tool-fixture';
import { openPdf, runCommand } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const picker = (page: Page): Locator => page.locator('input[data-compare-picker]');
const rowOf = (page: Page, method: 'text' | 'pixels', pageNumber: number): Locator =>
  page.locator(`[data-compare-row="${method}:${pageNumber}"]`);

async function openCompare(page: Page, bytes: Uint8Array, name = 'base.pdf'): Promise<void> {
  await openPdf(page, name, bytes);
  await runCommand(page, 'Document comparison');
  await expect(page.getByText('Select a second PDF to compare.')).toBeVisible();
}

async function pick(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await picker(page).setInputFiles(pdfFile(name, bytes));
  await expect(page.getByText(`Selected: ${name}`)).toBeVisible();
}

test('text comparison: identical pages say so, changed pages count their lines, a page one file lacks is deleted', async ({
  page,
}) => {
  await openCompare(page, labelledPdf('Doc', 3));
  // Nothing to run before a second file is chosen.
  await expect(page.getByRole('button', { name: 'Compare text' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Compare pixels' })).toBeDisabled();
  await pick(page, 'same.pdf', labelledPdf('Doc', 3));
  await expect(page.getByText('No results yet: run Compare text or Compare pixels.')).toBeVisible();
  await page.getByRole('button', { name: 'Compare text' }).click();
  await expect(page.getByText('Page count: 3 → 3')).toBeVisible({ timeout: 60_000 });
  for (const number of [1, 2, 3]) {
    await expect(rowOf(page, 'text', number)).toContainText('Identical');
    await expect(rowOf(page, 'text', number)).toContainText('No changes');
  }
  await expect(page.getByText(/Page count difference/)).toHaveCount(0);

  // A different second file: the old results are gone the moment it is picked.
  await pick(page, 'other.pdf', labelledPdf('Other', 2));
  await expect(page.locator('[data-compare-row]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Compare text' }).click();
  await expect(page.getByText('Page count: 3 → 2')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Page count difference: -1')).toBeVisible();
  await expect(rowOf(page, 'text', 1)).toContainText('Changed');
  await expect(rowOf(page, 'text', 1)).toContainText('1 changed, 0 added, 0 deleted line(s)');
  await expect(rowOf(page, 'text', 3)).toContainText('Deleted');
});

test('pixel comparison: a page that differs shows its share, a page only one document has says so, and Jump goes there', async ({
  page,
}) => {
  // The tool fixture carries highlights and strokes the plain labelled pages do not.
  await openCompare(page, toolFixturePdf());
  await pick(page, 'plain.pdf', labelledPdf('Doc', 1));
  await page.getByRole('button', { name: 'Compare pixels' }).click();
  await expect(page.getByText('Page count: 2 → 1')).toBeVisible({ timeout: 120_000 });
  const first = rowOf(page, 'pixels', 1);
  await expect(first).toContainText(/Pixel diff \(\d+ dpi\)/);
  await expect(first).toContainText('Changed');
  await expect(first).toContainText(/\d+\.\d\d% · [1-9]\d*\/\d+/);
  await expect(rowOf(page, 'pixels', 2)).toContainText('Deleted');
  await expect(rowOf(page, 'pixels', 2)).toContainText('Page exists in only one document');
  await expect(first.getByRole('button', { name: 'Jump' })).toBeEnabled();

  await rowOf(page, 'pixels', 2).getByRole('button', { name: 'Jump' }).click();
  await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
  await rowOf(page, 'pixels', 1).getByRole('button', { name: 'Jump' }).click();
  await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('1');

  // The same file twice: no difference at all, and the table says 0.
  await pick(page, 'same.pdf', toolFixturePdf());
  await page.getByRole('button', { name: 'Compare pixels' }).click();
  await expect(rowOf(page, 'pixels', 1)).toContainText('Identical', { timeout: 120_000 });
  await expect(rowOf(page, 'pixels', 1)).toContainText(/Identical0\.00% · 0\/\d+Jump$/);
});

test('both methods share one table, ordered by page; a page only the other document has has nowhere to jump', async ({
  page,
}) => {
  await openCompare(page, labelledPdf('Doc', 1));
  await pick(page, 'longer.pdf', labelledPdf('Doc', 2));
  await page.getByRole('button', { name: 'Compare text' }).click();
  await expect(page.getByText('Page count: 1 → 2')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Compare pixels' }).click();
  await expect(rowOf(page, 'pixels', 2)).toBeVisible({ timeout: 120_000 });
  expect(
    await page
      .locator('[data-compare-row]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-compare-row'))),
  ).toEqual(['pixels:1', 'text:1', 'pixels:2', 'text:2']);
  await expect(rowOf(page, 'text', 2)).toContainText('Added');
  await expect(rowOf(page, 'text', 2).getByRole('button', { name: 'Jump' })).toBeDisabled();
  await expect(page.getByText('Page count difference: 1')).toBeVisible();
});

test('pages of different sizes are compared with the reason named in the row', async ({ page }) => {
  await openCompare(page, labelledPdf('Doc', 2));
  await pick(page, 'a5.pdf', labelledPdf('Doc', 2, { size: [420, 595] }));
  await page.getByRole('button', { name: 'Compare pixels' }).click();
  const row = rowOf(page, 'pixels', 1);
  await expect(row).toContainText(/0\.00% · 0\/\d+ · different page sizes/, { timeout: 120_000 });
  await expect(page.getByText(/Comparison capped/)).toHaveCount(0);
  await expect(page.getByText('* detail for this row was capped')).toBeVisible();
});

test('a file that is no PDF is reported where the table would be, and the panel is usable again', async ({
  page,
}) => {
  await openCompare(page, labelledPdf('Doc', 2));
  await picker(page).setInputFiles({
    name: 'notes.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('this is not a pdf'),
  });
  await expect(page.getByText('Selected: notes.pdf')).toBeVisible();
  await page.getByRole('button', { name: 'Compare text' }).click();
  const failure = page.locator('[data-compare-failure]');
  await expect(failure).toBeVisible({ timeout: 60_000 });
  await expect(failure).toContainText(/\w/);
  await expect(page.locator('[data-compare-row]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Compare text' })).toBeEnabled();

  // A good file after it: the report goes.
  await pick(page, 'fine.pdf', labelledPdf('Doc', 2));
  await expect(failure).toHaveCount(0);
});

test('Cancel stops a running comparison and leaves no table', async ({ page }) => {
  await openCompare(page, labelledPdf('Doc', 60));
  await pick(page, 'other.pdf', labelledPdf('Other', 60));
  await page.getByRole('button', { name: 'Compare pixels' }).click();
  await expect(page.getByText('Comparing…')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('No results yet: run Compare text or Compare pixels.')).toBeVisible();
  await expect(page.locator('[data-compare-row]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Compare pixels' })).toBeEnabled();
});
