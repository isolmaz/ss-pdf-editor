/**
 * The annotation writers the engine has no writer for, against real bytes and read back
 * through the app's own reader (pdf.js). The wrong answers that matter: a shape that
 * lands somewhere else than it was drawn or without an appearance (some readers then
 * show nothing), a line whose endpoints swap, a retag that renames a popup or an
 * unrelated highlight, a marker resolved to its popup instead of itself, and a comment
 * whose session marker is lost (the next edit can no longer find it).
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as mupdf from 'mupdf';
import { describe, expect, it } from 'vitest';
import { loadPdfjs, openWithPdfjs } from '../engines/pdfjs-handle';
import { writeShapeAnnotations } from './annotation-shapes';
import {
  type AnnotationMark,
  type ExistingAnnotation,
  markerFor,
  markerTargets,
  readAnnotations,
  retagTextMarkup,
} from './annotations';

const pdfjs = await loadPdfjs();
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve('pdfjs-dist/build/pdf.worker.mjs'),
).href;

const run = { signal: new AbortController().signal };

/** Two 400×500 pages; the second has a CropBox that starts at (50, 50). */
async function blank(extra?: (doc: mupdf.PDFDocument) => void): Promise<Uint8Array> {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  doc.findPage(1).put('CropBox', [50, 50, 350, 450]);
  extra?.(doc);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function mark(overrides: Partial<AnnotationMark> & Pick<AnnotationMark, 'id' | 'kind'>): AnnotationMark {
  return {
    pageIndex: 0,
    quads: [[40, 60, 200, 90]],
    color: '#ff0000',
    opacity: 0.5,
    contents: 'Şişli notu',
    author: 'Ayşe',
    createdAt: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

async function annotationsOf(bytes: Uint8Array): Promise<readonly ExistingAnnotation[]> {
  const handle = await openWithPdfjs(bytes);
  try {
    return await readAnnotations(handle, run);
  } finally {
    await handle.destroy();
  }
}

/**
 * Per annotation with a comment (`Subtype|marker line`): whether it carries a normal
 * appearance stream, and its `/CA` (pdf.js does not report opacity for every kind).
 */
async function appearances(bytes: Uint8Array): Promise<Record<string, { ap: boolean; ca: number | null }>> {
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const found: Record<string, { ap: boolean; ca: number | null }> = {};
    for (let page = 0; page < doc.countPages(); page += 1) {
      const annots = doc.findPage(page).get('Annots');
      if (annots.isNull()) continue;
      const array = annots.resolve();
      for (let index = 0; index < array.length; index += 1) {
        const dict = array.get(index).resolve();
        const contents = dict.get('Contents');
        if (contents.isNull()) continue;
        const ap = dict.get('AP');
        const ca = dict.get('CA');
        found[`${dict.get('Subtype').asName()}|${contents.asString().split('\n')[0]}`] = {
          ap: !ap.isNull() && ap.resolve().get('N').isStream(),
          ca: ca.isNull() ? null : ca.asNumber(),
        };
      }
    }
    return found;
  } finally {
    doc.destroy();
  }
}

describe('writeShapeAnnotations', () => {
  it('writes each shape where it was drawn, with its colour, opacity, comment and an appearance', async () => {
    const shapes = [
      mark({ id: 'sq', kind: 'shapes', shape: 'square', rect: [40, 60, 200, 160], thickness: 2 }),
      mark({ id: 'ci', kind: 'shapes', shape: 'circle', rect: [100, 200, 300, 260], color: '#0000ff' }),
      mark({ id: 'li', kind: 'shapes', shape: 'line', rect: [300, 400, 50, 350], thickness: 4 }),
      mark({ id: 'p2', kind: 'shapes', shape: 'square', pageIndex: 1, rect: [0, 0, 100, 50] }),
    ];
    const out = await writeShapeAnnotations(await blank(), shapes, run);
    expect(out.written).toEqual(shapes.map((shape) => markerFor(shape.id)));

    const read = await annotationsOf(out.bytes);
    const byMarker = (id: string) => read.find((entry) => entry.contents.startsWith(markerFor(id)));
    // Page space is top-left; the file is bottom-left, padded by half the stroke.
    expect(byMarker('sq')).toMatchObject({ subtype: 'Square', rect: [39, 339, 201, 441], color: '#ff0000' });
    expect(byMarker('sq')?.contents).toContain('Şişli notu');
    expect(byMarker('ci')).toMatchObject({ subtype: 'Circle', color: '#0000ff' });
    // pdf.js reports a line's coordinates normalised, so only the span is checked here.
    expect(byMarker('li')).toMatchObject({ subtype: 'Line', vertices: [50, 100, 300, 150] });
    // The second page's box starts at y = 50, so its top is at 450, not 500.
    expect(byMarker('p2')).toMatchObject({ pageIndex: 1, subtype: 'Square', rect: [-1, 399, 101, 451] });
    const drawn = Object.values(await appearances(out.bytes));
    expect(drawn.map((entry) => entry.ap)).toEqual([true, true, true, true]);
    expect(drawn.map((entry) => entry.ca)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('paints each shape with its own outline, stroke width and colour, and keeps a line in drag order', async () => {
    const shapes = [
      mark({ id: 'sq', kind: 'shapes', shape: 'square', rect: [40, 60, 200, 160], thickness: 6, opacity: 1 }),
      mark({
        id: 'ci',
        kind: 'shapes',
        shape: 'circle',
        rect: [100, 200, 300, 260],
        color: '#0000ff',
        thickness: 6,
        opacity: 1,
      }),
      mark({
        id: 'li',
        kind: 'shapes',
        shape: 'line',
        rect: [300, 400, 50, 350],
        color: '#00aa00',
        thickness: 6,
        opacity: 1,
      }),
    ];
    const out = await writeShapeAnnotations(await blank(), shapes, run);
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      // The file's own /L is in drag order: from (300, 400) to (50, 350) in top-left page space.
      const annots = doc.asPDF()?.findPage(0).get('Annots').resolve();
      let endpoints: number[] | null = null;
      for (let index = 0; index < (annots?.length ?? 0); index += 1) {
        const dict = annots?.get(index).resolve();
        if (dict?.get('Subtype').asName() !== 'Line') continue;
        const list = dict.get('L').resolve();
        endpoints = [0, 1, 2, 3].map((position) => list.get(position).asNumber());
      }
      expect(endpoints).toEqual([300, 100, 50, 150]);

      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const pixels = pixmap.getPixels();
      const at = (x: number, y: number): number[] => {
        const offset = (y * pixmap.getWidth() + x) * pixmap.getNumberOfComponents();
        return [pixels[offset] ?? -1, pixels[offset + 1] ?? -1, pixels[offset + 2] ?? -1];
      };
      const white = [255, 255, 255];
      const red = [255, 0, 0];
      const blue = [0, 0, 255];
      const green = [0, 0xaa, 0];

      // Square: the outline sits on the drawn box, 6 pt wide, hollow inside and outside it.
      expect(at(40, 110)).toEqual(red);
      expect(at(120, 60)).toEqual(red);
      expect(at(200, 110)).toEqual(red);
      expect(at(120, 160)).toEqual(red);
      expect(at(120, 110)).toEqual(white);
      expect(at(30, 110)).toEqual(white);
      expect(at(42, 110)).toEqual(red); // within the half-stroke (37..43)...
      expect(at(44, 110)).toEqual(white); // ...and no further: the width is the mark's, not a default
      expect(at(120, 158)).toEqual(red); // the bottom edge spans 157..163 as well,
      expect(at(120, 164)).toEqual(white); // not a stroke shifted away from the box
      // Circle: the outline touches the four side midpoints but not the box corners.
      expect(at(100, 230)).toEqual(blue);
      expect(at(200, 200)).toEqual(blue);
      expect(at(300, 230)).toEqual(blue);
      expect(at(200, 260)).toEqual(blue);
      expect(at(101, 201)).toEqual(white);
      expect(at(299, 259)).toEqual(white);
      expect(at(200, 230)).toEqual(white);
      // Line: it runs between its two endpoints and nowhere else.
      expect(at(175, 375)).toEqual(green);
      expect(at(300, 400)).toEqual(green);
      expect(at(175, 340)).toEqual(white);
    } finally {
      doc.destroy();
    }
  });

  it('paints a translucent shape translucent: the appearance carries the opacity, not only /CA', async () => {
    // A reader paints the `/AP`; with the alpha only on the annotation's `/CA` a 40 %
    // rectangle came out of the export as a solid one.
    const out = await writeShapeAnnotations(
      await blank(),
      [
        mark({
          id: 'sq',
          kind: 'shapes',
          shape: 'square',
          rect: [40, 60, 200, 160],
          thickness: 6,
          opacity: 0.4,
        }),
      ],
      run,
    );
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const pixels = pixmap.getPixels();
      const offset = (110 * pixmap.getWidth() + 40) * pixmap.getNumberOfComponents();
      const [red, green, blue] = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      // Red at 40 % over white: (255, 153, 153), give or take the rasteriser's rounding.
      expect(red).toBe(255);
      expect(green).toBeGreaterThan(140);
      expect(green).toBeLessThan(166);
      expect(blue).toBeGreaterThan(140);
      expect(blue).toBeLessThan(166);
    } finally {
      doc.destroy();
    }
  });

  it('refuses a mark on a page the document does not have', async () => {
    await expect(
      writeShapeAnnotations(
        await blank(),
        [mark({ id: 'x', kind: 'shapes', shape: 'square', pageIndex: 5 })],
        run,
      ),
    ).rejects.toMatchObject({ code: 'range-invalid' });
  });
});

/**
 * A page with what the engine's highlight writer leaves behind for three session marks
 * (all `/Highlight`), one of them with a popup that carries the same comment, and an
 * unrelated highlight of the document's own.
 */
async function engineWritten(): Promise<Uint8Array> {
  return blank((doc) => {
    const page = doc.findPage(0);
    const annots = doc.newArray();
    const highlight = (id: string, top: number) => {
      const dict = doc.addObject({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [40, top - 30, 200, top],
        QuadPoints: [40, top, 200, top, 40, top - 30, 200, top - 30],
        P: page,
      });
      dict.put('Contents', doc.newString(`${markerFor(id)}\nyorum`));
      annots.push(dict);
      return dict;
    };
    const underlined = highlight('u1', 440);
    highlight('s1', 380);
    highlight('q1', 320);
    const popup = doc.addObject({
      Type: 'Annot',
      Subtype: 'Popup',
      Rect: [210, 400, 300, 440],
      Parent: underlined,
    });
    popup.put('Contents', doc.newString(`${markerFor('u1')}\nyorum`));
    underlined.put('Popup', popup);
    annots.push(popup);
    const own = doc.addObject({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [40, 100, 200, 130],
      QuadPoints: [40, 130, 200, 130, 40, 100, 200, 100],
      P: page,
    });
    own.put('Contents', doc.newString('the document’s own'));
    annots.push(own);
    page.put('Annots', annots);
  });
}

describe('retagTextMarkup', () => {
  it('turns each session highlight into its own kind and leaves the popup and the rest alone', async () => {
    const marks = [
      mark({ id: 'u1', kind: 'underline', quads: [[40, 60, 200, 90]] }),
      mark({ id: 's1', kind: 'strikeout', quads: [[40, 120, 200, 150]] }),
      mark({ id: 'q1', kind: 'squiggly', quads: [[40, 180, 200, 210]] }),
    ];
    const out = await retagTextMarkup(await engineWritten(), marks, run);
    expect(out.retagged).toHaveLength(3);
    const subtypes = (await annotationsOf(out.bytes)).map((entry) => entry.subtype).sort();
    expect(subtypes).toEqual(['Highlight', 'Popup', 'Squiggly', 'StrikeOut', 'Underline']);
    const drawn = await appearances(out.bytes);
    expect(drawn[`Underline|${markerFor('u1')}`]?.ap).toBe(true);
    expect(drawn[`Squiggly|${markerFor('q1')}`]?.ap).toBe(true);
  });
});

describe('retagTextMarkup appearance', () => {
  it('draws an underline at the baseline, a strike through the middle and a zigzag, each in its colour', async () => {
    const marks = [
      mark({ id: 'u1', kind: 'underline', quads: [[40, 60, 200, 90]], color: '#ff0000' }),
      mark({ id: 's1', kind: 'strikeout', quads: [[40, 120, 200, 150]], color: '#0000ff' }),
      mark({ id: 'q1', kind: 'squiggly', quads: [[40, 180, 200, 210]], color: '#00aa00', thickness: 4 }),
    ];
    const out = await retagTextMarkup(await engineWritten(), marks, run);
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const pixels = pixmap.getPixels();
      const components = pixmap.getNumberOfComponents();
      const row = (y: number, x0 = 60, x1 = 180): string[] => {
        const seen = new Set<string>();
        for (let x = x0; x <= x1; x += 1) {
          const [r = 255, g = 255, b = 255] = [0, 1, 2].map(
            (channel) => pixels[(y * pixmap.getWidth() + x) * components + channel],
          );
          if (r > 200 && g < 60 && b < 60) seen.add('red');
          else if (b > 200 && r < 60 && g < 60) seen.add('blue');
          else if (g > 130 && r < 60 && b < 60) seen.add('green');
        }
        return [...seen];
      };
      // Underline: on the baseline of its line box (the pixel row above y = 90, the annotation's
      // box ends there), nowhere else in the box.
      expect(row(89)).toEqual(['red']);
      expect(row(75)).toEqual([]);
      // Strike-out: halfway between top and bottom of the line box (y = 135).
      expect(row(134)).toEqual(['blue']);
      expect(row(135)).toEqual(['blue']);
      expect(row(150)).toEqual([]);
      // Squiggle: the 4 pt zigzag climbs above the baseline (y = 210); a straight bar would not.
      expect(row(205)).toEqual(['green']);
      expect(row(195)).toEqual([]);
    } finally {
      doc.destroy();
    }
  });
});

describe('markerTargets', () => {
  it('resolves a session mark to its own annotation, never to the popup that repeats its comment', async () => {
    const bytes = await engineWritten();
    const found = await markerTargets(
      bytes,
      [
        { pageIndex: 0, id: 'u1' },
        { pageIndex: 1, id: 's1' },
      ],
      run,
    );
    const read = await annotationsOf(bytes);
    const highlight = read.find(
      (entry) => entry.subtype === 'Highlight' && entry.contents.startsWith(markerFor('u1')),
    );
    // `s1` is on page 1, not page 2: a marker is only looked for on the page it names.
    expect(found).toEqual([{ pageIndex: 0, id: highlight?.id, markId: 'u1' }]);
  });
});
