/**
 * Insert pages / Replace pages, the sources the other page specs do not drive: pictures,
 * a whole other document, a size matching the page being replaced, and the refusals when
 * a source is missing or yields the wrong number of pages.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry, readProducedPageTexts } from './tool-fixture';
import { encodePng, exportBytes, inkPng, openPdf, pdfFile, runCommand } from './ui-helpers';
import { applyOperation, browserJpeg } from './ui-viewer15-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const thumbs = (page: Page) => page.getByRole('option');

async function openForm(page: Page, command: string, region: string): Promise<Locator> {
  await runCommand(page, command);
  const form = page.getByRole('region', { name: region });
  await expect(form).toBeVisible({ timeout: 30_000 });
  return form;
}

async function choose(page: Page, form: Locator, label: string, option: string): Promise<void> {
  await form.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Preview and expect the alert: the translated message and the engine's own words as its diagnostic. */
async function expectRefused(form: Locator, message: string, diagnostic: string): Promise<void> {
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  const alert = form.getByRole('alert');
  await expect(alert).toContainText(message, { timeout: 60_000 });
  await expect(alert.locator('[data-dialog-diagnostic]')).toHaveAttribute(
    'data-dialog-diagnostic',
    diagnostic,
  );
}

const mediaBox = (bytes: Uint8Array, index: number) => readProducedEntry(bytes, index, 'MediaBox');
const pictures = (bytes: Uint8Array, index: number) =>
  readProducedEntry(bytes, index, 'Resources', 'XObject');

test('insert from images: every picture becomes one page after the chosen page, sized A4', async ({
  page,
}) => {
  await page.goto('/editor/');
  const jpeg = await browserJpeg(page, 40, 20);
  await openPdf(page, 'base.pdf', labelledPdf('Base', 3), { navigate: false });
  const form = await openForm(page, 'Insert page', 'Insert Pages');
  await form.getByRole('radio', { name: 'From images' }).check();
  await form.locator('input[type="file"]').setInputFiles([
    { name: 'ink.png', mimeType: 'image/png', buffer: inkPng(60, 30) },
    { name: 'wide.jpg', mimeType: 'image/jpeg', buffer: jpeg },
  ]);
  await form.getByText(/^Advanced options/).click();
  await choose(page, form, 'Image placement', 'Fill (crop overflow)');
  await form.getByRole('spinbutton', { name: 'Position (after page N)' }).fill('1');
  await applyOperation(form);
  await expect(thumbs(page)).toHaveCount(5);
  const bytes = await exportBytes(page, 'with-pictures.pdf');
  const texts = (await readProducedPageTexts(bytes)).map((text) => text.trim());
  expect(texts).toEqual(['Base 1', '', '', 'Base 2', 'Base 3']);
  for (const index of [1, 2]) {
    expect(await mediaBox(bytes, index)).toBe('[0 0 595.28 841.89]');
    expect(await pictures(bytes, index)).toMatch(/^<<\/\w+ \d+ 0 R>>$/);
  }
  expect(await pictures(bytes, 0)).toBe('');
});

test('insert from images with the stretch placement still makes one picture page per file', async ({
  page,
}) => {
  await openPdf(page, 'base.pdf', labelledPdf('Base', 1));
  const form = await openForm(page, 'Insert page', 'Insert Pages');
  await form.getByRole('radio', { name: 'From images' }).check();
  await form.locator('input[type="file"]').setInputFiles({
    name: 'ink.png',
    mimeType: 'image/png',
    buffer: inkPng(60, 30),
  });
  await form.getByText(/^Advanced options/).click();
  await choose(page, form, 'Image placement', 'Stretch (ignore aspect ratio)');
  await applyOperation(form);
  await expect(thumbs(page)).toHaveCount(2);
  const bytes = await exportBytes(page, 'stretched.pdf');
  expect(await pictures(bytes, 1)).toMatch(/^<<\/\w+ \d+ 0 R>>$/);
});

test('insert from another PDF with the range left blank brings in every page of it', async ({ page }) => {
  await openPdf(page, 'base.pdf', labelledPdf('Base', 2));
  const form = await openForm(page, 'Insert page', 'Insert Pages');
  await form.getByRole('radio', { name: 'From another PDF' }).check();
  await form.locator('input[type="file"]').setInputFiles(pdfFile('donor.pdf', labelledPdf('Donor', 3)));
  await form.getByRole('spinbutton', { name: 'Position (after page N)' }).fill('2');
  await applyOperation(form);
  await expect(thumbs(page)).toHaveCount(5);
  const texts = await readProducedPageTexts(await exportBytes(page, 'all-donor.pdf'));
  expect(texts.map((text) => text.trim())).toEqual(['Base 1', 'Base 2', 'Donor 1', 'Donor 2', 'Donor 3']);
});

test('insert from another PDF without a file is refused, naming the missing source', async ({ page }) => {
  await openPdf(page, 'base.pdf', labelledPdf('Base', 2));
  const form = await openForm(page, 'Insert page', 'Insert Pages');
  await form.getByRole('radio', { name: 'From another PDF' }).check();
  await expectRefused(
    form,
    'This operation has nothing to work with yet.',
    'pageedit: no source PDF was picked',
  );
});

test('insert from images without a file is refused, naming the missing pictures', async ({ page }) => {
  await openPdf(page, 'base.pdf', labelledPdf('Base', 2));
  const form = await openForm(page, 'Insert page', 'Insert Pages');
  await form.getByRole('radio', { name: 'From images' }).check();
  await expectRefused(form, 'This operation has nothing to work with yet.', 'pageedit: no image was picked');
});

test('replace with a picture sized to the page it replaces keeps that page size', async ({ page }) => {
  await openPdf(page, 'small.pdf', labelledPdf('Small', 3, { size: [300, 400] }));
  await thumbs(page).nth(1).click();
  const form = await openForm(page, 'Replace Pages', 'Replace Pages');
  await form.getByRole('radio', { name: 'Image', exact: true }).check();
  await form.locator('input[type="file"]').setInputFiles({
    name: 'ink.png',
    mimeType: 'image/png',
    buffer: inkPng(60, 30),
  });
  await form.getByText(/^Advanced options/).click();
  await choose(page, form, 'Image placement', 'Stretch (ignore aspect ratio)');
  await applyOperation(form);
  const bytes = await exportBytes(page, 'replaced.pdf');
  const texts = (await readProducedPageTexts(bytes)).map((text) => text.trim());
  expect(texts).toEqual(['Small 1', '', 'Small 3']);
  expect(await mediaBox(bytes, 1)).toBe('[0 0 300 400]');
  expect(await pictures(bytes, 1)).toMatch(/^<<\/\w+ \d+ 0 R>>$/);
});

test('replacing two pages with one picture is refused and says how many were prepared', async ({ page }) => {
  await openPdf(page, 'trio.pdf', labelledPdf('Trio', 3));
  await thumbs(page).nth(0).click();
  await thumbs(page)
    .nth(1)
    .click({ modifiers: ['Control'] });
  const form = await openForm(page, 'Replace Pages', 'Replace Pages');
  await form.getByRole('radio', { name: 'Image', exact: true }).check();
  await form.locator('input[type="file"]').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: encodePng(4, 4, () => [10, 20, 30]),
  });
  await expectRefused(
    form,
    'Select pages first.',
    'replace-pages: 2 page(s) selected, 1 replacement page(s) prepared from 1 image(s)',
  );
});
