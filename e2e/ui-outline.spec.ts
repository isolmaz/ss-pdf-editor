/**
 * The outline view of the left dock and the tab strip around the dock's views: the bookmark
 * tree of the file as nested entries that go to their page (an entry with no destination
 * cannot), the page the viewer shows marked as current, the way into the outline editor, and
 * the views the simple mode keeps.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { openDockTab, openPdf } from './ui-helpers';
import { withOutline } from './ui-panels9-helpers';
import { viewingOnlyFixture } from './ui-tags-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const outline = (page: Page): Locator => page.getByRole('navigation', { name: 'Outline' });
const pageNumber = (page: Page): Locator => page.getByRole('textbox', { name: 'Page number' });
const settings = (page: Page): Locator => page.getByRole('dialog', { name: /Settings/ });

const BOOKMARKS = [
  {
    title: 'Chapter one',
    page: 1,
    children: [
      { title: 'Section 1.1', page: 2 },
      { title: 'Loose note', page: null },
    ],
  },
  { title: 'Chapter two', page: 3 },
] as const;

test('the bookmarks are shown nested; an entry goes to its page and marks it, one without a destination cannot', async ({
  page,
}) => {
  await openPdf(page, 'book.pdf', await withOutline(labelledPdf('Doc', 3), BOOKMARKS));
  await openDockTab(page, 'Outline');
  await expect(outline(page).getByRole('button')).toHaveText([
    'Chapter one',
    'Section 1.1',
    'Loose note',
    'Chapter two',
  ]);
  // The nested entries sit in a list of their own below their parent.
  await expect(outline(page).locator('ul ul').getByRole('button')).toHaveText(['Section 1.1', 'Loose note']);
  await expect(outline(page).getByRole('button', { name: 'Chapter one' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(outline(page).getByRole('button', { name: 'Loose note' })).toBeDisabled();

  await outline(page).getByRole('button', { name: 'Chapter two' }).click();
  await expect(pageNumber(page)).toHaveValue('3');
  await expect(outline(page).getByRole('button', { name: 'Chapter two' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(outline(page).getByRole('button', { name: 'Chapter one' })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
  await outline(page).getByRole('button', { name: 'Section 1.1' }).click();
  await expect(pageNumber(page)).toHaveValue('2');
  await expect(outline(page).getByRole('button', { name: 'Section 1.1' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('a document with no bookmarks says so, and Edit outline opens the editor on it', async ({ page }) => {
  await openPdf(page, 'plain.pdf', labelledPdf('Doc', 2));
  await openDockTab(page, 'Outline');
  await expect(page.getByText('This document has no outline.')).toBeVisible();
  await expect(outline(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit outline' }).click();
  await expect(page.getByRole('region', { name: 'Edit outline (bookmarks)' })).toBeVisible({
    timeout: 30_000,
  });
});

test.describe('a document that is only viewed', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });

  test('keeps the bookmarks readable but cannot edit them', async ({ page }) => {
    await openPdf(page, 'long.pdf', await withOutline(await viewingOnlyFixture(), BOOKMARKS));
    await openDockTab(page, 'Outline');
    await expect(outline(page).getByRole('button', { name: 'Chapter one' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit outline' })).toBeDisabled();
  });
});

test('the simple mode keeps Pages, Outline and Results; a view it drops gives way to the first', async ({
  page,
}) => {
  await openPdf(page, 'book.pdf', await withOutline(labelledPdf('Doc', 3), BOOKMARKS));
  await expect(page.getByRole('tab', { name: 'Layers', exact: true })).toBeVisible();

  await page
    .getByRole('button', { name: /^(Settings|Ayarlar)$/ })
    .first()
    .click();
  await settings(page)
    .getByRole('radio', { name: /Simple mode|Basit mod/ })
    .check();
  await settings(page)
    .getByRole('button', { name: /^(Close|Kapat)$/ })
    .click();
  await expect(settings(page)).toBeHidden();

  await expect(page.getByRole('tab', { name: 'Attachments', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Layers', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Pages', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab', { name: 'Outline', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Results', exact: true })).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Pages' })).toBeVisible();
});
