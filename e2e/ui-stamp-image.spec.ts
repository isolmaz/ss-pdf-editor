/**
 * An image added to the page (Tools → Add an image): what the browser makes of the file it
 * is given decides what is embedded. An upright JPEG keeps its own bytes, a JPEG its EXIF tag
 * turns is re-encoded upright, a picture with transparency stays a PNG with its alpha, an
 * opaque PNG becomes a JPEG, an oversized picture is brought down to 3000 px on its long
 * side, and a file no browser can read is reported by name. Each is placed on the page and the
 * exported file is read.
 */

import type { Page } from 'playwright/test';
import { notice } from './app-helpers';
import { expect, test } from './test';
import { readProducedPdf } from './tool-fixture';
import { exportBytes, menuItem, openPdf, pageFrame, toClient } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** A picture made by the browser's own encoder: `paint` draws on a canvas of the given size. */
async function encoded(
  page: Page,
  type: 'image/jpeg' | 'image/png',
  width: number,
  height: number,
  transparent: boolean,
): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ([mime, w, h, alpha]) => {
      const canvas = document.createElement('canvas');
      canvas.width = Number(w);
      canvas.height = Number(h);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no 2d context');
      if (alpha !== 'yes') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.fillStyle = '#c0392b';
      context.fillRect(0, 0, canvas.width / 2, canvas.height);
      context.fillStyle = '#2980b9';
      context.fillRect(canvas.width / 2, canvas.height / 2, canvas.width / 2, canvas.height / 2);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, String(mime), 0.92));
      if (blob === null) throw new Error('no blob');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    [type, String(width), String(height), transparent ? 'yes' : 'no'],
  );
  return Buffer.from(base64, 'base64');
}

/** The JPEG with an EXIF block that carries `orientation` (1 upright … 8), spliced after its SOI. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), segment, body, jpeg.subarray(2)]);
}

async function addImage(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await menuItem(page, 'Tools', 'Add an image');
  // The picker is the shell's hidden input; the file chooser is what the menu opened.
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({ name, mimeType, buffer });
}

/** Move over the page, see the ghost, click: the placement of the armed picture. */
async function placeAt(page: Page, x: number, y: number): Promise<void> {
  const frame = await pageFrame(page);
  const point = toClient(frame, x, y);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await expect(page.locator('[data-stamp-placement] img')).toBeVisible();
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);
}

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

async function stampRect(page: Page, name: string) {
  const bytes = await exportBytes(page, name);
  const [stamp, ...rest] = (await readProducedPdf(bytes)).annotations.filter(
    (annotation) => annotation.subtype === 'Stamp',
  );
  expect(rest).toEqual([]);
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = stamp?.rect ?? [];
  return { bytes, width: x1 - x0, height: y1 - y0 };
}

test('an upright JPEG is embedded with its own bytes, untouched by a second lossy pass', async ({ page }) => {
  await openPdf(page);
  const jpeg = await encoded(page, 'image/jpeg', 64, 32, false);
  await addImage(page, 'photo.jpg', 'image/jpeg', jpeg);
  await expect(page.getByText('Click on the page where it goes. Press Esc to cancel.').first()).toBeVisible();
  await placeAt(page, 300, 400);
  const { bytes, width, height } = await stampRect(page, 'jpeg.pdf');
  expect(latin1(bytes)).toContain(jpeg.toString('latin1'));
  expect(width / height).toBeCloseTo(2, 1);
});

test('a JPEG that its EXIF tag turns is embedded upright, as the browser shows it', async ({ page }) => {
  await openPdf(page);
  const jpeg = withOrientation(await encoded(page, 'image/jpeg', 64, 32, false), 6);
  await addImage(page, 'turned.jpg', 'image/jpeg', jpeg);
  await placeAt(page, 300, 400);
  const { bytes, width, height } = await stampRect(page, 'turned.pdf');
  // Not the file's own bytes: it was decoded turned and written again.
  expect(latin1(bytes)).not.toContain(jpeg.toString('latin1'));
  // Landscape on disk, portrait on the page.
  expect(height / width).toBeCloseTo(2, 1);
});

test('transparency stays: a PNG with alpha is embedded as an image with a soft mask; an opaque PNG becomes a JPEG', async ({
  page,
}) => {
  await openPdf(page);
  await addImage(page, 'logo.png', 'image/png', await encoded(page, 'image/png', 40, 40, true));
  await placeAt(page, 200, 400);
  const withAlpha = latin1((await stampRect(page, 'alpha.pdf')).bytes);
  expect(withAlpha).toContain('/SMask');

  await openPdf(page, 'opaque.pdf');
  await addImage(page, 'flat.png', 'image/png', await encoded(page, 'image/png', 40, 40, false));
  await placeAt(page, 200, 400);
  const flat = latin1((await stampRect(page, 'flat.pdf')).bytes);
  expect(flat).toContain('/DCTDecode');
  expect(flat).not.toContain('/SMask');
});

test('a picture larger than 3000 px on its long side is brought down to it', async ({ page }) => {
  await openPdf(page);
  await addImage(page, 'wide.png', 'image/png', await encoded(page, 'image/png', 4000, 100, false));
  await placeAt(page, 300, 400);
  const { bytes, width, height } = await stampRect(page, 'wide.pdf');
  expect(latin1(bytes)).toContain('/Width 3000');
  expect(width / height).toBeCloseTo(40, 0);
});

test('a file the browser cannot read as a picture is reported by name and nothing is armed', async ({
  page,
}) => {
  await openPdf(page);
  await addImage(page, 'notes.png', 'image/png', Buffer.from('this is not a picture'));
  await expect(
    notice(page, 'The image could not be read: notes.png. Choose a PNG, JPEG, WebP, GIF or BMP.'),
  ).toBeVisible();
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);
});
