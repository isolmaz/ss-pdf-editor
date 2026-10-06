import { readFileSync } from 'node:fs';
import type { Page } from 'playwright/test';
import { expect, test } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { encryptedToolFixturePdf, readProducedPdf, toolFixturePdf } from './tool-fixture';

/**
 * The document stays where the reader put it (2026-09-28 audit).
 *
 * Each case is a defect that was measured in the built application before it was fixed:
 *
 *  - a mark drawn on the page stayed where it was on screen while the page scrolled away
 *    under it (the overlays lived outside the scroll container);
 *  - arming a tool moved the whole document by up to 24 px, and every operation's notice
 *    and progress row pushed it down again (they were rows in the page's flow);
 *  - the status-bar rotate did nothing without a page-panel selection, and said so in a
 *    sentence with a raw `{count}` in it;
 *  - there was no way to type text onto a page, and a protected PDF could not be opened
 *    at all (the shell never supplied a password).
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('.pdfViewer[data-active-viewer] .page canvas').first()).toBeVisible({
    timeout: 30_000,
  });
  // The overlays are revealed with the first painted page; until then nothing is placed.
  await expect(page.locator('[data-viewer-overlay]')).not.toHaveAttribute('style', /hidden/);
}

/** The tool rail, by the button every document offers. */
function rail(page: Page) {
  return page
    .locator('nav')
    .filter({ has: page.getByRole('button', { name: 'Selection Tool', exact: true }) });
}

/** The scroll container's top edge in the viewport, and its scroll offset. */
function viewerBox(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.pdfViewer[data-active-viewer]')?.parentElement;
    if (scroller === null || scroller === undefined) throw new Error('no viewer');
    return { top: scroller.getBoundingClientRect().top, scrollTop: scroller.scrollTop };
  });
}

/** Where a mark's first visual sits relative to its page, in CSS pixels. */
function markOffset(page: Page) {
  return page.evaluate(() => {
    const mark = document.querySelector('[data-ann] > *');
    const sheet = document.querySelector('.pdfViewer[data-active-viewer] .page');
    if (mark === null || sheet === null) return null;
    const a = mark.getBoundingClientRect();
    const b = sheet.getBoundingClientRect();
    return { dx: Math.round(a.x - b.x), dy: Math.round(a.y - b.y) };
  });
}

test('a mark moves with its page when the document scrolls', async ({ page }) => {
  await open(page, 'scroll.pdf', toolFixturePdf());
  await rail(page).getByRole('button', { name: 'Draw Shape (Rectangle)', exact: true }).click();
  const sheet = await page.locator('.pdfViewer[data-active-viewer] .page').first().boundingBox();
  if (sheet === null) throw new Error('no page box');
  await page.mouse.move(sheet.x + 200, sheet.y + 300);
  await page.mouse.down();
  await page.mouse.move(sheet.x + 320, sheet.y + 380, { steps: 8 });
  await page.mouse.up();
  const before = await markOffset(page);
  expect(before).not.toBeNull();

  await page.mouse.move(sheet.x + 400, sheet.y + 400);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await viewerBox(page)).scrollTop).toBeGreaterThan(100);
  expect(await markOffset(page)).toEqual(before);
});

test('arming any tool and posting a notice leave the document where it is', async ({ page }) => {
  await open(page, 'still.pdf', toolFixturePdf());
  const start = await viewerBox(page);
  const labels = await rail(page)
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''));
  expect(labels.length).toBeGreaterThanOrEqual(11);
  for (const label of labels) {
    await rail(page).getByRole('button', { name: label, exact: true }).click();
    expect((await viewerBox(page)).top).toBe(start.top);
  }
  await page.keyboard.press('Escape');
  await rail(page).getByRole('button', { name: 'Selection Tool', exact: true }).click();

  // A page operation raises progress and a notice: both float, neither moves the page.
  await page.getByRole('button', { name: /Rotate page/i }).click();
  await expect(page.locator('[role="status"]').filter({ hasText: 'rotated' })).toBeVisible();
  expect((await viewerBox(page)).top).toBe(start.top);
});

test('the status-bar rotate turns the page on screen when no page is selected', async ({ page }) => {
  await open(page, 'rotate.pdf', toolFixturePdf());
  const sheet = page.locator('.pdfViewer[data-active-viewer] .page').first();
  const portrait = await sheet.boundingBox();
  if (portrait === null) throw new Error('no page box');
  expect(portrait.height).toBeGreaterThan(portrait.width);

  await page.getByRole('button', { name: /Rotate page/i }).click();
  await expect(page.locator('[role="status"]').filter({ hasText: '1 page(s) rotated' })).toBeVisible();
  await expect
    .poll(async () => {
      const box = await page.locator('.pdfViewer[data-active-viewer] .page').first().boundingBox();
      return box === null ? 0 : box.width - box.height;
    })
    .toBeGreaterThan(0);
  await expect(page.getByText('{count}')).toHaveCount(0);
});

test('typed text reaches the file as a /FreeText with the words the user typed', async ({ page }) => {
  await open(page, 'typed.pdf', toolFixturePdf());
  await rail(page).getByRole('button', { name: 'Add Text', exact: true }).click();
  const sheet = await page.locator('.pdfViewer[data-active-viewer] .page').first().boundingBox();
  if (sheet === null) throw new Error('no page box');
  await page.mouse.click(sheet.x + 150, sheet.y + 520);
  const field = page.getByRole('textbox', { name: 'Text to add to the page' });
  await expect(field).toBeFocused();
  await page.keyboard.type('Şişli’de ığdır — İĞÜŞÖÇ');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('[data-ann]').filter({ hasText: 'Şişli’de ığdır — İĞÜŞÖÇ' })).toBeVisible();

  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  const path = test.info().outputPath('typed-out.pdf');
  await file.saveAs(path);
  const produced = await readProducedPdf(new Uint8Array(readFileSync(path)));
  const typed = produced.annotations.filter((annotation) => annotation.subtype === 'FreeText');
  expect(typed.some((annotation) => annotation.contents.includes('Şişli’de ığdır — İĞÜŞÖÇ'))).toBe(true);
});

test('a protected PDF asks for its password, refuses a wrong one and opens read-only', async ({ page }) => {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({
      name: 'locked.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await encryptedToolFixturePdf('parola')),
    });
  const prompt = page.getByRole('dialog', { name: /locked\.pdf/ });
  await expect(prompt).toBeVisible({ timeout: 30_000 });

  await prompt.getByLabel('Document open password').fill('yanlis');
  await prompt.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /locked\.pdf/ }).getByRole('alert')).toBeVisible();

  const retry = page.getByRole('dialog', { name: /locked\.pdf/ });
  await retry.getByLabel('Document open password').fill('parola');
  await retry.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.pdfViewer[data-active-viewer] .page canvas').first()).toBeVisible({
    timeout: 30_000,
  });
  // Read-only until the user makes an unlocked copy: the writing tools are off and the
  // strip offers the copy.
  await expect(rail(page).getByRole('button', { name: 'Add Text', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Create unlocked copy' })).toBeVisible();
});

test('an operation applied from the tools panel reaches the document', async ({ page }) => {
  // The panel's runner used to go "back" right after handing over its result, and going
  // back cancels the operation in flight — the apply that had just started. Every result
  // applied from the panel was dropped; the notice said nothing and the page stayed as it was.
  await open(page, 'watermark.pdf', toolFixturePdf());
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Watermark');
  await page.keyboard.press('Enter');
  const form = page.getByRole('region', { name: 'Watermark' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('textbox', { name: 'Text', exact: true }).fill('PANEL APPLY');
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector('.pdfViewer[data-active-viewer] .textLayer')?.textContent ?? '',
      ),
    )
    .toContain('PANEL APPLY');
});

test('document properties written in the browser reach the exported file', async ({ page }) => {
  // Properties are written by MuPDF, which the editor loads from its runtime URL and
  // only a served build has; the unit suite cannot reach that path.
  await open(page, 'properties.pdf', toolFixturePdf());
  await useAdvancedMode(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Document properties');
  await page.keyboard.press('Enter');
  const form = page.getByRole('region', { name: 'Document properties' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByRole('textbox', { name: 'Title', exact: true }).fill('Şişli Şubesi — Yıllık Rapor');
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });

  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  const path = test.info().outputPath('properties-out.pdf');
  await file.saveAs(path);
  const produced = await readProducedPdf(new Uint8Array(readFileSync(path)));
  expect(produced.title).toBe('Şişli Şubesi — Yıllık Rapor');
  expect(produced.producer).toBe('SsPdfEditor (MuPDF 1.28)');
});

test('an attachment added and removed in the panel is in, then out of, the exported file', async ({
  page,
}) => {
  // Attachments are written by MuPDF in the browser; the file is the evidence.
  await open(page, 'attach.pdf', toolFixturePdf());
  const tab = page.getByRole('tab', { name: 'Document information' });
  if (!(await tab.isVisible())) await page.getByRole('button', { name: 'ALL TOOLS', exact: true }).click();
  await page.getByRole('tab', { name: 'Document information' }).click();
  const section = page.getByRole('region', { name: 'Attachments' });
  await section.locator('input[type="file"]').setInputFiles({
    name: 'şube-özeti.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ığdır ÇÖŞ'),
  });
  const remove = page.getByRole('button', { name: 'Remove attachment şube-özeti.txt' });
  await expect(remove).toBeVisible({ timeout: 60_000 });

  const exported = async (name: string) => {
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const path = test.info().outputPath(name);
    await (await download).saveAs(path);
    return readProducedPdf(new Uint8Array(readFileSync(path)));
  };
  expect((await exported('attached.pdf')).attachmentNames).toEqual(['şube-özeti.txt']);

  await remove.click();
  await expect(remove).toBeHidden({ timeout: 60_000 });
  expect((await exported('detached.pdf')).attachmentNames).toEqual([]);
});

test('bookmarks added and deleted in the outline form reach the exported file', async ({ page }) => {
  // Deleting a bookmark failed its own read-back before the MuPDF writer (the removed item
  // stayed in the recount), so every delete from this form was refused.
  await open(page, 'outline.pdf', toolFixturePdf());
  await useAdvancedMode(page);
  const form = page.getByRole('region', { name: 'Edit outline (bookmarks)' });
  const run = async (fill: () => Promise<void>) => {
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('Edit outline (bookmarks)');
    await page.keyboard.press('Enter');
    await expect(form).toBeVisible({ timeout: 30_000 });
    await fill();
    await form.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
    await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 30_000 });
  };
  await run(() => form.getByRole('textbox', { name: 'Title', exact: true }).fill('Birinci bölüm'));
  await run(() => form.getByRole('textbox', { name: 'Title', exact: true }).fill('İkinci — Şişli'));
  await run(async () => {
    await form.getByRole('combobox', { name: 'Action' }).click();
    await page.getByRole('option', { name: 'Delete', exact: true }).click();
    await form.getByRole('textbox', { name: 'Item path' }).fill('1');
  });

  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = test.info().outputPath('outline-out.pdf');
  await (await download).saveAs(path);
  expect((await readProducedPdf(new Uint8Array(readFileSync(path)))).outlineTitles).toEqual([
    'İkinci — Şişli',
  ]);
});

test('a command chosen in the palette with Enter runs exactly once', async ({ page }) => {
  // Enter reached both the palette input's handler and the list's item activation, so a
  // keyboard-chosen command ran twice: a tool toggle armed and disarmed itself, and an
  // operation's second run was refused with "another operation is running".
  await open(page, 'palette.pdf', toolFixturePdf());
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Freehand drawing');
  await page.keyboard.press('Enter');
  await expect(rail(page).getByRole('button', { name: 'Freehand drawing', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.locator('[role="status"]').filter({ hasText: 'Another operation is running' }),
  ).toHaveCount(0);
});
