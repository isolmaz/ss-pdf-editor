/**
 * The editor header at every width, the settings dialog's language and theme controls (the
 * choice applies to the page and survives a reload) and the command palette's search, mouse
 * activation, stored recents and the simple-mode hint.
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

/** The editor header at `width`: nothing scrolls sideways, the file actions are on screen, the name keeps room. */
async function expectHeaderFits(
  page: Page,
  width: number,
  names: {
    readonly open: string;
    readonly exportName: string;
    readonly options: string;
    readonly settings: string;
  },
): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  const header = page.locator('header');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), {
      message: `the page scrolls sideways at ${width} px`,
    })
    .toBe(true);
  expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const name of [names.open, names.exportName, names.options, names.settings]) {
    const box = await header.getByRole('button', { name, exact: true }).boundingBox();
    expect(box, `${name} is not rendered at ${width} px`).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width, `${name} at ${width} px`).toBe(
      true,
    );
  }
  const switcher = await header.getByRole('button', { name: /^a-long-document-name/ }).boundingBox();
  expect(switcher?.width ?? 0, `the document name at ${width} px`).toBeGreaterThanOrEqual(64);
}

test('the editor header fits every width from a phone to a wide screen and keeps the file actions on screen', async ({
  page,
}) => {
  await openPdf(page, 'a-long-document-name-that-has-to-be-cut-short.pdf');
  const english = { open: 'Open', exportName: 'Export', options: 'Export Options', settings: 'Settings' };
  for (const width of [320, 375, 768, 900, 1024, 1280, 1366, 1439, 1440, 1536]) {
    await expectHeaderFits(page, width, english);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await useLanguage(page, 'Türkçe');
  const turkish = {
    open: 'Aç',
    exportName: 'Dışa aktar',
    options: 'Dışa Aktarma Seçenekleri',
    settings: 'Ayarlar',
  };
  for (const width of [320, 768, 1024, 1280, 1366, 1439, 1440, 1536]) {
    await expectHeaderFits(page, width, turkish);
  }
});

test('the task buttons name themselves from 1280 px and the file actions from 1440 px', async ({ page }) => {
  await openPdf(page);
  const header = page.locator('header');
  const tasks = header.getByRole('navigation', { name: 'Tasks' });
  const labels = ['Tools', 'Read', 'Edit', 'Convert', 'Sign'];
  for (const [width, tasksNamed, filesNamed] of [
    [1279, false, false],
    [1280, true, false],
    [1439, true, false],
    [1440, true, true],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    for (const label of labels) {
      await expect(tasks.getByText(label, { exact: true }), `${label} at ${width} px`).toBeVisible({
        visible: tasksNamed,
      });
    }
    for (const label of ['Open', 'Export']) {
      await expect(header.getByText(label, { exact: true }), `${label} at ${width} px`).toBeVisible({
        visible: filesNamed,
      });
    }
  }
});

test('the status bar keeps the limit profile and the memory meter out of sight while they do not matter', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPdf(page);
  const bar = page.getByRole('contentinfo');
  await expect(bar.getByText('The document never leaves your device.')).toBeVisible();
  await expect(bar.getByText('Desktop limits')).toHaveCount(0);
  await expect(bar.locator('[title^="Memory:"]')).toHaveCount(0);
});

test('on a phone the tool rail is a toolbar under the document that scrolls sideways, and every tool is reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await openPdf(page);
  const rail = page.getByRole('navigation', { name: 'ALL TOOLS' });
  const bar = page.getByRole('contentinfo');
  const railBox = await rail.boundingBox();
  const barBox = await bar.boundingBox();
  const headerBox = await page.locator('header').boundingBox();
  expect(railBox?.x).toBe(0);
  expect(railBox?.width).toBe(375);
  expect(railBox?.y ?? 0).toBeGreaterThan((headerBox?.y ?? 0) + (headerBox?.height ?? 0) + 100);
  expect((railBox?.y ?? 0) + (railBox?.height ?? 0)).toBeCloseTo(barBox?.y ?? 0, 0);
  expect(await rail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The document has the whole width, and the last tool is one scroll away.
  const pageBox = await page.locator('.pdfViewer[data-active-viewer] .page').first().boundingBox();
  expect(pageBox?.width ?? 0).toBeGreaterThan(375 * 0.85);
  const redact = rail.getByRole('button', { name: /^Redact/ });
  await redact.scrollIntoViewIfNeeded();
  await redact.click();
  await expect(redact).toHaveAttribute('aria-pressed', 'true');
});

test('from 640 px the tool rail is a column beside the document, with buttons a mouse can hit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPdf(page);
  const rail = page.getByRole('navigation', { name: 'ALL TOOLS' });
  const box = await rail.boundingBox();
  expect(box?.width).toBe(48);
  expect(box?.height ?? 0).toBeGreaterThan(300);
  const select = await rail.getByRole('button', { name: 'Selection Tool' }).boundingBox();
  expect([select?.width, select?.height]).toEqual([36, 36]);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

  test('the rail and the status bar buttons are at least 40 px, and the bar scrolls instead of cutting controls off', async ({
    page,
  }) => {
    await openPdf(page);
    for (const buttons of [
      page.getByRole('navigation', { name: 'ALL TOOLS' }).getByRole('button'),
      page.getByRole('contentinfo').getByRole('button'),
    ]) {
      const boxes = await buttons.evaluateAll((elements) =>
        elements.map((element) => {
          const { width, height } = element.getBoundingClientRect();
          return { name: element.getAttribute('aria-label'), width, height };
        }),
      );
      expect(boxes.length).toBeGreaterThan(5);
      expect(boxes.filter((box) => box.width < 40 || box.height < 40)).toEqual([]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const bar = page.getByRole('contentinfo');
    expect(await bar.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect((await bar.boundingBox())?.height).toBe(44);
  });

  test('the home screen asks to open a PDF, lists the start cards compactly and shows the recent list without scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/editor/');
    const zone = page.locator('label', { hasText: 'Open a PDF' });
    await expect(zone.getByText('Open a PDF', { exact: true })).toBeVisible();
    await expect(zone.getByText('Open a PDF or drop it here')).toBeHidden();
    for (const card of ['Blank document', 'Merge PDFs']) {
      const box = await page.getByRole('button', { name: new RegExp(`^${card}`) }).boundingBox();
      expect(box?.height ?? 0).toBeLessThanOrEqual(60);
    }
    const recent = await page.getByRole('tab', { name: 'Recent' }).boundingBox();
    expect((recent?.y ?? 0) + (recent?.height ?? 0)).toBeLessThanOrEqual(667 - 44);
  });
});

test('with a mouse the drop zone also says the file can be dropped', async ({ page }) => {
  await page.goto('/editor/');
  const zone = page.locator('label', { hasText: 'Open a PDF' });
  await expect(zone.getByText('Open a PDF or drop it here')).toBeVisible();
  await expect(zone.getByText('Open a PDF', { exact: true })).toBeHidden();
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
  await expect(
    palette(page).getByText(/more matching command\(s\) are hidden by the simple mode\./),
  ).toBeVisible();
  await palette(page).getByRole('button', { name: 'Advanced mode' }).click();
  await expect(palette(page).getByRole('option').first()).toBeVisible();
  await expect(palette(page).getByText('No matching commands.')).toHaveCount(0);
});
