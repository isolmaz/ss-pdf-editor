/**
 * The document-information panel while the document changes under it: the font list follows
 * the file, and the panel announces the new font count to a screen reader.
 */

import { expect, test } from './test';
import { openDockTab, openPdf, runCommand } from './ui-helpers';
import { runsPdf } from './ui-rest16-helpers';
import { applyOperation } from './ui-viewer15-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

test('undoing a watermark takes its font off the list and the panel announces the new font count', async ({
  page,
}) => {
  await openPdf(page, 'one-font.pdf', runsPdf([{ text: 'Only Helvetica', x: 72, y: 700 }]));
  await openDockTab(page, 'Document information');
  const panel = page.getByRole('region', { name: 'Document information' });
  const fonts = panel
    .getByRole('region', { name: 'Fonts' })
    .getByRole('list', { name: 'Fonts' })
    .getByRole('listitem');
  await expect(fonts).toHaveCount(1);

  await runCommand(page, 'Watermark');
  const form = page.getByRole('region', { name: 'Watermark' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await applyOperation(form);

  // The tools panel took the dock over; the information panel is opened again on the new file.
  await openDockTab(page, 'Document information');
  await expect.poll(() => fonts.count()).toBeGreaterThan(1);

  // Undoing the watermark takes the font away while the panel stays open: the list shrinks
  // and the panel says so.
  await page.keyboard.press('Control+z');
  await expect(fonts).toHaveCount(1);
  await expect(panel.locator('[aria-live="polite"]')).toHaveText('Font list updated: 1');
});
