/**
 * An engine failure while the structure rewrite is saved reaches the caller as a tool error, not a
 * raw engine exception. The real engine saves what it is given, so the document being rewritten
 * is wrapped at the loading seam (as `structure.faults.test.ts` does) and its save fails once.
 */

import type { PDFDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state: { saveError?: unknown } = {};

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
            if (property === 'saveToBuffer' && state.saveError !== undefined) {
              return () => {
                throw state.saveError;
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

const { compressDocument } = await import('./compress');
const { PDFDocument: Doc } = await import('mupdf');

afterEach(() => {
  state.saveError = undefined;
});

describe('compressDocument structure mode engine failures', () => {
  it('maps a failing save to a tool error that names the operation', async () => {
    const doc = new Doc();
    doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    state.saveError = new Error('cannot write xref');
    const failure = await compressDocument(
      bytes,
      { mode: 'structure', stripMetadata: false, keepProducer: true },
      { signal: new AbortController().signal },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: 'ToolError',
      details: { engine: 'mupdf', engineMessage: 'compress: cannot write xref' },
    });
  });
});
