/**
 * The PDF/UA view's one-click declaration: offered only once every automated rule passes, and
 * written into the file's XMP.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { exportBytes, openPdf } from './ui-helpers';
import { almostConformingPdf } from './ui-panels15c-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

async function openUa(page: Page, bytes: Uint8Array): Promise<void> {
  await openPdf(page, 'conforming.pdf', bytes);
  await page.getByRole('tab', { name: 'Accessibility', exact: true }).click();
  await page.locator('[data-a11y-tab="ua"]').click();
  await expect(page.locator('[data-ua-rule]').first()).toBeVisible({ timeout: 60_000 });
}

test('a file every automated rule passes on can be marked PDF/UA-1, and the XMP then carries the identifier', async ({
  page,
}) => {
  const bytes = await almostConformingPdf();
  expect(Buffer.from(bytes).toString('latin1')).not.toContain('pdfuaid');
  await openUa(page, bytes);

  const rule = page.locator('[data-ua-rule="pdfua-id"]');
  // The marking is not offered while the title rule still fails.
  await expect(rule.getByRole('button', { name: 'Declare PDF/UA-1' })).toBeDisabled();
  await expect(rule).toContainText('Not offered while an automated rule fails');
  await page.getByLabel('Document title').fill('Conforming report');
  await page.getByRole('button', { name: 'Set title' }).click();
  await expect(page.locator('[data-ua-rule="title"]')).toHaveAttribute('data-ua-state', 'pass', {
    timeout: 60_000,
  });

  await expect(rule).toBeVisible();
  const mark = rule.getByRole('button', { name: 'Declare PDF/UA-1' });
  await expect(mark).toBeEnabled();
  await mark.click();

  await expect(page.locator('[data-ua-rule="pdfua-id"]')).toHaveAttribute('data-ua-state', 'pass', {
    timeout: 60_000,
  });
  const produced = Buffer.from(await exportBytes(page, 'marked.pdf')).toString('latin1');
  expect(produced).toContain('pdfuaid:part');
});
