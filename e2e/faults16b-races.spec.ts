/**
 * Work that lands while the shell is waiting on pdf.js to open a produced version: the open is
 * held at its `GetDocRequest` (`engine-faults.ts`), the stall a user meets on a large file, and
 * what arrives meanwhile must be refused in words and must not corrupt the outcome.
 */

import { notice, pdfFile } from './app-helpers';
import { holdNext, injectEngineFaults } from './engine-faults';
import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { exportBytes } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

const BUSY = 'Another operation is running — wait for it to complete.';

test('a second press of a Start tool result while its tab is still opening is refused, and the tab opens once with the merged pages', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await page.goto('/editor/');
  await page.getByRole('button', { name: /^Merge PDFs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge PDFs' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog
    .locator('input[type="file"]')
    .setInputFiles([
      pdfFile('first.pdf', labelledPdf('First', 2)),
      pdfFile('second.pdf', labelledPdf('Second', 1)),
    ]);
  const confirm = dialog.getByRole('button', { name: 'Open in new tab', exact: true });
  await confirm.click();
  await expect(dialog.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });

  // The new document's open is the next one pdf.js is asked for.
  const release = await holdNext(page, 'pdfjs', 'GetDocRequest');
  await confirm.click();
  await release.reached();
  await confirm.click({ force: true });
  await expect(notice(page, BUSY)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merged.pdf', exact: true })).toHaveCount(0);

  await release();
  await expect(page.getByRole('button', { name: 'Merged.pdf', exact: true })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(notice(page, 'Opened in new tab: Merged.pdf')).toBeVisible();
  const texts = await readProducedPageTexts(await exportBytes(page, 'combined.pdf'));
  expect(texts.map((text) => text.trim())).toEqual(['First 1', 'First 2', 'Second 1']);
});
