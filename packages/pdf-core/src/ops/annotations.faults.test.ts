/**
 * The annotation helpers that read a file with MuPDF map an engine failure to the error a caller can act on.
 * The real engine does not fail on a valid file, so these tests wrap it at its loading seam (the
 * same seam `structure.faults.test.ts` uses): one method of the document being read throws, and
 * everything else is real.
 */

import type { PDFDocument } from 'mupdf';
import { PDFDocument as BuilderDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** Runs on the document being written, just before it is saved. */
  tamper?: (document: PDFDocument) => void;
  /** A method of the document that throws when called. */
  trap?: { readonly method: string; readonly error: unknown };
  /** What the n-th `loadMupdf` call (1-based) rejects with. */
  failLoad: Map<number, unknown>;
  loads: number;
}
const state: Plan = { failLoad: new Map(), loads: 0 };

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      state.loads += 1;
      if (state.failLoad.has(state.loads)) throw state.failLoad.get(state.loads);
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
            if (property === 'setMetaData') {
              return (...args: Parameters<PDFDocument['setMetaData']>) => {
                state.tamper?.(target);
                return target.setMetaData(...args);
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

const { markerFor, markerTargets, readAnnotations } = await import('./annotations');
const { openWithPdfjs } = await import('../engines/pdfjs-handle');

afterEach(() => {
  state.tamper = undefined;
  state.trap = undefined;
  state.failLoad = new Map();
  state.loads = 0;
});

const RUN = { signal: new AbortController().signal };

/** One page holding a square the app named. */
function fixture(): Uint8Array {
  const doc = new BuilderDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  doc.findPage(0).put('Annots', [
    doc.addObject({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [10, 10, 50, 50],
      NM: doc.newString(markerFor('s1')),
    }),
  ]);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

async function rejectionOf(promise: Promise<unknown>): Promise<ToolError> {
  let outcome: { readonly error: unknown } | null = null;
  try {
    await promise;
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call resolved instead of rejecting');
  if (!isToolError(outcome.error)) throw outcome.error;
  return outcome.error;
}

describe('an engine failure while the file is scanned', () => {
  it('is mapped for the marker lookup, naming the step', async () => {
    state.trap = { method: 'countPages', error: new Error('page tree is damaged') };
    const error = await rejectionOf(markerTargets(fixture(), [{ pageIndex: 0, id: 's1' }], RUN));
    expect(error.details.engine).toBe('mupdf');
    expect(error.details.engineMessage).toBe('annotations.markers: page tree is damaged');
  });

  it('is mapped for the name lookup behind a listing, naming the step', async () => {
    const handle = await openWithPdfjs(fixture());
    try {
      state.trap = { method: 'countPages', error: new Error('page tree is damaged') };
      const error = await rejectionOf(readAnnotations(handle, RUN));
      expect(error.details.engineMessage).toBe('annotations.names: page tree is damaged');
    } finally {
      handle.destroy();
    }
  });
});
