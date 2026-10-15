import { readFileSync } from 'node:fs';
import type { Page } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { applyForm } from './ui-helpers';

/**
 * Split document, by bookmarks: one file per bookmark of the outline, named after it, with the
 * pages before the first bookmark in a file of their own. The downloaded parts are read back with
 * the independent reader of `tool-fixture.ts`.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const CANVAS = '.pdfViewer[data-active-viewer] .page canvas';

/**
 * Six pages, "Sheet 1" to "Sheet 6", with the bookmarks `Intro` (page 3) and
 * `Method: part 2` (page 5, a title that is not a file name).
 */
function bookmarkedPdf(): Uint8Array {
  const pages = 6;
  const bodies: string[] = [];
  const first = 4 + pages * 2;
  bodies.push(`<< /Type /Catalog /Pages 2 0 R /Outlines ${first} 0 R >>`);
  bodies.push(
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_unused, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages} >>`,
  );
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let index = 0; index < pages; index += 1) {
    const content = `BT /F1 24 Tf 72 700 Td (Sheet ${index + 1}) Tj ET\n`;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
    );
    bodies.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  const page = (index: number) => `${4 + index * 2} 0 R`;
  bodies.push(`<< /Type /Outlines /First ${first + 1} 0 R /Last ${first + 2} 0 R /Count 2 >>`);
  bodies.push(`<< /Title (Intro) /Parent ${first} 0 R /Next ${first + 2} 0 R /Dest [${page(2)} /Fit] >>`);
  bodies.push(
    `<< /Title (Method: part 2) /Parent ${first} 0 R /Prev ${first + 1} 0 R /Dest [${page(4)} /Fit] >>`,
  );

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

async function openSplitForm(page: Page, name: string, bytes: Uint8Array) {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });
  await useAdvancedMode(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Split document');
  await page.keyboard.press('Enter');
  const form = page.getByRole('region', { name: 'Split document' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('radio', { name: 'By bookmarks' }).check();
  return form;
}

test('split by bookmarks: a file per bookmark, named after it, the front pages first', async ({ page }) => {
  const form = await openSplitForm(page, 'book.pdf', bookmarkedPdf());
  const started: { name: string; bytes: Uint8Array }[] = [];
  page.on('download', async (download) => {
    const path = test.info().outputPath(`part-${started.length}.pdf`);
    const slot = { name: download.suggestedFilename(), bytes: new Uint8Array() };
    started.push(slot);
    await download.saveAs(path);
    slot.bytes = new Uint8Array(readFileSync(path));
  });
  await applyForm(form, 'Download');
  await expect
    .poll(() => started.filter((part) => part.bytes.length > 0).length, { timeout: 60_000 })
    .toBe(3);
  const parts = [...started].sort((left, right) => left.name.localeCompare(right.name));
  expect(parts.map((part) => part.name)).toEqual([
    'book-1-Beginning.pdf',
    'book-2-Intro.pdf',
    'book-3-Method part 2.pdf',
  ]);
  const texts = await Promise.all(parts.map((part) => readProducedPageTexts(part.bytes)));
  expect(texts.map((part) => part.map((text) => text.trim()))).toEqual([
    ['Sheet 1', 'Sheet 2'],
    ['Sheet 3', 'Sheet 4'],
    ['Sheet 5', 'Sheet 6'],
  ]);
});

test('split by bookmarks: a document without bookmarks says so and points to another method', async ({
  page,
}) => {
  const form = await openSplitForm(page, 'plain.pdf', labelledPdf('Plain', 3));
  await form.getByRole('button', { name: 'Download' }).click();
  await expect(form.getByText('This document has no bookmarks to split at.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(form.getByText('Choose another way to split the document.')).toBeVisible();
});
