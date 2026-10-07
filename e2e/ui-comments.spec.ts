/**
 * The comments view of the left dock: the marks of the session and the annotations the file
 * already holds as one list, the filter, selection, editing, replies and review statuses of
 * both kinds, and the review as a file of its own (JSON, FDF, XFDF in and out). Writes to the
 * file are read back from the exported bytes or from the file opened again.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { readProducedPdf, SAVED_MARKS } from './tool-fixture';
import { clickPage, exportBytes, openDockTab, openPdf, rail } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const rows = (page: Page): Locator => page.locator('ul[aria-label="Comments"] > li');
const filter = (page: Page): Locator => page.getByLabel('Filter comment type');
const status = (row: Locator): Locator => row.getByLabel('Review status');

/** Put a note on an empty spot of the page and give it a comment. */
async function addNote(page: Page, comment: string, at: readonly [number, number] = [300, 400]) {
  await rail(page, 'Add comment / Note').click();
  await clickPage(page, at[0], at[1]);
  const row = rows(page).filter({ hasText: 'unsaved' }).filter({ hasText: 'No comment' }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit comment' }).click();
  const body = page.getByLabel('Comment text').first();
  await body.fill(comment);
  await body.blur();
  const done = rows(page).filter({ hasText: comment });
  await expect(done).toBeVisible();
  return done;
}

async function download(page: Page, button: Locator, name: string) {
  const event = page.waitForEvent('download');
  await button.click();
  const file = await event;
  const path = test.info().outputPath(name);
  await file.saveAs(path);
  return { name: file.suggestedFilename(), text: readFileSync(path, 'utf8'), path };
}

test('the file’s own annotations are listed beside the session’s, can be filtered by kind and selected', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Comments');
  await expect(rows(page)).toHaveCount(5);
  await expect(rows(page).filter({ hasText: 'in file' })).toHaveCount(5);
  await expect(page.getByText('5 comment(s) displayed; 0 pending save.')).toBeAttached();
  await expect(rows(page).filter({ hasText: SAVED_MARKS.highlight.contents })).toContainText('Highlight');
  await expect(rows(page).filter({ hasText: SAVED_MARKS.sourceNote.contents })).toContainText('Note');

  await filter(page).selectOption('Freehand drawing');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText('Freehand drawing');
  await filter(page).selectOption('Highlight');
  await expect(rows(page)).toHaveCount(2);
  await filter(page).selectOption('Note');
  await expect(rows(page)).toHaveCount(1);
  await filter(page).selectOption('Squiggly');
  await expect(rows(page)).toHaveCount(0);
  // With nothing drawn yet, the empty list says what to do; with marks, that the filter hides them.
  await expect(page.getByText('No comments added yet.', { exact: false })).toBeVisible();
  await filter(page).selectOption('all');
  await expect(rows(page)).toHaveCount(5);

  // A click on a row of the file takes the viewer to its page.
  const second = rows(page).filter({ hasText: 'p. 2' });
  await expect(second).toHaveCount(1);
  await second.getByRole('button').first().click();
  await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');

  // The file's comments are not the session's: nothing to clear, nothing to edit or delete,
  // and JSON/FDF have nothing to export; XFDF carries the file's own comments.
  await expect(page.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  await expect(rows(page).first().getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
  await expect(rows(page).first().getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export comments as JSON' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export comments as FDF' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export comments as XFDF' })).toBeEnabled();
});

test('a session note is edited, answered, given a status, deleted and cleared; the filter says when it hides everything', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Comments');
  const row = await addNote(page, 'Check this figure');
  await expect(row).toContainText('unsaved');
  await expect(page.getByText('6 comment(s) displayed; 1 pending save.')).toBeAttached();

  // A new note is selected; a click on its row lets go, and another selects it again.
  const pick = row.getByRole('button').first();
  await expect(pick).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('1 mark(s) selected')).toBeVisible();
  await pick.click();
  await expect(pick).not.toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('No marks selected')).toBeVisible();
  await pick.click();
  await expect(pick).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('1 mark(s) selected')).toBeVisible();

  // Cancelling an edit leaves the text; the field closes.
  await row.getByRole('button', { name: 'Edit comment' }).click();
  await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('Comment text')).toHaveCount(0);
  await expect(row).toContainText('Check this figure');

  // An empty reply cannot be sent; Escape and Cancel close the field; Ctrl+Enter sends.
  await row.getByRole('button', { name: 'Reply', exact: true }).click();
  const reply = page.getByLabel('Your reply');
  await expect(row.getByRole('button', { name: 'Reply', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(row.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await reply.press('Escape');
  await expect(reply).toHaveCount(0);
  await row.getByRole('button', { name: 'Reply', exact: true }).click();
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(reply).toHaveCount(0);
  await row.getByRole('button', { name: 'Reply', exact: true }).click();
  await reply.fill('first answer');
  await reply.press('Control+Enter');
  await expect(row.getByRole('list', { name: '1 replies' })).toContainText('first answer');
  await expect(notice(page, 'Reply added; it is saved together with the comment.')).toBeVisible();
  await row.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByLabel('Your reply').fill('second answer');
  await row.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(row.getByRole('list', { name: '2 replies' })).toContainText('second answer');
  await row.getByRole('button', { name: 'Delete reply' }).first().click();
  await expect(row.getByRole('list', { name: '1 replies' })).not.toContainText('first answer');
  await expect(row.getByRole('list', { name: '1 replies' })).toContainText('second answer');

  await status(row).selectOption('Rejected');
  await expect(status(row)).toHaveValue('Rejected');
  await expect(notice(page, 'Rejected')).toBeVisible();

  // The filter hides it: the panel says so instead of showing an empty list.
  await filter(page).selectOption('Highlight');
  await expect(rows(page)).toHaveCount(2);
  await filter(page).selectOption('Squiggly');
  await expect(page.getByText('No comments match this filter.')).toBeVisible();
  await filter(page).selectOption('all');

  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText('5 comment(s) displayed; 0 pending save.')).toBeAttached();

  await addNote(page, 'one more', [200, 300]);
  await addNote(page, 'and another', [400, 300]);
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Clear all' })).toBeDisabled();
});

test('a reply and a status on a comment the file holds are written into the file', async ({ page }) => {
  await openPdf(page);
  await openDockTab(page, 'Comments');
  const row = rows(page).filter({ hasText: SAVED_MARKS.highlight.contents });
  await expect(row).toContainText('in file');
  await row.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByLabel('Your reply').fill('Seen and agreed');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(notice(page, 'The reply was written to the document.')).toBeVisible({ timeout: 60_000 });
  await expect(row.getByRole('list', { name: '1 replies' })).toContainText('Seen and agreed');

  await status(row).selectOption('Completed');
  await expect(notice(page, 'The review status was written to the document: Completed.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(status(row)).toHaveValue('Completed');

  const produced = await exportBytes(page, 'reviewed.pdf');
  const replies = (await readProducedPdf(produced)).annotations.filter((mark) =>
    mark.contents.includes('Seen and agreed'),
  );
  expect(replies).toHaveLength(1);

  // The reviewed file, opened again, shows the thread as the file spells it.
  await openPdf(page, 'reviewed.pdf', produced, { navigate: false, advanced: false });
  await openDockTab(page, 'Comments');
  const again = rows(page).filter({ hasText: SAVED_MARKS.highlight.contents });
  await expect(again.getByRole('list', { name: '1 replies' })).toContainText('Seen and agreed');
  await expect(status(again)).toHaveValue('Completed');
  // The answer is part of the thread, not a comment of its own.
  await expect(rows(page).filter({ hasText: 'Seen and agreed' })).toHaveCount(1);

  await again.getByRole('button', { name: 'Delete reply' }).click();
  await expect(again.getByRole('list', { name: '1 replies' })).toHaveCount(0, { timeout: 60_000 });
  const after = await readProducedPdf(await exportBytes(page, 'unanswered.pdf'));
  expect(after.annotations.filter((mark) => mark.contents.includes('Seen and agreed'))).toHaveLength(0);
});

test('the review leaves as JSON and FDF, and a JSON file brings it back; a damaged record is skipped and said', async ({
  page,
}) => {
  await openPdf(page, 'review.pdf');
  await openDockTab(page, 'Comments');
  await addNote(page, 'Figure two is wrong');

  const json = await download(
    page,
    page.getByRole('button', { name: 'Export comments as JSON' }),
    'out.json',
  );
  expect(json.name).toBe('review-comments.json');
  expect(json.text).toContain('Figure two is wrong');
  await expect(notice(page, '1 comments written: review-comments.json')).toBeVisible();
  const fdf = await download(page, page.getByRole('button', { name: 'Export comments as FDF' }), 'out.fdf');
  expect(fdf.name).toBe('review-comments.fdf');
  expect(fdf.text).toContain('%FDF');
  expect(fdf.text).toContain('Figure two is wrong');

  // A fresh copy knows nothing of it until the JSON is imported.
  await openPdf(page, 'copy.pdf', undefined, { navigate: false, advanced: false });
  await openDockTab(page, 'Comments');
  await expect(page.getByText('Figure two is wrong')).toHaveCount(0);
  const input = page.locator('input[type="file"][accept*=".xfdf"]');
  await input.setInputFiles(json.path);
  await expect(notice(page, '1 comments imported.')).toBeVisible({ timeout: 30_000 });
  await expect(rows(page).filter({ hasText: 'Figure two is wrong' })).toContainText('unsaved');
  // The same file twice in a row fires again: the input was cleared.
  await input.setInputFiles(json.path);
  await expect(rows(page).filter({ hasText: 'Figure two is wrong' })).toHaveCount(2, { timeout: 30_000 });

  // A record that is no mark is left out, and the notice counts it.
  const damaged = JSON.parse(json.text) as { marks?: unknown[]; annotations?: unknown[] };
  const key = Array.isArray(damaged.marks) ? 'marks' : 'annotations';
  const list = (damaged as Record<string, unknown[]>)[key] ?? [];
  (damaged as Record<string, unknown[]>)[key] = [...list, { nonsense: true }];
  await input.setInputFiles({
    name: 'damaged.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(damaged)),
  });
  await expect(notice(page, /1 record\(s\) could not be read and were skipped\./)).toBeVisible({
    timeout: 30_000,
  });
});
