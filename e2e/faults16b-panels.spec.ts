/**
 * Panels and dialogs that read or write the document through an engine, answering for one that
 * fails where the file is sound (`engine-faults.ts`): the search results, the signature list and
 * the XFA fill dialog, including the window while its form is still opening.
 */

import type { Page } from 'playwright/test';
import { notice } from './app-helpers';
import { failNext, firedCount, holdNext, injectEngineFaults, requestCount } from './engine-faults';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { menuItem, openDockTab, openPdf } from './ui-helpers';
import { signatureFieldsPdf } from './ui-panels15-helpers';
import { dynamicXfaPdf } from './ui-xfa-helpers';

test.use({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

const UNEXPECTED = 'Something unexpected went wrong.';

test('a search whose page text pdf.js cannot read says so in the panel and on the notice line, and the next query finds its matches', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'many.pdf', labelledPdf('Page', 6));
  await openDockTab(page, 'Results');
  const box = page.getByRole('textbox', { name: 'Find in document' }).first();

  await failNext(page, 'pdfjs', 'GetTextContent', 'text stream broke');
  await box.fill('Page');
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'pdfjs', 'GetTextContent')).toBe(1);
  await expect(page.getByRole('list', { name: 'Search results' })).toHaveCount(0);
  await expect(page.getByText(UNEXPECTED).first()).toBeVisible();

  // The page that failed was not remembered as empty: another query reads it afresh.
  await box.fill('Page 1');
  await expect(page.getByText('1 matches')).toBeVisible();
  await expect(page.getByText(UNEXPECTED)).toHaveCount(0);
});

test('a signature list pdf.js cannot read says so in the tab and on the notice line, and the other tabs still answer', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'fields.pdf', signatureFieldsPdf());
  await failNext(page, 'pdfjs', 'GetSignatures', 'signature table broke');
  await openDockTab(page, 'Signatures');
  await expect.poll(() => firedCount(page, 'pdfjs', 'GetSignatures')).toBe(1);
  await expect(page.getByRole('list', { name: 'Signatures' })).toHaveCount(0);
  await expect(
    page.getByText(`${UNEXPECTED} Try again; report it if it keeps happening.`).first(),
  ).toBeVisible();
  await expect(notice(page, UNEXPECTED)).toBeVisible();

  await openDockTab(page, 'Attachments');
  await expect(page.getByText('This document has no attachments.')).toBeVisible();
});

async function openFill(page: Page) {
  await menuItem(page, 'Tools', 'Fill XFA form…');
  const dialog = page.getByRole('dialog', { name: /Fill/ }).first();
  await expect(dialog).toBeVisible();
  return dialog;
}

test('an XFA form whose values the engine cannot write out keeps the dialog and the typed value, says so, and saves on the next try', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  const dialog = await openFill(page);
  const inputs = dialog.getByTestId('xfa-viewer').locator('input');
  await expect(inputs).toHaveCount(2, { timeout: 60_000 });
  await inputs.first().fill('Grace Hopper');
  await inputs.first().blur();
  const save = dialog.getByRole('button', { name: 'Save to document', exact: true });
  await expect(save).toBeEnabled();

  await failNext(page, 'pdfjs', 'SaveDocument', 'cannot serialise');
  await save.click();
  await expect(dialog.getByText(UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'pdfjs', 'SaveDocument')).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(inputs.first()).toHaveValue('Grace Hopper');
  await expect(save).toBeEnabled();

  await save.click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect(notice(page, '1 value(s) saved into the document’s XFA data.')).toBeVisible();
});

test('exporting the XFA data when the engine cannot write the form out says so and downloads nothing; the next try exports', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  const dialog = await openFill(page);
  const inputs = dialog.getByTestId('xfa-viewer').locator('input');
  await expect(inputs).toHaveCount(2, { timeout: 60_000 });
  // A form with a typed value is written out through pdf.js's save; an untouched one is its cached bytes.
  await inputs.first().fill('Grace Hopper');
  await inputs.first().blur();
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));

  await failNext(page, 'pdfjs', 'SaveDocument', 'cannot serialise');
  await dialog.getByRole('button', { name: 'Export data (XML)' }).click();
  await expect(dialog.getByText(UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'pdfjs', 'SaveDocument')).toBe(1);
  expect(downloads).toEqual([]);

  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export data (XML)' }).click();
  await download;
  await expect(dialog.getByText('2 data value(s) exported.')).toBeVisible();
});

test('closing the XFA dialog while its form is still opening leaves it closed when the open finishes, and the dialog opens normally again', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  // The dialog's own open of the document is the next one pdf.js is asked for.
  const release = await holdNext(page, 'pdfjs', 'GetDocRequest');
  await menuItem(page, 'Tools', 'Fill XFA form…');
  const dialog = page.getByRole('dialog', { name: /Fill/ }).first();
  await expect(dialog).toBeVisible();
  await release.reached();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  const before = await requestCount(page, 'GetDocRequest');
  await release();
  // The late answer is dropped: no form, no failure, nothing comes back.
  await page.waitForTimeout(1_000);
  await expect(page.getByRole('dialog', { name: /Fill/ })).toHaveCount(0);
  expect(before).toBe(await requestCount(page, 'GetDocRequest'));

  const again = await openFill(page);
  await expect(again.getByTestId('xfa-viewer').locator('input')).toHaveCount(2, { timeout: 60_000 });
});
