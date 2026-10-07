/**
 * Panel buttons that open the browser's file chooser (a user clicks them; the earlier specs
 * set the hidden inputs directly), and the redaction tab's own list of marks.
 */

import type { Locator, Page } from 'playwright/test';

import { pdfFile } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry } from './tool-fixture';
import { dragPage, exportBytes, openDockTab, openPdf, runCommand } from './ui-helpers';

type FilePayload = Parameters<Locator['setInputFiles']>[0];

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** Click `button` and answer the file chooser it opens. */
async function chooseFiles(page: Page, button: Locator, files: FilePayload): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await button.click();
  await (await chooser).setFiles(files);
}

test('the Add file button of the attachments tab opens the chooser and the chosen file is embedded', async ({
  page,
}) => {
  await openPdf(page, 'doc.pdf', labelledPdf('Doc', 1));
  await openDockTab(page, 'Attachments');
  await expect(page.getByText('This document has no attachments.')).toBeVisible();
  await chooseFiles(page, page.getByRole('button', { name: 'Add file', exact: true }), {
    name: 'memo.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('remember'),
  });
  const row = page
    .getByRole('list', { name: 'Attachments' })
    .getByRole('listitem')
    .filter({ hasText: 'memo.txt' });
  await expect(row).toContainText('8 byte', { timeout: 60_000 });
  const bytes = await exportBytes(page, 'with-memo.pdf');
  expect(await readProducedEntry(bytes, null, 'Names', 'EmbeddedFiles', 'Names', 0)).toContain('memo.txt');
});

test('the Select second document button of the comparison tab opens the chooser and names the chosen file', async ({
  page,
}) => {
  await openPdf(page, 'base.pdf', labelledPdf('Doc', 2));
  await runCommand(page, 'Document comparison');
  await expect(page.getByText('Select a second PDF to compare.')).toBeVisible();
  await chooseFiles(
    page,
    page.getByRole('button', { name: 'Select second document' }),
    pdfFile('second.pdf', labelledPdf('Doc', 2)),
  );
  await expect(page.getByText('Selected: second.pdf')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare text' })).toBeEnabled();
});

test('a redaction mark is listed in its tab with its page and the remove button of that row deletes it', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Redaction');
  await expect(page.getByText('No marks yet. Draw a box on the page.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear marks' })).toBeDisabled();
  await page.getByRole('button', { name: 'Open redaction tool', exact: true }).click();
  await dragPage(page, [72, 594], [320, 574]);

  const list = page.getByRole('list', { name: 'Marks' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Page 1');
  await expect(page.getByText('1 mark(s)')).toBeVisible();
  await list.getByRole('button', { name: 'Remove mark: Page 1' }).click();
  await expect(list).toHaveCount(0);
  await expect(page.getByText('0 mark(s)')).toBeVisible();
  await expect(page.locator('[data-mark-family="redaction"]')).toHaveCount(0);
});
