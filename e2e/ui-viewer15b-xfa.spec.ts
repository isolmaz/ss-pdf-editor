/**
 * The XFA dialogs that are not the fill viewer: export and import of the form's data, and
 * removing the XFA while keeping the AcroForm.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedEntry } from './tool-fixture';
import { exportBytes, openPdf, runCommand } from './ui-helpers';
import { dynamicXfaPdf, XFA_DATASETS, XFA_TEMPLATE } from './ui-xfa-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** A static XFA form: a page with a real text field (`Name`), and the XFA packets next to the AcroForm. */
function staticXfaPdf(): Uint8Array {
  const stream = (body: string) => `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 10 0 R >> >> /Contents 4 0 R /Annots [11 0 R] >>',
    stream('BT /F1 14 Tf 40 700 Td (Customer) Tj ET'),
    '<< /Fields [11 0 R] /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 10 0 R >> >> /XFA [(template) 7 0 R (datasets) 8 0 R] >>',
    stream(''),
    stream(XFA_TEMPLATE),
    stream(XFA_DATASETS),
    stream(''),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /V (Ada Lovelace) /Rect [40 640 300 660] /P 3 0 R /F 4 /DA (/F1 12 Tf 0 g) >>',
  ];
  let source = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  const start = source.length;
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${xref}`;
  source += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}

const NEW_DATA =
  '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Grace Hopper</Name><City>Arlington</City></form1></xfa:data></xfa:datasets>';

/** Run the form's export: the report first, then the download it offers. */
async function downloadData(page: Page, form: Locator): Promise<string> {
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await form.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await download;
  const path = test.info().outputPath(saved.suggestedFilename());
  await saved.saveAs(path);
  return readFileSync(path, 'utf8');
}

test('export XFA data downloads the datasets the form holds', async ({ page }) => {
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  await runCommand(page, 'Export or import XFA data');
  const form = page.getByRole('region', { name: 'XFA data' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(form.getByRole('radio', { name: 'Export', exact: true })).toBeChecked();
  const xml = await downloadData(page, form);
  expect(xml).toContain('Ada Lovelace');
  expect(xml).toContain('London');
});

test('import XFA data replaces the form values in the document', async ({ page }) => {
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  await runCommand(page, 'Export or import XFA data');
  const form = page.getByRole('region', { name: 'XFA data' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('radio', { name: 'Import', exact: true }).check();
  await form.locator('input[type="file"]').setInputFiles({
    name: 'data.xml',
    mimeType: 'application/xml',
    buffer: Buffer.from(NEW_DATA),
  });
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
  // Read back through the export of the same dialog: the datasets now hold the imported values.
  await runCommand(page, 'Export or import XFA data');
  const again = page.getByRole('region', { name: 'XFA data' });
  await expect(again).toBeVisible({ timeout: 30_000 });
  const xml = await downloadData(page, again);
  expect(xml).toContain('Grace Hopper');
  expect(xml).toContain('Arlington');
  expect(xml).not.toContain('Ada Lovelace');
});

test('import XFA data without a file is refused, naming the missing file', async ({ page }) => {
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  await runCommand(page, 'Export or import XFA data');
  const form = page.getByRole('region', { name: 'XFA data' });
  await form.getByRole('radio', { name: 'Import', exact: true }).check();
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  const alert = form.getByRole('alert');
  await expect(alert).toContainText('This operation has nothing to work with yet.', { timeout: 60_000 });
  await expect(alert.locator('[data-dialog-diagnostic]')).toHaveAttribute(
    'data-dialog-diagnostic',
    'no XFA data file chosen',
  );
});

test('remove XFA on a dynamic form is refused: its content exists only in the template', async ({ page }) => {
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  await runCommand(page, 'Remove XFA');
  const form = page.getByRole('region', { name: 'Remove XFA' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('button', { name: 'Remove XFA', exact: true }).click();
  const alert = form.getByRole('alert');
  await expect(alert).toContainText(
    'This is a dynamic XFA form: its content exists only in the XFA template.',
    {
      timeout: 60_000,
    },
  );
  await expect(alert.locator('[data-dialog-diagnostic]')).toHaveAttribute(
    'data-dialog-diagnostic',
    'dynamic XFA has no AcroForm',
  );
});

test('remove XFA on a static form drops the XFA entry and keeps the AcroForm field', async ({ page }) => {
  await openPdf(page, 'static.pdf', staticXfaPdf());
  await runCommand(page, 'Remove XFA');
  const form = page.getByRole('region', { name: 'Remove XFA' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('button', { name: 'Remove XFA', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
  const bytes = await exportBytes(page, 'no-xfa.pdf');
  expect(await readProducedEntry(bytes, null, 'AcroForm', 'XFA')).toBe('');
  expect(await readProducedEntry(bytes, null, 'AcroForm', 'Fields', 0, 'T')).toBe('(Name)');
});
