import { readFileSync } from 'node:fs';
import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { reviewHeading, runForm } from './ui-helpers';

/**
 * Repair PDF: a file that was cut off before its cross-reference table is rebuilt into a clean
 * copy that opens in a new tab, and a file that cannot be opened at all points to the tool.
 */

// MuPDF reports a repair on the console while it rebuilds the table; that is the repair working.
test.use({
  viewport: { width: 1440, height: 900 },
  allowedErrors: [
    /console: (format error: cannot find startxref|warning: (trying to repair broken xref|repairing PDF document))/,
  ],
});

/** `labelledPdf` cut off right before its cross-reference table: the objects are all there, the table is gone. */
function cutOff(): Uint8Array {
  const whole = labelledPdf('Sheet', 3);
  const text = new TextDecoder('latin1').decode(whole);
  return whole.slice(0, text.indexOf('xref\n'));
}

test('repair: a file with no cross-reference table becomes a clean copy that opens in a new tab', async ({
  page,
}) => {
  await page.goto('/editor/');
  await page.getByRole('tab', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: /^Repair PDF/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Repair PDF' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'cutoff.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(cutOff()),
  });

  // The repair says what it did and what it cannot promise, so the result is read before it opens.
  expect(await runForm(dialog, 'Open in new tab')).toBe('review');
  await expect(reviewHeading(dialog)).toBeVisible();
  await expect(
    dialog.getByText('The file was damaged; its structure was rebuilt from the objects found in it.'),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      'Check the pages: content that could not be read from the damaged file cannot be restored.',
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Open in new tab' }).click();
  await expect(
    page.getByRole('button', { name: 'cutoff-repaired.pdf Unsaved changes', exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });

  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = test.info().outputPath('repaired.pdf');
  await (await download).saveAs(path);
  const bytes = new Uint8Array(readFileSync(path));
  const texts = await readProducedPageTexts(bytes);
  expect(texts.map((text) => text.trim())).toEqual(['Sheet 1', 'Sheet 2', 'Sheet 3']);
  // The copy carries a table of its own now, and its startxref points at it.
  const source = new TextDecoder('latin1').decode(bytes);
  const offset = Number(/startxref\s+(\d+)/.exec(source)?.[1]);
  expect(source.slice(offset, offset + 4)).toMatch(/^(xref|\d+ 0)/);
});

test('a file that cannot be opened points to Repair PDF', async ({ page }) => {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({
      name: 'bad.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('this is not a pdf at all'),
    });
  await expect(
    page.locator('[role="status"]').filter({ hasText: 'The document looks damaged' }),
  ).toContainText('Try “Repair PDF” in the File menu.', { timeout: 30_000 });
});
