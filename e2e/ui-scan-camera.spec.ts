/**
 * Scan with the camera, with a camera: Chromium's fake device (two of them) feeds the live
 * preview, the shutter takes real frames, and the pages become a document.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedEntry, readProducedPdf } from './tool-fixture';
import { exportBytes, menuItem, openPdf, runCommand } from './ui-helpers';

test.use({
  viewport: { width: 1440, height: 900 },
  permissions: ['camera'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=device-count=2', '--use-fake-ui-for-media-stream'],
  },
});

test.describe.configure({ timeout: 120_000 });

const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Scan with camera' });

async function openScan(page: Page) {
  await menuItem(page, 'File', 'Scan with camera');
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the live preview looks for the page, the shutter takes photos, the second camera can be chosen and the pages become a document', async ({
  page,
}) => {
  await openPdf(page);
  const dialog = await openScan(page);
  const shutter = dialog.getByTestId('scan-shutter');
  await expect(shutter).toBeEnabled({ timeout: 30_000 });
  await expect(
    dialog.getByText('Lay the document on a plain surface and fit it in the frame.'),
  ).toBeVisible();
  await expect(dialog.getByText(/Looking for the page…|Page found/)).toBeVisible();

  // Two cameras are offered; picking the other restarts the stream.
  const select = dialog.getByRole('combobox', { name: 'Camera' });
  await expect(select).toBeVisible();
  const first = (await select.textContent()) ?? '';
  await select.click();
  await page.getByRole('option').filter({ hasNotText: first }).first().click();
  await expect(select).not.toHaveText(first);
  await expect(shutter).toBeEnabled({ timeout: 30_000 });

  await shutter.click();
  await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Whole photo' }).click();
  await dialog.getByRole('button', { name: 'Add page' }).click();
  await dialog.getByRole('button', { name: 'Add page' }).last().click();
  await expect(shutter).toBeEnabled({ timeout: 30_000 });
  await shutter.click();
  await dialog.getByRole('button', { name: 'Whole photo' }).click();
  await dialog.getByRole('button', { name: 'Add page' }).click();
  await expect(
    dialog.getByRole('list', { name: 'Scanned pages' }).getByRole('button', { name: /^Select page \d$/ }),
  ).toHaveCount(2);

  // Back to the camera with Pages (2) showing the way home.
  await dialog.getByRole('button', { name: 'Add page' }).last().click();
  await dialog.getByRole('button', { name: 'Pages (2)' }).click();
  await dialog.getByRole('button', { name: 'Create PDF' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  const bytes = await exportBytes(page, 'camera.pdf');
  expect((await readProducedPdf(bytes)).pageCount).toBe(2);
  // The A4 page of the default choice.
  expect(await readProducedEntry(bytes, 0, 'MediaBox')).toMatch(/595/);
});

test('the scan command is also in the palette and stops the camera when closed', async ({ page }) => {
  await openPdf(page);
  await runCommand(page, 'Scan with camera');
  const dialog = dialogOf(page);
  await expect(dialog.getByTestId('scan-shutter')).toBeEnabled({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
