/**
 * Throwaway (`K21`): do the operation dialogs still open, and if not, what does the
 * app say? Prints the notice line and the console errors after one menu command.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { chromium } from 'playwright';
import { createFixture } from './mupdf-fixture.mjs';

const dir = join(process.env.TEMP ?? '.', 'p3dialogs');
mkdirSync(dir, { recursive: true });
const pdf = createFixture(mupdf);
pdf.addPage(595.28, 841.89).text('Dialog probe', { x: 56, y: 780, size: 16, color: [0.1, 0.1, 0.1] });
const path = join(dir, 'dialog.pdf');
writeFileSync(path, pdf.save());

const exe = chromium.executablePath();
const browser = await chromium.launch(
  existsSync(exe) ? { executablePath: exe, headless: true } : { headless: true },
);
const page1 = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page1.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 200)}`));
page1.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 200)}`);
});

await page1.goto('http://localhost:4198/editor/', { waitUntil: 'load' });
await page1.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
await page1.setInputFiles('input[type="file"]', path);
try {
  await page1.waitForSelector('.pdfViewer .page', { timeout: 20_000 });
} catch {
  console.log('OPEN FAILED — errors so far:', errors.slice(0, 4));
  console.log(
    'body:',
    (await page1.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 200),
  );
  await browser.close();
  process.exit(1);
}
await page1.waitForTimeout(800);

for (const [menu, command] of [
  ['Araçlar', 'Üst bilgi / alt bilgi ve sayfa numarası'],
  ['Sayfa', 'Sayfa etiketleri'],
  ['Dosya', 'Belge özellikleri'],
]) {
  await page1.getByRole('menubar').getByRole('menuitem', { name: menu, exact: true }).first().click();
  const menuPanel = page1.getByRole('menu');
  await menuPanel.waitFor({ state: 'visible', timeout: 8000 });
  const entries = (await menuPanel.innerText()).replace(/\s+/g, ' ');
  const item = menuPanel.getByText(command, { exact: false }).first();
  const count = await item.count();
  console.log(`menu "${menu}": ${count} match(es) for "${command}" | entries: ${entries.slice(0, 160)}`);
  if (count === 0) continue;
  const disabled = await item.evaluate((node) => {
    const button = node.closest('button');
    return button === null ? 'not-a-button' : button.disabled;
  });
  console.log('  disabled:', disabled);
  if (disabled === true) continue;
  await item.click();
  await page1.waitForTimeout(2500);
  const state = await page1.evaluate(() => ({
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
  }));
  console.log('  dialogs:', state.dialogs, '| body:', state.body.slice(0, 180));
  await page1.keyboard.press('Escape');
  await page1.waitForTimeout(400);
}

console.log('errors:', errors.slice(0, 6));
await browser.close();
