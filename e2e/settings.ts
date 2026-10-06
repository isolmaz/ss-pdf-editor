/**
 * The settings dialog, as a user reaches it: the header's gear, then the control.
 *
 * Language, theme and the interface mode live in one dialog (`SettingsDialog`); the specs
 * that need the advanced mode or a dark theme go through it rather than through storage,
 * so the path under test is the one a user takes. Locators match both locales.
 */

import { expect, type Page } from 'playwright/test';

async function openSettings(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page
    .getByRole('button', { name: /^(Ayarlar|Settings)$/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: /Ayarlar|Settings/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeSettings(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /Ayarlar|Settings/ });
  await dialog.getByRole('button', { name: /^(Kapat|Close)$/ }).click();
  await expect(dialog).toBeHidden();
}

/** Switch to the advanced interface mode, the way the mode choice is offered. */
export async function useAdvancedMode(page: Page): Promise<void> {
  const dialog = await openSettings(page);
  const advanced = dialog.getByRole('radio', { name: /Gelişmiş mod|Advanced mode/ });
  await advanced.check();
  await expect(advanced).toBeChecked();
  await closeSettings(page);
}

/** Choose the interface language; the dialog's own close button follows it. */
export async function useLanguage(page: Page, language: 'Türkçe' | 'English'): Promise<void> {
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: language, exact: true }).click();
  await closeSettings(page);
}

/** Choose the dark theme. */
export async function useDarkTheme(page: Page): Promise<void> {
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: /^(Koyu Tema|Dark Theme)$/ }).click();
  await closeSettings(page);
}
