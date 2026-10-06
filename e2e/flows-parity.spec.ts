import { readFileSync } from 'node:fs';
import type { Download, Page } from 'playwright/test';
import { useAdvancedMode, useLanguage } from './settings';
import { expect, test } from './test';
import { authoredToolFixturePdf, readProducedEntry, readProducedPdf, toolFixturePdf } from './tool-fixture';

/**
 * The flows the parity work added, driven in the built app: the command palette's empty
 * state, comment threads and XFDF, form-field detection, sanitising, PDF/A, the PDF/UA and
 * tags views, the home screen, a missing-input error, and the language and direction
 * switches. Fixtures are made in the test (Chromium's own `page.pdf()` for flat and
 * tagged documents) and every test fails on a console error or an uncaught exception.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const CANVAS = '.pdfViewer[data-active-viewer] .page canvas';

async function open(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });
}

/** The palette's search box (the only combobox on the page while it is open). */
const paletteInput = (page: Page) => page.getByRole('combobox');

test('palette: Enter on an empty result list runs nothing, and switching modes keeps the keyboard working', async ({
  page,
}) => {
  await open(page, 'palette.pdf', toolFixturePdf());
  await page.keyboard.press('Control+k');
  await paletteInput(page).fill('zzzqqq');
  await expect(page.getByText('No matching commands.')).toBeVisible();
  await page.keyboard.press('Enter');
  // Nothing ran: the palette is still on screen and no dialog opened (it used to run
  // "Create a blank document", the last command it had highlighted).
  await expect(page.getByText('No matching commands.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Create a blank document' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Create a blank document' })).toHaveCount(0);

  // Simple mode hides the advanced commands; the empty state says so and offers the way out.
  await paletteInput(page).fill('Sanitize');
  await expect(page.getByText('No matching commands.')).toBeVisible();
  await page.getByRole('button', { name: 'Advanced mode' }).click();
  // The click took the focus away from the box; the palette hands it back, so Enter works.
  await expect(paletteInput(page)).toBeFocused();
  await expect(page.getByRole('option').first()).toContainText('Sanitize');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Sanitize document' })).toBeVisible({ timeout: 30_000 });
});

async function saveDownload(download: Download, name: string): Promise<string> {
  const path = test.info().outputPath(name);
  await download.saveAs(path);
  return path;
}

test('comments: a note with a reply and a status leaves as XFDF and comes back as the same thread', async ({
  page,
}) => {
  await open(page, 'review.pdf', toolFixturePdf());
  await useAdvancedMode(page);
  await page.getByRole('tab', { name: 'Comments', exact: true }).click();

  // An empty spot on the page (the fixture's marks sit in other bands).
  await page.getByRole('button', { name: 'Add comment / Note', exact: true }).click();
  const sheet = await page.locator('.pdfViewer[data-active-viewer] .page').first().boundingBox();
  if (sheet === null) throw new Error('no page box');
  await page.mouse.click(sheet.x + 300, sheet.y + 400);

  const rows = page.locator('ul[aria-label="Comments"] > li');
  const row = rows.filter({ hasText: 'unsaved' }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit comment' }).click();
  const body = page.getByLabel('Comment text').first();
  await body.fill('Check this figure');
  await body.blur();
  await expect(row).toContainText('Check this figure');

  await row.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByLabel('Your reply').fill('Figure is correct');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(row.getByRole('list', { name: '1 replies' })).toContainText('Figure is correct');
  await row.getByLabel('Review status').selectOption('Accepted');
  await expect(row.getByLabel('Review status')).toHaveValue('Accepted');

  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export comments as XFDF', exact: true }).click();
  const xfdfPath = await saveDownload(await downloaded, 'review.xfdf');
  const xfdf = readFileSync(xfdfPath, 'utf8');
  // The file is XML, and the reply points at the comment it answers.
  const parsed = await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const annots = [...doc.querySelectorAll('annots > *')];
    return {
      failed: doc.querySelector('parsererror') !== null,
      root: doc.documentElement.localName,
      replies: annots.filter((node) => node.hasAttribute('inreplyto')).length,
      total: annots.length,
    };
  }, xfdf);
  expect(parsed.failed).toBe(false);
  expect(parsed.root).toBe('xfdf');
  expect(parsed.replies).toBeGreaterThanOrEqual(1);
  expect(xfdf).toContain('Check this figure');
  expect(xfdf).toContain('Figure is correct');
  expect(xfdf).toContain('Accepted');

  // A fresh copy of the document knows nothing of the thread until the file is imported.
  await open(page, 'review-copy.pdf', toolFixturePdf());
  await page.getByRole('tab', { name: 'Comments', exact: true }).click();
  await expect(page.getByText('Check this figure')).toHaveCount(0);
  await page.locator('input[type="file"][accept*=".xfdf"]').setInputFiles(xfdfPath);
  const imported = rows.filter({ hasText: 'Check this figure' }).first();
  await expect(imported).toBeVisible({ timeout: 30_000 });
  await expect(imported.getByRole('list', { name: '1 replies' })).toContainText('Figure is correct');
  await expect(imported.getByLabel('Review status')).toHaveValue('Accepted');
});

/** A PDF printed by Chromium from HTML: a real producer's output, with real text and drawn lines. */
async function printedPdf(
  page: Page,
  html: string,
  options: { readonly tagged?: boolean } = {},
): Promise<Uint8Array> {
  const printer = await page.context().newPage();
  try {
    await printer.setContent(html);
    return new Uint8Array(
      await printer.pdf({
        format: 'A4',
        printBackground: true,
        tagged: options.tagged === true,
        outline: false,
      }),
    );
  } finally {
    await printer.close();
  }
}

/** A flat form: captions followed by drawn blanks and two tick squares, no form fields at all. */
const FLAT_FORM = `<!doctype html><html lang="en"><head><title>Flat form</title></head>
<body style="font: 14pt sans-serif; margin: 40pt">
<h1>Registration</h1>
${['Full name', 'Street address', 'City', 'Phone number']
  .map(
    (label) =>
      `<p>${label}: <span style="display:inline-block;width:320px;border-bottom:1px solid #000">&nbsp;</span></p>`,
  )
  .join('\n')}
<p><span style="display:inline-block;width:14px;height:14px;border:1px solid #000"></span> I agree
&nbsp;&nbsp; <span style="display:inline-block;width:14px;height:14px;border:1px solid #000"></span> I decline</p>
</body></html>`;

test('detect form fields: candidates appear, one is removed, the rest become fields, and Ctrl+Z takes them all back', async ({
  page,
}) => {
  await open(page, 'flat-form.pdf', await printedPdf(page, FLAT_FORM));
  await useAdvancedMode(page);
  await page.getByRole('tab', { name: 'Form fields', exact: true }).click();
  await expect(page.getByText('No form fields in this document.')).toBeVisible();

  await page.getByRole('button', { name: 'Detect fields', exact: true }).click();
  const summary = page.locator('[data-form-detect-summary]');
  // Four blanks and two tick squares, each beside its caption.
  await expect(summary).toHaveText('6 fields found: 6 labelled, 0 guessed.', { timeout: 60_000 });
  const candidates = page.getByRole('list', { name: 'Detected fields' }).getByRole('listitem');
  await expect(candidates).toHaveCount(6);

  // Every candidate has a frame on the page; its ✕ takes the candidate out of the review.
  const frames = page.locator('[data-field-candidate-remove]');
  await expect(frames).toHaveCount(6);
  await frames.and(page.getByLabel('Remove the field City')).click();
  await expect(frames).toHaveCount(5);
  await expect(candidates).toHaveCount(5);
  await expect(summary).toHaveText('5 fields found: 5 labelled, 0 guessed.');

  await page.getByRole('button', { name: 'Add 5 fields', exact: true }).click();
  const fieldRows = page.locator('[data-field-row]');
  await expect(fieldRows).toHaveCount(5, { timeout: 60_000 });
  const names = (await fieldRows.allInnerTexts()).join('\n');
  for (const name of ['Full name', 'Street address', 'Phone number', 'I agree', 'I decline']) {
    expect(names).toContain(name);
  }
  expect(names).not.toContain('City');

  // One undo step removes everything the detection added.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(fieldRows).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('No form fields in this document.')).toBeVisible();
});

/** Open an operation's form from the command palette (advanced mode is on). */
async function openForm(page: Page, command: string, region: string) {
  await page.keyboard.press('Control+k');
  await paletteInput(page).fill(command);
  await page.keyboard.press('Enter');
  const form = page.getByRole('region', { name: region });
  await expect(form).toBeVisible({ timeout: 30_000 });
  return form;
}

/** Export through the header button and read the downloaded bytes back. */
async function exported(page: Page, name: string): Promise<Uint8Array> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  return new Uint8Array(readFileSync(await saveDownload(await download, name)));
}

test('sanitize: the preview report comes first, and applying it takes the author out of the file', async ({
  page,
}) => {
  await open(page, 'authored.pdf', await authoredToolFixturePdf('Ada Lovelace', 'Private subject'));
  await useAdvancedMode(page);
  // The app shows no document author anywhere, so the file is read back by MuPDF: first
  // as it stands (the author is really there), then after the sanitize.
  const before = await exported(page, 'before.pdf');
  expect(await readProducedEntry(before, 'trailer', 'Info', 'Author')).toContain('Ada Lovelace');

  const form = await openForm(page, 'Sanitize document', 'Sanitize document');
  await expect(form.getByRole('checkbox', { name: 'Document metadata' })).toBeChecked();
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  const report = form.getByRole('heading', { name: 'Operation report' });
  const goOn = form.getByRole('button', { name: 'Continue', exact: true });
  await expect(goOn.or(report)).toBeVisible({ timeout: 60_000 });
  if (await goOn.isVisible()) await goOn.click();
  await expect(report).toBeVisible({ timeout: 60_000 });
  // The report says what was found before anything is written.
  await expect(form).toContainText(/Metadata: \d+ items found, \d+ removed\./);
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });

  const after = await exported(page, 'after.pdf');
  expect(await readProducedEntry(after, 'trailer', 'Info', 'Author')).toBe('');
  expect(await readProducedEntry(after, 'trailer', 'Info', 'Subject')).toBe('');
  expect(Buffer.from(after).includes('Ada Lovelace')).toBe(false);
  expect((await readProducedPdf(after)).pageCount).toBe(2);
});

test('PDF/A: saving as PDF/A-2b opens a new tab whose own check says PDF/A-2b with no violations', async ({
  page,
}) => {
  await open(page, 'archive.pdf', toolFixturePdf());
  await useAdvancedMode(page);
  const form = await openForm(page, 'Save as PDF/A', 'Save as PDF/A');
  await expect(form.getByRole('radio', { name: 'PDF/A-2b (recommended)' })).toBeChecked();
  // The first press converts and reports; the second opens the result.
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 180_000 });
  await expect(form).toContainText('The document was converted to PDF/A-2b');
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();

  // The result opens beside the source, which is left as it was.
  await expect(page.getByRole('button', { name: 'archive-pdfa-2b.pdf', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  // The converter's own sentence, not the generic "opened in a new tab".
  await expect(page.getByText('The PDF/A file is ready: archive-pdfa-2b.pdf')).toBeVisible();
  await page.getByRole('tab', { name: 'PDF/A', exact: true }).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(
    page.getByText('The file says it is PDF/A-2b and breaks none of the rules checked.'),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/ 0 violation\(s\)/)).toBeVisible();
});

/** A short article as Chromium prints it with its tag tree: a heading, paragraphs, a list and a table. */
const TAGGED_DOCUMENT = `<!doctype html><html lang="en"><head><title>Tagged article</title></head>
<body style="font: 12pt sans-serif; margin: 40pt">
<h1>Annual report</h1>
<p>The first paragraph describes the year.</p>
<ul><li>Revenue grew</li><li>Costs fell</li></ul>
<table border="1"><thead><tr><th>Quarter</th><th>Result</th></tr></thead>
<tbody><tr><td>Q1</td><td>Good</td></tr></tbody></table>
</body></html>`;

test('accessibility: the PDF/UA view lists its rules with states, and the Tags view shows the tree of a tagged page', async ({
  page,
}) => {
  await open(page, 'tagged.pdf', await printedPdf(page, TAGGED_DOCUMENT, { tagged: true }));
  await useAdvancedMode(page);
  await page.getByRole('tab', { name: 'Accessibility', exact: true }).click();

  await page.locator('[data-a11y-tab="ua"]').click();
  const rules = page.locator('[data-ua-rule]');
  await expect(rules.first()).toBeVisible({ timeout: 60_000 });
  const states = await rules.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-ua-state')));
  expect(states.length).toBeGreaterThanOrEqual(8);
  for (const state of states) expect(['pass', 'fail', 'manual', 'na', 'unchecked']).toContain(state);
  // The summary counts what the rows show, independently of how they are grouped.
  const count = (state: string) => states.filter((entry) => entry === state).length;
  await expect(page.locator('[data-ua-summary]')).toHaveText(
    `${count('pass')} passed, ${count('fail')} failed, ${count('manual')} need a person, ${count('na')} not applicable, ${count('unchecked')} not checked.`,
  );
  // Chromium tags a print but never declares PDF/UA, and the view says so.
  await expect(page.getByText('The file does not declare PDF/UA conformance.')).toBeVisible();
  expect(count('pass')).toBeGreaterThan(0);

  await page.locator('[data-a11y-tab="tags"]').click();
  const tree = page.getByRole('tree', { name: 'Structure tree' });
  await expect(tree).toBeVisible({ timeout: 60_000 });
  const roles = await tree
    .locator('[role="treeitem"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-tag-role')));
  expect(roles[0]).toBe('Document');
  for (const role of ['H1', 'P', 'L', 'LI', 'Table', 'TR', 'TH', 'TD']) expect(roles).toContain(role);
});

test('home: the Start tab lays eight tiles out in full rows, and the status bar states the privacy claim', async ({
  page,
}) => {
  await page.goto('/editor/');
  const panel = page.getByRole('tabpanel').first();
  const grid = panel.locator('.grid').first();
  await expect(grid).toBeVisible();
  const boxes = await grid.locator(':scope > *').evaluateAll((tiles) =>
    tiles.map((tile) => {
      const box = tile.getBoundingClientRect();
      return { top: Math.round(box.top), left: Math.round(box.left) };
    }),
  );
  expect(boxes).toHaveLength(8);
  // The rows, as the distinct tops: at 1440 px the tiles fill them completely, so a lone
  // tile on a last row (what a seven-tile grid left behind) is a failure.
  const rows = new Map<number, number>();
  for (const box of boxes) rows.set(box.top, (rows.get(box.top) ?? 0) + 1);
  expect([...rows.values()]).toEqual([4, 4]);

  await expect(page.getByRole('contentinfo')).toContainText('The document never leaves your device.');
});

test('insert pages from a scan with nothing scanned says the input is missing, not "select pages"', async ({
  page,
}) => {
  await open(page, 'insert.pdf', toolFixturePdf());
  await useAdvancedMode(page);
  await page.keyboard.press('Control+k');
  await paletteInput(page).fill('Insert pages');
  await page.keyboard.press('Enter');
  const form = page.getByRole('region', { name: 'Insert Pages' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('radio', { name: 'Scan with camera', exact: true }).check();
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(form.getByText('This operation has nothing to work with yet.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Select pages first.')).toHaveCount(0);
});

test('language: Turkish and back changes <html lang>, and a right-to-left page mirrors the docks', async ({
  page,
}) => {
  await open(page, 'lang.pdf', toolFixturePdf());
  await useAdvancedMode(page);
  const lang = () => page.evaluate(() => document.documentElement.lang);
  const dir = () => page.evaluate(() => document.documentElement.dir);
  expect(await lang()).toBe('en');

  await useLanguage(page, 'Türkçe');
  await expect.poll(lang).toBe('tr');
  await expect(page.getByRole('contentinfo')).toContainText('Belge cihazınızdan ayrılmaz.');
  await useLanguage(page, 'English');
  await expect.poll(lang).toBe('en');
  await expect(page.getByRole('contentinfo')).toContainText('The document never leaves your device.');

  // Left-to-right: the page rail (left dock) sits left of the comments rail (right dock).
  const centre = async (name: string) => {
    const box = await page.getByRole('tab', { name, exact: true }).boundingBox();
    if (box === null) throw new Error(`no ${name} tab`);
    return box.x + box.width / 2;
  };
  expect(await dir()).toBe('ltr');
  expect(await centre('Pages')).toBeLessThan(await centre('Comments'));

  await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
  });
  await expect.poll(async () => (await centre('Pages')) > (await centre('Comments'))).toBe(true);
});
