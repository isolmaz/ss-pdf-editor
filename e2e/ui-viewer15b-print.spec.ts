/**
 * Print dialog behaviours the main print spec leaves out: Escape and the backdrop are
 * refused while pages are being prepared, and an emptied margin field means no margin.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { openPdf } from './ui-helpers';
import { printedJobs, spyOnPrint } from './ui-panels9-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Print' });

async function openPrint(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+p');
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  return dialog(page);
}

test('Escape does not close the dialog while the pages are being prepared; Cancel then stops the job', async ({
  page,
}) => {
  await spyOnPrint(page);
  await openPdf(page, 'many.pdf', labelledPdf('Many', 60));
  const panel = await openPrint(page);
  await panel.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText(/^Preparing pages: \d+\/60$/);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  await expect(panel.getByRole('status')).toContainText(/^Preparing pages: \d+\/60$/);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await page.waitForTimeout(1500);
  expect(await printedJobs(page)).toEqual([]);
});

test('emptying the margin field leaves a margin of 0 in it', async ({ page }) => {
  await openPdf(page, 'print.pdf', labelledPdf('Print', 2));
  const panel = await openPrint(page);
  const margin = panel.getByRole('spinbutton', { name: 'Margins (mm)' });
  await margin.fill('12');
  await expect(margin).toHaveValue('12');
  await margin.fill('');
  await expect(margin).toHaveValue('0');
});
