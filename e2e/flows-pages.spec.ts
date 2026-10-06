import { readFileSync } from 'node:fs';
import type { Download, Page } from 'playwright/test';
import { expect, test } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { labelledPdf, readProducedEntry, readProducedPageTexts } from './tool-fixture';

/**
 * Page and file flows end to end: insert, merge, extract, split, the two exports, print,
 * opening by drag and drop, and reordering by drag.
 *
 * One test per flow. Where a file is produced the test reads the downloaded or exported
 * bytes back with the independent readers in `tool-fixture.ts` (page count, page order,
 * text), not the application's own state.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const CANVAS = '.pdfViewer[data-active-viewer] .page canvas';

const pdfFile = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from(bytes),
});

async function open(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles(pdfFile(name, bytes));
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  // The page shows before the open finishes (the source is still being stored), and the
  // shell refuses other work until then: a gesture sent earlier is dropped under load.
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });
}

/** Export through the header button and read the downloaded bytes back. */
async function exported(page: Page, name: string): Promise<Uint8Array> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return new Uint8Array(readFileSync(path));
}

const thumbs = (page: Page) => page.getByRole('option');
const notice = (page: Page, text: string) => page.locator('[role="status"]').filter({ hasText: text });

/** Open an operation's form from the command palette. */
async function openForm(page: Page, command: string, region: string) {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill(command);
  await page.keyboard.press('Enter');
  const form = page.getByRole('region', { name: region });
  await expect(form).toBeVisible({ timeout: 30_000 });
  return form;
}

async function previewForm(form: ReturnType<Page['getByRole']>, confirm = 'Preview'): Promise<void> {
  await form.getByRole('button', { name: confirm, exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
}

test('insert pages: a blank page and a page range of another file land where asked', async ({ page }) => {
  await open(page, 'base.pdf', labelledPdf('Base', 3));
  await useAdvancedMode(page);
  let form = await openForm(page, 'Insert page', 'Insert Pages');
  await form.getByRole('spinbutton', { name: 'Position (after page N)' }).fill('1');
  await previewForm(form);
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });
  await expect(thumbs(page)).toHaveCount(4);

  form = await openForm(page, 'Insert page', 'Insert Pages');
  await form.getByRole('radio', { name: 'From another PDF' }).check();
  await form.locator('input[type="file"]').setInputFiles(pdfFile('donor.pdf', labelledPdf('Donor', 4)));
  await form.getByRole('textbox', { name: 'Source page range' }).fill('3-4');
  await form.getByRole('spinbutton', { name: 'Position (after page N)' }).fill('0');
  await previewForm(form);
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });
  await expect(thumbs(page)).toHaveCount(6);

  const texts = await readProducedPageTexts(await exported(page, 'inserted.pdf'));
  expect(texts.map((text) => text.trim())).toEqual(['Donor 3', 'Donor 4', 'Base 1', '', 'Base 2', 'Base 3']);
});

test('merge: another file added at the start and at the end keeps every page in order', async ({ page }) => {
  await open(page, 'base.pdf', labelledPdf('Base', 2));
  for (const [position, donor] of [
    ['At start of document', labelledPdf('Front', 2)],
    ['At end of document', labelledPdf('Back', 1)],
  ] as const) {
    const form = await openForm(page, 'Add / Import Document', 'Add / Import Document');
    await form.locator('input[type="file"]').setInputFiles(pdfFile('donor.pdf', donor));
    await form.getByRole('radio', { name: position }).check();
    await previewForm(form);
    await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 30_000 });
  }
  await expect(thumbs(page)).toHaveCount(5);
  const texts = await readProducedPageTexts(await exported(page, 'merged.pdf'));
  expect(texts.map((text) => text.trim())).toEqual(['Front 1', 'Front 2', 'Base 1', 'Base 2', 'Back 1']);
});

test('extract: the selected page opens as its own document and the source keeps all of its pages', async ({
  page,
}) => {
  await open(page, 'source.pdf', labelledPdf('Page', 3));
  await thumbs(page).nth(1).click();
  const form = await openForm(page, 'Extract Pages', 'Extract Pages');
  await previewForm(form, 'Open in new tab');
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  // Named for the page it holds, not for a part counter.
  const header = page.getByRole('button', { name: 'source-p2.pdf', exact: true });
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(thumbs(page)).toHaveCount(1);
  const extracted = await readProducedPageTexts(await exported(page, 'extracted.pdf'));
  expect(extracted.map((text) => text.trim())).toEqual(['Page 2']);

  await header.click();
  await page.getByRole('button', { name: 'source.pdf', exact: true }).click();
  await expect(thumbs(page)).toHaveCount(3);
  const source = await readProducedPageTexts(await exported(page, 'source-out.pdf'));
  expect(source.map((text) => text.trim())).toEqual(['Page 1', 'Page 2', 'Page 3']);
});

/** Collect every download the page starts, saved and read back, until `count` have arrived. */
async function collectDownloads(
  page: Page,
  count: number,
  trigger: () => Promise<void>,
): Promise<{ name: string; bytes: Uint8Array }[]> {
  const started: Download[] = [];
  page.on('download', (download) => started.push(download));
  await trigger();
  await expect.poll(() => started.length, { timeout: 60_000 }).toBe(count);
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const download of started) {
    const path = test.info().outputPath(`dl-${files.length}-${download.suggestedFilename()}`);
    await download.saveAs(path);
    files.push({ name: download.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)) });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

test('split: page ranges become separate files with the right pages in the right order', async ({ page }) => {
  await open(page, 'big.pdf', labelledPdf('Sheet', 4));
  await useAdvancedMode(page);
  const form = await openForm(page, 'Split Document', 'Split Document');
  await form.getByRole('radio', { name: 'By page ranges' }).check();
  await form.getByRole('textbox', { name: 'Page ranges' }).fill('3-4, 1');
  await previewForm(form, 'Download');
  const files = await collectDownloads(page, 2, () =>
    form.getByRole('button', { name: 'Download', exact: true }).click(),
  );
  expect(files.map((file) => file.name)).toEqual(['big-1.pdf', 'big-2.pdf']);
  const parts = await Promise.all(files.map((file) => readProducedPageTexts(file.bytes)));
  expect(parts.map((texts) => texts.map((text) => text.trim()))).toEqual([
    ['Sheet 1'],
    ['Sheet 3', 'Sheet 4'],
  ]);
});

test('export as images: one PNG per page at the requested resolution', async ({ page }) => {
  await open(page, 'img.pdf', labelledPdf('Pic', 2));
  await useAdvancedMode(page);
  const form = await openForm(page, 'Export Pages as Images', 'Export Pages as Images');
  await form.getByRole('spinbutton', { name: 'Resolution (DPI)' }).fill('144');
  await previewForm(form, 'Download');
  const files = await collectDownloads(page, 2, () =>
    form.getByRole('button', { name: 'Download', exact: true }).click(),
  );
  expect(files.map((file) => file.name)).toEqual(['img-001.png', 'img-002.png']);
  for (const file of files) {
    const view = new DataView(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
    expect([...file.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // 595 x 842 points at 144 dpi is 1190 x 1684 pixels.
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1190, 1684]);
  }
  // Different pages are different pictures.
  expect(Buffer.from(files[0]?.bytes ?? []).equals(Buffer.from(files[1]?.bytes ?? []))).toBe(false);
});

test('export as text: the text file holds every page in order', async ({ page }) => {
  await open(page, 'words.pdf', labelledPdf('Word', 3));
  await useAdvancedMode(page);
  const form = await openForm(page, 'Export Text', 'Export Text');
  await previewForm(form, 'Download');
  const [file] = await collectDownloads(page, 1, () =>
    form.getByRole('button', { name: 'Download', exact: true }).click(),
  );
  expect(file?.name).toBe('words.txt');
  const text = Buffer.from(file?.bytes ?? []).toString('utf8');
  expect(text.indexOf('Word 1')).toBeGreaterThanOrEqual(0);
  expect(text.indexOf('Word 2')).toBeGreaterThan(text.indexOf('Word 1'));
  expect(text.indexOf('Word 3')).toBeGreaterThan(text.indexOf('Word 2'));
});

test('export options: the image format chosen in the export dialog is the one the form starts with', async ({
  page,
}) => {
  // The choice was read and then dropped: choosing JPG opened the form on PNG.
  await open(page, 'choice.pdf', labelledPdf('Pic', 1));
  await page.getByRole('button', { name: 'Export Options' }).click();
  const dialog = page.getByRole('dialog', { name: 'Download / Export' });
  await dialog.getByRole('radio', { name: 'Image Format' }).check();
  await dialog.getByRole('combobox').nth(1).selectOption('jpg');
  await dialog.getByRole('button', { name: 'Download Images' }).click();
  const form = page.getByRole('region', { name: 'Export Pages as Images' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('spinbutton', { name: 'Resolution (DPI)' }).fill('72');
  await previewForm(form, 'Download');
  const [file] = await collectDownloads(page, 1, () =>
    form.getByRole('button', { name: 'Download', exact: true }).click(),
  );
  expect(file?.name).toBe('choice-001.jpg');
  expect([...(file?.bytes.slice(0, 3) ?? [])]).toEqual([0xff, 0xd8, 0xff]);
});

test('print: the chosen range is rendered into the print sheet and handed to the browser', async ({
  page,
}) => {
  // The browser's own print call is replaced by a recorder that reads the sheets at the
  // moment it is invoked; headless Chromium has no print dialog to drive.
  await page.addInitScript(() => {
    const seen: { sheets: number; decoded: number }[] = [];
    Object.assign(window, { __printCalls: seen });
    window.print = () => {
      const images = [...document.querySelectorAll<HTMLImageElement>('.pdf-print-root img')];
      seen.push({ sheets: images.length, decoded: images.filter((image) => image.naturalWidth > 0).length });
    };
  });
  await open(page, 'print.pdf', labelledPdf('Leaf', 4));
  await page.keyboard.press('Control+p');
  const dialog = page.getByRole('dialog', { name: 'Print' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Range' }).check();
  await dialog.getByRole('textbox', { name: 'Page range' }).fill('2-3');
  await dialog.getByRole('button', { name: 'Print', exact: true }).click();
  const calls = () =>
    page.evaluate(
      () => (window as unknown as { __printCalls: { sheets: number; decoded: number }[] }).__printCalls,
    );
  await expect.poll(calls, { timeout: 60_000 }).toEqual([{ sheets: 2, decoded: 2 }]);

  // The browser reports the job finished: the sheets are removed and the dialog closes.
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(dialog).toBeHidden();
  await expect(page.locator('.pdf-print-root')).toHaveCount(0);

  // An unreadable range is refused in the dialog and prints nothing.
  await page.keyboard.press('Control+p');
  await dialog.getByRole('radio', { name: 'Range' }).check();
  await dialog.getByRole('textbox', { name: 'Page range' }).fill('2-x');
  await dialog.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not read the range: 2-x');
  expect(await calls()).toHaveLength(1);
});

/** Drop files on the shell the way the browser delivers them: one `drop` carrying a DataTransfer. */
async function dropFiles(
  page: Page,
  files: readonly { name: string; type: string; bytes: Uint8Array }[],
): Promise<void> {
  await page.evaluate(
    (payload) => {
      const transfer = new DataTransfer();
      for (const file of payload) {
        transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
      }
      const target = document.querySelector('#root > div') ?? document.body;
      target.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    },
    files.map((file) => ({ ...file, bytes: [...file.bytes] as unknown as Uint8Array })),
  );
}

test('drag and drop: a dropped PDF opens, a dropped non-PDF is refused, and a second PDF opens beside the first', async ({
  page,
}) => {
  await page.goto('/editor/');
  await dropFiles(page, [
    // Not a PDF and not a format the converter takes (a `.txt` would become a PDF).
    { name: 'notes.bin', type: 'application/octet-stream', bytes: new TextEncoder().encode('hello') },
  ]);
  await expect(notice(page, 'The document looks damaged')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.pdfViewer')).toHaveCount(0);

  await dropFiles(page, [{ name: 'first.pdf', type: 'application/pdf', bytes: labelledPdf('One', 2) }]);
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  await expect(thumbs(page)).toHaveCount(2);
  // The page is on screen before the open finishes (the source is still being stored), and
  // the shell refuses a second open until then: wait for the open itself to end.
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });

  await dropFiles(page, [{ name: 'second.pdf', type: 'application/pdf', bytes: labelledPdf('Two', 3) }]);
  await expect(page.getByRole('button', { name: 'second.pdf', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(thumbs(page)).toHaveCount(3);
  const second = await readProducedPageTexts(await exported(page, 'second-out.pdf'));
  expect(second.map((text) => text.trim())).toEqual(['Two 1', 'Two 2', 'Two 3']);
  await page.getByRole('button', { name: 'second.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'first.pdf', exact: true }).click();
  await expect(thumbs(page)).toHaveCount(2);
});

test('reordering by drag: two selected pages dropped after the last page keep their order', async ({
  page,
}) => {
  await open(page, 'order.pdf', labelledPdf('Slot', 3));
  await thumbs(page).nth(0).click();
  await thumbs(page)
    .nth(1)
    .click({ modifiers: ['Control'] });
  const last = thumbs(page).nth(2);
  const box = await last.boundingBox();
  if (box === null) throw new Error('no thumbnail box');
  // The lower half of a row means "after it".
  await thumbs(page)
    .nth(0)
    .dragTo(last, { targetPosition: { x: box.width / 2, y: box.height - 4 } });
  await expect(notice(page, '2 page(s) moved')).toBeVisible();
  const texts = await readProducedPageTexts(await exported(page, 'ordered.pdf'));
  expect(texts.map((text) => text.trim())).toEqual(['Slot 3', 'Slot 1', 'Slot 2']);
});

test("a thumbnail's own rotate and delete buttons act on that thumbnail's page, not the selected one", async ({
  page,
}) => {
  // The buttons selected their page and ran the action in the same tick, so the action
  // read the previous selection: rotating page 2 turned page 1, deleting page 3 deleted 1.
  await open(page, 'hover.pdf', labelledPdf('Hover', 3));
  await thumbs(page).nth(1).hover();
  await thumbs(page).nth(1).getByRole('button', { name: 'Rotate right' }).click();
  await expect(notice(page, '1 page(s) rotated')).toBeVisible();
  await thumbs(page).nth(2).hover();
  await thumbs(page).nth(2).getByRole('button', { name: 'Delete pages' }).click();
  await expect(thumbs(page)).toHaveCount(2);

  const bytes = await exported(page, 'hover-out.pdf');
  const texts = await readProducedPageTexts(bytes);
  expect(texts.map((text) => text.trim())).toEqual(['Hover 1', 'Hover 2']);
  expect(await readProducedEntry(bytes, 0, 'Rotate')).toMatch(/^0?$/);
  expect(await readProducedEntry(bytes, 1, 'Rotate')).toBe('90');
});

/**
 * How far thumbnail `index` is from the main view's page `index`: both canvases' aspect
 * ratios and the mean difference of 16×16 grey copies (0–255). The main page is brought
 * into view first, so its canvas is painted.
 */
async function thumbnailVersusPage(
  page: Page,
  index: number,
): Promise<{ readonly thumb: number; readonly main: number; readonly diff: number }> {
  return page.evaluate((pageIndex) => {
    const thumb = document.querySelector<HTMLCanvasElement>(`[data-thumb="${pageIndex}"] canvas`);
    const main = document.querySelector<HTMLCanvasElement>(
      `.pdfViewer[data-active-viewer] .page[data-page-number="${pageIndex + 1}"] canvas`,
    );
    if (thumb === null || main === null || thumb.width === 0 || main.width === 0) {
      return { thumb: 0, main: -1, diff: 255 };
    }
    const grey = (source: HTMLCanvasElement): number[] => {
      const small = document.createElement('canvas');
      small.width = 16;
      small.height = 16;
      const context = small.getContext('2d', { willReadFrequently: true });
      if (context === null) return [];
      context.drawImage(source, 0, 0, 16, 16);
      const { data } = context.getImageData(0, 0, 16, 16);
      const out: number[] = [];
      for (let at = 0; at < data.length; at += 4)
        out.push(((data[at] ?? 0) + (data[at + 1] ?? 0) + (data[at + 2] ?? 0)) / 3);
      return out;
    };
    const a = grey(thumb);
    const b = grey(main);
    const diff =
      a.reduce((sum, value, at) => sum + Math.abs(value - (b[at] ?? 0)), 0) / Math.max(a.length, 1);
    return { thumb: thumb.width / thumb.height, main: main.width / main.height, diff };
  }, index);
}

/** Bring page `index` into the main view and wait until its thumbnail shows the same page. */
async function expectThumbnailMatchesPage(page: Page, index: number): Promise<void> {
  await thumbs(page).nth(index).click();
  await expect
    .poll(
      async () => {
        const { thumb, main, diff } = await thumbnailVersusPage(page, index);
        return Math.abs(thumb - main) < 0.05 && diff < 12;
      },
      { message: `thumbnail ${index + 1} shows the page the main view shows`, timeout: 15_000 },
    )
    .toBe(true);
}

/** Open a second file in the same session: a new document tab beside the first. */
async function openAnother(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles(pdfFile(name, bytes));
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });
}

test('thumbnails follow the page: a turn of an already-turned page, an insert, and a second file of the same length', async ({
  page,
}) => {
  // Pages the file itself turns are the case that kept the old picture: the turn wrote a
  // new state before the new document handle arrived, and the painted flag outlived it.
  await open(page, 'turned.pdf', labelledPdf('Turned', 4, { rotations: [0, 90, 180, 270] }));
  for (const index of [1, 2]) {
    await thumbs(page).nth(index).click();
    await page.getByRole('button', { name: 'Rotate Page (90°)' }).click();
    await expect(notice(page, '1 page(s) rotated')).toBeVisible();
    await expectThumbnailMatchesPage(page, index);
  }

  await useAdvancedMode(page);
  const form = await openForm(page, 'Insert page', 'Insert Pages');
  await form.getByRole('spinbutton', { name: 'Position (after page N)' }).fill('2');
  await form.getByRole('spinbutton', { name: 'Page count to insert' }).fill('2');
  await previewForm(form);
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });
  await expect(thumbs(page)).toHaveCount(6);
  for (const index of [0, 1, 2, 3, 4, 5]) await expectThumbnailMatchesPage(page, index);

  // Two freshly opened files are both state "source": a file of the same length kept the
  // first file's pictures.
  await openAnother(page, 'wide.pdf', labelledPdf('Wide', 6, { size: [842, 595] }));
  for (const index of [0, 5]) await expectThumbnailMatchesPage(page, index);
});
