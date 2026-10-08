/**
 * The scan dialog's photo list from files: the choose button, a lone unreadable photo, a
 * photo skipped with nothing else queued, and the page order changed with the selection.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { openPdf, sheetPhotoPng } from './ui-helpers';

test.use({
  viewport: { width: 1440, height: 900 },
  permissions: [],
});
test.describe.configure({ timeout: 120_000 });

const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Scan with camera' });

async function openScan(page: Page): Promise<Locator> {
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Scan with camera' }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

const sheet = (name: string) => ({ name, mimeType: 'image/png', buffer: sheetPhotoPng() });

test('the choose button opens the file picker; a lone unreadable photo is named and the camera screen stays', async ({
  page,
}) => {
  await openPdf(page);
  const dialog = await openScan(page);
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose photos' }).first().click();
  await (await chooser).setFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('no') });
  await expect(dialog.getByText('This photo could not be opened: broken.png')).toBeVisible();
  await expect(dialog.getByTestId('scan-shutter')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Pages \(0\)$/ })).toBeDisabled();
});

test('cancelling the only photo returns to the camera screen with no pages', async ({ page }) => {
  await openPdf(page);
  const dialog = await openScan(page);
  await dialog.getByTestId('scan-file-input').setInputFiles(sheet('only.png'));
  await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByTestId('scan-shutter')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Pages \(0\)$/ })).toBeDisabled();
});

test('selecting a page by its thumbnail and moving it later changes the order', async ({ page }) => {
  await openPdf(page);
  const dialog = await openScan(page);
  await dialog.getByTestId('scan-file-input').setInputFiles([sheet('a.png'), sheet('b.png')]);
  await dialog.getByRole('button', { name: 'Add page' }).click();
  await dialog.getByRole('button', { name: 'Add page' }).click();
  const list = dialog.getByRole('list', { name: 'Scanned pages' });
  await expect(list.getByRole('button', { name: /^Select page \d$/ })).toHaveCount(2);
  await expect(list.getByRole('button', { name: 'Select page 2' })).toHaveAttribute('aria-current', 'true');

  await list.getByRole('button', { name: 'Select page 1' }).click();
  await expect(list.getByRole('button', { name: 'Select page 1' })).toHaveAttribute('aria-current', 'true');
  await dialog.getByRole('button', { name: 'Move page 1 later' }).click();
  // The page that was first is now second, and it stays the selected one.
  await expect(list.getByRole('button', { name: 'Select page 2' })).toHaveAttribute('aria-current', 'true');
  await expect(dialog.getByRole('button', { name: 'Move page 2 later' })).toBeDisabled();
});
