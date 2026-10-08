/**
 * The check that reads a written layer file back, and a document the engine hands over without a
 * catalog. The real engine writes what it is told to, so these tests wrap it at its seams (as
 * `image-edit.faults.test.ts` and `metadata.faults.test.ts` do): the bytes `saveRewrite` produces
 * can be swapped for a damaged file, and the opened document's trailer can answer `/Root` with
 * nothing. The input, the edit and the second reader are real.
 */

import type { PDFDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  noRoot?: boolean;
  /** The bytes the check reads instead of the ones the write produced. */
  damaged?: Uint8Array;
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
            if (property === 'getTrailer' && state.noRoot === true) {
              return () =>
                new Proxy(target.getTrailer(), {
                  get(trailer, key) {
                    if (key === 'get')
                      return (name: string) => trailer.get(name === 'Root' ? 'NoSuchKey' : name);
                    const value: unknown = Reflect.get(trailer, key, trailer);
                    return typeof value === 'function' ? value.bind(trailer) : value;
                  },
                });
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

vi.mock('../engines/mupdf-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf-write')>();
  return {
    ...actual,
    saveRewrite: (...args: Parameters<typeof actual.saveRewrite>) => {
      const produced = actual.saveRewrite(...args);
      return state.damaged ?? produced;
    },
  };
});

const { applyLayerWrite } = await import('./layer-write');
const { layerPdf } = await import('./layer-write.fixtures');

const run = { signal: new AbortController().signal };
const config = (body: string) => layerPdf({ config: `<<${body}>>` });
const input = () => config('/ON[10 0 R]/OFF[11 0 R]/Order[10 0 R 11 0 R 12 0 R]');

afterEach(() => {
  state.noRoot = undefined;
  state.damaged = undefined;
});

describe('a document with no /Root', () => {
  it('is refused as having no optional content, which is all a writer can say about it', async () => {
    state.noRoot = true;
    await expect(
      applyLayerWrite(input(), { states: [{ name: 'A', visible: false }] }, run),
    ).rejects.toMatchObject({ code: 'unsupported', details: { path: '/Root/OCProperties' } });
  });
});

describe('the read-back of the written file', () => {
  const states = (name: string, visible: boolean) => ({ states: [{ name, visible }] });
  const failure = (message: string | RegExp) => ({
    code: 'verification-failed',
    details: {
      engine: 'mupdf',
      engineMessage: typeof message === 'string' ? message : expect.stringMatching(message),
    },
  });

  it('refuses output that does not open, keeping the engine error as the cause', async () => {
    state.damaged = new Uint8Array([1, 2, 3]);
    await expect(applyLayerWrite(input(), states('A', false), run)).rejects.toMatchObject({
      ...failure(/^produced file does not re-open: /),
      cause: expect.any(Error),
    });
  });

  it('refuses output with a different page count', async () => {
    state.damaged = layerPdf({ pages: 2 });
    await expect(applyLayerWrite(input(), states('A', false), run)).rejects.toMatchObject(
      failure('produced file has 2 pages, expected 1'),
    );
  });

  it('refuses output that lost its optional content, naming why', async () => {
    state.damaged = layerPdf({ ocProperties: false });
    await expect(applyLayerWrite(input(), states('A', false), run)).rejects.toMatchObject({
      ...failure(
        /^produced file has no readable layer properties: \[unsupported\] mupdf: the document has no optional content/,
      ),
      cause: expect.objectContaining({ code: 'unsupported' }),
    });
  });

  it('refuses a layer that is on in the file when it was asked off, and the reverse', async () => {
    state.damaged = input();
    await expect(applyLayerWrite(input(), states('A', false), run)).rejects.toMatchObject(
      failure('layer "A" is on in the produced file, expected off'),
    );
    await expect(applyLayerWrite(input(), states('B', true), run)).rejects.toMatchObject(
      failure('layer "B" is off in the produced file, expected on'),
    );
  });

  it('refuses a layer listed in both arrays, whichever way it was asked', async () => {
    state.damaged = config('/ON[10 0 R 11 0 R]/OFF[10 0 R 11 0 R]');
    await expect(applyLayerWrite(input(), states('B', true), run)).rejects.toMatchObject(
      failure('layer "B" is on in the produced file, expected on'),
    );
    await expect(applyLayerWrite(input(), states('A', false), run)).rejects.toMatchObject(
      failure('layer "A" is on in the produced file, expected off'),
    );
  });

  it('refuses an /Order that does not start with what was asked, or whose groups have gone', async () => {
    state.damaged = input();
    await expect(applyLayerWrite(input(), { order: ['C', 'A'] }, run)).rejects.toMatchObject(
      failure('the produced /Order does not carry "C" at position 1'),
    );
    state.damaged = layerPdf({ ocgs: '[10 0 R 11 0 R]', config: '<</Order[10 0 R 11 0 R]>>' });
    await expect(applyLayerWrite(input(), { order: ['A', 'C'] }, run)).rejects.toMatchObject(
      failure('the produced /Order does not carry "C" at position 2'),
    );
  });

  it('refuses output in which no group carries the new name', async () => {
    state.damaged = input();
    await expect(applyLayerWrite(input(), { rename: { from: 'A', to: 'X' } }, run)).rejects.toMatchObject(
      failure('no optional content group carries the new name "X"'),
    );
  });
});
