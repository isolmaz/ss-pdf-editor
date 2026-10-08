/**
 * The settings dialog's language and theme controls (the choice applies to the page and
 * survives a reload) and the command palette's search, mouse activation, stored recents
 * and the simple-mode hint.
 */

import type { Page } from 'playwright/test';
import { useDarkTheme, useLanguage } from './settings';
import { expect, test } from './test';
import { openPdf } from './ui-helpers';

const attr = (page: Page, name: string) =>
  page.evaluate((key) => document.documentElement.getAttribute(key), name);

test('the language chosen in Settings applies to the page and is still there after a reload', async ({
  page,
}) => {
  await page.goto('/editor/');
  await useLanguage(page, 'Türkçe');
  expect(await attr(page, 'lang')).toBe('tr');
  expect(await page.evaluate(() => localStorage.getItem('pdf-editor.locale'))).toBe('tr');
  await expect(page.getByRole('button', { name: 'Ayarlar' }).first()).toBeVisible();

  await page.reload();
  expect(await attr(page, 'lang')).toBe('tr');
  await expect(page.getByRole('button', { name: 'Ayarlar' }).first()).toBeVisible();

  await useLanguage(page, 'English');
  expect(await attr(page, 'lang')).toBe('en');
  await page.reload();
  expect(await attr(page, 'lang')).toBe('en');
  await expect(page.getByRole('button', { name: 'Settings' }).first()).toBeVisible();
});

test('the dark theme chosen in Settings applies to the page and is still there after a reload', async ({
  page,
}) => {
  await page.goto('/editor/');
  await useDarkTheme(page);
  expect(await attr(page, 'data-mode')).toBe('dark');
  expect(await page.evaluate(() => localStorage.getItem('pdf-editor.theme'))).toBe('dark');

  await page.reload();
  expect(await attr(page, 'data-mode')).toBe('dark');

  await page.getByRole('button', { name: 'Settings' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('button', { name: 'Dark Theme' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Light Theme' }).click();
  expect(await attr(page, 'data-mode')).toBe('light');
  await expect(dialog.getByRole('button', { name: 'Light Theme' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: 'Dark Theme' })).toHaveAttribute('aria-pressed', 'false');
  await dialog.getByRole('button', { name: 'System Theme' }).click();
  expect(await page.evaluate(() => localStorage.getItem('pdf-editor.theme'))).toBeNull();
  await expect(dialog.getByRole('button', { name: 'System Theme' })).toHaveAttribute('aria-pressed', 'true');
});

const palette = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('combobox') });
const count = (page: Page) => palette(page).getByText(/^\d+ command\(s\)$/);

async function search(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.getByRole('combobox').fill(text);
}

test('a command is found by its keyword whole, by its start or by a part of it', async ({ page }) => {
  await openPdf(page);
  for (const word of ['birlestir', 'birlest', 'irlestir']) {
    await search(page, word);
    await expect(palette(page).getByRole('option', { name: /Merge/ }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
  }
});

test('clicking a command runs it once and the palette lists it first on the next empty search', async ({
  page,
}) => {
  await openPdf(page);
  await search(page, 'Merge PDFs');
  const option = palette(page)
    .getByRole('option', { name: /Merge PDFs/ })
    .first();
  await expect(option).toBeEnabled();
  await option.click();
  await expect(palette(page)).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Merge PDFs' })).toHaveCount(1);
  const stored = await page.evaluate(() => localStorage.getItem('pdf-editor.recent-commands'));
  expect(JSON.parse(stored ?? '[]')).toHaveLength(1);
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole('option').first()).toContainText('Merge PDFs');
});

test('a damaged list of recent commands is ignored', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pdf-editor.recent-commands', '{"not":"a list"}'));
  await openPdf(page);
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(count(page)).toBeVisible();
  await expect(palette(page).getByRole('option').first()).toBeVisible();
});

test('in the simple mode a command only the advanced mode has is counted, and the button switches the mode', async ({
  page,
}) => {
  await openPdf(page, 'doc.pdf', undefined, { advanced: false });
  await search(page, 'Redaction audit');
  await expect(palette(page).getByText('No matching commands.')).toBeVisible();
  await expect(palette(page).getByText(/more command\(s\) are hidden by the simple mode\./)).toBeVisible();
  await palette(page).getByRole('button', { name: 'Advanced mode' }).click();
  await expect(palette(page).getByRole('option').first()).toBeVisible();
  await expect(palette(page).getByText('No matching commands.')).toHaveCount(0);
});
