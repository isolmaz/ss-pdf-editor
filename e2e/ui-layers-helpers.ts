/**
 * Driving and read-back code of the `ui-layers-*.spec.ts` specs: the viewer's interaction
 * layers (measure, annotation, mark selection, redaction, context menu, magnifier) are
 * driven with a mouse and the exported file is read back with MuPDF's object model.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Locator, Page } from 'playwright/test';
import { expect } from './test';
import { FIXTURE_PAGE } from './tool-fixture';
import { CANVAS, type PageFrame, pageFrame, toClient } from './ui-helpers';

/** `mupdf` is a dependency of `packages/pdf-core`, not of the repository root. */
const coreRequire = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url));

interface PdfObjectLike {
  isNull(): boolean;
  isString(): boolean;
  isName(): boolean;
  isNumber(): boolean;
  isArray(): boolean;
  asString(): string;
  asName(): string;
  asNumber(): number;
  resolve(): PdfObjectLike;
  get(...path: (string | number)[]): PdfObjectLike;
  readonly length: number;
}

interface PdfDocumentLike {
  countPages(): number;
  findPage(index: number): PdfObjectLike;
  destroy(): void;
}

interface MupdfLike {
  PDFDocument: {
    openDocument(bytes: Uint8Array, magic: string): { asPDF(): PdfDocumentLike | null };
  };
}

function numbers(value: PdfObjectLike): number[] {
  if (value.isNull()) return [];
  const array = value.resolve();
  if (!array.isArray()) return [];
  const result: number[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const entry = array.get(index).resolve();
    if (entry.isNumber()) result.push(entry.asNumber());
  }
  return result;
}

function text(value: PdfObjectLike): string {
  if (value.isNull()) return '';
  const target = value.resolve();
  if (target.isString()) return target.asString();
  if (target.isName()) return target.asName();
  return '';
}

function number(value: PdfObjectLike): number | null {
  if (value.isNull()) return null;
  const target = value.resolve();
  return target.isNumber() ? target.asNumber() : null;
}

/** One annotation of an exported file, every entry the viewer layers write. */
export interface WrittenAnnotation {
  readonly pageIndex: number;
  readonly subtype: string;
  readonly contents: string;
  readonly author: string;
  readonly rect: readonly number[];
  readonly color: readonly number[];
  readonly opacity: number | null;
  readonly borderWidth: number | null;
  readonly vertices: readonly number[];
  readonly line: readonly number[];
  readonly quadPoints: readonly number[];
  readonly inkLists: readonly (readonly number[])[];
  /** `/Measure /Subtype`, empty without a `/Measure` dictionary. */
  readonly measureSubtype: string;
  /** `/Measure /R`: drawn units, real units. */
  readonly measureRatio: readonly number[];
  readonly measureUnit: string;
  readonly measureDecimals: number | null;
}

/** Every annotation of an exported file, page by page, as MuPDF's object model reads them. */
export async function readAnnotations(bytes: Uint8Array): Promise<readonly WrittenAnnotation[]> {
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as MupdfLike;
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('the produced file is not a PDF');
  try {
    const found: WrittenAnnotation[] = [];
    for (let pageIndex = 0; pageIndex < doc.countPages(); pageIndex += 1) {
      const entry = doc.findPage(pageIndex).get('Annots');
      if (entry.isNull()) continue;
      const array = entry.resolve();
      for (let at = 0; at < array.length; at += 1) {
        const dict = array.get(at).resolve();
        const measure = dict.get('Measure');
        const style = dict.get('BS');
        const inkEntry = dict.get('InkList');
        const inkLists: number[][] = [];
        if (!inkEntry.isNull()) {
          const runs = inkEntry.resolve();
          for (let run = 0; run < runs.length; run += 1) inkLists.push(numbers(runs.get(run)));
        }
        found.push({
          pageIndex,
          subtype: text(dict.get('Subtype')),
          contents: text(dict.get('Contents')),
          author: text(dict.get('T')),
          rect: numbers(dict.get('Rect')),
          color: numbers(dict.get('C')),
          opacity: number(dict.get('CA')),
          borderWidth: style.isNull() ? null : number(style.resolve().get('W')),
          vertices: numbers(dict.get('Vertices')),
          line: numbers(dict.get('L')),
          quadPoints: numbers(dict.get('QuadPoints')),
          inkLists,
          measureSubtype: measure.isNull() ? '' : text(measure.resolve().get('Subtype')),
          measureRatio: measure.isNull() ? [] : numbers(measure.resolve().get('R')),
          measureUnit: measure.isNull() ? '' : text(measure.resolve().get('X', 'U')),
          measureDecimals: measure.isNull() ? null : number(measure.resolve().get('X', 'D')),
        });
      }
    }
    return found;
  } finally {
    doc.destroy();
  }
}

/** The annotations a spec's own gestures added: the fixture's saved marks filtered out. */
export function ofSubtype(
  annotations: readonly WrittenAnnotation[],
  ...subtypes: readonly string[]
): readonly WrittenAnnotation[] {
  return annotations.filter((annotation) => subtypes.includes(annotation.subtype));
}

/** A number is within `tolerance` page points of the expected one (pointer → page point is not exact). */
export function expectNear(actual: number | undefined, expected: number, tolerance = 1): void {
  expect(
    Math.abs((actual ?? Number.NaN) - expected),
    `${actual} is not within ${tolerance} of ${expected}`,
  ).toBeLessThanOrEqual(tolerance);
}

/** The first page of the document, scrolled so that its whole height is at hand. */
export async function framed(page: Page, index = 0): Promise<PageFrame> {
  await page.locator('.pdfViewer[data-active-viewer] .page').nth(index).scrollIntoViewIfNeeded();
  return pageFrame(page, FIXTURE_PAGE, index);
}

/** Click a page point of page `index`, measured at the moment of the click. */
export async function clickAt(
  page: Page,
  x: number,
  y: number,
  options: { readonly index?: number; readonly button?: 'left' | 'right'; readonly clickCount?: number } = {},
): Promise<void> {
  const frame = await pageFrame(page, FIXTURE_PAGE, options.index ?? 0);
  const point = toClient(frame, x, y);
  await page.mouse.click(point.x, point.y, {
    button: options.button ?? 'left',
    clickCount: options.clickCount ?? 1,
  });
}

/** Move the pointer to a page point of page `index`. */
export async function moveTo(page: Page, x: number, y: number, index = 0): Promise<void> {
  const frame = await pageFrame(page, FIXTURE_PAGE, index);
  const point = toClient(frame, x, y);
  await page.mouse.move(point.x, point.y, { steps: 4 });
}

/** The painted pages of the viewer. */
export function pages(page: Page): Locator {
  return page.locator(CANVAS);
}
