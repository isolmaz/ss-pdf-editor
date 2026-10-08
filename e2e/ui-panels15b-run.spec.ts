/**
 * The operation form of the tools panel: the two steps it shows, the cancel while an
 * operation runs, and the export dialog's choice between the document and its compressed copy.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { openDockTab, openPdf } from './ui-helpers';
import { viewingOnlyFixture } from './ui-tags-helpers';

const panel = (page: Page): Locator => page.getByRole('tabpanel');
const tool = (page: Page, title: string): Locator =>
  panel(page).getByRole('button', { name: new RegExp(`^${title}`) });
const steps = (form: Locator): Locator => form.getByRole('list').first().getByRole('listitem');

async function openTool(page: Page, group: string, title: string, region: string): Promise<Locator> {
  await openDockTab(page, 'Tools');
  const header = panel(page).getByRole('button', { name: group, exact: true });
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
  await tool(page, title).click();
  const form = page.getByRole('region', { name: region, exact: true });
  await expect(form).toBeVisible();
  return form;
}

test('a tool that replaces the document names its second step Review and apply, and the step marker moves on after the preview', async ({
  page,
}) => {
  await openPdf(page);
  const form = await openTool(
    page,
    'Numbering & Watermark',
    'Add Page Numbers',
    'Header / Footer & Page Numbering',
  );
  await expect(steps(form)).toHaveText(['1Settings', '2Review and apply']);
  await expect(steps(form).first()).toHaveAttribute('aria-current', 'step');
  await expect(steps(form).last()).not.toHaveAttribute('aria-current', 'step');

  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await expect(steps(form).last()).toHaveAttribute('aria-current', 'step');
  await expect(steps(form).first()).not.toHaveAttribute('aria-current', 'step');
  await expect(form.getByRole('button', { name: 'Apply to document', exact: true })).toBeVisible();
});

test('a tool whose result is a download names its second step Result', async ({ page }) => {
  await openPdf(page);
  const form = await openTool(page, 'Security & Redaction', 'Protect with Password', 'Security');
  await expect(steps(form)).toHaveText(['1Settings', '2Result']);
});

test('Cancel while an operation runs stops it, says so, and leaves the settings to run again', async ({
  page,
}) => {
  await openPdf(page, 'long.pdf', await viewingOnlyFixture());
  const form = await openTool(
    page,
    'Convert & Export PDF',
    'Export Pages as Images',
    'Export Pages as Images',
  );
  await form.locator('button').last().click();
  // While it runs the footer holds two Cancel buttons: the form's own, then the run's.
  await form.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await expect(form.getByText('Operation cancelled.')).toBeVisible();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toHaveCount(0);
  await expect(steps(form).first()).toHaveAttribute('aria-current', 'step');
});

test('the export dialog offers the document or its compressed copy and the button follows the choice', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Tools');
  await tool(page, 'Export Options').click();
  const dialog = page.getByRole('dialog', { name: /Download \/ Export/ });
  const pdf = dialog.getByRole('radio', { name: /This PDF/ });
  const compressed = dialog.getByRole('radio', { name: /Compressed PDF/ });
  await expect(pdf).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeVisible();

  await compressed.check();
  await expect(compressed).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Download Compressed PDF', exact: true })).toBeVisible();

  await pdf.check();
  await expect(pdf).toBeChecked();
  await expect(compressed).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeVisible();
});
