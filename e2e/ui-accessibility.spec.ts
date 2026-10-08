/**
 * The accessibility panel of the right dock: the three views and their keyboard, the audit
 * report with the figures' alternative text and the tagging of the document, and the PDF/UA
 * view — its rules grouped and filtered, opened and folded, the quick fixes each rule offers
 * and the jumps to a page or to the element in the Tags view. A fix is checked on the file it
 * wrote (the rule passes when the produced file is audited again, and the entry is read back
 * with MuPDF); the panel only ever shows what the audit of the working file says.
 */

import type { Locator, Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { readProducedEntry, readProducedPdf, toolFixturePdf } from './tool-fixture';
import { exportBytes, openPdf } from './ui-helpers';
import { taggedFixture, untaggedFixture, viewingOnlyFixture } from './ui-tags-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const tab = (page: Page, view: 'report' | 'ua' | 'tags'): Locator =>
  page.locator(`[data-a11y-tab="${view}"]`);
const rule = (page: Page, id: string): Locator => page.locator(`[data-ua-rule="${id}"]`);
const rules = (page: Page): Locator => page.locator('[data-ua-rule]');

async function openAccessibility(page: Page, view: 'report' | 'ua' | 'tags' = 'report'): Promise<void> {
  await page.getByRole('tab', { name: 'Accessibility', exact: true }).click();
  await tab(page, view).click();
  await expect(tab(page, view)).toHaveAttribute('aria-selected', 'true');
}

async function openUa(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await openPdf(page, name, bytes);
  await openAccessibility(page, 'ua');
  await expect(rules(page).first()).toBeVisible({ timeout: 60_000 });
}

test('the views are tabs: the arrows move between them and wrap, other keys do nothing', async ({ page }) => {
  await openPdf(page, 'tagged.pdf', await taggedFixture());
  await openAccessibility(page, 'report');
  const root = page.locator('[data-a11y-view]');
  await expect(root).toHaveAttribute('data-a11y-view', 'report');
  await expect(tab(page, 'report')).toHaveAttribute('tabindex', '0');
  await expect(tab(page, 'ua')).toHaveAttribute('tabindex', '-1');

  await tab(page, 'report').press('x');
  await expect(root).toHaveAttribute('data-a11y-view', 'report');
  await tab(page, 'report').press('ArrowRight');
  await expect(root).toHaveAttribute('data-a11y-view', 'ua');
  await expect(tab(page, 'ua')).toBeFocused();
  await tab(page, 'ua').press('ArrowRight');
  await expect(root).toHaveAttribute('data-a11y-view', 'tags');
  await tab(page, 'tags').press('ArrowRight');
  await expect(root).toHaveAttribute('data-a11y-view', 'report');
  await tab(page, 'report').press('ArrowLeft');
  await expect(root).toHaveAttribute('data-a11y-view', 'tags');
  await expect(page.locator('[data-tags-mode]')).toBeVisible({ timeout: 60_000 });
  await tab(page, 'tags').press('ArrowLeft');
  await expect(root).toHaveAttribute('data-a11y-view', 'ua');
});

test('the report: an audit groups what it found, names what it did not check, and lists the figures without alt text', async ({
  page,
}) => {
  await openPdf(page, 'untagged.pdf', await untaggedFixture());
  await openAccessibility(page, 'report');
  await expect(page.getByText('Audit has not been run yet.')).toBeVisible();
  await page
    .getByRole('button', { name: 'Tag document' })
    .waitFor({ state: 'detached' })
    .catch(() => undefined);

  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await expect(page.getByText(/^2 page\(s\) · \d+ issue\(s\) · \d+ unknown$/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Audit has not been run yet.')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Detected issues' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unaudited items' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Figure alt text' })).toBeVisible();
  const figure = page.getByRole('textbox', { name: /^Alt text for figure/ });
  await expect(figure).toHaveCount(1);
  await expect(figure).toHaveValue('');
  await expect(page.getByText(/· page 1 · no alt text$/)).toBeVisible();
});

test('alt text written for a figure is in the file: the next audit lists it with its text, and an empty text writes nothing', async ({
  page,
}) => {
  await openPdf(page, 'untagged.pdf', await untaggedFixture());
  await openAccessibility(page, 'report');
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  const figure = page.getByRole('textbox', { name: /^Alt text for figure/ });
  await expect(figure).toBeVisible({ timeout: 60_000 });

  // Nothing typed: Save does nothing — no notice, no new version.
  await figure
    .locator('xpath=following-sibling::button')
    .or(page.getByRole('button', { name: 'Save', exact: true }))
    .first()
    .click();
  await expect(page.getByText(/Applied/)).toHaveCount(0);

  await figure.fill('Company logo');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });

  await openAccessibility(page, 'report');
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  const written = page.getByRole('textbox', { name: /^Alt text for figure/ });
  await expect(written).toHaveValue('Company logo', { timeout: 60_000 });
  await expect(page.getByText(/no alt text/)).toHaveCount(0);
});

test('Tag document tags the untagged file: the produced bytes carry a structure tree and the interface language', async ({
  page,
}) => {
  await openPdf(page, 'untagged.pdf', toolFixturePdf());
  await openAccessibility(page, 'report');
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tag document' })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Tag document' }).click();
  await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });
  const produced = await exportBytes(page, 'tagged.pdf');
  expect(await readProducedEntry(produced, null, 'StructTreeRoot')).not.toBe('');
  expect(await readProducedEntry(produced, null, 'MarkInfo')).toMatch(/Marked\s+true/);
  expect(await readProducedEntry(produced, null, 'Lang')).toContain('en');
});

test('PDF/UA: rules are grouped and filtered; failing ones start open, the others fold open and shut', async ({
  page,
}) => {
  await openUa(page, 'tool.pdf', toolFixturePdf());
  await expect(page.locator('[data-ua-summary]')).toHaveText(
    '5 passed, 11 failed, 3 need a person, 3 not applicable, 12 not checked.',
  );
  await expect(rule(page, 'title')).toHaveAttribute('data-ua-state', 'fail');
  await expect(rule(page, 'title').getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(rule(page, 'xfa').getByRole('button').first()).toHaveAttribute('aria-expanded', 'false');

  const xfa = rule(page, 'xfa').getByRole('button').first();
  await xfa.click();
  await expect(xfa).toHaveAttribute('aria-expanded', 'true');
  await expect(rule(page, 'xfa')).toContainText('Matterhorn checkpoint group');
  await xfa.click();
  await expect(xfa).toHaveAttribute('aria-expanded', 'false');
  const title = rule(page, 'title').getByRole('button').first();
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'false');

  const filter = page.getByLabel('Show');
  await filter.selectOption('fail');
  await expect(rules(page)).toHaveCount(23);
  await expect(rule(page, 'xfa')).toHaveCount(0);
  await expect(rule(page, 'role-map')).toHaveAttribute('data-ua-state', 'unchecked');
  // The rules a person has to judge, whatever state the automated part left them in.
  await filter.selectOption('manual');
  await expect(rules(page)).toHaveCount(4);
  await filter.selectOption('all');
  await expect(rules(page)).toHaveCount(34);

  // A rule that could not be checked says why in the shared sentence of its reason.
  await rule(page, 'role-map').getByRole('button').first().click();
  await expect(rule(page, 'role-map')).toContainText('Not checked: the file has no structure tree.');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(rules(page)).toHaveCount(34);
});

test('PDF/UA: a page button goes to its page and the element button opens the element in the Tags view', async ({
  page,
}) => {
  await openUa(page, 'tagged.pdf', await taggedFixture());
  await expect(page.getByText('The file does not declare PDF/UA conformance.')).toBeVisible();
  const tabOrder = rule(page, 'tab-order');
  await expect(tabOrder).toContainText('Page 1 has annotations but no /Tabs /S.');
  await tabOrder.getByRole('button', { name: 'Page 1' }).click();
  await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('1');

  const figure = rule(page, 'figure-alt');
  await figure.getByRole('button', { name: 'Open this element in the Tags view' }).click();
  await expect(page.locator('[data-tags-mode]')).toBeVisible({ timeout: 60_000 });
  await expect(tab(page, 'tags')).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.locator('[role="treeitem"][data-tag-role="Figure"][aria-selected="true"]').first(),
  ).toBeVisible();
});

test('PDF/UA quick fixes write the file: title and language by text, tab order and window title by button', async ({
  page,
}) => {
  await openUa(page, 'tool.pdf', toolFixturePdf());
  // Language: the field starts at the interface language; the button writes what it says.
  const lang = rule(page, 'lang');
  await expect(lang.getByRole('textbox', { name: 'Language tag' })).toHaveValue('en');
  await expect(lang).toContainText('For example en-US, tr-TR or de-DE.');
  await lang.getByRole('textbox', { name: 'Language tag' }).fill('de-DE');
  await lang.getByRole('button', { name: 'Set language' }).click();
  await expect(rule(page, 'lang')).toHaveAttribute('data-ua-state', 'pass', { timeout: 60_000 });

  // Title: the Info title is the starting text; an empty field offers no save.
  const title = rule(page, 'title');
  const titleField = title.getByRole('textbox', { name: 'Document title' });
  await titleField.fill('');
  await expect(title.getByRole('button', { name: 'Set title' })).toBeDisabled();
  await titleField.fill('Fixture for panels');
  await title.getByRole('button', { name: 'Set title' }).click();
  await expect(rule(page, 'title')).toHaveAttribute('data-ua-state', 'pass', { timeout: 60_000 });

  await rule(page, 'display-title').getByRole('button', { name: 'Show the title in the window bar' }).click();
  await expect(rule(page, 'display-title')).toHaveAttribute('data-ua-state', 'pass', { timeout: 60_000 });
  await rule(page, 'tab-order').getByRole('button', { name: 'Set tab order to the structure' }).click();
  await expect(rule(page, 'tab-order')).toHaveAttribute('data-ua-state', 'pass', { timeout: 60_000 });

  const produced = await exportBytes(page, 'fixed.pdf');
  expect(await readProducedEntry(produced, null, 'Lang')).toContain('de-DE');
  expect(await readProducedEntry(produced, null, 'ViewerPreferences', 'DisplayDocTitle')).toBe('true');
  expect(await readProducedEntry(produced, 0, 'Tabs')).toBe('/S');
  expect((await readProducedPdf(produced)).title).toBe('Fixture for panels');
});

test('PDF/UA: a link’s description and a field’s tooltip are written on the row of the instance', async ({
  page,
}) => {
  await openUa(page, 'tool.pdf', toolFixturePdf());
  const link = rule(page, 'link-alt');
  const description = link.getByRole('textbox', { name: 'Description of this link' });
  await expect(link.getByRole('button', { name: 'Save' })).toBeDisabled();
  await description.fill('Jump to the second page');
  await link.getByRole('button', { name: 'Save' }).click();
  await expect(rule(page, 'link-alt')).toHaveAttribute('data-ua-state', 'pass', { timeout: 60_000 });

  const field = rule(page, 'form-tooltip');
  await field.getByRole('textbox', { name: 'Tooltip for customer' }).fill('Customer name');
  await field.getByRole('button', { name: 'Save' }).click();
  await expect(rule(page, 'form-tooltip')).toHaveAttribute('data-ua-state', 'pass', { timeout: 60_000 });

  const links = (await readProducedPdf(await exportBytes(page, 'described.pdf'))).annotations.filter(
    (mark) => mark.subtype === 'Link',
  );
  expect(links.map((mark) => mark.contents)).toEqual(['Jump to the second page']);
});

test('PDF/UA: tagged-file fixes — links and fields into the tree; PDF/UA cannot be declared while a rule fails', async ({
  page,
}) => {
  await openUa(page, 'tagged.pdf', await taggedFixture());
  const declare = rule(page, 'pdfua-id');
  await expect(declare.getByRole('button', { name: 'Declare PDF/UA-1' })).toBeDisabled();
  await expect(declare).toContainText('Not offered while an automated rule fails or could not be checked.');
  // The file is tagged, so the tree fix is offered; it writes a new version of the file.
  const tree = rule(page, 'link-tagged').getByRole('button', {
    name: 'Put links, fields and annotations in the structure tree',
  });
  await expect(tree).toBeVisible();
  await tree.click();
  await expect(notice(page, /Accessibility tagging applied to document/)).toBeVisible({ timeout: 60_000 });
  await expect(rule(page, 'marked')).toHaveAttribute('data-ua-state', 'pass');

  await openUa(page, 'tool.pdf', toolFixturePdf());
  await expect(rule(page, 'marked')).toHaveAttribute('data-ua-state', 'fail');
  await expect(rule(page, 'marked').getByRole('button', { name: 'Mark the file as tagged' })).toHaveCount(0);
});

test.describe('a document that is only viewed', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });

  test('PDF/UA offers its fixes disabled', async ({ page }) => {
    await openUa(page, 'long.pdf', await viewingOnlyFixture());
    const title = rule(page, 'title');
    await expect(title).toHaveAttribute('data-ua-state', 'fail');
    await expect(title.getByRole('textbox', { name: 'Document title' })).toBeDisabled();
    await expect(
      rule(page, 'display-title').getByRole('button', { name: 'Show the title in the window bar' }),
    ).toBeDisabled();
  });
});
