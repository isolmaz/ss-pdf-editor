/**
 * The left dock's Signatures tab: the signature fields the AcroForm declares, whether each
 * carries a signature, and the walk to the page a field is on.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { toolFixturePdf } from './tool-fixture';
import { openDockTab, openPdf } from './ui-helpers';
import { clickTabsTogether, cmsBy, fromNow, signedDocument, signingPki } from './ui-panels9-helpers';
import { signatureFieldsPdf } from './ui-panels15-helpers';

const list = (page: Page): Locator => page.getByRole('list', { name: 'Signatures' });
const entry = (page: Page, name: string): Locator => list(page).getByRole('button').filter({ hasText: name });

test('a signed field says Signed and an unsigned one says Unsigned field', async ({ page }) => {
  const { root, leaf } = await signingPki();
  await openPdf(page, 'signed.pdf', await signedDocument(cmsBy(leaf, [root], fromNow(-100))));
  await openDockTab(page, 'Signatures');

  await expect(list(page).getByRole('listitem')).toHaveCount(1);
  await expect(entry(page, 'Sig1')).toContainText('Signed');
  await expect(entry(page, 'Sig1')).not.toContainText('Unsigned');
  await expect(entry(page, 'Sig1')).toHaveAttribute('title', 'Go to page 1');

  await openPdf(page, 'fields.pdf', signatureFieldsPdf(), { navigate: false, advanced: false });
  await openDockTab(page, 'Signatures');
  await expect(entry(page, 'Author')).toContainText('Unsigned field');
  await expect(entry(page, 'Reviewer')).toContainText('Unsigned field');
});

test('a row walks the viewer to the page its field is on', async ({ page }) => {
  await openPdf(page, 'fields.pdf', signatureFieldsPdf());
  await openDockTab(page, 'Signatures');
  await expect(list(page).getByRole('listitem')).toHaveCount(2);

  const pageField = page.getByRole('textbox', { name: 'Page number' });
  await expect(pageField).toHaveValue('1');
  await expect(entry(page, 'Reviewer')).toHaveAttribute('title', 'Go to page 2');
  await entry(page, 'Reviewer').click();
  await expect(pageField).toHaveValue('2');
  await entry(page, 'Author').click();
  await expect(pageField).toHaveValue('1');
});

test('a document without signature fields says so', async ({ page }) => {
  await openPdf(page, 'plain.pdf', toolFixturePdf());
  await openDockTab(page, 'Signatures');
  await expect(page.getByText('This document has no signature fields.')).toBeVisible();
  await expect(list(page)).toHaveCount(0);
});

test('leaving the tab before the fields are read drops the answer, and the tab reads them afresh on return', async ({
  page,
}) => {
  await openPdf(page, 'fields.pdf', signatureFieldsPdf());
  await clickTabsTogether(page, ['Signatures', 'Pages']);
  await expect(page.getByRole('tab', { name: 'Pages', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(list(page)).toHaveCount(0);

  await openDockTab(page, 'Signatures');
  await expect(list(page).getByRole('listitem')).toHaveCount(2);
});
