/**
 * The PDF/A tab of the right dock: a check of a file that does not claim PDF/A, the level
 * picker, the clauses and samples of broken rules, and the "and N more" tail.
 */

import { expect, test } from './test';
import { toolFixturePdf } from './tool-fixture';
import { openDockTab, openPdf } from './ui-helpers';
import { manyFontsPdf } from './ui-panels15c-helpers';

test('a file that does not claim PDF/A is checked against PDF/A-2b and its broken rules are listed with their clause', async ({
  page,
}) => {
  await openPdf(page, 'plain.pdf', toolFixturePdf());
  await openDockTab(page, 'PDF/A');
  await expect(page.getByText(/Press .Check. to start\.$/)).toBeVisible();
  await page.getByRole('button', { name: 'Check', exact: true }).click();

  await expect(page.getByText('The file does not say it is PDF/A (no pdfaid in its XMP).')).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText(/^It was checked against PDF\/A-2b anyway: \d+ violation\(s\) found\.$/),
  ).toBeVisible();
  const broken = page.getByRole('heading', { name: /^Rules that are broken \(\d+\)$/ });
  await expect(broken).toBeVisible();
  const clauses = page.getByText(/^ISO 19005-2, clause /);
  expect(await clauses.count()).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'What this check does not look at' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Rules that pass \(\d+\)$/ })).toBeVisible();

  // The same file against PDF/A-1b cites the first edition's clauses.
  await page.getByLabel('Level to check').selectOption('1');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByText(/^It was checked against PDF\/A-1b anyway/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^ISO 19005-1, clause /).first()).toBeVisible();
  await expect(page.getByText(/^ISO 19005-2, clause /)).toHaveCount(0);
});

test('a rule broken many times lists a few samples with their page and says how many more there are', async ({
  page,
}) => {
  await openPdf(page, 'fonts.pdf', manyFontsPdf());
  await openDockTab(page, 'PDF/A');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  const more = page.getByText(/^and \d+ more$/);
  await expect(more.first()).toBeVisible({ timeout: 60_000 });
  const line = (await more.first().innerText()).match(/\d+/);
  expect(Number(line?.[0])).toBeGreaterThanOrEqual(2);
  await expect(page.getByText(/^Page 1$/).first()).toBeVisible();
});
