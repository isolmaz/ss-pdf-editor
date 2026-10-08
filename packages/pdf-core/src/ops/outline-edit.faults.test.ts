/**
 * Outline edits verify the file they wrote by re-opening and reading the outline back. A valid
 * write never fails that check, so these tests wrap MuPDF at its loading seam (the seam
 * `structure.faults.test.ts` uses): the re-opened document is made to fail, miscount pages or
 * carry a different outline, and the catalog of the edited one is made to vanish. Everything
 * else is real.
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

const { applyOutlineEdit } = await import('./outline-edit');

afterEach(() => {
  state.tamper = undefined;
  state.trap = undefined;
  state.override = undefined;
  state.failLoad = new Map();
  state.loads = 0;
  state.opened = 0;
});

const RUN = { signal: new AbortController().signal };

/** One page and, when `title` is given, an outline of that single item. */
function document(title?: string): Uint8Array {
  const doc = new BuilderDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 300], 0, {}, ''));
  if (title !== undefined) {
    const outlines = doc.addObject({ Type: 'Outlines' });
    const item = doc.addObject({ Title: doc.newString(title), Parent: outlines });
    outlines.put('First', item);
    outlines.put('Last', item);
    outlines.put('Count', 1);
    doc.getTrailer().get('Root').resolve().put('Outlines', outlines);
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const addOne = { kind: 'add-child', parentPath: [], node: { title: 'Yeni', destination: null } } as const;

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

/** The re-opened document answers `getTrailer` after `change` has been made to it. */
function reopenedWith(
  change: (catalog: ReturnType<PDFDocument['getTrailer']>, doc: PDFDocument) => void,
): void {
  state.override = {
    document: 2,
    method: 'getTrailer',
    value: (target) => () => {
      const trailer = target.getTrailer();
      change(trailer.get('Root').resolve(), target);
      return trailer;
    },
  };
}

describe('a document without a catalog', () => {
  it('is refused as corrupt', async () => {
    state.override = {
      document: 1,
      method: 'getTrailer',
      value: (target) => () =>
        new Proxy(target.getTrailer(), {
          get: (trailer, property) =>
            property === 'get'
              ? (key: string) => (key === 'Root' ? target.newNull() : trailer.get(key))
              : Reflect.get(trailer, property, trailer),
        }),
    };
    const error = await refusal(applyOutlineEdit(document(), addOne, RUN));
    expect(error.code).toBe('corrupt-document');
    expect(error.details.engineMessage).toBe('no /Root');
  });
});

describe('verification of the written outline', () => {
  it.each([
    ['an Error', new Error('xref is broken'), 'xref is broken'],
    ['a bare string', 'gone', 'gone'],
  ])('reports a file that does not re-open, failing with %s', async (_name, failure, message) => {
    state.failLoad.set(2, failure);
    const error = await refusal(applyOutlineEdit(document(), addOne, RUN));
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe(`produced file does not re-open: ${message}`);
    expect(error.cause).toBe(failure);
  });

  it('reports a file that came back with another page count', async () => {
    state.override = { document: 2, method: 'countPages', value: (target) => () => target.countPages() + 1 };
    const error = await refusal(applyOutlineEdit(document(), addOne, RUN));
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe('produced file has 2 pages, expected 1');
    expect(error.cause).toBeUndefined();
  });

  it('reports an outline that came back with another number of items', async () => {
    reopenedWith((catalog) => catalog.get('Outlines').resolve().delete('First'));
    const error = await refusal(applyOutlineEdit(document(), addOne, RUN));
    expect(error.details.engineMessage).toBe('produced outline holds 0 items, expected 1');
  });

  it('reports an /Outlines that is still there after the last item was removed', async () => {
    reopenedWith((catalog, doc) => catalog.put('Outlines', doc.addObject(doc.newDictionary())));
    const error = await refusal(applyOutlineEdit(document('Tek'), { kind: 'remove', path: [0] }, RUN));
    expect(error.details.engineMessage).toBe(
      'the produced file still carries /Outlines after the last item was removed',
    );
  });

  it('reports a rename that did not take', async () => {
    reopenedWith((catalog) => catalog.get('Outlines').resolve().get('First').resolve().put('Title', 'eski'));
    const error = await refusal(
      applyOutlineEdit(document('Tek'), { kind: 'rename', path: [0], title: ' Yeni ' }, RUN),
    );
    expect(error.details.engineMessage).toBe(
      'produced outline does not carry the new title "Yeni" at the renamed path',
    );
  });

  it('reports an outline it cannot read back, naming why and keeping the cause', async () => {
    reopenedWith((catalog, doc) => {
      const direct = doc.newDictionary();
      catalog.get('Outlines').resolve().put('First', direct);
    });
    const error = await refusal(
      applyOutlineEdit(document('Tek'), { kind: 'rename', path: [0], title: 'Yeni' }, RUN),
    );
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe(
      'produced outline does not read back: [unsupported] mupdf: /Root/Outlines/First is not an indirect reference; an outline item needs one for its /Parent',
    );
    expect(isToolError(error.cause)).toBe(true);
  });

  it('reports an engine failure that is not an Error while reading back', async () => {
    state.override = {
      document: 2,
      method: 'countPages',
      value: () => () => {
        throw 'boom';
      },
    };
    const error = await refusal(applyOutlineEdit(document(), addOne, RUN));
    expect(error.details.engineMessage).toBe('produced outline does not read back: boom');
    expect(error.cause).toBe('boom');
  });
});
