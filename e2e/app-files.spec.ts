import { createHash } from 'node:crypto';
import {
  CANVAS,
  installPickers,
  notice,
  openApp,
  readFile,
  rewriteFile,
  rotateCurrentPage,
  settled,
  stageFile,
} from './app-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry } from './tool-fixture';

/**
 * Opening, saving and closing through the shell: the file pickers (stood in for by real
 * origin-private file handles), the in-place save with its conflict check, the download
 * fallback, and the close prompt.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('Ctrl+O opens the picked file and Ctrl+S writes the rotated page back over that same file', async ({
  page,
}) => {
  await installPickers(page);
  await page.goto('/editor/');
  const original = labelledPdf('Picked', 2);
  await stageFile(page, 'open', 'picked.pdf', original);
  await page.keyboard.press('Control+o');
  await settled(page);

  await rotateCurrentPage(page);
  // Save is enabled once the inspection of the new version has finished.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('Control+s');
  await expect(notice(page, 'Saved: picked.pdf')).toBeVisible({ timeout: 60_000 });

  const written = await readFile(page, 'picked.pdf');
  expect(sha(written)).not.toBe(sha(original));
  expect(await readProducedEntry(written, 0, 'Rotate')).toBe('90');
  expect(await readProducedEntry(written, 1, 'Rotate')).toMatch(/^0?$/);
});

test('Save stops with a conflict when the file changed after it was opened, and leaves it alone', async ({
  page,
}) => {
  await installPickers(page);
  await page.goto('/editor/');
  await stageFile(page, 'open', 'shared.pdf', labelledPdf('Shared', 2));
  await page.keyboard.press('Control+o');
  await settled(page);

  // Another program replaces the file while the document is open.
  const elsewhere = labelledPdf('Elsewhere', 3);
  await rewriteFile(page, 'shared.pdf', elsewhere);

  await rotateCurrentPage(page);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notice(page, 'The file changed after you opened it.')).toBeVisible({ timeout: 60_000 });
  expect(sha(await readFile(page, 'shared.pdf'))).toBe(sha(elsewhere));
});

test('Save as: a cancelled picker writes nothing and says nothing; a chosen file receives the document', async ({
  page,
}) => {
  await installPickers(page);
  await openApp(page, 'fresh.pdf', labelledPdf('Fresh', 2), { advanced: false });
  await rotateCurrentPage(page);
  const saveAs = page.getByRole('button', { name: 'Save as…', exact: true });
  await expect(saveAs).toBeEnabled({ timeout: 30_000 });

  // No destination chosen: the picker is dismissed.
  await saveAs.click();
  await expect(page.getByText('Opening the document…')).toHaveCount(0);
  await expect(notice(page, 'Saved:')).toHaveCount(0);

  await stageFile(page, 'save', 'destination.pdf', new Uint8Array(0));
  await page.keyboard.press('Control+s');
  await expect(notice(page, 'Saved: fresh.pdf')).toBeVisible({ timeout: 60_000 });
  const written = await readFile(page, 'destination.pdf');
  expect(await readProducedEntry(written, 0, 'Rotate')).toBe('90');

  // The destination is now the document's own file: the header offers a plain Save.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
});

test('without a save picker, Ctrl+S downloads the document and the header offers no Save', async ({
  page,
}) => {
  await installPickers(page, { savePicker: false });
  await openApp(page, 'plain.pdf', labelledPdf('Plain', 1), { advanced: false });
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);
  await rotateCurrentPage(page);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 30_000 });
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.keyboard.press('Control+s');
  const file = await download;
  expect(file.suggestedFilename()).toBe('plain.pdf');
  await expect(notice(page, 'Saved: plain.pdf')).toBeVisible({ timeout: 60_000 });
});

test('a file whose write permission is refused is reported, and nothing is written', async ({ page }) => {
  await installPickers(page);
  await page.goto('/editor/');
  const original = labelledPdf('Locked', 1);
  await stageFile(page, 'open', 'refused.pdf', original);
  // The handle answers as a handle restored from storage does: access has to be granted again.
  await page.evaluate(() => {
    const picks: { open: FileSystemFileHandle[] } = Reflect.get(window, '__picks');
    const real = picks.open.shift();
    if (real === undefined) throw new Error('no staged handle');
    const refusing = new Proxy(real, {
      get(target, property) {
        if (property === 'queryPermission') return async () => 'prompt';
        if (property === 'requestPermission') return async () => 'denied';
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    picks.open.push(refusing);
  });
  await page.keyboard.press('Control+o');
  await settled(page);
  await rotateCurrentPage(page);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notice(page, 'File access was denied.')).toBeVisible({ timeout: 30_000 });
  expect(sha(await readFile(page, 'refused.pdf'))).toBe(sha(original));
});

test('Ctrl+Shift+S asks how to export; the plain PDF choice downloads the edited document', async ({
  page,
}) => {
  await openApp(page, 'exp.pdf', labelledPdf('Exp', 2), { advanced: false });
  await rotateCurrentPage(page);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('Control+Shift+S');
  const dialog = page.getByRole('dialog', { name: 'Download / Export' });
  await expect(dialog).toBeVisible();
  // Escape puts the dialog away without exporting.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.keyboard.press('Control+Shift+S');
  await expect(dialog).toBeVisible();
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await dialog
    .getByRole('button', { name: /Download|Export/ })
    .last()
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('exp.pdf');
  await expect(notice(page, 'No in-place saving here')).toBeVisible({ timeout: 60_000 });
});

test('closing an edited document: cancel keeps it, export saves a copy, discard closes it', async ({
  page,
}) => {
  await openApp(page, 'close.pdf', labelledPdf('Close', 2), { advanced: false });
  await rotateCurrentPage(page);
  await page
    .getByRole('button', { name: /^close\.pdf/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Close tab' }).click();
  const dialog = page.getByRole('dialog', { name: /Close "close.pdf"/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('This document has no file handle')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator(CANVAS).first()).toBeVisible();

  // The tab switcher stays open behind the prompt.
  await page.getByRole('button', { name: 'Close tab' }).click();
  await expect(dialog).toBeVisible();
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await dialog.getByRole('button', { name: /Export/ }).click();
  expect((await download).suggestedFilename()).toBe('close.pdf');
  // An export does not close the document: the prompt stays until a decision is made.
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close without saving' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(CANVAS)).toHaveCount(0);
  // With no document the home screen is back.
  await expect(page.getByRole('tab', { name: 'Start' })).toBeVisible();
});

test('closing a document that has its own file offers Save and close, which writes it first', async ({
  page,
}) => {
  await installPickers(page);
  await page.goto('/editor/');
  await stageFile(page, 'open', 'inplace.pdf', labelledPdf('Inplace', 2));
  await page.keyboard.press('Control+o');
  await settled(page);
  await rotateCurrentPage(page);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 30_000 });
  await page
    .getByRole('button', { name: /^inplace\.pdf/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Close tab' }).click();
  const dialog = page.getByRole('dialog', { name: /Close "inplace.pdf"/ });
  await dialog.getByRole('button', { name: 'Save and close' }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  expect(await readProducedEntry(await readFile(page, 'inplace.pdf'), 0, 'Rotate')).toBe('90');
  await expect(page.locator(CANVAS)).toHaveCount(0);
});
