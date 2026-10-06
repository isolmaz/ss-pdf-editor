import { readFileSync } from 'node:fs';
import type { Page } from 'playwright/test';
import { expect, test } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { readProducedPageTexts, readProducedPdf, textNotePdf, toolFixturePdf } from './tool-fixture';

/**
 * Editor flows end to end: errors, navigation, page operations, search, forms,
 * redaction, closing and the recent list.
 *
 * Each test is one flow and reads the produced file where there is one, with the same
 * independent readers the other specs use (`tool-fixture.ts`). The marks, text tool,
 * password, properties, attachments, outline and watermark flows live in
 * `editor-stability.spec.ts` and `tool-interaction.spec.ts`; they are not repeated here.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const CANVAS = '.pdfViewer[data-active-viewer] .page canvas';

async function open(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  // The page shows before the open finishes (the source is still being stored), and the
  // shell refuses other work until then: a gesture sent earlier is dropped under load.
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });
}

/** Export through the header button and read the downloaded bytes back. */
async function exported(page: Page, name: string): Promise<Uint8Array> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return new Uint8Array(readFileSync(path));
}

const thumbs = (page: Page) => page.getByRole('option');
const notice = (page: Page, text: string) => page.locator('[role="status"]').filter({ hasText: text });

test('a file that is not a PDF is refused with a message and a valid file opens afterwards', async ({
  page,
}) => {
  await page.goto('/editor/');
  const input = page.locator('input[type="file"][accept*="application/pdf"]').first();
  await input.setInputFiles({
    name: 'bad.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('this is not a pdf at all'),
  });
  await expect(notice(page, 'The document looks damaged')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.pdfViewer')).toHaveCount(0);

  await input.setInputFiles({
    name: 'good.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(toolFixturePdf()),
  });
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
});

test('page stepper, page field and zoom move the view', async ({ page }) => {
  await open(page, 'nav.pdf', toolFixturePdf());
  const field = page.getByLabel('Page number');
  await expect(field).toHaveValue('1');
  await page.getByRole('button', { name: 'Next Page' }).click();
  await expect(field).toHaveValue('2');
  await field.fill('1');
  await field.press('Enter');
  await expect(field).toHaveValue('1');

  const level = page.getByRole('button', { name: /Fit Width/ });
  const percent = async () => Number.parseInt((await level.textContent()) ?? '0', 10);
  const before = await percent();
  await page.getByRole('button', { name: 'Zoom In (+)' }).click();
  await expect.poll(percent).toBeGreaterThan(before);
  await page.getByRole('button', { name: 'Zoom Out (-)' }).click();
  await expect.poll(percent).toBe(before);
});

test('duplicating, moving and deleting pages reach the file, and undo takes them back', async ({ page }) => {
  await open(page, 'pages.pdf', toolFixturePdf());
  await expect(thumbs(page)).toHaveCount(2);

  // The pages panel's hover actions are named in the interface language (they were Turkish).
  await thumbs(page).first().hover();
  await expect(thumbs(page).first().getByRole('button', { name: 'Rotate right' })).toBeVisible();

  await thumbs(page).first().click();
  await page.getByRole('menuitem', { name: 'Page', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate pages' }).click();
  await expect(thumbs(page)).toHaveCount(3);

  await thumbs(page).nth(2).dragTo(thumbs(page).first());
  await expect(notice(page, 'page(s) moved')).toBeVisible();
  const reordered = await readProducedPageTexts(await exported(page, 'moved.pdf'));
  expect(reordered).toHaveLength(3);
  expect(reordered[0]).toContain('Second page anchor line');
  expect(reordered[1]).toContain('Fixture line one');

  await page.keyboard.press('Control+z');
  await expect(notice(page, 'Undone: 1 page(s) moved')).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(notice(page, 'Undone: 1 page(s) duplicated')).toBeVisible();
  await expect(thumbs(page)).toHaveCount(2);
  const restored = await readProducedPdf(await exported(page, 'restored.pdf'));
  expect(restored.pageCount).toBe(2);

  await thumbs(page).nth(1).hover();
  await thumbs(page).nth(1).getByRole('button', { name: 'Delete pages' }).click();
  await expect(thumbs(page)).toHaveCount(1);
  expect((await readProducedPdf(await exported(page, 'deleted.pdf'))).pageCount).toBe(1);
});

test('search counts matches across pages and highlights them', async ({ page }) => {
  await open(page, 'find.pdf', toolFixturePdf());
  await page.keyboard.press('Control+f');
  const box = page.getByRole('textbox', { name: 'Find in document' });
  await expect(box).toBeFocused();
  await box.fill('line');
  await box.press('Enter');
  // Four lines on page one and the anchor line on page two.
  await expect(page.getByText('1 of 5 matches')).toBeVisible();
  // "Highlights them": every match painted on the page is marked in the text layer, not
  // only the current one (page one holds four of the five).
  await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer .highlight')).toHaveCount(4);
  await expect(page.locator('.pdfViewer .textLayer .highlight.selected')).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('a form value typed in the panel reaches the exported file', async ({ page }) => {
  await open(page, 'form.pdf', toolFixturePdf());
  await useAdvancedMode(page);
  await page.getByRole('tab', { name: 'Form fields' }).click();
  const field = page
    .locator('input[type="text"]')
    .filter({ hasNot: page.getByLabel('Page number') })
    .first();
  await expect(field).toHaveValue('Grace Hopper');
  await field.fill('Ada Lovelace');
  await field.blur();
  const produced = await readProducedPdf(await exported(page, 'form-out.pdf'));
  expect(produced.formValue).toBe('Ada Lovelace');
});

test('typing a value into a field on the page is one undo step, not one per keystroke', async ({ page }) => {
  await open(page, 'typing.pdf', toolFixturePdf());
  const field = page.locator('.annotationLayer input[type="text"]').first();
  await expect(field).toHaveValue('Grace Hopper');
  await field.click();
  await field.press('Control+a');
  await field.pressSequentially('Ada', { delay: 80 });
  await field.press('Tab');
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByText('1 step(s) can be undone')).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(notice(page, 'Undone')).toBeVisible();
  await expect(page.locator('.annotationLayer input[type="text"]').first()).toHaveValue('Grace Hopper');
});

test('a redaction box removes the text under it from the exported file', async ({ page }) => {
  await open(page, 'redact.pdf', toolFixturePdf());
  await page.getByRole('button', { name: 'Redact (permanent removal)' }).click();
  const sheet = await page.locator('.pdfViewer[data-active-viewer] .page').first().boundingBox();
  if (sheet === null) throw new Error('no page box');
  const scale = sheet.width / 595;
  // The fourth line sits on baseline 580.
  await page.mouse.move(sheet.x + 60 * scale, sheet.y + (842 - 592) * scale);
  await page.mouse.down();
  await page.mouse.move(sheet.x + 330 * scale, sheet.y + (842 - 575) * scale, { steps: 6 });
  await page.mouse.up();

  await page.getByRole('tab', { name: 'Redaction', exact: true }).click();
  await page.getByRole('button', { name: 'Redaction (Permanent Erase)', exact: true }).click();
  const form = page.getByRole('region', { name: 'Redaction (Permanent Erase)' });
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(notice(page, 'targeted content no longer exists')).toBeVisible({ timeout: 60_000 });

  const texts = await readProducedPageTexts(await exported(page, 'redacted.pdf'));
  expect(texts[0]).toContain('Third line stays untouched');
  expect(texts[0]).not.toContain('Fourth line');
});

test('closing an edited document asks first, and the recent list names its controls in the interface language', async ({
  page,
}) => {
  await open(page, 'recent.pdf', toolFixturePdf());
  await useAdvancedMode(page);
  await page.getByRole('button', { name: /Rotate page/i }).click();
  await expect(notice(page, '1 page(s) rotated')).toBeVisible();

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Close tab');
  await page.getByRole('option').filter({ hasText: 'Close tab' }).first().click();
  const dialog = page.getByRole('dialog', { name: /recent\.pdf/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close without saving' }).click();

  // Home again: the document is listed, with controls named in the interface language.
  await page.getByRole('tab', { name: 'Recent', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'recent.pdf' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Star', exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Remove from list' }).click();
  await expect(row).toBeHidden();
});

test("a file's own sticky note is drawn with its icon, not a broken image", async ({ page }) => {
  // pdf.js lays `annotation-<icon>.svg` over every /Text note from its image path; the
  // default path was relative to the page and the request came back 404 with HTML.
  const icons: { url: string; status: number }[] = [];
  page.on('response', (response) => {
    if (/annotation-[a-z]+\.svg/.test(response.url()))
      icons.push({ url: response.url(), status: response.status() });
  });
  await open(page, 'noted.pdf', await textNotePdf('A note the file already had'));
  const icon = page.locator('.annotationLayer .textAnnotation img').first();
  await expect(icon).toBeAttached({ timeout: 15_000 });
  await expect
    .poll(() => icon.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0))
    .toBe(true);
  expect(icons.length).toBeGreaterThan(0);
  expect(icons.every((entry) => entry.status === 200)).toBe(true);
});
