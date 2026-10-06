import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { Download, Page } from 'playwright/test';
import { expect, test } from 'playwright/test';
import { useAdvancedMode } from './settings';
import {
  encryptedToolFixturePdf,
  labelledPdf,
  PAGE_ONE_LINES,
  readProducedEntry,
  readProducedPageTexts,
  readProducedPdf,
  toolFixturePdf,
} from './tool-fixture';

/**
 * The menu-bar commands the other specs do not drive: one test per command (or family),
 * each run in the built app with the produced bytes read back by the independent readers
 * of `tool-fixture.ts`. Every dialog is also checked for English labels: `openForm` fails
 * on a Turkish letter anywhere in the form it opens.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const CANVAS = '.pdfViewer[data-active-viewer] .page canvas';
const TURKISH_LETTER = /[çğıöşüÇĞİÖŞÜ]/;

const pdfFile = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from(bytes),
});

async function open(page: Page, name = 'doc.pdf', bytes: Uint8Array = toolFixturePdf()): Promise<void> {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles(pdfFile(name, bytes));
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  // The page shows before the open finishes (the source is still being stored), and the
  // shell refuses other work until then: a gesture sent earlier is dropped under load.
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });
  await useAdvancedMode(page);
}

/** Export through the header button and read the downloaded bytes back. */
async function exported(page: Page, name: string): Promise<Uint8Array> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return new Uint8Array(readFileSync(path));
}

async function saveDownload(download: Download, name: string): Promise<Uint8Array> {
  const path = test.info().outputPath(name);
  await download.saveAs(path);
  return new Uint8Array(readFileSync(path));
}

const thumbs = (page: Page) => page.getByRole('option');
const notice = (page: Page, text: string) => page.locator('[role="status"]').filter({ hasText: text });

/** Open an operation's form from the command palette; its words must be English. */
async function openForm(page: Page, command: string, region: string) {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill(command);
  await page.keyboard.press('Enter');
  // An operation opens in the tools panel; a command that starts a new document (images to
  // PDF) opens as a dialog of its own.
  const form = page.getByRole('region', { name: region }).or(page.getByRole('dialog', { name: region }));
  await expect(form).toBeVisible({ timeout: 30_000 });
  const words = await form.evaluate((element) => {
    const fields = [...element.querySelectorAll<HTMLInputElement>('input, textarea')].map((e) => e.value);
    return `${(element as HTMLElement).innerText}\n${fields.join('\n')}`;
  });
  expect(words, `${region}: Turkish text in the English interface`).not.toMatch(TURKISH_LETTER);
  return form;
}

async function previewForm(form: ReturnType<Page['getByRole']>, confirm = 'Preview'): Promise<void> {
  await form.getByRole('button', { name: confirm, exact: true }).click();
  const report = form.getByRole('heading', { name: 'Operation report' });
  // A destructive operation asks once more before it runs.
  const goOn = form.getByRole('button', { name: 'Continue', exact: true });
  await expect(goOn.or(report)).toBeVisible({ timeout: 60_000 });
  if (await goOn.isVisible()) await goOn.click();
  await expect(report).toBeVisible({ timeout: 60_000 });
}

/** Choose an entry of one of the dialog's drop-down lists. */
async function choose(page: Page, form: ReturnType<Page['getByRole']>, label: string, option: string) {
  await form.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Preview, then apply to the document, and wait for the form to close. */
async function applyForm(form: ReturnType<Page['getByRole']>): Promise<void> {
  await previewForm(form);
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
}

test('optimize: lossless pass strips metadata, the image pass replaces the text layer by pictures', async ({
  page,
}) => {
  await open(page);
  let form = await openForm(page, 'Optimize', 'Optimize / Compress');
  await form.getByText('Advanced options').click();
  await form.getByRole('checkbox', { name: /Clear metadata/ }).check();
  await applyForm(form);
  const lossless = await readProducedPdf(await exported(page, 'lossless.pdf'));
  expect(lossless.title).toBeNull();
  expect(lossless.producer).not.toBeNull();
  expect((await readProducedPageTexts(await exported(page, 'lossless2.pdf')))[0]).toContain('Third line');

  form = await openForm(page, 'Optimize', 'Optimize / Compress');
  await form.getByRole('radio', { name: 'Convert pages to image (lossy)' }).check();
  await form.getByRole('spinbutton', { name: /DPI|Resolution/ }).fill('72');
  await applyForm(form);
  const raster = await exported(page, 'raster.pdf');
  expect((await readProducedPdf(raster)).pageCount).toBe(2);
  expect((await readProducedPageTexts(raster)).map((text) => text.trim())).toEqual(['', '']);
});

test('page boxes and labels: a set CropBox and a Roman label range reach the file', async ({ page }) => {
  await open(page);
  let form = await openForm(page, 'Page boxes', 'Page boxes & dimensions');
  await form.getByRole('radio', { name: 'Set box values' }).check();
  await form.getByRole('spinbutton', { name: 'X', exact: true }).fill('10');
  await form.getByRole('spinbutton', { name: 'Y', exact: true }).fill('20');
  await form.getByRole('spinbutton', { name: 'Width', exact: true }).fill('300');
  await form.getByRole('spinbutton', { name: 'Height', exact: true }).fill('400');
  await applyForm(form);

  form = await openForm(page, 'Page labels', 'Page labels');
  await choose(page, form, 'Numbering style', 'i, ii, iii');
  await form.getByRole('textbox', { name: 'Prefix' }).fill('App-');
  await applyForm(form);

  const bytes = await exported(page, 'boxes.pdf');
  expect(await readProducedEntry(bytes, 0, 'CropBox')).toMatch(/10\s+20\s+310\s+420/);
  expect(await readProducedEntry(bytes, 1, 'CropBox')).toMatch(/10\s+20\s+310\s+420/);
  const labels = await readProducedEntry(bytes, null, 'PageLabels');
  expect(labels).toContain('App-');
  expect(labels).toMatch(/\/S\s*\/r/);
});

test('new form field and form data: a created field exports, and an imported value reaches the file', async ({
  page,
}) => {
  await open(page);
  let form = await openForm(page, 'New form field', 'New form field');
  await form.getByRole('textbox', { name: 'Field name' }).fill('email');
  await form.getByRole('spinbutton', { name: 'Left (x)' }).fill('72');
  await form.getByRole('spinbutton', { name: 'Bottom (y)' }).fill('300');
  await form.getByRole('spinbutton', { name: 'Width' }).fill('200');
  await form.getByRole('spinbutton', { name: 'Height' }).fill('24');
  await applyForm(form);
  const created = (await readProducedPdf(await exported(page, 'field.pdf'))).annotations.find(
    (annotation) => annotation.fieldName === 'email',
  );
  expect(created?.subtype).toBe('Widget');
  expect(created?.pageIndex).toBe(0);
  expect(created?.rect).toEqual([72, 300, 272, 324]);

  form = await openForm(page, 'Form data', 'Form data');
  await previewForm(form, 'Preview');
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  const data = JSON.parse(Buffer.from(await saveDownload(await download, 'form.json')).toString('utf8'));
  expect(JSON.stringify(data)).toContain('Grace Hopper');
  expect(JSON.stringify(data)).toContain('email');

  const edited = JSON.stringify(data).replace('Grace Hopper', 'Ada Lovelace');
  form = await openForm(page, 'Form data', 'Form data');
  await form.getByRole('radio', { name: 'Import' }).check();
  await form.locator('input[type="file"]').setInputFiles({
    name: 'values.json',
    mimeType: 'application/json',
    buffer: Buffer.from(edited),
  });
  await applyForm(form);
  expect((await readProducedPdf(await exported(page, 'imported.pdf'))).formValue).toBe('Ada Lovelace');
});

test('replace pages: the selected page takes its content from another PDF and from a blank page', async ({
  page,
}) => {
  await open(page, 'base.pdf', labelledPdf('Base', 3));
  await thumbs(page).nth(1).click();
  let form = await openForm(page, 'Replace Pages', 'Replace Pages');
  await form.getByRole('radio', { name: 'Another PDF' }).check();
  await form.locator('input[type="file"]').setInputFiles(pdfFile('donor.pdf', labelledPdf('Donor', 2)));
  await form.getByRole('textbox', { name: 'Source page range' }).fill('2');
  await applyForm(form);
  await expect(thumbs(page)).toHaveCount(3);

  await thumbs(page).nth(2).click();
  form = await openForm(page, 'Replace Pages', 'Replace Pages');
  await applyForm(form);
  const texts = await readProducedPageTexts(await exported(page, 'replaced.pdf'));
  expect(texts.map((text) => text.trim())).toEqual(['Base 1', 'Donor 2', '']);
});

/** Run a command from the palette that opens a dock panel instead of a form. */
async function runCommand(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill(command);
  await page.keyboard.press('Enter');
}

test('compare, accessibility and redaction audit: each panel reports on the open document', async ({
  page,
}) => {
  await open(page, 'base.pdf', labelledPdf('Base', 3));
  await runCommand(page, 'Document comparison');
  await page
    .locator('input[data-compare-picker]')
    .setInputFiles(pdfFile('other.pdf', labelledPdf('Other', 2)));
  await expect(page.getByText('Selected: other.pdf')).toBeVisible();
  await page.getByRole('button', { name: 'Compare text' }).click();
  await expect(page.getByText('Page count: 3 → 2')).toBeVisible({ timeout: 60_000 });
  const results = page.getByRole('table', { name: 'Page-by-page comparison results' });
  await expect(results.getByRole('cell', { name: 'Changed', exact: true })).toHaveCount(2);
  await expect(results.getByRole('cell', { name: 'Deleted', exact: true })).toHaveCount(1);

  await runCommand(page, 'Accessibility');
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await expect(page.getByText(/3 page\(s\) · \d+ issue\(s\)/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Tag document' }).click();
  await expect(notice(page, 'Accessibility tagging applied')).toBeVisible({ timeout: 60_000 });
  const tagged = await exported(page, 'tagged.pdf');
  expect(await readProducedEntry(tagged, null, 'StructTreeRoot')).not.toBe('');
  expect(await readProducedEntry(tagged, null, 'MarkInfo')).toMatch(/Marked\s+true/);

  await runCommand(page, 'Redaction audit');
  await page.getByRole('button', { name: 'Rerun audit' }).click();
  await expect(page.getByText(/File contains \d+ object\(s\) across 1 revision/)).toBeVisible({
    timeout: 60_000,
  });
});

test('page numbering: the template is stamped on every page but the skipped first one', async ({ page }) => {
  await open(page, 'bates.pdf', labelledPdf('Base', 3));
  const form = await openForm(page, 'Header / Footer', 'Header / Footer & Page Numbering');
  await form.getByRole('textbox', { name: 'Format' }).fill('BATES-{page}/{total}');
  await form.getByRole('checkbox', { name: 'Skip first page' }).check();
  // The count starts at the first stamped page, so the second page is the one that shows 2.
  await form.getByText('Advanced options').click();
  await form.getByRole('spinbutton', { name: 'Starting page number' }).fill('2');
  await applyForm(form);
  const texts = await readProducedPageTexts(await exported(page, 'bates-out.pdf'));
  expect(texts[0]).not.toContain('BATES');
  expect(texts[1]).toContain('BATES-2/3');
  expect(texts[2]).toContain('BATES-3/3');
});

test('security and remove password: the downloaded copy carries the permissions and an unlocked copy opens', async ({
  page,
}) => {
  await open(page);
  let form = await openForm(page, 'Security', 'Security');
  await form.getByLabel('Open password').fill('s3cret');
  await form.getByLabel('Owner password').fill('own3r');
  await form.getByRole('checkbox', { name: 'Copying' }).uncheck();
  await previewForm(form);
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  const encrypted = await saveDownload(await download, 'locked.pdf');
  const permissions = Number(await readProducedEntry(encrypted, 'trailer', 'Encrypt', 'P'));
  // Bit 5 (value 16) is "copy or extract text": cleared, while printing (bit 3, value 4) stays set.
  expect(permissions & 16).toBe(0);
  expect(permissions & 4).toBe(4);
  // The document in the editor is still the editable original.
  await expect(thumbs(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Create unlocked copy' })).toHaveCount(0);

  // A file that only an owner password restricts opens for editing; Remove password then
  // makes an unprotected copy of it in a new tab.
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles(pdfFile('owned.pdf', await encryptedToolFixturePdf('own3r', '')));
  await expect(page.getByRole('button', { name: 'owned.pdf', exact: true })).toBeVisible({ timeout: 30_000 });
  form = await openForm(page, 'Remove password', 'Remove password');
  await form.getByLabel('Password', { exact: true }).fill('own3r-owner');
  await previewForm(form, 'Open in new tab');
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(page.getByRole('button', { name: /unprotected/ })).toBeVisible({ timeout: 60_000 });
  const unlocked = await exported(page, 'unlocked.pdf');
  expect(await readProducedEntry(unlocked, 'trailer', 'Encrypt')).toBe('');
  expect((await readProducedPageTexts(unlocked))[0]).toContain('Third line stays untouched');
});

/** A one-page PDF with a 4x4 RGB picture, spelled in ASCII hex so the file stays plain text. */
function pictureBearingPdf(): Uint8Array {
  const pixels = '2060c0 '.repeat(16);
  const content = 'q 200 0 0 200 100 500 cm /Im0 Do Q\n';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${pixels.length + 1} >>\nstream\n${pixels}>\nendstream`,
  ];
  let source = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${xref}`;
  source += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${source.indexOf('xref\n')}\n%%EOF\n`;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}

/** A solid 8x8 RGB PNG, deflated and checksummed here so the test needs no image library. */
function solidPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 0x80)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('replace image: the picture in the file is swapped for the chosen PNG', async ({ page }) => {
  await open(page, 'picture.pdf', pictureBearingPdf());
  const form = await openForm(page, 'Replace Image', 'Replace Image');
  await form.getByRole('combobox', { name: 'Image' }).click();
  await page.locator('[data-base-ui-portal]').getByRole('option').first().click();
  await form.locator('input[type="file"]').setInputFiles({
    name: 'new.png',
    mimeType: 'image/png',
    buffer: solidPng(),
  });
  await applyForm(form);
  const bytes = await exported(page, 'picture-out.pdf');
  expect(await readProducedEntry(bytes, 0, 'Resources', 'XObject', 'Im0', 'Width')).toBe('8');
  expect(await readProducedEntry(bytes, 0, 'Resources', 'XObject', 'Im0', 'Height')).toBe('8');
});

/** Drag over a rectangle given in PDF points (origin bottom-left) on page 1. */
async function dragOnPage(page: Page, rect: readonly [number, number, number, number]): Promise<void> {
  const sheet = await page.locator('.pdfViewer[data-active-viewer] .page').first().boundingBox();
  if (sheet === null) throw new Error('no page box');
  const scale = sheet.width / 595;
  const [left, bottom, right, top] = rect;
  await page.mouse.move(sheet.x + left * scale, sheet.y + (842 - top) * scale);
  await page.mouse.down();
  await page.mouse.move(sheet.x + right * scale, sheet.y + (842 - bottom) * scale, { steps: 6 });
  await page.mouse.up();
}

test('link tool: two dragged rectangles become a web link and a page link in the file', async ({ page }) => {
  await open(page);
  await runCommand(page, 'Add link');
  await dragOnPage(page, [72, 380, 272, 410]);
  let form = page.getByRole('region', { name: 'Add link' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('textbox', { name: 'Address' }).fill('https://example.com/docs');
  await applyForm(form);

  await runCommand(page, 'Add link');
  await dragOnPage(page, [72, 320, 272, 350]);
  form = page.getByRole('region', { name: 'Add link' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('radio', { name: 'Page in this document' }).check();
  await form.getByRole('spinbutton', { name: 'Destination page' }).fill('2');
  await applyForm(form);

  const links = (await readProducedPdf(await exported(page, 'links.pdf'))).annotations.filter(
    (annotation) => annotation.subtype === 'Link' && annotation.pageIndex === 0,
  );
  // The fixture's own link plus the two drawn ones.
  expect(links).toHaveLength(3);
  const near = (rect: readonly number[], expected: readonly number[]) =>
    expected.every((value, index) => Math.abs((rect[index] ?? Number.NaN) - value) < 8);
  const web = links.find((link) => near(link.rect, [72, 380, 272, 410]));
  const internal = links.find((link) => near(link.rect, [72, 320, 272, 350]));
  expect(web).toBeDefined();
  expect(web?.destPageRef).toBeNull();
  expect(internal?.destPageRef).not.toBeNull();
});

test('edit menu: Select all picks every page, Rename renames the document and its export', async ({
  page,
}) => {
  await open(page, 'first.pdf', labelledPdf('Base', 3));
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(3);

  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Document name' });
  await expect(field).toBeFocused();
  await field.fill('renamed.pdf');
  await field.press('Enter');
  await expect(page.getByRole('button', { name: 'renamed.pdf', exact: true })).toBeVisible();
  await expect(notice(page, 'Document renamed: renamed.pdf')).toBeVisible();

  // Escape leaves the name alone.
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document name' }).fill('discarded.pdf');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'renamed.pdf', exact: true })).toBeVisible();

  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('renamed.pdf');
});

/** One page with two optional-content layers, each drawing its own line of text. */
function layeredPdf(): Uint8Array {
  const content =
    '/OC /L1 BDC BT /F1 24 Tf 72 700 Td (Alpha layer) Tj ET EMC\n' +
    '/OC /L2 BDC BT /F1 24 Tf 72 640 Td (Beta layer) Tj ET EMC\n';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R 7 0 R] /D << /Order [6 0 R 7 0 R] /ON [6 0 R 7 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /Properties << /L1 6 0 R /L2 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /OCG /Name (Alpha) >>',
    '<< /Type /OCG /Name (Beta) >>',
  ];
  let source = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${xref}`;
  source += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${source.indexOf('xref\n')}\n%%EOF\n`;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}

test('layers: a layer switched off in the panel is written into the file as hidden', async ({ page }) => {
  await open(page, 'layers.pdf', layeredPdf());
  await runCommand(page, 'Layers');
  const layers = page.getByRole('group', { name: 'Layers' });
  await expect(layers.getByRole('checkbox')).toHaveCount(2);
  await layers.getByRole('checkbox', { name: 'Beta' }).uncheck();
  await expect(layers.getByRole('checkbox', { name: 'Beta' })).not.toBeChecked();
  await layers.getByRole('button', { name: 'Write layer state to the document' }).click();
  const bytes = await exported(page, 'layers-out.pdf');
  // One of the two layers is in the default configuration's OFF list, the other is not.
  expect(await readProducedEntry(bytes, null, 'OCProperties', 'D', 'OFF')).toMatch(/^\[\s*\d+ 0 R\s*\]$/);
  const hidden = await readProducedEntry(bytes, null, 'OCProperties', 'D', 'OFF', 0, 'Name');
  expect(hidden).toContain('Beta');
});

/** The vault as the page sees it: the draft manifests and the source blobs actually stored. */
async function readVault(page: Page): Promise<{ drafts: string[]; sources: string[] }> {
  return await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const list = async (name: string): Promise<string[]> => {
      const names: string[] = [];
      try {
        const app = await root.getDirectoryHandle('pdf-editor');
        const dir = await app.getDirectoryHandle(name);
        for await (const [entry] of (
          dir as unknown as { entries(): AsyncIterable<[string, unknown]> }
        ).entries()) {
          names.push(entry);
        }
      } catch {
        return [];
      }
      return names.sort();
    };
    return {
      drafts: (await list('drafts')).filter((name) => name.endsWith('.json')),
      sources: await list('sources'),
    };
  });
}

test('browser storage: save, delete the stored copies, and the sensitive session that keeps nothing', async ({
  page,
}) => {
  await open(page);
  await runCommand(page, 'Save to Browser Storage');
  await expect(notice(page, 'Draft saved to browser storage')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await readVault(page)).drafts.length).toBe(1);
  expect((await readVault(page)).sources).toHaveLength(1);

  await runCommand(page, 'Delete Stored Copies');
  await expect.poll(async () => (await readVault(page)).drafts.length).toBe(0);
  expect((await readVault(page)).sources).toHaveLength(0);

  await runCommand(page, 'Sensitive Session');
  await expect(notice(page, 'Sensitive session: persistent draft disabled.')).toBeVisible();
  await runCommand(page, 'Save to Browser Storage');
  await expect(notice(page, 'Sensitive session: persistent draft disabled.')).toBeVisible();
  expect((await readVault(page)).drafts).toHaveLength(0);

  await runCommand(page, 'Sensitive Session');
  await expect(notice(page, 'Sensitive session disabled.')).toBeVisible();
  await runCommand(page, 'Save to Browser Storage');
  await expect.poll(async () => (await readVault(page)).drafts.length).toBe(1);
});

test('underline, strikeout and squiggly: each look reaches the file over the text it was dragged across', async ({
  page,
}) => {
  await open(page);
  // The file's own ink strokes cover the second line, so the marks go on the third and fourth.
  const lines = {
    Underline: PAGE_ONE_LINES[2],
    Strikeout: PAGE_ONE_LINES[3],
    Squiggly: PAGE_ONE_LINES[2],
  } as const;
  for (const [tool, { text }] of Object.entries(lines)) {
    await runCommand(page, tool);
    const box = await page.locator('.textLayer span').filter({ hasText: text }).first().boundingBox();
    if (box === null) throw new Error(`no text line "${text}"`);
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 0.25, box.y + box.height / 2, { steps: 16 });
    await page.mouse.up();
  }
  const produced = (await readProducedPdf(await exported(page, 'markup.pdf'))).annotations;
  for (const [subtype, line] of [
    ['Underline', lines.Underline],
    ['StrikeOut', lines.Strikeout],
    ['Squiggly', lines.Squiggly],
  ] as const) {
    const mark = produced.find((annotation) => annotation.subtype === subtype);
    expect(mark, subtype).toBeDefined();
    // The mark sits on its own line of text, not on another one.
    const centre = ((mark?.rect[1] ?? 0) + (mark?.rect[3] ?? 0)) / 2;
    expect(Math.abs(centre - (line.baseline + 4)), subtype).toBeLessThan(10);
  }
});

test('home "Merge PDFs" tile: two chosen files become one new document, in the order chosen', async ({
  page,
}) => {
  await page.goto('/editor/');
  await page.getByRole('button', { name: /^Merge PDFs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge PDFs' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog
    .locator('input[type="file"]')
    .setInputFiles([
      pdfFile('first.pdf', labelledPdf('First', 2)),
      pdfFile('second.pdf', labelledPdf('Second', 1)),
    ]);
  // The first press merges and reports; the result step's own press opens the new tab.
  const confirm = dialog.getByRole('button', { name: 'Open in new tab', exact: true });
  await confirm.click();
  await expect(dialog.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await confirm.click();
  await expect(page.getByRole('button', { name: 'Merged.pdf', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const texts = await readProducedPageTexts(await exported(page, 'combined.pdf'));
  expect(texts.map((text) => text.trim())).toEqual(['First 1', 'First 2', 'Second 1']);
});

test('export options: the compression level chosen in the dialog fills the Optimize form', async ({
  page,
}) => {
  await open(page);
  const viaExportDialog = async (level: string) => {
    await page.getByRole('button', { name: 'Export Options', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Download / Export' });
    await dialog.getByRole('radio', { name: 'Compressed PDF' }).check();
    await dialog.getByRole('combobox').first().selectOption(level);
    await dialog.getByRole('button', { name: 'Download Compressed PDF' }).click();
    const form = page.getByRole('region', { name: 'Optimize / Compress' });
    await expect(form).toBeVisible({ timeout: 30_000 });
    return form;
  };
  let form = await viaExportDialog('high');
  await expect(form.getByRole('radio', { name: 'Convert pages to image (lossy)' })).toBeChecked();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();

  form = await viaExportDialog('low');
  await expect(form.getByRole('radio', { name: 'Preserve structure (lossless)' })).toBeChecked();
  await form.getByText('Advanced options').click();
  await expect(form.getByRole('checkbox', { name: /Clear metadata/ })).not.toBeChecked();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();

  form = await viaExportDialog('medium');
  await form.getByText('Advanced options').click();
  await expect(form.getByRole('checkbox', { name: /Clear metadata/ })).toBeChecked();
});

test('batch: Bates numbers run across a queue of files and every finished file downloads', async ({
  page,
}) => {
  await page.goto('/editor/');
  await useAdvancedMode(page);
  // The home screen has no menu bar: the palette is the way to the batch dialog.
  await page.getByRole('button', { name: 'Search commands (Ctrl+K)' }).click();
  await page.getByRole('combobox').fill('Batch operations');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Batch operations' });
  await expect(dialog).toBeVisible();
  await dialog
    .locator('input[type="file"][accept*="pdf"]')
    .first()
    .setInputFiles([
      pdfFile('alpha.pdf', labelledPdf('Alpha', 2)),
      pdfFile('beta.pdf', labelledPdf('Beta', 1)),
    ]);
  await dialog.getByRole('checkbox', { name: 'Header / Footer & Page Numbering' }).check();
  await dialog.getByRole('radio', { name: 'Bates numbering' }).check();
  await dialog.getByRole('textbox', { name: 'Prefix' }).fill('CASE-');
  await dialog.getByRole('spinbutton', { name: 'Digits' }).fill('4');
  await dialog.getByRole('button', { name: 'Run batch' }).click();
  await expect(dialog.getByText('2 completed, 0 failed, 0 skipped')).toBeVisible({ timeout: 120_000 });

  const started: Download[] = [];
  page.on('download', (download) => started.push(download));
  await dialog.getByRole('button', { name: 'Download finished files' }).click();
  await expect.poll(() => started.length, { timeout: 60_000 }).toBe(2);
  const files = new Map<string, Uint8Array>();
  for (const download of started) {
    files.set(
      download.suggestedFilename(),
      await saveDownload(download, `batch-${download.suggestedFilename()}`),
    );
  }
  const names = [...files.keys()].sort();
  expect(names).toHaveLength(2);
  const alpha = await readProducedPageTexts(files.get(names[0] ?? '') ?? new Uint8Array());
  const beta = await readProducedPageTexts(files.get(names[1] ?? '') ?? new Uint8Array());
  expect(alpha.map((text) => text.includes('Alpha'))).toEqual([true, true]);
  expect(alpha[0]).toContain('CASE-0001');
  expect(alpha[1]).toContain('CASE-0002');
  expect(beta[0]).toContain('CASE-0001');
});

test('every operation dialog speaks English in the English interface, defaults included', async ({
  page,
}) => {
  // `openForm` fails on a Turkish letter in the form's text or in any field's value: the
  // watermark's default text was the Turkish "TASLAK".
  await open(page);
  for (const [command, region] of [
    ['Watermark', 'Watermark'],
    ['Page layout', 'Page layout (N-up / Booklet)'],
    ['Create PDF from Images', 'Create PDF from Images'],
    ['Edit outline', 'Edit outline (bookmarks)'],
    ['Fill form fields', 'Fill form fields'],
    ['Split Document', 'Split Document'],
    ['Insert Pages', 'Insert Pages'],
    ['Export Text', 'Export Text'],
    ['Export Pages as Images', 'Export Pages as Images'],
    ['Document properties', 'Document properties'],
    ['Sign document', 'Sign Document (PAdES B-B)'],
    ['Text recognition', 'Text recognition (OCR)'],
  ] as const) {
    const form = await openForm(page, command, region);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toBeHidden();
  }
  const watermark = await openForm(page, 'Watermark', 'Watermark');
  await expect(watermark.getByRole('textbox', { name: 'Text' })).toHaveValue('DRAFT');
});
