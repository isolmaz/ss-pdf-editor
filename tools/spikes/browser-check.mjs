#!/usr/bin/env node
/**
 * Cross-browser verification driver — throwaway tooling, not the e2e suite
 * (`K28`: a committed test suite is opt-in; this is the “run the thing and look at
 * it” path).
 *
 * Why it exists: the managed Chromium in this environment stopped completing
 * `page.render()` (see `WORKLOG.md §4`), which blocks every pixel-level check. This
 * driver runs the assembled app in **Firefox** through Playwright — a different PDF
 * engine path (our own bundled pdf.js on Gecko's canvas) — and reports what it sees.
 * It doubles as the browser-matrix evidence `PLAN.md §4.5` asks for: Firefox has no
 * File System Access, so the file-input fallback and the Export explanation are the
 * paths actually exercised there.
 *
 * Usage: node tools/spikes/browser-check.mjs [--browser firefox|chromium] [fixture.pdf]
 */
import { chromium, firefox } from 'playwright';

const args = process.argv.slice(2);
const browserName = args.includes('--browser') ? args[args.indexOf('--browser') + 1] : 'firefox';
const fixture =
  args.find((value) => value.endsWith('.pdf')) ??
  'C:/Users/isolm/AppData/Local/Temp/pdf-editor-fixture-u4L2dW/fixture-5p.pdf';
const origin = process.env.VERIFY_ORIGIN ?? 'http://localhost:4178';
const outcome = { browser: browserName, fixture, steps: [], errors: [] };

// The managed Chromium build already on disk is reused instead of downloading
// Playwright's own copy: the point is to launch the same binaries through a
// different launcher, whose flag set may avoid the render stall (WORKLOG.md §4).
const executablePath =
  browserName === 'chromium' ? (process.env.CHROMIUM_PATH ?? chromium.executablePath()) : undefined;
const browser = await (browserName === 'chromium' ? chromium : firefox).launch(
  executablePath === undefined ? {} : { executablePath, headless: true },
);
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (error) => outcome.errors.push(`pageerror: ${error.message.slice(0, 200)}`));
page.on('console', (message) => {
  if (message.type() === 'error') outcome.errors.push(`console: ${message.text().slice(0, 200)}`);
});

const step = async (label, fn) => {
  try {
    outcome.steps.push({ label, result: await fn() });
  } catch (error) {
    outcome.steps.push({ label, error: String(error?.message ?? error).slice(0, 300) });
  }
};

await step('open empty editor', async () => {
  await page.goto(`${origin}/editor/`, { waitUntil: 'load' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
  return page.evaluate(() => document.body.innerText.includes('Bir PDF açın'));
});

await step('load fixture', async () => {
  await page.setInputFiles('input[type="file"]', fixture);
  await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
  return page.evaluate(() => ({
    pages: document.querySelectorAll('.pdfViewer .page').length,
    canvases: document.querySelectorAll('.pdfViewer canvas').length,
    textSpans: document.querySelectorAll('.textLayer span').length,
    pageClass: document.querySelector('.pdfViewer .page')?.className ?? '',
    status: document.querySelector('footer')?.innerText.replace(/\n/g, ' | ') ?? '',
  }));
});

await step('select text through the text layer', async () => {
  await page.waitForSelector('.textLayer span', { timeout: 30_000 });
  return page.evaluate(() => {
    const span = document.querySelector('.textLayer span');
    if (span === null) return null;
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return (selection?.toString() ?? '').slice(0, 60);
  });
});

await step('search with highlighting', async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Belgede ara')
      ?.click();
  });
  await page.waitForSelector('search input', { timeout: 15_000 });
  await page.fill('search input', 'Gizlilik');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  return page.evaluate(() => ({
    label: document.querySelector('search span')?.textContent ?? '',
    highlights: document.querySelectorAll('.highlight').length,
  }));
});

await step('document panel', async () => {
  await page.waitForFunction(() => document.querySelectorAll('[data-thumb]').length >= 3, {
    timeout: 30_000,
  });
  const thumbs = await page.evaluate(() => ({
    count: document.querySelectorAll('[data-thumb]').length,
    painted: [...document.querySelectorAll('[data-thumb] canvas')].filter((c) => c.width > 100).length,
  }));
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="tab"]')]
      .find((el) => el.textContent?.includes('İçindekiler'))
      ?.click();
  });
  const outline = await page.evaluate(() =>
    [...document.querySelectorAll('nav button')].map((b) => b.textContent?.trim()),
  );
  // Navigation is the point of the panel: click the last entry and read the page back.
  await page.evaluate(() => {
    const target = [...document.querySelectorAll('nav button')].at(-1);
    target?.click();
  });
  await page.waitForTimeout(1500);
  const afterClick = await page.evaluate(
    () => document.querySelector('footer')?.innerText.split('\n').join(' | ') ?? '',
  );
  return { thumbs, outline, afterClick };
});

await step('export explanation without File System Access', async () => {
  // Firefox has no showOpenFilePicker: Save must be disabled and Export must explain itself.
  const saveDisabled = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Kaydet' && b.disabled),
  );
  const picker = await page.evaluate(() => typeof globalThis.showOpenFilePicker);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Dışa aktar')?.click();
  });
  await page.waitForTimeout(1500);
  const notice = await page.evaluate(() =>
    [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent).join(' | '),
  );
  return { picker, saveDisabled, notice };
});

await step('draft survives a reload', async () => {
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(4000);
  return page.evaluate(() => ({
    tabs: document.querySelectorAll('[aria-label^="Sekmeyi kapat"]').length,
    notices: [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent).join(' | '),
  }));
});

await browser.close();
console.log(JSON.stringify(outcome, null, 1));
