/**
 * Clips a page opens that the scene reader must answer as MuPDF counts them. A path or text
 * stroked with a tiling pattern (`/Pattern CS /P1 SCN … S`) is drawn through its outline: MuPDF
 * clips to it (`clipStrokePath`, `clipStrokeText`), runs the tile and pops the clip. Every one of
 * those calls has to be answered on both devices (the scene's frames and the raster's
 * `DrawDevice`), or the engine reports "device calls unbalanced". These pages are read in a
 * file of their own: MuPDF keeps the tiles it has drawn by their object number, so a
 * neighbouring file's pattern of the same number would stand in for these.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf, type Mupdf } from '../engines/mupdf';
import type { SceneRaster } from './layout-scene';
import { readPageScene } from './layout-scene-read';

type Doc = InstanceType<Mupdf['PDFDocument']>;

async function sceneOfPage(content: string, resources: (doc: Doc) => Record<string, unknown>) {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const page = doc.addPage([0, 0, 400, 500], 0, { Font: { F1: font }, ...resources(doc) }, content);
  doc.insertPage(0, page);
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  const opened = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  return { mupdf, scene: readPageScene(mupdf, opened.loadPage(0)) };
}

/** A 10 × 10 coloured tile (`content`), repeated every 10 points; `resources` are what it uses besides. */
const tile = (doc: Doc, content: string, resources: Record<string, unknown> = {}) =>
  doc.addStream(content, {
    Type: 'Pattern',
    PatternType: 1,
    PaintType: 1,
    TilingType: 1,
    BBox: [0, 0, 10, 10],
    XStep: 10,
    YStep: 10,
    Resources: resources,
  });

/** A decoded PNG: its size and every pixel as `[r, g, b, a]`. */
function decode(mupdf: Mupdf, data: Uint8Array) {
  const pixmap = new mupdf.Image(data).toPixmap();
  const pixels = pixmap.getPixels();
  const stride = pixmap.getStride();
  const step = pixmap.getNumberOfComponents();
  const at = (x: number, y: number): [number, number, number, number] => {
    const from = y * stride + x * step;
    return [
      pixels[from] as number,
      pixels[from + 1] as number,
      pixels[from + 2] as number,
      pixmap.getAlpha() === 1 ? (pixels[from + step - 1] as number) : 255,
    ];
  };
  return { width: pixmap.getWidth(), height: pixmap.getHeight(), at };
}

const close = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, at) => {
    expect(value).toBeCloseTo(expected[at] as number, 1);
  });
};

const kinds = (scene: { readonly items: readonly { readonly kind: string }[] }) =>
  scene.items.map((item) => item.kind);

describe('layout scene: a pattern used as a stroke', () => {
  it('reads a path stroked with a tiling pattern as a raster of the stroke, the shapes around it stay shapes', async () => {
    const { mupdf, scene } = await sceneOfPage(
      [
        '0 0 1 rg 20 20 40 40 re f',
        '/Pattern CS /P1 SCN 8 w 100 100 m 300 100 l S',
        '0 g 340 440 40 40 re f',
      ].join('\n'),
      (doc) => ({ Pattern: { P1: tile(doc, '1 0 0 rg 0 0 5 5 re f') } }),
    );
    expect(kinds(scene)).toEqual(['shape', 'raster', 'shape']);
    const raster = scene.items[1] as SceneRaster;
    // The line's 8 points of width, 200 long, with the y axis turned down.
    close(raster.box, [100, 396, 300, 404]);
    const png = decode(mupdf, raster.data);
    expect([png.width, png.height]).toEqual([400, 16]);
    // Inside a red cell and the stroke; between two cells; and the stroke's lower half, a gap of the tile.
    expect(png.at(4, 4)).toEqual([255, 0, 0, 255]);
    expect(png.at(14, 4)[3]).toBe(0);
    expect(png.at(4, 12)[3]).toBe(0);
  });

  it('reads the pattern strokes of a pattern another island leaves out, and the ones it draws itself', async () => {
    const { scene } = await sceneOfPage(
      '/Pattern cs /P1 scn 20 20 60 60 re f /Pattern cs /P2 scn 300 400 60 60 re f',
      (doc) => {
        const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
        return {
          Pattern: {
            P1: tile(doc, '0 0 1 rg 0 0 10 10 re f'),
            P2: tile(doc, '/Pattern CS /P3 SCN 2 w 0 5 m 10 5 l S BT /F1 8 Tf 1 Tr 0 2 Td (A) Tj ET', {
              Pattern: { P3: tile(doc, '0 1 0 rg 0 0 10 10 re f') },
              Font: { F1: font },
            }),
          },
        };
      },
    );
    expect(kinds(scene)).toEqual(['raster', 'raster']);
    const [first, second] = scene.items as [SceneRaster, SceneRaster];
    close(first.box, [20, 420, 80, 480]);
    close(second.box, [300, 40, 360, 100]);
  });

  it('reads text stroked with a tiling pattern as a raster, the text as text, and the shape after it stays a shape', async () => {
    const { scene } = await sceneOfPage(
      '/Pattern CS /P1 SCN 2 w BT /F1 48 Tf 1 Tr 60 300 Td (Hi) Tj ET 0 g 340 440 40 40 re f',
      (doc) => ({ Pattern: { P1: tile(doc, '1 0 0 rg 0 0 5 5 re f') } }),
    );
    expect(kinds(scene)).toEqual(['raster', 'shape']);
    const lines = scene.text.blocks.flatMap((block) => (block.kind === 'text' ? block.lines : []));
    expect(lines.map((entry) => entry.chars.map((char) => char.c).join(''))).toEqual(['Hi']);
  });
});

describe('layout scene: a stencil mask outside its clip', () => {
  it('draws nothing for it, and reads what follows', async () => {
    const { scene } = await sceneOfPage(
      ['q 0 0 20 20 re W n 100 0 0 100 200 200 cm /Stencil Do Q', '0 g 300 300 20 20 re f'].join('\n'),
      (doc) => ({
        XObject: {
          Stencil: doc.addStream(new Uint8Array([0xa0, 0x50]), {
            Type: 'XObject',
            Subtype: 'Image',
            Width: 2,
            Height: 2,
            ImageMask: true,
            BitsPerComponent: 1,
          }),
        },
      }),
    );
    expect(kinds(scene)).toEqual(['shape']);
  });
});
