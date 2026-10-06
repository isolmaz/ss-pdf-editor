#!/usr/bin/env node
/**
 * Throwaway probe: what happens when the text edit is applied?
 *
 *   node tools/spikes/diag/probe-text-edit.mjs [--port 4201] [--wait 60]
 *
 * Arms the text tool, selects the sentinel paragraph, rewrites it and presses the
 * dialog's confirm button, then dumps — every second — the dialog's own text, the
 * progress line, the notice banner and any console/page error. The harness only sees
 * "it timed out"; this shows which stage never came back.
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
const port = Number.parseInt(readArg('--port', '4201'), 10);
const waitSeconds = Number.parseInt(readArg('--wait', '60'), 10);
const origin = `http://localhost:${port}`;

const dir = join(tmpdir(), `pdf-editor-textedit-${process.pid}`);
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
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
const events = [];
page.on('console', (message) => {
  if (message.type() === 'error' && !/FT_Load_Glyph|invalid composite glyph/.test(message.text())) {
    events.push(`console.error: ${message.text().slice(0, 240)}`);
  }
});
page.on('pageerror', (error) => events.push(`pageerror: ${error.message.slice(0, 240)}`));
page.on('requestfailed', (request) => events.push(`requestfailed: ${request.url().slice(0, 200)}`));
page.on('response', (response) => {
  if (response.status() >= 400) events.push(`http ${response.status()}: ${response.url().slice(0, 200)}`);
});

try {
  await page.goto(`${origin}/editor/`, { waitUntil: 'load' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
  await page.setInputFiles('input[type="file"]', fixture);
  await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
  await page.waitForTimeout(1200);

  await page.getByRole('menubar').getByRole('menuitem', { name: 'Araçlar', exact: true }).first().click();
  await page.getByRole('menu').waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .getByRole('menu')
    .getByRole('menuitemcheckbox', { name: /Metni düzenle/ })
    .first()
    .click();
  await page.waitForSelector('[data-text-block]', { timeout: 60_000 });

  await page.evaluate(() => {
    const node = [...document.querySelectorAll('[data-text-block]')].find((candidate) =>
      (candidate.getAttribute('aria-label') ?? '').includes('KADIKÖY'),
    );
    node?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  });
  await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 30_000 });
  const area = page.locator('[role="dialog"] textarea').first();
  await area.fill(process.env.TEXT ?? 'ÜSKÜDAR şubesi bu kuralı istisnasız uygular ve arşivini yerel tutar.');
  console.log('filled; pressing the confirm button');

  const confirm = page
    .getByRole('dialog')
    .getByRole('button', { name: /^Uygula$/ })
    .first();
  console.log('confirm buttons present:', await page.getByRole('dialog').getByRole('button').allInnerTexts());
  await confirm.click();
  console.log('clicked at', new Date().toISOString());

  for (let second = 1; second <= waitSeconds; second += 1) {
    await page.waitForTimeout(1000);
    if (second === 12 || second === 6) {
      const full = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const buttons = [...(dialog?.querySelectorAll('button') ?? [])].map((button) => ({
          text: (button.textContent ?? '').trim().slice(0, 30),
          disabled: button.disabled,
        }));
        const inputs = [...(dialog?.querySelectorAll('input, textarea, select') ?? [])].map((node) => ({
          id: node.id,
          value: (node.value ?? '').slice(0, 40),
          invalid: node.getAttribute('aria-invalid') ?? '',
        }));
        return {
          diagnostic:
            dialog?.querySelector('[data-dialog-diagnostic]')?.getAttribute('data-dialog-diagnostic') ?? null,
          text: (dialog?.innerText ?? '').replace(/\n+/g, ' | ').slice(0, 1200),
          buttons,
          inputs,
        };
      });
      console.log(`FULL at t+${second}s`, JSON.stringify(full.text));
      console.log('DIAG', JSON.stringify(full.diagnostic));
      if (second === 12) break;
    }
    if (second % 5 === 0 || second <= 5) {
      const state = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return {
          dialogText: (dialog?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 220),
          progress: (document.querySelector('[role="progressbar"], progress')?.textContent ?? '').slice(
            0,
            80,
          ),
          notice: [...document.querySelectorAll('p,div')]
            .map((node) => node.textContent ?? '')
            .filter((text) => /Belgeye uygula|başarısız|hata|kayded|uygulandı|Metin/i.test(text))
            .slice(0, 3)
            .map((text) => text.replace(/\s+/g, ' ').slice(0, 140)),
        };
      });
      console.log(`t+${second}s`, JSON.stringify(state));
      if (/Belgeye uygula/.test(state.dialogText) || /başarısız/i.test(state.dialogText)) break;
    }
  }
  // The produced file's page text, read the way a reader reads it: the decisive
  // question for an erase is what the bytes say, not what the report claims.
  if (process.env.DUMP_PDF === '1') {
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Dosya', exact: true }).first().click();
    const fileMenu = page.getByRole('menu');
    await fileMenu.waitFor({ state: 'visible', timeout: 10_000 });
    await fileMenu.getByText('Dışa aktar', { exact: false }).first().click();
    const file = await download;
    const saved = join(dir, 'exported.pdf');
    await file.saveAs(saved);
    console.log('EXPORTED', saved);
  }
  console.log('EVENTS:');
  for (const event of events.slice(0, 20)) console.log('  ', event);
} finally {
  await browser.close();
  server.kill();
  server.stdout.destroy();
  server.stderr.destroy();
}
