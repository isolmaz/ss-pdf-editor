/**
 * An engine failure while pages are tidied is mapped to the error a caller can act on. The real
 * engine does not fail on a valid file, so these tests wrap it at its loading seam (the same
 * seam `page-boxes.faults.test.ts` uses): one method of the document throws, and everything
 * else is real.
 */

import type { PDFDocument } from 'mupdf';
import { PDFDocument as BuilderDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state: { trap?: { readonly method: string; readonly error: unknown } } = {};

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
            if (property === state.trap?.method) {
              return () => {
                throw state.trap?.error;
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

const { findBlankPages, splitTwoUpPages } = await import('./page-tidy');

afterEach(() => {
  state.trap = undefined;
});

const RUN = { signal: new AbortController().signal };

function fixture(): Uint8Array {
  const doc = new BuilderDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 200], 0, {}, '0 g 20 10 100 50 re f'));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('an engine failure while pages are tidied', () => {
  it('is mapped, naming the operation, when a page cannot be drawn to be judged', async () => {
    state.trap = { method: 'loadPage', error: new Error('page is damaged') };
    await expect(findBlankPages(fixture(), RUN)).rejects.toMatchObject({
      details: { engine: 'mupdf', engineMessage: 'blank-pages: page is damaged' },
    });
  });

  it('is mapped, naming the operation, when the new page cannot be inserted', async () => {
    state.trap = { method: 'insertPage', error: new Error('page tree is damaged') };
    await expect(splitTwoUpPages(fixture(), [0], RUN)).rejects.toMatchObject({
      details: { engine: 'mupdf', engineMessage: 'split-two-up: page tree is damaged' },
    });
  });
});
