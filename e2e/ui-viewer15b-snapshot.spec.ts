/**
 * The snapshot panel when the browser's PNG encoder gives nothing back: the reader gets the
 * shell's own notice, the panel closes, and nothing is offered for download.
 */

import { notice } from './app-helpers';
import { expect, test } from './test';
import { menuItem, openPdf } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('a snapshot the encoder cannot produce is reported in the notice line and the panel closes', async ({
  page,
}) => {
  await openPdf(page);
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
      callback(null);
    };
  });
  await menuItem(page, 'View', 'Snapshot');
  await expect(notice(page, 'Something unexpected went wrong.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: 'Snapshot' })).toHaveCount(0);
});
