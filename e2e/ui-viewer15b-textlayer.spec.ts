/**
 * Edit Text: the paragraph boxes drawn over the page. Clicking one opens its text for
 * editing, and the edit is what the file says afterwards.
 */

import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { exportBytes, openPdf } from './ui-helpers';
import { applyOperation } from './ui-viewer15-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('clicking a paragraph box opens its text; the rewritten line is what the file says', async ({
  page,
}) => {
  await openPdf(page, 'edit.pdf', labelledPdf('Original', 1));
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  const block = page.locator('[data-text-block][data-block-text="Original 1"]');
  await expect(block).toHaveCount(1, { timeout: 30_000 });
  await block.click();
  const form = page.getByRole('region', { name: 'Edit text' });
  await expect(form).toBeVisible({ timeout: 15_000 });
  const text = form.getByRole('textbox', { name: 'Text', exact: true });
  await expect(text).toHaveValue('Original 1');
  await text.fill('Rewritten line');
  await applyOperation(form);
  const texts = await readProducedPageTexts(await exportBytes(page, 'edited.pdf'));
  expect(texts[0]).toContain('Rewritten line');
  expect(texts[0]).not.toContain('Original 1');
});
