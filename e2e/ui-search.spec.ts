/**
 * The search view of the left dock: every match of a query as a list of the pages it sits on,
 * the count and the "searching" state, the result a click jumps to (and the page it marks as
 * current), and the queries the panel remembers.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { openDockTab, openPdf } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const box = (page: Page): Locator => page.getByRole('textbox', { name: 'Find in document' }).first();
const results = (page: Page): Locator => page.getByRole('list', { name: 'Results' }).getByRole('listitem');
const pageBox = (page: Page): Locator => page.getByRole('textbox', { name: 'Page number' });

test('typing lists every match with its page and the count, and a query without a hit says so', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Results');
  await expect(page.getByText('No matches.')).toBeVisible();

  await box(page).fill('line');
  await expect(page.getByText('5 matches', { exact: true })).toBeVisible();
  await expect(results(page)).toHaveCount(5);
  // Each result shows its page and the matched word, set apart from the text around it.
  await expect(results(page).nth(0)).toContainText('1Fixture line one reads clearly');
  await expect(results(page).nth(0).locator('span span').last()).toHaveText('line');
  await expect(results(page).nth(4)).toContainText('2Second page anchor line');
  await expect(results(page).nth(4).getByRole('button')).toHaveAttribute('title', 'Go to page 2');

  await box(page).fill('zzzqx');
  await expect(page.getByText('0 matches', { exact: true })).toBeVisible();
  await expect(page.getByText('No matches.')).toBeVisible();
  await expect(results(page)).toHaveCount(0);

  // Clearing the box clears the count: nothing is claimed for text that is no longer there.
  await box(page).fill('');
  await expect(page.getByText(/\d+ matches/)).toHaveCount(0);
  await expect(page.getByText('No matches.')).toBeVisible();
});

test('Enter searches at once; a result takes the viewer to its page and marks the page it sits on', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Results');
  await box(page).fill('anchor');
  await box(page).press('Enter');
  await expect(results(page)).toHaveCount(1);
  await expect(page.getByText('1 matches', { exact: true })).toBeVisible();
  await expect(pageBox(page)).toHaveValue('1');
  await expect(results(page).getByRole('button')).not.toHaveAttribute('aria-current', 'page');

  await results(page).getByRole('button').click();
  await expect(pageBox(page)).toHaveValue('2');
  await expect(results(page).getByRole('button')).toHaveAttribute('aria-current', 'page');
  // The viewer's own find layer marks the query on the page the click went to.
  await expect(page.locator('.pdfViewer[data-active-viewer] .textLayer .highlight').first()).toBeVisible();
});

test('a query searched before is answered again, and a query typed over another replaces its answer', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Results');
  await box(page).fill('line');
  await expect(results(page)).toHaveCount(5);
  await box(page).fill('second');
  await expect(results(page)).toHaveCount(2);
  await box(page).fill('line');
  await expect(page.getByText('5 matches', { exact: true })).toBeVisible();
  await expect(results(page)).toHaveCount(5);

  // More queries than the panel remembers: the oldest is read again, with the same answer.
  for (const query of ['third', 'fourth', 'fixture', 'untouched']) {
    await box(page).fill(query);
    await expect(results(page)).toHaveCount(1);
  }
  await box(page).fill('line');
  await expect(results(page)).toHaveCount(5);
});

test('a query typed and replaced before the scan ends leaves only the last answer', async ({ page }) => {
  await openPdf(page);
  await openDockTab(page, 'Results');
  await box(page).fill('line');
  await box(page).press('Enter');
  await box(page).fill('anchor');
  await box(page).press('Enter');
  await expect(page.getByText('1 matches', { exact: true })).toBeVisible();
  await expect(results(page)).toHaveCount(1);
  await expect(results(page)).toContainText('Second page anchor line');
});
