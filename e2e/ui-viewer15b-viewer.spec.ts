/**
 * The viewer pane's find bar reached from the header's search button, and its hand-over to
 * Find and replace.
 */

import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { exportBytes, openPdf } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('the header search button opens the find bar with its field focused; Replace… carries the query into Find and replace', async ({
  page,
}) => {
  await openPdf(page, 'find.pdf', labelledPdf('Alpha', 1));
  await page.getByRole('button', { name: 'Search document', exact: true }).click();
  const bar = page.getByRole('search');
  const box = bar.getByRole('textbox', { name: 'Find in document' });
  await expect(box).toBeFocused();
  await box.fill('Alpha');
  await box.press('Enter');
  await expect(bar.locator('span').first()).toHaveText('1 of 1 matches');

  // Opened again with a query in it, the field is selected so typing replaces it.
  await page.getByRole('button', { name: 'Search document', exact: true }).click();
  await expect(box).toBeFocused();
  expect(
    await box.evaluate((input: HTMLInputElement) =>
      input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
    ),
  ).toBe('Alpha');

  await bar.getByRole('button', { name: 'Replace…', exact: true }).click();
  const form = page.getByRole('region', { name: 'Find and replace' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(form.getByRole('textbox', { name: 'Find', exact: true })).toHaveValue('Alpha');
  await form.getByRole('textbox', { name: 'Replace with' }).fill('Omega');
  await form.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
  const texts = await readProducedPageTexts(await exportBytes(page, 'replaced.pdf'));
  expect(texts[0]).toContain('Omega 1');
  expect(texts[0]).not.toContain('Alpha');
});
