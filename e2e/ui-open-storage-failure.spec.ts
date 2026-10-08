/**
 * A document that opened is open, whatever happens to the copy kept for recovery.
 *
 * Both ways of opening register the tab first and only then write the recovery copy (the
 * source blob in the browser's storage). When that write rejects — storage full, OPFS
 * unavailable — the document must stay open and usable, there must be exactly one tab, and
 * the user is told what is true: the recovery copy could not be stored. It used to be
 * reported as an open failure ("The document looks damaged." for a file, "Something
 * unexpected went wrong." for a converted picture) while the tab was in fact open, so a retry
 * opened a second one.
 *
 * The failure is injected where the application writes: `createWritable` of an OPFS file
 * handle rejects with the `QuotaExceededError` a full origin raises. It is armed by the test
 * and spent by the first write of a source blob (a `.pdf` entry), so the later automatic
 * draft save runs against a working store and cannot replace the notice under test.
 */

import type { Page } from 'playwright/test';
import { injectEngineFaults, requestCount } from './engine-faults';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { CANVAS, encodePng, openPdf } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });

const SENTENCE =
  'This document is open, but its recovery copy could not be stored: unsaved changes would not survive a closed tab or a crash. Browser storage is full.';

/** Make the next write of a `.pdf` file in the origin-private file system fail as a full store does. */
async function failNextSourceWrite(page: Page): Promise<void> {
  await page.evaluate(() => {
    let armed = true;
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function createWritable(
      this: FileSystemFileHandle,
      ...args: Parameters<FileSystemFileHandle['createWritable']>
    ) {
      if (armed && this.name.endsWith('.pdf')) {
        armed = false;
        return Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
      }
      return original.apply(this, args);
    };
  });
}

const notices = (page: Page) => page.locator('[role="status"]');

/** How many documents the switcher says are open. */
async function openDocuments(page: Page): Promise<number> {
  await page
    .getByRole('button', { name: /^[^\s].*\.pdf/ })
    .first()
    .click();
  const heading = page.getByText(/^Open documents \(\d+\)$/);
  await expect(heading).toBeVisible();
  const count = Number(/\((\d+)\)/.exec((await heading.textContent()) ?? '')?.[1]);
  await page.keyboard.press('Escape');
  return count;
}

test('a file whose recovery copy cannot be stored still opens, once, with the storage said', async ({
  page,
}) => {
  await page.goto('/editor/');
  await failNextSourceWrite(page);
  await openPdf(page, 'kept.pdf', labelledPdf('Kept', 3), { navigate: false, advanced: false });

  await expect(page.locator(CANVAS).first()).toBeVisible();
  await expect(page.getByText('/ 3', { exact: true })).toBeVisible();
  await expect(notices(page).filter({ hasText: SENTENCE })).toBeVisible();
  await expect(notices(page).filter({ hasText: /damaged|unexpected/i })).toHaveCount(0);
  expect(await openDocuments(page)).toBe(1);
});

test('a picture converted to a tab whose recovery copy cannot be stored is opened and done, with the storage said', async ({
  page,
}) => {
  await page.goto('/editor/');
  await failNextSourceWrite(page);
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: encodePng(200, 100, () => [20, 120, 220]),
    });

  await expect(page.getByRole('button', { name: /^photo\.pdf/ }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('/ 1', { exact: true })).toBeVisible();
  const line = notices(page).filter({ hasText: SENTENCE });
  await expect(line).toBeVisible();
  // The operation is reported as done, in the same line: the warning does not replace it.
  await expect(line).toContainText('The image was opened as a PDF page in a new tab.');
  await expect(
    notices(page).filter({ hasText: /damaged|unexpected|could not be (read|opened)/i }),
  ).toHaveCount(0);
  expect(await openDocuments(page)).toBe(1);
});

/** Make the next SHA-256 the page computes reject, as a hashing the browser cannot do would. */
async function failNextDigest(page: Page): Promise<void> {
  await page.evaluate(() => {
    let armed = true;
    const original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...args: Parameters<SubtleCrypto['digest']>) => {
      if (!armed) return original(...args);
      armed = false;
      return Promise.reject(new DOMException('The operation failed.', 'OperationError'));
    };
  });
}

/**
 * A document is opened and fingerprinted side by side. When the fingerprint fails after the
 * engine opened the document, the engine's handle (a pdf.js worker and its parsed document) is
 * nobody's any more and must be released: pdf.js answers `destroy()` with one `Terminate`
 * request, which is what the fault table counts.
 */
test('a fingerprint that fails after the engine opened the file releases the engine handle', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await page.goto('/editor/');
  await failNextDigest(page);
  const before = await requestCount(page, 'Terminate');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({
      name: 'unhashed.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(labelledPdf('Unhashed', 2)),
    });

  // Nothing opened: the failure is an open failure, with no tab registered.
  await expect(notices(page).filter({ hasText: 'The document looks damaged.' })).toBeVisible();
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect.poll(() => requestCount(page, 'Terminate')).toBeGreaterThan(before);
});

test('the same for a produced document: nothing opens and the engine handle is released', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await page.goto('/editor/');
  await failNextDigest(page);
  const before = await requestCount(page, 'Terminate');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: encodePng(200, 100, () => [20, 120, 220]),
    });

  await expect.poll(() => requestCount(page, 'Terminate')).toBeGreaterThan(before);
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^photo\.pdf/ })).toHaveCount(0);
});
