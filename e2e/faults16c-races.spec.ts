/**
 * A removal, a move or a produced file that is still waiting on pdf.js to open the version it
 * made (the open held at `GetDocRequest`, `engine-faults.ts`) when the user goes elsewhere:
 * the answer must not be written onto the document the user left, and the shell must be free
 * again once the held open finishes.
 */

import { readFileSync } from 'node:fs';
import type { Page } from 'playwright/test';
import { menu, notice, openApp, recordNotices } from './app-helpers';
import { holdNext, injectEngineFaults } from './engine-faults';
import { expect, test } from './test';
import { labelledPdf, readProducedPdf, toolFixturePdf } from './tool-fixture';
import { exportBytes } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

/** Open `a.pdf` (marks) and `b.pdf`, with `b.pdf` in front. */
async function twoDocuments(page: Page): Promise<void> {
  await injectEngineFaults(page);
  await openApp(page, 'a.pdf', toolFixturePdf());
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await openApp(page, 'b.pdf', labelledPdf('Second', 1), { navigate: false });
  await expect(page.getByRole('button', { name: 'b.pdf', exact: true })).toBeVisible();
}

async function switchTo(page: Page, from: string, to: string): Promise<void> {
  await page.getByRole('button', { name: from, exact: true }).first().click();
  await page.getByRole('button', { name: to, exact: true }).click();
  await expect(page.getByRole('button', { name: to, exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: to, exact: true })).toHaveAttribute('aria-expanded', 'false');
}

/**
 * Export the document in front the moment the shell takes it. An export is refused while an
 * operation runs, with a line that is up before the press returns, so a press that comes too
 * early is repeated; the download that follows is the proof that nothing was running any more.
 */
async function exportWhenFree(page: Page, name: string): Promise<Uint8Array> {
  const refusal = notice(page, 'Another operation is running — wait for it to complete.');
  const download = page.waitForEvent('download', { timeout: 120_000 });
  download.catch(() => undefined);
  await expect(async () => {
    await refusal
      .getByRole('button', { name: 'Close' })
      .click({ timeout: 500 })
      .catch(() => undefined);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    // A refusal is the press's own state update: once two frames have been drawn it is on screen
    // if it is coming, so "no refusal" is read after the render and not within a guessed window.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(refusal).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 120_000 });
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return new Uint8Array(readFileSync(path));
}

test('marks deleted from a document the user leaves while its new version is still opening are not removed from it', async ({
  page,
}) => {
  await twoDocuments(page);
  await switchTo(page, 'b.pdf', 'a.pdf');
  const before = await readProducedPdf(await exportBytes(page, 'before.pdf'));
  const marks = before.annotations.filter((item) => ['Highlight', 'Ink', 'FreeText'].includes(item.subtype));
  expect(marks.length).toBeGreaterThan(0);

  // Wait until the file's marks are listed, as the command only answers then.
  await expect(async () => {
    await menu(page, 'Edit', 'Select all marks');
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /^Delete(?! page)/ })).toBeEnabled({ timeout: 1_500 });
    await page.keyboard.press('Escape');
  }).toPass({ timeout: 60_000 });

  const noticesSeen = await recordNotices(page);
  const release = await holdNext(page, 'pdfjs', 'GetDocRequest');
  await page.keyboard.press('Delete');
  await release.reached();
  await switchTo(page, 'a.pdf', 'b.pdf');
  await release();

  // The other document is untouched, and the one that was left still has every mark. An export
  // is refused while an operation runs, so its download is the proof that the held open has
  // finished — and a removal reported for the left document would have been reported by then.
  await switchTo(page, 'b.pdf', 'a.pdf');
  const after = await readProducedPdf(await exportWhenFree(page, 'after.pdf'));
  expect(after.annotations.map((item) => item.subtype)).toEqual(
    before.annotations.map((item) => item.subtype),
  );
  expect((await noticesSeen()).filter((line) => /mark\(s\) removed\./.test(line))).toEqual([]);

  // The shell is free again: the same gesture now removes them, links included.
  await expect(async () => {
    await menu(page, 'Edit', 'Select all marks');
    await menu(page, 'Edit', /^Delete(?! page)/);
    await expect(notice(page, /mark\(s\) removed\./)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  const removed = await readProducedPdf(await exportBytes(page, 'removed.pdf'));
  expect(removed.annotations.map((item) => item.subtype)).toEqual(['Widget']);
});
