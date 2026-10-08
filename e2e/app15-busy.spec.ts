import type { Locator, Page } from 'playwright/test';
import { installPickers, menu, notice, openApp } from './app-helpers';
import { holdSavePicker } from './app15-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedPdf, toolFixturePdf } from './tool-fixture';
import { exportBytes } from './ui-helpers';

/**
 * Work that arrives while the shell is busy with something else. A save waiting on its file
 * picker holds the document for as long as the picker is open, which is the one stall a test
 * can keep open deterministically; what is refused must be refused in words, and must go
 * through once the shell is free.
 */

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const BUSY = 'Another operation is running — wait for it to complete.';

const released = (page: Page) =>
  page.evaluate(() => {
    const release: () => void = Reflect.get(window, '__releaseSave');
    release();
  });

/** The Edit menu's Undo item, with the menu opened. */
async function undoItem(page: Page): Promise<Locator> {
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  return page.getByRole('menuitem', { name: /^Undo/ });
}

test('a previewed result applied while a save waits on its picker is refused, and applies once the picker closes', async ({
  page,
}) => {
  await installPickers(page);
  await holdSavePicker(page);
  await openApp(page, 'busy.pdf', labelledPdf('Busy', 2));

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Optimize');
  await page.keyboard.press('Enter');
  const form = page.getByRole('region', { name: 'Optimize / Compress' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  const report = form.getByRole('heading', { name: 'Operation report' });
  // A destructive operation asks once more before it runs.
  const goOn = form.getByRole('button', { name: 'Continue', exact: true });
  await expect(goOn.or(report)).toBeVisible({ timeout: 60_000 });
  if (await goOn.isVisible()) await goOn.click();
  await expect(report).toBeVisible({ timeout: 60_000 });

  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__saveCalls'))).toBe(1);

  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(notice(page, BUSY)).toBeVisible();
  // Refused, not dropped: the form is still there with its result.
  await expect(form).toBeVisible();
  await expect(await undoItem(page)).toBeDisabled();
  await page.keyboard.press('Escape');

  // The picker is dismissed: the save ends quietly and the shell is free again.
  await released(page);
  await expect(page.getByRole('button', { name: 'Apply to document', exact: true })).toBeEnabled();
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
  // The result is a journaled version: Undo is offered now.
  await expect(await undoItem(page)).toBeEnabled();
});

test('deleting the selected marks while a save waits on its picker is refused, and the marks stay in the file', async ({
  page,
}) => {
  await installPickers(page);
  await holdSavePicker(page);
  await openApp(page, 'marks.pdf', toolFixturePdf());

  await expect(async () => {
    await menu(page, 'Edit', 'Select all marks');
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /^Delete(?! page)/ })).toBeEnabled({ timeout: 1_500 });
    await page.keyboard.press('Escape');
  }).toPass({ timeout: 60_000 });

  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__saveCalls'))).toBe(1);

  // The menu offers no Delete while the shell is busy; the key does, and is refused in words.
  await page.keyboard.press('Delete');
  await expect(notice(page, BUSY)).toBeVisible();
  await expect(notice(page, /mark\(s\) removed\./)).toHaveCount(0);

  await released(page);
  await expect(notice(page, 'Saved:')).toHaveCount(0);
  const kept = await readProducedPdf(await exportBytes(page, 'kept.pdf'));
  expect(kept.annotations.map((item) => item.subtype)).toEqual([
    'Highlight',
    'Ink',
    'Ink',
    'FreeText',
    'Widget',
    'Link',
    'Highlight',
  ]);
});
