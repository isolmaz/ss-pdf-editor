/**
 * A catalog is something MuPDF guarantees on open (it repairs or refuses a file without one), so
 * "no /Root" is an engine fault no file reaches. This test wraps the engine at its loading seam
 * (the one `forms.faults.test.ts` uses): the opened document's trailer answers `/Root` with
 * nothing, and the reader and the writer must report the fault as an error that says what failed.
 */

import type { PDFDocument } from 'mupdf';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      const wrapDocument = (document: PDFDocument): PDFDocument => {
        const proxy: PDFDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'asPDF') return () => proxy;
            if (property === 'getTrailer') {
              return () =>
                new Proxy(target.getTrailer(), {
                  get(trailer, key) {
                    if (key === 'get')
                      return (name: string) => trailer.get(name === 'Root' ? 'NoSuchKey' : name);
                    const value: unknown = Reflect.get(trailer, key, trailer);
                    return typeof value === 'function' ? value.bind(trailer) : value;
                  },
                });
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
              wrapDocument(real.PDFDocument.openDocument(...args) as PDFDocument);
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

const { readMetadata, writeMetadata } = await import('./metadata');
const { handPdf } = await import('./forms.fixtures');

const bytes = () =>
  handPdf({
    1: '<</Type/Catalog/Pages 2 0 R>>',
    2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>',
  });
const internal = { code: 'internal', details: { engine: 'mupdf', engineMessage: 'no /Root' } };

describe('metadata of a document with no /Root', () => {
  it('is reported by the reader as an internal error', async () => {
    await expect(readMetadata(bytes())).rejects.toMatchObject(internal);
  });

  it('is reported by the writer as an internal error when it has to reach the catalog', async () => {
    await expect(
      writeMetadata(
        bytes(),
        { patch: { title: 'T', writeXmp: true }, clean: false, cleanXmp: false },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject(internal);
  });
});
