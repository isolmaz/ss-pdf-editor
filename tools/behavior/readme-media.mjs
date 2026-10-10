#!/usr/bin/env node
/**
 * Records the README's feature clips (`docs/media/*.webp`, animated WebP) from the built app.
 *
 * Each scene drives the assembled `dist/` (served by `tools/preview-dist.mjs`) in Chromium
 * with a visible cursor drawn into the page — headless video has none — records it, and
 * turns the recording into an animated WebP with ffmpeg (`libwebp_anim`).
 *
 * Usage: pnpm build && pnpm assemble:dist && node tools/preview-dist.mjs &
 *        node tools/behavior/readme-media.mjs [scene …]
 * Needs `ffmpeg` and `openssl` on PATH (openssl makes the signing identity).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readmeDemoPdf, readmeScannedPdf } from './readme-demo-pdf.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'docs/media');
const BASE = process.env.APP_URL ?? 'http://localhost:4178';
const VIEW = { width: 1280, height: 760 };
const work = mkdtempSync(join(tmpdir(), 'readme-media-'));
const demo = join(work, 'service-agreement.pdf');
const revised = join(work, 'service-agreement-v2.pdf');
const scanned = join(work, 'scanned-agreement.pdf');
writeFileSync(demo, readmeDemoPdf());
writeFileSync(revised, readmeDemoPdf({ revised: true }));
writeFileSync(scanned, readmeScannedPdf());

/** A cursor the recording can see, moved by the page's own mouse events. */
const CURSOR = () => {
  const install = () => {
    const dot = document.createElement('div');
    dot.id = '__cursor';
    Object.assign(dot.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '18px',
      height: '18px',
      marginLeft: '-9px',
      marginTop: '-9px',
      borderRadius: '50%',
      background: 'rgba(31, 77, 143, 0.35)',
      border: '2px solid rgba(31, 77, 143, 0.9)',
      pointerEvents: 'none',
      zIndex: '2147483647',
      transition: 'transform 80ms ease',
    });
    document.documentElement.appendChild(dot);
    const move = (event) => {
      dot.style.left = `${event.clientX}px`;
      dot.style.top = `${event.clientY}px`;
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mousedown', () => (dot.style.transform = 'scale(0.7)'), true);
    window.addEventListener('mouseup', () => (dot.style.transform = 'scale(1)'), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
};

const pause = (page, ms) => page.waitForTimeout(ms);

async function glide(page, x, y) {
  await page.mouse.move(x, y, { steps: 18 });
}

async function center(locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no box for ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function press(page, locator, wait = 450) {
  const { x, y } = await center(locator);
  await glide(page, x, y);
  await pause(page, 150);
  await page.mouse.click(x, y);
  await pause(page, wait);
}

/** Screen point of a PDF point (`x`, `yUp` from the bottom) on page `index` (595 × 842). */
async function onPage(page, index, x, yUp) {
  const sheet = await page.locator('.pdfViewer[data-active-viewer] .page').nth(index).boundingBox();
  if (sheet === null) throw new Error('no page box');
  const scale = sheet.width / 595.28;
  return { x: sheet.x + x * scale, y: sheet.y + (841.89 - yUp) * scale };
}

async function drag(page, from, to, steps = 22) {
  await glide(page, from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await pause(page, 500);
}

async function openDemo(page, file = demo) {
  await page.goto(`${BASE}/editor/`);
  await page.locator('input[type="file"][accept*="application/pdf"]').first().setInputFiles(file);
  await page.locator('.pdfViewer canvas').first().waitFor({ timeout: 30_000 });
  await page
    .getByText('Opening the document…')
    .waitFor({ state: 'detached', timeout: 30_000 })
    .catch(() => {});
  await pause(page, 800);
}

const notice = (page, text) => page.locator('[role="status"]').filter({ hasText: text });

/** The settings dialog, opened from the header's gear as a user does. */
async function settings(page, visible = true) {
  const gear = page.getByRole('button', { name: /^(Settings|Ayarlar)$/ }).first();
  if (visible) await press(page, gear, 600);
  else await gear.click();
  return page.getByRole('dialog', { name: /Settings|Ayarlar/ });
}

/** Switch to the advanced interface mode before a scene that needs its commands. */
async function useAdvanced(page) {
  const dialog = await settings(page, false);
  await dialog.getByRole('radio', { name: 'Advanced mode' }).check();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await pause(page, 300);
}

/** Run a command through the `Ctrl+K` palette, typing it where the viewer can see. */
async function palette(page, query) {
  await page.keyboard.press('Control+k');
  await pause(page, 300);
  await page.keyboard.type(query, { delay: 90 });
  await pause(page, 700);
  await page.keyboard.press('Enter');
  await pause(page, 700);
}

/**
 * Each scene gets `mark()` (the clip starts here) and `cut()`, which returns a function
 * that ends a stretch to drop from the clip — an engine working while nothing on screen
 * changes.
 */
const SCENES = {
  async 'open-and-navigate'(page, mark) {
    await page.goto(`${BASE}/editor/`);
    await page.getByRole('button', { name: 'Open', exact: true }).waitFor();
    await pause(page, 700);
    mark();
    await pause(page, 900);
    await glide(page, 1236, 24);
    await pause(page, 300);
    await page.locator('input[type="file"][accept*="application/pdf"]').first().setInputFiles(demo);
    await page.locator('.pdfViewer canvas').first().waitFor({ timeout: 30_000 });
    await pause(page, 1200);
    await press(page, page.getByRole('button', { name: 'Next Page' }), 900);
    await press(page, page.getByRole('button', { name: 'Next Page' }), 900);
    await press(page, page.getByRole('option').first(), 900);
    await press(page, page.getByRole('button', { name: 'Zoom In (+)' }), 600);
    await press(page, page.getByRole('button', { name: 'Zoom In (+)' }), 900);
    await press(page, page.getByRole('button', { name: /^Fit Width/ }), 1200);
  },

  async annotate(page, mark) {
    await openDemo(page);
    mark();
    await press(
      page,
      page.getByRole('button', { name: 'Mark Up Text (highlight, underline, strike)', exact: true }),
    );
    await drag(page, await onPage(page, 0, 56, 640), await onPage(page, 0, 470, 640));
    await press(page, page.getByRole('button', { name: 'Draw Shape (Rectangle)', exact: true }));
    await drag(page, await onPage(page, 0, 48, 556), await onPage(page, 0, 150, 528));
    await press(page, page.getByRole('button', { name: 'Freehand drawing', exact: true }));
    const a = await onPage(page, 0, 60, 486);
    await glide(page, a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 24; i += 1) {
      const p = await onPage(page, 0, 60 + i * 14, 486 + (i % 2 === 0 ? 4 : -4));
      await page.mouse.move(p.x, p.y, { steps: 2 });
    }
    await page.mouse.up();
    await pause(page, 500);
    await press(page, page.getByRole('button', { name: 'Add Text', exact: true }));
    const spot = await onPage(page, 0, 380, 700);
    await glide(page, spot.x, spot.y);
    await page.mouse.click(spot.x, spot.y);
    await pause(page, 300);
    await page.keyboard.type('Approved by legal', { delay: 60 });
    await page.keyboard.press('Control+Enter');
    await press(page, page.getByRole('button', { name: 'Selection Tool', exact: true }), 1400);
  },

  async pages(page, mark) {
    await openDemo(page);
    mark();
    const second = page.getByRole('option').nth(1);
    await glide(page, ...Object.values(await center(second)));
    await pause(page, 500);
    await press(page, second.getByRole('button', { name: 'Rotate right' }), 1100);
    const third = await center(page.getByRole('option').nth(2));
    const firstBox = await page.getByRole('option').first().boundingBox();
    await press(page, page.getByRole('option').nth(2), 300);
    await drag(page, third, { x: firstBox.x + firstBox.width / 2, y: firstBox.y + 6 }, 30);
    await pause(page, 1400);
    await press(page, page.getByRole('button', { name: 'Undo', exact: true }), 1200);
  },

  async 'fill-and-sign'(page, mark) {
    await openDemo(page);
    mark();
    await press(page, page.getByRole('option').nth(2), 1000);
    const field = await onPage(page, 2, 186, 654);
    await glide(page, field.x, field.y);
    await page.mouse.click(field.x, field.y);
    await page.keyboard.type('Acme Corporation', { delay: 70 });
    await page.keyboard.press('Tab');
    await pause(page, 600);
    const identity = join(work, 'signer');
    mkdirSync(identity, { recursive: true });
    const ssl = (args) => execFileSync('openssl', args, { cwd: identity, stdio: 'pipe' });
    ssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'key.pem']);
    ssl([
      'req',
      '-new',
      '-x509',
      '-key',
      'key.pem',
      '-days',
      '30',
      '-subj',
      '/CN=Northwind Studio',
      '-addext',
      'keyUsage=digitalSignature',
      '-out',
      'cert.pem',
    ]);
    ssl([
      'pkcs12',
      '-export',
      '-inkey',
      'key.pem',
      '-in',
      'cert.pem',
      '-name',
      'demo',
      '-passout',
      'pass:demo',
      '-out',
      'signer.p12',
    ]);
    await press(page, page.getByRole('menuitem', { name: 'Tools', exact: true }), 500);
    await press(page, page.getByRole('menuitem', { name: 'Sign document' }), 700);
    const form = page.getByRole('region', { name: /Sign Document/ });
    await form.locator('input[type="file"]').setInputFiles(join(identity, 'signer.p12'));
    const password = form.getByRole('textbox', { name: 'PKCS#12 password' });
    await press(page, password, 200);
    await page.keyboard.type('demo', { delay: 80 });
    await press(page, form.getByRole('button', { name: 'Sign', exact: true }), 300);
    await form.getByRole('heading', { name: 'Operation report' }).waitFor({ timeout: 60_000 });
    await pause(page, 900);
    await press(page, form.getByRole('button', { name: 'Apply to document', exact: true }), 300);
    await notice(page, 'Signature applied').waitFor({ timeout: 60_000 });
    await pause(page, 800);
    // The visible stamp sits at the bottom right of the page: bring it into view.
    const stamp = await onPage(page, 2, 300, 300);
    await glide(page, stamp.x, Math.min(stamp.y, 600));
    await page.mouse.wheel(0, 520);
    await pause(page, 2400);
  },

  async redact(page, mark) {
    await openDemo(page);
    mark();
    await press(page, page.getByRole('option').nth(1), 900);
    await press(page, page.getByRole('button', { name: 'Redact (permanent removal)' }));
    await drag(page, await onPage(page, 1, 52, 690), await onPage(page, 1, 520, 670));
    await press(page, page.getByRole('tab', { name: 'Redaction', exact: true }), 500);
    await press(page, page.getByRole('button', { name: 'Redaction (Permanent Erase)', exact: true }), 600);
    const form = page.getByRole('region', { name: 'Redaction (Permanent Erase)' });
    await press(page, form.getByRole('button', { name: 'Preview', exact: true }), 900);
    await press(page, form.getByRole('button', { name: 'Continue', exact: true }), 300);
    await form.getByRole('heading', { name: 'Operation report' }).waitFor({ timeout: 60_000 });
    await pause(page, 900);
    await press(page, form.getByRole('button', { name: 'Apply to document', exact: true }), 300);
    await notice(page, 'no text remains in the marked areas').waitFor({ timeout: 60_000 });
    await pause(page, 2200);
  },

  async search(page, mark) {
    await openDemo(page);
    mark();
    await pause(page, 500);
    await page.keyboard.press('Control+f');
    await pause(page, 400);
    await page.keyboard.type('Northwind', { delay: 110 });
    await page.keyboard.press('Enter');
    await pause(page, 900);
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Enter');
      await pause(page, 700);
    }
    await pause(page, 800);
  },

  async 'edit-text'(page, mark, cut) {
    await openDemo(page);
    mark();
    await palette(page, 'Edit text');
    const block = page.locator('[data-text-block][data-block-text*="Northwind Studio will design"]').first();
    await block.waitFor({ timeout: 60_000 });
    await pause(page, 900);
    await press(page, block, 900);
    const form = page.getByRole('region', { name: 'Edit text' });
    await press(page, form.locator('textarea').first(), 200);
    await page.keyboard.press('Control+a');
    await page.keyboard.type(
      'Northwind Studio will design, build and launch the new client website, including a content audit and a two-week launch period.',
      { delay: 22 },
    );
    await pause(page, 500);
    await press(page, form.getByRole('button', { name: 'Preview', exact: true }), 300);
    const resume = cut();
    await form.getByRole('heading', { name: 'Operation report' }).waitFor({ timeout: 180_000 });
    resume();
    await pause(page, 1100);
    await press(page, form.getByRole('button', { name: 'Apply to document', exact: true }), 300);
    await form.waitFor({ state: 'hidden', timeout: 60_000 });
    await press(page, page.getByRole('button', { name: 'Selection Tool', exact: true }), 2200);
  },

  async watermark(page, mark) {
    await openDemo(page);
    await useAdvanced(page);
    mark();
    await palette(page, 'Watermark');
    const form = page.getByRole('region', { name: 'Watermark' });
    await press(page, form.getByRole('textbox', { name: 'Text', exact: true }), 200);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('CONFIDENTIAL', { delay: 90 });
    await pause(page, 400);
    await press(page, form.getByRole('button', { name: 'Preview', exact: true }), 300);
    await form.getByRole('heading', { name: 'Operation report' }).waitFor({ timeout: 60_000 });
    await pause(page, 1100);
    await press(page, form.getByRole('button', { name: 'Apply to document', exact: true }), 300);
    await form.waitFor({ state: 'hidden', timeout: 60_000 });
    await pause(page, 2200);
  },

  async measure(page, mark) {
    await openDemo(page);
    await useAdvanced(page);
    mark();
    await palette(page, 'Distance');
    const from = await onPage(page, 0, 56, 600);
    const to = await onPage(page, 0, 300, 600);
    await glide(page, from.x, from.y);
    await page.mouse.click(from.x, from.y);
    await pause(page, 300);
    await page.mouse.move(to.x, to.y, { steps: 30 });
    await page.mouse.click(to.x, to.y);
    await page.keyboard.press('Enter');
    await pause(page, 900);
    await palette(page, 'Area');
    for (const [x, y] of [
      [320, 600],
      [520, 600],
      [520, 480],
      [320, 480],
    ]) {
      const point = await onPage(page, 0, x, y);
      await page.mouse.move(point.x, point.y, { steps: 18 });
      await page.mouse.click(point.x, point.y);
      await pause(page, 250);
    }
    await page.keyboard.press('Enter');
    await pause(page, 2000);
  },

  async ocr(page, mark, cut) {
    await openDemo(page, scanned);
    await useAdvanced(page);
    mark();
    await pause(page, 600);
    await palette(page, 'OCR');
    const form = page.getByRole('region', { name: 'Text recognition' });
    await form.waitFor();
    await pause(page, 600);
    await press(page, form.getByRole('button', { name: 'Preview', exact: true }), 300);
    const resume = cut();
    await form.getByRole('heading', { name: 'Operation report' }).waitFor({ timeout: 240_000 });
    resume();
    await pause(page, 1300);
    await press(page, form.getByRole('button', { name: 'Apply to document', exact: true }), 300);
    const done = cut();
    await form.waitFor({ state: 'hidden', timeout: 60_000 });
    await pause(page, 1500);
    done();
    await page.keyboard.press('Control+f');
    await pause(page, 300);
    await page.keyboard.type('website', { delay: 120 });
    await page.keyboard.press('Enter');
    await pause(page, 2200);
  },

  async protect(page, mark) {
    await openDemo(page);
    await useAdvanced(page);
    mark();
    await palette(page, 'Security');
    const form = page.getByRole('region', { name: 'Security' });
    await press(page, form.getByLabel('Open password'), 200);
    await page.keyboard.type('northwind', { delay: 90 });
    await press(page, form.getByLabel('Owner password'), 200);
    await page.keyboard.type('owner-2026', { delay: 70 });
    await press(page, form.getByRole('checkbox', { name: 'Copying' }), 500);
    await press(page, form.getByRole('button', { name: 'Preview', exact: true }), 300);
    await form.getByRole('heading', { name: 'Operation report' }).waitFor({ timeout: 60_000 });
    await pause(page, 1500);
    await press(page, form.getByRole('button', { name: 'Download', exact: true }), 1800);
  },

  async compare(page, mark) {
    await openDemo(page);
    await useAdvanced(page);
    mark();
    await palette(page, 'Document comparison');
    await page.locator('input[data-compare-picker]').setInputFiles(revised);
    await page.getByText('Selected: service-agreement-v2.pdf').waitFor();
    await pause(page, 700);
    await press(page, page.getByRole('button', { name: 'Compare text' }), 300);
    await page.getByRole('table', { name: 'Page-by-page comparison results' }).waitFor({ timeout: 60_000 });
    await pause(page, 2600);
  },

  async 'reading-mode'(page, mark) {
    await openDemo(page);
    mark();
    await pause(page, 500);
    await page.keyboard.press('Control+h');
    await pause(page, 1500);
    await page.keyboard.press('ArrowRight');
    await pause(page, 1300);
    await page.keyboard.press('ArrowRight');
    await pause(page, 1300);
    await page.keyboard.press('Escape');
    await pause(page, 900);
  },

  async 'theme-and-language'(page, mark) {
    await openDemo(page);
    mark();
    const dialog = await settings(page);
    await press(page, dialog.getByRole('button', { name: 'Dark Theme', exact: true }), 900);
    await press(page, dialog.getByRole('button', { name: 'Türkçe', exact: true }), 900);
    await press(page, dialog.getByRole('button', { name: 'Kapat', exact: true }), 1800);
  },

  async 'palette-and-export'(page, mark) {
    await openDemo(page);
    mark();
    await press(page, page.getByRole('button', { name: 'Command palette' }), 500);
    await page.keyboard.type('water', { delay: 110 });
    await pause(page, 1300);
    await page.keyboard.press('Escape');
    await pause(page, 400);
    await press(page, page.getByRole('button', { name: 'Export Options', exact: true }), 1800);
    await page.keyboard.press('Escape');
    await pause(page, 600);
  },
};

/** An ffmpeg filter prefix that drops the cut stretches; times are relative to the trimmed clip. */
function drop(cuts, start) {
  const offset = Math.max(0, start - 0.2);
  const spans = cuts
    .map(([from, to]) => [from - offset, to - offset])
    .filter(([from, to]) => to > from)
    .map(([from, to]) => `between(t,${from.toFixed(2)},${to.toFixed(2)})`);
  if (spans.length === 0) return '';
  return `select='not(${spans.join('+')})',setpts=N/FRAME_RATE/TB,`;
}

async function record(name) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: VIEW,
    recordVideo: { dir: join(work, name), size: VIEW },
  });
  await context.addInitScript(CURSOR);
  const t0 = Date.now();
  let start = 0;
  const cuts = [];
  const now = () => (Date.now() - t0) / 1000;
  const page = await context.newPage();
  try {
    await SCENES[name](
      page,
      () => {
        start = now();
      },
      () => {
        const from = now() + 0.3;
        return () => cuts.push([from, now() - 0.3]);
      },
    );
  } finally {
    await context.close();
    await browser.close();
  }
  const video = await page.video().path();
  mkdirSync(OUT, { recursive: true });
  const clip = join(OUT, `${name}.webp`);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    String(Math.max(0, start - 0.2)),
    '-i',
    video,
    '-vf',
    `${drop(cuts, start)}fps=10,scale=960:-1:flags=lanczos`,
    '-c:v',
    'libwebp_anim',
    '-lossless',
    '0',
    '-q:v',
    '75',
    '-compression_level',
    '6',
    '-loop',
    '0',
    clip,
  ]);
  console.log(`${name}: ${clip}`);
}

const chosen = process.argv.slice(2);
for (const name of chosen.length > 0 ? chosen : Object.keys(SCENES)) await record(name);
rmSync(work, { recursive: true, force: true });
