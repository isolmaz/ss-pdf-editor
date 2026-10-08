/**
 * The batch dialog as a user drives it: a queue of files, a rule set of steps, a run with
 * progress, cancel and per-file failures, the rule set saved to and loaded from a JSON file,
 * and a watched folder. The finished files are downloaded and read back with MuPDF.
 */

import { readFileSync } from 'node:fs';
import type { Download, Locator, Page } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { expect, test } from './test';
import { labelledPdf, readProducedEntry, readProducedPageTexts, readProducedPdf } from './tool-fixture';
import { pdfFile } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 150_000 });

const STEPS = [
  'Extract Pages',
  'Optimize / Compress',
  'Text recognition (OCR)',
  'Page labels',
  'Header / Footer & Page Numbering',
  'Document properties',
  'Export Text',
  'Security',
] as const;

async function openBatch(page: Page): Promise<Locator> {
  await page.goto('/editor/');
  await useAdvancedMode(page);
  await page.getByRole('button', { name: 'Search commands (Ctrl+K)' }).click();
  await page.getByRole('combobox').fill('Batch operations');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Batch operations' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Tick exactly these steps (the dialog starts with Optimize and Document properties on). */
async function onlySteps(dialog: Locator, wanted: readonly (typeof STEPS)[number][]): Promise<void> {
  for (const step of STEPS) {
    await dialog.getByRole('checkbox', { name: step, exact: true }).setChecked(wanted.includes(step));
  }
}

async function queue(dialog: Locator, files: readonly { name: string; bytes: Uint8Array }[]): Promise<void> {
  await dialog
    .locator('input[type="file"][accept*="pdf"]')
    .first()
    .setInputFiles(files.map((file) => pdfFile(file.name, file.bytes)));
}

/** Click and gather every download the page starts until `count` have arrived. */
async function downloads(
  page: Page,
  count: number,
  trigger: () => Promise<void>,
): Promise<Map<string, Uint8Array>> {
  const started: Download[] = [];
  page.on('download', (download) => started.push(download));
  await trigger();
  await expect.poll(() => started.length, { timeout: 60_000 }).toBe(count);
  const files = new Map<string, Uint8Array>();
  for (const download of started) {
    const path = test.info().outputPath(`batch-${files.size}-${download.suggestedFilename()}`);
    await download.saveAs(path);
    files.set(download.suggestedFilename(), new Uint8Array(readFileSync(path)));
  }
  return files;
}

/** The file report section: it is headed, not landmarked. */
const fileReport = (dialog: Locator): Locator => dialog.locator('section').filter({ hasText: 'File report' });

const bytesOf = (files: ReadonlyMap<string, Uint8Array>, name: string): Uint8Array => {
  const found = files.get(name);
  if (found === undefined) throw new Error(`no download named ${name}: ${[...files.keys()].join(', ')}`);
  return found;
};

test('extract, label and describe: every file gets each step, in order, and the report names the numbers', async ({
  page,
}) => {
  const dialog = await openBatch(page);
  await queue(dialog, [
    { name: 'alpha.pdf', bytes: labelledPdf('Alpha', 3) },
    { name: 'beta.pdf', bytes: labelledPdf('Beta', 4) },
  ]);
  await expect(dialog.getByText('2/', { exact: false }).first()).toBeVisible();
  await expect(dialog.getByRole('list').getByText('alpha.pdf', { exact: true })).toBeVisible();
  await onlySteps(dialog, ['Extract Pages', 'Page labels', 'Document properties']);
  await dialog.getByRole('textbox', { name: 'Page range' }).fill('2-3');
  await dialog.getByRole('textbox', { name: 'Prefix' }).fill('A-');
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Batch title');
  await dialog.getByRole('textbox', { name: 'Author' }).fill('Ada Lovelace');
  await dialog.getByRole('button', { name: 'Run batch' }).click();

  await expect(dialog.getByText('2 completed, 0 failed, 0 skipped').first()).toBeVisible({
    timeout: 120_000,
  });
  const report = fileReport(dialog);
  await expect(report.getByText(/^alpha.* — .* · \d+ → \d+ bytes, 2 page\(s\)$/)).toBeVisible();
  await expect(report.getByText(/^beta.* — .* · \d+ → \d+ bytes, 2 page\(s\)$/)).toBeVisible();

  const files = await downloads(page, 2, () =>
    dialog.getByRole('button', { name: 'Download finished files' }).click(),
  );
  expect([...files.keys()].sort()).toHaveLength(2);
  for (const [name, label, last] of [
    ['alpha', 'Alpha', 3],
    ['beta', 'Beta', 3],
  ] as const) {
    const produced = [...files.entries()].find(([file]) => file.includes(name));
    if (produced === undefined) throw new Error(`no file for ${name}`);
    const bytes = produced[1];
    expect((await readProducedPdf(bytes)).pageCount).toBe(2);
    const texts = await readProducedPageTexts(bytes);
    expect(texts.map((text) => text.trim())).toEqual([`${label} 2`, `${label} ${last}`]);
    expect(await readProducedEntry(bytes, null, 'PageLabels')).toContain('A-');
    expect(await readProducedEntry(bytes, 'trailer', 'Info', 'Title')).toBe('(Batch title)');
    expect(await readProducedEntry(bytes, 'trailer', 'Info', 'Author')).toBe('(Ada Lovelace)');
  }
});

test('Header / Footer: the format template and the start number reach every file', async ({ page }) => {
  const dialog = await openBatch(page);
  await queue(dialog, [{ name: 'memo.pdf', bytes: labelledPdf('Memo', 2) }]);
  await onlySteps(dialog, ['Header / Footer & Page Numbering']);
  await dialog.getByRole('textbox', { name: 'Format' }).fill('Leaf {page} of {total}');
  await dialog.getByRole('spinbutton', { name: 'Starting page number' }).fill('5');
  await dialog.getByRole('checkbox', { name: 'Skip first page' }).check();
  await dialog.getByRole('button', { name: 'Run batch' }).click();
  await expect(dialog.getByText('1 completed, 0 failed, 0 skipped').first()).toBeVisible({
    timeout: 120_000,
  });
  const files = await downloads(page, 1, () =>
    dialog.getByRole('button', { name: 'Download finished files' }).click(),
  );
  const texts = await readProducedPageTexts([...files.values()][0] ?? new Uint8Array());
  expect(texts[0]).not.toContain('Leaf');
  expect(texts[1]).toContain('Leaf 5 of 2');
});

test('Export Text: a text file comes with the finished PDF', async ({ page }) => {
  const dialog = await openBatch(page);
  await queue(dialog, [{ name: 'memo.pdf', bytes: labelledPdf('Memo', 2) }]);
  await onlySteps(dialog, ['Export Text']);
  await dialog.getByRole('button', { name: 'Run batch' }).click();
  await expect(dialog.getByText('1 completed, 0 failed, 0 skipped').first()).toBeVisible({
    timeout: 120_000,
  });
  const files = await downloads(page, 2, () =>
    dialog.getByRole('button', { name: 'Download finished files' }).click(),
  );
  const names = [...files.keys()];
  const textName = names.find((name) => name.endsWith('.txt'));
  if (textName === undefined) throw new Error(`no text file among ${names.join(', ')}`);
  expect(names.filter((name) => name.endsWith('.pdf'))).toHaveLength(1);
  const text = new TextDecoder().decode(bytesOf(files, textName));
  expect(text).toContain('Memo 1');
  expect(text).toContain('Memo 2');
});

test('Security without an owner password fails every file with the policy message', async ({ page }) => {
  const dialog = await openBatch(page);
  await queue(dialog, [{ name: 'memo.pdf', bytes: labelledPdf('Memo', 2) }]);
  await onlySteps(dialog, ['Security']);
  await dialog.getByLabel('Open password').fill('s3cret');
  await dialog.getByRole('button', { name: 'Run batch' }).click();
  await expect(dialog.getByText('0 completed, 1 failed, 0 skipped').first()).toBeVisible({
    timeout: 120_000,
  });
  const failure = fileReport(dialog).getByRole('alert');
  await expect(failure).toContainText('Failed at step Security:');
  await expect(failure).toContainText('Operation halted by password policy.');
  await expect(failure).toContainText('owner password is required');
});

test('Security: the finished PDF is encrypted with the open password and the chosen permissions', async ({
  page,
}) => {
  const dialog = await openBatch(page);
  await queue(dialog, [{ name: 'memo.pdf', bytes: labelledPdf('Memo', 2) }]);
  await onlySteps(dialog, ['Security']);
  await dialog.getByLabel('Open password').fill('s3cret');
  await dialog.getByLabel('Owner password').fill('0wner');
  await dialog.getByRole('checkbox', { name: 'Printing', exact: true }).setChecked(true);
  await dialog.getByRole('checkbox', { name: 'Copying', exact: true }).setChecked(false);
  await dialog.getByRole('checkbox', { name: 'Editing', exact: true }).setChecked(false);
  await dialog.getByRole('button', { name: 'Run batch' }).click();
  await expect(dialog.getByText('1 completed, 0 failed, 0 skipped').first()).toBeVisible({
    timeout: 120_000,
  });
  const files = await downloads(page, 1, () =>
    dialog.getByRole('button', { name: 'Download finished files' }).click(),
  );
  const bytes = [...files.values()][0] ?? new Uint8Array();
  expect(await readProducedEntry(bytes, 'trailer', 'Encrypt', 'Filter')).toContain('Standard');
  // Printing (bit 3) was granted; editing (bit 4) and copying (bit 5) were not.
  const permissions = Number(await readProducedEntry(bytes, 'trailer', 'Encrypt', 'P'));
  expect(permissions & 4).toBe(4);
  expect(permissions & 8).toBe(0);
  expect(permissions & 16).toBe(0);
});

test.describe('a damaged file in the queue', () => {
  // MuPDF reports what it repairs and what it cannot read on the console.
  test.use({ allowedErrors: [/format error|repair/] });

  test('a file that is not a PDF fails alone: its row says where, and the others still finish', async ({
    page,
  }) => {
    const dialog = await openBatch(page);
    await queue(dialog, [
      { name: 'good.pdf', bytes: labelledPdf('Good', 2) },
      { name: 'broken.pdf', bytes: new TextEncoder().encode('this is not a pdf at all') },
    ]);
    await onlySteps(dialog, ['Page labels']);
    await dialog.getByRole('button', { name: 'Run batch' }).click();
    await expect(dialog.getByText('1 completed, 1 failed, 0 skipped').first()).toBeVisible({
      timeout: 120_000,
    });
    const report = fileReport(dialog);
    const failure = report.getByRole('alert');
    await expect(failure).toHaveCount(1);
    await expect(failure).toContainText('Failed at step Page labels:');
    await expect(report.getByText(/^good.* — /)).toContainText('2 page(s)');
    // Only the finished file is downloaded.
    const files = await downloads(page, 1, () =>
      dialog.getByRole('button', { name: 'Download finished files' }).click(),
    );
    expect([...files.keys()][0]).toContain('good');
  });
});

test('a page range that cannot be read stops the run before any file is touched', async ({ page }) => {
  const dialog = await openBatch(page);
  await queue(dialog, [{ name: 'memo.pdf', bytes: labelledPdf('Memo', 2) }]);
  await onlySteps(dialog, ['Extract Pages']);
  await dialog.getByRole('textbox', { name: 'Page range' }).fill('two to three');
  await dialog.getByRole('button', { name: 'Run batch' }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('Could not read step settings.');
  await expect(alert).toContainText('pages: two to three');
  await expect(fileReport(dialog)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Download finished files' })).toHaveCount(0);
});

test('the run needs a queue and at least one step', async ({ page }) => {
  const dialog = await openBatch(page);
  const run = dialog.getByRole('button', { name: 'Run batch' });
  await expect(run).toBeDisabled();
  await queue(dialog, [{ name: 'memo.pdf', bytes: labelledPdf('Memo', 1) }]);
  await expect(run).toBeEnabled();
  await onlySteps(dialog, []);
  await expect(run).toBeDisabled();
});

test('a ruleset is saved as JSON, loaded again, locks the steps, and can be discarded', async ({ page }) => {
  const dialog = await openBatch(page);
  await onlySteps(dialog, ['Extract Pages', 'Page labels']);
  await dialog.getByRole('textbox', { name: 'Page range' }).fill('1-2');
  await dialog.getByRole('textbox', { name: 'Prefix' }).fill('Z-');
  await dialog.getByRole('textbox', { name: 'Ruleset name' }).fill('my rules');
  const saved = await downloads(page, 1, () =>
    dialog.getByRole('button', { name: 'Save ruleset (JSON)' }).click(),
  );
  const [fileName, bytes] = [...saved.entries()][0] ?? ['', new Uint8Array()];
  expect(fileName).toBe('my rules.batch.json');
  const template = JSON.parse(new TextDecoder().decode(bytes)) as {
    name: string;
    steps: { kind: string; params: Record<string, unknown> }[];
  };
  expect(template.name).toBe('my rules');
  expect(template.steps.map((step) => step.kind)).toEqual(['pages', 'page-labels']);
  expect(template.steps[0]?.params.pages).toEqual([0, 1]);

  // A fresh dialog with its queue loads it: the steps are locked and the run uses exactly the loaded rules.
  const again = await openBatch(page);
  await queue(again, [{ name: 'memo.pdf', bytes: labelledPdf('Memo', 4) }]);
  await again.locator('input[type="file"][accept*="json"]').setInputFiles({
    name: fileName,
    mimeType: 'application/json',
    buffer: Buffer.from(bytes),
  });
  await expect(
    again.getByRole('status').filter({ hasText: 'Loaded ruleset contains 2 step(s)' }),
  ).toBeVisible();
  await expect(again.getByRole('textbox', { name: 'Ruleset name' })).toHaveValue('my rules');
  await expect(again.getByRole('textbox', { name: 'Ruleset name' })).toBeDisabled();
  await expect(again.getByRole('checkbox', { name: 'Extract Pages', exact: true })).toBeDisabled();
  await again.getByRole('button', { name: 'Run batch' }).click();
  await expect(again.getByText('1 completed, 0 failed, 0 skipped').first()).toBeVisible({ timeout: 120_000 });
  const files = await downloads(page, 1, () =>
    again.getByRole('button', { name: 'Download finished files' }).click(),
  );
  const out = [...files.values()][0] ?? new Uint8Array();
  expect((await readProducedPdf(out)).pageCount).toBe(2);
  expect(await readProducedEntry(out, null, 'PageLabels')).toContain('Z-');

  await again.getByRole('button', { name: 'Discard loaded ruleset' }).click();
  await expect(again.getByRole('checkbox', { name: 'Extract Pages', exact: true })).toBeEnabled();
  await expect(again.getByRole('textbox', { name: 'Ruleset name' })).toBeEnabled();
  await expect(again.getByText('Loaded ruleset contains')).toHaveCount(0);
});

test('a file that is not a ruleset is refused with a message and loads nothing', async ({ page }) => {
  const dialog = await openBatch(page);
  await dialog.locator('input[type="file"][accept*="json"]').setInputFiles({
    name: 'rules.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version": 99, "steps": "nope"}'),
  });
  const alert = dialog.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(dialog.getByText('Loaded ruleset contains')).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: 'Optimize / Compress', exact: true })).toBeEnabled();
});

test('Cancel stops a running batch: progress names the file, finished files are kept, the rest are skipped', async ({
  page,
}) => {
  const dialog = await openBatch(page);
  await queue(dialog, [
    { name: 'one.pdf', bytes: labelledPdf('One', 1) },
    { name: 'two.pdf', bytes: labelledPdf('Two', 40) },
    { name: 'three.pdf', bytes: labelledPdf('Three', 40) },
  ]);
  await onlySteps(dialog, ['Optimize / Compress']);
  await dialog.getByRole('radio', { name: 'Convert pages to image (lossy)' }).check();
  await dialog.getByRole('spinbutton', { name: /Resolution/ }).fill('300');
  await dialog.getByRole('button', { name: 'Run batch' }).click();
  // While it runs the progress shows which file it is on, and the run button is the cancel one.
  await expect(dialog.getByText('Processing').first()).toBeVisible();
  const cancel = dialog.getByRole('button', { name: 'Cancel' }).last();
  await expect(dialog.getByRole('button', { name: 'Run batch' })).toHaveCount(0);
  await expect(dialog.getByText(/^(one|two|three)\.pdf$/).last()).toBeVisible({ timeout: 60_000 });
  await cancel.click();
  await expect(dialog.getByText(/^Batch cancelled\. Completed files:/)).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText(/\d+ completed, \d+ failed, [1-9]\d* skipped/).first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Run batch' })).toBeEnabled();
});

/* ------------------------------------------------------------------ *
 * A watched folder
 * ------------------------------------------------------------------ */

/** Stand in for the folder picker with a real directory of the origin-private file system. */
async function stageFolder(page: Page, files: readonly { name: string; bytes: Uint8Array }[]): Promise<void> {
  await page.evaluate(
    async (entries) => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('watched', { create: true });
      for (const entry of entries) {
        const handle = await folder.getFileHandle(entry.name, { create: true });
        const writer = await handle.createWritable();
        await writer.write(new Uint8Array(entry.bytes));
        await writer.close();
      }
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async () => folder,
      });
    },
    files.map((file) => ({ name: file.name, bytes: [...file.bytes] })),
  );
}

test('watching a folder queues its PDFs, picks up a new one, and stops on request', async ({ page }) => {
  const dialog = await openBatch(page);
  await stageFolder(page, [
    { name: 'a.pdf', bytes: labelledPdf('A', 1) },
    { name: 'b.PDF', bytes: labelledPdf('B', 1) },
    { name: 'notes.txt', bytes: new TextEncoder().encode('not a pdf') },
  ]);
  await dialog.getByRole('button', { name: 'Watch Folder' }).click();
  await expect(dialog.getByText('Watching folder: watched')).toBeVisible();
  const list = dialog.getByRole('list').first();
  await expect(list.getByText('a.pdf', { exact: true })).toBeVisible();
  await expect(list.getByText('b.PDF', { exact: true })).toBeVisible();
  await expect(list.getByText('notes.txt')).toHaveCount(0);
  await expect(dialog.getByText(/^2\/\d+$/)).toBeVisible();
  await expect(page.getByText('2 PDF files queued from folder.')).toBeVisible();

  // A file that arrives later is queued by the next scan (every 4 s).
  await stageFolder(page, [{ name: 'c.pdf', bytes: labelledPdf('C', 1) }]);
  await expect(list.getByText('c.pdf', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/^3\/\d+$/)).toBeVisible();
  await expect(page.getByText('3 PDF files queued from folder.')).toBeVisible();

  await dialog.getByRole('button', { name: 'Stop Watching' }).click();
  await expect(dialog.getByText('Watching folder')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Watch Folder' })).toBeVisible();
});

test('a refused folder picker changes nothing', async ({ page }) => {
  const dialog = await openBatch(page);
  await page.evaluate(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
    });
  });
  await dialog.getByRole('button', { name: 'Watch Folder' }).click();
  await expect(dialog.getByText('Watching folder')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Watch Folder' })).toBeVisible();
  await expect(dialog.getByText(/^0\/\d+$/)).toBeVisible();
});

test('choosing files after loading a ruleset keeps the loaded ruleset', async ({ page }) => {
  const dialog = await openBatch(page);
  await dialog.locator('input[type="file"][accept*="json"]').setInputFiles({
    name: 'rules.batch.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'first two',
        steps: [{ kind: 'pages', params: { pages: [0, 1] } }],
      }),
    ),
  });
  await expect(dialog.getByText('Loaded ruleset contains 1 step(s)')).toBeVisible();
  await queue(dialog, [{ name: 'memo.pdf', bytes: labelledPdf('Memo', 4) }]);
  await expect(dialog.getByText('Loaded ruleset contains 1 step(s)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Run batch' }).click();
  await expect(dialog.getByText('1 completed, 0 failed, 0 skipped').first()).toBeVisible({
    timeout: 120_000,
  });
  const files = await downloads(page, 1, () =>
    dialog.getByRole('button', { name: 'Download finished files' }).click(),
  );
  const texts = await readProducedPageTexts([...files.values()][0] ?? new Uint8Array());
  expect(texts.map((text) => text.trim())).toEqual(['Memo 1', 'Memo 2']);
});
