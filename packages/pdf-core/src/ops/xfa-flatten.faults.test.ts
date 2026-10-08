/**
 * The flattened file is read back before it is returned. The real writer produces what it is told
 * to, so these tests wrap the engine's opening of a document (the seam `structure.faults.test.ts`
 * uses): the file being verified answers wrongly in one chosen way, and the verification has to
 * say so instead of handing back an unchecked file.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PDFDocument } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** What the document being verified answers for its page count. */
  pageCount?: number;
  /** An error `loadPage` throws. */
  loadPageError?: unknown;
  /** What every page's extracted text is. */
  pageText?: string;
}
const state: Plan = {};

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      const wrap = (document: PDFDocument): PDFDocument => {
        const proxy: PDFDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'asPDF') return () => proxy;
            if (property === 'countPages' && state.pageCount !== undefined) return () => state.pageCount;
            if (property === 'loadPage' && state.loadPageError !== undefined) {
              return () => {
                throw state.loadPageError;
              };
            }
            if (property === 'loadPage' && state.pageText !== undefined) {
              return (index: number) => {
                const page = target.loadPage(index);
                return new Proxy(page, {
                  get(pageTarget, pageProperty) {
                    if (pageProperty === 'toStructuredText') {
                      return () => ({ asText: () => state.pageText });
                    }
                    const value: unknown = Reflect.get(pageTarget, pageProperty, pageTarget);
                    return typeof value === 'function' ? value.bind(pageTarget) : value;
                  },
                });
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return proxy;
      };
      const documents = new Proxy(real.PDFDocument, {
        get(target, property) {
          if (property === 'openDocument') {
            return (...args: Parameters<typeof real.PDFDocument.openDocument>) =>
              wrap(real.PDFDocument.openDocument(...args) as PDFDocument);
          }
          return Reflect.get(target, property, target);
        },
      });
      return new Proxy(real, {
        get(target, property) {
          return property === 'PDFDocument' ? documents : Reflect.get(target, property, target);
        },
      });
    },
  };
});

const { buildFlattenedXfa } = await import('./xfa-flatten');
const { loadMupdf } = await import('../engines/mupdf');

const run = { signal: new AbortController().signal };

async function onePage(withWords: boolean) {
  const mupdf = await loadMupdf();
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 100, 50], false);
  pixmap.clear(90);
  const png = new Uint8Array(pixmap.asPNG());
  pixmap.destroy();
  return {
    widthPt: 100,
    heightPt: 50,
    scale: 1,
    png,
    words: withWords ? [{ text: 'Merhaba', x0: 5, y0: 5, x1: 80, y1: 25 }] : [],
  };
}

describe('buildFlattenedXfa verification', () => {
  beforeEach(() => {
    const file = createRequire(import.meta.url).resolve(
      '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
      { paths: [process.cwd()] },
    );
    const font = new Uint8Array(readFileSync(file));
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    state.pageCount = undefined;
    state.loadPageError = undefined;
    state.pageText = undefined;
  });

  it('refuses a file whose page count is not the number of pictures it was built from', async () => {
    state.pageCount = 3;
    const failure = await buildFlattenedXfa([await onePage(false)], run).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'verification-failed',
      details: { engineMessage: '3 pages written, 1 expected' },
    });
  });

  it('refuses a text layer that does not hold the words it was given', async () => {
    state.pageText = 'something else';
    const failure = await buildFlattenedXfa([await onePage(true)], run).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'verification-failed',
      details: { pageIndex: 0, engineMessage: 'the text layer does not hold "Merhaba"' },
    });
  });

  it('accepts the file when the layer holds the sampled word', async () => {
    state.pageText = 'Merhaba';
    const out = await buildFlattenedXfa([await onePage(true)], run);
    expect(out.report.steps).toEqual(['xfa.flatten', 'ocr.layer', 'verify', 'save']);
  });

  it('maps an engine failure while reading the file back to a tool error', async () => {
    state.loadPageError = new Error('page tree is damaged');
    const failure = await buildFlattenedXfa([await onePage(false)], run).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: 'ToolError',
      details: { engine: 'mupdf', engineMessage: 'xfa.verify: page tree is damaged' },
    });
  });
});
