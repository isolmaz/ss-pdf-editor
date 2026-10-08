import type { PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { loadMupdf, type Mupdf } from '../engines/mupdf';
import { circle, line, officeDocument, picture } from './export-office-fixtures';
import type { SceneImage, SceneRaster, SceneShape } from './layout-scene';
import { readPageScene } from './layout-scene-read';

interface RawPage {
  readonly content: string;
  readonly size?: readonly [number, number];
  /** Resources the page needs besides `Font /F1`. */
  readonly resources?: (doc: InstanceType<Mupdf['PDFDocument']>) => Record<string, unknown>;
  /** Images by resource name, each pixel from `at(x, y)`. */
  readonly images?: Readonly<
    Record<
      string,
      {
        readonly width: number;
        readonly height: number;
        readonly at: (x: number, y: number) => readonly [number, number, number];
      }
    >
  >;
  /** Link annotations; `page` is the page object a GoTo link points at. */
  readonly annots?: (page: PDFObject) => readonly unknown[];
}

/** A one-page PDF from a raw content stream, with `Helvetica` as `/F1`. */
async function rawPdf(spec: RawPage): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const xobjects: Record<string, PDFObject> = {};
  for (const [name, image] of Object.entries(spec.images ?? {})) {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, image.width, image.height], false);
    const samples = pixmap.getPixels();
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) samples.set(image.at(x, y), (y * image.width + x) * 3);
    }
    const decoded = new mupdf.Image(pixmap);
    xobjects[name] = doc.addImage(decoded);
    decoded.destroy();
    pixmap.destroy();
  }
  const [width, height] = spec.size ?? [400, 500];
  const page = doc.addPage(
    [0, 0, width, height],
    0,
    { Font: { F1: font }, XObject: xobjects, ...spec.resources?.(doc) },
    spec.content,
  );
  if (spec.annots !== undefined) {
    page.put(
      'Annots',
      spec.annots(page).map((annot) => doc.addObject(annot)),
    );
  }
  doc.insertPage(0, page);
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

async function sceneOf(bytes: Uint8Array) {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  const scene = readPageScene(mupdf, doc.loadPage(0));
  return { mupdf, scene };
}

const sceneOfRaw = async (spec: RawPage) => sceneOf(await rawPdf(spec));

const contentOnly = (content: string) => officeDocument([{ content }]);

/** A decoded PNG/JPEG: its size and every pixel as `[r, g, b, a]`. */
function decode(mupdf: Mupdf, data: Uint8Array) {
  const pixmap = new mupdf.Image(data).toPixmap();
  const pixels = pixmap.getPixels();
  const stride = pixmap.getStride();
  const alpha = pixmap.getAlpha();
  // MuPDF counts the alpha channel among the components.
  const step = pixmap.getNumberOfComponents();
  const at = (x: number, y: number): [number, number, number, number] => {
    const from = y * stride + x * step;
    return [
      pixels[from] as number,
      pixels[from + 1] as number,
      pixels[from + 2] as number,
      alpha === 1 ? (pixels[from + step - 1] as number) : 255,
    ];
  };
  return { width: pixmap.getWidth(), height: pixmap.getHeight(), at };
}

const shapes = (items: readonly { kind: string }[]) =>
  items.filter((item): item is SceneShape => item.kind === 'shape');

const close = (actual: readonly number[], expected: readonly number[], digits = 1) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, digits);
  });
};

describe('layout scene: shapes', () => {
  it('reads a filled rectangle, a scaled dashed stroke and a curved fill in paint order', async () => {
    const { scene } = await sceneOf(
      await contentOnly(
        [
          '0.2 0.4 0.6 rg 50 400 100 50 re f',
          'q 2 0 0 2 0 0 cm 1 0 0 RG 3 w [4 2] 0 d 1 J 1 j 20 100 m 100 100 l S Q',
          circle(250, 150, 40, '0 0.6 0'),
        ].join('\n'),
      ),
    );
    expect([scene.width, scene.height]).toEqual([400, 500]);
    expect(scene.items.map((item) => item.kind)).toEqual(['shape', 'shape', 'shape']);
    const [rectangle, stroke, disc] = shapes(scene.items) as [SceneShape, SceneShape, SceneShape];

    close(rectangle.box, [50, 50, 150, 100]);
    expect(rectangle.fill).toEqual({ color: 0x336699, alpha: 1, evenOdd: false });
    expect(rectangle.stroke).toBeNull();
    expect(rectangle.segments.filter((segment) => segment.kind === 'line')).toHaveLength(3);

    // The `cm` doubles the width (3 → 6) and the dash (4 2 → 8 4); y is flipped to the top-left origin.
    expect(stroke.fill).toBeNull();
    expect(stroke.stroke).toEqual({
      color: 0xff0000,
      alpha: 1,
      width: 6,
      dash: [8, 4],
      cap: 'round',
      join: 'round',
    });
    close(stroke.box, [40, 300, 200, 300]);

    expect(disc.fill).toEqual({ color: 0x009900, alpha: 1, evenOdd: false });
    expect(disc.segments.filter((segment) => segment.kind === 'curve')).toHaveLength(4);
    close(disc.box, [210, 310, 290, 390]);
  });

  it('carries the fill and the stroke alpha of an ExtGState as two shapes', async () => {
    const { scene } = await sceneOfRaw({
      content: '/GS1 gs 1 0 0 rg 0 0 1 RG 4 w 100 100 80 80 re B',
      resources: () => ({ ExtGState: { GS1: { Type: 'ExtGState', ca: 0.5, CA: 0.25 } } }),
    });
    const [fill, stroke] = shapes(scene.items) as [SceneShape, SceneShape];
    expect(scene.items).toHaveLength(2);
    expect(fill.fill).toMatchObject({ color: 0xff0000, alpha: 0.5 });
    expect(fill.stroke).toBeNull();
    expect(stroke.stroke).toMatchObject({ color: 0x0000ff, alpha: 0.25, width: 4, dash: [] });
    expect(stroke.stroke?.cap).toBe('butt');
    expect(stroke.stroke?.join).toBe('miter');
  });

  it('converts a CMYK fill the way MuPDF does', async () => {
    const { scene } = await sceneOf(await contentOnly('0 1 1 0 k 50 50 50 50 re f'));
    const color = (shapes(scene.items)[0] as SceneShape).fill?.color ?? 0;
    expect(color >> 16).toBeGreaterThan(200);
    expect((color >> 8) & 255).toBeLessThan(100);
    expect(color & 255).toBeLessThan(100);
  });

  it('keeps the page-sized background fill as the first shape', async () => {
    const { scene } = await sceneOf(
      await contentOnly('0.8 0.8 0.6 rg 0 0 400 500 re f 0 g 100 100 50 50 re f'),
    );
    const [paper, ink] = shapes(scene.items) as [SceneShape, SceneShape];
    expect(scene.items).toHaveLength(2);
    close(paper.box, [0, 0, 400, 500]);
    expect(paper.fill?.color).toBe(0xcccc99);
    expect(ink.fill?.color).toBe(0);
  });

  it('turns a page of more than 1500 paths into one raster', async () => {
    const squares = Array.from({ length: 1600 }, (_, index) => {
      return `${(index % 40) * 10} ${Math.floor(index / 40) * 10} 8 8 re f`;
    }).join('\n');
    const { mupdf, scene } = await sceneOf(await contentOnly(`0 0.5 0 rg ${squares}`));
    expect(scene.items).toHaveLength(1);
    const [all] = scene.items as [SceneRaster];
    expect(all.kind).toBe('raster');
    // 40 columns of 10 pt, the last square ends at 398; 40 rows from the bottom, the top one ends at 398 from it.
    close(all.box, [0, 102, 398, 500]);
    const png = decode(mupdf, all.data);
    // The square drawn at 0,0 (PDF) is at the bottom-left of the box.
    expect(png.at(4, png.height - 4)[3]).toBe(255);
    // The gap between squares stays transparent.
    expect(png.at(17, png.height - 4)[3]).toBe(0);
  });
});

describe('layout scene: pictures', () => {
  it('reads a picture at its box with its colour', async () => {
    const { mupdf, scene } = await sceneOf(
      await officeDocument([
        {
          content: picture('Im1', 100, 300, 120, 80),
          images: { Im1: { width: 8, height: 8, rgb: [200, 30, 60] } },
        },
      ]),
    );
    expect(scene.items).toHaveLength(1);
    const [image] = scene.items as [SceneImage];
    expect(image.kind).toBe('image');
    close(image.box, [100, 120, 220, 200]);
    expect(image.mime).toBe('image/png');
    const png = decode(mupdf, image.data);
    const [r, g, b, a] = png.at(Math.floor(png.width / 2), Math.floor(png.height / 2));
    expect([r, g, b, a]).toEqual([200, 30, 60, 255]);
  });

  it('sends a photographic picture as JPEG', async () => {
    const { mupdf, scene } = await sceneOfRaw({
      content: 'q 128 0 0 128 100 100 cm /Im1 Do Q',
      images: {
        Im1: {
          width: 64,
          height: 64,
          // Smooth but far more than 256 distinct colours.
          at: (x, y) => [x * 4, y * 4, (x * 7 + y * 3) % 256],
        },
      },
    });
    const [image] = scene.items as [SceneImage];
    expect(image.kind).toBe('image');
    expect(image.mime).toBe('image/jpeg');
    expect([image.data[0], image.data[1]]).toEqual([0xff, 0xd8]);
    const jpeg = decode(mupdf, image.data);
    const [r, g] = jpeg.at(Math.floor(jpeg.width * 0.75), Math.floor(jpeg.height * 0.25));
    // Column 48 of 64 is 192 red, row 16 is 64 green (JPEG is lossy).
    expect(Math.abs(r - 192)).toBeLessThan(24);
    expect(Math.abs(g - 64)).toBeLessThan(24);
  });

  it('crops a picture to a rectangular clip', async () => {
    const { mupdf, scene } = await sceneOfRaw({
      content: 'q 100 100 50 100 re W n 200 0 0 200 100 100 cm /Im1 Do Q',
      images: { Im1: { width: 4, height: 4, at: (x) => (x < 2 ? [255, 0, 0] : [0, 0, 255]) } },
    });
    const [image] = scene.items as [SceneImage];
    expect(image.kind).toBe('image');
    // The picture spans x 100…300, the clip x 100…150 (page y 300…400): only the left (red) quarter shows.
    close(image.box, [100, 300, 150, 400]);
    const png = decode(mupdf, image.data);
    expect(png.at(Math.floor(png.width / 2), Math.floor(png.height / 2)).slice(0, 3)).toEqual([255, 0, 0]);
  });
});

describe('layout scene: rasters', () => {
  it('draws a shading as one raster without the text over it', async () => {
    const { mupdf, scene } = await sceneOfRaw({
      content: ['q 20 200 360 100 re W n /Sh1 sh Q', 'BT 0 g /F1 60 Tf 40 230 Td (HELLO) Tj ET'].join('\n'),
      resources: (doc) => ({
        Shading: {
          Sh1: doc.addObject({
            ShadingType: 2,
            ColorSpace: 'DeviceRGB',
            Coords: [0, 0, 400, 0],
            Function: { FunctionType: 2, Domain: [0, 1], C0: [0, 0, 1], C1: [0, 0, 1], N: 1 },
            Extend: [true, true],
          }),
        },
      }),
    });
    // The text is still read as text …
    const letters = scene.text.blocks.flatMap((block) =>
      block.kind === 'text' ? block.lines.flatMap((entry) => entry.chars.map((char) => char.c)) : [],
    );
    expect(letters.join('')).toBe('HELLO');
    // … and the drawing is the shading alone.
    expect(scene.items.map((item) => item.kind)).toEqual(['raster']);
    const [shading] = scene.items as [SceneRaster];
    close(shading.box, [20, 200, 380, 300]);
    const png = decode(mupdf, shading.data);
    expect([png.width, png.height]).toEqual([720, 200]);
    let ink = 0;
    let blue = 0;
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const [r, g, b, a] = png.at(x, y);
        if (r + g + b < 200) ink += 1;
        if (r < 8 && g < 8 && b > 247 && a === 255) blue += 1;
      }
    }
    expect(ink).toBe(0);
    expect(blue).toBe(png.width * png.height);
  });

  it('repeats a dash of an odd length, as PDF does, so the pattern alternates dash and gap', async () => {
    const { scene } = await sceneOf(await contentOnly('0 0 0 RG 2 w [5 2 1] 0 d 20 100 m 200 100 l S'));
    const [stroke] = shapes(scene.items) as [SceneShape];
    expect(stroke.stroke?.dash).toEqual([5, 2, 1, 5, 2, 1]);
  });

  it.each([
    ['clipped to the outline of text', '7 Tr'],
    ['clipped to outlined text', '1 w 5 Tr'],
    ['clipped to outlined and filled text', '1 w 6 Tr'],
    ['clipped to filled text', '4 Tr'],
  ])('draws a fill %s as a raster of the part the letters let through', async (_name, mode) => {
    const { mupdf, scene } = await sceneOf(
      await contentOnly(
        [`q BT /F1 120 Tf ${mode} 20 300 Td (MM) Tj ET`, '1 0 0 rg 0 0 400 500 re f Q'].join('\n'),
      ),
    );
    const rasters = scene.items.filter((item): item is SceneRaster => item.kind === 'raster');
    expect(rasters).toHaveLength(1);
    const png = decode(mupdf, (rasters[0] as SceneRaster).data);
    const opaque = new Set<number>();
    for (let y = 0; y < png.height; y += 1)
      for (let x = 0; x < png.width; x += 1) opaque.add(png.at(x, y)[3] === 0 ? 0 : 1);
    // Some pixels are red (inside a letter), some are cut away.
    expect([...opaque].sort()).toEqual([0, 1]);
  });

  it('draws what a circular clip cuts as a raster, and cuts a rectangle to a rectangular clip', async () => {
    const { mupdf, scene } = await sceneOf(
      await contentOnly(
        [
          // A circle (r 50 at 200,250) as the clip, a big red fill through it.
          'q 250 250 m 250 277.6 227.6 300 200 300 c 172.4 300 150 277.6 150 250 c',
          '150 222.4 172.4 200 200 200 c 227.6 200 250 222.4 250 250 c W n',
          '1 0 0 rg 0 0 400 500 re f Q',
          // A rectangle cut by a rectangular clip.
          'q 20 20 100 100 re W n 0 0 1 rg 0 0 70 70 re f Q',
        ].join('\n'),
      ),
    );
    expect(scene.items.map((item) => item.kind)).toEqual(['raster', 'shape']);
    const [clipped, cut] = scene.items as [SceneRaster, SceneShape];
    close(clipped.box, [150, 200, 250, 300]);
    const png = decode(mupdf, clipped.data);
    // Inside the circle: red; in the box's corner, outside the circle: nothing.
    expect(png.at(png.width / 2, png.height / 2)).toEqual([255, 0, 0, 255]);
    expect(png.at(3, 3)[3]).toBe(0);
    // The rectangle 0…70 cut to 20…120 is 20…70 on both axes (page y: 430…480).
    close(cut.box, [20, 430, 70, 480]);
    expect(cut.segments.map((segment) => segment.kind)).toEqual(['move', 'line', 'line', 'line', 'close']);
    expect(cut.fill?.color).toBe(0x0000ff);
  });

  it('rasters a stroke that a rectangular clip cuts, and drops shapes outside it', async () => {
    const { scene } = await sceneOf(
      await contentOnly(
        [
          'q 100 100 100 100 re W n',
          '0 0 1 RG 4 w 50 150 m 250 150 l S',
          '1 0 0 rg 300 300 20 20 re f',
          'Q',
        ].join('\n'),
      ),
    );
    expect(scene.items.map((item) => item.kind)).toEqual(['raster']);
    const [cutLine] = scene.items as [SceneRaster];
    close(cutLine.box, [100, 348, 200, 352]);
  });

  describe('a polygonal clip that is no rectangle', () => {
    /** A hexagon around the rule (100…200, 200): wider than it, pointed at the ends (Antenna House's clip of a table rule). */
    const HEXAGON = '100.1 200 m 98 198 l 200 198 l 200 200 l 200 202 l 98 202 l h W n';
    const kinds = async (content: string) =>
      (await sceneOf(await contentOnly(content))).scene.items.map((item) => item.kind);

    it('keeps a hairline the polygon holds a shape', async () => {
      expect(await kinds(`q ${HEXAGON} 0 G 0.5 w 100 200 m 200 200 l S Q`)).toEqual(['shape']);
    });

    it('rasters a stroke wider than the polygon, a fill that sticks out and a stroke that crosses an edge', async () => {
      expect(await kinds(`q ${HEXAGON} 0 G 8 w 100 200 m 200 200 l S Q`)).toEqual(['raster']);
      expect(await kinds(`q ${HEXAGON} 1 0 0 rg 150 190 20 20 re f Q`)).toEqual(['raster']);
      expect(await kinds(`q ${HEXAGON} 0 G 0.5 w 100 200 m 100 230 l S Q`)).toEqual(['raster']);
    });

    it('follows the fill rule of the clip', async () => {
      const rings = '90 90 120 120 re 120 120 60 60 re';
      const line = '0 G 0.5 w 140 150 m 160 150 l S Q';
      // Inside the hole of an even-odd clip nothing shows; with the winding rule it is inside.
      expect(await kinds(`q ${rings} W* n ${line}`)).toEqual(['raster']);
      expect(await kinds(`q ${rings} W n ${line}`)).toEqual(['shape']);
    });

    it('keeps a picture the polygon holds and rasters one it cuts', async () => {
      const images = { Im1: { width: 2, height: 2, at: () => [255, 0, 0] as [number, number, number] } };
      const picture = 'q 100 0 0 100 100 100 cm /Im1 Do Q';
      const held = await sceneOfRaw({
        content: `q 90 90 m 90 210 l 210 210 l 210 90 l 150 80 l h W n ${picture} Q`,
        images,
      });
      expect(held.scene.items.map((item) => item.kind)).toEqual(['image']);
      const cut = await sceneOfRaw({ content: `q 90 90 m 90 210 l 150 210 l h W n ${picture} Q`, images });
      expect(cut.scene.items.map((item) => item.kind)).toEqual(['raster']);
    });
  });

  it('draws a blend-mode fill as a raster, and a tiling pattern fill', async () => {
    const { scene: blended } = await sceneOfRaw({
      content: '/GS1 gs 1 0 0 rg 100 100 100 100 re f',
      resources: () => ({ ExtGState: { GS1: { Type: 'ExtGState', BM: 'Multiply' } } }),
    });
    expect(blended.items.map((item) => item.kind)).toEqual(['raster']);
    close((blended.items[0] as SceneRaster).box, [100, 300, 200, 400]);

    const { mupdf, scene: tiled } = await sceneOfRaw({
      content: '/Pattern cs /P1 scn 100 100 100 100 re f',
      resources: (doc) => ({
        Pattern: {
          P1: doc.addStream('1 0 0 rg 0 0 5 5 re f', {
            Type: 'Pattern',
            PatternType: 1,
            PaintType: 1,
            TilingType: 1,
            BBox: [0, 0, 10, 10],
            XStep: 10,
            YStep: 10,
            Resources: {},
          }),
        },
      }),
    });
    expect(tiled.items.map((item) => item.kind)).toEqual(['raster']);
    const [pattern] = tiled.items as [SceneRaster];
    close(pattern.box, [100, 300, 200, 400]);
    const png = decode(mupdf, pattern.data);
    expect(png.at(2, png.height - 2)).toEqual([255, 0, 0, 255]);
    expect(png.at(15, png.height - 2)[3]).toBe(0);
  });

  it('draws a soft-masked fill as a raster and leaves the mask own drawing out', async () => {
    const { scene } = await sceneOfRaw({
      content: '/GS1 gs 1 0 0 rg 100 100 100 100 re f',
      resources: (doc) => ({
        ExtGState: {
          GS1: {
            Type: 'ExtGState',
            SMask: {
              Type: 'Mask',
              S: 'Luminosity',
              G: doc.addStream('0.5 g 0 0 400 500 re f', {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [0, 0, 400, 500],
                Group: { S: 'Transparency', CS: 'DeviceGray' },
              }),
            },
          },
        },
      }),
    });
    expect(scene.items.map((item) => item.kind)).toEqual(['raster']);
    close((scene.items[0] as SceneRaster).box, [100, 300, 200, 400]);
  });

  it('puts an island at the paint position of its first content, so later shapes stay on top', async () => {
    const { scene: ordered } = await sceneOfRaw({
      content: [
        '0 g 10 10 20 20 re f',
        '/GS1 gs 1 0 0 rg 100 100 100 100 re f',
        '/GS0 gs 0 0 1 rg 120 120 20 20 re f',
      ].join('\n'),
      resources: () => ({
        ExtGState: {
          GS0: { Type: 'ExtGState', BM: 'Normal' },
          GS1: { Type: 'ExtGState', BM: 'Multiply' },
        },
      }),
    });
    expect(ordered.items.map((item) => item.kind)).toEqual(['shape', 'raster', 'shape']);
  });
});

describe('layout scene: raster content', () => {
  const half = { Type: 'ExtGState', ca: 0.5 };
  const circle = [
    'q 250 250 m 250 277.6 227.6 300 200 300 c 172.4 300 150 277.6 150 250 c',
    '150 222.4 172.4 200 200 200 c 227.6 200 250 222.4 250 250 c W n',
  ].join(' ');

  it('draws only what the island itself holds: neither the shapes under nor the shapes over it', async () => {
    const { mupdf, scene } = await sceneOfRaw({
      content: [
        '/GS1 gs 0 g 0 0 400 500 re f',
        `${circle} 1 0 0 rg 150 200 100 100 re f Q`,
        '1 g 190 240 20 20 re f',
      ].join('\n'),
      resources: () => ({ ExtGState: { GS1: half } }),
    });
    expect(scene.items.map((item) => item.kind)).toEqual(['shape', 'raster', 'shape']);
    const png = decode(mupdf, (scene.items[1] as SceneRaster).data);
    // The red half-transparent fill alone (the decoder premultiplies: half of 255 over half
    // opaque): not the black under it, nor the white over it.
    const [r, g, bl, a] = png.at(png.width / 2, png.height / 2);
    expect([g, bl]).toEqual([0, 0]);
    expect(r).toBeGreaterThanOrEqual(124);
    expect(r).toBeLessThanOrEqual(130);
    expect(a).toBeGreaterThanOrEqual(126);
    expect(a).toBeLessThanOrEqual(130);
  });
});

describe('layout scene: raster content of patterns', () => {
  it('keeps each far apart tiling pattern, nested ones included, in its own raster', async () => {
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
    const { mupdf, scene } = await sceneOfRaw({
      content: [
        '/Pattern cs /P1 scn 20 20 60 60 re f',
        '/Pattern cs /P2 scn 300 400 60 60 re f',
        '1 0 0 rg 150 200 10 10 re f',
      ].join('\n'),
      resources: (doc) => {
        const red = tile(doc, '1 0 0 rg 0 0 10 10 re f', {});
        const nested = tile(doc, '/Pattern cs /P3 scn 0 0 10 10 re f', { P3: red });
        return { Pattern: { P1: tile(doc, '0 0 1 rg 0 0 10 10 re f', {}), P2: nested } };
      },
    });
    expect(scene.items.map((item) => item.kind)).toEqual(['raster', 'raster', 'shape']);
    const [first, second] = scene.items as [SceneRaster, SceneRaster];
    close(first.box, [20, 420, 80, 480]);
    close(second.box, [300, 40, 360, 100]);
    const blue = decode(mupdf, first.data);
    expect(blue.at(blue.width / 2, blue.height / 2)).toEqual([0, 0, 255, 255]);
    const red = decode(mupdf, second.data);
    expect(red.at(red.width / 2, red.height / 2)).toEqual([255, 0, 0, 255]);
  });
});

describe('layout scene: links', () => {
  it('reads an external link with its box and ignores an internal one', async () => {
    const { scene } = await sceneOfRaw({
      content: '0 g 50 400 100 20 re f',
      annots: (page) => [
        {
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [50, 400, 150, 420],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: '(https://example.com/a)' },
        },
        {
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [200, 400, 300, 420],
          Border: [0, 0, 0],
          Dest: [page, 'Fit'],
        },
      ],
    });
    expect(scene.links).toHaveLength(1);
    const link = scene.links[0];
    expect(link?.uri).toBe('https://example.com/a');
    close(link?.box ?? [], [50, 80, 150, 100]);
  });
});

describe('layout scene: text', () => {
  it('carries the page text from the layout reader', async () => {
    const { scene } = await sceneOf(await contentOnly(line('helvetica', 12, 40, 400, 'Hello scene')));
    const lines = scene.text.blocks.flatMap((block) => (block.kind === 'text' ? block.lines : []));
    expect(lines.map((entry) => entry.chars.map((char) => char.c).join(''))).toEqual(['Hello scene']);
    expect(scene.items).toEqual([]);
  });
});

/** A `/DeviceN` space of `inks` over DeviceCMYK, its tint transform the PostScript `program`. */
function deviceN(doc: InstanceType<Mupdf['PDFDocument']>, inks: readonly string[], program: string) {
  const tint = doc.addStream(program, {
    FunctionType: 4,
    Domain: inks.flatMap(() => [0, 1]),
    Range: [0, 1, 0, 1, 0, 1, 0, 1],
  });
  return doc.addObject(['DeviceN', inks, 'DeviceCMYK', tint]);
}

describe('layout scene: colours the binding cannot draw as they come', () => {
  it('reads a DeviceN fill of two inks as its CMYK alternate does', async () => {
    const { scene } = await sceneOfRaw({
      content: '/CS0 cs 0.5 0.5 scn 50 50 50 50 re f',
      resources: (doc) => ({ ColorSpace: { CS0: deviceN(doc, ['Cyan', 'Magenta'], '{ 0 0 }') } }),
    });
    const { scene: alternate } = await sceneOf(await contentOnly('0.5 0.5 0 0 k 50 50 50 50 re f'));
    const color = (shapes(scene.items)[0] as SceneShape).fill?.color;
    expect(color).toBeDefined();
    expect(color).toBe((shapes(alternate.items)[0] as SceneShape).fill?.color);
  });

  it('reads a DeviceN stroke of two inks', async () => {
    const { scene } = await sceneOfRaw({
      content: '/CS0 CS 1 0 SCN 4 w 50 50 m 150 50 l S',
      resources: (doc) => ({ ColorSpace: { CS0: deviceN(doc, ['Cyan', 'Magenta'], '{ 0 0 }') } }),
    });
    const { scene: alternate } = await sceneOf(await contentOnly('1 0 0 0 K 4 w 50 50 m 150 50 l S'));
    const stroke = (shapes(scene.items)[0] as SceneShape).stroke?.color;
    expect(stroke).toBe((shapes(alternate.items)[0] as SceneShape).stroke?.color);
  });

  it('reads a DeviceN fill of five inks as a grey of its strongest ink', async () => {
    const { scene } = await sceneOfRaw({
      content: '/CS0 cs 0.2 0.4 0.6 0.3 0.1 scn 50 50 50 50 re f',
      resources: (doc) => ({
        ColorSpace: { CS0: deviceN(doc, ['A', 'B', 'C', 'D', 'E'], '{ pop pop 0 }') },
      }),
    });
    const color = (shapes(scene.items)[0] as SceneShape).fill?.color ?? 0;
    close([color >> 16, (color >> 8) & 255, color & 255], [102, 102, 102], -1);
  });

  it('draws DeviceN fills of two and five inks into a raster too', async () => {
    const { mupdf, scene } = await sceneOfRaw({
      content: [
        'q 50 50 m 150 50 l 100 150 l h W n',
        '/CS0 cs 1 0 scn 0 0 200 200 re f Q',
        'q 250 50 m 350 50 l 300 150 l h W n',
        '/CS1 cs 0.2 0.4 0.6 0.3 0.1 scn 200 0 200 200 re f Q',
      ].join('\n'),
      resources: (doc) => ({
        ColorSpace: {
          CS0: deviceN(doc, ['Cyan', 'Magenta'], '{ 0 0 }'),
          CS1: deviceN(doc, ['A', 'B', 'C', 'D', 'E'], '{ pop pop 0 }'),
        },
      }),
    });
    const [cyan, grey] = scene.items as [SceneRaster, SceneRaster];
    expect(scene.items.map((item) => item.kind)).toEqual(['raster', 'raster']);
    const first = decode(mupdf, cyan.data);
    const [r, , b] = first.at(first.width / 2, first.height / 2);
    expect(b).toBeGreaterThan(r);
    const second = decode(mupdf, grey.data);
    close(second.at(second.width / 2, second.height / 2).slice(0, 3), [102, 102, 102], -1);
  });
});

describe('layout scene: stencil masks in a raster', () => {
  it('paints a stencil mask into the raster in its fill colour, a DeviceN one included', async () => {
    const { mupdf, scene } = await sceneOfRaw({
      content: '/CS0 cs 1 0 scn q 100 0 0 100 50 50 cm /Stencil Do Q',
      resources: (doc) => ({
        ColorSpace: { CS0: deviceN(doc, ['Cyan', 'Magenta'], '{ 0 0 }') },
        XObject: {
          Stencil: doc.addStream(new Uint8Array(8).fill(0), {
            Type: 'XObject',
            Subtype: 'Image',
            Width: 8,
            Height: 8,
            ImageMask: true,
            BitsPerComponent: 1,
          }),
        },
      }),
    });
    expect(scene.items.map((item) => item.kind)).toEqual(['raster']);
    const [mask] = scene.items as [SceneRaster];
    close(mask.box, [50, 350, 150, 450]);
    const png = decode(mupdf, mask.data);
    const [r, , b, a] = png.at(png.width / 2, png.height / 2);
    expect(a).toBeGreaterThan(250);
    expect(b).toBeGreaterThan(r);
  });
});

describe('layout scene: compound paths', () => {
  const squares = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `${(index % 50) * 6} ${Math.floor(index / 50) * 6} 4 4 re`,
    ).join(' ');

  it('keeps an even-odd path of a few hundred subpaths a shape', async () => {
    const { scene } = await sceneOf(await contentOnly(`0 g ${squares(300)} f*`));
    expect(scene.items.map((item) => item.kind)).toEqual(['shape']);
  });

  it('draws an even-odd path of more than 1500 subpaths as a picture, a nonzero one of the same still a shape', async () => {
    const { mupdf, scene } = await sceneOf(await contentOnly(`0 g ${squares(1600)} f*`));
    expect(scene.items.map((item) => item.kind)).toEqual(['raster']);
    const [all] = scene.items as [SceneRaster];
    expect(decode(mupdf, all.data).at(4, decode(mupdf, all.data).height - 4)[3]).toBe(255);
    const { scene: nonzero } = await sceneOf(await contentOnly(`0 g ${squares(1600)} f`));
    expect(nonzero.items.map((item) => item.kind)).toEqual(['shape']);
  });
});

describe('layout scene: drawing far off the page', () => {
  it('cuts a filled rectangle that reaches far off the page to the page, keeping its colour', async () => {
    const { scene } = await sceneOf(
      await contentOnly('0.9 0.9 0.9 rg -200000 -200000 400000 400000 re f 0 g 100 100 50 50 re f'),
    );
    const [paper, ink] = shapes(scene.items) as [SceneShape, SceneShape];
    expect(scene.items).toHaveLength(2);
    close(paper.box, [0, 0, 400, 500]);
    expect(paper.fill?.color).toBe(0xe5e5e5);
    expect(paper.segments.length).toBeGreaterThan(0);
    expect(ink.fill?.color).toBe(0);
  });

  it('keeps a rectangle that reaches a little off the page whole', async () => {
    const { scene } = await sceneOf(await contentOnly('0 g -20 -20 440 540 re f'));
    close((shapes(scene.items)[0] as SceneShape).box, [-20, -20, 420, 520]);
  });

  it('draws a stroke and a curved fill far off the page as pictures of the page part', async () => {
    const { mupdf, scene } = await sceneOf(
      await contentOnly(
        [
          '0 0 1 RG 6 w -200000 250 m 200000 250 l S',
          '1 0 0 rg -200000 -200000 m 200000 -200000 l 0 200000 l f',
        ].join('\n'),
      ),
    );
    expect(scene.items.length).toBeGreaterThan(0);
    for (const item of scene.items) {
      expect(item.kind).toBe('raster');
      const box = item.kind === 'raster' ? item.box : [0, 0, 0, 0];
      expect(box[0]).toBeGreaterThanOrEqual(0);
      expect(box[1]).toBeGreaterThanOrEqual(0);
      expect(box[2]).toBeLessThanOrEqual(400);
      expect(box[3]).toBeLessThanOrEqual(500);
    }
    const [first] = scene.items as [SceneRaster];
    expect(decode(mupdf, first.data).width).toBeGreaterThan(0);
  });

  it('cuts the fill of an outlined rectangle far off the page and draws its outline as a picture', async () => {
    const { scene } = await sceneOf(
      await contentOnly('0 1 0 rg 0 0 1 RG 6 w -200000 -200000 400000 400000 re B'),
    );
    expect(scene.items.map((item) => item.kind)).toEqual(['shape', 'raster']);
    const [fill, outline] = scene.items as [SceneShape, SceneRaster];
    close(fill.box, [0, 0, 400, 500]);
    expect(fill.fill?.color).toBe(0x00ff00);
    close(outline.box, [0, 0, 400, 500]);
  });
});
