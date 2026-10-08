import { readFileSync } from 'node:fs';
import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedPageTexts, readProducedPdf, toolFixturePdf } from './tool-fixture';
import {
  CANVAS,
  dragPage,
  encodePng,
  exportBytes,
  menuItem,
  openDockTab,
  openPdf,
  pageFrame,
  rail,
  runCommand,
  sheetPhotoPng,
  toClient,
} from './ui-helpers';
import { cmsBy, fromNow, signedDocument, signingPki } from './ui-panels9-helpers';
import {
  FLAT_FORM,
  pictureOnlyHtml,
  printedPdf,
  withHighlightContents,
  xfaWithoutNeedsRendering,
} from './ui-small-helpers';
import { openTagsView, taggedFixture } from './ui-tags-helpers';

test.use({ viewport: { width: 1440, height: 900 } });

/* ------------------------------------------------------------------ *
 * The signature warning: what saving does to a signed document
 * ------------------------------------------------------------------ */

const REVISION = 'A new version will be written after signing';
const BREAKS = 'Saving will invalidate existing signature';

async function signedBytes(): Promise<Uint8Array> {
  const { root, leaf } = await signingPki();
  return signedDocument(cmsBy(leaf, [root], fromNow(-100)));
}

/** A freehand stroke on the open page: an edit the save appends as a revision. */
async function scribble(page: Page): Promise<void> {
  await rail(page, 'Freehand drawing').click();
  await dragPage(page, [100, 400], [300, 450]);
}

/** Press Export and report whether a download follows within a short while. */
async function exportStarts(page: Page): Promise<boolean> {
  const download = page.waitForEvent('download', { timeout: 2_500 }).then(
    () => true,
    () => false,
  );
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  return download;
}

test('a save that appends a revision names the signer and Continue keeps the signed bytes intact', async ({
  page,
}) => {
  const signed = await signedBytes();
  await openPdf(page, 'signed.pdf', signed);
  await scribble(page);
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const warning = page.getByRole('dialog', { name: REVISION });
  await expect(warning).toContainText('Panel Signer (Sig1)');
  await expect(warning).toContainText('readers will show "modified after signing"');
  await expect(warning.getByRole('button', { name: 'Save anyway' })).toHaveCount(0);
  await warning.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(warning).toBeHidden();
  const path = test.info().outputPath('appended.pdf');
  await (await download).saveAs(path);
  const produced = new Uint8Array(readFileSync(path));
  // An incremental update: the signed file is the untouched prefix of the output.
  expect(produced.length).toBeGreaterThan(signed.length);
  expect(Buffer.from(produced.subarray(0, signed.length)).equals(Buffer.from(signed))).toBe(true);
  const read = await readProducedPdf(produced);
  expect(read.annotations.filter((mark) => mark.subtype === 'Ink')).toHaveLength(1);
});

test('Cancel and Escape on the revision warning export nothing; the next export asks again', async ({
  page,
}) => {
  await openPdf(page, 'signed.pdf', await signedBytes());
  await scribble(page);
  const warning = page.getByRole('dialog', { name: REVISION });

  expect(await exportStarts(page)).toBe(false);
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(warning).toBeHidden();

  expect(await exportStarts(page)).toBe(false);
  await expect(warning).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(warning).toBeHidden();

  // The refusals left the document as it was: the same export still works once accepted.
  const bytes = await (async () => {
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const path = test.info().outputPath('after-refusal.pdf');
    await (await download).saveAs(path);
    return new Uint8Array(readFileSync(path));
  })();
  expect((await readProducedPdf(bytes)).annotations.filter((mark) => mark.subtype === 'Ink')).toHaveLength(1);
});

test('Escape on the invalidation warning exports nothing', async ({ page }) => {
  await openPdf(page, 'signed.pdf', await signedBytes());
  await page.getByRole('button', { name: 'Rotate Page (90°)' }).click();
  expect(await exportStarts(page)).toBe(false);
  const warning = page.getByRole('dialog', { name: BREAKS });
  await expect(warning).toContainText('This save rewrites the entire file');
  await expect(warning.getByRole('button', { name: 'Save anyway' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(warning).toBeHidden();
});

/* ------------------------------------------------------------------ *
 * The start dialog, its two steps and its report
 * ------------------------------------------------------------------ */

test('the blank-document dialog marks its steps, reports a grown size, and Escape closes it', async ({
  page,
}) => {
  await page.goto('/editor/');
  await page.getByRole('button', { name: 'Blank document' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const steps = dialog.getByRole('listitem').filter({ hasText: /Settings|Result/ });
  await expect(steps).toHaveCount(2);
  await expect(steps.filter({ hasText: 'Settings' })).toHaveAttribute('aria-current', 'step');
  await expect(steps.filter({ hasText: 'Result' })).not.toHaveAttribute('aria-current', 'step');

  await dialog.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  const report = dialog.getByRole('region', { name: 'Operation report' });
  await expect(report).toBeVisible({ timeout: 60_000 });
  await expect(steps.filter({ hasText: 'Result' })).toHaveAttribute('aria-current', 'step');
  await expect(steps.filter({ hasText: 'Settings' })).not.toHaveAttribute('aria-current', 'step');
  await expect(report.getByText('1 page(s)', { exact: true })).toBeVisible();
  // A new file starts from nothing, so the size can only have grown.
  await expect(report.getByText(/^Size: 0 B → .+ \(increased\)$/)).toBeVisible();
  await expect(report.getByText('Fully rewritten (not incremental)')).toBeVisible();
  await expect(report.getByText(/^Executed steps: \S+/)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator(CANVAS)).toHaveCount(0);
});

/* ------------------------------------------------------------------ *
 * The export dialog
 * ------------------------------------------------------------------ */

const EXPORT_TITLE = 'Download / Export';

async function openExportDialog(page: Page) {
  await page.getByRole('button', { name: 'Export Options', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: EXPORT_TITLE });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the export dialog shows the file and its size, and its close button leaves without exporting', async ({
  page,
}) => {
  await openPdf(page, 'sized.pdf', toolFixturePdf());
  const dialog = await openExportDialog(page);
  await expect(dialog.getByRole('radio', { name: /^This PDF \(\d+\.\d KB\)/ })).toBeChecked();
  await expect(dialog.getByText('sized.pdf', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Download PDF' })).toBeVisible();
  for (const other of ['Compressed PDF', 'Image Format', 'Text Format', 'Word, Excel or CSV']) {
    await expect(dialog.getByRole('radio', { name: other })).not.toBeChecked();
  }
  // Only the chosen option's list is enabled.
  await expect(dialog.getByRole('combobox').first()).toBeDisabled();

  const download = page.waitForEvent('download', { timeout: 1_500 }).then(
    () => true,
    () => false,
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await download).toBe(false);
});

test('the text choice opens the Export Text form', async ({ page }) => {
  await openPdf(page, 'words.pdf', toolFixturePdf());
  const dialog = await openExportDialog(page);
  await dialog.getByRole('radio', { name: 'Text Format' }).check();
  await expect(dialog.getByRole('radio', { name: /^This PDF/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Download Text File' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('region', { name: 'Export Text' })).toBeVisible({ timeout: 30_000 });
});

test('the Word, Excel or CSV choice starts the office form on the format picked in the dialog', async ({
  page,
}) => {
  await openPdf(page, 'tables.pdf', toolFixturePdf());
  let dialog = await openExportDialog(page);
  await dialog.getByRole('radio', { name: 'Word, Excel or CSV' }).check();
  const format = dialog.getByRole('combobox', { name: 'Format' });
  await expect(format).toBeEnabled();
  await expect(format).toHaveValue('docx');
  // The Word layout is offered while Word is the format, flowing text first, and only then.
  const layout = dialog.getByRole('combobox', { name: 'Word layout' });
  await expect(layout).toHaveValue('flow');
  await format.click();
  await format.selectOption('xlsx');
  await expect(layout).toBeHidden();
  await dialog.getByRole('button', { name: 'Download as Word, Excel or CSV' }).click();
  const form = page.getByRole('region', { name: 'Export to Word, Excel or CSV' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(form.getByRole('radio', { name: /Excel \(XLSX\)/ })).toBeChecked();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toBeHidden();

  dialog = await openExportDialog(page);
  await dialog.getByRole('radio', { name: 'Word, Excel or CSV' }).check();
  await dialog.getByRole('combobox', { name: 'Format' }).selectOption('csv');
  await dialog.getByRole('button', { name: 'Download as Word, Excel or CSV' }).click();
  const csv = page.getByRole('region', { name: 'Export to Word, Excel or CSV' });
  await expect(csv.getByRole('radio', { name: /^CSV/ })).toBeChecked({ timeout: 30_000 });
});

test('the Word layout picked in the dialog is the one checked in the office form', async ({ page }) => {
  await openPdf(page, 'layout.pdf', toolFixturePdf());
  let dialog = await openExportDialog(page);
  await dialog.getByRole('radio', { name: 'Word, Excel or CSV' }).check();
  await dialog.getByRole('combobox', { name: 'Word layout' }).selectOption('page-images');
  await dialog.getByRole('button', { name: 'Download as Word, Excel or CSV' }).click();
  const form = page.getByRole('region', { name: 'Export to Word, Excel or CSV' });
  await expect(form.getByRole('radio', { name: /Word \(DOCX\)/ })).toBeChecked({ timeout: 30_000 });
  await expect(form.getByRole('radio', { name: /One picture per page/ })).toBeChecked();
  await expect(form.getByRole('radio', { name: /Flowing text/ })).not.toBeChecked();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toBeHidden();

  // The default is the flowing text.
  dialog = await openExportDialog(page);
  await dialog.getByRole('radio', { name: 'Word, Excel or CSV' }).check();
  await dialog.getByRole('button', { name: 'Download as Word, Excel or CSV' }).click();
  await expect(form.getByRole('radio', { name: /Flowing text/ })).toBeChecked({ timeout: 30_000 });
});

test('clicking the compression and image lists does not switch the chosen option', async ({ page }) => {
  await openPdf(page, 'lists.pdf', toolFixturePdf());
  const dialog = await openExportDialog(page);
  await dialog.getByRole('radio', { name: 'Compressed PDF' }).check();
  await dialog.getByRole('combobox').first().click();
  await expect(dialog.getByRole('radio', { name: 'Compressed PDF' })).toBeChecked();
  await dialog.getByRole('radio', { name: 'Image Format' }).check();
  await dialog.getByRole('combobox').nth(1).click();
  await expect(dialog.getByRole('radio', { name: 'Image Format' })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Download Images' })).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * Steps of a form that changes the document
 * ------------------------------------------------------------------ */

test('a replace-kind form names its second step "Review and apply" and reports the grown size', async ({
  page,
}) => {
  await openPdf(page, 'mark.pdf', toolFixturePdf());
  await runCommand(page, 'Watermark');
  const form = page.getByRole('region', { name: 'Watermark' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  const steps = form.getByRole('listitem').filter({ hasText: /Settings|Review and apply|Result/ });
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(1)).toContainText('Review and apply');
  await form.getByRole('textbox', { name: 'Text', exact: true }).fill('STEPS');
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  const report = form.getByRole('region', { name: 'Operation report' });
  await expect(report).toBeVisible({ timeout: 60_000 });
  await expect(steps.nth(1)).toHaveAttribute('aria-current', 'step');
  await expect(steps.nth(0)).not.toHaveAttribute('aria-current', 'step');
  await expect(report.getByText(/^Size: .+ → .+ \(increased\)$/)).toBeVisible();
  await expect(report.getByText('2 page(s)', { exact: true })).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * pdf.js's popup of a legacy annotation
 * ------------------------------------------------------------------ */

test('pdf.js shows only the comment of a legacy annotation whose /Contents starts with the marker', async ({
  page,
}) => {
  await openPdf(page, 'legacy.pdf', await withHighlightContents('pdf-editor-ann:legacy1\nLegacy words'));
  const trigger = page.locator('.annotationLayer .highlightAnnotation').first();
  await trigger.dispatchEvent('mouseenter');
  await trigger.dispatchEvent('click');
  const popup = page.locator('.annotationLayer .popup');
  await expect(popup).toHaveCount(1);
  await expect(popup).toHaveText('Legacy words');
  await expect(page.locator('.annotationLayer').first()).not.toContainText('pdf-editor-ann');
});

test('pdf.js shows the comment of an annotation without the marker as written', async ({ page }) => {
  await openPdf(page, 'plain.pdf', await withHighlightContents('A reader wrote this'));
  const trigger = page.locator('.annotationLayer .highlightAnnotation').first();
  await trigger.dispatchEvent('mouseenter');
  await trigger.dispatchEvent('click');
  await expect(page.locator('.annotationLayer .popup')).toHaveText('A reader wrote this');
});

/* ------------------------------------------------------------------ *
 * The status bar's signature badge and sensitive-session flag
 * ------------------------------------------------------------------ */

const statusBar = (page: Page) => page.getByRole('contentinfo');

test('a signature that no longer verifies is named as such in the status bar', async ({ page }) => {
  const { root, leaf } = await signingPki();
  // The CMS is made over bytes that are not the signed range, so its digest cannot match.
  const sign = cmsBy(leaf, [root], fromNow(-100));
  const bytes = await signedDocument((covered) => sign(covered.slice(1)));
  await openPdf(page, 'tampered.pdf', bytes);
  await expect(statusBar(page).getByText('Signature cannot be verified')).toBeVisible({ timeout: 30_000 });
  await expect(statusBar(page).getByText(/^Signatures: \d+$/)).toHaveCount(0);
});

test('revisions written after a signature are counted in the status bar', async ({ page }) => {
  const { root, leaf } = await signingPki();
  const bytes = await signedDocument(cmsBy(leaf, [root], fromNow(-100)), { revisions: 2 });
  await openPdf(page, 'revised.pdf', bytes);
  await expect(statusBar(page).getByText('2 modification(s) after signing')).toBeVisible({ timeout: 30_000 });
});

test('an intact signature shows its count, and a document with none shows no badge', async ({ page }) => {
  const { root, leaf } = await signingPki();
  await openPdf(page, 'intact.pdf', await signedDocument(cmsBy(leaf, [root], fromNow(-100))));
  await expect(statusBar(page).getByText('Signatures: 1')).toBeVisible({ timeout: 30_000 });
  await openPdf(page, 'plain.pdf', toolFixturePdf());
  await expect(statusBar(page).getByText('Signatures: 1')).toHaveCount(0);
  await expect(statusBar(page).getByText(/Signatures:|modification\(s\)|cannot be verified/)).toHaveCount(0);
});

test('the sensitive session says so in the status bar until it is switched off', async ({ page }) => {
  await openPdf(page, 'secret.pdf', toolFixturePdf());
  const flag = statusBar(page).getByText('Sensitive session: persistent draft disabled.');
  await expect(flag).toHaveCount(0);
  await runCommand(page, 'Sensitive Session');
  await expect(flag).toBeVisible();
  await runCommand(page, 'Sensitive Session');
  await expect(flag).toHaveCount(0);
});

/* ------------------------------------------------------------------ *
 * Flattening an XFA form that pdf.js does not lay out
 * ------------------------------------------------------------------ */

test('flatten refuses a form pdf.js does not render as XFA and says why, producing nothing', async ({
  page,
}) => {
  await openPdf(page, 'unrendered.pdf', xfaWithoutNeedsRendering());
  await menuItem(page, 'Tools', 'Flatten XFA form to a normal PDF…');
  const form = page.getByRole('region', { name: 'Flatten XFA form to a normal PDF' });
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(form).toContainText('This is a static XFA form: its pages are already in the PDF.', {
    timeout: 60_000,
  });
  await expect(form.getByRole('heading', { name: 'Operation report' })).toHaveCount(0);
  await expect(page).toHaveTitle(/unrendered\.pdf/);
});

/* ------------------------------------------------------------------ *
 * The corner editor: a cancelled drag and a resized stage
 * ------------------------------------------------------------------ */

test('a cancelled corner drag drops the magnifier, and the picture and handles follow a resized window', async ({
  page,
}) => {
  await openPdf(page);
  await menuItem(page, 'File', 'Scan with camera');
  const dialog = page.getByRole('dialog', { name: 'Scan with camera' });
  await dialog
    .getByTestId('scan-file-input')
    .setInputFiles({ name: 'sheet.png', mimeType: 'image/png', buffer: sheetPhotoPng() });
  await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toBeVisible();

  const picture = dialog.locator('img[draggable="false"]');
  const handle = dialog.getByRole('button', { name: 'Top-left corner' });
  const magnifier = dialog.locator('div[aria-hidden="true"][style*="background-image"]');
  const geometry = async () => {
    const image = await picture.boundingBox();
    const corner = await handle.boundingBox();
    if (image === null || corner === null) throw new Error('the crop picture is not on screen');
    return { image, corner };
  };

  // The picture keeps the photograph's 600 x 800 shape at any window size, and the handle
  // stays on the outline's corner (a fixed fraction of the picture).
  const before = await geometry();
  expect(before.image.width / before.image.height).toBeCloseTo(0.75, 1);
  const fraction = {
    x: (before.corner.x + before.corner.width / 2 - before.image.x) / before.image.width,
    y: (before.corner.y + before.corner.height / 2 - before.image.y) / before.image.height,
  };
  await page.setViewportSize({ width: 1000, height: 640 });
  await expect.poll(async () => (await geometry()).image.height).toBeLessThan(before.image.height);
  const after = await geometry();
  expect(after.image.width / after.image.height).toBeCloseTo(0.75, 1);
  expect((after.corner.x + after.corner.width / 2 - after.image.x) / after.image.width).toBeCloseTo(
    fraction.x,
    2,
  );
  expect((after.corner.y + after.corner.height / 2 - after.image.y) / after.image.height).toBeCloseTo(
    fraction.y,
    2,
  );

  // A press shows the magnifier; the browser cancelling the pointer ends the drag.
  await expect(magnifier).toHaveCount(0);
  await page.mouse.move(after.corner.x + after.corner.width / 2, after.corner.y + after.corner.height / 2);
  await page.mouse.down();
  await expect(magnifier).toHaveCount(1);
  await handle.dispatchEvent('pointercancel');
  await expect(magnifier).toHaveCount(0);
  await page.mouse.up();
});

/* ------------------------------------------------------------------ *
 * The reading-order boxes on a turned page
 * ------------------------------------------------------------------ */

test('the numbered box of the heading follows the page through every quarter turn', async ({ page }) => {
  await openPdf(page, 'turned.pdf', await taggedFixture());
  await openTagsView(page);
  const heading = page.locator('[data-order-box][data-order-page="0"]').first();
  await expect(heading).toHaveAccessibleName('1: H1');
  const pageCanvas = page.locator(CANVAS).first();

  /** The heading box's centre as a fraction of the page's painted box. */
  const where = async () => {
    const [box, sheet] = await Promise.all([heading.boundingBox(), pageCanvas.boundingBox()]);
    // Mid-turn the page is repainted and the box is briefly gone.
    if (box === null || sheet === null) return { x: Number.NaN, y: Number.NaN };
    return {
      x: (box.x + box.width / 2 - sheet.x) / sheet.width,
      y: (box.y + box.height / 2 - sheet.y) / sheet.height,
    };
  };

  // Upright, the heading is at the top left of the page.
  let at = await where();
  expect(at.x).toBeLessThan(0.5);
  expect(at.y).toBeLessThan(0.5);
  const corners = [
    { name: 'a quarter turn', right: true, bottom: false },
    { name: 'a half turn', right: true, bottom: true },
    { name: 'three quarter turns', right: false, bottom: true },
  ] as const;
  for (const corner of corners) {
    await page.getByRole('button', { name: 'Rotate Page (90°)' }).click();
    await expect
      .poll(async () => {
        at = await where();
        return [at.x > 0.5, at.y > 0.5];
      }, corner.name)
      .toEqual([corner.right, corner.bottom]);
  }
});

/* ------------------------------------------------------------------ *
 * Form-field detection: the frames on the page and the review list
 * ------------------------------------------------------------------ */

async function detectFields(page: Page, name: string, html: string) {
  await openPdf(page, name, await printedPdf(page, html));
  await page.getByRole('tab', { name: 'Form fields', exact: true }).click();
  await page.getByRole('button', { name: 'Detect fields', exact: true }).click();
  return page.locator('[data-form-detect-summary]');
}

test('the review of detected fields: select from the page or the list, remove with the keys, restore, cancel', async ({
  page,
}) => {
  const summary = await detectFields(page, 'flat-form.pdf', FLAT_FORM);
  await expect(summary).toHaveText('6 fields found: 6 labelled, 0 guessed.', { timeout: 60_000 });
  const frames = page.locator('[data-field-candidate]');
  const rows = page.getByRole('list', { name: 'Detected fields' }).getByRole('listitem');
  await expect(frames).toHaveCount(6);
  await expect(rows).toHaveCount(6);
  // Each row names the field, how sure the detection is, its kind and page.
  await expect(rows.filter({ hasText: 'Full name' })).toContainText('Labelled');
  await expect(rows.filter({ hasText: 'Full name' })).toContainText('Text · 1');
  await expect(rows.filter({ hasText: 'I agree' })).toContainText('Checkbox · 1');

  // A click on a frame selects it, and its row says so; a click on a row moves the selection.
  const frameOf = (name: string) => page.locator(`[data-field-candidate][data-name="${name}"]`);
  await frameOf('City').click();
  await expect(frameOf('City')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.filter({ hasText: 'City' }).getByRole('button').first()).toHaveAttribute(
    'aria-current',
    'true',
  );
  await rows.filter({ hasText: 'Phone number' }).getByRole('button').first().click();
  await expect(frameOf('Phone number')).toHaveAttribute('aria-pressed', 'true');
  await expect(frameOf('City')).toHaveAttribute('aria-pressed', 'false');

  // Delete and Backspace on a focused frame take the candidate out; so does a row's ✕.
  await frameOf('Street address').focus();
  await page.keyboard.press('Delete');
  await expect(frames).toHaveCount(5);
  await frameOf('Full name').focus();
  await page.keyboard.press('Backspace');
  await expect(frames).toHaveCount(4);
  await rows.filter({ hasText: 'City' }).getByRole('button', { name: 'Remove the field City' }).click();
  await expect(summary).toHaveText('3 fields found: 3 labelled, 0 guessed.');
  await frameOf('Phone number').focus();
  await page.keyboard.press('a');
  await expect(frames).toHaveCount(3);

  // Nothing removed is lost: restoring brings all six back.
  await page.getByRole('button', { name: 'Bring removed fields back' }).click();
  await expect(summary).toHaveText('6 fields found: 6 labelled, 0 guessed.');
  await expect(page.getByRole('button', { name: 'Bring removed fields back' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add 6 fields', exact: true })).toBeVisible();

  // With every candidate removed the add button says there is nothing left, and is off.
  for (const name of ['Full name', 'Street address', 'City', 'Phone number', 'I agree', 'I decline']) {
    await page
      .getByRole('button', { name: `Remove the field ${name}` })
      .first()
      .click();
  }
  await expect(summary).toHaveText('0 fields found: 0 labelled, 0 guessed.');
  await expect(page.getByRole('button', { name: 'No fields left to add.' })).toBeDisabled();

  // Detect again starts a fresh review; Cancel leaves the review without adding anything.
  await page.getByRole('button', { name: 'Detect again' }).click();
  await expect(summary).toHaveText('6 fields found: 6 labelled, 0 guessed.', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(frames).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Detect fields', exact: true })).toBeVisible();
  await expect(page.locator('[data-field-row]')).toHaveCount(0);
});

test('a page that is only a picture is reported as needing OCR, and no field is invented', async ({
  page,
}) => {
  const summary = await detectFields(page, 'picture.pdf', pictureOnlyHtml(sheetPhotoPng()));
  await expect(summary).toHaveText('No place to fill in was found in this document.', { timeout: 60_000 });
  await expect(
    page.getByRole('note').filter({ hasText: '1 page(s) are only a picture with no text' }),
  ).toBeVisible();
  await expect(page.locator('[data-field-candidate]')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Detected fields' })).toHaveCount(0);
});

test('a scan that carries text is reported as read from pixels, its fields are guesses', async ({ page }) => {
  const summary = await detectFields(
    page,
    'recognised.pdf',
    pictureOnlyHtml(sheetPhotoPng(), 'Full name: ____________________'),
  );
  await expect(summary).toContainText('fields found', { timeout: 60_000 });
  await expect(
    page.getByRole('note').filter({ hasText: '1 page(s) are scans: only horizontal lines were read' }),
  ).toBeVisible();
  await expect(page.getByRole('note').filter({ hasText: 'only a picture with no text' })).toHaveCount(0);
});

/* ------------------------------------------------------------------ *
 * Placing a picture: its size, the ghost under the pointer, the page edges
 * ------------------------------------------------------------------ */

const flatPicture = (width: number, height: number) => ({
  name: 'picture.png',
  mimeType: 'image/png',
  buffer: encodePng(width, height, () => [200, 30, 30]),
});

/** Arm the placement of a picture file the way the image picker does. */
async function armImage(page: Page, width: number, height: number): Promise<void> {
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles(flatPicture(width, height));
  await expect(page.locator('[data-stamp-placement]')).toBeAttached();
}

/** The stamps of the exported file, in page points. */
async function placedStamps(page: Page, name: string) {
  const produced = await readProducedPdf(await exportBytes(page, name));
  return produced.annotations
    .filter((annotation) => annotation.subtype === 'Stamp')
    .map((annotation) => {
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = annotation.rect;
      return { width: x1 - x0, height: y1 - y0, centerX: (x0 + x1) / 2, centerY: (y0 + y1) / 2 };
    });
}

test('an image is placed at 96 dpi, shrunk to 60 % of the page when larger, and kept inside the page', async ({
  page,
}) => {
  await openPdf(page);
  const frame = await pageFrame(page);

  // 400 x 200 px is 300 x 150 pt; clicked mid-page it is centred on the click.
  await armImage(page, 400, 200);
  const middle = toClient(frame, 300, 400);
  await page.mouse.move(middle.x, middle.y, { steps: 4 });
  const ghost = page.locator('[data-stamp-ghost]');
  await expect(ghost).toBeVisible();
  const shown = await ghost.boundingBox();
  expect(shown?.width).toBeCloseTo(300 * frame.scale, 0);
  expect(shown?.height).toBeCloseTo(150 * frame.scale, 0);
  // Over the tools rail the pointer is off the pages: the ghost goes.
  await page.mouse.move(5, 300, { steps: 4 });
  await expect(ghost).toHaveCount(0);
  // A right-button press is not a placement.
  await page.mouse.click(middle.x, middle.y, { button: 'right' });
  await expect(page.locator('[data-stamp-placement]')).toBeAttached();
  await page.mouse.click(middle.x, middle.y);
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);

  // 2000 x 1000 px would be 1500 x 750 pt: it is shrunk, aspect kept, to 60 % of the page width.
  await armImage(page, 2000, 1000);
  const corner = toClient(frame, 4, 838);
  await page.mouse.move(corner.x, corner.y, { steps: 4 });
  await page.mouse.click(corner.x, corner.y);
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);

  const [normal, big, ...rest] = await placedStamps(page, 'images.pdf');
  expect(rest).toEqual([]);
  expect(normal?.width).toBeCloseTo(300, 0);
  expect(normal?.height).toBeCloseTo(150, 0);
  expect(normal?.centerX).toBeCloseTo(300, 0);
  expect(normal?.centerY).toBeCloseTo(400, 0);
  expect(big?.width).toBeCloseTo(595 * 0.6, 0);
  expect(big?.height).toBeCloseTo(595 * 0.3, 0);
  // The click was in the page's top-left corner: the picture is pushed inside the page.
  expect(big?.centerX).toBeCloseTo((595 * 0.6) / 2, 0);
  expect(big?.centerY).toBeCloseTo(842 - (595 * 0.3) / 2, 0);
});

test('on a page turned a quarter the picture keeps the size it shows on screen', async ({ page }) => {
  await openPdf(page);
  await page.getByRole('button', { name: 'Rotate Page (90°)' }).click();
  await expect
    .poll(async () => {
      const box = await page.locator(CANVAS).first().boundingBox();
      return box !== null && box.width > box.height;
    })
    .toBe(true);
  await armImage(page, 400, 200);
  const sheet = await page.locator(CANVAS).first().boundingBox();
  if (sheet === null) throw new Error('the turned page is not on screen');
  const middle = { x: sheet.x + sheet.width / 2, y: sheet.y + sheet.height / 2 };
  await page.mouse.move(middle.x, middle.y, { steps: 4 });
  const shown = await page.locator('[data-stamp-ghost]').boundingBox();
  // On screen it is wider than tall, as the picture is.
  expect(shown?.width).toBeCloseTo((shown?.height ?? 0) * 2, 0);
  await page.mouse.click(middle.x, middle.y);
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);
  const [stamp] = await placedStamps(page, 'turned.pdf');
  // In the file's own (unturned) space the stamp's extents are swapped.
  expect(stamp?.width).toBeCloseTo(150, 0);
  expect(stamp?.height).toBeCloseTo(300, 0);
  expect(stamp?.centerX).toBeCloseTo(297.5, 0);
  expect(stamp?.centerY).toBeCloseTo(421, 0);
});

/* ------------------------------------------------------------------ *
 * The tool settings strip
 * ------------------------------------------------------------------ */

const settingsStrip = (page: Page) => page.getByRole('group', { name: 'Tool settings' });

test('Add Text settings: the size is kept between 6 and 72 pt, an empty field keeps the last size, colour and author are taken', async ({
  page,
}) => {
  await openPdf(page);
  await rail(page, 'Add Text').click();
  const strip = settingsStrip(page);
  const size = strip.getByRole('spinbutton', { name: 'Size' });
  await size.fill('500');
  await expect(size).toHaveValue('72');
  await size.fill('2');
  await expect(size).toHaveValue('6');
  await size.fill('18.4');
  await expect(size).toHaveValue('18');
  // A half-typed (empty) field is not a size: the last valid one stays.
  await size.fill('');
  await size.blur();
  await expect(size).toHaveValue('18');

  const colour = strip.getByLabel('Color');
  await colour.fill('#0000ff');
  await expect(colour).toHaveValue('#0000ff');
  const author = strip.getByRole('textbox', { name: 'Author' });
  await author.fill('Ada Lovelace');
  await expect(author).toHaveValue('Ada Lovelace');
});

test('shape settings: thickness stays between 1 and 20, opacity is read out, and the chosen kind is what is drawn', async ({
  page,
}) => {
  await openPdf(page);
  await rail(page, 'Draw Shape (Rectangle)').click();
  const strip = settingsStrip(page);
  const thickness = strip.getByRole('spinbutton', { name: 'Thickness' });
  await thickness.fill('99');
  await expect(thickness).toHaveValue('20');
  await thickness.fill('0');
  await expect(thickness).toHaveValue('1');
  await thickness.fill('7');
  await thickness.fill('');
  await thickness.blur();
  await expect(thickness).toHaveValue('7');

  const opacity = strip.getByRole('slider', { name: 'Opacity' });
  await opacity.fill('0.5');
  await expect(strip.getByText('50%')).toBeVisible();
  await strip.getByRole('combobox', { name: 'Shape' }).selectOption('circle');
  await expect(strip.getByRole('combobox', { name: 'Shape' })).toHaveValue('circle');

  await dragPage(page, [100, 400], [300, 500]);
  const produced = await readProducedPdf(await exportBytes(page, 'circle.pdf'));
  const circles = produced.annotations.filter((mark) => mark.subtype === 'Circle');
  expect(circles).toHaveLength(1);
});

test('redaction settings count the marked areas and Apply redaction removes the covered text from the file', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Redaction');
  await page.getByRole('button', { name: 'Open redaction tool', exact: true }).click();
  const strip = settingsStrip(page);
  await expect(strip.getByText('0 area(s) marked')).toBeVisible();
  const apply = strip.getByRole('button', { name: 'Apply redaction' });
  await expect(apply).toBeDisabled();
  // Over the fourth text line of the fixture.
  await dragPage(page, [72, 594], [320, 574]);
  // The gesture leaves the tool; arming it again shows what is pending.
  await expect(page.locator('[data-mark-family="redaction"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open redaction tool', exact: true }).click();
  await expect(strip.getByText('1 area(s) marked')).toBeVisible();
  await expect(apply).toBeEnabled();
  await apply.click();
  // Apply opens the redaction form over the pending marks; its two steps remove the text.
  const form = page.getByRole('region', { name: /Redact/ });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'This operation may permanently delete content. Continue?',
  );
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
  const texts = await readProducedPageTexts(await exportBytes(page, 'redacted.pdf'));
  expect(texts[0]).toContain('Third line stays untouched');
  expect(texts[0]).not.toContain('Fourth line for redaction marks');
});
