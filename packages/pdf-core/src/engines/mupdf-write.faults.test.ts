/**
 * Two engine behaviours of the font writer that a real font file does not show on demand: a font
 * MuPDF loads but whose metric tables the text engine's reader refuses, and a subsetting pass that
 * leaves a face without its font program. The first replaces the metric reader at its import, the
 * second hands the writer a MuPDF whose scratch document does the subsetting wrongly.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PDFObject } from 'mupdf';
import { isToolError } from 'pdf-shared';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ metricsFail: false }));

vi.mock('pdf-text-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdf-text-engine')>();
  return {
    ...actual,
    metricsFor: (...args: Parameters<typeof actual.metricsFor>) => {
      if (state.metricsFail) throw new Error('hhea table is unreadable');
      return actual.metricsFor(...args);
    },
  };
});

const { loadMupdf } = await import('./mupdf');
const { embedFontFile, subsetEmbeddedFaces } = await import('./mupdf-write');

function notoRegular(): Uint8Array<ArrayBuffer> {
  const file = createRequire(import.meta.url).resolve(
    '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
    { paths: [process.cwd()] },
  );
  return new Uint8Array(readFileSync(file));
}

describe('embedFontFile', () => {
  it('reports a font whose metrics cannot be read as an unsupported format, keeping the cause', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    state.metricsFail = true;
    try {
      embedFontFile(mupdf, doc, 'Odd', notoRegular());
      throw new Error('expected a failure');
    } catch (error) {
      expect(isToolError(error) && error.code).toBe('unsupported-format');
      expect(isToolError(error) && error.details.engineMessage).toBe(
        'embed-font: Odd has no readable metrics',
      );
      expect(error instanceof Error && (error.cause as Error).message).toBe('hhea table is unreadable');
    } finally {
      state.metricsFail = false;
      doc.destroy();
    }
  });
});

/** A MuPDF whose scratch document, after `subsetFonts`, has `damage` done to every font descriptor. */
function damagingMupdf(real: Awaited<ReturnType<typeof loadMupdf>>, damage: (descriptor: PDFObject) => void) {
  return new Proxy(real, {
    get(target, property) {
      if (property !== 'PDFDocument') return Reflect.get(target, property, target);
      return new Proxy(target.PDFDocument, {
        construct(Scratch) {
          const scratch = new Scratch();
          return new Proxy(scratch, {
            get(own, name) {
              if (name === 'subsetFonts') {
                return () => {
                  own.subsetFonts();
                  for (let index = 1; index < own.countObjects(); index += 1) {
                    const object = own.newIndirect(index).resolve();
                    if (object.isDictionary() && !object.get('FontFile2').isNull()) damage(object);
                  }
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
}

describe('subsetEmbeddedFaces', () => {
  async function embedded() {
    const real = await loadMupdf();
    const doc = new real.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    const face = embedFontFile(real, doc, 'Noto', notoRegular());
    face.encode('ab');
    return { real, doc, face };
  }

  it('keeps the whole program when the subsetting pass leaves the face without one', async () => {
    const { real, doc, face } = await embedded();
    const forgetful = damagingMupdf(real, (descriptor) => descriptor.delete('FontFile2'));
    expect(subsetEmbeddedFaces(forgetful, doc, [face])).toBe(0);
    doc.destroy();
  });

  it('keeps the subset program under its old name when the pass names no font', async () => {
    const { real, doc, face } = await embedded();
    const nameless = damagingMupdf(real, (descriptor) => descriptor.delete('FontName'));
    expect(subsetEmbeddedFaces(nameless, doc, [face])).toBeGreaterThan(100_000);
    doc.destroy();
  });
});
