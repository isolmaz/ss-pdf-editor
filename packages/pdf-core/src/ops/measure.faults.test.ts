/**
 * An engine failure while a measurement is written must come out as a mapped error that names the
 * step, not as the engine's own exception. The real engine writes what it is given, so this test
 * wraps it at its loading seam (the one `forms.faults.test.ts` uses): adding the appearance
 * stream throws once, and everything else is real.
 */

import type { PDFDocument } from 'mupdf';
import { describe, expect, it, vi } from 'vitest';

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
            if (property === 'addStream') {
              return () => {
                throw new Error('engine fault');
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

const { scaleForRatio, writeMeasureAnnotations } = await import('./measure');
const { handPdf } = await import('./forms.fixtures');

describe('writeMeasureAnnotations when the engine fails', () => {
  it('reports the failure with the step it happened in', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 500]>>',
    });
    await expect(
      writeMeasureAnnotations(
        bytes,
        [
          {
            id: 'm1',
            pageIndex: 0,
            mode: 'distance',
            points: [
              { x: 10, y: 10 },
              { x: 110, y: 10 },
            ],
            scale: scaleForRatio(100, 'cm'),
            color: '#336699',
            opacity: 1,
            author: 'A',
            contents: '',
            createdAt: '2026-01-02T03:04:05.000Z',
          },
        ],
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ details: { engine: 'mupdf', engineMessage: 'measure.write: engine fault' } });
  });
});
