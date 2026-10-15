/**
 * Straightening scanned pages, from the Page menu to the bytes. The scan is generated in the
 * test: three pages that are only a picture (no text layer), the first of text tilted by a
 * known angle, the second level, the third blank. What the specs read is the file the editor
 * exports, measured again with the same search that measured the input.
 */

import { renderPage, scanDocument, tiltedText } from '../packages/pdf-core/src/ops/deskew.fixtures';
import { detectSkew } from '../packages/pdf-core/src/ops/ocr-preprocess';
import { expect, test } from './test';
import { exportBytes, menuItem, openDockTab, openPdf, runForm } from './ui-helpers';

const TILT = 4.2;

const scan = () =>
  scanDocument([{ content: tiltedText(TILT), noise: 15 }, { content: tiltedText(0) }, { content: '' }]);

const sameRender = (left: { data: Uint8Array }, right: { data: Uint8Array }) =>
  Buffer.compare(left.data, right.data) === 0;

test('straightens the crooked page of a scan, reports each page, and Undo brings the scan back', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const input = await scan();
  await openPdf(page, 'scan.pdf', input);

  await menuItem(page, 'Page', /Straighten pages/);
  const form = page.getByRole('region', { name: 'Straighten pages', exact: true });
  await expect(form).toBeVisible();

  // A blank page cannot be measured, so the result is read before it is applied.
  expect(await runForm(form)).toBe('review');
  const tilt = form.getByText(/^Page 1: \d\.\d° of tilt removed\.$/);
  await expect(tilt).toBeVisible();
  const removed = Number(/(\d\.\d)°/.exec((await tilt.textContent()) ?? '')?.[1]);
  expect(Math.abs(removed - TILT)).toBeLessThanOrEqual(0.15);
  await expect(form.getByText('Page 2 is already straight; left as it was.')).toBeVisible();
  await expect(form.getByText('Page 3 skipped: no clear text lines.')).toBeVisible();
  await expect(form.getByText(/^Scans were not re-encoded/)).toBeVisible();
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
  await expect(page.getByText(/^1 page\(s\) straightened\./)).toBeVisible();

  const straight = await exportBytes(page, 'straight.pdf');
  expect(Math.abs(detectSkew(await renderPage(input, 0)).angle - TILT)).toBeLessThanOrEqual(0.15);
  expect(Math.abs(detectSkew(await renderPage(straight, 0)).angle)).toBeLessThanOrEqual(0.15);
  // The pages it did not turn are the pages it was given.
  for (const pageIndex of [1, 2]) {
    expect(sameRender(await renderPage(straight, pageIndex), await renderPage(input, pageIndex))).toBe(true);
  }

  await openDockTab(page, 'History');
  await expect(page.getByText('1 step(s) can be undone · 0 step(s) can be redone')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undone = await exportBytes(page, 'undone.pdf');
  expect(sameRender(await renderPage(undone, 0), await renderPage(input, 0))).toBe(true);
  expect(Math.abs(detectSkew(await renderPage(undone, 0)).angle - TILT)).toBeLessThanOrEqual(0.15);
});

test('a scan with nothing to straighten says why, page by page, and records no step', async ({ page }) => {
  const input = await scanDocument([{ content: tiltedText(0) }, { content: '' }]);
  await openPdf(page, 'level.pdf', input);

  await menuItem(page, 'Page', /Straighten pages/);
  const form = page.getByRole('region', { name: 'Straighten pages', exact: true });
  await expect(form).toBeVisible();
  expect(await runForm(form)).toBe('review');
  await expect(form.getByText('Page 1 is already straight; left as it was.')).toBeVisible();
  await expect(form.getByText('Page 2 skipped: no clear text lines.')).toBeVisible();
  await expect(
    form.getByText('There is nothing to straighten on the selected pages; no file was written.'),
  ).toBeVisible();

  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
  // Nothing was applied, so there is nothing to undo.
  await openDockTab(page, 'History');
  await expect(page.getByText('0 step(s) can be undone · 0 step(s) can be redone')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
