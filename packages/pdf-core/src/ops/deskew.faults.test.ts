/**
 * Straightening maps an engine failure to the error a caller can act on. The real engine does not
 * fail on a valid file, so these tests wrap it at its loading seam (the same seam
 * `page-boxes.faults.test.ts` uses): one method of the document being edited throws, and
 * everything else is real.
 */

import type { PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanDocument, tiltedText } from './deskew.fixtures';

interface Plan {
  /** A method of the document that throws when called. */
  trap?: { readonly method: string; readonly error: unknown };
}
const state: Plan = {};

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

const { deskewPages } = await import('./deskew');

afterEach(() => {
  state.trap = undefined;
});

const RUN = { signal: new AbortController().signal };

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

describe('an engine failure while pages are straightened', () => {
  it('is mapped, naming the operation, when a page cannot be drawn for measuring', async () => {
    const input = await scanDocument([{ content: tiltedText(2) }]);
    state.trap = { method: 'loadPage', error: new Error('page is damaged') };
    const error = await refusal(deskewPages(input, { pages: [0] }, RUN));
    expect(error.details.engine).toBe('mupdf');
    expect(error.details.engineMessage).toBe('deskew: page is damaged');
  });

  it('is mapped, naming the operation, when the content cannot be wrapped', async () => {
    const input = await scanDocument([{ content: tiltedText(2) }]);
    state.trap = { method: 'newArray', error: new Error('out of memory') };
    const error = await refusal(deskewPages(input, { pages: [0] }, RUN));
    expect(error.details.engineMessage).toBe('deskew: out of memory');
  });
});
