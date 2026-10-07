/**
 * Text export on pdf.js answers a healthy page never gives: text-layer markers that are not
 * text, items whose matrix says nothing about their size, a page that cannot be read — and
 * the worker that must be released in every case, including a bad page selection.
 * The document is real; pdf.js's handle is wrapped at its loading seam so that one page read
 * answers as chosen.
 */

import { ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PdfDocumentHandle, PdfOpenOptions } from '../engines/pdfjs-handle';

type Wrap = (handle: PdfDocumentHandle, release: () => void) => PdfDocumentHandle;
const state: { wrap: Wrap | null; released: number } = { wrap: null, released: 0 };

vi.mock('../engines/pdfjs-handle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/pdfjs-handle')>();
  return {
    ...actual,
    openWithPdfjs: async (bytes: Uint8Array, options?: PdfOpenOptions) => {
      const handle = await actual.openWithPdfjs(bytes, options);
      const counted: PdfDocumentHandle = {
        ...handle,
        destroy: async () => {
          state.released += 1;
          await handle.destroy();
        },
      };
      return state.wrap === null ? counted : state.wrap(counted, () => undefined);
    },
  };
});

const { loadMupdf } = await import('../engines/mupdf');
const { exportText } = await import('./text-export');
const run = { signal: new AbortController().signal };

async function onePage(): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  doc.insertPage(
    0,
    doc.addPage([0, 0, 600, 400], 0, { Font: { F: font } }, 'BT /F 12 Tf 50 300 Td (a) Tj ET'),
  );
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

type Item =
  | { str: string; transform: number[]; width: number; height: number }
  | { type: string; id?: string };

/** The handle's page 1 reads its text content as `items`. */
const withItems =
  (items: Item[]): Wrap =>
  (handle) => ({
    ...handle,
    raw: new Proxy(handle.raw, {
      get(target, property) {
        if (property === 'getPage') {
          return async () => ({ getTextContent: async () => ({ items, styles: {} }) });
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  });

afterEach(() => {
  state.wrap = null;
  state.released = 0;
});

describe('exportText on unusual text layers', () => {
  it('skips markers that are not text and reads the size of an item from its matrix, its height, or 1', async () => {
    state.wrap = withItems([
      { type: 'beginMarkedContent', id: 'span-1' },
      // Matrix says 20 pt; the baselines are 5 pt apart: same line only when the size is read.
      { str: 'matrix', transform: [20, 0, 0, 20, 10, 100], width: 100, height: 1 },
      // No size in the matrix: the item's own height (10) decides the tolerance 5 → same line.
      { str: 'height', transform: [0, 0, 0, 0, 120, 104], width: 40, height: 10 },
      // Neither: the size is 1, tolerance 1 → a line of its own, 50 pt below.
      { str: 'unit', transform: [0, 0, 0, 0, 10, 50], width: 5, height: 0 },
      { type: 'endMarkedContent' },
    ]);
    const result = await exportText(await onePage(), { pages: [0], format: 'text', baseName: 'x' }, run);
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(result.file.bytes)).toBe(
      '\uFEFFmatrix height\n\nunit\n',
    );
  });

  it('drops a line that holds only spaces, and calls a page of such lines empty', async () => {
    state.wrap = withItems([
      { str: 'Bir', transform: [12, 0, 0, 12, 10, 300], width: 20, height: 12 },
      { str: '  ', transform: [12, 0, 0, 12, 10, 250], width: 6, height: 12 },
      { str: 'Iki', transform: [12, 0, 0, 12, 10, 200], width: 20, height: 12 },
    ]);
    const mixed = await exportText(await onePage(), { pages: [0], format: 'markdown', baseName: 'x' }, run);
    expect(new TextDecoder().decode(mixed.file.bytes)).toBe('Bir\n\nIki\n');
    expect(mixed.emptyPages).toEqual([]);

    state.wrap = withItems([{ str: ' ', transform: [12, 0, 0, 12, 10, 250], width: 6, height: 12 }]);
    const blank = await exportText(await onePage(), { pages: [0], format: 'markdown', baseName: 'x' }, run);
    expect(blank.emptyPages).toEqual([0]);
    expect(blank.characterCount).toBe(0);
  });

  it('maps a page the reader cannot read to a ToolError of the reader and releases the worker', async () => {
    const cause = new Error('page tree is damaged');
    state.wrap = (handle) => ({
      ...handle,
      raw: new Proxy(handle.raw, {
        get(target, property) {
          if (property === 'getPage') {
            return async () => {
              throw cause;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    const failure = await exportText(
      await onePage(),
      { pages: [0], format: 'text', baseName: 'x' },
      run,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({
      code: 'internal',
      details: { engine: 'pdfjs', engineMessage: 'page tree is damaged' },
    });
    expect((failure as ToolError).cause).toBe(cause);
    expect(state.released).toBe(1);
  });

  it('releases the worker when the page selection is refused', async () => {
    await expect(
      exportText(await onePage(), { pages: [5], format: 'text', baseName: 'x' }, run),
    ).rejects.toMatchObject({ code: 'range-invalid' });
    expect(state.released).toBe(1);
  });
});
