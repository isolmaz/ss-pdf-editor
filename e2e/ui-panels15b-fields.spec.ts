/**
 * The field controls of the operation forms, as a user drives them: reordering and removing
 * the files of a multiple picker, inserting a format token at the caret, the page range's
 * message, and a typed password reaching the encrypted file.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { exportBytes, openDockTab, openPdf, pdfFile } from './ui-helpers';

const panel = (page: Page): Locator => page.getByRole('tabpanel');

async function openTool(page: Page, group: string, title: string, region: string): Promise<Locator> {
  await openDockTab(page, 'Tools');
  const header = panel(page).getByRole('button', { name: group, exact: true });
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
  await panel(page)
    .getByRole('button', { name: new RegExp(`^${title}`) })
    .click();
  const form = page.getByRole('region', { name: region, exact: true });
  await expect(form).toBeVisible();
  return form;
}

test('the files of a multiple picker are reordered and removed before the merge, and the file follows that order', async ({
  page,
}) => {
  await page.goto('/editor/');
  await page.getByRole('button', { name: /^Merge PDFs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge PDFs' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const picker = dialog.locator('input[type="file"]');
  await picker.setInputFiles([
    pdfFile('a.pdf', labelledPdf('Alpha', 1)),
    pdfFile('b.pdf', labelledPdf('Bravo', 1)),
    pdfFile('c.pdf', labelledPdf('Charlie', 1)),
  ]);
  const names = dialog.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Move / }) });
  await expect(names).toHaveText([/a\.pdf/, /b\.pdf/, /c\.pdf/]);
  await expect(dialog.getByText('3 files chosen')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Move a.pdf up' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Move c.pdf down' })).toBeDisabled();

  await dialog.getByRole('button', { name: 'Move c.pdf up' }).click();
  await expect(names).toHaveText([/a\.pdf/, /c\.pdf/, /b\.pdf/]);
  await dialog.getByRole('button', { name: 'Move a.pdf down' }).click();
  await expect(names).toHaveText([/c\.pdf/, /a\.pdf/, /b\.pdf/]);
  await dialog.getByRole('button', { name: 'Remove b.pdf from the list' }).click();
  await expect(names).toHaveText([/c\.pdf/, /a\.pdf/]);

  // More files add to the list rather than replace it.
  await picker.setInputFiles([pdfFile('d.pdf', labelledPdf('Delta', 1))]);
  await expect(names).toHaveText([/c\.pdf/, /a\.pdf/, /d\.pdf/]);

  const confirm = dialog.getByRole('button', { name: 'Open in new tab', exact: true });
  await confirm.click();
  await expect(dialog.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await confirm.click();
  await expect(page.getByRole('button', { name: 'Merged.pdf', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const texts = await readProducedPageTexts(await exportBytes(page, 'merged.pdf'));
  expect(texts.map((text) => text.trim())).toEqual(['Charlie 1', 'Alpha 1', 'Delta 1']);
});

test('a token button inserts its placeholder at the caret and the stamp carries the filled-in text', async ({
  page,
}) => {
  await openPdf(page, 'doc.pdf', labelledPdf('Doc', 2));
  const form = await openTool(
    page,
    'Numbering & Watermark',
    'Add Page Numbers',
    'Header / Footer & Page Numbering',
  );
  const format = form.getByRole('textbox', { name: 'Format' });
  await format.fill('Page ');
  await form.getByRole('button', { name: 'Page', exact: true }).click();
  await expect(format).toHaveValue('Page {page}');
  await expect(format).toBeFocused();
  await page.keyboard.type(' of ');
  await form.getByRole('button', { name: 'Total', exact: true }).click();
  await expect(format).toHaveValue('Page {page} of {total}');

  // A token goes where the caret is, not at the end.
  await format.focus();
  await format.press('Home');
  await form.getByRole('button', { name: 'Date', exact: true }).click();
  await expect(format).toHaveValue(/^\{date\}Page \{page\} of \{total\}$/);
  await format.fill('Page {page} of {total}');

  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });
  const texts = await readProducedPageTexts(await exportBytes(page, 'numbered.pdf'));
  expect(texts[0]).toContain('Page 1 of 2');
  expect(texts[1]).toContain('Page 2 of 2');
});

test('a page range that cannot be read is explained under the field and keeps the run from starting', async ({
  page,
}) => {
  await openPdf(page, 'doc.pdf', labelledPdf('Doc', 2));
  const form = await openTool(page, 'Organize Pages', 'Extract Pages', 'Extract Pages');
  await form.getByRole('radio', { name: 'Custom range' }).check();
  const range = form.getByPlaceholder('e.g. 1-3, 5, 8-10');
  await range.fill('abc');
  const run = form.locator('button').last();
  await expect(run).toBeDisabled();
  await expect(
    form.getByText('Page range could not be parsed. Enter a range like 1-3, 5 or 8-10.'),
  ).toBeVisible();

  await range.fill('9');
  await expect(run).toBeDisabled();
  await range.fill('2');
  await expect(run).toBeEnabled();
});

test('the passwords typed into the protect form are what encrypts the file', async ({ page }) => {
  await openPdf(page, 'doc.pdf', labelledPdf('Doc', 1));
  const form = await openTool(page, 'Security & Redaction', 'Protect with Password', 'Security');
  const open = form.getByLabel('Open password');
  await expect(open).toHaveAttribute('type', 'password');
  await open.fill('open-sesame');
  await form.getByLabel('Owner password').fill('owner-secret');
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });

  const download = page.waitForEvent('download');
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  const path = test.info().outputPath('protected.pdf');
  await (await download).saveAs(path);
  const text = readFileSync(path).toString('latin1');
  expect(text).toContain('/Encrypt');
  expect(text).not.toContain('Doc 1');
});
