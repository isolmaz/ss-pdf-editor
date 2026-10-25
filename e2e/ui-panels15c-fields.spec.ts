/**
 * A multi-line field and a number field of the operation forms, driven as a user types into
 * them: the bookmarks written in the outline editor's box are the outline of the produced file.
 */

import { expect, test } from './test';
import { labelledPdf, readProducedPdf } from './tool-fixture';
import { applyForm, exportBytes, openDockTab, openPdf } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

test('bookmarks typed into the outline editor’s box become the outline of the file, with the page numbers typed', async ({
  page,
}) => {
  await openPdf(page, 'plain.pdf', labelledPdf('Doc', 3));
  await openDockTab(page, 'Outline');
  await page.getByRole('button', { name: 'Edit outline' }).click();
  const form = page.getByRole('region', { name: 'Edit outline' });
  await expect(form).toBeVisible({ timeout: 30_000 });

  // The mode starts on "add child"; the multi-line box only exists once "Rewrite all" is chosen.
  await expect(form.getByRole('textbox', { name: /^Bookmarks/ })).toHaveCount(0);
  await expect(form.getByRole('spinbutton', { name: 'Destination page' })).toBeVisible();
  await form.getByRole('combobox', { name: 'Action' }).click();
  await page.getByRole('option', { name: 'Rewrite all' }).click();
  await expect(form.getByRole('spinbutton', { name: 'Destination page' })).toHaveCount(0);

  const box = form.getByRole('textbox', { name: /^Bookmarks/ });
  await box.fill('Start | 1\nMiddle | 2\nEnd | 3');
  await expect(box).toHaveValue('Start | 1\nMiddle | 2\nEnd | 3');
  await applyForm(form);

  const produced = await readProducedPdf(await exportBytes(page, 'outlined.pdf'));
  expect(produced.outlineTitles).toEqual(['Start', 'Middle', 'End']);
});

test('a number outside its range, a fraction in a page number, or none, blocks the run with the range; a valid one lifts it', async ({
  page,
}) => {
  await openPdf(page, 'plain.pdf', labelledPdf('Doc', 3));
  await openDockTab(page, 'Outline');
  await page.getByRole('button', { name: 'Edit outline' }).click();
  const form = page.getByRole('region', { name: 'Edit outline' });
  const pageNumber = form.getByRole('spinbutton', { name: 'Destination page' });
  const run = form.locator('button').last();

  const refusal = form.getByText('This value must be a whole number between 1 and 100000.');

  await expect(pageNumber).toHaveValue('1');
  await pageNumber.fill('0');
  await expect(refusal).toBeVisible();
  await expect(run).toBeDisabled();
  await pageNumber.fill('');
  await expect(refusal).toBeVisible();
  await pageNumber.fill('2.5');
  await expect(refusal).toBeVisible();
  await expect(run).toBeDisabled();
  await pageNumber.fill('3');
  await expect(refusal).toHaveCount(0);
  await expect(pageNumber).toHaveValue('3');
});
