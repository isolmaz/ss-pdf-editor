/**
 * Measurement annotations, against real bytes. The wrong answers that matter: a line
 * whose endpoints land somewhere else than they were drawn, a measure dictionary that
 * loses its ratio or its unit, a Turkish comment mangled, and a polygon written without
 * its vertices.
 */

import { describe, expect, it } from 'vitest';
import { type MeasureMark, scaleForRatio, writeMeasureAnnotations } from './measure';

const run = { signal: new AbortController().signal };

async function blank(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function mark(overrides: Partial<MeasureMark> & Pick<MeasureMark, 'id' | 'mode' | 'points'>): MeasureMark {
  return {
    pageIndex: 0,
    scale: scaleForRatio(100, 'cm'),
    color: '#ff0000',
    opacity: 1,
    author: 'Ayşe',
    contents: 'Çatı alanı',
    createdAt: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

/** Every annotation's subtype, geometry, comment and measure dictionary, as MuPDF reads them. */
async function read(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const annots = doc.findPage(0).get('Annots').resolve();
    const numbers = (value: import('mupdf').PDFObject) => {
      if (value.isNull()) return null;
      const array = value.resolve();
      return Array.from({ length: array.length }, (_unused, index) => array.get(index).asNumber());
    };
    return Array.from({ length: annots.length }, (_unused, index) => {
      const dict = annots.get(index).resolve();
      const measure = dict.get('Measure').resolve();
      return {
        subtype: dict.get('Subtype').asName(),
        line: numbers(dict.get('L')),
        vertices: numbers(dict.get('Vertices')),
        contents: dict.get('Contents').asString(),
        ratio: numbers(measure.get('R')),
        unit: measure.get('X').resolve().get('U').asString(),
        appearance: dict.get('AP').resolve().get('N').isStream(),
      };
    });
  } finally {
    doc.destroy();
  }
}

describe('writeMeasureAnnotations', () => {
  it('writes a distance and an area where they were drawn, with their scale, unit and comment', async () => {
    const out = await writeMeasureAnnotations(
      await blank(),
      [
        mark({
          id: 'd',
          mode: 'distance',
          points: [
            { x: 50, y: 100 },
            { x: 250, y: 100 },
          ],
        }),
        mark({
          id: 'a',
          mode: 'area',
          points: [
            { x: 50, y: 200 },
            { x: 150, y: 200 },
            { x: 150, y: 300 },
          ],
        }),
      ],
      run,
    );
    const [distance, area] = await read(out.bytes);
    // App space is top-left: y = 100 on a 500-high page is 400 in the file.
    expect(distance).toMatchObject({
      subtype: 'Line',
      line: [50, 400, 250, 400],
      ratio: [1, 100],
      unit: 'cm',
      appearance: true,
    });
    expect(distance?.contents).toContain('Çatı alanı');
    expect(area).toMatchObject({
      subtype: 'Polygon',
      vertices: [50, 300, 150, 300, 150, 200],
      ratio: [1, 100],
      // An area is read in square units of the scale's unit.
      unit: 'cm²',
      appearance: true,
    });
    expect(out.written).toHaveLength(2);
  });

  it('paints the ruler and the outline where they were drawn, in the mark colour', async () => {
    const out = await writeMeasureAnnotations(
      await blank(),
      [
        mark({
          id: 'd',
          mode: 'distance',
          points: [
            { x: 50, y: 100 },
            { x: 250, y: 100 },
          ],
        }),
        mark({
          id: 'a',
          mode: 'area',
          points: [
            { x: 50, y: 200 },
            { x: 150, y: 200 },
            { x: 150, y: 300 },
          ],
        }),
      ],
      run,
    );
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const pixels = pixmap.getPixels();
      const width = pixmap.getWidth();
      /** Whether a red-tinted pixel lies within one pixel of the point (a hairline antialiases to pink). */
      const red = (x: number, y: number): boolean => {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const at = ((y + dy) * width + x + dx) * pixmap.getNumberOfComponents();
            if ((pixels[at] ?? 0) > 200 && (pixels[at] ?? 0) - (pixels[at + 1] ?? 255) > 60) return true;
          }
        }
        return false;
      };
      // The ruler runs along y = 100 from x = 50 to 250, and ends there.
      expect([red(60, 100), red(150, 100), red(245, 100)]).toEqual([true, true, true]);
      expect([red(150, 90), red(150, 110), red(280, 100)]).toEqual([false, false, false]);
      // The polygon's three edges: top, right and the hypotenuse; nothing outside the triangle.
      expect([red(100, 200), red(150, 250), red(100, 250)]).toEqual([true, true, true]);
      expect([red(60, 290), red(100, 280), red(200, 250)]).toEqual([false, false, false]);
    } finally {
      doc.destroy();
    }
  });

  it('refuses a mark on a page the document does not have', async () => {
    await expect(
      writeMeasureAnnotations(
        await blank(),
        [
          mark({
            id: 'x',
            mode: 'distance',
            pageIndex: 3,
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
            ],
          }),
        ],
        run,
      ),
    ).rejects.toMatchObject({ code: 'selection-empty' });
  });
});
