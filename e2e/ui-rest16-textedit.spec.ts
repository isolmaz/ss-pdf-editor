/**
 * Edit Text on a page with a line the editor cannot rewrite: its box is drawn and labelled
 * with the reason, and a click on it opens nothing, while a click on a plain line does.
 */

import { expect, test } from './test';
import { openPdf } from './ui-helpers';
import { runsPdf } from './ui-rest16-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const PDF = runsPdf([
  { text: 'Plain words', x: 72, y: 700 },
  { text: 'Tilted words', x: 100, y: 450, matrix: [0.866, 0.5, -0.5, 0.866] },
]);

test('a tilted line is marked not editable and a click on it opens nothing; a plain line opens its text', async ({
  page,
}) => {
  await openPdf(page, 'tilted.pdf', PDF);
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  const tilted = page.locator('[data-text-block][data-block-text="Tilted words"]');
  const plain = page.locator('[data-text-block][data-block-text="Plain words"]');
  await expect(plain).toHaveCount(1, { timeout: 30_000 });
  await expect(tilted).toHaveCount(1);
  await expect(tilted).toHaveAttribute('data-editability', 'not-editable');
  await expect(plain).not.toHaveAttribute('data-editability', 'not-editable');
  // The reason the box carries is the one the user reads on hover.
  const reason = await tilted.getAttribute('title');
  expect(reason ?? '').not.toBe('');
  await expect(tilted).toHaveAttribute('aria-label', new RegExp(`Tilted words — ${reason}`));

  await tilted.dispatchEvent('click');
  await expect(page.getByRole('region', { name: 'Edit text' })).toHaveCount(0);

  await plain.click();
  await expect(page.getByRole('region', { name: 'Edit text' })).toBeVisible({ timeout: 15_000 });
});
