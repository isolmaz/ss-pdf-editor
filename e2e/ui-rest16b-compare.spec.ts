/**
 * The comparison panel when a page changes in more lines than the report keeps: the table
 * says the comparison was capped and names the cap.
 */

import type { Page } from 'playwright/test';
import { pdfFile } from './app-helpers';
import { expect, test } from './test';
import { openPdf, runCommand } from './ui-helpers';
import { runsPdf } from './ui-rest16-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** One page of `count` tiny lines, each starting with `prefix`. */
function lines(prefix: string, count: number): Uint8Array {
  return runsPdf(
    Array.from({ length: count }, (_, index) => ({
      text: `${prefix} ${index}`,
      x: 20,
      y: 830 - index * 3.2,
      size: 2.5,
    })),
  );
}

async function compare(page: Page, button: string): Promise<void> {
  await openPdf(page, 'left.pdf', lines('Left', 250));
  await runCommand(page, 'Document comparison');
  await page.locator('input[data-compare-picker]').setInputFiles(pdfFile('right.pdf', lines('Right', 250)));
  await expect(page.getByText('Selected: right.pdf')).toBeVisible();
  await page.getByRole('button', { name: button }).click();
}

test('a page whose lines all differ is reported capped, with the line list cap as the reason', async ({
  page,
}) => {
  await compare(page, 'Compare text');
  await expect(page.getByText('Page count: 1 → 1')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Comparison capped: line list cap')).toBeVisible();
  // The count is of every line that differs; the row carries the star that says its list of them was cut.
  const row = page.locator('[data-compare-row="text:1"]');
  await expect(row).toContainText('250 changed, 0 added, 0 deleted line(s)');
  await expect(row).toContainText('0 deleted line(s) *');
});
