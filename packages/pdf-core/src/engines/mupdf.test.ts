/**
 * The MuPDF adapter's own helpers against real pages: the visible box (crop inside, outside or
 * absent), the page turn, the open that refuses what is not a PDF, and the loader that retries.
 * The unit setup replaces `loadMupdf` with a direct import; these tests take the real one by
 * importing the module actually and pointing the asset URL at a loader file written for the test.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPdf, readPageBox, readPageRotation } from './mupdf';

const assets = vi.hoisted(() => ({ js: '' }));

vi.mock('../assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../assets')>();
  return {
    ...actual,
    MUPDF_ASSETS: {
      ...actual.MUPDF_ASSETS,
      get js() {
        return assets.js;
      },
    },
  };
});

function failureOf(task: () => unknown): ToolError {
  try {
    task();
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

function page(entries: Record<string, unknown>) {
  const doc = new PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 300], 0, {}, ''));
  const object = doc.findPage(0);
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) object.delete(key);
    else object.put(key, value as never);
  }
  return { doc, page: doc.loadPage(0) };
}

describe('readPageBox', () => {
  it('reads the media box, and the crop box inside it', () => {
    const plain = page({});
    expect(readPageBox(plain.page)).toEqual({ x: 0, y: 0, width: 200, height: 300 });
    plain.doc.destroy();
    const cropped = page({ CropBox: [10, 20, 150, 250] });
    expect(readPageBox(cropped.page)).toEqual({ x: 10, y: 20, width: 140, height: 230 });
    cropped.doc.destroy();
  });

  it('clips a crop box that sticks out of the media box, and ignores one that misses it entirely', () => {
    const sticking = page({ CropBox: [-50, -50, 100, 100] });
    expect(readPageBox(sticking.page)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    sticking.doc.destroy();
    const missing = page({ CropBox: [500, 500, 600, 600] });
    expect(readPageBox(missing.page)).toEqual({ x: 0, y: 0, width: 200, height: 300 });
    missing.doc.destroy();
  });

  it('refuses a page without a readable media box or with an empty one', () => {
    for (const media of [null, [0, 0, 0, 0], [0, 0, 'x', 5], 7]) {
      const broken = page({ MediaBox: media });
      expect(failureOf(() => readPageBox(broken.page)).code).toBe('corrupt-document');
      broken.doc.destroy();
    }
  });
});

describe('readPageRotation', () => {
  it('reads the turn in quarter turns, normalised, and 0 when absent', () => {
    for (const [raw, quarter] of [
      [null, 0],
      [90, 90],
      [-90, 270],
      [450, 90],
      [180, 180],
    ] as const) {
      const turned = page({ Rotate: raw });
      expect(readPageRotation(turned.page)).toBe(quarter);
      turned.doc.destroy();
    }
  });

  it('refuses a turn that is not a multiple of 90', () => {
    const odd = page({ Rotate: 45 });
    expect(failureOf(() => readPageRotation(odd.page)).code).toBe('unsupported');
    odd.doc.destroy();
  });
});

describe('openPdf', () => {
  it('refuses bytes that are not a document, naming the open', () => {
    const failure = failureOf(() => openPdf({ PDFDocument } as never, new Uint8Array([1, 2, 3])));
    expect(failure.details.engineMessage).toContain('open:');
  });

  it('refuses a document that opens but is not a PDF, and releases it', () => {
    let destroyed = 0;
    const stand = {
      PDFDocument: {
        openDocument: () => ({
          asPDF: () => null,
          destroy: () => {
            destroyed += 1;
          },
        }),
      },
    };
    const failure = failureOf(() => openPdf(stand as never, new Uint8Array([1])));
    expect(failure.code).toBe('unsupported-format');
    expect(destroyed).toBe(1);
  });
});

describe('loadMupdf (the real loader)', () => {
  let directory = '';
  afterEach(() => {
    if (directory !== '') rmSync(directory, { recursive: true, force: true });
    directory = '';
    vi.resetModules();
  });

  it('shares one load between simultaneous callers, and retries under a new URL after a failure', async () => {
    directory = mkdtempSync(join(tmpdir(), 'mupdf-loader-'));
    const file = join(directory, 'mupdf.mjs');
    assets.js = pathToFileURL(file).href;
    vi.resetModules();
    const real = await vi.importActual<typeof import('./mupdf')>('./mupdf');

    // The first attempt finds nothing at the URL and is forgotten.
    await expect(real.loadMupdf()).rejects.toBeDefined();
    writeFileSync(file, 'export const marker = "loaded";');
    // The retry asks for the same file under a query, which now exists.
    const first = real.loadMupdf();
    expect(real.loadMupdf()).toBe(first);
    expect(await first).toMatchObject({ marker: 'loaded' });
    expect(real.loadMupdf()).toBe(first);
  });
});
