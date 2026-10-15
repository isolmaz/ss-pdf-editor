/**
 * The operation form of the tools panel: the review of a result that has to be read first, the
 * cancel while an operation runs, and the export dialog's choice between the document and its
 * compressed copy.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { openDockTab, openPdf, reviewHeading, runCommand } from './ui-helpers';
import { viewingOnlyFixture } from './ui-tags-helpers';

const panel = (page: Page): Locator => page.getByRole('tabpanel');
const tool = (page: Page, title: string): Locator =>
  panel(page).getByRole('button', { name: new RegExp(`^${title}`) });

async function openTool(page: Page, group: string, title: string, region: string): Promise<Locator> {
  await openDockTab(page, 'Tools');
  const header = panel(page).getByRole('button', { name: group, exact: true });
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
  await tool(page, title).click();
  const form = page.getByRole('region', { name: region, exact: true });
  await expect(form).toBeVisible();
  return form;
}

test('a result that has to be read first is called Review the result, with its technical details folded away and no step marker', async ({
  page,
}) => {
  await openPdf(page);
  // Nothing to write: the run has no file to apply, so its report is the answer and is read.
  await runCommand(page, 'Document properties');
  const form = page.getByRole('region', { name: 'Document properties', exact: true });
  await expect(form).toBeVisible();
  await expect(form.locator('[aria-current="step"]')).toHaveCount(0);

  await form.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(reviewHeading(form)).toBeVisible({ timeout: 60_000 });
  await expect(form.locator('[aria-current="step"]')).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Apply to document', exact: true })).toBeVisible();

  const written = form.getByText('Written incrementally');
  await expect(written).toBeHidden();
  await form.getByText('Technical details', { exact: true }).click();
  await expect(written).toBeVisible();
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
  await expect(reviewHeading(form)).toHaveCount(0);
  // The run is over: the footer is back to the form's own Cancel and the settings can run again.
  await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1);
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
