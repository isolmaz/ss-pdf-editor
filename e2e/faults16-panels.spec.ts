/**
 * The panels and tool layers that read the document through an engine, answering for an
 * engine that fails where the file is sound: the text-edit overlay (MuPDF), the layers tab
 * (pdf.js). What is asserted is what the user reads on screen and that the rest of the
 * interface still works.
 */

import { notice } from './app-helpers';
import { failNext, firedCount, injectEngineFaults } from './engine-faults';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { openDockTab, openPdf } from './ui-helpers';
import { layerTreePdf } from './ui-panels15-helpers';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 120_000 });

test('Edit Text on a page MuPDF cannot read says so on the page and offers no box; Escape leaves the tool and the tool works again afterwards', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'edit.pdf', labelledPdf('Original', 1));
  await failNext(page, 'mupdf', 'PDFDocument.loadPage', 'page tree unreadable');
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();

  const failure = page.locator('[data-text-layer-error]');
  await expect(failure).toHaveText('Could not extract text for this page; editing disabled.');
  expect(await firedCount(page, 'mupdf', 'PDFDocument.loadPage')).toBe(1);
  // The diagnostic attribute carries the engine's own words, the page only the dictionary's.
  await expect(failure).toHaveAttribute('data-text-layer-error', 'internal');
  await expect(failure).toHaveAttribute('data-text-layer-reason', /page tree unreadable/);
  await expect(page.locator('[data-text-block]')).toHaveCount(0);

  // The tool is left with Escape, and entered again, the page reads and its paragraph is offered.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-text-layer]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await expect(page.locator('[data-text-block][data-block-text="Original 1"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator('[data-text-layer-error]')).toHaveCount(0);
});

test.describe('a failed first request for the layer configuration', () => {
  // The viewer's own paint is the first asker, and logs its failed render.
  test.use({ allowedErrors: [/renderView/] });

  test('a layers tab whose configuration pdf.js cannot read says so in the tab and on the notice line, and the other tabs still answer', async ({
    page,
  }) => {
    await injectEngineFaults(page);
    await page.goto('/editor/');
    // The first request for the layer configuration is the viewer's own: it fails the paint too.
    await failNext(page, 'pdfjs', 'GetOptionalContentConfig', 'ocg broke');
    await openPdf(page, 'layers.pdf', layerTreePdf(), { navigate: false });
    await openDockTab(page, 'Layers');
    expect(await firedCount(page, 'pdfjs', 'GetOptionalContentConfig')).toBe(1);
    await expect(page.getByRole('group', { name: 'Layers' })).toHaveCount(0);
    await expect(page.getByText('Something unexpected went wrong.').first()).toBeVisible();
    await expect(notice(page, 'Something unexpected went wrong.')).toBeVisible();

    await openDockTab(page, 'Attachments');
    await expect(page.getByText('This document has no attachments.')).toBeVisible();
  });
});
