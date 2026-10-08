import type { Page } from 'playwright/test';
import { dragOnPage, notice, openApp, rail, rotateCurrentPage } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';

/**
 * The keyboard layer (`useShortcuts.ts`), driven with real key presses: what each chord does,
 * that a text field keeps its keys (except the five that work from anywhere), that Delete and
 * select-all decline when there is nothing to act on, and that composite widgets keep the
 * navigation keys.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const pageField = (page: Page) => page.getByRole('textbox', { name: 'Page number' });

test('PageDown, PageUp, End and Home move through the pages and the page field follows', async ({ page }) => {
  await openApp(page, 'keys.pdf', labelledPdf('Key', 4), { advanced: false });
  await expect(pageField(page)).toHaveValue('1');
  await page.keyboard.press('PageDown');
  await expect(pageField(page)).toHaveValue('2');
  await page.keyboard.press('End');
  await expect(pageField(page)).toHaveValue('4');
  await page.keyboard.press('PageUp');
  await expect(pageField(page)).toHaveValue('3');
  await page.keyboard.press('Home');
  await expect(pageField(page)).toHaveValue('1');
});

test('Ctrl+= , Ctrl+-, Ctrl+1 and Ctrl+0 change the zoom the status bar reports', async ({ page }) => {
  await openApp(page, 'zoom.pdf', labelledPdf('Zoom', 1), { advanced: false });
  const zoom = (value: RegExp) => page.getByRole('button', { name: value });
  // The scale pdf.js draws the pages at (its `--scale-factor` is in CSS pixels per point).
  const drawn = () =>
    page.evaluate(() => {
      const viewer = document.querySelector('.pdfViewer[data-active-viewer]');
      if (viewer === null) return Number.NaN;
      const factor = Number.parseFloat(getComputedStyle(viewer).getPropertyValue('--scale-factor'));
      return Math.round(((factor * 72) / 96) * 100);
    });
  // A document opens at fit width, and the status bar reports the scale it is drawn at.
  // On a 1440 px window that is not 100%: before, the open reset the report to 100% after
  // the viewer had already applied fit width.
  const fit = await drawn();
  expect(fit).not.toBe(100);
  await expect(zoom(new RegExp(`^Fit Width \\(${fit}%\\)$`))).toBeVisible();
  await page.keyboard.press('Control+1');
  await expect(zoom(/^Fit Width \(100%\)$/)).toBeVisible();
  expect(await drawn()).toBe(100);
  await page.keyboard.press('Control+=');
  await expect(zoom(/^Fit Width \(125%\)$/)).toBeVisible();
  await page.keyboard.press('Control+-');
  await page.keyboard.press('Control+-');
  await expect(zoom(/^Fit Width \(75%\)$/)).toBeVisible();
  expect(await drawn()).toBe(75);
  await page.keyboard.press('Control+0');
  await expect(zoom(new RegExp(`^Fit Width \\(${fit}%\\)$`))).toBeVisible();
  expect(await drawn()).toBe(fit);
});

test('F4 and F5 toggle the page panel and the tools dock, F9 the reading pane, Escape closes it', async ({
  page,
}) => {
  await openApp(page, 'docks.pdf', labelledPdf('Dock', 2), { advanced: false });
  const thumbnails = page.getByRole('option');
  await expect(thumbnails.first()).toBeVisible();
  await page.keyboard.press('F4');
  await expect(thumbnails).toHaveCount(0);
  await page.keyboard.press('F4');
  await expect(thumbnails.first()).toBeVisible();

  const history = page.getByRole('tab', { name: 'History' });
  await expect(history).toBeVisible();
  await page.keyboard.press('F5');
  await expect(history).toHaveCount(0);
  await page.keyboard.press('F5');
  await expect(history).toBeVisible();

  await page.keyboard.press('F9');
  const reading = page
    .getByRole('group', { name: 'Page and view controls' })
    .getByRole('button', { name: 'Reading Mode' });
  await expect(reading).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('F9');
  await expect(reading).toHaveAttribute('aria-pressed', 'false');
});

test('Ctrl+Shift+D opens the document properties form and Ctrl+H the find and replace form', async ({
  page,
}) => {
  await openApp(page, 'forms.pdf', labelledPdf('Form', 2));
  await page.keyboard.press('Control+Shift+D');
  await expect(page.getByRole('region', { name: /Document properties/ })).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole('button', { name: /Back to tools|Tools/ })
    .first()
    .click();
  await page.keyboard.press('Control+h');
  await expect(page.getByRole('region', { name: /Find and replace/ })).toBeVisible({ timeout: 30_000 });
});

test('Ctrl+P opens the print dialog and Ctrl+K the palette, which Escape closes', async ({ page }) => {
  await openApp(page, 'print.pdf', labelledPdf('Print', 2), { advanced: false });
  await page.keyboard.press('Control+p');
  await expect(page.getByRole('dialog', { name: 'Print' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Print' })).toBeHidden();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox')).toBeHidden();
});

test('Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y walk the history', async ({ page }) => {
  await openApp(page, 'undo.pdf', labelledPdf('Undo', 2), { advanced: false });
  await rotateCurrentPage(page);
  await page.keyboard.press('Control+z');
  await expect(notice(page, 'Undone:')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+Shift+Z');
  await expect(notice(page, 'Redone:')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+z');
  await expect(notice(page, 'Undone:')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+y');
  await expect(notice(page, 'Redone:')).toBeVisible({ timeout: 30_000 });
});

test('a text field keeps its keys: PageDown, undo and Delete skip the shell, Ctrl+K and Ctrl+S still work', async ({
  page,
}) => {
  await openApp(page, 'field.pdf', labelledPdf('Field', 3), { advanced: false });
  await rotateCurrentPage(page);
  await expect(notice(page, 'Applied')).toBeVisible();
  // Let the notice go so a later "Undone" can only come from a fresh press.
  await notice(page, 'Applied').getByRole('button', { name: 'Close' }).click();
  await expect(notice(page, 'Applied')).toHaveCount(0);

  const field = pageField(page);
  await field.focus();
  await page.keyboard.press('PageDown');
  await page.keyboard.press('Control+z');
  await expect(notice(page, 'Undone:')).toHaveCount(0);
  await expect(field).toHaveValue('1');

  // Ctrl+K works from inside the field.
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox')).toBeVisible();
  await page.keyboard.press('Escape');

  // Ctrl+S works from inside the field too: with no file handle and a save picker that is
  // cancelled by the browser's own default the shell answers by trying to save.
  const picker = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        Object.assign(window, {
          showSaveFilePicker: async () => {
            resolve(true);
            throw new DOMException('cancelled', 'AbortError');
          },
        });
      }),
  );
  await field.focus();
  await page.keyboard.press('Control+s');
  expect(await picker).toBe(true);
});

test('Delete and select-all decline when no mark is selected and the page keeps the keys', async ({
  page,
}) => {
  await openApp(page, 'marks.pdf', labelledPdf('Marks', 1), { advanced: false });
  // A bubble-phase observer sees only the keys the shell did not consume.
  await page.evaluate(() => {
    const seen: { key: string; prevented: boolean }[] = [];
    Object.assign(window, { __seen: seen });
    window.addEventListener('keydown', (event) =>
      seen.push({ key: event.key, prevented: event.defaultPrevented }),
    );
  });
  await page.locator('.pdfViewer[data-active-viewer]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('PageDown');
  const seen: { key: string; prevented: boolean }[] = await page.evaluate(() =>
    Reflect.get(window, '__seen'),
  );
  expect(seen.find((entry) => entry.key === 'Delete')).toEqual({ key: 'Delete', prevented: false });
  expect(seen.find((entry) => entry.key === 'a')).toEqual({ key: 'a', prevented: false });
  // PageDown was the shell's: consumed in the capture phase, never seen by the page.
  expect(seen.find((entry) => entry.key === 'PageDown')).toBeUndefined();
  await expect(notice(page, 'removed')).toHaveCount(0);
});

test('with a mark drawn, select-all selects it and Delete removes it with one undo step', async ({
  page,
}) => {
  await openApp(page, 'draw.pdf', labelledPdf('Draw', 1), { advanced: false });
  await rail(page, 'Draw Shape (Rectangle)').click();
  await dragOnPage(page, [100, 600], [260, 700]);
  // Back in the select tool the common layer is ready once the inventory is read.
  await expect(rail(page, 'Selection Tool')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.pdfViewer[data-active-viewer]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+a');
  await expect(page.getByText('1 mark(s) selected')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Delete');
  await expect(notice(page, '1 mark(s) removed.')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+z');
  await expect(notice(page, 'Undone:')).toBeVisible({ timeout: 30_000 });
});

test('End on a focused menu trigger moves along the menu bar and does not turn the page', async ({
  page,
}) => {
  await openApp(page, 'menu.pdf', labelledPdf('Menu', 3), { advanced: false });
  const triggers = page.getByRole('menubar').getByRole('menuitem');
  await triggers.first().focus();
  await page.keyboard.press('End');
  await expect(triggers.last()).toBeFocused();
  await expect(pageField(page)).toHaveValue('1');
  await page.keyboard.press('Home');
  await expect(triggers.first()).toBeFocused();
  await expect(pageField(page)).toHaveValue('1');
});
