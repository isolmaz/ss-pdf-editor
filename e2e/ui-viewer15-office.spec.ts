/**
 * Export to Word, Excel or CSV: a document with no ruled table is written one sheet per
 * page, and each sheet carries the page's own number in its name.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { openPdf, runCommand } from './ui-helpers';

interface Workbook {
  file(name: string): { async(type: 'string'): Promise<string> } | null;
}
interface ZipReader {
  loadAsync(data: Buffer): Promise<Workbook>;
}

// pdf-core owns jszip; the repository root cannot resolve it.
const JSZip = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url))(
  'jszip',
) as ZipReader;

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

test('excel export of pages without a table names one sheet per page', async ({ page }) => {
  await openPdf(page, 'notes.pdf', labelledPdf('Notes', 2));
  await runCommand(page, 'Export to Word');
  const form = page.getByRole('region', { name: 'Export to Word, Excel or CSV' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('radio', { name: /Excel \(XLSX\)/ }).check();
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  const path = test.info().outputPath('notes.xlsx');
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/\.xlsx$/);
  await saved.saveAs(path);
  const workbook = await JSZip.loadAsync(readFileSync(path));
  const xml = await workbook.file('xl/workbook.xml')?.async('string');
  const names = [...(xml ?? '').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((match) => match[1]);
  expect(names).toEqual(['Page 1', 'Page 2']);
});
