/**
 * `checkAllObjects` walks every object number of an untrusted file; an object the engine
 * throws on must be skipped, not turn the whole check into an error. The real engine reports
 * unloadable objects as "not a stream" instead of throwing, so these tests wrap it at its
 * loading seam: the bytes are real, but the document handle throws for one chosen object.
 */

import type { PDFDocument } from 'mupdf';
import { describe, expect, it, vi } from 'vitest';

/** Object numbers whose `newIndirect` throws, shared with the mocked engine. */
const state: { broken: number[] } = { broken: [] };

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
            if (property === 'newIndirect') {
              return (number: number) => {
                if (state.broken.includes(number)) throw new Error(`cannot load object ${number}`);
                return target.newIndirect(number);
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

const { checkPdfA } = await import('./pdfa-check');
const mupdf = await import('mupdf');

/** A page plus two LZW streams, with the object numbers they were given. */
function twoLzwStreams(): { bytes: Uint8Array; first: number; second: number } {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, '1 0 0 rg 10 10 100 100 re f'));
  const first = doc.addRawStream(new Uint8Array([1]), { Filter: 'LZWDecode' }).asIndirect();
  const second = doc.addRawStream(new Uint8Array([1]), { Filter: 'LZWDecode' }).asIndirect();
  doc
    .getTrailer()
    .get('Root')
    .put('Extra', [doc.newIndirect(first), doc.newIndirect(second)]);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return { bytes, first, second };
}

const lzwSamples = async (bytes: Uint8Array): Promise<string[]> => {
  const report = await checkPdfA(bytes, { part: 2 });
  return (report.rules.find((entry) => entry.id === 'streams')?.samples ?? []).map(
    (sample) => sample.detail as string,
  );
};

describe('checkPdfA object walk', () => {
  it('reports the LZW stream of every object when the engine loads them all', async () => {
    const { bytes, first, second } = twoLzwStreams();
    state.broken = [];
    expect(await lzwSamples(bytes)).toEqual([`object ${first}: LZW`, `object ${second}: LZW`]);
  });

  it('skips an object the engine throws on and still checks the others', async () => {
    const { bytes, first, second } = twoLzwStreams();
    state.broken = [first];
    try {
      expect(await lzwSamples(bytes)).toEqual([`object ${second}: LZW`]);
    } finally {
      state.broken = [];
    }
  });
});
