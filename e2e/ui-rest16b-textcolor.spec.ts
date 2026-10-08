/**
 * Edit Text's colour well: the colour chosen there is the colour the rewritten line is drawn in.
 */

import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { exportBytes, openPdf } from './ui-helpers';
import { pageContentOf } from './ui-rest16-helpers';
import { applyOperation } from './ui-viewer15-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('a colour picked in the Edit Text form colours the rewritten line in the file', async ({ page }) => {
  await openPdf(page, 'colour.pdf', labelledPdf('Plain', 1));
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  const block = page.locator('[data-text-block][data-block-text="Plain 1"]');
  await expect(block).toHaveCount(1, { timeout: 30_000 });
  await block.click();
  const form = page.getByRole('region', { name: 'Edit text' });
  await expect(form).toBeVisible({ timeout: 15_000 });
  await form.getByRole('textbox', { name: 'Text', exact: true }).fill('Coloured line');
  await form.getByLabel('Color', { exact: true }).fill('#cc0000');
  await expect(form.getByLabel('Color', { exact: true })).toHaveValue('#cc0000');
  await applyOperation(form);

  const bytes = await exportBytes(page, 'coloured.pdf');
  expect((await readProducedPageTexts(bytes))[0]).toContain('Coloured line');
  // 0xcc / 0xff = 0.8: the fill colour set before the rewritten text is drawn.
  expect(await pageContentOf(bytes)).toMatch(/0\.8 0 0 rg/);
});
