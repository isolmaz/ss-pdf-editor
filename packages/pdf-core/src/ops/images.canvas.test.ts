/**
 * Page export to pictures, with the browser's canvas replaced by a recorder (a Node run has no
 * canvas, and pdf.js paints onto one): `renderPage` of the handle only sizes it, and the canvas
 * answers `toBlob`. What is asserted is the export's own work — one canvas reused for every page,
 * the pixel size from the DPI, the file names and mime types, releasing the canvas, and the errors
 * it names for an encoder that gives nothing or another format.
 */

import { PDFDocument } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../engines/pdfjs-handle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/pdfjs-handle')>();
  return {
    ...actual,
    openWithPdfjs: async (...args: Parameters<typeof actual.openWithPdfjs>) => {
      const handle = await actual.openWithPdfjs(...args);
      return {
        ...handle,
        renderPage: async (
          pageIndex: number,
          canvas: { width: number; height: number },
          renderOptions: { scale: number },
        ) => {
          const size = await handle.getPageSize(pageIndex, renderOptions.scale);
          canvas.width = Math.floor(size.width);
          canvas.height = Math.floor(size.height);
        },
      };
    },
  };
});

const { exportImages } = await import('./images');

const run = { signal: new AbortController().signal };

interface FakeCanvas {
  width: number;
  height: number;
  toBlob: (done: (blob: Blob | null) => void, type: string) => void;
}

const made: FakeCanvas[] = [];
const behaviour = { blob: 'ok' as 'ok' | 'none' | 'other' };

function document(): Uint8Array {
  const doc = new PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 100, 50], 0, {}, ''));
  doc.insertPage(1, doc.addPage([0, 0, 200, 100], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

beforeEach(() => {
  made.length = 0;
  behaviour.blob = 'ok';
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      expect(tag).toBe('canvas');
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        toBlob: (done, type) => {
          if (behaviour.blob === 'none') done(null);
          else
            done(
              new Blob([`${canvas.width}x${canvas.height}`], {
                type: behaviour.blob === 'other' ? 'image/png' : type,
              }),
            );
        },
      };
      made.push(canvas);
      return canvas;
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const settings = {
  pages: [0, 1],
  dpi: 144,
  format: 'jpeg' as const,
  baseName: 'rapor.pdf',
  maxMegapixels: 50,
};

describe('exportImages with a canvas', () => {
  it('makes one file per page from one reused canvas, sized by the DPI, named and typed by the format', async () => {
    const out = await exportImages(document(), settings, run);
    expect(out.pageCount).toBe(2);
    expect(out.files.map((file) => [file.name, file.mime])).toEqual([
      ['rapor-001.jpg', 'image/jpeg'],
      ['rapor-002.jpg', 'image/jpeg'],
    ]);
    expect(out.files.map((file) => new TextDecoder().decode(file.bytes))).toEqual(['200x100', '400x200']);
    expect(made).toHaveLength(1);
    expect([made[0]?.width, made[0]?.height]).toEqual([0, 0]);
  });

  it('names png and webp files by their own extension', async () => {
    expect(
      (await exportImages(document(), { ...settings, pages: [0], format: 'png' }, run)).files[0]?.name,
    ).toBe('rapor-001.png');
    const webp = await exportImages(document(), { ...settings, pages: [0], format: 'webp' }, run);
    expect(webp.files[0]).toMatchObject({ name: 'rapor-001.webp', mime: 'image/webp' });
  });

  it('refuses a page index the document does not have', async () => {
    await expect(exportImages(document(), { ...settings, pages: [0, 5] }, run)).rejects.toMatchObject({
      code: 'range-invalid',
    });
    await expect(exportImages(document(), { ...settings, pages: [-1] }, run)).rejects.toMatchObject({
      code: 'range-invalid',
    });
  });

  it('reports a canvas that encoded nothing, and releases it', async () => {
    behaviour.blob = 'none';
    const failure = await exportImages(document(), settings, run).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'internal' });
    expect([made[0]?.width, made[0]?.height]).toEqual([0, 0]);
  });

  it('reports a browser that encoded another format than the one asked for', async () => {
    behaviour.blob = 'other';
    const failure = await exportImages(document(), { ...settings, format: 'webp' }, run).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'unsupported-format' });
  });
});
