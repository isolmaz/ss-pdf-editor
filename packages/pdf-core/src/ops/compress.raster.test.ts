/**
 * The raster compression path against real PDFs. A Node run has no canvas and pdf.js has nothing
 * to paint on, so the two things that need one are replaced at their own boundary: the handle's
 * `renderPage` (it only sizes the canvas) and the canvas the operation creates (a stand-in that
 * answers `getContext`, `toDataURL` and the pixel buffer). The PDF, the page sizes pdf.js reports,
 * the JPEG that is embedded, the assembled file and the report are real.
 */

import { ColorSpace, Font, PDFDocument, Pixmap } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationProgress } from './types';

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

const { assembleRaster, compressDocument } = await import('./compress');

const run = { signal: new AbortController().signal };

interface FakeCanvas {
  width: number;
  height: number;
  puts: Uint8ClampedArray[];
  toDataURL: (type: string, quality: number) => string;
  getContext: (kind: string) => unknown;
}

const made: FakeCanvas[] = [];
const behaviour = {
  dataUrl: 'jpeg' as 'jpeg' | 'png' | 'nocomma',
  noContext: false,
  qualities: [] as number[],
};

function jpegDataUrl(): string {
  const pixmap = new Pixmap(ColorSpace.DeviceRGB, [0, 0, 40, 40], false);
  pixmap.clear(180);
  const bytes = new Uint8Array(pixmap.asJPEG(80));
  pixmap.destroy();
  return `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function fixture(rotated = true): Uint8Array {
  const doc = new PDFDocument();
  const font = doc.addSimpleFont(new Font('Helvetica'));
  for (const [index, word] of ['Alpha', 'Bravo', 'Charlie'].entries()) {
    doc.insertPage(
      index,
      doc.addPage(
        [0, 0, 300, 400],
        rotated && index === 1 ? 90 : 0,
        { Font: { F: font } },
        `BT /F 24 Tf 40 300 Td (${word}) Tj ET`,
      ),
    );
  }
  doc.setMetaData('info:Title', 'Özet');
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function pages(bytes: Uint8Array) {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return Array.from({ length: doc.countPages() }, (_unused, index) => {
      const page = doc.loadPage(index);
      const bounds = page.getBounds();
      return {
        text: page.toStructuredText('').asText().trim(),
        size: [Math.round(bounds[2] - bounds[0]), Math.round(bounds[3] - bounds[1])],
      };
    });
  } finally {
    doc.destroy();
  }
}

async function failureOf(task: Promise<unknown>): Promise<ToolError> {
  try {
    await task;
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

beforeEach(() => {
  made.length = 0;
  behaviour.dataUrl = 'jpeg';
  behaviour.noContext = false;
  behaviour.qualities = [];
  const url = jpegDataUrl();
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      expect(tag).toBe('canvas');
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        puts: [],
        toDataURL: (_type, quality) => {
          behaviour.qualities.push(quality);
          if (behaviour.dataUrl === 'png') return 'data:image/png;base64,AAAA';
          if (behaviour.dataUrl === 'nocomma') return 'data:image/jpeg';
          return url;
        },
        getContext: () => {
          if (behaviour.noContext) return null;
          // Two pixels: pure red and pure green, both opaque.
          const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
          return {
            getImageData: () => ({ data }),
            putImageData: () => {
              canvas.puts.push(new Uint8ClampedArray(data));
            },
          };
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

const raster = (
  overrides: Partial<{ pages: number[]; dpi: number; quality: number; greyscale: boolean }> = {},
) => ({
  mode: 'raster' as const,
  pages: [0],
  dpi: 144,
  quality: 0.7,
  greyscale: false,
  ...overrides,
});

describe('compressDocument raster mode', () => {
  it('replaces the chosen pages by their pictures at the displayed size and leaves the others', async () => {
    const progress: OperationProgress[] = [];
    const out = await compressDocument(fixture(), raster({ pages: [1, 0, 1] }), {
      signal: run.signal,
      onProgress: (entry) => progress.push(entry),
    });
    const result = pages(out.bytes);
    // Page 0 and the turned page 1 are pictures: no text, the displayed (upright) size.
    expect(result.map((page) => page.text)).toEqual(['', '', 'Charlie']);
    expect(result.map((page) => page.size)).toEqual([
      [300, 400],
      [400, 300],
      [300, 400],
    ]);
    // 144 dpi is 2 pixels per point, requested once per distinct page, with the requested quality.
    expect(made.map((canvas) => [canvas.width, canvas.height])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(behaviour.qualities).toEqual([0.7, 0.7]);
    expect(out.report.engine).toBe('pdfjs');
    expect(out.report.incremental).toBe(false);
    expect(out.report.pageCount).toBe(3);
    expect(out.report.steps).toEqual(['load', 'render', 'assemble', 'save']);
    expect(out.report.notes.slice(0, 3).map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.compress.rasterized', { count: 2 }],
      ['op.note.compress.rotationBaked', { count: 1 }],
      ['op.note.compress.otherPages', { count: 1 }],
    ]);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.compress.infoCopied');
    expect(out.report.notes.at(-1)?.key).toMatch(/^optimize\./);
    expect(progress.filter((entry) => entry.phase === 'render').map((entry) => entry.done)).toEqual([1, 2]);
  });

  it('turns the picture grey with the Rec. 601 weighting when asked, and says so', async () => {
    const out = await compressDocument(fixture(false), raster({ greyscale: true }), run);
    const [first] = made;
    expect(first?.puts).toHaveLength(1);
    // Red: 0.299 * 255 = 76.245 -> 76; green: 0.587 * 255 = 149.685 -> 149 (clamped array truncates by rounding).
    expect(Array.from(first?.puts[0] ?? [])).toEqual([76, 76, 76, 255, 150, 150, 150, 255]);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.compress.greyscale');
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.compress.rotationBaked');
  });

  it('refuses a greyscale page whose canvas has no 2d context', async () => {
    behaviour.noContext = true;
    const failure = await failureOf(compressDocument(fixture(), raster({ greyscale: true }), run));
    expect(failure.code).toBe('internal');
    expect(failure.details.engineMessage).toBe('render canvas has no 2d context');
    expect(made[0]?.width).toBe(0);
  });

  it('has no note about untouched pages when every page was rasterised', async () => {
    const out = await compressDocument(fixture(), raster({ pages: [0, 1, 2] }), run);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.compress.otherPages');
  });

  it('refuses a canvas that produced no JPEG', async () => {
    for (const dataUrl of ['png', 'nocomma'] as const) {
      behaviour.dataUrl = dataUrl;
      const failure = await failureOf(compressDocument(fixture(), raster(), run));
      expect(failure.details.engineMessage).toBe('canvas produced no JPEG data');
    }
  });

  it('refuses options outside the supported range, an empty selection and a page that is not there', async () => {
    const cases: Array<[ReturnType<typeof raster>, string]> = [
      [raster({ dpi: 71 }), 'range-invalid'],
      [raster({ dpi: Number.NaN }), 'range-invalid'],
      [raster({ dpi: 301 }), 'range-invalid'],
      [raster({ quality: 0.29 }), 'range-invalid'],
      [raster({ quality: 1 }), 'range-invalid'],
      [raster({ pages: [] }), 'selection-empty'],
      [raster({ pages: [3] }), 'range-invalid'],
      [raster({ pages: [-1] }), 'range-invalid'],
      [raster({ pages: [0.5] }), 'range-invalid'],
    ];
    for (const [options, code] of cases) {
      expect((await failureOf(compressDocument(fixture(), options, run))).code).toBe(code);
    }
    expect(made).toEqual([]);
  });

  it('stops with an abort error before the run, between pages and before assembling', async () => {
    const before = new AbortController();
    before.abort();
    await expect(compressDocument(fixture(), raster(), { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    const between = new AbortController();
    await expect(
      compressDocument(fixture(), raster({ pages: [0, 1] }), {
        signal: between.signal,
        onProgress: () => between.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(made).toHaveLength(1);

    const last = new AbortController();
    await expect(
      compressDocument(fixture(), raster({ pages: [0] }), {
        signal: last.signal,
        onProgress: () => last.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('assembleRaster', () => {
  const jpeg = (): Uint8Array => {
    const pixmap = new Pixmap(ColorSpace.DeviceRGB, [0, 0, 20, 20], false);
    pixmap.clear(100);
    const bytes = new Uint8Array(pixmap.asJPEG(80));
    pixmap.destroy();
    return bytes;
  };

  it('names a page the document does not have', async () => {
    const failure = await failureOf(
      assembleRaster(fixture(), new Map([[9, { jpeg: jpeg(), width: 10, height: 10 }]]), run),
    );
    expect(failure.code).toBe('range-invalid');
    expect(failure.details.pageIndex).toBe(9);
  });

  it('maps a picture the engine cannot decode to a tool error', async () => {
    const failure = await failureOf(
      assembleRaster(
        fixture(),
        new Map([[0, { jpeg: new Uint8Array([1, 2, 3]), width: 10, height: 10 }]]),
        run,
      ),
    );
    expect(failure.details.engine).toBe('mupdf');
    expect(failure.details.engineMessage).toContain('embed rasterised page');
  });

  it('stops with an abort error between pages', async () => {
    const controller = new AbortController();
    await expect(
      assembleRaster(
        fixture(),
        new Map([
          [0, { jpeg: jpeg(), width: 10, height: 10 }],
          [1, { jpeg: jpeg(), width: 10, height: 10 }],
        ]),
        { signal: controller.signal, onProgress: () => controller.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('compressDocument structure mode', () => {
  const structure = { mode: 'structure' as const, stripMetadata: false, keepProducer: true };

  it('refuses to strip the producer line', async () => {
    const failure = await failureOf(
      compressDocument(fixture(), { mode: 'structure', stripMetadata: true, keepProducer: false }, run),
    );
    expect(failure.code).toBe('unsupported');
  });

  it('strips the Info entries but keeps the Producer line, and copes with a file that has no Info', async () => {
    const withInfo = new PDFDocument();
    withInfo.insertPage(0, withInfo.addPage([0, 0, 100, 100], 0, {}, ''));
    withInfo.setMetaData('info:Title', 'Gizli');
    withInfo.setMetaData('info:Producer', 'Üretici');
    const bytes = new Uint8Array(withInfo.saveToBuffer('').asUint8Array());
    withInfo.destroy();
    const out = await compressDocument(
      bytes,
      { mode: 'structure', stripMetadata: true, keepProducer: true },
      run,
    );
    const read = PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    expect(read.getMetaData('info:Title') ?? null).toBeNull();
    expect(read.getMetaData('info:Producer')).toBeTruthy();
    read.destroy();

    const bare = new PDFDocument();
    bare.insertPage(0, bare.addPage([0, 0, 100, 100], 0, {}, ''));
    const bareBytes = new Uint8Array(bare.saveToBuffer('').asUint8Array());
    bare.destroy();
    const stripped = await compressDocument(
      bareBytes,
      { mode: 'structure', stripMetadata: true, keepProducer: true },
      run,
    );
    expect(stripped.report.steps).toContain('metadata');
  });

  it('stops with an abort error when the signal is aborted while the document is loading', async () => {
    const controller = new AbortController();
    const running = compressDocument(fixture(), structure, { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('maps damaged bytes to a tool error', async () => {
    const failure = await failureOf(compressDocument(new Uint8Array([1, 2, 3]), structure, run));
    expect(failure.code).not.toBe('aborted');
  });
});
