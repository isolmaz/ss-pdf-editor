/**
 * Export to Word through the UI, in the two layouts that keep the page's look.
 *
 * "One picture per page": a two-page document (an A4 page and an A4 page turned on its
 * side) is exported, the downloaded .docx is unzipped, and it holds two sections of the
 * pages' sizes without margins and one picture file for each page.
 *
 * "Text and pictures, exact layout" (the default): a page with a heading, a paragraph and
 * a link is exported, and the .docx holds text boxes carrying the words, an external
 * hyperlink relationship and one section of the page's size.
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
  // The layout is a Word choice: the exact layout unless asked otherwise.
  await expect(form.getByRole('radio', { name: /exact layout/ })).toBeChecked();
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

/**
 * A one-page A4 PDF built byte by byte (ASCII, a computed cross-reference table): a bold
 * heading, a two-line paragraph, and a line of text under a real /Link annotation with a
 * URI action.
 */
function headingParagraphLinkPdf(uri: string): Uint8Array {
  const content = [
    'BT /F2 24 Tf 72 740 Td (Quarterly report) Tj ET',
    'BT /F1 12 Tf 72 700 Td 16 TL (Revenue grew steadily through the year) Tj T* (and costs stayed flat.) Tj ET',
    'BT /F1 12 Tf 72 640 Td (See example.org) Tj ET',
    '',
  ].join('\n');
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R /Annots [7 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /Type /Annot /Subtype /Link /Rect [72 636 160 652] /Border [0 0 0] /A << /S /URI /URI (${uri}) >> >>`,
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

test('Word as the exact layout (the default): text boxes with the words, a live link, one section', async ({
  page,
}) => {
  const uri = 'https://example.org/report';
  await openPdf(page, 'report.pdf', headingParagraphLinkPdf(uri));
  await runCommand(page, 'Export to Word');
  const form = page.getByRole('region', { name: 'Export to Word, Excel or CSV' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(form.getByRole('radio', { name: /exact layout/ })).toBeChecked();
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 90_000 });

  const download = page.waitForEvent('download', { timeout: 60_000 });
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('report.docx');
  const path = test.info().outputPath('report.docx');
  await saved.saveAs(path);

  const word = await JSZip.loadAsync(readFileSync(path));
  const document = (await word.file('word/document.xml')?.async('string')) ?? '';
  expect(document).toContain('<wps:txbx');
  for (const text of [
    'Quarterly report',
    'Revenue grew steadily through the year',
    'and costs stayed flat.',
  ]) {
    expect(document, text).toContain(text);
  }
  expect(document.match(/<w:pgSz [^>]*\/>/g)).toEqual(['<w:pgSz w:w="11900" w:h="16840"/>']);

  // The link is a hyperlink the document relates to the address, outside the package.
  const relationships = (await word.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
  const link = relationships.match(/<Relationship [^>]*>/g)?.find((element) => element.includes(uri));
  expect(link, relationships).toBeDefined();
  expect(link).toContain('TargetMode="External"');
});
