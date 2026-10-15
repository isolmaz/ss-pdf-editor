/**
 * Split two-up scans: each landscape page becomes a left and a right page by windowing, in
 * order, as one undoable step; pages that are not landscape stay whole, and a document with
 * nothing to split says so. Results are read back from the exported file.
 */

import type { Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { tidyPdf } from './tidy-fixture';
import { readProducedEntry, readProducedPageTexts } from './tool-fixture';
import { applyForm, exportBytes, openPdf, reviewHeading, runCommand } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const thumbs = (page: Page) => page.getByRole('option');
const form = (page: Page) => page.getByRole('region', { name: 'Split two-up scans' });

test('cuts landscape pages into left and right pages, keeps a portrait page whole, and undoes it', async ({
  page,
}) => {
  const spread: readonly [number, number] = [842, 595];
  await openPdf(
    page,
    'spreads.pdf',
    tidyPdf([{ size: spread, text: 'Spread 1' }, { text: 'Cover' }, { size: spread, text: 'Spread 2' }]),
  );
  await runCommand(page, 'Split two-up scans');
  await expect(form(page)).toBeVisible({ timeout: 30_000 });
  // Nothing needs reading: the result is applied at once, and the portrait page is only counted.
  expect(await applyForm(form(page), 'Apply')).toBe('closed');
  await expect(notice(page, /2 page\(s\) split into a left and a right page \(pages 1, 3\)/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(thumbs(page)).toHaveCount(5);

  const bytes = await exportBytes(page, 'halves.pdf');
  // The text sits at the left edge of its spread: it stays on the left page.
  expect((await readProducedPageTexts(bytes)).map((text) => text.trim())).toEqual([
    'Spread 1',
    '',
    'Cover',
    'Spread 2',
    '',
  ]);
  expect(await readProducedEntry(bytes, 0, 'MediaBox')).toBe('[0 0 421 595]');
  expect(await readProducedEntry(bytes, 1, 'MediaBox')).toBe('[421 0 842 595]');
  expect(await readProducedEntry(bytes, 2, 'MediaBox')).toBe('[0 0 595 842]');

  await page.keyboard.press('Control+z');
  await expect(thumbs(page)).toHaveCount(3);
});

test('says so and leaves the document alone when no page is landscape', async ({ page }) => {
  await openPdf(page, 'portrait.pdf', tidyPdf([{ text: 'One' }, { text: 'Two' }]));
  await runCommand(page, 'Split two-up scans');
  await form(page).getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(reviewHeading(form(page))).toBeVisible({ timeout: 60_000 });
  await expect(form(page)).toContainText('2 page(s) that are not landscape were left as they are.');
  await form(page).getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(notice(page, /No landscape page without notes or form fields to split/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(thumbs(page)).toHaveCount(2);
});
