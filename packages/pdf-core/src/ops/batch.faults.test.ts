/**
 * The page count of an item is measured through the MuPDF writer base. The real engine
 * answers for any document it opens, so this test wraps it at its loading seam (as
 * `security.faults.test.ts` does): the bytes are real, but the first document the run
 * opens cannot count its pages. The item must fail with the engine's mapped code and the
 * call site named, and the run must go on.
 */

import type { PDFDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state: { failCountOn: number; opened: number } = { failCountOn: -1, opened: 0 };

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      const documents = new Proxy(real.PDFDocument, {
        get(target, property) {
          if (property !== 'openDocument') return Reflect.get(target, property, target);
          return (...args: Parameters<typeof real.PDFDocument.openDocument>) => {
            const opened = real.PDFDocument.openDocument(...args);
            const index = state.opened;
            state.opened += 1;
            if (index !== state.failCountOn) return opened;
            const proxy: PDFDocument = new Proxy(opened as PDFDocument, {
              get(document, name) {
                if (name === 'asPDF') return () => proxy;
                if (name === 'countPages') {
                  return () => {
                    throw new Error('the page tree is damaged');
                  };
                }
                const value: unknown = Reflect.get(document, name, document);
                return typeof value === 'function' ? value.bind(document) : value;
              },
            });
            return proxy;
          };
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

const { runBatch } = await import('./batch');

afterEach(() => {
  state.failCountOn = -1;
  state.opened = 0;
});

async function onePage(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('runBatch page count measurement', () => {
  it('fails the item with the mapped engine error when the page count cannot be read, then goes on', async () => {
    const bytes = await onePage();
    // Opens made while building the fixture do not count: the plan starts at the run.
    state.opened = 0;
    state.failCountOn = 0;
    const report = await runBatch(
      [
        { name: 'broken.pdf', bytes },
        { name: 'fine.pdf', bytes },
      ],
      {
        version: 1,
        name: 'text',
        steps: [{ kind: 'text-export', params: { pages: 'all', format: 'text', baseName: 'x' } }],
      },
      { signal: new AbortController().signal },
    );
    expect(report.results[0]).toMatchObject({
      status: 'failed',
      name: 'broken.pdf',
      code: 'corrupt-document',
      step: 'text-export',
      detail: 'measure page count: the page tree is damaged',
    });
    expect(report.completed).toEqual(['fine.pdf']);
  });
});
