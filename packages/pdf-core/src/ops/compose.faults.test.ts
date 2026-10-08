/**
 * Composition and merge read the file they produce and measure its structure. The real engine
 * writes what pdf.js composed, so these tests wrap MuPDF at its loading seam (the same seam
 * `structure.faults.test.ts` uses): the merged document is damaged in one chosen way just
 * before the structure is measured, or one call of the engine fails, and everything else is real.
 */

import type { PDFDocument } from 'mupdf';
import { PDFDocument as BuilderDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** Runs on the document being written, just before it is saved. */
  tamper?: (document: PDFDocument) => void;
  /** Runs on the document being written, right after each page-label range is written to it. */
  afterLabels?: (document: PDFDocument) => void;
  /** A method of the document that throws when called. */
  trap?: { readonly method: string; readonly error: unknown };
  /** What `countPages` answers instead of the real count. */
  pageCount?: number;
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
            if (property === 'countPages' && state.pageCount !== undefined) return () => state.pageCount;
            if (property === state.trap?.method) {
              return () => {
                throw state.trap?.error;
              };
            }
            if (property === 'setPageLabels') {
              return (...args: Parameters<PDFDocument['setPageLabels']>) => {
                target.setPageLabels(...args);
                state.afterLabels?.(target);
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

const { composeDocument, mergeDocuments } = await import('./compose');
const { openWithPdfjs } = await import('../engines/pdfjs-handle');

afterEach(() => {
  state.tamper = undefined;
  state.afterLabels = undefined;
  state.trap = undefined;
  state.pageCount = undefined;
  state.failLoad = new Map();
  state.loads = 0;
});

const RUN = { signal: new AbortController().signal };

/** `count` blank pages; a title makes the merge write the base's Info, which is when MuPDF is told to set it. */
function pages(count: number, title?: string, build?: (doc: BuilderDocument) => void): Uint8Array {
  const doc = new BuilderDocument();
  for (let index = 0; index < count; index += 1)
    doc.insertPage(index, doc.addPage([0, 0, 100, 100], 0, {}, ''));
  if (title !== undefined) doc.setMetaData('info:Title', title);
  build?.(doc);
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

/** A merge of one titled page with one more, run once with `tamper` applied before the measurement. */
async function merged(tamper?: (doc: PDFDocument) => void, build?: (doc: BuilderDocument) => void) {
  let done = false;
  state.tamper = (doc) => {
    if (done) return;
    done = true;
    tamper?.(doc);
  };
  return mergeDocuments(
    { bytes: pages(1, 'Başlık', build), pageCount: 1 },
    [{ name: 'ek.pdf', bytes: pages(1), pageCount: 1 }],
    0,
    RUN,
  );
}

const structureOf = (out: {
  readonly report: { readonly notes: readonly { readonly key: string; readonly params?: unknown }[] };
}) => out.report.notes.find((entry) => entry.key === 'op.note.merge.structure')?.params;

describe('the structure a merge measures in the file it produced', () => {
  it('counts outline items through children and siblings, and stops at a sibling cycle', async () => {
    const out = await merged((doc) => {
      const root = doc.getTrailer().get('Root');
      const first = doc.addObject({ Title: doc.newString('A') });
      const second = doc.addObject({ Title: doc.newString('B'), Next: first });
      first.put('Next', second);
      first.put('First', { Title: doc.newString('A.1') });
      root.put('Outlines', doc.addObject({ Type: doc.newName('Outlines'), First: first, Last: second }));
    });
    // A, its direct child and B: the `/Next` back to A ends the walk.
    expect(structureOf(out)).toMatchObject({ outline: 3 });
  });

  it('counts page-label ranges over a number tree with kids, a cycle and a kid that is no dictionary', async () => {
    const out = await merged((doc) => {
      const root = doc.getTrailer().get('Root');
      const style = doc.newName('D');
      const tree = doc.addObject({});
      const head = doc.addObject({ Nums: [0, { S: style }] });
      const kid = doc.addObject({ Nums: [1, { S: style }, 2, { S: style }] });
      kid.put('Kids', [kid, 7, { Nums: [5, { S: style }] }]);
      tree.put('Kids', [head, kid, kid]);
      root.put('PageLabels', tree);
    });
    expect(structureOf(out)).toMatchObject({ labels: 4 });
  });

  it('counts the fields of a form, and none for a form without /Fields', async () => {
    const withFields = await merged((doc) => {
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', {
          Fields: [doc.addObject({ T: doc.newString('a') }), doc.addObject({ T: doc.newString('b') })],
        });
    });
    expect(structureOf(withFields)).toMatchObject({ fields: 2 });
    const bare = await merged((doc) =>
      doc.getTrailer().get('Root').put('AcroForm', { NeedAppearances: true }),
    );
    expect(structureOf(bare)).toMatchObject({ fields: 0 });
  });

  it('says the outline was lost when the file it produced has less of it than the base had', async () => {
    const out = await merged(
      (doc) => doc.getTrailer().get('Root').delete('Outlines'),
      (doc) => {
        const item = doc.addObject({
          Title: doc.newString('Giriş'),
          Dest: [doc.findPage(0), doc.newName('Fit')],
        });
        doc
          .getTrailer()
          .get('Root')
          .put('Outlines', doc.addObject({ Type: doc.newName('Outlines'), First: item, Last: item }));
      },
    );
    expect(out.report.notes.find((entry) => entry.key === 'op.note.merge.outlineLost')?.params).toEqual({
      expected: 1,
      actual: 0,
    });
  });
});

describe('the page labels a merge writes are checked against the plan', () => {
  it('says the labels were lost when the file holds fewer ranges than were planned', async () => {
    state.afterLabels = (doc) => doc.getTrailer().get('Root').delete('PageLabels');
    const out = await merged(undefined, (doc) => doc.setPageLabels(0, 'D', 'A-', 1));
    // `A-1` on the base page, then the added page counting on its own from `1`: two ranges.
    expect(out.report.notes.find((entry) => entry.key === 'op.note.merge.labelsLost')?.params).toEqual({
      expected: 2,
      actual: 0,
    });
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.merge.labels');
  });
});

describe('an engine failure while composing or merging', () => {
  it('refuses a merged document whose page count is not the one planned', async () => {
    state.pageCount = 5;
    const error = await refusal(merged());
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe('merged document has 5 pages, expected 2');
  });

  it('maps an engine failure of the merge, naming the step', async () => {
    state.trap = { method: 'countPages', error: new Error('page tree is damaged') };
    const error = await refusal(merged());
    expect(error.details.engineMessage).toBe('mergeDocuments: page tree is damaged');
  });

  it('maps an engine failure while the composed page count is read back', async () => {
    const handle = await openWithPdfjs(pages(2));
    try {
      state.trap = { method: 'countPages', error: new Error('page tree is damaged') };
      const error = await refusal(
        composeDocument({ sources: [{ pages: [0] }], pageCount: 1 }, handle.raw, RUN),
      );
      expect(error.details.engineMessage).toBe('composeDocument.verify: page tree is damaged');
    } finally {
      await handle.destroy();
    }
  });
});
