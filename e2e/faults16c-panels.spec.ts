/**
 * The accessibility views (audit report, PDF/UA rules, tags tree) answering for MuPDF failing
 * where the file is sound (`engine-faults.ts`): the panel says so, the notice line says so, the
 * document is as it was, and the same gesture works afterwards.
 */

import type { Locator, Page } from 'playwright/test';
import { notice } from './app-helpers';
import { failNext, firedCount, injectEngineFaults } from './engine-faults';
import { expect, test } from './test';
import { readProducedEntry, toolFixturePdf } from './tool-fixture';
import { exportBytes, openPdf } from './ui-helpers';
import { openTagsView, rowOf, taggedFixture, treeRows } from './ui-tags-helpers';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

const UNEXPECTED = 'Something unexpected went wrong.';
const OPEN = 'Document.static.openDocument';

const tab = (page: Page, view: 'report' | 'ua' | 'tags'): Locator =>
  page.locator(`[data-a11y-tab="${view}"]`);

async function openAccessibility(page: Page, view: 'report' | 'ua' | 'tags'): Promise<void> {
  await page.getByRole('tab', { name: 'Accessibility', exact: true }).click();
  await tab(page, view).click();
  await expect(tab(page, view)).toHaveAttribute('aria-selected', 'true');
}

test('the audit report: an audit the engine cannot open the file for says so, and the next Audit reports', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'plain.pdf', toolFixturePdf());
  await openAccessibility(page, 'report');
  await failNext(page, 'mupdf', OPEN, 'the wasm module trapped');
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'mupdf', OPEN)).toBe(1);
  await expect(page.getByText(UNEXPECTED).first()).toBeVisible();
  await expect(page.getByText('Audit has not been run yet.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await expect(page.getByText(/page\(s\) · \d+ issue\(s\)/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(UNEXPECTED)).toHaveCount(0);
});

test('the audit report: tagging a document the engine cannot save says so and leaves it untagged; the next try tags it', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'untagged.pdf', toolFixturePdf());
  await openAccessibility(page, 'report');
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tag document' })).toBeEnabled({ timeout: 60_000 });
  await failNext(page, 'mupdf', 'PDFDocument.saveToBuffer', 'the wasm module trapped');
  await page.getByRole('button', { name: 'Tag document', exact: true }).click();
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'mupdf', 'PDFDocument.saveToBuffer')).toBe(1);
  expect(await readProducedEntry(await exportBytes(page, 'same.pdf'), null, 'StructTreeRoot')).toBe('');

  const tag = page.getByRole('button', { name: 'Tag document', exact: true });
  await expect(tag).toBeEnabled();
  await tag.click();
  await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });
  expect(await readProducedEntry(await exportBytes(page, 'tagged.pdf'), null, 'StructTreeRoot')).not.toBe('');
});

test('the PDF/UA view: a check the engine cannot run says so, the view checks again when it is opened again, and a fix the engine cannot save changes nothing', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'plain.pdf', toolFixturePdf());
  await openAccessibility(page, 'report');
  await failNext(page, 'mupdf', OPEN, 'the wasm module trapped');
  await tab(page, 'ua').click();
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'mupdf', OPEN)).toBe(1);
  await expect(page.locator('[data-ua-rule]')).toHaveCount(0);
  await expect(page.getByText(UNEXPECTED).first()).toBeVisible();

  await tab(page, 'report').click();
  await tab(page, 'ua').click();
  await expect(page.locator('[data-ua-rule]').first()).toBeVisible({ timeout: 60_000 });

  // A quick fix whose write fails: nothing is journaled.
  const lang = page.locator('[data-ua-rule="lang"]');
  await lang.getByRole('textbox', { name: 'Language tag' }).fill('de-DE');
  await failNext(page, 'mupdf', 'PDFDocument.saveToBuffer', 'the wasm module trapped');
  await lang.getByRole('button', { name: 'Set language' }).click();
  await expect.poll(() => firedCount(page, 'mupdf', 'PDFDocument.saveToBuffer')).toBe(1);
  await expect(page.getByText(UNEXPECTED).first()).toBeVisible();
  expect(await readProducedEntry(await exportBytes(page, 'same.pdf'), null, 'Lang')).toBe('');
});

test('the tags view: a tree the engine cannot read says so and opens when the view is opened again', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await page.getByRole('tab', { name: 'Accessibility', exact: true }).click();
  await failNext(page, 'mupdf', OPEN, 'the wasm module trapped');
  await tab(page, 'tags').click();
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'mupdf', OPEN)).toBe(1);
  await expect(page.getByRole('tree', { name: 'Structure tree' })).toHaveCount(0);
  await expect(page.getByText(UNEXPECTED).first()).toBeVisible();

  await tab(page, 'report').click();
  await openTagsView(page);
  await expect(page.getByRole('tree', { name: 'Structure tree' })).toBeVisible();
});

test('the tags view: a page whose layout the engine cannot read still lists its rows, without boxes and without a notice', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  // The structure read is the first open; the layout of the page in view is the second.
  await failNext(page, 'mupdf', OPEN, 'the wasm module trapped', 1, 1);
  await openTagsView(page);
  await expect.poll(() => firedCount(page, 'mupdf', OPEN)).toBe(1);
  await expect(treeRows(page).first()).toHaveAttribute('data-tag-role', 'Document');
  // Page two's layout reads fine: its one box appears, page one's never does, and every row is listed.
  await expect(page.locator('[data-order-box][data-order-page="1"]')).toHaveCount(1);
  await expect(page.locator('[data-order-box][data-order-page="0"]')).toHaveCount(0);
  await page.getByLabel('Show').selectOption('all');
  const pageTwo = rowOf(page, 'P', 'Page two text');
  await expect(pageTwo).toBeVisible();
  await pageTwo.click();
  await expect(pageTwo).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
  await expect(notice(page, UNEXPECTED)).toHaveCount(0);
});
