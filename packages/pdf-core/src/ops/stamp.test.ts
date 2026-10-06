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
import { stampDocument } from './stamp';

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
      await twoPages(),
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
    expect(page.lines.map((line) => line.text)).toEqual(['GİZLİ']);
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
    expect((await lines(out.bytes, 1)).lines).toEqual([]);
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
