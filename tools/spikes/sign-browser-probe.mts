/**
 * Throwaway (`K21`): the signing chain, in a browser, under the production CSP.
 *
 *   npx tsx tools/spikes/sign-browser-probe.mts
 *
 * The Node check (`tools/spikes/sign-check.mts`) proves the CMS is correct; this proves
 * the **app** can produce it: open a document, run the sign dialog with a PKCS#12 file,
 * let the result land in the session, export the document and read the exported bytes
 * back with the product's own verifier. One question — does the browser path end in a
 * signed file that verifies — and nothing else.
 *
 * Requires the assembled `dist/` served under the production headers:
 *   node tools/preview-dist.mjs --port 4198
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { chromium } from 'playwright';
import { createFixture, readFixture } from './mupdf-fixture.mjs';
import { installMupdfHook } from './node-mupdf-hook.mjs';

// The product verifier below loads MuPDF by its served URL; in Node that resolves to the
// installed package (`node-mupdf-hook.mjs`).
installMupdfHook();

const dir = join(process.env.TEMP ?? '.', 'p4sign');
mkdirSync(dir, { recursive: true });

const pdf = createFixture(mupdf);
const sheet = pdf.addPage(595.28, 841.89);
sheet.text('Imza denemesi', { x: 56, y: 780, size: 16, color: [0.1, 0.1, 0.1] });
sheet.text('Bu belge tarayicida imzalanacak.', {
  x: 56,
  y: 750,
  size: 12,
  color: [0.2, 0.2, 0.2],
});
const fixture = join(dir, 'unsigned.pdf');
writeFileSync(fixture, pdf.save());

// The smoke identity stays in temporary storage, never in the repository.
const container = join(dir, 'identity.p12');
for (const args of [
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'key.pem',
    '-out',
    'cert.pem',
    '-days',
    '2',
    '-subj',
    '/CN=PDF Editor Browser Test',
  ],
  [
    'pkcs12',
    '-export',
    '-out',
    'identity.p12',
    '-inkey',
    'key.pem',
    '-in',
    'cert.pem',
    '-passout',
    'pass:testpass',
  ],
]) {
  const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
}

const exe = chromium.executablePath();
const browser = await chromium.launch(
  existsSync(exe) ? { executablePath: exe, headless: true } : { headless: true },
);
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 200)}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 200)}`);
});

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

try {
  await page.goto(`${process.env.VERIFY_ORIGIN ?? 'http://localhost:4198'}/editor/`, { waitUntil: 'load' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
  await page.setInputFiles('input[type="file"]', fixture);
  await page.waitForSelector('.pdfViewer .page', { timeout: 60_000 });
  await page.waitForTimeout(600);

  // The command palette is the shortest honest route to the dialog: it is the app's own
  // registry, so a missing command fails here rather than being masked by a menu click.
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(400);
  await page.keyboard.type('imzala');
  await page.waitForTimeout(400);
  const palette = page.getByRole('dialog');
  const hits = await palette.getByText(/Belgeyi imzala|PAdES/).all();
  record(
    'palette: the sign command is registered',
    hits.length > 0,
    `${hits.length} palette entry/entries matched`,
  );
  await hits[0].click();
  await page.waitForTimeout(1200);

  // Every operation opens in the tools panel, as a region named by its title; its body
  // carries the PKCS#12 field, which is what identifies it.
  const dialog = page
    .getByRole('region', { name: 'Belgeyi imzala (PAdES B-B)' })
    .filter({ hasText: /PKCS#12/ })
    .first();
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  record('dialog: the sign dialog opens from the palette', true, 'the PKCS#12 field is on screen');

  // The two-step file picker: the container input is the one that accepts .p12.
  await dialog.locator('input[type="file"]').first().setInputFiles(container);
  await dialog.locator('input[type="password"], input[placeholder*="arola"]').first().fill('testpass');
  await page.waitForTimeout(200);
  const runButton = dialog.getByRole('button', { name: 'İmzala' }).first();
  await runButton.click();

  // The dialog reports before it applies: the report is the op's own notes. The report
  // replaces the form, so the PKCS#12 text that identified the region is gone — from
  // here on the region is found by its title alone.
  const report = page.getByRole('region', { name: 'Belgeyi imzala (PAdES B-B)' }).first();
  await report.getByText('PAdES B-B imzası yazıldı', { exact: false }).waitFor({ timeout: 60_000 });
  record('run: the dialog reports the PAdES B-B signature', true, 'report panel shows the byte range note');

  // Apply the result to the session, then export the document to disk.
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await report
    .getByRole('button', { name: /uygula|Tümünü|Belgeye/i })
    .first()
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(1200);

  // Export through the app's own File menu, which writes the *current version*.
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Dosya', exact: true }).first().click();
  const fileMenu = page.getByRole('menu');
  await fileMenu.waitFor({ state: 'visible' });
  await fileMenu.getByText('Dışa aktar', { exact: false }).first().click();
  const saved = await download;
  const exported = join(dir, 'signed-by-browser.pdf');
  await saved.saveAs(exported);

  const bytes = new Uint8Array(readFileSync(exported));

  /**
   * Read the file the way a reader reads it — the object graph, not the raw text. pdf.js
   * writes its objects into object streams, so a `/ByteRange` search over the bytes finds
   * nothing on a perfectly good signature; the first version of this probe did exactly
   * that and called the file broken.
   */
  const { doc: parsed } = readFixture(mupdf, bytes);
  const annots = parsed.findPage(0).get('Annots');
  const count = annots.isArray() ? annots.length : 0;
  const first = count > 0 ? annots.get(0) : null;
  const signature = first?.get('V');
  const value = signature?.isDictionary() === true ? signature : null;
  const range = value?.get('ByteRange');
  const subFilterObject = value?.get('SubFilter');
  const subFilter = subFilterObject?.isName() === true ? subFilterObject.asName() : null;
  record(
    'export: the exported file carries a signature dictionary with a byte range',
    value !== null && range?.isArray() === true && (subFilter ?? '').includes('CAdES.detached'),
    `annotations on page 1: ${count}, subfilter ${String(subFilter)}`,
  );
  const rangeNumbers: number[] = [];
  for (let index = 0; range?.isArray() === true && index < range.length; index += 1) {
    rangeNumbers.push(range.get(index).asNumber());
  }
  record(
    'file: the byte range covers the file except the signature itself',
    rangeNumbers.length === 4 &&
      // The rule (§12.8.1): the first range starts at byte 0, the second ends at EOF, and
      // the gap between them is exactly the `/Contents` value — the signature's own bytes.
      // (The first version of this check added the four numbers up, which is not the rule.)
      rangeNumbers[0] === 0 &&
      (rangeNumbers[2] ?? 0) + (rangeNumbers[3] ?? 0) === bytes.length,
    `range ${JSON.stringify(rangeNumbers)} over ${bytes.length} B, gap ${(rangeNumbers[2] ?? 0) - (rangeNumbers[0] ?? 0) - (rangeNumbers[1] ?? 0)} B`,
  );

  // The product's own verifier, on the bytes the browser produced.
  const { verifySignatures } = await import('../../packages/pdf-core/src/ops/signature-status.ts');
  const verdicts = await verifySignatures(bytes, undefined, { now: new Date('2026-09-16T12:00:00Z') });
  const verdict = verdicts[0];
  record(
    'verify: the product verifier reads the browser-signed file as valid',
    verdict?.integrity === 'valid',
    verdict === undefined
      ? 'no signature found'
      : `integrity ${verdict.integrity}, signer ${String(verdict.signer)}, ${String(verdict.coverage)}`,
  );

  record('page errors: none', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');
} finally {
  await browser.close();
}

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(`  ${checks.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
