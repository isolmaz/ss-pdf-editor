/**
 * Export a scanned page to Word in the exact layout, through the UI.
 *
 * The input is generated in the test: one page that is only a picture (no text layer at all)
 * of known printed lines. The exact layout reads it with OCR (Turkish and English, the
 * dialog's default), so the downloaded .docx must hold the words as text boxes, a comments
 * part only if a word was low-confidence (and then the report says so), and the report
 * says the page was read with OCR. Real recognition runs in the page's worker, so the test
 * has a generous timeout.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { paragraphTexts } from './docx-text';
import { expect, test } from './test';
import { scannedPdf } from './tool-fixture';
import { openPdf, runCommand } from './ui-helpers';

interface Package {
  readonly files: Readonly<Record<string, { readonly dir: boolean }>>;
  file(name: string): { async(type: 'string'): Promise<string> } | null;
}
interface ZipReader {
  loadAsync(data: Buffer): Promise<Package>;
}

// pdf-core owns jszip; the repository root cannot resolve it.
const JSZip = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url))(
  'jszip',
) as ZipReader;

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 600_000 });

const LINES = ['Invoice 2041', 'Total 318.40', 'Payment due Friday'] as const;

test('a scanned page exports to Word as text boxes read by OCR, with the report saying so', async ({
  page,
}) => {
  await openPdf(page, 'scan.pdf', await scannedPdf([LINES]));
  await runCommand(page, 'Export to Word');
  const form = page.getByRole('region', { name: 'Export to Word, Excel or CSV' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(form.getByRole('radio', { name: /exact layout/ })).toBeChecked();
  // The languages of a scan are asked with the exact layout: Turkish and English by default.
  const languages = form.getByRole('group', { name: /Languages of scanned pages/ });
  await expect(languages.getByRole('checkbox', { name: /Turkish/ })).toBeChecked();
  await expect(languages.getByRole('checkbox', { name: /English/ })).toBeChecked();

  await form.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 540_000 });
  await expect(form.getByText(/were read with OCR/)).toBeVisible();

  const download = page.waitForEvent('download', { timeout: 60_000 });
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('scan.docx');
  const path = test.info().outputPath('scan.docx');
  await saved.saveAs(path);

  const word = await JSZip.loadAsync(readFileSync(path));
  const document = (await word.file('word/document.xml')?.async('string')) ?? '';
  expect(document).toContain('<wps:txbx');
  // The words are text in the document (OCR noise allowed: nine in ten of them must be there).
  const text = paragraphTexts(document).join('\n');
  const expected = LINES.flatMap((line) => line.split(' '));
  const found = expected.filter((word) => text.includes(word));
  expect(
    found.length / expected.length,
    `${found.join(' ')} of ${expected.join(' ')} in: ${text}`,
  ).toBeGreaterThanOrEqual(0.9);
  // The scan itself is behind the text as pictures and the page colour: one section, no text-less picture page.
  expect(document.match(/<w:pgSz [^>]*\/>/g)).toEqual(['<w:pgSz w:w="11900" w:h="16840"/>']);

  // Comments exist exactly when a word was low-confidence, and the report names them then.
  const comments = word.file('word/comments.xml');
  const flagged = document.includes('<w:commentReference ');
  expect(comments !== null).toBe(flagged);
  if (flagged) {
    expect(await comments?.async('string')).toContain('Low OCR confidence');
    await expect(form.getByText(/read with low confidence and marked with a comment/)).toBeVisible();
  } else {
    await expect(form.getByText(/read with low confidence/)).toHaveCount(0);
  }
});
