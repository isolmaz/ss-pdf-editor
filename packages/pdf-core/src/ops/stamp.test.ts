/**
 * Stamps against real bytes and the real pinned face. The wrong answers that matter: a
 * page number that is not extractable text (drawn with a face that cannot encode `ş`), a
 * footer that lands sideways or off the displayed bottom of a rotated page, a watermark
 * image that is not drawn at all, and a no-print mark whose optional-content group does
 * not actually turn off for printing.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PDFObject } from 'mupdf';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { displayToUserPoint, geometryOf, pageGeometry, type StampOptions, stampDocument } from './stamp';

const run = { signal: new AbortController().signal };

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

/** Two A4 pages, the second turned a quarter; a title in the Info dictionary. */
async function twoPages(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, {}, ''));
  doc.insertPage(1, doc.addPage([0, 0, 595, 842], 90, {}, ''));
  doc.setMetaData('info:Title', 'Çeyrek Rapor');
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/**
 * Pages that already carry text ("Existing {n}" in Helvetica at 100,700 of the unrotated page), one
 * per rotation, with no Info dictionary at all.
 */
async function textPages(rotations: readonly (0 | 90 | 180 | 270)[], title?: string): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
  for (const [index, rotation] of rotations.entries()) {
    const contents = `BT /F1 24 Tf 100 700 Td (Existing ${index + 1}) Tj ET`;
    doc.insertPage(index, doc.addPage([0, 0, 595, 842], rotation, { Font: { F1: font } }, contents));
  }
  if (title !== undefined) doc.setMetaData('info:Title', title);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

async function redSquarePng(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 10], false);
  pixmap.clear(128);
  const png = pixmap.asPNG();
  pixmap.destroy();
  return new Uint8Array(png);
}

/** Every text line MuPDF extracts from a page, with its bounding box in displayed space. */
async function lines(bytes: Uint8Array, pageIndex: number) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    const json = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
      blocks: { lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
    };
    const bounds = page.getBounds();
    return {
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
      lines: json.blocks.flatMap((block) => block.lines ?? []),
    };
  } finally {
    doc.destroy();
  }
}

async function withDoc<T>(bytes: Uint8Array, read: (doc: import('mupdf').PDFDocument) => T): Promise<T> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return read(doc);
  } finally {
    doc.destroy();
  }
}

describe('stampDocument', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes an extractable Turkish footer at the displayed bottom of plain and rotated pages', async () => {
    const out = await stampDocument(
      await twoPages(),
      {
        kind: 'header-footer',
        pages: [0, 1],
        anchor: 'bottom-center',
        template: 'Sayfa {page}/{total} — {file} şğı',
        startAt: 1,
        fontSize: 12,
        marginMm: 10,
        skipFirst: false,
      },
      run,
    );
    expect(out.report.steps).toEqual(['load', 'font', 'stamp', 'save']);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.stamp.rotateAware');

    for (const pageIndex of [0, 1]) {
      const page = await lines(out.bytes, pageIndex);
      const footer = page.lines.find((line) => line.text.startsWith('Sayfa'));
      expect(footer?.text).toBe(`Sayfa ${pageIndex + 1}/2 — Çeyrek Rapor şğı`);
      if (footer === undefined) continue;
      // Horizontal on the displayed page, centred, and in the bottom margin band.
      expect(footer.bbox.w).toBeGreaterThan(footer.bbox.h);
      expect(footer.bbox.x + footer.bbox.w / 2).toBeCloseTo(page.width / 2, -1);
      expect(footer.bbox.y).toBeGreaterThan(page.height - 60);
      expect(footer.bbox.y + footer.bbox.h).toBeLessThan(page.height);
    }
    // Page 2 is the turned one: its displayed page is landscape.
    const turned = await lines(out.bytes, 1);
    expect(turned.width).toBeGreaterThan(turned.height);
  });

  it('numbers Bates pages from the start value with zero padding', async () => {
    const out = await stampDocument(
      await twoPages(),
      {
        kind: 'bates',
        pages: [0, 1],
        anchor: 'top-right',
        prefix: 'DAVA-',
        startAt: 7,
        digits: 4,
        fontSize: 9,
        marginMm: 8,
      },
      run,
    );
    const texts = [(await lines(out.bytes, 0)).lines, (await lines(out.bytes, 1)).lines].map((page) =>
      page.map((line) => line.text),
    );
    expect(texts).toEqual([['DAVA-0007'], ['DAVA-0008']]);
  });

  it('draws a see-through text watermark and keeps what was on the page', async () => {
    const out = await stampDocument(
      await textPages([0, 0]),
      {
        kind: 'watermark',
        pages: [0],
        text: 'GİZLİ',
        opacity: 0.3,
        rotationDegrees: 45,
        scale: 0.5,
        tile: false,
        tileSpacing: 50,
        noPrint: false,
      },
      run,
    );
    const page = await lines(out.bytes, 0);
    // The text that was on the page is still extracted, next to the watermark that was drawn over it.
    expect(page.lines.map((line) => line.text).sort()).toEqual(['Existing 1', 'GİZLİ']);
    const alpha = await withDoc(out.bytes, (doc) => {
      const states = doc.findPage(0).get('Resources').resolve().get('ExtGState').resolve();
      const found: number[] = [];
      states.forEach((value: PDFObject) => {
        found.push(value.resolve().get('ca').asNumber());
      });
      return found;
    });
    expect(alpha).toHaveLength(1);
    expect(alpha[0]).toBeCloseTo(0.3, 5);
    expect((await lines(out.bytes, 1)).lines.map((line) => line.text)).toEqual(['Existing 2']);
    // Every report line reads as a sentence: the producer note once printed `{producer}`.
    const say = createTranslator();
    for (const entry of out.report.notes) expect(say(entry.key, entry.params)).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  describe('watermark geometry', () => {
    const watermark = (overrides: Record<string, unknown>) =>
      ({
        kind: 'watermark',
        pages: [0],
        text: 'GİZLİ',
        opacity: 0.3,
        rotationDegrees: 0,
        scale: 0.5,
        tile: false,
        tileSpacing: 50,
        noPrint: false,
        ...overrides,
      }) as unknown as Parameters<typeof stampDocument>[1];

    it('sizes the text to the requested share of the page width, upright or turned', async () => {
      const upright = await lines((await stampDocument(await twoPages(), watermark({}), run)).bytes, 0);
      const box = upright.lines[0]?.bbox;
      // 0.5 of the 595-pt displayed width.
      expect(box?.w).toBeGreaterThan(0.45 * 595);
      expect(box?.w).toBeLessThan(0.55 * 595);
      expect(box?.w ?? 0).toBeGreaterThan(box?.h ?? 1);

      const small = await lines(
        (await stampDocument(await twoPages(), watermark({ scale: 0.25 }), run)).bytes,
        0,
      );
      expect(small.lines[0]?.bbox.w).toBeGreaterThan(0.2 * 595);
      expect(small.lines[0]?.bbox.w).toBeLessThan(0.3 * 595);

      // Turned 45 degrees, a wide run's bounding box is as tall as it is wide.
      const turned = await lines(
        (await stampDocument(await twoPages(), watermark({ rotationDegrees: 45 }), run)).bytes,
        0,
      );
      const diagonal = turned.lines[0]?.bbox;
      expect(Math.abs((diagonal?.w ?? 0) - (diagonal?.h ?? 0))).toBeLessThan(0.25 * (diagonal?.w ?? 1));
    });

    it('tiles at the requested spacing: as many cells as fit the displayed page', async () => {
      const count = async (tileSpacing: number) => {
        const out = await stampDocument(
          await twoPages(),
          watermark({ tile: true, tileSpacing, scale: 0.2 }),
          run,
        );
        const text = (await lines(out.bytes, 0)).lines.map((line) => line.text).join(' ');
        return text.split('GİZLİ').length - 1;
      };
      // A4 portrait is 595 × 842 pt: 50 mm (141.7 pt) fits 4 columns × 5 rows, 150 mm fits one.
      expect(await count(50)).toBe(20);
      expect(await count(150)).toBe(1);
    });
  });

  it('leaves the first page without a footer when asked, numbering the next page from the start value', async () => {
    const out = await stampDocument(
      await twoPages(),
      {
        kind: 'header-footer',
        pages: [0, 1],
        anchor: 'bottom-center',
        template: 'Sayfa {page}/{total}',
        startAt: 1,
        fontSize: 12,
        marginMm: 10,
        skipFirst: true,
      },
      run,
    );
    expect((await lines(out.bytes, 0)).lines).toEqual([]);
    expect((await lines(out.bytes, 1)).lines.map((line) => line.text)).toEqual(['Sayfa 1/2']);
  });

  it('draws an image watermark inside a no-print optional-content group', async () => {
    const out = await stampDocument(
      await twoPages(),
      {
        kind: 'watermark',
        pages: [0, 1],
        image: { bytes: await redSquarePng(), name: 'logo.png' },
        opacity: 1,
        rotationDegrees: 0,
        scale: 0.5,
        tile: false,
        tileSpacing: 50,
        noPrint: true,
      },
      run,
    );
    expect(out.report.steps).toEqual(['load', 'image', 'ocg', 'stamp', 'save']);
    const facts = await withDoc(out.bytes, (doc) => {
      const properties = doc.getTrailer().get('Root', 'OCProperties').resolve();
      const group = properties.get('OCGs').resolve().get(0).resolve();
      const autoState = properties.get('D').resolve().get('AS').resolve().get(0).resolve();
      const xobjects = doc.findPage(1).get('Resources').resolve().get('XObject').resolve();
      const images: number[] = [];
      xobjects.forEach((value: PDFObject) => {
        const image = value.resolve();
        if (image.get('Subtype').asName() === 'Image') images.push(image.get('Width').asNumber());
      });
      return {
        // The usage dictionary is where `/AS` looks for the print state.
        printState: group.get('Usage').resolve().get('Print').resolve().get('PrintState').asName(),
        event: autoState.get('Event').asName(),
        images,
        content: doc.loadPage(1).getObject().get('Contents').resolve().isArray(),
      };
    });
    expect(facts).toEqual({ printState: 'OFF', event: 'Print', images: [20], content: true });
    // Rendered, the image is on the page: the centre pixel is no longer white.
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
      const offset =
        (Math.floor(pixmap.getHeight() / 2) * pixmap.getWidth() + Math.floor(pixmap.getWidth() / 2)) * 3;
      expect(Array.from(pixmap.getPixels().slice(offset, offset + 3))).toEqual([128, 128, 128]);
      // ...and it is as wide as the requested share of the displayed width (0.5 × 595 pt), at
      // the picture's own 2:1 aspect.
      const pixels = pixmap.getPixels();
      let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
      for (let y = 0; y < pixmap.getHeight(); y += 1)
        for (let x = 0; x < pixmap.getWidth(); x += 1)
          if ((pixels[(y * pixmap.getWidth() + x) * 3] ?? 255) < 250)
            [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      expect(x1 - x0 + 1).toBeGreaterThan(293);
      expect(x1 - x0 + 1).toBeLessThan(302);
      expect(y1 - y0 + 1).toBeGreaterThan(145);
      expect(y1 - y0 + 1).toBeLessThan(153);
    } finally {
      doc.destroy();
    }
  });

  it('refuses a page the document does not have', async () => {
    await expect(
      stampDocument(
        await twoPages(),
        {
          kind: 'bates',
          pages: [5],
          anchor: 'top-right',
          prefix: '',
          startAt: 1,
          digits: 3,
          fontSize: 9,
          marginMm: 8,
        },
        run,
      ),
    ).rejects.toMatchObject({ code: 'range-invalid' });
  });
});

const footer = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: 'header-footer',
    pages: [0],
    anchor: 'bottom-center',
    template: 'Footer',
    startAt: 1,
    fontSize: 12,
    marginMm: 10,
    skipFirst: false,
    ...overrides,
  }) as unknown as StampOptions;

const textWatermark = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: 'watermark',
    pages: [0],
    text: 'DRAFT',
    opacity: 1,
    rotationDegrees: 0,
    scale: 0.5,
    tile: false,
    tileSpacing: 50,
    noPrint: false,
    ...overrides,
  }) as unknown as StampOptions;

const imageWatermark = (
  image: { bytes: Uint8Array; name: string },
  overrides: Record<string, unknown> = {},
) =>
  ({
    kind: 'watermark',
    pages: [0],
    image,
    opacity: 1,
    rotationDegrees: 0,
    scale: 0.5,
    tile: false,
    tileSpacing: 50,
    noPrint: false,
    ...overrides,
  }) as unknown as StampOptions;

describe('page geometry', () => {
  const box = { x: 10, y: 20, width: 300, height: 400 };

  it('maps a displayed point back into user space for each of the four rotations', () => {
    expect(displayToUserPoint(geometryOf(0, box), 5, 7)).toEqual({ x: 15, y: 27 });
    expect(displayToUserPoint(geometryOf(90, box), 5, 7)).toEqual({ x: 10 + 300 - 7, y: 20 + 5 });
    expect(displayToUserPoint(geometryOf(180, box), 5, 7)).toEqual({ x: 10 + 300 - 5, y: 20 + 400 - 7 });
    expect(displayToUserPoint(geometryOf(270, box), 5, 7)).toEqual({ x: 10 + 7, y: 20 + 400 - 5 });
  });

  it('normalises any multiple of 90, negative ones included, and swaps the displayed size on a quarter turn', () => {
    expect(geometryOf(-90, box)).toMatchObject({ rotation: 270, display: { width: 400, height: 300 } });
    expect(geometryOf(450, box)).toMatchObject({ rotation: 90, display: { width: 400, height: 300 } });
    expect(geometryOf(180, box)).toMatchObject({ rotation: 180, display: { width: 300, height: 400 } });
  });

  it('reads /Rotate and the CropBox of a page dictionary, and treats a missing /Rotate as upright', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 600, 800], 0, {}, ''));
    doc.insertPage(1, doc.addPage([0, 0, 600, 800], 270, {}, ''));
    doc.findPage(1).put('CropBox', [100, 100, 500, 700]);
    doc.insertPage(2, doc.addPage([0, 0, 600, 800], 0, {}, ''));
    doc.findPage(2).put('Rotate', doc.newString('sideways'));
    try {
      // A /Rotate that is not a number is no rotation.
      expect(pageGeometry(doc.findPage(2)).rotation).toBe(0);
      expect(pageGeometry(doc.findPage(0))).toEqual({
        rotation: 0,
        box: { x: 0, y: 0, width: 600, height: 800 },
        display: { width: 600, height: 800 },
      });
      expect(pageGeometry(doc.findPage(1))).toEqual({
        rotation: 270,
        box: { x: 100, y: 100, width: 400, height: 600 },
        display: { width: 600, height: 400 },
      });
    } finally {
      doc.destroy();
    }
  });
});

describe('stampDocument placement and content', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts each anchor in its own corner of the displayed page, the margin away from the edges', async () => {
    const margin = 10 * (72 / 25.4);
    const place = async (anchor: string) => {
      const out = await stampDocument(await textPages([0]), footer({ anchor }), run);
      const page = await lines(out.bytes, 0);
      const found = page.lines.find((line) => line.text === 'Footer');
      if (found === undefined) throw new Error('no footer line');
      return { ...found.bbox, pageWidth: page.width, pageHeight: page.height };
    };
    const left = await place('top-left');
    expect(left.x).toBeCloseTo(margin, 0);
    expect(left.y).toBeGreaterThan(margin - 2);
    expect(left.y).toBeLessThan(margin + 4);
    const topCentre = await place('top-center');
    expect(Math.abs(topCentre.x + topCentre.w / 2 - 595 / 2)).toBeLessThan(1);
    expect(topCentre.y).toBeLessThan(margin + 4);
    const bottomLeft = await place('bottom-left');
    expect(bottomLeft.x).toBeCloseTo(margin, 0);
    expect(bottomLeft.y + bottomLeft.h).toBeGreaterThan(842 - margin - 4);
    const bottomRight = await place('bottom-right');
    expect(Math.abs(bottomRight.x + bottomRight.w - (595 - margin))).toBeLessThan(3);
    const centre = await place('center');
    expect(Math.abs(centre.x + centre.w / 2 - 595 / 2)).toBeLessThan(1);
    expect(Math.abs(centre.y + centre.h / 2 - 842 / 2)).toBeLessThan(2);
  });

  it('keeps the footer horizontal and in the bottom band of pages turned 180 and 270 degrees, and leaves their text alone', async () => {
    const out = await stampDocument(await textPages([180, 270]), footer({ pages: [0, 1] }), run);
    for (const pageIndex of [0, 1]) {
      const page = await lines(out.bytes, pageIndex);
      const found = page.lines.find((line) => line.text === 'Footer');
      if (found === undefined) throw new Error('no footer line');
      expect(found.bbox.w).toBeGreaterThan(found.bbox.h);
      expect(found.bbox.x + found.bbox.w / 2).toBeCloseTo(page.width / 2, -1);
      expect(found.bbox.y + found.bbox.h).toBeLessThan(page.height);
      expect(found.bbox.y).toBeGreaterThan(page.height - 60);
      expect(page.lines.some((line) => line.text === `Existing ${pageIndex + 1}`)).toBe(true);
    }
    expect(out.report.notes.find((entry) => entry.key === 'op.note.stamp.rotateAware')?.params).toEqual({
      count: 2,
    });
  });

  it('draws a see-through image watermark through a graphics state, and an opaque one without any', async () => {
    const image = { bytes: await redSquarePng(), name: 'logo.png' };
    const seeThrough = await stampDocument(await twoPages(), imageWatermark(image, { opacity: 0.4 }), run);
    const opacities = await withDoc(seeThrough.bytes, (doc) => {
      const states = doc.findPage(0).get('Resources').resolve().get('ExtGState').resolve();
      const found: number[] = [];
      states.forEach((value: PDFObject) => {
        found.push(value.resolve().get('ca').asNumber());
      });
      return found;
    });
    expect(opacities).toHaveLength(1);
    expect(opacities[0]).toBeCloseTo(0.4, 5);
    const operators = await withDoc(seeThrough.bytes, (doc) => {
      const contents = doc.findPage(0).get('Contents').resolve();
      return contents
        .get(contents.length - 1)
        .readStream()
        .asString();
    });
    expect(operators).toMatch(/^q\n\/GS\d* gs\n[-\d. ]+ cm\n\/Watermark\d* Do\nQ\n$/);

    const opaque = await stampDocument(await twoPages(), imageWatermark(image), run);
    const opaqueOperators = await withDoc(opaque.bytes, (doc) => {
      const contents = doc.findPage(0).get('Contents').resolve();
      return contents
        .get(contents.length - 1)
        .readStream()
        .asString();
    });
    expect(opaqueOperators).toMatch(/^q\n[-\d. ]+ cm\n\/Watermark\d* Do\nQ\n$/);
  });

  it('embeds a JPEG watermark, and tiles an image watermark at the requested spacing', async () => {
    const mupdf = await import('mupdf');
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
    pixmap.clear(60);
    const jpeg = new Uint8Array(pixmap.asJPEG(90, false));
    pixmap.destroy();
    const out = await stampDocument(
      await twoPages(),
      imageWatermark({ bytes: jpeg, name: 'logo.jpg' }, { tile: true, tileSpacing: 100, scale: 0.1 }),
      run,
    );
    const facts = await withDoc(out.bytes, (doc) => {
      const contents = doc.findPage(0).get('Contents').resolve();
      const operators = contents
        .get(contents.length - 1)
        .readStream()
        .asString();
      const xobjects = doc.findPage(0).get('Resources').resolve().get('XObject').resolve();
      const filters: string[] = [];
      xobjects.forEach((value: PDFObject) => {
        const image = value.resolve();
        if (image.get('Subtype').asName() === 'Image') filters.push(image.get('Filter').asName());
      });
      return { draws: operators.split('Do').length - 1, filters };
    });
    // 100 mm = 283.5 pt: 2 columns × 2 rows (595/283.5 and 842/283.5 floor to 2) on the page, and the JPEG is stored as DCT.
    expect(facts).toEqual({ draws: 4, filters: ['DCTDecode'] });
    expect(out.report.notes.find((entry) => entry.key === 'op.note.stamp.imageEmbedded')?.params).toEqual({
      name: 'logo.jpg',
    });
  });

  it('refuses a watermark image that is neither PNG nor JPEG, naming the file, and one whose PNG data is cut off', async () => {
    await expect(
      stampDocument(
        await twoPages(),
        imageWatermark({ bytes: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9), name: 'logo.gif' }),
        run,
      ),
    ).rejects.toMatchObject({ code: 'unsupported', details: { path: 'logo.gif' } });
    const truncatedPng = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
    await expect(
      stampDocument(await twoPages(), imageWatermark({ bytes: truncatedPng, name: 'broken.png' }), run),
    ).rejects.toMatchObject({ code: 'internal', details: { engine: 'mupdf' } });
  });

  it('wraps a text watermark of a no-print group in marked content and registers the group once', async () => {
    const out = await stampDocument(await twoPages(), textWatermark({ noPrint: true, opacity: 0.5 }), run);
    expect(out.report.steps).toEqual(['load', 'font', 'ocg', 'stamp', 'save']);
    const operators = await withDoc(out.bytes, (doc) => {
      const contents = doc.findPage(0).get('Contents').resolve();
      return contents
        .get(contents.length - 1)
        .readStream()
        .asString();
    });
    expect(operators.startsWith('/OC /OC')).toBe(true);
    expect(operators).toMatch(/BDC\nq\n\/GS\d* gs\nBT\n/);
    expect(operators.endsWith('EMC\n')).toBe(true);
  });

  it('adds its optional-content group to the groups a document already declares', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, {}, ''));
    const existing = doc.addObject({ Type: 'OCG', Name: doc.newString('Existing layer') });
    doc
      .getTrailer()
      .get('Root')
      .put('OCProperties', doc.addObject({ OCGs: [existing], D: { Order: [existing], ON: [existing] } }));
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const out = await stampDocument(bytes, textWatermark({ noPrint: true }), run);
    const names = await withDoc(out.bytes, (read) => {
      const groups = read.getTrailer().get('Root', 'OCProperties').resolve().get('OCGs').resolve();
      const found: string[] = [];
      for (let index = 0; index < groups.length; index += 1) {
        found.push(groups.get(index).resolve().get('Name').asString());
      }
      return found;
    });
    expect(names).toEqual(['Existing layer', 'SsPdfEditor no-print stamp']);
  });

  it('uses the first-page template on page one only, and warns when {file} resolves to nothing', async () => {
    const out = await stampDocument(
      await textPages([0, 0]),
      footer({ pages: [0, 1], template: 'Page {page} of {total} {file}', firstPageTemplate: 'Cover {file}' }),
      run,
    );
    expect((await lines(out.bytes, 0)).lines.map((line) => line.text)).toContain('Cover ');
    expect((await lines(out.bytes, 1)).lines.map((line) => line.text)).toContain('Page 2 of 2 ');
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.stamp.fileTokenEmpty');
  });

  it('reads {file} from an Info dictionary that has a title, and treats an Info without a title as empty', async () => {
    const titled = await stampDocument(
      await textPages([0], 'Annual Report'),
      footer({ template: 'File {file}' }),
      run,
    );
    expect((await lines(titled.bytes, 0)).lines.map((line) => line.text)).toContain('File Annual Report');
    expect(titled.report.notes.map((entry) => entry.key)).not.toContain('op.note.stamp.fileTokenEmpty');

    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument((await textPages([0])).slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    doc.setMetaData('info:Author', 'Someone');
    const authored = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const untitled = await stampDocument(authored, footer({ template: 'File {file}' }), run);
    expect(untitled.report.notes.map((entry) => entry.key)).toContain('op.note.stamp.fileTokenEmpty');
  });
});

describe('stampDocument refusals', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses an empty page selection and a selection of only the skipped first page', async () => {
    await expect(stampDocument(await twoPages(), footer({ pages: [] }), run)).rejects.toMatchObject({
      code: 'selection-empty',
      details: { engineMessage: 'no pages to stamp' },
    });
    await expect(
      stampDocument(await twoPages(), footer({ pages: [0], skipFirst: true }), run),
    ).rejects.toMatchObject({
      code: 'selection-empty',
      details: { engineMessage: 'every selected page was skipped' },
    });
  });

  it('refuses numbers outside their range with value-out-of-range, naming the field', async () => {
    const cases: [StampOptions, string][] = [
      [footer({ fontSize: 2 }), 'fontSize must be between 4 and 200'],
      [footer({ marginMm: 101 }), 'marginMm must be between 0 and 100'],
      [textWatermark({ opacity: 1.5 }), 'opacity must be between 0 and 1'],
      [textWatermark({ scale: 9 }), 'scale must be between 0.05 and 5'],
      [textWatermark({ tile: true, tileSpacing: 2 }), 'tileSpacing must be between 5 and 500'],
      [footer({ fontSize: Number.NaN }), 'fontSize must be between 4 and 200'],
    ];
    for (const [options, message] of cases) {
      await expect(stampDocument(await twoPages(), options, run)).rejects.toMatchObject({
        code: 'value-out-of-range',
        details: { engineMessage: message },
      });
    }
  });

  it('refuses a watermark with neither text nor image, and one with both', async () => {
    const image = { bytes: await redSquarePng(), name: 'logo.png' };
    await expect(
      stampDocument(await twoPages(), textWatermark({ text: undefined }), run),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'watermark needs text or an image' },
    });
    await expect(stampDocument(await twoPages(), textWatermark({ image }), run)).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'watermark takes either text or an image, not both' },
    });
  });

  it('refuses stamp text that resolves to nothing, and a text with no measurable width', async () => {
    await expect(stampDocument(await twoPages(), footer({ template: '  ' }), run)).rejects.toMatchObject({
      code: 'selection-empty',
      details: { engineMessage: 'stamp text resolved to an empty string' },
    });
    await expect(
      stampDocument(await twoPages(), textWatermark({ text: '\u200B' }), run),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'watermark text has no measurable width' },
    });
  });

  it('stops with an AbortError, not a tool error, when the signal aborts between pages', async () => {
    const controller = new AbortController();
    await expect(
      stampDocument(await twoPages(), footer({ pages: [0, 1] }), {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.done === 1) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
