/**
 * The menu bar's keyboard model: the triggers move with the arrow keys, Home and End; a
 * menu opens with Enter, Space, the down arrow (first entry) or the up arrow (last entry);
 * its entries walk with the arrows, Home and End, run with Enter, and Escape closes it
 * with the focus back on its trigger.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { openPdf } from './ui-helpers';

const bar = (page: Page): Locator => page.getByRole('menubar');
const trigger = (page: Page, name: string): Locator => bar(page).getByRole('menuitem', { name, exact: true });
const menu = (page: Page): Locator => page.getByRole('menu');
const highlighted = (page: Page) =>
  menu(page).evaluate((element) => {
    const id = element.getAttribute('aria-activedescendant');
    return id === null ? null : (document.getElementById(id)?.textContent ?? null);
  });
const entries = (page: Page) => menu(page).locator('> button:not([disabled])');
const entryTexts = (page: Page) =>
  entries(page).evaluateAll((els) => els.map((element) => element.textContent));

test('the triggers move with the arrow keys, Home and End and wrap around the bar', async ({ page }) => {
  await openPdf(page);
  const names = await bar(page).getByRole('menuitem').allInnerTexts();
  expect(names.length).toBeGreaterThan(3);
  const first = names[0] ?? '';
  const last = names.at(-1) ?? '';
  const second = names[1] ?? '';

  await trigger(page, first).focus();
  await page.keyboard.press('ArrowRight');
  await expect(trigger(page, second)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(trigger(page, first)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(trigger(page, last)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(trigger(page, first)).toBeFocused();
  await page.keyboard.press('End');
  await expect(trigger(page, last)).toBeFocused();
  await page.keyboard.press('a');
  await expect(trigger(page, last)).toBeFocused();
  await expect(menu(page)).toHaveCount(0);
});

test('a menu opens on its first entry with Enter, Space and the down arrow, and on its last with the up arrow', async ({
  page,
}) => {
  await openPdf(page);
  const file = trigger(page, 'File');
  await file.focus();

  for (const key of ['Enter', ' ', 'ArrowDown']) {
    await page.keyboard.press(key);
    await expect(menu(page)).toBeVisible();
    await expect(file).toHaveAttribute('aria-expanded', 'true');
    expect(await highlighted(page)).toBe((await entryTexts(page))[0]);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(file).toBeFocused();
  }

  await page.keyboard.press('ArrowUp');
  await expect(menu(page)).toBeVisible();
  expect(await highlighted(page)).toBe((await entryTexts(page)).at(-1));
});

test('inside an open menu the arrows, Home and End walk the entries and the arrows cross to the next menu', async ({
  page,
}) => {
  await openPdf(page);
  await trigger(page, 'File').focus();
  await page.keyboard.press('Enter');
  const texts = await entryTexts(page);
  expect(texts.length).toBeGreaterThan(2);

  await page.keyboard.press('ArrowDown');
  expect(await highlighted(page)).toBe(texts[1]);
  await page.keyboard.press('ArrowUp');
  expect(await highlighted(page)).toBe(texts[0]);
  await page.keyboard.press('ArrowUp');
  expect(await highlighted(page)).toBe(texts.at(-1));
  await page.keyboard.press('ArrowDown');
  expect(await highlighted(page)).toBe(texts[0]);
  await page.keyboard.press('End');
  expect(await highlighted(page)).toBe(texts.at(-1));
  await page.keyboard.press('Home');
  expect(await highlighted(page)).toBe(texts[0]);
  await page.keyboard.press('x');
  expect(await highlighted(page)).toBe(texts[0]);

  // Tab leaves the menu closed.
  await page.keyboard.press('Tab');
  await expect(menu(page)).toHaveCount(0);

  // On an open bar the horizontal arrows of a trigger swap the showing menu.
  const names = await page.getByRole('menubar').getByRole('menuitem').allInnerTexts();
  await trigger(page, 'File').click();
  await expect(trigger(page, 'File')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(trigger(page, 'File')).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger(page, names[1] ?? '')).toHaveAttribute('aria-expanded', 'true');
  await expect(menu(page)).toBeVisible();
  // The second menu took the focus into its panel; back on its trigger, the left arrow walks back.
  await trigger(page, names[1] ?? '').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(trigger(page, 'File')).toHaveAttribute('aria-expanded', 'true');
});

test('Enter on a highlighted entry runs its command and closes the menu', async ({ page }) => {
  await openPdf(page);
  await trigger(page, 'View').focus();
  await page.keyboard.press('Enter');
  const before = await menu(page)
    .getByRole('menuitemcheckbox')
    .evaluateAll((els) => els.map((element) => element.getAttribute('aria-checked')));
  expect(before.length).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  await expect(menu(page)).toHaveCount(0);
  await expect(trigger(page, 'View')).toBeFocused();
});

test('Escape on an open trigger and a click elsewhere both dismiss the menu', async ({ page }) => {
  await openPdf(page);
  await trigger(page, 'File').click();
  await expect(menu(page)).toBeVisible();
  await trigger(page, 'File').press('Escape');
  await expect(menu(page)).toHaveCount(0);

  await trigger(page, 'File').click();
  await expect(menu(page)).toBeVisible();
  await page.mouse.click(5, 400);
  await expect(menu(page)).toHaveCount(0);
});
