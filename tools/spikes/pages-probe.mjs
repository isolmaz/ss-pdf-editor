/**
 * Throwaway (`K21`): does selecting two pages in the list enable the delete action,
 * and does the page count change? Prints the selection state and the button's own
 * disabled flag, so a failure names the step instead of the symptom.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { chromium } from 'playwright';
import { createFixture } from './mupdf-fixture.mjs';

const dir = join(process.env.TEMP ?? '.', 'p3pages');
mkdirSync(dir, { recursive: true });
const pdf = createFixture(mupdf);
for (let index = 1; index <= 4; index += 1) {
  pdf.addPage(595.28, 841.89).text(`page ${index}`, { x: 56, y: 780, size: 16, color: [0.1, 0.1, 0.1] });
}
const path = join(dir, 'pages.pdf');
writeFileSync(path, pdf.save());

const exe = chromium.executablePath();
const browser = await chromium.launch(
  existsSync(exe) ? { executablePath: exe, headless: true } : { headless: true },
);
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message.slice(0, 160)));

await page.goto('http://localhost:4198/editor/', { waitUntil: 'load' });
await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
await page.setInputFiles('input[type="file"]', path);
await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
await page.waitForTimeout(900);
// One session mark first: page deletion re-composes the document, and the mark's
// pageIndex has to survive that — the harness failed exactly this way.
await page.getByRole('menubar').getByRole('menuitem', { name: 'Araçlar', exact: true }).first().click();
const toolsMenu = page.getByRole('menu');
await toolsMenu.waitFor({ state: 'visible' });
await toolsMenu.getByText('Dikdörtgen', { exact: true }).first().click();
await page.waitForTimeout(400);
const box = await page.evaluate(() => {
  const sheet = document.querySelector('.pdfViewer .page');
  const rect = sheet?.getBoundingClientRect();
  return rect === undefined ? null : { x: rect.x, y: rect.y };
});
await page.mouse.move(box.x + 120, box.y + 220);
await page.mouse.down();
await page.mouse.move(box.x + 240, box.y + 300, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(700);
await page.keyboard.press('Escape');

await page.getByRole('tab', { name: 'Sayfalar', exact: true }).first().click();
await page.waitForTimeout(600);

const options = page.locator('[data-page-option]');
console.log('page options:', await options.count());
await options.nth(1).click();
await options.nth(2).click({ modifiers: ['Control'] });
await page.waitForTimeout(400);
console.log(
  'selection:',
  await page.evaluate(() =>
    JSON.stringify(
      [...document.querySelectorAll('[data-page-option]')].map((node) => node.getAttribute('aria-selected')),
    ),
  ),
);

const remove = page.getByRole('button', { name: 'Sayfaları sil', exact: true }).first();
console.log('delete button present:', await remove.count(), '| disabled:', await remove.isDisabled());
await remove.click();
await page.waitForTimeout(2500);
console.log(
  'footer:',
  (await page.evaluate(() => document.querySelector('footer')?.textContent ?? ''))
    .replace(/\s+/g, ' ')
    .slice(0, 60),
);
console.log(
  'body notices:',
  (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 160),
);
console.log(
  'session marks after delete:',
  await page.evaluate(() =>
    JSON.stringify((globalThis.__annState ?? []).map((mark) => `${mark.kind}@${mark.pageIndex}`)),
  ),
);
console.log('errors:', errors.slice(0, 4));
await browser.close();
