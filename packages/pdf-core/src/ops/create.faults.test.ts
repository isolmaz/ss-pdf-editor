/**
 * A failure of the engine while the blank document is built reaches the caller as a tool error
 * that names the operation, and the half-built document is released. The real engine builds
 * what it is told to, so its `PDFDocument` is wrapped at the loading seam: one page insertion
 * fails.
 */

import type { PDFDocument } from 'mupdf';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ destroyed: 0 }));

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      return new Proxy(real, {
        get(target, property) {
          if (property !== 'PDFDocument') return Reflect.get(target, property, target);
          return new Proxy(target.PDFDocument, {
            construct(Document) {
              const document: PDFDocument = new Document();
              return new Proxy(document, {
                get(own, name) {
                  if (name === 'insertPage') {
                    return () => {
                      throw new Error('cannot insert page');
                    };
                  }
                  if (name === 'destroy') {
                    return () => {
                      state.destroyed += 1;
                      own.destroy();
                    };
                  }
                  const value: unknown = Reflect.get(own, name, own);
                  return typeof value === 'function' ? value.bind(own) : value;
                },
              });
            },
          });
        },
      });
    },
  };
});

const { createBlankDocument } = await import('./create');

describe('createBlankDocument when the engine fails', () => {
  it('maps the failure to a tool error naming the operation and releases the document', async () => {
    const failure = await createBlankDocument(
      { size: 'a4', orientation: 'portrait', pageCount: 1 },
      { signal: new AbortController().signal },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: 'ToolError',
      details: { engine: 'mupdf', engineMessage: 'createBlankDocument: cannot insert page' },
    });
    expect(state.destroyed).toBe(1);
  });
});
