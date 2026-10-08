/**
 * The image dialog's actions that work on the picture's own pixels (rotate, crop,
 * recompress), opacity, and the refusals: what the produced file says about the edited
 * object, and what the reader is told when an action cannot run.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedEntry } from './tool-fixture';
import { exportBytes, openPdf, runCommand } from './ui-helpers';
import {
  applyOperation,
  browserJpeg,
  type FixtureImage,
  pdfWithImages,
  rgbSamples,
} from './ui-viewer15-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const RAW: FixtureImage = {
  name: 'Raw',
  width: 8,
  height: 4,
  entries: '/ColorSpace /DeviceRGB /BitsPerComponent 8',
  data: rgbSamples(8, 4),
};

const ONE_BIT: FixtureImage = {
  name: 'Bits',
  width: 8,
  height: 8,
  entries: '/ColorSpace /DeviceGray /BitsPerComponent 1',
  data: new Uint8Array(8).fill(0xaa),
};

const NOT_A_JPEG: FixtureImage = {
  name: 'Broken',
  width: 4,
  height: 4,
  entries: '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
  data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
};

async function openWith(page: Page, images: readonly FixtureImage[]): Promise<Locator> {
  await openPdf(page, 'pictures.pdf', pdfWithImages(images));
  await runCommand(page, 'Replace Image');
  const form = page.getByRole('region', { name: 'Replace Image' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  return form;
}

async function pick(page: Page, form: Locator, name: string): Promise<void> {
  await form.getByRole('combobox', { name: 'Image' }).click();
  await page
    .getByRole('option', { name: new RegExp(` · ${name} · `) })
    .first()
    .click();
}

async function action(form: Locator, label: string): Promise<void> {
  await form.getByRole('radio', { name: label, exact: true }).check();
}

/** Preview and expect the form's alert: the translated message, and the engine's own words as its diagnostic. */
async function expectRefused(form: Locator, message: string, diagnostic: string): Promise<void> {
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  const alert = form.getByRole('alert');
  await expect(alert).toContainText(message, { timeout: 60_000 });
  await expect(alert.locator('[data-dialog-diagnostic]')).toHaveAttribute(
    'data-dialog-diagnostic',
    diagnostic,
  );
  await expect(form.getByRole('heading', { name: 'Operation report' })).toHaveCount(0);
}

const entry = (bytes: Uint8Array, name: string, key: string) =>
  readProducedEntry(bytes, 0, 'Resources', 'XObject', name, key);

test('rotating an uncompressed image a quarter turn swaps its pixel width and height in the file', async ({
  page,
}) => {
  const form = await openWith(page, [RAW]);
  await pick(page, form, 'Raw');
  await action(form, 'Rotate');
  await applyOperation(form);
  const bytes = await exportBytes(page, 'rotated.pdf');
  expect(await entry(bytes, 'Raw', 'Width')).toBe('4');
  expect(await entry(bytes, 'Raw', 'Height')).toBe('8');
});

test('rotating by 180 degrees keeps the pixel size of the image', async ({ page }) => {
  const form = await openWith(page, [RAW]);
  await pick(page, form, 'Raw');
  await action(form, 'Rotate');
  await form.getByRole('combobox', { name: 'Angle' }).click();
  await page.getByRole('option', { name: '180°', exact: true }).click();
  await applyOperation(form);
  const bytes = await exportBytes(page, 'half-turn.pdf');
  expect(await entry(bytes, 'Raw', 'Width')).toBe('8');
  expect(await entry(bytes, 'Raw', 'Height')).toBe('4');
});

test('cropping takes the chosen percentages off every side of the image', async ({ page }) => {
  const form = await openWith(page, [RAW]);
  await pick(page, form, 'Raw');
  await action(form, 'Crop (percent)');
  await form.getByRole('spinbutton', { name: 'Crop left (%)' }).fill('25');
  await form.getByRole('spinbutton', { name: 'Crop right (%)' }).fill('25');
  await form.getByRole('spinbutton', { name: 'Crop top (%)' }).fill('25');
  await form.getByRole('spinbutton', { name: 'Crop bottom (%)' }).fill('0');
  await applyOperation(form);
  const bytes = await exportBytes(page, 'cropped.pdf');
  // 8 px wide minus 2 + 2, 4 px high minus 1 + 0.
  expect(await entry(bytes, 'Raw', 'Width')).toBe('4');
  expect(await entry(bytes, 'Raw', 'Height')).toBe('3');
});

test('a crop that removes the whole image is refused and the document is left alone', async ({ page }) => {
  const form = await openWith(page, [RAW]);
  await pick(page, form, 'Raw');
  await action(form, 'Crop (percent)');
  await form.getByRole('spinbutton', { name: 'Crop top (%)' }).fill('90');
  await form.getByRole('spinbutton', { name: 'Crop bottom (%)' }).fill('90');
  await expectRefused(
    form,
    'A field value is outside the allowed range.',
    'the crop removes the whole image',
  );
  await expect(form.getByRole('heading', { name: 'Operation report' })).toHaveCount(0);
});

test('recompressing an uncompressed image writes it as a JPEG stream', async ({ page }) => {
  const form = await openWith(page, [RAW]);
  await pick(page, form, 'Raw');
  await action(form, 'Recompress (JPEG)');
  await form.getByRole('spinbutton', { name: 'JPEG quality' }).fill('0.5');
  await applyOperation(form);
  const bytes = await exportBytes(page, 'recompressed.pdf');
  expect(await entry(bytes, 'Raw', 'Filter')).toBe('/DCTDecode');
  expect(await entry(bytes, 'Raw', 'Width')).toBe('8');
  expect(await entry(bytes, 'Raw', 'Height')).toBe('4');
});

test('a JPEG image is decoded by the browser, cropped and written back at the cropped size', async ({
  page,
}) => {
  await page.goto('/editor/');
  const jpeg = await browserJpeg(page, 32, 16);
  const photo: FixtureImage = {
    name: 'Photo',
    width: 32,
    height: 16,
    entries: '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
    data: new Uint8Array(jpeg),
  };
  await openPdf(page, 'pictures.pdf', pdfWithImages([photo]), { navigate: false });
  await runCommand(page, 'Replace Image');
  const form = page.getByRole('region', { name: 'Replace Image' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await pick(page, form, 'Photo');
  await action(form, 'Crop (percent)');
  await form.getByRole('spinbutton', { name: 'Crop left (%)' }).fill('50');
  await form.getByRole('spinbutton', { name: 'Crop right (%)' }).fill('0');
  await form.getByRole('spinbutton', { name: 'Crop top (%)' }).fill('0');
  await form.getByRole('spinbutton', { name: 'Crop bottom (%)' }).fill('0');
  await applyOperation(form);
  const bytes = await exportBytes(page, 'photo-cropped.pdf');
  expect(await entry(bytes, 'Photo', 'Width')).toBe('16');
  expect(await entry(bytes, 'Photo', 'Height')).toBe('16');
});

test('a JPEG stream the browser cannot decode is reported and nothing is applied', async ({ page }) => {
  const form = await openWith(page, [NOT_A_JPEG]);
  await pick(page, form, 'Broken');
  await action(form, 'Rotate');
  await expectRefused(
    form,
    'This file format is not supported.',
    'the browser could not decode this image’s JPEG stream',
  );
});

test('an image whose samples cannot be read says so in the list and refuses rotation', async ({ page }) => {
  const form = await openWith(page, [ONE_BIT]);
  await form.getByRole('combobox', { name: 'Image' }).click();
  await expect(page.getByRole('option', { name: /Bits · 8×8 · .* · replace only/ })).toBeVisible();
  await page.getByRole('option', { name: /Bits/ }).click();
  await action(form, 'Rotate');
  await expectRefused(
    form,
    'This feature is not available for this document.',
    "this image's samples cannot be read: op.note.image.bitsUnsupported",
  );
});

test('opacity leaves the picture alone and puts a graphics state around the operator that draws it', async ({
  page,
}) => {
  const form = await openWith(page, [RAW]);
  await pick(page, form, 'Raw');
  await action(form, 'Opacity');
  await form.getByRole('spinbutton', { name: 'Opacity (0–1)' }).fill('0.25');
  await applyOperation(form);
  const bytes = await exportBytes(page, 'faded.pdf');
  expect(await entry(bytes, 'Raw', 'Width')).toBe('8');
  const states = await readProducedEntry(bytes, 0, 'Resources', 'ExtGState');
  const stateName = /^<<\/(\w+) /.exec(states)?.[1] ?? '';
  expect(await readProducedEntry(bytes, 0, 'Resources', 'ExtGState', stateName, 'ca')).toBe('.25');
});

test('replacing without picking a file is refused with the missing input', async ({ page }) => {
  const form = await openWith(page, [RAW]);
  await pick(page, form, 'Raw');
  await expectRefused(form, 'This operation has nothing to work with yet.', 'no image file was picked');
});
