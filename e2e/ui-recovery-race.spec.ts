/**
 * Startup recovery brings the drafts of the last session back as tabs, while the user may
 * already be opening a document of their own. A restored tab must wait behind the document the
 * user opened: the one in front stays the one they chose, so what they place on it and export
 * is theirs and not a document from the session before.
 *
 * The overlap is made certain by holding recovery on its read of the browser's file-handle
 * store (`recent-handles-gate.ts`) while the second document opens.
 */

import { notice, openApp, rotateCurrentPage } from './app-helpers';
import { holdRecentHandlesOnNextLoad } from './recent-handles-gate';
import { expect, test } from './test';
import { labelledPdf, readProducedPdf } from './tool-fixture';
import { exportBytes } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

test('a draft restored while the user opens a document does not take the front from it', async ({ page }) => {
  const gate = await holdRecentHandlesOnNextLoad(page);
  await openApp(page, 'first.pdf', labelledPdf('First', 2), { advanced: false });
  await rotateCurrentPage(page);
  // The draft is written after a short pause: wait for the manifest that records the rotation.
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

  await gate.arm();
  await page.reload();
  await gate.reached();

  // Recovery is waiting; the user opens a document now.
  await openApp(page, 'second.pdf', labelledPdf('Second', 1), { advanced: false, navigate: false });
  await gate.release();
  await expect(notice(page, 'draft(s) restored')).toBeVisible({ timeout: 30_000 });

  // Both are open, and the one in front is the one the user opened.
  await expect(page.getByRole('button', { name: /^second\.pdf/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^first\.pdf/ })).toHaveCount(0);
  expect((await readProducedPdf(await exportBytes(page, 'second.pdf'))).pageCount).toBe(1);
});
