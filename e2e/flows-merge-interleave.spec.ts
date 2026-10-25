import { readFileSync } from 'node:fs';
import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { reviewHeading, runForm } from './ui-helpers';

/**
 * Merge PDFs, alternating mode: the front sides and the back sides of a double-sided scan become
 * one document. The produced bytes are read back with the independent reader of `tool-fixture.ts`.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const pdfFile = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from(bytes),
});

async function openAlternating(page: Page, fronts: Uint8Array, backs: Uint8Array) {
  await page.goto('/editor/');
  await page.getByRole('button', { name: /^Merge PDFs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge PDFs' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('radio', { name: /^Alternate pages/ }).check();
  await expect(dialog.getByRole('checkbox', { name: 'Back sides are in reverse order' })).toBeChecked();
  const inputs = dialog.locator('input[type="file"]');
  await expect(inputs).toHaveCount(2);
  await inputs.nth(0).setInputFiles(pdfFile('fronts.pdf', fronts));
  await inputs.nth(1).setInputFiles(pdfFile('backs.pdf', backs));
  return dialog;
}

async function exportedTexts(page: Page): Promise<string[]> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = test.info().outputPath('alternated.pdf');
  await (await download).saveAs(path);
  const texts = await readProducedPageTexts(new Uint8Array(readFileSync(path)));
  return texts.map((text) => text.trim());
}

test('merge, alternating: a flipped stack of backs lands behind the right fronts', async ({ page }) => {
  const dialog = await openAlternating(page, labelledPdf('Front', 3), labelledPdf('Back', 3));
  // Merging always reports what it does not carry over, so the result is read before it opens.
  expect(await runForm(dialog, 'Open in new tab')).toBe('review');
  await expect(
    dialog.getByText('Front and back sides alternated: 3 front page(s) and 3 back page(s).'),
  ).toBeVisible();
  await expect(dialog.getByText('The back sides were taken from the last page to the first.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Open in new tab' }).click();
  await expect(page.getByRole('button', { name: 'Merged.pdf Unsaved changes', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(await exportedTexts(page)).toEqual(['Front 1', 'Back 3', 'Front 2', 'Back 2', 'Front 3', 'Back 1']);
});

test('merge, alternating: pages without a partner follow at the end and the report says so', async ({
  page,
}) => {
  const dialog = await openAlternating(page, labelledPdf('Front', 3), labelledPdf('Back', 1));
  await dialog.getByRole('checkbox', { name: 'Back sides are in reverse order' }).uncheck();
  expect(await runForm(dialog, 'Open in new tab')).toBe('review');
  await expect(reviewHeading(dialog)).toBeVisible();
  await expect(
    dialog.getByText(
      'The front sides have 2 more page(s) than the back sides; the extra pages follow at the end.',
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Open in new tab' }).click();
  await expect(page.getByRole('button', { name: 'Merged.pdf Unsaved changes', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(await exportedTexts(page)).toEqual(['Front 1', 'Back 1', 'Front 2', 'Front 3']);
});
