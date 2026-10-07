/**
 * The batch dialog: the Open button's own file chooser, a folder scan that finds a swapped
 * file or nothing new, the ruleset name and loader buttons, and Escape while a run is going.
 */

import { readFileSync } from 'node:fs';
import type { Download, Locator, Page } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { pdfFile } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 150_000 });

async function openBatch(page: Page): Promise<Locator> {
  await page.goto('/editor/');
  await useAdvancedMode(page);
  await page.getByRole('button', { name: 'Search commands (Ctrl+K)' }).click();
  await page.getByRole('combobox').fill('Batch operations');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Batch operations' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function stageFolder(
  page: Page,
  put: readonly { name: string; bytes: Uint8Array }[],
  remove: readonly string[] = [],
): Promise<void> {
  await page.evaluate(
    async ([entries, gone]) => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('watched15', { create: true });
      for (const name of gone) await folder.removeEntry(name);
      for (const entry of entries) {
        const handle = await folder.getFileHandle(entry.name, { create: true });
        const writer = await handle.createWritable();
        await writer.write(new Uint8Array(entry.bytes));
        await writer.close();
      }
      Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
    },
    [put.map((file) => ({ name: file.name, bytes: [...file.bytes] })), [...remove]] as const,
  );
}

test('the Open button asks for PDFs and queues the ones chosen', async ({ page }) => {
  const dialog = await openBatch(page);
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await (await chooser).setFiles([
    pdfFile('first.pdf', labelledPdf('First', 1)),
    pdfFile('second.pdf', labelledPdf('Second', 1)),
  ]);
  const list = dialog.getByRole('list').first();
  await expect(list.getByText('first.pdf', { exact: true })).toBeVisible();
  await expect(list.getByText('second.pdf', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^2\/\d+$/)).toBeVisible();
});

test('a watched folder where one file was swapped for another keeps the count but queues the new name; an untouched folder changes nothing', async ({
  page,
}) => {
  const dialog = await openBatch(page);
  await stageFolder(page, [{ name: 'old.pdf', bytes: labelledPdf('Old', 1) }]);
  await dialog.getByRole('button', { name: 'Watch Folder' }).click();
  const list = dialog.getByRole('list').first();
  await expect(list.getByText('old.pdf', { exact: true })).toBeVisible();
  await expect(page.getByText('1 PDF files queued from folder.')).toBeVisible();

  // Several scans (every 4 s) pass over an unchanged folder: the queue stays as it is.
  await page.waitForTimeout(9000);
  await expect(list.getByText('old.pdf', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^1\/\d+$/)).toBeVisible();

  await stageFolder(page, [{ name: 'new.pdf', bytes: labelledPdf('New', 1) }], ['old.pdf']);
  await expect(list.getByText('new.pdf', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(list.getByText('old.pdf', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/^1\/\d+$/)).toBeVisible();
});

test('the ruleset buttons: Load ruleset opens a file chooser, and a typed name names the saved file', async ({
  page,
}) => {
  const dialog = await openBatch(page);
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Load ruleset', exact: true }).click();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(false);
  await picker.setFiles({
    name: 'rules.json',
    mimeType: 'application/json',
    buffer: Buffer.from('not json'),
  });
  await expect(dialog.getByRole('alert')).toBeVisible();

  const name = dialog.getByRole('textbox', { name: 'Ruleset name' });
  await name.fill('Quarter close');
  await expect(name).toHaveValue('Quarter close');
  const started: Download[] = [];
  page.on('download', (download) => started.push(download));
  await dialog.getByRole('button', { name: 'Save ruleset (JSON)' }).click();
  await expect.poll(() => started.length).toBe(1);
  expect(started[0]?.suggestedFilename()).toBe('Quarter close.batch.json');
  const path = test.info().outputPath('quarter.batch.json');
  await started[0]?.saveAs(path);
  expect((JSON.parse(readFileSync(path, 'utf8')) as { name: string }).name).toBe('Quarter close');
});

test('Escape does not close the dialog while a batch is running', async ({ page }) => {
  const dialog = await openBatch(page);
  await dialog
    .locator('input[type="file"][accept*="pdf"]')
    .first()
    .setInputFiles([pdfFile('big.pdf', labelledPdf('Big', 60))]);
  for (const step of ['Optimize / Compress', 'Document properties']) {
    await dialog
      .getByRole('checkbox', { name: step, exact: true })
      .setChecked(step === 'Optimize / Compress');
  }
  await dialog.getByRole('radio', { name: 'Convert pages to image (lossy)' }).check();
  await dialog.getByRole('spinbutton', { name: /Resolution/ }).fill('300');
  await dialog.getByRole('button', { name: 'Run batch' }).click();
  await expect(dialog.getByText('Processing').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).last().click();
  await expect(dialog.getByRole('button', { name: 'Run batch' })).toBeEnabled({ timeout: 60_000 });
});
