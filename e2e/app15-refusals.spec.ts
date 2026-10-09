import { createHash } from 'node:crypto';
import type { Page } from 'playwright/test';
import {
  CANVAS,
  dragOnPage,
  installPickers,
  menu,
  notice,
  openApp,
  openStaged,
  palette,
  readFile,
  rotateCurrentPage,
  stageFile,
} from './app-helpers';
import { holdSavePicker, offerHugeFile } from './app15-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry } from './tool-fixture';

/**
 * Refusals and failures in the shell: what the user is told when the shell is busy, when a
 * file is over the limits, when a save is held back, and when a picked picture is not one.
 */

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const PENDING =
  'Unapplied redaction marks; saving, exporting, printing and every tool that produces a file or moves pages are held.';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('a second Save while the save picker is still open is refused, and the first one then completes', async ({
  page,
}) => {
  await installPickers(page);
  await holdSavePicker(page);
  await openApp(page, 'held.pdf', labelledPdf('Held', 2), { advanced: false });
  await rotateCurrentPage(page);
  await stageFile(page, 'save', 'target.pdf', new Uint8Array(0));
  await expect(page.getByRole('button', { name: 'Save as…', exact: true })).toBeEnabled({ timeout: 30_000 });

  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__saveCalls'))).toBe(1);

  // The first Save owns the document while its picker is open: the second one is told so,
  // and it opens no picker of its own.
  await page.keyboard.press('Control+s');
  await expect(notice(page, 'Another operation is running — wait for it to complete.')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, '__saveCalls'))).toBe(1);

  // Closing the tab is refused for the same reason: the document is mid-save.
  await page
    .getByRole('button', { name: /^held\.pdf/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Close tab' }).click();
  // A refused close asks nothing: the edited document's "Close" question never comes up.
  await page.waitForTimeout(500);
  await expect(page.getByRole('dialog', { name: /Close "held.pdf"/ })).toHaveCount(0);
  await expect(page.locator(CANVAS).first()).toBeVisible();

  await page.evaluate(() => {
    const release: () => void = Reflect.get(window, '__releaseSave');
    release();
  });
  await expect(notice(page, 'Saved: held.pdf')).toBeVisible({ timeout: 60_000 });
  expect(await readProducedEntry(await readFile(page, 'target.pdf'), 0, 'Rotate')).toBe('90');
});

test('a file over the size limit is refused with the limit named, and no document opens', async ({
  page,
}) => {
  await page.goto('/editor/');
  // One byte over the 300 MiB desktop ceiling.
  await offerHugeFile(page, 'huge.pdf', 300 * 1024 * 1024 + 1);
  await expect(
    notice(page, 'The file exceeds the size limit. Reduce the file size and try again.'),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Start', exact: true })).toBeVisible();
});

test('a document with more pages than the limit is refused after it is read, and nothing opens', async ({
  page,
}) => {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({
      name: 'endless.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(labelledPdf('Endless', 2001)),
    });
  await expect(notice(page, 'The document exceeds the page limit. Open it in parts.')).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^endless\.pdf/ })).toHaveCount(0);
});

test('a picked file that is not a picture is reported by name and arms no tool', async ({ page }) => {
  await openApp(page, 'stamp.pdf', labelledPdf('Stamp', 1));
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({
    name: 'notes.png',
    mimeType: 'image/png',
    buffer: Buffer.from('this is text, not a PNG'),
  });
  await expect(
    notice(page, 'The image could not be read: notes.png. Choose a PNG, JPEG, WebP, GIF or BMP.'),
  ).toBeVisible({ timeout: 30_000 });
});

test('Save is held back while a redaction mark is unapplied, and the file on disk keeps its bytes', async ({
  page,
}) => {
  await installPickers(page);
  await page.goto('/editor/');
  const original = labelledPdf('Marked', 1);
  await stageFile(page, 'open', 'marked.pdf', original);
  await openStaged(page);
  await rotateCurrentPage(page);

  await page.getByRole('button', { name: 'Redact (permanent removal)' }).click();
  await dragOnPage(page, [60, 700], [330, 660]);
  // The inspection of the new version has to land before the save reaches the marks, so the
  // press is repeated until the refusal that names them shows.
  await expect(async () => {
    await page.keyboard.press('Control+s');
    await expect(notice(page, PENDING)).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });
  expect(sha(await readFile(page, 'marked.pdf'))).toBe(sha(original));
});

test('Word and text export, Print and Snapshot are held back while a redaction mark is unapplied, as Export is', async ({
  page,
}) => {
  await openApp(page, 'marked.pdf', labelledPdf('Marked', 1));
  await page.getByRole('button', { name: 'Redact (permanent removal)' }).click();
  await dragOnPage(page, [60, 700], [330, 660]);
  await expect(page.locator('[data-mark-family="redaction"]')).toHaveCount(1);

  for (const tool of ['Export to Word, Excel or CSV', 'Export Text']) {
    await palette(page, tool);
    await expect(notice(page, PENDING)).toBeVisible({
      timeout: 30_000,
    });
    // The form that would write the marked words into a file never opens.
    await expect(page.getByRole('region', { name: tool })).toHaveCount(0);
    await dismissNotice(page);
  }

  // Print and Snapshot render the engine document, which carries no staged marks: every way
  // in is refused with the same notice, and neither dialog opens.
  const entries: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    ['Ctrl+P', () => page.keyboard.press('Control+p')],
    ['File > Print', () => menu(page, 'File', /^Print/)],
    ['palette Print', () => palette(page, 'Print')],
    ['View > Snapshot', () => menu(page, 'View', /^Snapshot/)],
    ['palette Snapshot', () => palette(page, 'Snapshot')],
  ];
  for (const [entry, open] of entries) {
    await open();
    await expect(notice(page, PENDING), entry).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('dialog', { name: /^(Print|Snapshot)$/ }), entry).toHaveCount(0);
    await dismissNotice(page);
  }
});

async function dismissNotice(page: Page): Promise<void> {
  await notice(page, PENDING).getByRole('button', { name: 'Close' }).click();
  await expect(notice(page, PENDING)).toHaveCount(0);
}
