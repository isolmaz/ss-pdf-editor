/**
 * Driving code of the `ui-marks-*.spec.ts` specs: pictures placed through the image picker,
 * the selection chrome and handles read from the page, and the exported file read back.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { toolFixturePdf } from './tool-fixture';
import { encodePng, exportBytes, pageFrame, toClient } from './ui-helpers';
import { ofSubtype, readAnnotations, type WrittenAnnotation } from './ui-layers-helpers';

/** The exported file's annotations of `subtypes`, read back by MuPDF. */
export async function exported(
  page: Page,
  name: string,
  ...subtypes: readonly string[]
): Promise<readonly WrittenAnnotation[]> {
  return ofSubtype(await readAnnotations(await exportBytes(page, name)), ...subtypes);
}

/**
 * Place a flat red picture of `width × height` px (96 dpi: 0.75 pt per pixel) centred on the
 * page point (`x`, `y`) of page `index`, through the image picker and one click.
 */
export async function placePicture(
  page: Page,
  width: number,
  height: number,
  x: number,
  y: number,
  index = 0,
): Promise<void> {
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({
    name: 'picture.png',
    mimeType: 'image/png',
    buffer: encodePng(width, height, () => [200, 30, 30]),
  });
  await expect(page.locator('[data-stamp-placement]')).toBeAttached();
  const frame = await pageFrame(page, undefined, index);
  const point = toClient(frame, x, y);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);
  // The re-read inventory lists the new picture and selects it: its four handles are the sign.
  await expect(page.locator('[data-mark-resize]')).toHaveCount(4);
}

/** The rectangle of the `at`-th stamp of the exported file. */
export function rectOf(
  stamps: readonly WrittenAnnotation[],
  at = 0,
): readonly [number, number, number, number] {
  const [left, bottom, right, top] = stamps[at]?.rect ?? [];
  if (left === undefined || bottom === undefined || right === undefined || top === undefined) {
    throw new Error(`the exported file has no stamp number ${at} with a rectangle`);
  }
  return [left, bottom, right, top];
}

/** A client-space press, travel and release started at the centre of `from`. */
export async function dragFrom(
  page: Page,
  from: Locator,
  deltaX: number,
  deltaY: number,
  steps = 8,
): Promise<void> {
  const box = await from.boundingBox();
  if (box === null) throw new Error('nothing to drag from');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps });
  await page.mouse.up();
}

/** Click `button`, take the download it starts and keep the file under the test's output. */
export async function download(
  page: Page,
  button: Locator,
  name: string,
): Promise<{ readonly name: string; readonly text: string; readonly path: string }> {
  const started = page.waitForEvent('download');
  await button.click();
  const file = await started;
  const path = test.info().outputPath(name);
  await file.saveAs(path);
  return { name: file.suggestedFilename(), text: readFileSync(path, 'utf8'), path };
}

/** `mupdf` is a dependency of `packages/pdf-core`, not of the repository root. */
const coreRequire = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url));

interface DictEntry {
  isNull(): boolean;
  isString(): boolean;
  isName(): boolean;
  asString(): string;
  asName(): string;
  resolve(): DictEntry;
  get(...path: (string | number)[]): DictEntry;
  readonly length: number;
}

interface PdfFile {
  countPages(): number;
  findPage(index: number): DictEntry;
  destroy(): void;
}

interface MupdfModule {
  readonly PDFDocument: {
    openDocument(bytes: Uint8Array, magic: string): { asPDF(): PdfFile | null };
  };
}

/** The `/DA` default-appearance string of every `/FreeText` of an exported file, in page order. */
export async function freeTextAppearances(bytes: Uint8Array): Promise<readonly string[]> {
  const mupdf: MupdfModule = await import(pathToFileURL(coreRequire.resolve('mupdf')).href);
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('the produced file is not a PDF');
  try {
    const found: string[] = [];
    for (let index = 0; index < doc.countPages(); index += 1) {
      const annots = doc.findPage(index).get('Annots');
      if (annots.isNull()) continue;
      const list = annots.resolve();
      for (let at = 0; at < list.length; at += 1) {
        const dict = list.get(at).resolve();
        const subtype = dict.get('Subtype');
        const raw = dict.get('DA');
        if (subtype.isNull() || raw.isNull()) continue;
        const kind = subtype.resolve();
        const entry = raw.resolve();
        if (kind.isName() && kind.asName() === 'FreeText' && entry.isString()) found.push(entry.asString());
      }
    }
    return found;
  } finally {
    doc.destroy();
  }
}

interface LinkablePage {
  createLink(rect: [number, number, number, number], uri: string): unknown;
}

interface LinkableDocument {
  loadPage(index: number): LinkablePage;
  saveToBuffer(options: string): { asUint8Array(): Uint8Array };
  destroy(): void;
}

interface LinkableMupdf {
  readonly PDFDocument: { openDocument(bytes: Uint8Array, magic: string): LinkableDocument };
}

/** Where the external link of {@link linkedFixture} sits, in page points (origin bottom-left). */
export const EXTERNAL_LINK = { rect: [100, 500, 250, 520], uri: 'https://example.com/linked-page' } as const;

/** The tool fixture with an external `/URI` link on page 1, added by MuPDF. */
export async function linkedFixture(): Promise<Uint8Array> {
  const mupdf: LinkableMupdf = await import(pathToFileURL(coreRequire.resolve('mupdf')).href);
  const doc = mupdf.PDFDocument.openDocument(toolFixturePdf().slice(), 'application/pdf');
  try {
    const [left, bottom, right, top] = EXTERNAL_LINK.rect;
    // MuPDF's page space has its origin top-left.
    doc.loadPage(0).createLink([left, 842 - top, right, 842 - bottom], EXTERNAL_LINK.uri);
    return new Uint8Array(doc.saveToBuffer('').asUint8Array());
  } finally {
    doc.destroy();
  }
}
