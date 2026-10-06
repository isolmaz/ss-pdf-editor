#!/usr/bin/env node
/**
 * Throwaway probe: which request 404s while the shell opens a dialog and exports?
 *
 *   node tools/spikes/diag/probe-chunks.mjs [--port 4202]
 *
 * Opens the phase-4 fixture, opens one operation dialog through the real menu, closes
 * it, exports the document and prints every non-2xx response and failed request with
 * its URL — the evidence a "Failed to load resource: 404" console line does not carry.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number.parseInt(process.argv[portArg + 1] ?? '4202', 10) : 4202;
const origin = `http://localhost:${port}`;
const dir = join(tmpdir(), `pdf-editor-chunks-${process.pid}`);
mkdirSync(dir, { recursive: true });
const fixture = join(dir, 'fixture.pdf');
await new Promise((resolve) =>
  spawn(process.execPath, [join(ROOT, 'tools/spikes/make-phase4-fixture.mjs'), '--out', fixture], {
    cwd: ROOT,
    stdio: 'inherit',
  }).on('exit', resolve),
);

const server = spawn(
  process.execPath,
  [join(ROOT, 'tools/preview-dist.mjs'), '--root', 'dist', '--port', String(port)],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
server.stdout.resume();
server.stderr.resume();
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    if ((await fetch(`${origin}/editor/`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const executablePath = process.env.CHROMIUM_PATH ?? chromium.executablePath();
const browser = await chromium.launch(
  existsSync(executablePath) ? { executablePath, headless: true } : { headless: true },
);
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();
const bad = [];
page.on('response', (response) => {
  if (response.status() >= 400) bad.push(`${response.status()} ${response.url()}`);
});
page.on('requestfailed', (request) => bad.push(`FAILED ${request.url()} — ${request.failure()?.errorText}`));

try {
  await page.goto(`${origin}/editor/`, { waitUntil: 'load' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
  await page.setInputFiles('input[type="file"]', fixture);
  await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
  await page.waitForTimeout(1500);

  // A dialog (its chunk is lazy), then the print dialog and the palette (both new
  // dynamic boundaries), then an export (the save path).
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Araçlar', exact: true }).first().click();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Belge özellikleri', exact: false })
    .first()
    .click();
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);

  await page.getByRole('menubar').getByRole('menuitem', { name: 'Dosya', exact: true }).first().click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Yazdır', exact: false }).first().click();
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  await page.keyboard.press('Control+k');
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Dosya', exact: true }).first().click();
  await page.getByRole('menu').getByText('Dışa aktar', { exact: false }).first().click();
  const file = await download;
  await file.saveAs(join(dir, 'exported.pdf'));
  console.log('EXPORTED', join(dir, 'exported.pdf'));
} finally {
  console.log('BAD RESPONSES:');
  for (const entry of [...new Set(bad)]) console.log('  ', entry);
  await browser.close();
  server.kill();
  server.stdout.destroy();
  server.stderr.destroy();
}
