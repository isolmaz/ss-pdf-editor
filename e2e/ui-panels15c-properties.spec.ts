/**
 * The document-information tab's three buttons that open the browser's file chooser: add an
 * attachment, import a trust root, import a revocation list. The earlier specs set the hidden
 * inputs directly; here a user clicks.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { toolFixturePdf } from './tool-fixture';
import { openDockTab, openPdf } from './ui-helpers';
import { cmsBy, crlBy, fromNow, pem, signedDocument, signingPki, utf8 } from './ui-panels9-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

type FilePayload = Parameters<Locator['setInputFiles']>[0];

async function chooseFiles(page: Page, button: Locator, files: FilePayload): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await button.click();
  await (await chooser).setFiles(files);
}

async function openProperties(page: Page): Promise<Locator> {
  await openDockTab(page, 'Document information');
  const panel = page.getByRole('region', { name: 'Document information' });
  await expect(panel).toBeVisible();
  return panel;
}

test('Add file in the attachments section opens the chooser and lists the chosen file', async ({ page }) => {
  await openPdf(page, 'plain.pdf', toolFixturePdf());
  const panel = await openProperties(page);
  const attachments = panel.getByRole('region', { name: 'Attachments' });
  await chooseFiles(page, attachments.getByRole('button', { name: 'Add file', exact: true }), {
    name: 'added.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(utf8('added by click')),
  });
  await expect(attachments.getByRole('listitem').filter({ hasText: 'added.txt' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Attachment list updated: 1')).toBeAttached();
});

test('Import certificate and Import CRL open their choosers; the root is listed and the list is shown', async ({
  page,
}) => {
  const { root, leaf } = await signingPki();
  await openPdf(page, 'signed.pdf', await signedDocument(cmsBy(leaf, [root], fromNow(-100))));
  const panel = await openProperties(page);

  await chooseFiles(page, panel.locator('button', { hasText: 'Import certificate' }), {
    name: 'root.pem',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(pem('CERTIFICATE', root.der)),
  });
  await expect(page.getByText('Panel Root CA', { exact: true })).toBeVisible();

  const list = await crlBy(root, fromNow(-50), fromNow(30));
  await chooseFiles(page, panel.locator('button', { hasText: 'Import CRL' }), {
    name: 'root.crl',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(list),
  });
  await expect(
    page.getByRole('list', { name: 'Imported revocation lists (CRL)' }).getByRole('listitem'),
  ).toHaveCount(1);
});
