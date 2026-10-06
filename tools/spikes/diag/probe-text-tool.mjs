#!/usr/bin/env node
/**
 * Throwaway probe: why does the text tool paint no blocks?
 *
 *   node tools/spikes/diag/probe-text-tool.mjs [--port 4200]
 *
 * Opens the phase-4 fixture through the app's own file input, arms the text tool
 * through the real menu, then dumps the facts a driver cannot see: the notice text,
 * whether the layer element exists at all, every block overlay's attributes, and the
 * console/page errors with their stacks.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const port = Number.parseInt(readArg('--port', '4200'), 10);
const origin = `http://localhost:${port}`;

const dir = join(tmpdir(), `pdf-editor-texttool-${process.pid}`);
mkdirSync(dir, { recursive: true });
const fixture = join(dir, 'fixture.pdf');
const built = spawn(
  process.execPath,
  [join(ROOT, 'tools/spikes/make-phase4-fixture.mjs'), '--out', fixture],
  {
    cwd: ROOT,
    stdio: 'inherit',
  },
);
await new Promise((resolve) => built.on('exit', resolve));

const server = spawn(
  process.execPath,
  [join(ROOT, 'tools/preview-dist.mjs'), '--root', 'dist', '--port', String(port)],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
server.stdout.resume();
server.stderr.resume();
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch(`${origin}/editor/`);
    if (response.ok) break;
  } catch {
    // not up yet
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const executablePath = process.env.CHROMIUM_PATH ?? chromium.executablePath();
const browser = await chromium.launch(
  existsSync(executablePath) ? { executablePath, headless: true } : { headless: true },
);
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const events = [];
page.on('console', (message) => events.push(`console.${message.type()}: ${message.text().slice(0, 300)}`));
page.on('pageerror', (error) => events.push(`pageerror: ${error.message.slice(0, 300)}`));
page.on('requestfailed', (request) => events.push(`requestfailed: ${request.url().slice(0, 160)}`));

try {
  await page.goto(`${origin}/editor/`, { waitUntil: 'load' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
  await page.setInputFiles('input[type="file"]', fixture);
  await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
  await page.waitForTimeout(1500);

  // Open the Tools menu and list everything in it, so a label mismatch is visible.
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Araçlar', exact: true }).first().click();
  const menu = page.getByRole('menu');
  await menu.waitFor({ state: 'visible', timeout: 10_000 });
  const entries = await menu.getByRole('menuitem').allInnerTexts();
  const boxes = await menu.getByRole('menuitemcheckbox').allInnerTexts();
  console.log('TOOLS MENU items:', JSON.stringify(entries));
  console.log('TOOLS MENU checks:', JSON.stringify(boxes));

  const target = menu.getByRole('menuitemcheckbox', { name: /Metni düzenle/i }).first();
  const count = await target.count();
  console.log('menuitemcheckbox /Metni düzenle/ count:', count);
  if (count > 0) {
    console.log('disabled?', await target.isDisabled());
    await target.click();
  } else {
    const item = menu.getByRole('menuitem', { name: /Metni düzenle/i }).first();
    console.log('plain menuitem count:', await item.count());
    if ((await item.count()) > 0) {
      console.log('disabled?', await item.isDisabled());
      await item.click();
    }
  }
  await page.waitForTimeout(6000);

  const state = await page.evaluate(() => ({
    layer: document.querySelectorAll('[data-text-layer]').length,
    blocks: [...document.querySelectorAll('[data-text-block]')].map((node) => ({
      id: node.getAttribute('data-text-block'),
      editability: node.getAttribute('data-editability'),
      rect: node.getAttribute('data-block-rect'),
      text: (node.getAttribute('aria-label') ?? '').slice(0, 40),
    })),
    layerError:
      document.querySelector('[data-text-layer-error]')?.getAttribute('data-text-layer-error') ?? null,
    reason: document.querySelector('[data-text-layer-error]')?.getAttribute('data-text-layer-reason') ?? null,
    bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
  }));
  console.log('LAYER/BLOCKS:', JSON.stringify(state, null, 2));
  // Where the overlays actually sit, in client coordinates, next to the text layer's
  // own spans — the pair that says whether the model's rects point at the glyphs.
  const geometry = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('[data-text-block]')].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        id: node.getAttribute('data-text-block'),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    });
    const spans = [...document.querySelectorAll('.textLayer span')]
      .map((node) => ({ text: (node.textContent ?? '').slice(0, 24), rect: node.getBoundingClientRect() }))
      .filter((entry) => entry.text.includes('KADIKÖY') || entry.text.startsWith('Belge'))
      .map((entry) => ({
        text: entry.text,
        x: Math.round(entry.rect.x),
        y: Math.round(entry.rect.y),
        w: Math.round(entry.rect.width),
      }));
    return { blocks, spans };
  });
  console.log('GEOMETRY:', JSON.stringify(geometry, null, 1));
  await page.screenshot({ path: 'tools/spikes/diag/text-tool-layer.png', fullPage: false });
  console.log('EVENTS:');
  for (const event of events.slice(0, 25)) console.log('  ', event);
} finally {
  await browser.close();
  server.kill();
  server.stdout.destroy();
  server.stderr.destroy();
}
