/**
 * Shell flows that no other spec drives: files of other formats opened as PDF tabs,
 * the history list, and the tab lifecycle. Everything is asserted by what the user sees
 * and by the PDF the export writes.
 */

import type { Locator, Page } from 'playwright/test';
import { openApp, rotateCurrentPage } from './app-helpers';
import { expect, test } from './test';
import {
  encryptedToolFixturePdf,
  labelledPdf,
  readProducedEntry,
  readProducedPageTexts,
} from './tool-fixture';
import { CANVAS, encodePng, exportBytes, openPdf, pdfFile } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const notice = (page: Page, text: string | RegExp): Locator =>
  page.locator('[role="status"]').filter({ hasText: text });

/** Offer a non-PDF file to the home screen's file input. */
async function offer(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.goto('/editor/');
  await page.locator('input[type="file"][accept*="application/pdf"]').first().setInputFiles(file);
}

/** The painted page's box. */
async function pageShape(page: Page): Promise<{ width: number; height: number }> {
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  const box = await page.locator(CANVAS).first().boundingBox();
  if (box === null) throw new Error('no page on screen');
  return box;
}

test('a text file is converted and opens as a PDF tab with its words and a notice', async ({ page }) => {
  await offer(page, {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('First line of the notes\nSecond line of the notes\n'),
  });
  await expect(notice(page, /The TXT file was converted to PDF and opened in a new tab\./)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: 'notes.pdf', exact: true })).toBeVisible();
  const shape = await pageShape(page);
  expect(shape.height).toBeGreaterThan(shape.width);
  const texts = await readProducedPageTexts(await exportBytes(page, 'notes-out.pdf'));
  const flat = texts.join(' ').replace(/\s+/g, ' ');
  expect(flat).toContain('First line of the notes');
  expect(flat).toContain('Second line of the notes');
});

test('a CSV file becomes a landscape table', async ({ page }) => {
  await offer(page, {
    name: 'sales.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('region,total\nNorth,120\nSouth,340\n'),
  });
  await expect(notice(page, /The CSV file was converted to PDF/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'sales.pdf', exact: true })).toBeVisible();
  const shape = await pageShape(page);
  expect(shape.width).toBeGreaterThan(shape.height);
  const text = (await readProducedPageTexts(await exportBytes(page, 'sales-out.pdf'))).join(' ');
  for (const word of ['region', 'total', 'North', '120', 'South', '340']) expect(text).toContain(word);
});

test('a picture opens as one PDF page', async ({ page }) => {
  await offer(page, {
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: encodePng(200, 100, () => [20, 120, 220]),
  });
  await expect(notice(page, 'The image was opened as a PDF page in a new tab.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: 'photo.pdf', exact: true })).toBeVisible();
  await expect(page.getByText('/ 1', { exact: true })).toBeVisible();
});

test('a converted file opens beside the document that was open', async ({ page }) => {
  await openPdf(page, 'first.pdf');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({
      name: 'memo.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Memo body'),
    });
  await expect(notice(page, /The TXT file was converted/)).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole('button', { name: /^memo\.pdf/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'first.pdf', exact: true })).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * The history list
 * ------------------------------------------------------------------ */

test('the History panel lists the steps, its buttons undo and redo them, and the file follows the cursor', async ({
  page,
}) => {
  await openPdf(page, 'turns.pdf', labelledPdf('Turn', 3));
  await rotateCurrentPage(page);
  await expect(notice(page, '1 page(s) rotated')).toBeVisible();
  await rotateCurrentPage(page);
  await page.getByRole('tab', { name: 'History' }).click();
  const steps = page.getByRole('list', { name: 'History' });
  const counts = page.getByText(/step\(s\) can be undone/);
  await expect(steps.getByRole('listitem')).toHaveCount(2);
  await expect(counts).toHaveText('2 step(s) can be undone · 0 step(s) can be redone');
  await expect(steps.getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step');
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  await expect(redo).toBeDisabled();

  await undo.click();
  await expect(counts).toHaveText('1 step(s) can be undone · 1 step(s) can be redone');
  await expect(steps.getByRole('listitem').nth(0)).toHaveAttribute('aria-current', 'step');
  await expect(notice(page, /^Undone: /)).toBeVisible();
  expect(await readProducedEntry(await exportBytes(page, 'one.pdf'), 0, 'Rotate')).toBe('90');

  await undo.click();
  await expect(counts).toHaveText('0 step(s) can be undone · 2 step(s) can be redone');
  await expect(undo).toBeDisabled();
  expect(await readProducedEntry(await exportBytes(page, 'none.pdf'), 0, 'Rotate')).toBe('');

  await redo.click();
  await redo.click();
  await expect(counts).toHaveText('2 step(s) can be undone · 0 step(s) can be redone');
  await expect(notice(page, /^Redone: /)).toBeVisible();
  expect(await readProducedEntry(await exportBytes(page, 'both.pdf'), 0, 'Rotate')).toBe('180');
});

test('two undo presses in a row undo two steps, and the redo shortcut brings one back', async ({ page }) => {
  await openPdf(page, 'quick.pdf', labelledPdf('Quick', 3));
  await rotateCurrentPage(page);
  await rotateCurrentPage(page);
  await rotateCurrentPage(page);
  await page.getByRole('tab', { name: 'History' }).click();
  const counts = page.getByText(/step\(s\) can be undone/);
  await expect(counts).toHaveText('3 step(s) can be undone · 0 step(s) can be redone');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(counts).toHaveText('1 step(s) can be undone · 2 step(s) can be redone');
  await page.keyboard.press('Control+Shift+z');
  await expect(counts).toHaveText('2 step(s) can be undone · 1 step(s) can be redone');
  expect(await readProducedEntry(await exportBytes(page, 'two.pdf'), 0, 'Rotate')).toBe('180');
});

/* ------------------------------------------------------------------ *
 * Offline packages (Settings)
 * ------------------------------------------------------------------ */

async function openOfflineSettings(page: Page): Promise<Locator> {
  await page.goto('/editor/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Settings/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('Prepare fills the offline cache, and Check status then reports every package ready', {
  tag: '@service-worker',
}, async ({ page }) => {
  const dialog = await openOfflineSettings(page);
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
    timeout: 30_000,
  });
  await dialog.getByRole('button', { name: 'Prepare', exact: true }).click();
  await expect(notice(page, /^\d+ file\(s\) prepared for offline use\.$/)).toBeVisible({
    timeout: 120_000,
  });
  await dialog.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(notice(page, 'Every package offline use needs is ready.')).toBeVisible({ timeout: 60_000 });
  // The engines are really in a cache of this origin now, not only claimed to be.
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
    }
    return urls;
  });
  expect(cached.some((path) => path.includes('/engines/mupdf/'))).toBe(true);
  expect(cached.some((path) => path.includes('/engines/pdfjs/') || path.includes('pdf.worker'))).toBe(true);
});

/* ------------------------------------------------------------------ *
 * A protected document: the unlocked copy
 * ------------------------------------------------------------------ */

test('a document opened with its password offers an unlocked copy, which opens in a new tab without the password', async ({
  page,
}) => {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles(pdfFile('sealed.pdf', await encryptedToolFixturePdf('parola')));
  const prompt = page.getByRole('dialog', { name: /Password required/ });
  await prompt.getByLabel('Document open password').fill('parola');
  await prompt.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(
    page.getByRole('main').getByText('Protected document: you can read, search and print it.'),
  ).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Create unlocked copy' }).click();
  await expect(
    notice(page, 'The unlocked copy opened in a new tab; the original file stays protected.'),
  ).toBeVisible({ timeout: 60_000 });
  // The copy is the active tab: no banner, and its file carries no encryption and the text.
  await expect(page.getByRole('button', { name: 'Create unlocked copy' })).toHaveCount(0);
  const bytes = await exportBytes(page, 'unlocked-copy.pdf');
  expect(await readProducedEntry(bytes, 'trailer', 'Encrypt')).toBe('');
  expect((await readProducedPageTexts(bytes))[0]).toContain('Fixture line one reads clearly');
  // The protected original is still its own tab.
  await expect(page.getByRole('button', { name: /^sealed/ }).first()).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * Stored drafts: Settings → Privacy and storage
 * ------------------------------------------------------------------ */

/** The vault as the page sees it: the draft manifests and the source blobs actually stored. */
async function readVault(page: Page): Promise<{ drafts: string[]; sources: string[] }> {
  return await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const list = async (name: string): Promise<string[]> => {
      const names: string[] = [];
      try {
        const app = await root.getDirectoryHandle('pdf-editor');
        const dir = await app.getDirectoryHandle(name);
        for await (const [entry] of (
          dir as unknown as { entries(): AsyncIterable<[string, unknown]> }
        ).entries()) {
          names.push(entry);
        }
      } catch {
        return [];
      }
      return names.sort();
    };
    return {
      drafts: (await list('drafts')).filter((name) => name.endsWith('.json')),
      sources: await list('sources'),
    };
  });
}

test('Settings saves the draft now, deletes the stored copies, and sweeps nothing when nothing is orphaned', async ({
  page,
}) => {
  await openPdf(page, 'stored.pdf', labelledPdf('Stored', 2));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Settings/ });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await readVault(page)).drafts.length, { timeout: 30_000 }).toBe(1);
  expect((await readVault(page)).sources).toHaveLength(1);

  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click();
  await expect(
    notice(page, /No orphaned copies in the vault|record\(s\) no other document references/),
  ).toBeVisible({
    timeout: 30_000,
  });
  // The document being edited is not an orphan: its copies stay.
  expect((await readVault(page)).drafts).toHaveLength(1);

  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await readVault(page)).drafts.length, { timeout: 30_000 }).toBe(0);
  expect((await readVault(page)).sources).toHaveLength(0);
});

/* ------------------------------------------------------------------ *
 * Tabs: closing an untouched document
 * ------------------------------------------------------------------ */

test('closing an untouched document asks nothing, shows the other document, and the last close returns home', async ({
  page,
}) => {
  await openApp(page, 'first.pdf', labelledPdf('First', 1), { advanced: false });
  await openApp(page, 'second.pdf', labelledPdf('Second', 2), { advanced: false, navigate: false });
  await expect(page.getByText('/ 2', { exact: true })).toBeVisible();

  await page
    .getByRole('button', { name: /^second\.pdf/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Close tab' }).last().click();
  // No question: nothing was changed. The remaining document is the one on screen.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^first\.pdf/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^second\.pdf/ })).toHaveCount(0);
  await expect(page.getByText('/ 1', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector('.pdfViewer[data-active-viewer] .textLayer')?.textContent ?? '',
      ),
    )
    .toContain('First 1');

  // The list of open documents may still be open from the first close.
  const close = page.getByRole('button', { name: 'Close tab' });
  if ((await close.count()) === 0) {
    await page
      .getByRole('button', { name: /^first\.pdf/ })
      .first()
      .click();
  }
  await close.click();
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Start', exact: true })).toBeVisible();
});
