/**
 * A tiling pattern the raster of another island leaves out is still run by the interpreter, cell
 * by cell, and every clip, mask, stroke and picture call in it is let past, unseen. These pages
 * are read in a file of their own: MuPDF keeps the tiles it has drawn by their object number, so
 * a neighbouring file's pattern of the same number would stand in for these.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf, type Mupdf } from '../engines/mupdf';
import type { SceneRaster } from './layout-scene';
import { readPageScene } from './layout-scene-read';

interface RawPage {
  readonly content: string;
  readonly resources: (doc: InstanceType<Mupdf['PDFDocument']>) => Record<string, unknown>;
}

async function rawPdf(spec: RawPage): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const page = doc.addPage([0, 0, 400, 500], 0, spec.resources(doc), spec.content);
  doc.insertPage(0, page);
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

const close = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, at) => {
    expect(value).toBeCloseTo(expected[at] as number, 1);
  });
};

describe('layout scene: raster content of a pattern with clips, masks and groups', () => {
  /** Three pages' worth of drawing in a tile: every kind of call a pattern can make. */
  const busy = (doc: InstanceType<Mupdf['PDFDocument']>) => {
    const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    const stencil = doc.addStream(new Uint8Array([0xa0, 0x50]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 2,
      ImageMask: true,
      BitsPerComponent: 1,
    });
    const masked = doc.addStream(new Uint8Array([0, 255, 255, 0]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 2,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
      Mask: stencil,
    });
    const content = [
      'q 0 0 5 5 re W n 0 0 m 10 10 l S Q',
      'q BT /F1 8 Tf 7 Tr 0 2 Td (A) Tj ET 0 0 10 10 re f Q',
      'q /GS1 gs 0 0 10 10 re f Q',
      'q 10 0 0 10 0 0 cm /St Do /Mk Do Q',
    ].join('\n');
    return doc.addStream(content, {
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 1,
      TilingType: 1,
      BBox: [0, 0, 10, 10],
      XStep: 10,
      YStep: 10,
      Resources: {
        Font: { F1: font },
        XObject: { St: stencil, Mk: masked },
        ExtGState: {
          GS1: {
            Type: 'ExtGState',
            SMask: {
              Type: 'Mask',
              S: 'Luminosity',
              G: doc.addStream('0.5 g 0 0 10 10 re f', {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [0, 0, 10, 10],
                Group: { S: 'Transparency', CS: 'DeviceGray' },
              }),
            },
          },
        },
      },
    });
  };
  const sceneOfPage = async () => {
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument((await rawPdf(page)).slice(), 'application/pdf');
    return { mupdf, scene: readPageScene(mupdf, doc.loadPage(0)) };
  };
  const page: RawPage = {
    content: ['/Pattern cs /P1 scn 20 20 60 60 re f', '/Pattern cs /P2 scn 300 400 60 60 re f'].join('\n'),
    resources: (doc) => ({
      Pattern: {
        P1: doc.addStream('0 0 1 rg 0 0 10 10 re f', {
          Type: 'Pattern',
          PatternType: 1,
          PaintType: 1,
          TilingType: 1,
          BBox: [0, 0, 10, 10],
          XStep: 10,
          YStep: 10,
          Resources: {},
        }),
        P2: busy(doc),
      },
    }),
  };

  it('leaves the busy pattern of another island out of a raster, whole, and keeps its own', async () => {
    const { scene } = await sceneOfPage();
    expect(scene.items.map((item) => item.kind)).toEqual(['raster', 'raster']);
    const [first, second] = scene.items as [SceneRaster, SceneRaster];
    close(first.box, [20, 420, 80, 480]);
    close(second.box, [300, 40, 360, 100]);
  });

  it('rasters a pattern inside a pattern, and a plain one beside it', async () => {
    const tile = (
      doc: InstanceType<Mupdf['PDFDocument']>,
      content: string,
      patterns: Record<string, unknown>,
    ) =>
      doc.addStream(content, {
        Type: 'Pattern',
        PatternType: 1,
        PaintType: 1,
        TilingType: 1,
        BBox: [0, 0, 10, 10],
        XStep: 10,
        YStep: 10,
        Resources: { Pattern: patterns },
      });
    const mupdf = await loadMupdf();
    const bytes = await rawPdf({
      content: '/Pattern cs /P1 scn 100 100 100 40 re f /Pattern cs /P2 scn 300 300 40 40 re f',
      resources: (doc) => {
        const inner = tile(doc, '0 1 0 rg 0 0 5 5 re f', {});
        return {
          Pattern: {
            P1: tile(doc, '1 0 0 rg 0 0 10 10 re f', {}),
            P2: tile(doc, '/Pattern cs /P3 scn 0 0 10 10 re f', { P3: inner }),
          },
        };
      },
    });
    const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
    const { items } = readPageScene(mupdf, doc.loadPage(0));
    expect(items.map((item) => item.kind)).toEqual(['raster', 'raster']);
  });

  it('reads the same rasters from the page contents alone, as the page without its annotations is read', async () => {
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument((await rawPdf(page)).slice(), 'application/pdf');
    const scene = readPageScene(mupdf, doc.loadPage(0), true);
    expect(scene.items.map((item) => item.kind)).toEqual(['raster', 'raster']);
  });
});
