import type { Page } from 'playwright/test';
import {
  CANVAS,
  installPickers,
  notice,
  openApp,
  rotateCurrentPage,
  settled,
  stageFile,
} from './app-helpers';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';

/**
 * The home screen (`HomeScreen`, `HomeToolGrid`) and what it starts: the recent list with its
 * star, search, sort, remove and clear controls; reopening an entry from its stored file
 * handle, from the browser's own copy, or through the picker; and picking a tool first.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const rows = (page: Page) => page.getByRole('table').getByRole('row');
const names = async (page: Page) =>
  (await page.getByRole('table').locator('tbody tr td:nth-child(2) span.truncate').allTextContents()).map(
    (text) => text.trim(),
  );

async function openThree(page: Page): Promise<void> {
  await openApp(page, 'alpha.pdf', labelledPdf('Alpha', 1), { advanced: false });
  await openApp(page, 'bravo.pdf', labelledPdf('Bravo', 3), { advanced: false, navigate: false });
  await openApp(page, 'charlie.pdf', labelledPdf('Charlie', 2), { advanced: false, navigate: false });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Start' })).toHaveAttribute('aria-selected', 'true');
}

test('the recent list: open badges, star, starred tab, search, sort, remove and clear', async ({ page }) => {
  await openThree(page);
  await expect(rows(page)).toHaveCount(4);
  expect(await names(page)).toEqual(['charlie.pdf', 'bravo.pdf', 'alpha.pdf']);
  // All three are open in tabs.
  await expect(page.getByRole('table').getByText('Open', { exact: true })).toHaveCount(3);

  await page.getByRole('button', { name: 'Star', exact: true }).nth(1).click();
  await expect(page.getByRole('button', { name: 'Unstar', exact: true })).toHaveCount(1);
  await page.getByRole('tab', { name: 'Starred' }).click();
  expect(await names(page)).toEqual(['bravo.pdf']);
  await page.getByRole('tab', { name: 'Recent' }).click();

  await page.getByRole('searchbox', { name: 'Search recent documents…' }).fill('ALPH');
  expect(await names(page)).toEqual(['alpha.pdf']);
  await page.getByRole('searchbox', { name: 'Search recent documents…' }).fill('nothing like it');
  await expect(page.getByText('No document matches your search.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search recent documents…' }).fill('');

  const sort = page.getByRole('combobox', { name: 'Sort' });
  await sort.selectOption('name');
  expect(await names(page)).toEqual(['alpha.pdf', 'bravo.pdf', 'charlie.pdf']);
  await sort.selectOption('size');
  expect(await names(page)).toEqual(['bravo.pdf', 'charlie.pdf', 'alpha.pdf']);
  await sort.selectOption('date');
  expect(await names(page)).toEqual(['charlie.pdf', 'bravo.pdf', 'alpha.pdf']);

  await page.getByRole('button', { name: 'Remove from list: alpha.pdf' }).click();
  expect(await names(page)).toEqual(['charlie.pdf', 'bravo.pdf']);

  // Clearing asks first; "Cancel" keeps the list.
  await page.getByRole('button', { name: 'Clear list' }).click();
  await expect(page.getByRole('alert')).toContainText('Your files are not deleted.');
  await page.getByRole('alert').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await names(page)).toHaveLength(2);
  await page.getByRole('button', { name: 'Clear list' }).click();
  await page.getByRole('alert').getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByText('No recent documents.')).toBeVisible();

  // Starred with nothing starred says so.
  await page.getByRole('tab', { name: 'Starred' }).click();
  await expect(page.getByText('No starred documents yet.')).toBeVisible();
});

test('an entry that is open in a tab is brought forward, with "Back to document" on the way home', async ({
  page,
}) => {
  await openThree(page);
  await expect(page.getByRole('button', { name: 'Back to document (charlie.pdf)' })).toBeVisible();
  await page.getByRole('button', { name: 'Open alpha.pdf' }).click();
  await expect(page.locator(CANVAS).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^alpha\.pdf/ }).first()).toBeVisible();
  // The one-page document: the page counter says so.
  await expect(page.getByRole('textbox', { name: 'Page number' })).toBeVisible();
  await expect(page.getByText('/ 1', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Back to document (alpha.pdf)' }).click();
  await expect(page.locator(CANVAS).first()).toBeVisible();
});

test('an entry with no stored file handle reopens from the browser copy, or asks for the file', async ({
  page,
}) => {
  await installPickers(page);
  await openApp(page, 'drafted.pdf', labelledPdf('Drafted', 2), { advanced: false });
  await rotateCurrentPage(page);
  // The automatic save of the draft runs after a short pause; wait for the manifest that
  // records the rotation (a manifest of the untouched document exists before that).
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const drafts = await (
          await (await root.getDirectoryHandle('pdf-editor')).getDirectoryHandle('drafts')
        ).entries();
        for await (const [, entry] of drafts) {
          if (entry.kind !== 'file') continue;
          const text = await (await (entry as FileSystemFileHandle).getFile()).text();
          if (text.includes('"dirty":true')) return true;
        }
        return false;
      }),
    )
    .toBe(true);
  await page.reload();
  await expect(notice(page, 'draft(s) restored')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Open drafted.pdf' })).toBeVisible();
  await expect(page.getByRole('table').getByText('Open', { exact: true })).toBeVisible();

  // A document closed for good leaves no copy: the entry then asks for the file.
  await page.getByRole('button', { name: 'Back to document (drafted.pdf)' }).click();
  await page
    .getByRole('button', { name: /^drafted\.pdf/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Close tab' }).click();
  await page.getByRole('button', { name: 'Close without saving' }).click();
  await expect(page.getByRole('button', { name: 'Open drafted.pdf' })).toBeVisible();
  await stageFile(page, 'open', 'drafted.pdf', labelledPdf('Drafted', 4));
  await page.getByRole('button', { name: 'Open drafted.pdf' }).click();
  await settled(page);
  await expect(page.getByText('/ 4', { exact: true })).toBeVisible();
});

test('All tools: the search narrows the grid, and a tool picked with no document asks for the file first', async ({
  page,
}) => {
  await installPickers(page);
  await page.goto('/editor/');
  await page.getByRole('tab', { name: 'All tools' }).click();
  await expect(
    page.getByText('Pick a tool; if it needs a document, we ask for your file first.'),
  ).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search tools…' });
  await search.fill('zzzz-no-tool');
  await expect(page.getByText('No tool matches your search.')).toBeVisible();
  await search.fill('watermark');
  const tiles = page.getByRole('list').getByRole('button');
  await expect(tiles).toHaveCount(1);
  // A dismissed picker opens nothing and drops the tool.
  await tiles.first().click();
  await expect(page.locator(CANVAS)).toHaveCount(0);

  // The picker opens first; the chosen file arrives and the tool then opens on it.
  await stageFile(page, 'open', 'tool.pdf', labelledPdf('Tool', 2));
  await tiles.first().click();
  await settled(page);
  await expect(page.getByRole('region', { name: /Watermark/ })).toBeVisible({ timeout: 30_000 });
});

test('All tools with a document open: its name is shown and a tool runs on it', async ({ page }) => {
  await openApp(page, 'grid.pdf', labelledPdf('Grid', 2), { advanced: false });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('tab', { name: 'All tools' }).click();
  await expect(page.getByText('Tools apply to the open document: grid.pdf')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search tools…' }).fill('properties');
  await page.getByRole('list').getByRole('button').first().click();
  await expect(page.locator(CANVAS).first()).toBeVisible();
  await expect(page.getByRole('region', { name: /Document properties/ })).toBeVisible({ timeout: 30_000 });
});

test('the start cards: a blank document, a picked file and the command palette from the home header', async ({
  page,
}) => {
  await installPickers(page);
  await page.goto('/editor/');
  await page.getByRole('button', { name: 'Blank document' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Command palette (Ctrl+K)' }).first().click();
  await expect(page.getByRole('combobox')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /Settings/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await stageFile(page, 'open', 'card.pdf', labelledPdf('Card', 1));
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await settled(page);
  await expect(page.getByText('/ 1', { exact: true })).toBeVisible();
});
