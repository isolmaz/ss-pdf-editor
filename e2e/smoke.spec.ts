import type { Page } from 'playwright/test';
import { expect, test } from 'playwright/test';
import { useDarkTheme, useLanguage } from './settings';

/**
 * The shell a user meets first.
 *
 * These assertions are about *visible* state — text and attributes — because that is what a
 * "it still works" claim has to mean. The visible strings come from the i18n catalogues
 * (`packages/shared/src/i18n/{tr,en}.ts`); the context is pinned to `en-US` in
 * `playwright.config.ts`, so the shell boots in English and the switcher is exercised in
 * both directions rather than depending on the machine's locale.
 */

/**
 * Run a dialog command through the palette by the label the user reads.
 *
 * The palette is the way in with nothing open — the editor's Help menu needs a tab —
 * so it is also the only surface that can answer the shortcut list without a document.
 * The command is chosen by its own role and name once the results are rendered, rather
 * than pressing `Enter` on whatever the list happened to be highlighting a frame
 * earlier: `Ctrl+K` is the user's own route, the click is the user's own selection.
 */
async function runPaletteCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press('Control+k');
  // With nothing open the palette's search field is the shell's only `combobox`.
  await page.getByRole('combobox').fill(label);
  await page.getByRole('option', { name: label }).click();
}

test.describe('editor shell', () => {
  test('the home screen renders at /editor/', async ({ page }) => {
    await page.goto('/editor/');

    // The product title names the window (`App.tsx`) and the home header renders it too.
    await expect(page).toHaveTitle('SsPdfEditor');
    await expect(page.getByText('SsPdfEditor')).toBeVisible();
    // The home screen's own controls: the Discover/Tools tabs and the shell's Open button.
    await expect(page.getByRole('button', { name: 'Discover' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tools', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
  });

  test('the language switcher changes visible copy between Turkish and English', async ({ page }) => {
    await page.goto('/editor/');

    await expect(page.getByRole('button', { name: 'Discover' })).toBeVisible();

    // The language lives in the settings dialog, reached from the home screen's gear.
    await useLanguage(page, 'Türkçe');
    await expect(page.getByRole('button', { name: 'Keşfet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discover' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('tr');

    await useLanguage(page, 'English');
    await expect(page.getByRole('button', { name: 'Discover' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  });

  test('the theme switcher applies dark mode to the document', async ({ page }) => {
    await page.goto('/editor/');

    // `devices['Desktop Chrome']` emulates a light system preference and the fresh context
    // stores no choice, so the shell boots light: dark later must be the choice's doing.
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).not.toBe('dark');

    // The theme lives in the settings dialog, reached from the home screen's gear.
    await useDarkTheme(page);

    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe('dark');
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
    expect(await page.evaluate(() => window.localStorage.getItem('pdf-editor.theme'))).toBe('dark');
  });

  test('the shortcut list answers with no document, in both languages, and its printed chords work', async ({
    page,
  }) => {
    await page.goto('/editor/');

    // Help is not a document operation, so it has to answer with nothing open, and
    // "nothing open" is the home surface itself: its own controls are up, no viewer
    // pane is mounted (`PdfViewerPane`'s `.pdfViewer`), and the status bar reports no
    // page rather than a page number.
    await expect(page.getByRole('button', { name: 'Discover' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tools', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
    await expect(page.locator('.pdfViewer')).toHaveCount(0);
    // No document: the page and the zoom both read as a dash.
    await expect(page.getByRole('contentinfo').getByText('—', { exact: true })).toHaveCount(2);

    await runPaletteCommand(page, 'Keyboard shortcuts');

    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();

    // The rows come from the binding table the keyboard layer runs from: save, its
    // Shift sibling, and the palette chord that opened this list.
    await expect(dialog.getByText('Ctrl+S', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Ctrl+Shift+S', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Ctrl+K', { exact: true })).toBeVisible();

    // Escape closes the modal surface...
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // ...and hands focus back into the shell instead of dropping it on `<body>`: the
    // palette's search field is gone by now, so this is the shell's own fallback
    // (`closeShortcuts`), the home screen's first control.
    await expect(page.getByRole('button', { name: 'Discover' })).toBeFocused();

    // And a printed chord really is a binding: Ctrl+K, listed above, opens the palette.
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('combobox')).toBeVisible();
    await page.keyboard.press('Escape');

    // The same help in the other language, through the switcher a user would reach for:
    // the palette command and the dialog's own title follow the interface language.
    await useLanguage(page, 'Türkçe');
    await expect(page.getByRole('button', { name: 'Keşfet' })).toBeVisible();

    await runPaletteCommand(page, 'Klavye kısayolları');

    const turkishDialog = page.getByRole('dialog', { name: 'Klavye kısayolları' });
    await expect(turkishDialog).toBeVisible();
    await expect(turkishDialog.getByText('Ctrl+K', { exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(turkishDialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Keşfet' })).toBeFocused();
  });
});
