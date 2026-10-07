/**
 * Scan with the camera: the camera screen (a fake Chromium camera, a refused permission,
 * photographs picked from files), the crop screen with its draggable corners, the page
 * list (reorder, turn, filter, retake, delete) and the PDF each door produces. The
 * produced document is read back by its page count and page size.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedEntry, readProducedPdf } from './tool-fixture';
import { encodePng, exportBytes, menuItem, openPdf, sheetPhotoPng } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Scan with camera' });

async function openScan(page: Page) {
  await menuItem(page, 'File', 'Scan with camera');
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

const sheet = (name: string) => ({ name, mimeType: 'image/png', buffer: sheetPhotoPng() });

/** The polygon of the corner editor, as numbers: the outline the user sees. */
async function outline(page: Page): Promise<number[]> {
  return page
    .locator('dialog, [role="dialog"]')
    .locator('svg polygon')
    .first()
    .evaluate((polygon) =>
      (polygon.getAttribute('points') ?? '')
        .split(/[ ,]/)
        .filter((part) => part !== '')
        .map(Number),
    );
}

test.describe('without a camera permission', () => {
  test('the refusal is named, photos are chosen from files, the corners are corrected and the pages become a PDF', async ({
    page,
  }) => {
    await openPdf(page);
    const dialog = await openScan(page);
    await expect(dialog.getByText('Camera permission was not granted.')).toBeVisible();
    const shutter = dialog.getByRole('button', { name: 'Take photo' });
    await expect(shutter).toBeDisabled();
    // Try again asks again and is refused again.
    await dialog.getByRole('button', { name: 'Try again' }).click();
    await expect(dialog.getByText('Camera permission was not granted.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Pages \(0\)$/ })).toBeDisabled();

    // Three photographs at once: a sheet, a file that is no picture, a sheet.
    await dialog
      .getByTestId('scan-file-input')
      .setInputFiles([
        sheet('one.png'),
        { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('no') },
        sheet('three.png'),
      ]);
    await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toBeVisible();
    await expect(dialog.getByText('Photo 1 of 3')).toBeVisible();
    await expect(dialog.getByText(/The page edges were found/)).toBeVisible();
    const found = await outline(page);
    expect(found).toHaveLength(8);
    // The detector put the corners near the sheet's corners (15 %/10 % …).
    expect(found[0]).toBeGreaterThan(8);
    expect(found[0]).toBeLessThan(22);
    expect(found[1]).toBeGreaterThan(4);
    expect(found[1]).toBeLessThan(18);

    // The keyboard moves a corner by 0.25 %, Shift by 2 %.
    const topLeft = dialog.getByRole('button', { name: 'Top-left corner' });
    await topLeft.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    let moved = await outline(page);
    expect(moved[0]).toBeCloseTo((found[0] as number) + 0.25, 1);
    expect(moved[1]).toBeCloseTo((found[1] as number) + 0.25, 1);
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    moved = await outline(page);
    expect(moved[0]).toBeCloseTo((found[0] as number) - 2, 1);
    expect(moved[1]).toBeCloseTo((found[1] as number) - 2, 1);

    // A drag moves another corner; a corner dragged across its neighbour folds the outline
    // and the page cannot be added until it is straightened out again.
    const bottomRight = dialog.getByRole('button', { name: 'Bottom-right corner' });
    const box = await bottomRight.boundingBox();
    if (box === null) throw new Error('corner handle missing');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 - 40, { steps: 5 });
    const dragged = await outline(page);
    expect(dragged[4]).toBeLessThan((found[4] as number) - 1);
    await page.mouse.up();

    // The whole photo, then the edges again.
    await dialog.getByRole('button', { name: 'Whole photo' }).click();
    expect(await outline(page)).toEqual([0, 0, 100, 0, 100, 100, 0, 100]);
    await dialog.getByRole('button', { name: 'Find the edges again' }).click();
    expect((await outline(page))[0]).toBeGreaterThan(8);

    // Skip leaves this photo out; the broken one is skipped on its own, and the last sheet is shown.
    await dialog.getByRole('button', { name: 'Skip this photo' }).click();
    await expect(dialog.getByText('This photo could not be opened: broken.png')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Add page' }).click();

    // One page in the list.
    const list = dialog.getByRole('list', { name: 'Scanned pages' });
    await expect(list.getByRole('button', { name: 'Select page 1' })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Select page 2' })).toHaveCount(0);
    await expect(dialog.getByRole('img', { name: 'Page 1' }).first()).toBeVisible();

    // Look: one page, then all.
    const original = dialog.getByRole('button', { name: 'Original colour' });
    await original.click();
    await expect(original).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Black and white' }).click();
    await expect(dialog.getByRole('button', { name: 'Black and white' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dialog.getByRole('checkbox', { name: 'Apply to all pages' }).uncheck();
    await dialog.getByRole('button', { name: 'Grayscale' }).click();
    await expect(dialog.getByRole('button', { name: 'Grayscale' })).toHaveAttribute('aria-pressed', 'true');

    // A second page from the add button, a third, and the order is changed.
    await dialog.getByRole('button', { name: 'Add page' }).last().click();
    await dialog.getByTestId('scan-file-input').setInputFiles(sheet('two.png'));
    await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Add page' }).click();
    await expect(list.getByRole('button', { name: 'Select page 2' })).toHaveAttribute('aria-current', 'true');
    const moveLater = dialog.getByRole('button', { name: /^Move page \d later$/ });
    await expect(moveLater).toBeDisabled();
    await dialog.getByRole('button', { name: /^Move page 2 earlier$/ }).click();
    await expect(dialog.getByRole('toolbar', { name: 'Page 1' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Move page 1 earlier$/ })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Rotate right' }).click();
    await dialog.getByRole('button', { name: 'Rotate left' }).click();
    await dialog.getByRole('button', { name: 'Rotate left' }).click();

    // Edit the corners of the selected page and apply them; cancelling leaves the page as it was.
    await dialog.getByRole('button', { name: 'Edit corners' }).click();
    await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Whole photo' }).click();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await dialog.getByRole('button', { name: 'Edit corners' }).click();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog.getByRole('toolbar', { name: 'Page 1' })).toBeVisible();

    // Retake replaces the page with a new photograph.
    await dialog.getByRole('button', { name: 'Retake' }).click();
    await dialog.getByTestId('scan-file-input').setInputFiles(sheet('retaken.png'));
    await dialog.getByRole('button', { name: 'Add page' }).click();
    await expect(list.getByRole('button', { name: /^Select page \d$/ })).toHaveCount(2);

    // Delete the first page: one is left; deleting the last returns to the camera screen.
    await dialog.getByRole('button', { name: 'Delete page' }).click();
    await expect(list.getByRole('button', { name: /^Select page \d$/ })).toHaveCount(1);

    // Letter pages, balanced quality, and the document opens as a new tab.
    await dialog.getByRole('combobox', { name: 'Page size' }).click();
    await page.getByRole('option', { name: 'Letter' }).click();
    await dialog.getByRole('combobox', { name: 'JPEG quality' }).click();
    await page.getByRole('option', { name: 'Best quality' }).click();
    await dialog.getByRole('button', { name: 'Create PDF' }).click();
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
    await expect(page).toHaveTitle(/^Scan \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.pdf$/);
    const bytes = await exportBytes(page, 'scan.pdf');
    expect((await readProducedPdf(bytes)).pageCount).toBe(1);
    expect(await readProducedEntry(bytes, 0, 'MediaBox')).toMatch(/612 792/);
  });

  test('closing with scanned pages asks first, and the last page deleted returns to the camera', async ({
    page,
  }) => {
    await openPdf(page);
    const dialog = await openScan(page);
    await dialog.getByTestId('scan-file-input').setInputFiles(sheet('a.png'));
    await dialog.getByRole('button', { name: 'Add page' }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog.getByText('Discard the scanned pages?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Go back' }).click();
    await expect(dialog.getByText('Discard the scanned pages?')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog.getByText('Discard the scanned pages?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Discard and close' }).click();
    await expect(dialog).toHaveCount(0);

    const again = await openScan(page);
    await again.getByTestId('scan-file-input').setInputFiles(sheet('b.png'));
    await again.getByRole('button', { name: 'Add page' }).click();
    await again.getByRole('button', { name: 'Delete page' }).click();
    await expect(again.getByTestId('scan-shutter')).toBeVisible();
    await expect(again.getByText('Camera permission was not granted.')).toBeVisible();
    // Nothing scanned: closing needs no question.
    await again.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(again).toHaveCount(0);
  });

  test('a photograph without a sheet in it says the edges were not found and the pages door hands JPEGs to Insert Pages', async ({
    page,
  }) => {
    await openPdf(page);
    await menuItem(page, 'Page', 'Insert Pages');
    const form = page.getByRole('region', { name: 'Insert Pages' });
    await expect(form).toBeVisible();
    await form.getByRole('radio', { name: 'Scan with camera', exact: true }).check();
    await expect(form.getByText('No scanned pages yet')).toBeVisible();
    await form.getByRole('button', { name: 'Scan with camera…' }).click();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    // A plain dark photograph: no page to find.
    const flat = encodePng(300, 400, () => [90, 90, 90]);
    await dialog
      .getByTestId('scan-file-input')
      .setInputFiles({ name: 'desk.png', mimeType: 'image/png', buffer: flat });
    await expect(dialog.getByText(/The page edges could not be found/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Add page' }).click();
    // Pages door: no page size or OCR choice, the button counts the pages.
    await expect(dialog.getByRole('combobox', { name: 'Page size' })).toHaveCount(0);
    await expect(dialog.getByRole('checkbox', { name: /Offer text recognition/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Use 1 pages' }).click();
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
    await expect(form.getByText('1 pages scanned')).toBeVisible();
    await form.getByRole('button', { name: 'Clear the scanned pages' }).click();
    await expect(form.getByText('No scanned pages yet')).toBeVisible();
  });
});
