/**
 * Owner-reported bug verification (throwaway, `PLAN.md §9/K21`):
 *   1. thumbnails must stay upright after Pages -> Outline -> Pages,
 *   2. thumbnails must not stay black on a long document after the same dance,
 *   3. the floating toolbar must sit at the top right of the viewer, clear of the page.
 *
 * The upright check uses a fixture whose text sits in the **upper** half: if a thumbnail is
 * drawn upside down, the ink lands in its lower half and the check fails.
 *
 * Usage: node tools/spikes/verify-thumbnails.mjs [origin]
 */
import { chromium } from 'playwright';

const origin = process.argv[2] ?? process.env.VERIFY_ORIGIN ?? 'http://localhost:4178';
const SMALL = 'C:/Users/isolm/AppData/Local/Temp/pdf-editor-fonts/standard14-1p.pdf';
const LARGE = 'C:/Users/isolm/AppData/Local/Temp/pdf-editor-img/photo-130p.pdf';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 160)));

const openTab = async (label) => {
  await page.evaluate((text) => {
    [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes(text))?.click();
  }, label);
  await page.waitForTimeout(1600);
};

const thumbStats = () =>
  page.evaluate(() => {
    const rows = [];
    for (const holder of document.querySelectorAll('[data-thumb]')) {
      const canvas = holder.querySelector('canvas');
      const box = holder.getBoundingClientRect();
      if (canvas === null || box.bottom < 0 || box.top > window.innerHeight) continue;
      const context2d = canvas.getContext('2d');
      const data = context2d?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (data === undefined) continue;
      let top = 0;
      let bottom = 0;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const i = (y * canvas.width + x) * 4;
          const ink = data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200;
          if (!ink) continue;
          if (y < canvas.height / 2) top += 1;
          else bottom += 1;
        }
      }
      rows.push({
        page: holder.getAttribute('data-thumb'),
        top,
        bottom,
        size: `${canvas.width}x${canvas.height}`,
      });
    }
    return rows;
  });

try {
  await page.goto(`${origin}/editor/`, { waitUntil: 'load' });

  // 3. toolbar placement, measured against the viewer box
  await page.waitForSelector('input[type="file"]', { state: 'attached' });
  await page.setInputFiles('input[type="file"]', SMALL);
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
  await page.waitForTimeout(2500);
  const toolbar = await page.evaluate(() => {
    const cluster = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === '100%',
    )?.parentElement;
    const viewer = document.querySelector('.pdfViewer')?.getBoundingClientRect();
    if (cluster === null || cluster === undefined || viewer === undefined) return null;
    const rect = cluster.getBoundingClientRect();
    const _page = document.querySelector('.pdfViewer .page')?.getBoundingClientRect();
    return {
      rightGap: Math.round(viewer.right - rect.right),
      topGap: Math.round(rect.top - viewer.top),
      // The viewer scrolls under the strip, so the honest question is whether the toolbar
      // can cover page pixels at all: it must sit entirely above the scroll container.
      clearOfViewer: Math.round(viewer.top - rect.bottom),
      viewerTop: Math.round(viewer.top),
      toolbarBottom: Math.round(rect.bottom),
    };
  });

  // 1. upright after the tab dance
  const beforeSwitch = await thumbStats();
  await openTab('İçindekiler');
  await openTab('Ek');
  await openTab('Sayfalar');
  await page.waitForTimeout(2000);
  const afterSwitch = await thumbStats();

  // 2. a long document must not leave black thumbnails behind
  await page.setInputFiles('input[type="file"]', LARGE);
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 120_000 });
  await page.waitForTimeout(4000);
  await openTab('İçindekiler');
  await openTab('Sayfalar');
  await page.waitForTimeout(3000);
  const large = await thumbStats();

  const blank = (rows) => rows.filter((row) => row.top + row.bottom === 0).map((row) => row.page);
  const flipped = (rows) =>
    rows.filter((row) => row.top + row.bottom > 0 && row.bottom > row.top * 4).map((row) => row.page);
  console.log(
    JSON.stringify(
      {
        origin,
        toolbar,
        small: {
          before: beforeSwitch.length,
          after: afterSwitch.length,
          blankBefore: blank(beforeSwitch),
          blankAfter: blank(afterSwitch),
          flippedAfter: flipped(afterSwitch),
          sample: afterSwitch.slice(0, 3),
        },
        large: {
          visible: large.length,
          blank: blank(large),
          flipped: flipped(large),
          sample: large.slice(0, 3),
        },
        errors,
      },
      null,
      1,
    ),
  );
} finally {
  await browser.close();
}
