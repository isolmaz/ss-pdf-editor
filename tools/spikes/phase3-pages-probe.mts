/**
 * Throwaway (`K21`): one question, asked in the driver's own order — **why does the page
 * action after a form fill do nothing?**
 *
 *   npx tsx tools/spikes/phase3-pages-probe.mts
 *
 * Requires the assembled `dist/` served under the production policy on port 4199
 * (`node tools/preview-dist.mjs --port 4199`).
 *
 * Measured with this file: with no form fill the two-page delete works (4 → 2 in under 5 s);
 * after a form fill, on the build before `cb727c4`, the same click left the footer untouched
 * for 45 s and raised **no `click` event on the document at all**, while a manual DOM
 * `click()` on that button deleted the pages. That diagnosis ended in the fix committed as
 * `cb727c4` (the panel keeps its seeded draft; a fill repeating the document's value is not
 * written), after which the fill-then-delete sequence lands in under 5 s.
 *
 * `MARK=1` adds the driver's underline step before the page action, to ask whether a *mark*
 * write swallows the next press the way a fill did. **That variant does not yet measure what
 * it says, and the reason is measured rather than guessed:** the step selects the text (the
 * selection is live at the dispatch point, the span's own box), toggles the tool through the
 * driver's own menu path, dispatches `mouseup` on the page overlay — and after four seconds
 * **no tool is active at all** (`tool state: []`) and no notice appears. The menu item's click
 * does not take, which is the same shape as the press that vanishes on the pages toolbar: a
 * click that lands on an element the next render has already replaced. So the mark variant
 * also belongs to the press-swallow family, not to this file's original question, and the run
 * above is the no-fill control rather than a mark case.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { chromium } from 'playwright';
import { createFixture } from './mupdf-fixture.mjs';

/** The driver's own fixture, rebuilt here so the probe is one file (`phase3-check.mjs:61`). */
const FIXTURE_PAGES = 4;
const dir = join(tmpdir(), `pdf-editor-pages-probe-${process.pid}`);
mkdirSync(dir, { recursive: true });
const fixture = join(dir, 'phase3-fixture-4p.pdf');
{
  const pdf = createFixture(mupdf);
  for (let index = 1; index <= FIXTURE_PAGES; index += 1) {
    const sheet = pdf.addPage(595.28, 841.89);
    sheet.text(`Phase 3 fixture - page ${index} of ${FIXTURE_PAGES}`, {
      x: 56,
      y: 760,
      size: 18,
      color: [0.1, 0.1, 0.1],
    });
    for (let line = 0; line < 10; line += 1) {
      sheet.text(`Page ${index} body line ${line + 1}`, {
        x: 56,
        y: 680 - line * 20,
        size: 11,
        color: [0.15, 0.15, 0.15],
      });
    }
    if (index === 1) sheet.textField('musteri', [56, 90, 276, 114], 'Ada Lovelace');
  }
  writeFileSync(fixture, pdf.save());
}

const exe = chromium.executablePath();
const browser = await chromium.launch(
  existsSync(exe) ? { executablePath: exe, headless: true } : { headless: true },
);
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
page.on('console', (message) => {
  const text = message.text();
  if (text.startsWith('[pages')) console.log('APP>', text);
});

/** Every evaluate is a plain string: tsx injects `__name` into function form and breaks it. */
const footer = async () =>
  page.evaluate("document.querySelector('footer')?.textContent?.trim() ?? '(no footer)'");
const findDelete = [
  "[...document.querySelectorAll('button')]",
  ".find((node) => ((node.getAttribute('aria-label') ?? node.textContent ?? '').trim()) === 'Sayfaları sil')",
].join('');

await page.goto('http://localhost:4199/editor/', { waitUntil: 'load' });
await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
await page.setInputFiles('input[type="file"]', fixture);
await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
await page.waitForTimeout(900);
console.log('after open      :', await footer());

// The driver's order: the form fill happens first, and it writes more than once per edit.
// `SKIP_FILL=1` runs the same probe without it, to measure what the fill changes.
if (process.env.SKIP_FILL !== '1') {
  await page.getByRole('tab', { name: 'Form alanları', exact: true }).first().click();
  await page.waitForTimeout(700);
  const row = page.locator('ul[aria-label="Form alanları"] li').first();
  await row.getByRole('button').first().click();
  const input = page.locator('#form-musteri');
  await input.waitFor({ state: 'visible', timeout: 20_000 });
  await input.fill('Grace Hopper');
  await input.press('Enter');
  await page.waitForTimeout(3000);
  // The driver re-opens the same field after the fill and expects the editor again. That
  // second open is where the acceptance driver fails (`WORKLOG.md §4`), so it is asked here.
  const rowAgain = page.locator('ul[aria-label="Form alanları"] li').first();
  await rowAgain.getByRole('button').first().click();
  await page.waitForTimeout(1500);
  console.log('reopen input    :', await page.locator('#form-musteri').count());
  console.log(
    'reopen state    :',
    await page.evaluate(
      "JSON.stringify({ current: document.querySelector('li[data-field-row] button')?.getAttribute('aria-current') ?? '(none)', rows: document.querySelectorAll('ul[aria-label=\"Form alanları\"] > li').length })",
    ),
  );
  console.log(
    'form notice     :',
    await page.evaluate(
      "document.querySelector('[role=\"status\"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '(none)'",
    ),
  );
}

// `MARK=1` adds the driver's own underline step before the page action, to measure whether a
// *mark* write (not just a form fill) is enough to swallow the next press.
if (process.env.MARK === '1') {
  await page.getByRole('tab', { name: 'Notlar', exact: true }).first().click();
  await page.waitForTimeout(600);
  const selected = await page.evaluate(
    "(() => { const spans = [...document.querySelectorAll('.textLayer span')]; const target = spans.find((node) => (node.textContent ?? '').includes('body line')); if (target === undefined) return ''; const range = document.createRange(); range.selectNodeContents(target); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return selection?.toString() ?? ''; })()",
  );
  console.log('selected text   :', JSON.stringify(selected).slice(0, 40));
  // The driver's own menu path: `menubar` → `menu`, and toggle commands are checkboxes.
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Araçlar', exact: true }).first().click();
  const toolItem = page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Altı çizili', exact: true })
    .or(page.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Altı çizili', exact: true }))
    .first();
  await toolItem.waitFor({ state: 'visible', timeout: 10_000 });
  await toolItem.click();
  await page.waitForTimeout(600);
  // The dispatch point comes from the selected span itself, and the reason is printed when
  // nothing lands: the app commits the tool on `mouseup` inside the page, so a point outside
  // the text layer's own box is a click that marks nothing.
  const target = (await page.evaluate(
    "JSON.stringify((() => { const span = [...document.querySelectorAll('.textLayer span')].find((node) => (node.textContent ?? '').includes('body line')); if (span === undefined) return null; const rect = span.getBoundingClientRect(); return [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2), Math.round(rect.width), Math.round(rect.height)]; })())",
  )) as string;
  const box = JSON.parse(target) as [number, number, number, number] | null;
  console.log('span box        :', box === null ? '(not found)' : box.join(','));
  if (box !== null) {
    console.log(
      'selection live  :',
      await page.evaluate("(window.getSelection()?.toString() ?? '').slice(0, 30) || '(empty)'"),
    );
    await page.evaluate(
      `(() => { const overlay = document.querySelector('[role="application"]:not([data-l10n-id])'); overlay?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${box[0]}, clientY: ${box[1]}, button: 0 })); })()`,
    );
  }
  await page.waitForTimeout(4000);
  console.log(
    'tool state      :',
    await page.evaluate(
      "JSON.stringify([...document.querySelectorAll('[aria-checked=\"true\"], [aria-pressed=\"true\"]')].map((node) => (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 24)))",
    ),
  );
  console.log(
    'menu item kind  :',
    await page.evaluate(
      "(() => { const item = [...document.querySelectorAll('[role=\"menuitemcheckbox\"], [role=\"menuitem\"]')].find((node) => (node.textContent ?? '').trim() === 'Altı çizili'); return item === undefined ? '(gone)' : item.getAttribute('role') + ' checked=' + item.getAttribute('aria-checked'); })()",
    ),
  );
  console.log(
    'mark notice     :',
    await page.evaluate(
      "document.querySelector('[role=\"status\"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '(none)'",
    ),
  );
}

await page.getByRole('tab', { name: 'Sayfalar', exact: true }).first().click();
await page.waitForTimeout(800);
console.log('rows            :', await page.getByRole('option').count());
await page.getByRole('option').nth(1).click();
await page.waitForTimeout(300);
await page
  .getByRole('option')
  .nth(2)
  .click({ modifiers: ['Control'] });
await page.waitForTimeout(400);

const centre = (await page.evaluate(
  `JSON.stringify((() => { const node = ${findDelete}; if (node === undefined) return null; const box = node.getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]; })())`,
)) as string;
const point = JSON.parse(centre) as [number, number] | null;
console.log('delete button   :', point === null ? '(not found)' : `centre ${point.join(',')}`);

if (point !== null) {
  // A real press, then the pointer is released on whatever the DOM holds at that moment.
  await page.mouse.move(point[0], point[1]);
  await page.mouse.down();
  await page.mouse.up();
  console.log(
    'marked after up :',
    await page.evaluate(
      `(() => { const node = ${findDelete}; return node === undefined ? '(gone)' : 'present'; })()`,
    ),
  );
}

for (const seconds of [5, 15, 30]) {
  await page.waitForTimeout(seconds === 5 ? 5_000 : seconds === 15 ? 10_000 : 15_000);
  console.log(`footer at ${seconds}s  :`, await footer());
}
console.log(
  'notice          :',
  await page.evaluate(
    "document.querySelector('[role=\"status\"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '(none)'",
  ),
);
await browser.close();
