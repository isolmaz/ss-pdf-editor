/**
 * The form panel (right dock, "Form fields"): the inventory of the document's fields, its
 * keyboard model, and the inline controls that commit through the shell — what the user
 * sees in the panel and what the exported file holds.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { exportBytes, openDockTab, openPdf } from './ui-helpers';
import { FORM_FIELDS, formFixturePdf, formValues } from './ui-panels15-helpers';

const list = (page: Page): Locator => page.locator('ul[aria-label="Form fields"]');
const rows = (page: Page): Locator => list(page).locator('> li');
const row = (page: Page, name: string): Locator => rows(page).filter({ hasText: name }).first();
const rowButton = (page: Page, name: string): Locator => row(page, name).getByRole('button').first();

async function openForms(page: Page): Promise<void> {
  await openPdf(page, 'form.pdf', formFixturePdf());
  await openDockTab(page, 'Form fields');
  await expect(rows(page)).toHaveCount(FORM_FIELDS.length);
}

test('lists every field in file order with its kind, its lock and required marks and its value', async ({
  page,
}) => {
  await openForms(page);
  await expect(page.getByText('8 form field(s) listed.')).toBeAttached();

  for (const [index, field] of FORM_FIELDS.entries()) {
    const entry = rows(page).nth(index);
    await expect(entry.getByRole('button').first()).toContainText(field.name);
    await expect(entry.getByRole('button').first()).toContainText(field.kind);
  }
  await expect(row(page, 'locked').getByTitle('Read only')).toBeVisible();
  await expect(row(page, 'applicant').getByTitle('Required')).toBeVisible();
  await expect(row(page, 'applicant').getByTitle('Read only')).toHaveCount(0);

  // A locked field shows its value but offers no control; an editable one a button holding it.
  await expect(row(page, 'locked')).toContainText('Fixed text');
  await expect(row(page, 'locked').locator('input')).toHaveCount(0);
  await expect(row(page, 'applicant').getByRole('button', { name: 'Ada' })).toBeVisible();
  await expect(row(page, 'country').getByRole('button', { name: 'France' })).toBeVisible();
  await expect(row(page, 'agree').getByRole('checkbox')).not.toBeChecked();
  await expect(row(page, 'agree')).toContainText('Unchecked');
  await expect(row(page, 'seal')).toContainText('(empty)');
});

test('the arrow keys, Home and End walk the rows and Enter selects the focused one', async ({ page }) => {
  await openForms(page);
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? '');

  await rowButton(page, 'applicant').focus();
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toContain('locked');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toContain('agree');
  await page.keyboard.press('ArrowUp');
  expect(await focused()).toContain('locked');
  // Only the focused row is in the tab order, and Enter selects it.
  await expect(rowButton(page, 'locked')).toHaveAttribute('tabindex', '0');
  await expect(rowButton(page, 'applicant')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Enter');
  await expect(rowButton(page, 'locked')).toHaveAttribute('aria-current', 'true');
  await expect(rowButton(page, 'applicant')).not.toHaveAttribute('aria-current', 'true');
});

test('a value typed into the inline control is committed with Enter and lands in the exported file', async ({
  page,
}) => {
  await openForms(page);
  await rowButton(page, 'applicant').click();
  const input = row(page, 'applicant').locator('input[type="text"]');
  await expect(input).toHaveValue('Ada');
  await expect(input).toBeFocused();

  await input.fill('Grace Hopper');
  await input.press('Enter');
  // The field stays selected, so its control reopens on the value the document now holds.
  await expect(page.getByText('Applied to document: Form fields', { exact: false })).toBeVisible();
  await expect(input).toHaveValue('Grace Hopper');

  const values = await formValues(await exportBytes(page, 'filled.pdf'));
  expect(values.applicant).toBe('Grace Hopper');
  expect(values.locked).toBe('Fixed text');
});

test('leaving the control commits the edit, Escape drops it, and an untouched control writes nothing', async ({
  page,
}) => {
  await openForms(page);

  await rowButton(page, 'applicant').click();
  const input = row(page, 'applicant').locator('input[type="text"]');
  await input.fill('Blurred value');
  await input.press('Tab');
  await expect(page.getByText('Applied to document: Form fields', { exact: false })).toBeVisible();
  await expect(input).toHaveValue('Blurred value');

  await input.fill('Discarded value');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(row(page, 'applicant').getByRole('button', { name: 'Blurred value' })).toBeVisible();

  // Opened and left without a keystroke: no fill is journaled, so no "applied" notice follows.
  await rowButton(page, 'country').click();
  await row(page, 'country').locator('input[type="text"]').press('Enter');
  await expect(row(page, 'country').getByRole('button', { name: 'France' })).toBeVisible();

  const values = await formValues(await exportBytes(page, 'blurred.pdf'));
  expect(values.applicant).toBe('Blurred value');
  expect(values.country).toBe('France');
});

test('a dropdown offers its options and a chosen one is written', async ({ page }) => {
  await openForms(page);
  await rowButton(page, 'country').click();
  const input = row(page, 'country').locator('input[type="text"]');
  await expect(input).toHaveValue('France');
  await expect(row(page, 'country').locator('datalist option')).toHaveCount(3);
  expect(
    await row(page, 'country')
      .locator('datalist option')
      .evaluateAll((els) => els.map((e) => e.getAttribute('value'))),
  ).toEqual(['Turkey', 'France', 'Japan']);

  await input.fill('Japan');
  await input.press('Enter');
  await expect(page.getByText('Applied to document: Form fields', { exact: false })).toBeVisible();
  await expect(input).toHaveValue('Japan');
  const values = await formValues(await exportBytes(page, 'country.pdf'));
  expect(values.country).toBe('Japan');
});

test('a checkbox toggles at once, with its label following, and the file keeps the state', async ({
  page,
}) => {
  await openForms(page);
  const box = row(page, 'agree').getByRole('checkbox');
  await box.click();
  await expect(box).toBeChecked();
  await expect(row(page, 'agree')).toContainText('Checked');
  expect((await formValues(await exportBytes(page, 'checked.pdf'))).agree).not.toBe('Off');

  await box.click();
  await expect(box).not.toBeChecked();
  await expect(row(page, 'agree')).toContainText('Unchecked');
  expect((await formValues(await exportBytes(page, 'unchecked.pdf'))).agree).toBe('Off');
});

// The shell's page shortcuts (Home and End jump to the first and last page) leave the keys to
// the list that owns them.
test('Home and End walk to the first and last row instead of turning the page', async ({ page }) => {
  await openForms(page);
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? '');
  await rowButton(page, 'locked').focus();
  await page.keyboard.press('End');
  expect(await focused()).toContain('seal');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toContain('seal');
  await page.keyboard.press('Home');
  expect(await focused()).toContain('applicant');
  await page.keyboard.press('ArrowUp');
  expect(await focused()).toContain('applicant');

  await expect(page.getByLabel('Page number')).toHaveValue('1');
});
