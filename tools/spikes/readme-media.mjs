#!/usr/bin/env node
/**
 * Records the README's feature GIFs (`docs/media/*.gif`) from the built app.
 *
 * Each scene drives the assembled `dist/` (served by `tools/preview-dist.mjs`) in Chromium
 * with a visible cursor drawn into the page — headless video has none — records it, and
 * turns the recording into a palette-optimised GIF with ffmpeg.
 *
 * Usage: pnpm build && pnpm assemble:dist && node tools/preview-dist.mjs &
 *        node tools/spikes/readme-media.mjs [scene …]
 * Needs `ffmpeg` and `openssl` on PATH (openssl makes the signing identity).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readmeDemoPdf } from './readme-demo-pdf.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'docs/media');
const BASE = process.env.APP_URL ?? 'http://localhost:4178';
const VIEW = { width: 1280, height: 760 };
const work = mkdtempSync(join(tmpdir(), 'readme-media-'));
const demo = join(work, 'service-agreement.pdf');
writeFileSync(demo, readmeDemoPdf());

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

async function openDemo(page) {
  await page.goto(`${BASE}/editor/`);
  await page.locator('input[type="file"][accept*="application/pdf"]').first().setInputFiles(demo);
  await page.locator('.pdfViewer canvas').first().waitFor({ timeout: 30_000 });
  await page
    .getByText('Opening the document…')
    .waitFor({ state: 'detached', timeout: 30_000 })
    .catch(() => {});
  await pause(page, 800);
}

const notice = (page, text) => page.locator('[role="status"]').filter({ hasText: text });

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
    await notice(page, 'targeted content no longer exists').waitFor({ timeout: 60_000 });
    await pause(page, 2200);
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
  const page = await context.newPage();
  try {
    await SCENES[name](page, () => {
      start = (Date.now() - t0) / 1000;
    });
  } finally {
    await context.close();
    await browser.close();
  }
  const video = await page.video().path();
  mkdirSync(OUT, { recursive: true });
  const gif = join(OUT, `${name}.gif`);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    String(Math.max(0, start - 0.2)),
    '-i',
    video,
    '-vf',
    'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    gif,
  ]);
  console.log(`${name}: ${gif}`);
}

const chosen = process.argv.slice(2);
for (const name of chosen.length > 0 ? chosen : Object.keys(SCENES)) await record(name);
rmSync(work, { recursive: true, force: true });
