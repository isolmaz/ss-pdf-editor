/**
 * A dynamic XFA form, as a user meets it: the fill dialog hosts pdf.js's XFA renderer over
 * the form, the typed values are saved into the datasets packet or exported as XML, and the
 * flatten command rasterises the laid-out form into a normal PDF whose words can be read.
 */

import { readFileSync } from 'node:fs';
import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedPageTexts, readProducedPdf } from './tool-fixture';
import { exportBytes, menuItem, openPdf } from './ui-helpers';
import { dynamicXfaPdf } from './ui-xfa-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 150_000 });

async function openFillDialog(page: Page) {
  await menuItem(page, 'Tools', 'Fill XFA form…');
  const dialog = page.getByRole('dialog', { name: /Fill/ }).first();
  await expect(dialog).toBeVisible();
  return dialog;
}

test('fill: the form is laid out, typed values are exported as XML and saved into the document', async ({
  page,
}) => {
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  const dialog = await openFillDialog(page);
  const viewer = dialog.getByTestId('xfa-viewer');
  // The template was laid out as HTML: its caption and the prefilled data are there.
  await expect(viewer.getByText('Customer registration')).toBeVisible({ timeout: 60_000 });
  const fields = viewer.locator('input');
  await expect(fields).toHaveCount(2);
  await expect(fields.first()).toHaveValue('Ada Lovelace');

  const save = dialog.getByRole('button', { name: 'Save to document', exact: true });
  await expect(save).toBeDisabled();
  await fields.first().fill('Grace Hopper');
  await fields.first().blur();
  await expect(save).toBeEnabled();

  // Export the data as the form holds it now.
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export data (XML)' }).click();
  const exported = await download;
  const path = test.info().outputPath('xfa-data.xml');
  await exported.saveAs(path);
  const xml = readFileSync(path, 'utf8');
  expect(xml).toContain('Grace Hopper');
  expect(xml).toContain('London');
  expect(xml).not.toContain('Ada Lovelace');

  // Closing with unsaved values asks first; "Go back" keeps the form.
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Close without saving' })).toBeVisible();
  await expect(fields.first()).toHaveValue('Grace Hopper');

  await save.click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  const bytes = await exportBytes(page, 'xfa-filled.pdf');
  expect((await readProducedPdf(bytes)).pageCount).toBe(1);
  expect(Buffer.from(bytes).toString('latin1')).toContain('Grace Hopper');
});

test('fill: closing a pristine form needs no question and discarding typed values leaves the document alone', async ({
  page,
}) => {
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  let dialog = await openFillDialog(page);
  await expect(dialog.getByTestId('xfa-viewer').locator('input').first()).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  dialog = await openFillDialog(page);
  const field = dialog.getByTestId('xfa-viewer').locator('input').first();
  await field.fill('Changed');
  await field.blur();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const discard = dialog.getByRole('button', { name: 'Close without saving' });
  await expect(discard).toBeVisible();
  await discard.click();
  await expect(dialog).toHaveCount(0);
  expect(Buffer.from(await exportBytes(page, 'xfa-untouched.pdf')).toString('latin1')).not.toContain(
    'Changed',
  );
});

test('flatten: the laid-out form becomes a normal PDF whose text is the form text', async ({ page }) => {
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  await menuItem(page, 'Tools', 'Flatten XFA form to a normal PDF…');
  const form = page.getByRole('region', { name: 'Flatten XFA form to a normal PDF' });
  await expect(form).toBeVisible();
  await form.getByRole('radio').first().check();
  // The first click runs the flatten and shows its report; the second opens the result.
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await expect(form).toContainText('1 XFA page(s) became normal PDF pages.');
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(page).toHaveTitle('xfa-flat.pdf', { timeout: 60_000 });
  const bytes = await exportBytes(page, 'flat.pdf');
  expect((await readProducedPdf(bytes)).pageCount).toBeGreaterThanOrEqual(1);
  const text = (await readProducedPageTexts(bytes)).join(' ');
  expect(text).toContain('Customer');
  expect(text).toContain('Ada');
});
