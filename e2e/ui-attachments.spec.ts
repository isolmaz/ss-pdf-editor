/**
 * The attachments view of the left dock: the embedded files a document carries, their
 * descriptions and measured sizes, the save action (the payload written out as a download),
 * and the two writes the panel hands to the shell — add from the picker, remove by name —
 * whose result is checked on the exported file, read back with MuPDF's object model.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { mutate } from '../packages/pdf-core/src/ops/tagged.fixtures';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { readProducedPdf, toolFixturePdf } from './tool-fixture';
import { exportBytes, openDockTab, openPdf } from './ui-helpers';
import { clickTabsTogether, revokedUrls, trackRevocations, utf8, withEmbedded } from './ui-panels9-helpers';
import { viewingOnlyFixture } from './ui-tags-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** A payload of `length` bytes that does not shrink under deflate. */
const noise = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let state = 12345;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
};

const rowsOf = (page: Page): Locator => page.getByRole('list', { name: 'Attachments' }).getByRole('listitem');

/** The steps the history list shows. */
const history = (page: Page): Locator => page.getByRole('list', { name: 'History' });

const rowNamed = (page: Page, name: string): Locator => rowsOf(page).filter({ hasText: name });

/** The picker the panel's "Add file" button opens. */
const picker = (page: Page): Locator => page.locator('input[data-attachment-picker]');

/** Click `button` and read the file the browser was asked to download. */
async function download(page: Page, button: Locator, name: string) {
  const event = page.waitForEvent('download');
  await button.click();
  const file = await event;
  const path = test.info().outputPath(name);
  await file.saveAs(path);
  return { suggested: file.suggestedFilename(), url: file.url(), bytes: new Uint8Array(readFileSync(path)) };
}

test('every embedded file is listed with its description and measured size, and saving writes its bytes out', async ({
  page,
}) => {
  const big = noise(2048);
  await openPdf(
    page,
    'files.pdf',
    await withEmbedded([
      { name: 'a.txt', bytes: utf8('hello'), description: 'A greeting' },
      { name: 'b.bin', bytes: big },
      { name: 'c.txt', bytes: utf8('lost'), withoutStream: true },
    ]),
  );
  await openDockTab(page, 'Attachments');

  await expect(rowsOf(page)).toHaveCount(3);
  const a = rowNamed(page, 'a.txt');
  await expect(a).toContainText('A greeting');
  await expect(a).toContainText('5 byte');
  // A file without a description has no description line, only its name and size.
  await expect(rowNamed(page, 'b.bin')).toHaveText(/^b\.bin2,048 byte$/);
  // A payload the engine cannot read costs its row the size, not its place in the list.
  await expect(rowNamed(page, 'c.txt')).toHaveText(/^c\.txt—$/);

  const saved = await download(page, a.getByRole('button', { name: 'Save attachment' }), 'a.txt');
  expect(saved.suggested).toBe('a.txt');
  expect(new TextDecoder().decode(saved.bytes)).toBe('hello');

  const binary = await download(
    page,
    rowNamed(page, 'b.bin').getByRole('button', { name: 'Save attachment' }),
    'b.bin',
  );
  expect(binary.suggested).toBe('b.bin');
  expect(Array.from(binary.bytes)).toEqual(Array.from(big));

  // Asking for the file whose payload is missing reports the failure instead of writing nothing.
  await rowNamed(page, 'c.txt').getByRole('button', { name: 'Save attachment' }).click();
  await expect(notice(page, 'The document looks damaged.')).toBeVisible();
});

test('the blob behind a saved file is revoked ten seconds after the download starts', async ({ page }) => {
  await trackRevocations(page);
  await openPdf(page, 'files.pdf', await withEmbedded([{ name: 'a.txt', bytes: utf8('hello') }]));
  await openDockTab(page, 'Attachments');
  const saved = await download(
    page,
    rowNamed(page, 'a.txt').getByRole('button', { name: 'Save attachment' }),
    'a.txt',
  );
  expect(saved.url).toMatch(/^blob:/);
  expect(await revokedUrls(page)).not.toContain(saved.url);
  await expect.poll(() => revokedUrls(page), { timeout: 20_000, intervals: [500] }).toContain(saved.url);
});

test('leaving the view revokes the blob of a file saved a moment ago', async ({ page }) => {
  await trackRevocations(page);
  await openPdf(page, 'files.pdf', await withEmbedded([{ name: 'a.txt', bytes: utf8('hello') }]));
  await openDockTab(page, 'Attachments');
  const saved = await download(
    page,
    rowNamed(page, 'a.txt').getByRole('button', { name: 'Save attachment' }),
    'a.txt',
  );
  expect(await revokedUrls(page)).not.toContain(saved.url);
  await openDockTab(page, 'Pages');
  await expect.poll(() => revokedUrls(page), { timeout: 5_000 }).toContain(saved.url);
});

test('files picked in the panel are embedded and files removed from it leave the document', async ({
  page,
}) => {
  await openPdf(page, 'empty.pdf', toolFixturePdf());
  await openDockTab(page, 'Attachments');
  await expect(page.getByText('This document has no attachments.')).toBeVisible();

  // Nothing picked, nothing written: the shell is not asked and no step is journaled.
  await picker(page).setInputFiles([]);
  await expect(page.getByText('This document has no attachments.')).toBeVisible();
  await expect(page.getByText('No operation history for this document.')).toBeVisible();

  await picker(page).setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('four') },
    { name: 'data.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(noise(3000)) },
  ]);
  await expect(rowsOf(page)).toHaveCount(2, { timeout: 60_000 });
  await expect(rowNamed(page, 'notes.txt')).toContainText('4 byte');
  await expect(rowNamed(page, 'data.bin')).toContainText('3,000 byte');
  await expect(history(page).getByText('Attachments', { exact: true })).toBeVisible();
  // The input is cleared as soon as its files are read, so the same pick fires again.
  await expect(picker(page)).toHaveValue('');

  expect((await readProducedPdf(await exportBytes(page, 'added.pdf'))).attachmentNames).toEqual([
    'data.bin',
    'notes.txt',
  ]);

  await rowNamed(page, 'notes.txt').getByRole('button', { name: 'Remove attachment: notes.txt' }).click();
  await expect(rowsOf(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(rowNamed(page, 'data.bin')).toBeVisible();
  expect((await readProducedPdf(await exportBytes(page, 'removed.pdf'))).attachmentNames).toEqual([
    'data.bin',
  ]);

  await rowNamed(page, 'data.bin').getByRole('button', { name: 'Remove attachment: data.bin' }).click();
  await expect(page.getByText('This document has no attachments.')).toBeVisible({ timeout: 60_000 });
  expect((await readProducedPdf(await exportBytes(page, 'none.pdf'))).attachmentNames).toEqual([]);
});

test.describe('a document that is only viewed', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });

  test('keeps the list and the save action but offers no write', async ({ page }) => {
    await openPdf(
      page,
      'long.pdf',
      await withEmbedded([{ name: 'a.txt', bytes: utf8('hello') }], await viewingOnlyFixture()),
    );
    await openDockTab(page, 'Attachments');
    await expect(rowNamed(page, 'a.txt')).toContainText('5 byte');
    await expect(page.getByRole('button', { name: 'Add file' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Remove attachment: a.txt' })).toBeDisabled();
    const saved = await download(
      page,
      rowNamed(page, 'a.txt').getByRole('button', { name: 'Save attachment' }),
      'a.txt',
    );
    expect(new TextDecoder().decode(saved.bytes)).toBe('hello');
  });
});

/** A name tree whose only kid is itself: the engine cannot walk it. */
const cyclicTree = (bytes: Uint8Array) =>
  mutate(bytes, (doc) => {
    const tree = doc.addObject(doc.newDictionary());
    const kids = doc.newArray();
    kids.push(tree);
    tree.put('Kids', kids);
    const names = doc.newDictionary();
    names.put('EmbeddedFiles', tree);
    doc.getTrailer().get('Root').resolve().put('Names', names);
  });

test('a name tree the engine cannot walk is reported in the panel and on the notice line', async ({
  page,
}) => {
  await openPdf(page, 'cycle.pdf', await cyclicTree(toolFixturePdf()));
  await openDockTab(page, 'Attachments');
  await expect(page.getByText('Something unexpected went wrong.').first()).toBeVisible();
  await expect(notice(page, 'Something unexpected went wrong.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add file' })).toHaveCount(0);
});

const pagesTab = (page: Page): Locator => page.getByRole('tab', { name: 'Pages', exact: true });

test('leaving the view before the list is read drops the answer, and the view reads it afresh on return', async ({
  page,
}) => {
  await openPdf(
    page,
    'files.pdf',
    await withEmbedded([
      { name: 'a.txt', bytes: utf8('hello') },
      { name: 'b.txt', bytes: utf8('world!') },
    ]),
  );
  // Open and leave in one task: the engine's answer arrives after the view is gone.
  await clickTabsTogether(page, ['Attachments', 'Pages']);
  await expect(pagesTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(rowsOf(page)).toHaveCount(0);

  await openDockTab(page, 'Attachments');
  await expect(rowsOf(page)).toHaveCount(2);
  await expect(rowNamed(page, 'a.txt')).toContainText('5 byte');
  await expect(rowNamed(page, 'b.txt')).toContainText('6 byte');
});

test('leaving the view as soon as the list shows drops the size reads that follow', async ({ page }) => {
  await openPdf(
    page,
    'files.pdf',
    await withEmbedded([
      { name: 'a.txt', bytes: utf8('hello') },
      { name: 'b.txt', bytes: utf8('world!') },
    ]),
  );
  // The observer runs as a microtask right after the commit that shows the list, before
  // the first payload has been read.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const tab = (label: string): HTMLElement => {
          const found = document.querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`);
          if (found === null) throw new Error(`no ${label} tab`);
          return found;
        };
        try {
          const watcher = new MutationObserver(() => {
            if (document.querySelector('ul[aria-label="Attachments"]') === null) return;
            watcher.disconnect();
            tab('Pages').click();
            resolve();
          });
          watcher.observe(document.body, { childList: true, subtree: true });
          tab('Attachments').click();
        } catch (error) {
          reject(error);
        }
      }),
  );
  await expect(pagesTab(page)).toHaveAttribute('aria-selected', 'true');
  await openDockTab(page, 'Attachments');
  await expect(rowNamed(page, 'a.txt')).toContainText('5 byte');
  await expect(rowNamed(page, 'b.txt')).toContainText('6 byte');
});

test('a name tree the engine cannot walk, left before it answers, stays silent', async ({ page }) => {
  await openPdf(page, 'cycle.pdf', await cyclicTree(toolFixturePdf()));
  await clickTabsTogether(page, ['Attachments', 'Pages']);
  await expect(pagesTab(page)).toHaveAttribute('aria-selected', 'true');
  // Give the engine's rejection time to arrive; nothing may be reported for a view that is gone.
  await page.waitForTimeout(1500);
  await expect(notice(page, 'Something unexpected went wrong.')).toHaveCount(0);
});
