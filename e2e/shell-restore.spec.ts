import type { Page } from 'playwright/test';
import { exportBytes, notice, openApp, recordNotices, rotateCurrentPage } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry } from './tool-fixture';

/**
 * What a reload brings back: the document with its unsaved edit, and the undo history the draft
 * carried. The draft keeps the journal and every snapshot on the desktop tier; the smaller tier
 * (a phone: it is read from the user agent) keeps the working version and no journal, so its
 * restore must say that earlier steps cannot be undone instead of promising a history.
 */

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

const MOBILE_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

/** Rotate the page, wait for the autosave that records it, and reload onto the stored draft. */
async function editAndReload(page: Page, name: string): Promise<void> {
  await openApp(page, name, labelledPdf('Report', 2), { advanced: false });
  await rotateCurrentPage(page);
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const drafts = await (
          await (await root.getDirectoryHandle('pdf-editor')).getDirectoryHandle('drafts')
        ).entries();
        for await (const [, entry] of drafts) {
          if (entry.kind !== 'file') continue;
          const text = await (await (entry as FileSystemFileHandle).getFile()).text();
          if (text.includes('"dirty":true')) return true;
        }
        return false;
      }),
    )
    .toBe(true);
  await page.reload();
}

test('a reload brings the edit back with its history, and one undo leads back to the original', async ({
  page,
}) => {
  await editAndReload(page, 'report.pdf');
  await expect(
    notice(page, '1 draft(s) restored; the document and its change journal are ready.'),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Back to document (report.pdf)' }).click();

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByText(/step\(s\) can be undone/)).toHaveText(
    '1 step(s) can be undone · 0 step(s) can be redone',
  );
  expect(await readProducedEntry(await exportBytes(page, 'edited.pdf'), 0, 'Rotate')).toBe('90');

  await page.keyboard.press('Control+z');
  await expect(notice(page, /^Undone: /)).toBeVisible({ timeout: 30_000 });
  expect(await readProducedEntry(await exportBytes(page, 'original.pdf'), 0, 'Rotate')).toBe('');
});

test.describe('on the smaller tier', () => {
  test.use({ userAgent: MOBILE_AGENT });

  test('a reload brings the edit back and says that earlier steps cannot be undone', async ({ page }) => {
    await editAndReload(page, 'phone.pdf');
    await expect(
      notice(
        page,
        '1 draft(s) restored with their unsaved changes; earlier steps cannot be undone for 1 of them.',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Back to document (phone.pdf)' }).click();

    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByText(/step\(s\) can be undone/)).toHaveText(
      '0 step(s) can be undone · 0 step(s) can be redone',
    );
    // There is nothing to undo, so the key does nothing and says nothing: not that a step's data is missing.
    const seen = await recordNotices(page);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(1_000);
    expect((await seen()).filter((line) => line.includes('cannot undo'))).toEqual([]);
    expect(await readProducedEntry(await exportBytes(page, 'edited.pdf'), 0, 'Rotate')).toBe('90');
  });
});
