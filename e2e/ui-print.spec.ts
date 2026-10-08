/**
 * The print dialog: which pages it sends (all, the ones in view, a typed range), at which
 * scale, and what comes out. The browser's own print dialog cannot be driven, so the page's
 * `window.print` stands in and records the sheets the editor laid out when it was called —
 * their number, order (told apart by the pages' shapes) and sizes. The imposed file
 * ("Generate Printable PDF") opens as a new tab and is exported and read back.
 */

import type { Locator, Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry, readProducedPageTexts, readProducedPdf } from './tool-fixture';
import { exportBytes, openPdf } from './ui-helpers';
import {
  type PrintedSheet,
  printedJobs,
  revokedUrls,
  spyOnPrint,
  trackRevocations,
  withPageSizes,
} from './ui-panels9-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** Three pages of three shapes: portrait A4, landscape A4, a square. */
const SHAPES = [
  [595, 842],
  [842, 595],
  [500, 500],
] as const;

const shapedPdf = async (): Promise<Uint8Array> => withPageSizes(labelledPdf('Print', 3), SHAPES);

const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Print' });
const printButton = (page: Page): Locator => dialog(page).getByRole('button', { name: 'Print', exact: true });

async function openPrint(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+p');
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  return dialog(page);
}

/** Which of the three shapes a sheet is, from the proportions of its raster. */
const shapeOf = (sheet: PrintedSheet): 'portrait' | 'landscape' | 'square' => {
  const ratio = sheet.naturalWidth / sheet.naturalHeight;
  return ratio > 1.2 ? 'landscape' : ratio < 0.9 ? 'portrait' : 'square';
};

async function onlyJob(page: Page): Promise<readonly PrintedSheet[]> {
  await expect.poll(async () => (await printedJobs(page)).length).toBe(1);
  const [job] = await printedJobs(page);
  if (job === undefined) throw new Error('no print job');
  return job;
}

test('All pages: every page is laid out in order at the A4 width, the dialog closes and the sheets are released', async ({
  page,
}) => {
  await spyOnPrint(page);
  await trackRevocations(page);
  await openPdf(page, 'print.pdf', await shapedPdf());
  const panel = await openPrint(page);
  await expect(panel.getByRole('radio', { name: 'All pages' })).toBeChecked();
  await expect(panel.getByRole('radio', { name: 'Fit to page' })).toBeChecked();
  await printButton(page).click();

  const sheets = await onlyJob(page);
  expect(sheets.map(shapeOf)).toEqual(['portrait', 'landscape', 'square']);
  // "Fit": the stylesheet decides the size, and every raster carries the A4 width twice over (2 × 793.7 px).
  for (const sheet of sheets) {
    expect(sheet.styleWidth).toBe('');
    expect(Math.abs(sheet.naturalWidth - 1587)).toBeLessThanOrEqual(2);
  }
  expect(sheets.map((sheet) => sheet.naturalHeight)).toEqual(
    [2245, 1122, 1587].map((height, index) => {
      return Math.abs((sheets[index]?.naturalHeight ?? 0) - height) <= 2
        ? (sheets[index]?.naturalHeight ?? 0)
        : height;
    }),
  );

  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('.pdf-print-root')).toHaveCount(0);
  expect((await revokedUrls(page)).length).toBe(3);
});

test('a typed range prints exactly those pages; Enter in the field prints; unreadable and empty ranges are refused', async ({
  page,
}) => {
  await spyOnPrint(page);
  await openPdf(page, 'print.pdf', await shapedPdf());
  const panel = await openPrint(page);
  await panel.getByRole('radio', { name: 'Range' }).check();
  const field = panel.getByRole('textbox', { name: 'Page range' });
  await expect(field).toBeFocused();

  await field.fill('abc');
  await printButton(page).click();
  await expect(panel.getByRole('alert')).toHaveText('Could not read the range: abc');
  await expect(notice(page, 'Could not read the range: abc')).toBeVisible();
  // Typing again clears the refusal.
  await field.fill(' , ');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await printButton(page).click();
  await expect(panel.getByRole('alert')).toHaveText('No pages in the selected range.');
  await expect(notice(page, 'No pages in the selected range.')).toBeVisible();
  expect(await printedJobs(page)).toEqual([]);

  // Pages 3 and 1, whatever the order they were typed in: printed in page order. Enter starts it.
  await field.fill('3; 1');
  await field.press('Enter');
  const sheets = await onlyJob(page);
  expect(sheets.map(shapeOf)).toEqual(['portrait', 'square']);
  await expect(dialog(page)).toBeHidden();

  // A number past the end is the last page, as the field's placeholder promises for a range.
  const again = await openPrint(page);
  await again.getByRole('radio', { name: 'Range' }).check();
  await again.getByRole('textbox', { name: 'Page range' }).fill('2-99');
  await printButton(page).click();
  await expect.poll(async () => (await printedJobs(page)).length).toBe(2);
  expect(((await printedJobs(page))[1] ?? []).map(shapeOf)).toEqual(['landscape', 'square']);
});

test('Current view prints the page in view, and choosing another choice clears a refusal', async ({
  page,
}) => {
  await spyOnPrint(page);
  await openPdf(page, 'print.pdf', await shapedPdf());
  const pageNumber = page.getByRole('textbox', { name: 'Page number' });
  await pageNumber.fill('3');
  await pageNumber.press('Enter');
  await expect(pageNumber).toHaveValue('3');
  const panel = await openPrint(page);
  await panel.getByRole('radio', { name: 'Range' }).check();
  await panel.getByRole('textbox', { name: 'Page range' }).fill('x');
  await printButton(page).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await panel.getByRole('radio', { name: 'Current view' }).check();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await printButton(page).click();
  const sheets = await onlyJob(page);
  expect(sheets.length).toBeGreaterThanOrEqual(1);
  expect(sheets.map(shapeOf)).toContain('square');
  expect(sheets.map(shapeOf)).not.toContain('portrait');
});

test('Actual size pins each page at its own size, Shrink only reduces what is larger than the sheet', async ({
  page,
}) => {
  await spyOnPrint(page);
  await openPdf(page, 'print.pdf', await shapedPdf());
  let panel = await openPrint(page);
  await panel.getByRole('radio', { name: 'Actual size' }).check();
  await printButton(page).click();
  // 100 % is 4/3 CSS pixel per point.
  expect((await onlyJob(page)).map((sheet) => [sheet.styleWidth, sheet.styleHeight])).toEqual([
    ['793px', '1123px'],
    ['1123px', '793px'],
    ['667px', '667px'],
  ]);

  panel = await openPrint(page);
  await panel.getByRole('radio', { name: 'Shrink oversized pages' }).check();
  await printButton(page).click();
  await expect.poll(async () => (await printedJobs(page)).length).toBe(2);
  const second = (await printedJobs(page))[1] ?? [];
  // The landscape page does not fit an A4 width and is brought down to it; the others keep their own size.
  expect(second.map((sheet) => [sheet.styleWidth, sheet.styleHeight])).toEqual([
    ['793px', '1123px'],
    ['794px', '561px'],
    ['667px', '667px'],
  ]);
});

test('Cancel closes the dialog without printing, and so does Escape', async ({ page }) => {
  await spyOnPrint(page);
  await openPdf(page, 'print.pdf', await shapedPdf());
  await openPrint(page);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await openPrint(page);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  expect(await printedJobs(page)).toEqual([]);
  await expect(page.locator('.pdf-print-root')).toHaveCount(0);
});

test('Cancel while the pages are being prepared stops the job: nothing is printed and no sheet is left behind', async ({
  page,
}) => {
  await spyOnPrint(page);
  await openPdf(page, 'many.pdf', labelledPdf('Many', 60));
  const panel = await openPrint(page);
  await printButton(page).click();
  await expect(panel.getByRole('status')).toContainText(/^Preparing pages: \d+\/60$/);
  // Neither the button nor Escape can start or end a half-prepared job twice.
  await expect(printButton(page)).toBeDisabled();
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await page.waitForTimeout(1500);
  expect(await printedJobs(page)).toEqual([]);
  await expect(page.locator('.pdf-print-root')).toHaveCount(0);
});

test('Generate Printable PDF: N-up puts several pages on a sheet and opens the file as a new tab', async ({
  page,
}) => {
  await openPdf(page, 'print.pdf', labelledPdf('Print', 3));
  const panel = await openPrint(page);
  await expect(panel.getByRole('button', { name: 'Generate Printable PDF' })).toBeEnabled();
  await panel.getByRole('radio', { name: '2', exact: true }).check();
  await panel.getByRole('button', { name: 'Generate Printable PDF' }).click();
  await expect(notice(page, 'Print file ready: print.pdf')).toBeVisible({ timeout: 60_000 });
  await expect(dialog(page)).toBeHidden();
  const texts = (await readProducedPageTexts(await exportBytes(page, 'two-up.pdf'))).map((text) =>
    text.trim(),
  );
  expect(texts).toHaveLength(2);
  expect(texts[0]).toContain('Print 1');
  expect(texts[0]).toContain('Print 2');
  expect(texts[1]).toContain('Print 3');
});

test('Generate Printable PDF: the file is a new A4 tab beside the source, which is left as it was, and the shell is free again', async ({
  page,
}) => {
  await openPdf(page, 'source.pdf', labelledPdf('Source', 3));
  const panel = await openPrint(page);
  await panel.getByRole('radio', { name: '2', exact: true }).check();
  await panel.getByRole('button', { name: 'Generate Printable PDF' }).click();
  await expect(notice(page, 'Print file ready: print.pdf')).toBeVisible({ timeout: 60_000 });
  await expect(dialog(page)).toBeHidden();

  // The file is the document on screen: two sheets, its own name in the tab list, the source beside it.
  await expect(page.getByText('/ 2', { exact: true })).toBeVisible({ timeout: 30_000 });
  const produced = await exportBytes(page, 'two-up.pdf');
  expect((await readProducedPdf(produced)).pageCount).toBe(2);
  // A4 portrait (595 × 842 pt), the sheet the dialog imposes on unless it is told otherwise.
  for (const index of [0, 1]) {
    const [left = 0, bottom = 0, right = 0, top = 0, ...rest] =
      (await readProducedEntry(produced, index, 'MediaBox')).match(/[\d.]+/g)?.map(Number) ?? [];
    expect(rest).toEqual([]);
    expect(right - left).toBeCloseTo(595.28, 0);
    expect(top - bottom).toBeCloseTo(841.89, 0);
  }
  const texts = (await readProducedPageTexts(produced)).map((text) => text.trim());
  expect(texts[0]).toContain('Source 1');
  expect(texts[0]).toContain('Source 2');
  expect(texts[1]).toContain('Source 3');

  // Two documents are open now; the file is a document of its own, not a step on the source.
  await page
    .getByRole('button', { name: /^print\.pdf/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Close tab' })).toHaveCount(2);
  await page
    .getByRole('button', { name: /^source\.pdf/ })
    .first()
    .click();
  await expect(page.getByText('/ 3', { exact: true })).toBeVisible({ timeout: 30_000 });
  const source = await exportBytes(page, 'source-after.pdf');
  expect((await readProducedPdf(source)).pageCount).toBe(3);
  expect((await readProducedPageTexts(source)).map((text) => text.trim())).toEqual([
    expect.stringContaining('Source 1'),
    expect.stringContaining('Source 2'),
    expect.stringContaining('Source 3'),
  ]);

  // Nothing is left running: the dialog opens again on the source and offers the file again.
  await openPrint(page);
  await expect(dialog(page).getByRole('button', { name: 'Generate Printable PDF' })).toBeEnabled();
});

test('Generate Printable PDF: a booklet is a signature — four pages to a sheet, ordered front and back', async ({
  page,
}) => {
  await openPdf(page, 'book.pdf', labelledPdf('Book', 4));
  const panel = await openPrint(page);
  await panel.getByRole('checkbox', { name: 'Booklet (imposition)' }).check();
  // A signature replaces the grid choice.
  await expect(panel.getByRole('radio', { name: '2', exact: true })).toHaveCount(0);
  // A signature is printed on both sides of the sheet: one-sided is refused and says so.
  await panel.getByRole('button', { name: 'Generate Printable PDF' }).click();
  await expect(panel.getByRole('alert')).toContainText('This feature is not available for this document.');
  await expect(dialog(page)).toBeVisible();
  await expect(notice(page, 'Print file ready: print.pdf')).toHaveCount(0);

  await panel.getByRole('combobox', { name: 'Two-sided (duplex)' }).click();
  await page.getByRole('option', { name: 'Flip on long edge' }).click();
  await panel.getByRole('button', { name: 'Generate Printable PDF' }).click();
  await expect(notice(page, 'Print file ready: print.pdf')).toBeVisible({ timeout: 60_000 });
  const texts = (await readProducedPageTexts(await exportBytes(page, 'booklet.pdf'))).map((text) =>
    text.trim(),
  );
  expect(texts).toHaveLength(2);
  expect(texts[0]).toContain('Book 4');
  expect(texts[0]).toContain('Book 1');
  expect(texts[1]).toContain('Book 2');
  expect(texts[1]).toContain('Book 3');
});

test('a page that cannot be drawn stops the job with its number, leaves no sheet behind, and the next try prints', async ({
  page,
}) => {
  await spyOnPrint(page);
  // The browser's PNG encoder fails once, on the second page of the job: a canvas it cannot read back.
  await page.addInitScript(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    let calls = 0;
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type, quality) {
      if (type === 'image/png' && Reflect.get(window, 'failSecondSheet') === true) {
        calls += 1;
        if (calls === 2) {
          callback(null);
          return;
        }
      }
      encode.call(this, callback, type, quality);
    };
  });
  await openPdf(page, 'print.pdf', await shapedPdf());
  const panel = await openPrint(page);
  await page.evaluate(() => Reflect.set(window, 'failSecondSheet', true));
  await printButton(page).click();
  await expect(panel.getByRole('alert')).toHaveText('Could not read the range: 2');
  expect(await printedJobs(page)).toEqual([]);
  await expect(page.locator('.pdf-print-root')).toHaveCount(0);
  await expect(printButton(page)).toBeEnabled();

  await page.evaluate(() => Reflect.set(window, 'failSecondSheet', false));
  await printButton(page).click();
  const sheets = await onlyJob(page);
  expect(sheets.map(shapeOf)).toEqual(['portrait', 'landscape', 'square']);
});
