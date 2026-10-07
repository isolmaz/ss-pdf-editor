/**
 * The document-information panel of the right dock: the font inventory, the embedded files
 * (sizes, open, add, remove), the security state and the verdicts on existing signatures.
 * What the panel says is read on screen; what its actions do is read back from the produced
 * and downloaded bytes.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedPdf } from './tool-fixture';
import { exportBytes, openDockTab, openPdf } from './ui-helpers';
import { ownerProtected, utf8, withEmbedded, withFonts } from './ui-panels9-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** The panel, once its tab is open. */
async function openProperties(page: Page): Promise<Locator> {
  await openDockTab(page, 'Document information');
  const panel = page.getByRole('region', { name: 'Document information' });
  await expect(panel).toBeVisible();
  return panel;
}

const section = (panel: Locator, name: string): Locator => panel.getByRole('region', { name });

test('fonts are listed with their kind, page count, embedding, subset tag and encoding', async ({ page }) => {
  await openPdf(page, 'fonts.pdf', await withFonts());
  const panel = await openProperties(page);
  const fonts = section(panel, 'Fonts').getByRole('list', { name: 'Fonts' }).getByRole('listitem');
  await expect(fonts).toHaveCount(3);

  // The page's own base-14 font: not embedded, used on both pages.
  const helvetica = fonts.filter({ hasText: 'Helvetica' });
  await expect(helvetica).toContainText('Type1');
  await expect(helvetica).toContainText('2 page(s)');
  await expect(helvetica).toContainText('Not embedded');
  await expect(helvetica).toContainText('Encoding: WinAnsiEncoding');
  await expect(helvetica).not.toContainText('Subset');

  const subset = fonts.filter({ hasText: 'ABCDEF+Embedded' });
  await expect(subset).toContainText('TrueType');
  await expect(subset).toContainText('1 page(s)');
  await expect(subset).toContainText('Embedded');
  await expect(subset).not.toContainText('Not embedded');
  await expect(subset).toContainText('Subset');
  await expect(subset).toContainText('Encoding: MacRomanEncoding');

  // A font with no base name is shown by its kind, and an encoding that is only a list of
  // differences has no name to show.
  const nameless = fonts.filter({ hasNotText: /Helvetica|ABCDEF/ });
  await expect(nameless).toHaveCount(1);
  await expect(nameless).toContainText('Type1');
  await expect(nameless).toContainText('Not embedded');
  await expect(nameless).not.toContainText('Encoding');
});

const attachmentRow = (panel: Locator, name: string): Locator =>
  section(panel, 'Attachments').getByRole('listitem').filter({ hasText: name });

/** The panel's polite live region, the sentence a screen reader is given when a list changes. */
const announcement = (panel: Locator): Locator => panel.locator('[aria-live="polite"]');

/** Click `button` and read the file the browser was asked to download. */
async function downloaded(page: Page, button: Locator, name: string) {
  const event = page.waitForEvent('download');
  await button.click();
  const file = await event;
  const path = test.info().outputPath(name);
  await file.saveAs(path);
  return { suggested: file.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)) };
}

test('an embedded file is listed with its description and can be written out; one whose payload is gone says so', async ({
  page,
}) => {
  await openPdf(
    page,
    'files.pdf',
    await withEmbedded([
      { name: 'a.txt', bytes: utf8('hello'), description: 'A greeting' },
      { name: 'b.txt', bytes: utf8('lost'), withoutStream: true },
    ]),
  );
  const panel = await openProperties(page);
  const a = attachmentRow(panel, 'a.txt');
  await expect(a).toContainText('A greeting');
  // No description: the line carries the size alone, with no separator left over.
  await expect(attachmentRow(panel, 'b.txt')).toHaveText(/^b\.txtSize unreadableOpenRemove$/);

  const opened = await downloaded(page, a.getByRole('button', { name: 'Open attachment a.txt' }), 'a.txt');
  expect(opened.suggested).toBe('a.txt');
  expect(new TextDecoder().decode(opened.bytes)).toBe('hello');
  await expect(page.getByText('Open attachment a.txt', { exact: true }).first()).toBeVisible();

  await attachmentRow(panel, 'b.txt').getByRole('button', { name: 'Open attachment b.txt' }).click();
  await expect(page.getByText(/The document looks damaged\./)).toBeVisible();
});

test('the size of an embedded file is measured from its payload', async ({ page }) => {
  await openPdf(
    page,
    'sizes.pdf',
    await withEmbedded([
      { name: 'a.txt', bytes: utf8('hello'), description: 'A greeting' },
      { name: 'b.bin', bytes: new Uint8Array(3000).map((_, index) => (index * 7919) % 251) },
      { name: 'c.txt', bytes: utf8('lost'), withoutStream: true },
    ]),
  );
  const panel = await openProperties(page);
  await expect(attachmentRow(panel, 'a.txt')).toContainText('5 byte · A greeting');
  await expect(attachmentRow(panel, 'b.bin')).toContainText('3,000 byte');
  await expect(attachmentRow(panel, 'c.txt')).toContainText('Size unreadable');
});

test('adding and removing embedded files changes the document and is announced', async ({ page }) => {
  await openPdf(page, 'files.pdf', await withEmbedded([{ name: 'a.txt', bytes: utf8('hello') }]));
  const panel = await openProperties(page);
  const picker = section(panel, 'Attachments').locator('input[type="file"]');
  await expect(attachmentRow(panel, 'a.txt')).toBeVisible();

  // Nothing picked, nothing written.
  await picker.setInputFiles([]);
  await expect(attachmentRow(panel, 'a.txt')).toBeVisible();
  await expect(section(panel, 'Attachments').getByRole('listitem')).toHaveCount(1);
  await expect(announcement(panel)).toHaveText('');

  await picker.setInputFiles([
    { name: 'şube.txt', mimeType: 'text/plain', buffer: Buffer.from('merhaba') },
    { name: 'data.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3]) },
  ]);
  await expect(attachmentRow(panel, 'şube.txt')).toBeVisible({ timeout: 60_000 });
  await expect(attachmentRow(panel, 'data.bin')).toBeVisible();
  await expect(announcement(panel)).toHaveText('Attachment list updated: 3');
  expect((await readProducedPdf(await exportBytes(page, 'added.pdf'))).attachmentNames).toEqual([
    'a.txt',
    'data.bin',
    'şube.txt',
  ]);

  await attachmentRow(panel, 'a.txt').getByRole('button', { name: 'Remove attachment a.txt' }).click();
  await expect(attachmentRow(panel, 'a.txt')).toHaveCount(0, { timeout: 60_000 });
  await expect(announcement(panel)).toHaveText('Attachment list updated: 2');
  expect((await readProducedPdf(await exportBytes(page, 'removed.pdf'))).attachmentNames).toEqual([
    'data.bin',
    'şube.txt',
  ]);
});

test('security: a document with no restriction says so, and an owner-protected one lists what it grants', async ({
  page,
}) => {
  await openPdf(page, 'plain.pdf');
  const plain = section(await openProperties(page), 'Security');
  await expect(plain).toContainText('Unencrypted');
  await expect(plain.getByRole('listitem')).toHaveCount(8);
  await expect(plain).not.toContainText('Encrypted');

  // Everything but printing and accessibility is withheld.
  await openPdf(page, 'limited.pdf', await ownerProtected(-3904 | 0x4 | 0x200));
  const limited = section(await openProperties(page), 'Security');
  await expect(limited).toContainText('Encrypted');
  await expect(limited.getByRole('listitem')).toHaveText(['print', 'accessibility']);
  await expect(limited.getByText(/./).last()).toBeVisible();

  // Nothing granted at all.
  await openPdf(page, 'locked.pdf', await ownerProtected(-3904));
  const locked = section(await openProperties(page), 'Security');
  await expect(locked).toContainText('Encrypted');
  await expect(locked.getByText('No restrictions declared.')).toBeVisible();
});
