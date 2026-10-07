/**
 * File → Add / Import Document and Create PDF from Images: the refusals when nothing is
 * picked, and the document the picked pictures become.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry } from './tool-fixture';
import { encodePng, exportBytes, inkPng, openPdf, runCommand } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

async function openForm(page: Page, command: string, region: string): Promise<Locator> {
  await runCommand(page, command);
  const form = page.getByRole('region', { name: region }).or(page.getByRole('dialog', { name: region }));
  await expect(form).toBeVisible({ timeout: 30_000 });
  return form;
}

async function expectRefused(form: Locator, message: string, diagnostic: string): Promise<void> {
  await form.getByRole('button', { name: /^(Preview|Open in new tab)$/ }).click();
  const alert = form.getByRole('alert');
  await expect(alert).toContainText(message, { timeout: 60_000 });
  await expect(alert.locator('[data-dialog-diagnostic]')).toHaveAttribute(
    'data-dialog-diagnostic',
    diagnostic,
  );
}

test('add / import without a file is refused, naming the missing source', async ({ page }) => {
  await openPdf(page, 'base.pdf', labelledPdf('Base', 2));
  const form = await openForm(page, 'Add / Import Document', 'Add / Import Document');
  await expectRefused(
    form,
    'This operation has nothing to work with yet.',
    'add-document: no file was picked',
  );
});

test('create from images without a file is refused, naming the missing pictures', async ({ page }) => {
  await openPdf(page, 'base.pdf', labelledPdf('Base', 2));
  const form = await openForm(page, 'Create PDF from Images', 'Create PDF from Images');
  await expectRefused(
    form,
    'This operation has nothing to work with yet.',
    'images-to-pdf: no images were picked',
  );
});

test('create from images: two pictures open as a two-page Letter document, one picture on each page', async ({
  page,
}) => {
  await openPdf(page, 'base.pdf', labelledPdf('Base', 1));
  const form = await openForm(page, 'Create PDF from Images', 'Create PDF from Images');
  await form.locator('input[type="file"]').setInputFiles([
    { name: 'ink.png', mimeType: 'image/png', buffer: inkPng(60, 30) },
    { name: 'dot.png', mimeType: 'image/png', buffer: encodePng(8, 8, () => [200, 30, 30]) },
  ]);
  await form.getByRole('combobox', { name: 'Page size' }).click();
  await page.getByRole('option', { name: 'Letter', exact: true }).click();
  await form.getByRole('radio', { name: 'Stretch' }).check();
  await form.getByText(/^Advanced options/).click();
  await form.getByRole('radio', { name: 'Ignore' }).check();
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Images.pdf', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('option')).toHaveCount(2);
  const bytes = await exportBytes(page, 'from-images.pdf');
  for (const index of [0, 1]) {
    expect(await readProducedEntry(bytes, index, 'MediaBox')).toBe('[0 0 612 792]');
    expect(await readProducedEntry(bytes, index, 'Resources', 'XObject')).toMatch(/^<<\/\w+ \d+ 0 R>>$/);
  }
});
