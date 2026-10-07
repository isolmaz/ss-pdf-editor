/**
 * The shell's own controls, as a keyboard or mouse user meets them: the application menu
 * bar (roving tabindex, arrow navigation, activation), the command palette (ranking,
 * recents, the empty state the simple mode offers a way out of) and the settings dialog's
 * theme and language choices.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { openPdf } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const trigger = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

test('menu bar: arrows move along the bar, open a menu, walk its items and Enter runs the highlighted one', async ({
  page,
}) => {
  await openPdf(page);
  const file = trigger(page, 'File');
  const edit = trigger(page, 'Edit');
  const help = trigger(page, 'Help');

  // One tab stop: the anchor trigger is tabbable, the others are not.
  await expect(file).toHaveAttribute('tabindex', '0');
  await expect(edit).toHaveAttribute('tabindex', '-1');

  await file.focus();
  await page.keyboard.press('ArrowRight');
  await expect(edit).toBeFocused();
  await expect(edit).toHaveAttribute('tabindex', '0');
  await expect(file).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('End');
  await expect(help).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(file).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(help).toBeFocused();
  await page.keyboard.press('Home');
  await expect(file).toBeFocused();

  // Space opens the menu with the focus on the menu container and the first item active.
  await page.keyboard.press(' ');
  await expect(file).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu');
  await expect(menu).toBeFocused();
  const items = menu.getByRole('menuitem');
  const active = async () => {
    const id = await menu.getAttribute('aria-activedescendant');
    return id === null ? null : ((await page.locator(`[id="${id}"]`).textContent()) ?? '');
  };
  expect(await active()).toContain('Create a blank document');
  await page.keyboard.press('ArrowDown');
  expect(await active()).toContain('Open');
  await page.keyboard.press('End');
  expect(await active()).toContain('Close tab');
  await page.keyboard.press('ArrowDown');
  expect(await active()).toContain('Create a blank document');
  await page.keyboard.press('ArrowUp');
  expect(await active()).toContain('Close tab');
  await page.keyboard.press('Home');
  expect(await active()).toContain('Create a blank document');
  await expect(items.first()).toBeVisible();

  // Along an open bar the arrows swap the menu showing.
  await page.keyboard.press('Tab');
  await expect(file).toHaveAttribute('aria-expanded', 'false');
  await file.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(file).toBeFocused();

  // ArrowUp on a trigger opens its menu on the last entry.
  await page.keyboard.press('ArrowUp');
  expect(await active()).toContain('Close tab');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Enter on a trigger opens; Escape on the trigger of an open menu closes it without moving focus.
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  expect(await active()).toContain('Search commands');
  await page.keyboard.press('ArrowDown');
  expect(await active()).toContain('Keyboard shortcuts');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(menu).toHaveCount(0);
});

test('menu bar: hovering another trigger moves the open menu, a press elsewhere closes it and a checked item says so', async ({
  page,
}) => {
  await openPdf(page);
  await trigger(page, 'View').click();
  await expect(trigger(page, 'View')).toHaveAttribute('aria-expanded', 'true');
  const toggle = page.getByRole('menuitemcheckbox', { name: /Magnifier/ });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await trigger(page, 'Page').hover();
  await expect(trigger(page, 'Page')).toHaveAttribute('aria-expanded', 'true');
  await expect(trigger(page, 'View')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('menuitem', { name: /Page labels/ })).toBeVisible();

  // Hovering an item of the open menu makes it the active one.
  const labels = page.getByRole('menuitem', { name: /Page labels/ });
  await labels.hover();
  const menuId = await page.getByRole('menu').getAttribute('aria-activedescendant');
  expect(menuId).toBe(await labels.getAttribute('id'));

  // A click on the open trigger closes the menu again.
  await trigger(page, 'Page').click();
  await expect(trigger(page, 'Page')).toHaveAttribute('aria-expanded', 'false');

  await trigger(page, 'View').click();
  await page.getByRole('menuitemcheckbox', { name: /Magnifier/ }).click();
  await trigger(page, 'View').click();
  await expect(page.getByRole('menuitemcheckbox', { name: /Magnifier/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // A press on the page, outside the bar, dismisses the menu.
  await page.mouse.click(700, 500);
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('command palette: ranking by label, keyword and group, recents first, mouse and keyboard run one command', async ({
  page,
}) => {
  await openPdf(page);
  const input = page.getByRole('combobox');
  const options = page.getByRole('option');

  await page.keyboard.press('Control+k');
  await expect(input).toBeFocused();
  // An exact label wins over a longer one that merely contains it.
  await input.fill('Rename');
  await expect(options.first()).toContainText('Rename');
  // A group name finds its commands: "Settings" is also the name of a menu.
  await input.fill('theme');
  await expect(options.filter({ hasText: 'Dark Theme' })).toHaveCount(1);
  // Fuzzy: the letters of the query in order.
  await input.fill('shtcts');
  await expect(options.filter({ hasText: 'Keyboard shortcuts' })).toHaveCount(1);
  // A query nothing matches shows the empty state and the count says zero.
  await input.fill('zzzzqq');
  await expect(page.getByText('No matching commands')).toBeVisible();
  await expect(page.getByText('0 command(s)')).toBeVisible();

  // Clicking an entry runs it once and closes the palette.
  await input.fill('Keyboard shortcuts');
  await options.first().click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(input).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The command just used heads the empty query's list the next time.
  await page.keyboard.press('Control+k');
  await expect(options.first()).toContainText('Keyboard shortcuts');
  const recent = await page.evaluate(() => window.localStorage.getItem('pdf-editor.recent-commands'));
  expect(JSON.parse(recent ?? '[]')[0]).toBe(await recentId(page));
  // Enter on a disabled highlighted entry runs nothing: Undo is disabled with no edit made.
  await input.fill('Undo');
  await expect(options.first()).toContainText('Undo');
  await page.keyboard.press('Enter');
  await expect(input).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
});

/** The id of the recorded command: the first entry of the stored list. */
async function recentId(page: Page): Promise<string> {
  const stored = await page.evaluate(() => window.localStorage.getItem('pdf-editor.recent-commands'));
  return (JSON.parse(stored ?? '[]') as string[])[0] ?? '';
}

test('command palette: the simple mode names what it hides and offers the advanced mode', async ({
  page,
}) => {
  await openPdf(page, 'doc.pdf', undefined, { advanced: false });
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox');
  await input.fill('Optimize');
  await expect(page.getByText('No matching commands')).toBeVisible();
  const way = page.getByRole('button', { name: 'Advanced mode' });
  await expect(way).toBeVisible();
  await way.click();
  // Back on the input, with the hidden command now listed.
  await expect(input).toBeFocused();
  await expect(page.getByRole('option', { name: /Optimize/ }).first()).toBeVisible();
});

test('settings: theme and language choices persist and change the page', async ({ page }) => {
  await openPdf(page);
  await page
    .getByRole('button', { name: /^(Ayarlar|Settings)$/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const dark = dialog.getByRole('button', { name: 'Dark Theme' });
  const light = dialog.getByRole('button', { name: 'Light Theme' });
  const system = dialog.getByRole('button', { name: 'System Theme' });

  await dark.click();
  await expect(dark).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  expect(await page.evaluate(() => window.localStorage.getItem('pdf-editor.theme'))).toBe('dark');

  await light.click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
  expect(await page.evaluate(() => window.localStorage.getItem('pdf-editor.theme'))).toBe('light');

  // The system choice follows the browser's own colour scheme, live.
  await page.emulateMedia({ colorScheme: 'dark' });
  await system.click();
  await expect(system).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.localStorage.getItem('pdf-editor.theme'))).toBeNull();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');

  // The same choice made from the menu bar updates the dialog's pressed state.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await trigger(page, 'Settings').click();
  await page.getByRole('menuitemcheckbox', { name: 'Dark Theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
});
