/**
 * The tools rail (right dock, "Tools" tab) and the dock's keyboard model: each group
 * folds and unfolds, every tool button opens its own tool, the page actions act on the
 * document, and the dock's tabs follow the arrow keys.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { openDockTab, openPdf } from './ui-helpers';

const panel = (page: Page): Locator => page.getByRole('tabpanel');

const group = (page: Page, name: string): Locator => panel(page).getByRole('button', { name, exact: true });

const tool = (page: Page, title: string): Locator =>
  panel(page).getByRole('button', { name: new RegExp(`^${title.replace(/[()/]/g, '\\$&')}`) });

test('a group folds and unfolds, and only its own tools are listed while it is open', async ({ page }) => {
  await openPdf(page);
  await openDockTab(page, 'Tools');

  const security = group(page, 'Security and redaction');
  await expect(security).toHaveAttribute('aria-expanded', 'false');
  await expect(tool(page, 'Protect with password')).toHaveCount(0);

  await security.click();
  await expect(security).toHaveAttribute('aria-expanded', 'true');
  for (const title of [
    'Protect with password',
    'Remove password',
    'Sanitize document',
    'Permanent redaction',
  ]) {
    await expect(tool(page, title)).toBeVisible();
  }

  const pages = group(page, 'Organize pages');
  await expect(pages).toHaveAttribute('aria-expanded', 'true');
  await pages.click();
  await expect(pages).toHaveAttribute('aria-expanded', 'false');
  await expect(tool(page, 'Split document')).toHaveCount(0);
  await expect(tool(page, 'Protect with password')).toBeVisible();

  await security.click();
  await expect(security).toHaveAttribute('aria-expanded', 'false');
});

const TOOLS: readonly { readonly group: string; readonly button: string; readonly region: string }[] = [
  { group: 'Organize pages', button: 'Extract pages', region: 'Extract pages' },
  { group: 'Organize pages', button: 'Split document', region: 'Split document' },
  { group: 'Organize pages', button: 'Add document', region: 'Add document' },
  { group: 'Convert and export', button: 'Reduce file size', region: 'Reduce file size' },
  { group: 'Convert and export', button: 'Export pages as images', region: 'Export pages as images' },
  { group: 'Convert and export', button: 'Export text', region: 'Export text' },
  {
    group: 'Convert and export',
    button: 'Export to Word, Excel or CSV',
    region: 'Export to Word, Excel or CSV',
  },
  { group: 'Convert and export', button: 'Save as PDF/A', region: 'Save as PDF/A' },
  { group: 'Fill and sign', button: 'Sign document', region: 'Sign document' },
  { group: 'Fill and sign', button: 'Fill form fields', region: 'Fill form fields' },
  { group: 'Fill and sign', button: 'Add form field', region: 'Add form field' },
  { group: 'Security and redaction', button: 'Protect with password', region: 'Protect with password' },
  { group: 'Security and redaction', button: 'Remove password', region: 'Remove password' },
  { group: 'Security and redaction', button: 'Sanitize document', region: 'Sanitize document' },
  { group: 'Security and redaction', button: 'Permanent redaction', region: 'Permanent redaction' },
  {
    group: 'Numbering and watermark',
    button: 'Page numbers and headers/footers',
    region: 'Page numbers and headers/footers',
  },
  { group: 'Numbering and watermark', button: 'Add watermark', region: 'Add watermark' },
];

for (const entry of TOOLS) {
  test(`the "${entry.button}" button opens the "${entry.region}" tool and Back returns to the list`, async ({
    page,
  }) => {
    await openPdf(page);
    await openDockTab(page, 'Tools');
    const header = group(page, entry.group);
    if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();

    await tool(page, entry.button).click();
    await expect(page.getByRole('region', { name: entry.region, exact: true })).toBeVisible();
    await expect(tool(page, entry.button)).toHaveCount(0);

    await page.getByRole('button', { name: /^Back/ }).first().click();
    await expect(page.getByRole('region', { name: entry.region, exact: true })).toHaveCount(0);
    await expect(group(page, entry.group)).toBeVisible();
  });
}

test('Export Options opens the export dialog and the footer button opens the command palette', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Tools');

  await tool(page, 'Export options').click();
  const dialog = page.getByRole('dialog', { name: /Export options/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This PDF (');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await panel(page)
    .getByRole('button', { name: /Search All Commands/ })
    .click();
  await expect(page.getByRole('combobox')).toBeVisible();
});

test('Delete Pages removes the selected page and Rotate Pages turns it', async ({ page }) => {
  await openPdf(page);
  const pages = page.locator('.pdfViewer[data-active-viewer] .page');
  await expect(pages).toHaveCount(2);
  const shape = async () => pages.first().evaluate((element) => element.clientWidth / element.clientHeight);
  expect(await shape()).toBeLessThan(1);

  await openDockTab(page, 'Tools');
  await tool(page, 'Rotate pages').click();
  await expect.poll(shape).toBeGreaterThan(1);

  await tool(page, 'Delete pages').click();
  await expect(pages).toHaveCount(1);
});

test('the left dock moves between its tabs with the arrow keys', async ({ page }) => {
  await openPdf(page);
  const tabs = page.getByRole('tablist', { name: 'Left dock' }).getByRole('tab');
  const names = ['Pages', 'Outline', 'Attachments', 'Layers', 'Signatures', 'Results'];
  await expect(tabs).toHaveCount(names.length);

  const selected = () => page.getByRole('tablist', { name: 'Left dock' }).locator('[aria-selected="true"]');
  await openDockTab(page, 'Pages');
  await tabs.first().focus();

  await page.keyboard.press('ArrowDown');
  await expect(selected()).toHaveAttribute('aria-label', 'Outline');
  await page.keyboard.press('ArrowRight');
  await expect(selected()).toHaveAttribute('aria-label', 'Attachments');
  await page.keyboard.press('ArrowUp');
  await expect(selected()).toHaveAttribute('aria-label', 'Outline');
  await page.keyboard.press('ArrowLeft');
  await expect(selected()).toHaveAttribute('aria-label', 'Pages');
  // Wrapping past the first tab lands on the last; that tab's own panel takes the focus
  // (its search box), so the keys below start from a tab again.
  await page.keyboard.press('ArrowLeft');
  await expect(selected()).toHaveAttribute('aria-label', 'Results');
  await expect(page.getByRole('tabpanel').first()).toHaveAccessibleName('Results');

  // Any other key leaves the selection where it is.
  await openDockTab(page, 'Layers');
  await page.keyboard.press('x');
  await expect(selected()).toHaveAttribute('aria-label', 'Layers');
});

// The page shortcuts (Home and End jump to the first and last page) leave the keys to a
// tab list that owns them, as they do for menus and the thumbnail list.
test('Home and End on a dock tab move between tabs and leave the viewer on its page', async ({ page }) => {
  await openPdf(page);
  const selected = () => page.getByRole('tablist', { name: 'Left dock' }).locator('[aria-selected="true"]');
  await openDockTab(page, 'Attachments');
  await page.keyboard.press('Home');
  await expect(selected()).toHaveAttribute('aria-label', 'Pages');
  await expect(page.getByRole('tabpanel').first()).toHaveAccessibleName('Pages');
  await page.keyboard.press('End');
  await expect(selected()).toHaveAttribute('aria-label', 'Results');
  await expect(page.getByRole('tabpanel').first()).toHaveAccessibleName('Results');

  await expect(page.getByLabel('Page number')).toHaveValue('1');
});
