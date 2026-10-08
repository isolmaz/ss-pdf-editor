/**
 * Reading mode: a large line is shown as a heading, and the previous-page button turns
 * back a page.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { menuItem, openPdf } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

/** Two pages, each: one 30 pt title line and three 11 pt body lines (ASCII, computed xref). */
function headedPdf(): Uint8Array {
  const bodies: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids: number[] = [];
  for (const number of [1, 2]) {
    const lines = [
      `BT /F1 30 Tf 72 760 Td (Chapter ${number} overview) Tj ET`,
      `BT /F1 11 Tf 72 700 Td (The first body line of page ${number} is plain running text.) Tj ET`,
      `BT /F1 11 Tf 72 684 Td (The second body line follows the first one closely here.) Tj ET`,
      `BT /F1 11 Tf 72 668 Td (The third body line ends this short paragraph of prose.) Tj ET`,
    ].join('\n');
    kids.push(bodies.length + 1);
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${bodies.length + 2} 0 R >>`,
    );
    bodies.push(`<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`);
  }
  bodies[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count 2 >>`;
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

async function openReading(page: Page): Promise<void> {
  await openPdf(page, 'headed.pdf', headedPdf());
  await menuItem(page, 'View', /Reading mode/);
  await expect(page.getByRole('region', { name: 'Reading mode' })).toBeVisible({ timeout: 30_000 });
}

test('a large line of the page is a heading and the lines under it are one paragraph', async ({ page }) => {
  await openReading(page);
  const pane = page.getByRole('region', { name: 'Reading mode' });
  await expect(pane.getByRole('heading', { name: 'Chapter 1 overview' })).toBeVisible({ timeout: 30_000 });
  await expect(pane.locator('p.pdf-reading-block-paragraph')).toContainText(
    'The first body line of page 1 is plain running text.',
  );
});

test('the previous-page button turns back from page two and is off on page one', async ({ page }) => {
  await openReading(page);
  const pane = page.getByRole('region', { name: 'Reading mode' });
  await expect(pane.getByRole('heading', { name: 'Chapter 1 overview' })).toBeVisible({ timeout: 30_000 });
  await expect(pane.getByRole('button', { name: 'Go to page 1' })).toBeDisabled();
  await pane.getByRole('button', { name: 'Go to page 2' }).click();
  await expect(pane.getByRole('heading', { name: 'Chapter 2 overview' })).toBeVisible();
  await pane.getByRole('button', { name: 'Go to page 1' }).click();
  await expect(pane.getByRole('heading', { name: 'Chapter 1 overview' })).toBeVisible();
});
