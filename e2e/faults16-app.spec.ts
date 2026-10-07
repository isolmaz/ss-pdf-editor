/**
 * The shell's answers to an engine that fails where a real file would not make it fail: the
 * embedded-file writes and reads, the form-field write and the save-time form check, with the
 * failure injected into MuPDF or pdf.js (`engine-faults.ts`). What the user sees is a notice,
 * the document stays as it was in the exported file, and the same gesture works once the
 * engine does.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { mutate } from '../packages/pdf-core/src/ops/tagged.fixtures';
import { notice } from './app-helpers';
import { failNext, firedCount, injectEngineFaults } from './engine-faults';
import { expect, test } from './test';
import { readProducedEntry, readProducedPdf, toolFixturePdf } from './tool-fixture';
import { exportBytes, openDockTab, openPdf } from './ui-helpers';
import { utf8, withEmbedded } from './ui-panels9-helpers';
import { FORM_FIELDS, formFixturePdf, formValues } from './ui-panels15-helpers';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

/** What the shell says for an engine failure it has no better words for. */
const UNEXPECTED = 'Something unexpected went wrong. Try again; report it if it keeps happening.';

const rowsOf = (page: Page): Locator => page.getByRole('list', { name: 'Attachments' }).getByRole('listitem');
const picker = (page: Page): Locator => page.locator('input[data-attachment-picker]');

test('the attachments panel: a file the engine cannot add is refused in words, leaves the file alone, and the same pick works afterwards', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'empty.pdf', toolFixturePdf());
  await openDockTab(page, 'Attachments');
  await expect(page.getByText('This document has no attachments.')).toBeVisible();

  await failNext(page, 'mupdf', 'PDFDocument.addEmbeddedFile', 'disk full');
  await picker(page).setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('four') },
  ]);
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  // The wrapper is what ran: the rule fired inside MuPDF, once.
  expect(await firedCount(page, 'mupdf', 'PDFDocument.addEmbeddedFile')).toBe(1);
  await expect(page.getByText('This document has no attachments.')).toBeVisible();
  await expect(page.getByText('No operation history for this document.')).toBeVisible();
  expect((await readProducedPdf(await exportBytes(page, 'same.pdf'))).attachmentNames).toEqual([]);

  // A file the browser gave no type is embedded as a plain binary.
  await picker(page).setInputFiles([{ name: 'blob', mimeType: '', buffer: Buffer.from('four') }]);
  await expect(rowsOf(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(notice(page, '1 attachment(s) added.')).toBeVisible();
  const added = await exportBytes(page, 'added.pdf');
  expect((await readProducedPdf(added)).attachmentNames).toEqual(['blob']);
  expect(
    await readProducedEntry(added, null, 'Names', 'EmbeddedFiles', 'Names', 1, 'EF', 'F', 'Subtype'),
  ).toBe('/application#2Foctet-stream');
});

test('the attachments panel: a removal the engine cannot save keeps the file listed and in the document, and works on the next try', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'files.pdf', await withEmbedded([{ name: 'a.txt', bytes: utf8('hello') }]));
  await openDockTab(page, 'Attachments');
  await expect(rowsOf(page)).toHaveCount(1);

  await failNext(page, 'mupdf', 'PDFDocument.saveToBuffer', 'disk full');
  await page.getByRole('button', { name: 'Remove attachment: a.txt' }).click();
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'mupdf', 'PDFDocument.saveToBuffer')).toBe(1);
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(page.getByText('No operation history for this document.')).toBeVisible();
  const kept = await readProducedPdf(await exportBytes(page, 'kept.pdf'));
  expect(kept.attachmentNames).toEqual(['a.txt']);

  await page.getByRole('button', { name: 'Remove attachment: a.txt' }).click();
  await expect(page.getByText('This document has no attachments.')).toBeVisible({ timeout: 60_000 });
  expect((await readProducedPdf(await exportBytes(page, 'gone.pdf'))).attachmentNames).toEqual([]);
});

/** The document-information panel of the right dock, once its tab is open. */
async function openProperties(page: Page): Promise<Locator> {
  await openDockTab(page, 'Document information');
  const panel = page.getByRole('region', { name: 'Document information' });
  await expect(panel).toBeVisible();
  return panel.getByRole('region', { name: 'Attachments' });
}

const propsRow = (section: Locator, name: string): Locator =>
  section.getByRole('listitem').filter({ hasText: name });

test('the properties panel: a file the engine cannot add is refused in words, and the same pick then embeds a typeless file as a plain binary', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'empty.pdf', toolFixturePdf());
  const section = await openProperties(page);
  await expect(section.getByText('No attachments in document.')).toBeVisible();
  const input = section.locator('input[type="file"]');

  await failNext(page, 'mupdf', 'PDFDocument.addEmbeddedFile', 'disk full');
  await input.setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('four') }]);
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'mupdf', 'PDFDocument.addEmbeddedFile')).toBe(1);
  await expect(section.getByText('No attachments in document.')).toBeVisible();
  expect((await readProducedPdf(await exportBytes(page, 'same.pdf'))).attachmentNames).toEqual([]);

  await input.setInputFiles([{ name: 'blob', mimeType: '', buffer: Buffer.from('four') }]);
  await expect(propsRow(section, 'blob')).toBeVisible({ timeout: 60_000 });
  await expect(notice(page, '1 attachment(s) added.')).toBeVisible();
  const added = await exportBytes(page, 'added.pdf');
  expect((await readProducedPdf(added)).attachmentNames).toEqual(['blob']);
  expect(
    await readProducedEntry(added, null, 'Names', 'EmbeddedFiles', 'Names', 1, 'EF', 'F', 'Subtype'),
  ).toBe('/application#2Foctet-stream');
});

test('the properties panel: a removal the engine cannot save keeps the file in the document, and works on the next try', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'files.pdf', await withEmbedded([{ name: 'a.txt', bytes: utf8('hello') }]));
  const section = await openProperties(page);
  await expect(propsRow(section, 'a.txt')).toBeVisible();

  await failNext(page, 'mupdf', 'PDFDocument.saveToBuffer', 'disk full');
  await propsRow(section, 'a.txt').getByRole('button', { name: 'Remove attachment a.txt' }).click();
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'mupdf', 'PDFDocument.saveToBuffer')).toBe(1);
  await expect(propsRow(section, 'a.txt')).toBeVisible();
  expect((await readProducedPdf(await exportBytes(page, 'kept.pdf'))).attachmentNames).toEqual(['a.txt']);

  await propsRow(section, 'a.txt').getByRole('button', { name: 'Remove attachment a.txt' }).click();
  await expect(propsRow(section, 'a.txt')).toHaveCount(0, { timeout: 60_000 });
  expect((await readProducedPdf(await exportBytes(page, 'gone.pdf'))).attachmentNames).toEqual([]);
});

test('the properties panel: removing a file the name tree holds under another key says it was not found and changes nothing', async ({
  page,
}) => {
  // The panel lists the file specification's own name; removal looks the tree key up.
  const bytes = await mutate(toolFixturePdf(), (doc) => {
    const spec = doc.addEmbeddedFile('shown.txt', 'text/plain', utf8('hello'), new Date(0), new Date(0));
    const pairs = doc.newArray();
    pairs.push(doc.newString('keyed-differently.txt'));
    pairs.push(spec);
    const tree = doc.newDictionary();
    tree.put('Names', pairs);
    const names = doc.newDictionary();
    names.put('EmbeddedFiles', tree);
    doc.getTrailer().get('Root').resolve().put('Names', names);
  });
  await openPdf(page, 'keyed.pdf', bytes);
  const section = await openProperties(page);
  await expect(propsRow(section, 'shown.txt')).toBeVisible();

  await propsRow(section, 'shown.txt').getByRole('button', { name: 'Remove attachment shown.txt' }).click();
  await expect(notice(page, '1 attachment(s) not found in document.')).toBeVisible();
  await expect(propsRow(section, 'shown.txt')).toBeVisible();
  expect((await readProducedPdf(await exportBytes(page, 'same.pdf'))).attachmentNames).toEqual([
    'keyed-differently.txt',
  ]);
});

test('the properties panel: an attachment pdf.js cannot read back is reported and nothing is downloaded; the next try opens it', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'files.pdf', await withEmbedded([{ name: 'a.txt', bytes: utf8('hello') }]));
  const section = await openProperties(page);
  const open = propsRow(section, 'a.txt').getByRole('button', { name: 'Open attachment a.txt' });
  await expect(open).toBeVisible();

  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  // The list of embedded files cannot be fetched.
  await failNext(page, 'pdfjs', 'GetAttachments', 'worker lost the table');
  await open.click();
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'pdfjs', 'GetAttachments')).toBe(1);
  expect(downloads).toEqual([]);

  // The list arrives but the file's own stream cannot be read.
  await failNext(page, 'pdfjs', 'GetAttachmentContent', 'worker lost the stream');
  await open.click();
  await expect.poll(() => firedCount(page, 'pdfjs', 'GetAttachmentContent')).toBe(1);
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(downloads).toEqual([]);

  const event = page.waitForEvent('download');
  await open.click();
  const file = await event;
  expect(file.suggestedFilename()).toBe('a.txt');
  const path = test.info().outputPath('a.txt');
  await file.saveAs(path);
  expect(readFileSync(path).toString()).toBe('hello');
  await expect(notice(page, 'Open attachment a.txt')).toBeVisible();
});

test('a form value the engine cannot write leaves the field and the file as they were, and the next edit lands', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'form.pdf', formFixturePdf());
  await openDockTab(page, 'Form fields');
  const rows = page.locator('ul[aria-label="Form fields"] > li');
  await expect(rows).toHaveCount(FORM_FIELDS.length);
  const applicant = rows.filter({ hasText: 'applicant' }).first();

  await applicant.getByRole('button').first().click();
  const input = applicant.locator('input[type="text"]');
  await failNext(page, 'mupdf', 'PDFDocument.saveToBuffer', 'disk full');
  await input.fill('Grace Hopper');
  await input.press('Enter');
  await expect(notice(page, UNEXPECTED)).toBeVisible();
  expect(await firedCount(page, 'mupdf', 'PDFDocument.saveToBuffer')).toBe(1);
  await expect(notice(page, 'Applied to document')).toHaveCount(0);

  const untouched = await formValues(await exportBytes(page, 'untouched.pdf'));
  expect(untouched.applicant).toBe('Ada');

  // The field is still editable and the same edit now goes through.
  await applicant.getByRole('button').first().click();
  const again = applicant.locator('input[type="text"]');
  await expect(again).toHaveValue('Ada');
  await again.fill('Grace Hopper');
  await again.press('Enter');
  await expect(notice(page, 'Applied to document: Form fields')).toBeVisible();
  expect((await formValues(await exportBytes(page, 'filled.pdf'))).applicant).toBe('Grace Hopper');
});

test('a save whose form check the engine cannot answer says so, keeps every value, and checks nothing else less', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'form.pdf', formFixturePdf());
  await openDockTab(page, 'Form fields');
  await expect(page.locator('ul[aria-label="Form fields"] > li')).toHaveCount(FORM_FIELDS.length);

  // The form reader is the one reader of the save that walks page objects by number.
  await failNext(page, 'mupdf', 'PDFObject.asIndirect', 'form reader broke');
  const saved = await exportBytes(page, 'checked.pdf');
  expect(await firedCount(page, 'mupdf', 'PDFObject.asIndirect')).toBe(1);

  const report = notice(page, 'Not checked by this build');
  await expect(report).toContainText(
    'Verified: page count, page order, page content, text, rotation, crop box, outline, page labels.',
  );
  await expect(report).toContainText(
    'Not checked by this build: form field count (the reader cannot answer this), form field values (the reader cannot answer this)',
  );
  const values = await formValues(saved);
  expect(values.applicant).toBe('Ada');
  expect(values.locked).toBe('Fixed text');
  expect(values.country).toBe('France');
});
