import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright/test';
import { expect, test } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { readProducedPageTexts, readProducedPdf } from './tool-fixture';

/**
 * Real OCR, on both kinds of document it has to handle (`R09`, `R10`).
 *
 * **Boundary:** the fixtures are real PDFs kept out of the repository (they are large):
 * put them in `e2e/fixtures/local/`, which `.gitignore` covers. Two shapes matter, and the
 * operation branches on exactly that difference:
 *
 *  - **`scanned.pdf`** — at least 3 pages, **no text layer at all** (verified with pdf.js:
 *    `getTextContent()` returns nothing). Every page is a genuine recognition job, so this
 *    is where the engine itself is proven: Tesseract really renders and recognises.
 *  - **`text.pdf`** — at least 3 pages that **do** carry text. The default `skip` mode must refuse
 *    to re-OCR them and say so, which is the guard that keeps a working document from
 *    being silently overwritten with a worse text layer.
 *
 * A missing fixture **skips with a stated reason**, so a green run never quietly means
 * "OCR was not tested".
 */

const ROOT = process.cwd();
const SCANNED = resolve(ROOT, 'e2e/fixtures/local/scanned.pdf');
const TEXT = resolve(ROOT, 'e2e/fixtures/local/text.pdf');
const has = (path: string) => existsSync(path) && statSync(path).size > 0;

/** The fixture's page count, read from the file itself: any document of the right shape works. */
async function pagesOf(path: string): Promise<number> {
  return (await readProducedPdf(new Uint8Array(readFileSync(path)))).pageCount;
}

/** Open a fixture through the home screen's file input and wait for the page count. */
async function openFixture(page: Page, path: string, pages: number): Promise<void> {
  await page.goto('/editor/');
  await page.locator('input[type="file"][accept="application/pdf"]').setInputFiles(path);
  await expect(page.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(`/ ${pages}`, { exact: true }).first()).toBeVisible({ timeout: 120_000 });
}

/** OCR is not a simple-mode command; switch through the settings, as a user would. */
async function useAdvanced(page: Page): Promise<void> {
  await useAdvancedMode(page);
}

/** The OCR form: every operation opens in the tools panel, as a region named by its title. */
function ocrForm(page: Page) {
  return page.getByRole('region', { name: /Metin tanıma|Text recognition/ });
}

/**
 * Open the OCR form through the palette.
 *
 * The palette input is located by its placeholder: the editor also renders a hidden file
 * input and a find box, so "the first text input" would type into the wrong control.
 */
async function openOcrDialog(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder(/Komut veya araç ara|Search commands/);
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill('OCR');
  await expect(page.getByRole('option', { name: /Metin tanıma|Text recognition/ }).first()).toBeVisible({
    timeout: 10_000,
  });
  await page.keyboard.press('Enter');
  await expect(ocrForm(page)).toBeVisible({ timeout: 15_000 });
}

/** Narrow the run to a page range — the shared `pageScope` field every dialog uses. */
async function scopeTo(page: Page, range: string): Promise<void> {
  const form = ocrForm(page);
  // Both controls must exist: a silent skip here would run the whole document.
  const rangeRadio = form.getByRole('radio', { name: /Aralık|Range/i }).first();
  await rangeRadio.check();
  const box = form.getByRole('textbox').first();
  await box.fill(range);
  await expect(box).toHaveValue(range);
}

/**
 * Press the form's first-step button (`op.apply`, "Preview": it runs and shows the report).
 *
 * The editor refuses to start an operation while another runs, and a large fixture is
 * still being indexed right after it opens; waiting for the button to become enabled is
 * waiting on the application's own idle signal rather than sleeping and hoping.
 */
async function runDialog(page: Page): Promise<void> {
  const run = page.getByRole('button', { name: /^Önizle$|^Preview$/ }).first();
  await expect(run).toBeVisible({ timeout: 30_000 });
  await expect(run).toBeEnabled({ timeout: 120_000 });
  await run.click();
}

const report = (page: Page) => page.getByRole('region', { name: /İşlem raporu|Operation report/ });

test.describe('OCR on a scanned document', () => {
  test.skip(!has(SCANNED), `fixture missing: ${SCANNED}`);

  test('recognises real pages and reports a word count', async ({ page }) => {
    const pages = await pagesOf(SCANNED);
    test.skip(pages < 3, `${SCANNED} needs at least 3 pages`);
    await openFixture(page, SCANNED, pages);
    await useAdvanced(page);
    await openOcrDialog(page);
    await scopeTo(page, '1-2');
    await runDialog(page);

    // The report's own note carries the word count: a skip, a stub or a crash report zero,
    // and the engine cannot invent words from a blank render. The count and the page count
    // are read as numbers, not matched as labels (the label is there with zero words too).
    await expect(report(page)).toBeVisible({ timeout: 240_000 });
    const layer = report(page).getByText(/Invisible text layer of \d+ word\(s\) added to \d+ page\(s\)/);
    await expect(layer).toBeVisible({ timeout: 30_000 });
    const match = /of (\d+) word\(s\) added to (\d+) page\(s\)/.exec((await layer.textContent()) ?? '');
    expect(Number(match?.[1] ?? 0)).toBeGreaterThan(50);
    expect(Number(match?.[2] ?? 0)).toBe(2);
  });

  test('the produced bytes keep a usable text layer and the viewer survives', async ({ page }) => {
    const pages = await pagesOf(SCANNED);
    test.skip(pages < 3, `${SCANNED} needs at least 3 pages`);
    await openFixture(page, SCANNED, pages);
    await useAdvanced(page);
    await openOcrDialog(page);
    await scopeTo(page, '1-2');
    await runDialog(page);
    await expect(report(page)).toBeVisible({ timeout: 240_000 });

    // The round trip a user performs: run, apply, keep reading, export.
    await page
      .getByRole('button', { name: /Belgeye uygula|Apply to document/ })
      .first()
      .click();
    await expect(page.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`/ ${pages}`, { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    // The bytes are the evidence: the scan had no text at all, so words on pages 1-2 can
    // only be the recognised layer, and page 3 (outside the range) must stay empty.
    const download = page.waitForEvent('download', { timeout: 240_000 });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const path = test.info().outputPath('ocr-out.pdf');
    await (await download).saveAs(path);
    const texts = await readProducedPageTexts(new Uint8Array(readFileSync(path)), 3);
    const words = (text: string | undefined) => (text ?? '').split(/\s+/).filter(Boolean).length;
    expect(words(texts[0])).toBeGreaterThan(3);
    expect(words(texts[1])).toBeGreaterThan(3);
    expect((texts[2] ?? '').trim()).toBe('');
  });
});

test.describe('OCR on a document that already has text', () => {
  test.skip(!has(TEXT), `fixture missing: ${TEXT}`);

  test('the default skip mode refuses to re-OCR pages that carry text', async ({ page }) => {
    const pages = await pagesOf(TEXT);
    test.skip(pages < 3, `${TEXT} needs at least 3 pages`);
    await openFixture(page, TEXT, pages);
    await useAdvanced(page);
    await openOcrDialog(page);
    await scopeTo(page, '1-3');
    await runDialog(page);

    // Pages 1-3 of this fixture carry text, so the run must report them as skipped. This is
    // the guard that stops a working text layer from being replaced by a worse one — and
    // it is decided per page, from the page's own text, so it finishes in seconds.
    await expect(report(page)).toBeVisible({ timeout: 120_000 });
    await expect(report(page).getByText('3 page(s) with text skipped.', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });
});
