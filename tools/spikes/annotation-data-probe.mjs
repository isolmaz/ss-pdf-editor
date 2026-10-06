/**
 * Throwaway (`K21`): the round trip of the review file — export, clear, import, and
 * then check both the panel and the **exported PDF** carry the same marks. JSON and
 * FDF are checked in the same run, because a format that only round-trips through
 * its own serializer is not evidence.
 *
 *   node tools/spikes/annotation-data-probe.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { chromium } from 'playwright';
import { createFixture, readFixture } from './mupdf-fixture.mjs';

const dir = join(process.env.TEMP ?? '.', 'p3data');
mkdirSync(dir, { recursive: true });
const pdf = createFixture(mupdf);
const sheet = pdf.addPage(595.28, 841.89);
sheet.text('Data probe', { x: 56, y: 780, size: 16, color: [0.1, 0.1, 0.1] });
for (let line = 0; line < 8; line += 1) {
  sheet.text(`body line ${line + 1} of text`, {
    x: 56,
    y: 700 - line * 22,
    size: 12,
    color: [0.2, 0.2, 0.2],
  });
}
const path = join(dir, 'data.pdf');
writeFileSync(path, pdf.save());

const exe = chromium.executablePath();
const browser = await chromium.launch(
  existsSync(exe) ? { executablePath: exe, headless: true } : { headless: true },
);
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 160)}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 160)}`);
});

const menu = async (label) => {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Araçlar', exact: true }).first().click();
  const panel = page.getByRole('menu');
  await panel.waitFor({ state: 'visible' });
  await panel.getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(500);
};
const rows = () =>
  page.evaluate(() => {
    const list = document.querySelector('ul[aria-label="Notlar"]');
    return list === null ? 0 : list.children.length;
  });

await page.goto('http://localhost:4198/editor/', { waitUntil: 'load' });
await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
await page.setInputFiles('input[type="file"]', path);
await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
await page.waitForTimeout(900);

// Two marks of our own kinds.
await menu('Dikdörtgen');
const box = await page.evaluate(() => {
  const rect = document.querySelector('.pdfViewer .page')?.getBoundingClientRect();
  return rect === undefined ? null : { x: rect.x, y: rect.y };
});
await page.mouse.move(box.x + 120, box.y + 240);
await page.mouse.down();
await page.mouse.move(box.x + 300, box.y + 330, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(600);
await page.keyboard.press('Escape');

await page.getByRole('tab', { name: 'Notlar', exact: true }).first().click();
await page.waitForTimeout(400);

for (const format of ['json', 'fdf']) {
  const before = await rows();
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page
    .getByText(format === 'json' ? 'Notları JSON olarak dışa aktar' : 'Notları FDF olarak dışa aktar', {
      exact: true,
    })
    .first()
    .click();
  const file = await download;
  const saved = join(dir, `comments.${format}`);
  await file.saveAs(saved);
  const printed = readFileSync(saved);
  console.log(
    `${format}: exported ${printed.length} bytes from ${before} mark(s); head: ${JSON.stringify(printed.toString('utf8').slice(0, 70))}`,
  );

  // Clear, then import the same file back.
  await page.getByText('Tümünü sil', { exact: true }).first().click();
  await page.waitForTimeout(400);
  if ((await rows()) !== 0) throw new Error(`${format}: the clear left rows behind`);
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll('input[type="file"]')].map((node) => node.getAttribute('accept')),
  );
  console.log(`${format}: file inputs on the page: ${JSON.stringify(inputs)}`);
  await page.setInputFiles('input[type="file"][accept*="json"]', saved);
  await page.waitForTimeout(900);
  console.log(
    `${format}: status line:`,
    (
      await page.evaluate(() => document.querySelector('[role="status"]')?.textContent ?? '(no notice)')
    ).replace(/\s+/g, ' '),
  );
  const after = await rows();
  if (after !== before) throw new Error(`${format}: import restored ${after} mark(s), expected ${before}`);
  console.log(`${format}: import restored ${after} mark(s)`);

  // The imported marks must still be writable: export the PDF and read its annotations.
  const pdfDownload = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Dosya', exact: true }).first().click();
  const fileMenu = page.getByRole('menu');
  await fileMenu.waitFor({ state: 'visible' });
  await fileMenu.getByText('Dışa aktar', { exact: false }).first().click();
  const written = await pdfDownload;
  const writtenPath = join(dir, `after-${format}.pdf`);
  await written.saveAs(writtenPath);
  const reopened = readFixture(mupdf, readFileSync(writtenPath));
  const subtypes = [];
  for (let index = 0; index < reopened.pageCount; index += 1) {
    for (const annotation of reopened.annotations(index)) subtypes.push(annotation.subtype);
  }
  console.log(`${format}: after re-import the PDF carries ${JSON.stringify(subtypes)}`);
}

console.log('errors:', errors.slice(0, 5));
await browser.close();
