/**
 * Driving code shared by the `ui-viewer15-*.spec.ts` specs: a PDF that carries images of
 * every kind the image dialog distinguishes (binary-safe, unlike the ASCII fixtures), the
 * browser's own JPEG encoder, and the preview → apply steps of an operation form.
 */

import type { Locator, Page } from 'playwright/test';
import { expect } from './test';

/** One image XObject of the fixture: extra dictionary entries and the stream bytes as stored. */
export interface FixtureImage {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Everything after `/Width`/`/Height`, e.g. `/ColorSpace /DeviceRGB /BitsPerComponent 8`. */
  readonly entries: string;
  readonly data: Uint8Array;
}

/**
 * A one-page PDF drawing each image side by side, written byte by byte so the stream bytes
 * stay binary. Object 1 is the catalogue, 2 the page tree, 3 the page, 4 the content, then
 * one object per image.
 */
export function pdfWithImages(images: readonly FixtureImage[]): Uint8Array {
  const content = images
    .map((image, index) => `q 100 0 0 100 ${40 + index * 130} 600 cm /${image.name} Do Q\n`)
    .join('');
  const xobjects = images.map((image, index) => `/${image.name} ${5 + index} 0 R`).join(' ');
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]?.length ?? 0;
  const add = (body: Buffer): void => {
    offsets.push(length);
    const object = Buffer.concat([
      Buffer.from(`${offsets.length} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(object);
    length += object.length;
  };
  add(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
  add(Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'));
  add(
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << ${xobjects} >> >> /Contents 4 0 R >>`,
      'latin1',
    ),
  );
  add(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}endstream`, 'latin1'));
  for (const image of images) {
    add(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ${image.entries} /Length ${image.data.length} >>\nstream\n`,
          'latin1',
        ),
        Buffer.from(image.data),
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
  }
  const count = offsets.length + 1;
  const xref = `xref\n0 ${count}\n0000000000 65535 f \n${offsets
    .map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
    .join('')}`;
  parts.push(
    Buffer.from(`${xref}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'),
  );
  return new Uint8Array(Buffer.concat(parts));
}

/** A JPEG made by the browser's encoder: left half red, right half blue. */
export async function browserJpeg(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = Number(w);
      canvas.height = Number(h);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no 2d context');
      context.fillStyle = '#c0392b';
      context.fillRect(0, 0, canvas.width / 2, canvas.height);
      context.fillStyle = '#2980b9';
      context.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      if (blob === null) throw new Error('no blob');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    [String(width), String(height)],
  );
  return Buffer.from(base64, 'base64');
}

/** Raw RGB samples: the left half red, the right half blue. */
export function rgbSamples(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      const left = x < width / 2;
      out[at] = left ? 192 : 41;
      out[at + 1] = left ? 57 : 128;
      out[at + 2] = left ? 43 : 185;
    }
  }
  return out;
}

/** Preview an operation form, confirm a destructive prompt if asked, and wait for the report. */
export async function previewOperation(form: Locator): Promise<void> {
  await form.getByRole('button', { name: 'Preview', exact: true }).click();
  const report = form.getByRole('heading', { name: 'Operation report' });
  const goOn = form.getByRole('button', { name: 'Continue', exact: true });
  await expect(goOn.or(report)).toBeVisible({ timeout: 60_000 });
  if (await goOn.isVisible()) await goOn.click();
  await expect(report).toBeVisible({ timeout: 60_000 });
}

/** Preview, then apply to the document, and wait for the form to close. */
export async function applyOperation(form: Locator): Promise<void> {
  await previewOperation(form);
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
}
