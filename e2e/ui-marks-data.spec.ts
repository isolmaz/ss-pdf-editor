/**
 * The review as a file of its own: XFDF and FDF leave from the Comments panel and come back
 * into a fresh copy of the document, with their replies and review states, at the page place
 * they were written; an unreadable file is refused in words.
 */

import type { Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { clickPage, openDockTab, openPdf, rail } from './ui-helpers';
import { expectNear } from './ui-layers-helpers';
import { download, exported } from './ui-marks-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const rows = (page: Page) => page.locator('ul[aria-label="Comments"] > li');

/** A note at a page point, with its comment text. */
async function addNote(page: Page, comment: string, x: number, y: number) {
  await rail(page, 'Add comment / Note').click();
  await clickPage(page, x, y);
  const row = rows(page).filter({ hasText: 'unsaved' }).filter({ hasText: 'No comment' }).first();
  await row.getByRole('button', { name: 'Edit comment' }).click();
  const body = page.getByLabel('Comment text').first();
  await body.fill(comment);
  await body.blur();
  const done = rows(page).filter({ hasText: comment });
  await expect(done).toBeVisible();
  return done;
}

test('XFDF carries the file’s own comments and the session’s note with its reply and status, and a fresh copy gets them back', async ({
  page,
}) => {
  await openPdf(page, 'review.pdf');
  await openDockTab(page, 'Comments');
  const row = await addNote(page, 'Check the total', 250, 300);
  await row.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByLabel('Your reply').fill('Total confirmed');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(row.getByRole('list', { name: '1 replies' })).toContainText('Total confirmed');
  await row.getByLabel('Review status').selectOption('Rejected');
  await expect(row.getByLabel('Review status')).toHaveValue('Rejected');

  const xfdf = await download(
    page,
    page.getByRole('button', { name: 'Export comments as XFDF' }),
    'review.xfdf',
  );
  expect(xfdf.name).toBe('review-comments.xfdf');
  expect(xfdf.text.trimStart().startsWith('<?xml')).toBe(true);
  expect(xfdf.text).toContain('Check the total');
  expect(xfdf.text).toContain('Total confirmed');
  expect(xfdf.text).toContain('Saved highlight over line one');
  await expect(
    notice(page, /comments exported as XFDF with their replies: review-comments\.xfdf/),
  ).toBeVisible();

  // A fresh copy has none of the session's note until the XFDF is imported.
  await openPdf(page, 'copy.pdf', undefined, { navigate: false, advanced: false });
  await openDockTab(page, 'Comments');
  await expect(page.getByText('Check the total')).toHaveCount(0);
  await page.locator('input[type="file"][accept*=".xfdf"]').setInputFiles(xfdf.path);
  await expect(notice(page, /comments imported\./)).toBeVisible({ timeout: 30_000 });
  await expect(notice(page, /replies and review states were attached to their comments\./)).toBeVisible();
  const imported = rows(page).filter({ hasText: 'Check the total' });
  await expect(imported.first()).toContainText('unsaved');
  await expect(imported.first().getByRole('list', { name: '1 replies' })).toContainText('Total confirmed');
  await expect(imported.first().getByLabel('Review status')).toHaveValue('Rejected');
});

test('FDF imported into a fresh copy puts the note back at its page place, and the saved file holds it there', async ({
  page,
}) => {
  await openPdf(page, 'review.pdf');
  await openDockTab(page, 'Comments');
  await addNote(page, 'Moves with the file', 200, 250);
  const fdf = await download(
    page,
    page.getByRole('button', { name: 'Export comments as FDF' }),
    'review.fdf',
  );
  expect(fdf.text).toContain('%FDF');

  await openPdf(page, 'copy.pdf', undefined, { navigate: false, advanced: false });
  await openDockTab(page, 'Comments');
  await page.locator('input[type="file"][accept*=".xfdf"]').setInputFiles(fdf.path);
  await expect(notice(page, '1 comments imported.')).toBeVisible({ timeout: 30_000 });
  await expect(rows(page).filter({ hasText: 'Moves with the file' })).toContainText('unsaved');

  const notes = (await exported(page, 'copy-out.pdf', 'Text')).filter(
    (annotation) => annotation.contents === 'Moves with the file',
  );
  expect(notes).toHaveLength(1);
  // The note icon is centred where the user clicked: the file's own page space, y up.
  const rect = notes[0]?.rect ?? [];
  expectNear(((rect[0] ?? 0) + (rect[2] ?? 0)) / 2, 200, 3);
  expectNear(((rect[1] ?? 0) + (rect[3] ?? 0)) / 2, 250, 3);
});

test('a file that is neither JSON, FDF nor XFDF is refused with its reason and adds no comment', async ({
  page,
}) => {
  await openPdf(page, 'review.pdf');
  await openDockTab(page, 'Comments');
  await expect(rows(page)).toHaveCount(5);
  const before = 5;
  const input = page.locator('input[type="file"][accept*=".xfdf"]');
  await input.setInputFiles({
    name: 'notes.json',
    mimeType: 'application/json',
    buffer: Buffer.from('this is not a review'),
  });
  await expect(notice(page, 'This file format is not supported. Pick a PDF file.')).toBeVisible({
    timeout: 30_000,
  });
  expect(await rows(page).count()).toBe(before);

  // An XML file that is not an XFDF is refused the same way.
  await input.setInputFiles({
    name: 'notes.xfdf',
    mimeType: 'application/vnd.adobe.xfdf',
    buffer: Buffer.from('<?xml version="1.0"?><html><body>no comments</body></html>'),
  });
  await expect(notice(page, 'This file format is not supported. Pick a PDF file.')).toBeVisible({
    timeout: 30_000,
  });
  expect(await rows(page).count()).toBe(before);
});
