/**
 * Export to Word as one picture per page, through the UI: a two-page document (an A4 page and
 * an A4 page turned on its side) is exported with "One picture per page", the downloaded
 * .docx is unzipped, and it holds two sections of the pages' sizes without margins and one
 * picture file for each page.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
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
test.describe.configure({ timeout: 180_000 });

test('Word as one picture per page: a section and a picture for each page, at its size', async ({ page }) => {
  await openPdf(page, 'plan.pdf', labelledPdf('Plan', 2, { rotations: [0, 90] }));
  await runCommand(page, 'Export to Word');
  const form = page.getByRole('region', { name: 'Export to Word, Excel or CSV' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  // The layout is a Word choice: flowing text unless asked otherwise.
  await expect(form.getByRole('radio', { name: /Flowing text/ })).toBeChecked();
  await form.getByRole('radio', { name: /One picture per page/ }).check();
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 90_000 });

  const download = page.waitForEvent('download', { timeout: 60_000 });
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('plan.docx');
  const path = test.info().outputPath('plan.docx');
  await saved.saveAs(path);

  const word = await JSZip.loadAsync(readFileSync(path));
  const document = (await word.file('word/document.xml')?.async('string')) ?? '';
  expect(document.match(/<w:pgSz [^>]*\/>/g)).toEqual([
    '<w:pgSz w:w="11900" w:h="16840"/>',
    '<w:pgSz w:w="16840" w:h="11900" w:orient="landscape"/>',
  ]);
  expect(document.match(/<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0"/g)).toHaveLength(2);
  expect(document.match(/<wp:anchor /g)).toHaveLength(2);
  const media = Object.keys(word.files)
    .filter((name) => name.startsWith('word/media/') && !word.files[name]?.dir)
    .sort();
  expect(media).toEqual(['word/media/page1.png', 'word/media/page2.png']);
});
