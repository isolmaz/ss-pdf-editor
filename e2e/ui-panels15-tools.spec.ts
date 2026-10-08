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

  const security = group(page, 'Security & Redaction');
  await expect(security).toHaveAttribute('aria-expanded', 'false');
  await expect(tool(page, 'Protect with Password')).toHaveCount(0);

  await security.click();
  await expect(security).toHaveAttribute('aria-expanded', 'true');
  for (const title of [
    'Protect with Password',
    'Remove Password',
    'Sanitize Document',
    'Permanent Redaction',
  ]) {
    await expect(tool(page, title)).toBeVisible();
  }

  const pages = group(page, 'Organize Pages');
  await expect(pages).toHaveAttribute('aria-expanded', 'true');
  await pages.click();
  await expect(pages).toHaveAttribute('aria-expanded', 'false');
  await expect(tool(page, 'Split Document')).toHaveCount(0);
  await expect(tool(page, 'Protect with Password')).toBeVisible();

  await security.click();
  await expect(security).toHaveAttribute('aria-expanded', 'false');
});

const TOOLS: readonly { readonly group: string; readonly button: string; readonly region: string }[] = [
  { group: 'Organize Pages', button: 'Extract Pages', region: 'Extract Pages' },
  { group: 'Organize Pages', button: 'Split Document', region: 'Split Document' },
  { group: 'Organize Pages', button: 'Combine / Add Document', region: 'Add / Import Document' },
  { group: 'Convert & Export PDF', button: 'Compress PDF', region: 'Optimize / Compress' },
  { group: 'Convert & Export PDF', button: 'Export Pages as Images', region: 'Export Pages as Images' },
  { group: 'Convert & Export PDF', button: 'Export as Plain Text', region: 'Export Text' },
  {
    group: 'Convert & Export PDF',
    button: 'Export as Word, Excel or CSV',
    region: 'Export to Word, Excel or CSV',
  },
  { group: 'Convert & Export PDF', button: 'Save as PDF/A', region: 'Save as PDF/A' },
  { group: 'Fill & Sign', button: 'Digital Signature (PAdES)', region: 'Sign Document (PAdES B-B)' },
  { group: 'Fill & Sign', button: 'Fill Form Fields', region: 'Fill form fields' },
  { group: 'Fill & Sign', button: 'Add New Form Field', region: 'New form field' },
  { group: 'Security & Redaction', button: 'Protect with Password', region: 'Security' },
  { group: 'Security & Redaction', button: 'Remove Password', region: 'Remove password' },
  { group: 'Security & Redaction', button: 'Sanitize Document', region: 'Sanitize document' },
  { group: 'Security & Redaction', button: 'Permanent Redaction', region: 'Redaction (Permanent Erase)' },
  { group: 'Numbering & Watermark', button: 'Add Page Numbers', region: 'Header / Footer & Page Numbering' },
  { group: 'Numbering & Watermark', button: 'Add Watermark', region: 'Watermark' },
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

  await tool(page, 'Export Options').click();
  const dialog = page.getByRole('dialog', { name: /Download \/ Export/ });
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
  await tool(page, 'Rotate Pages').click();
  await expect.poll(shape).toBeGreaterThan(1);

  await tool(page, 'Delete Pages').click();
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
