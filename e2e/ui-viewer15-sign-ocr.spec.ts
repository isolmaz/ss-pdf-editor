/**
 * The certificate-signing and OCR forms refuse a run that has nothing to work with:
 * no PKCS#12 container chosen, no recognition language ticked. The reader gets the
 * translated message and the form says what exactly was missing.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { openPdf, runCommand } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

async function openForm(page: Page, command: string, region: string): Promise<Locator> {
  await runCommand(page, command);
  const form = page.getByRole('region', { name: region });
  await expect(form).toBeVisible({ timeout: 30_000 });
  return form;
}

async function expectRefused(form: Locator, message: string, diagnostic: string): Promise<void> {
  await form.getByRole('button', { name: /^(Preview|Sign)$/ }).click();
  const alert = form.getByRole('alert');
  await expect(alert).toContainText(message, { timeout: 60_000 });
  await expect(alert.locator('[data-dialog-diagnostic]')).toHaveAttribute(
    'data-dialog-diagnostic',
    diagnostic,
  );
  await expect(form.getByRole('heading', { name: 'Operation report' })).toHaveCount(0);
}

test('signing without a certificate container is refused, naming the missing file', async ({ page }) => {
  await openPdf(page, 'contract.pdf', labelledPdf('Contract', 1));
  const form = await openForm(page, 'Sign document', 'Sign Document (PAdES B-B)');
  await expectRefused(form, 'This operation has nothing to work with yet.', 'no PKCS#12 file was chosen');
});

test('text recognition with every language unticked is refused before any page is read', async ({ page }) => {
  await openPdf(page, 'scan.pdf', labelledPdf('Scan', 1));
  const form = await openForm(page, 'Text recognition', 'Text recognition (OCR)');
  await form.getByRole('checkbox', { name: 'Turkish' }).uncheck();
  await expectRefused(form, 'The selected OCR language is not installed.', 'ocr: no language was selected');
});
