/**
 * Page insertion carries the base document's Info over to the composed file. The real engine
 * does not fail on a valid file, so this test wraps MuPDF at its loading seam (the same seam
 * `structure.faults.test.ts` uses): one method of the document being read throws, and
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

const { insertPages, replacePages } = await import('./page-insert');

afterEach(() => {
  state.tamper = undefined;
  state.trap = undefined;
  state.failLoad = new Map();
  state.loads = 0;
});

const RUN = { signal: new AbortController().signal };

function pages(widths: readonly number[]): Uint8Array {
  const doc = new BuilderDocument();
  for (const [index, width] of widths.entries())
    doc.insertPage(index, doc.addPage([0, 0, width, 300], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
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

describe('an engine failure while the base Info is carried over', () => {
  it('is mapped for an insertion, naming the step', async () => {
    state.trap = { method: 'getMetaData', error: new Error('info is damaged') };
    const error = await refusal(
      insertPages(
        { source: { kind: 'blank', size: 'a4', count: 1 }, at: 0, bytes: pages([200]), pageCount: 1 },
        RUN,
      ),
    );
    expect(error.details.engineMessage).toBe('insertPages.metadata: info is damaged');
  });

  it('is mapped for a replacement, naming the step', async () => {
    state.trap = { method: 'getMetaData', error: new Error('info is damaged') };
    const error = await refusal(
      replacePages(
        {
          bytes: pages([200, 210]),
          pageCount: 2,
          pages: [0],
          replacements: [{ name: 'ek.pdf', bytes: pages([500]), index: 0 }],
        },
        RUN,
      ),
    );
    expect(error.details.engineMessage).toBe('replacePages.metadata: info is damaged');
  });
});
