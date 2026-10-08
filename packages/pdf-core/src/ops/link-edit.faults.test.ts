/**
 * Link edits verify the file they wrote by re-opening it. A valid write never fails that check,
 * so these tests wrap MuPDF at its loading seam (the seam `structure.faults.test.ts` uses):
 * the re-opened document is made to fail, miscount pages or miscount links, and a method of
 * the edited document throws. Everything else is real.
 */

import type { PDFDocument } from 'mupdf';
import { PDFDocument as BuilderDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** Runs on the document being written, just before it is saved. */
  tamper?: (document: PDFDocument) => void;
  /** What the n-th opened document (1-based) answers instead of the real method. */
  override?: {
    readonly document: number;
    readonly method: string;
    readonly value: (target: PDFDocument) => unknown;
  };
  opened: number;
  /** A method of the document that throws when called. */
  trap?: { readonly method: string; readonly error: unknown };
  /** What the n-th `loadMupdf` call (1-based) rejects with. */
  failLoad: Map<number, unknown>;
  loads: number;
}
const state: Plan = { failLoad: new Map(), loads: 0, opened: 0 };

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      state.loads += 1;
      if (state.failLoad.has(state.loads)) throw state.failLoad.get(state.loads);
      const real = await import('mupdf');
      const wrapDocument = (document: PDFDocument): PDFDocument => {
        state.opened += 1;
        const ordinal = state.opened;
        const proxy: PDFDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'asPDF') return () => proxy;
            if (property === state.trap?.method) {
              return () => {
                throw state.trap?.error;
              };
            }
            if (state.override?.document === ordinal && property === state.override.method) {
              return state.override.value(target);
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

const { applyLinkEdit } = await import('./link-edit');

afterEach(() => {
  state.tamper = undefined;
  state.trap = undefined;
  state.override = undefined;
  state.failLoad = new Map();
  state.loads = 0;
  state.opened = 0;
});

const RUN = { signal: new AbortController().signal };
const web = { kind: 'uri', uri: 'https://example.com' } as const;

function twoPages(): Uint8Array {
  const doc = new BuilderDocument();
  for (const index of [0, 1]) doc.insertPage(index, doc.addPage([0, 0, 200, 300], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const addOne = { add: [{ target: { pageIndex: 0, rect: [10, 10, 50, 30] }, destination: web }] } as const;

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

describe('verification of the written link file', () => {
  it.each([
    ['an Error', new Error('xref is broken'), 'xref is broken'],
    ['a bare string', 'gone', 'gone'],
  ])('reports a file that does not re-open, failing with %s', async (_name, failure, message) => {
    state.failLoad.set(2, failure);
    const error = await refusal(applyLinkEdit(twoPages(), addOne, RUN));
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe(`produced file does not re-open: ${message}`);
  });

  it('reports a file that came back with another page count', async () => {
    state.override = { document: 2, method: 'countPages', value: (target) => () => target.countPages() + 1 };
    const error = await refusal(applyLinkEdit(twoPages(), addOne, RUN));
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe('produced file has 3 pages, expected 2');
  });

  it('reports a page that came back with another number of links', async () => {
    // The re-opened document answers page 1 with page 2, which carries no link.
    state.override = { document: 2, method: 'findPage', value: (target) => () => target.findPage(1) };
    const error = await refusal(applyLinkEdit(twoPages(), addOne, RUN));
    expect(error.code).toBe('verification-failed');
    expect(error.details.pageIndex).toBe(0);
    expect(error.details.engineMessage).toBe('page 1 carries 0 link annotations, expected 1');
  });
});

describe('an engine failure while links are edited', () => {
  it('is mapped, naming the step', async () => {
    state.trap = { method: 'addObject', error: new Error('out of memory') };
    const error = await refusal(applyLinkEdit(twoPages(), addOne, RUN));
    expect(error.details.engineMessage).toBe('edit links: out of memory');
  });

  it('lets an abort through unchanged', async () => {
    const controller = new AbortController();
    const abort = new DOMException('aborted', 'AbortError');
    state.trap = { method: 'addObject', error: abort };
    await expect(applyLinkEdit(twoPages(), addOne, { signal: controller.signal })).rejects.toBe(abort);
  });
});
