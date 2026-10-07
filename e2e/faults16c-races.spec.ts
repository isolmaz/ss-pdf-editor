/**
 * A removal, a move or a produced file that is still waiting on pdf.js to open the version it
 * made (the open held at `GetDocRequest`, `engine-faults.ts`) when the user goes elsewhere:
 * the answer must not be written onto the document the user left, and the shell must be free
 * again once the held open finishes.
 */

import type { Page } from 'playwright/test';
import { menu, notice, openApp } from './app-helpers';
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

  const release = await holdNext(page, 'pdfjs', 'GetDocRequest');
  await page.keyboard.press('Delete');
  await release.reached();
  await switchTo(page, 'a.pdf', 'b.pdf');
  await release();

  await page.waitForTimeout(1_000);
  await expect(notice(page, /mark\(s\) removed\./)).toHaveCount(0);
  // The other document is untouched, and the one that was left still has every mark.
  await switchTo(page, 'b.pdf', 'a.pdf');
  const after = await readProducedPdf(await exportBytes(page, 'after.pdf'));
  expect(after.annotations.map((item) => item.subtype)).toEqual(
    before.annotations.map((item) => item.subtype),
  );

  // The shell is free again: the same gesture now removes them, links included.
  await expect(async () => {
    await menu(page, 'Edit', 'Select all marks');
    await menu(page, 'Edit', /^Delete(?! page)/);
    await expect(notice(page, /mark\(s\) removed\./)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  const removed = await readProducedPdf(await exportBytes(page, 'removed.pdf'));
  expect(removed.annotations.map((item) => item.subtype)).toEqual(['Widget']);
});
