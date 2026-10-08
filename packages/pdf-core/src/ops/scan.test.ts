/**
 * Scanned pages to a PDF, read back with MuPDF: one page per picture in the order given, the
 * paper that was asked for, the picture's own proportions for `fit`. The wrong answers that
 * matter: a page lost without a word (the underlying image writer only warns about a picture
 * it cannot embed), a page of the wrong paper, and an empty scan that returns an empty file.
 */

import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { FIT_LONG_SIDE_PT, type ScanPageInput, scanPagesToPdf } from './scan';

const run = { signal: new AbortController().signal };

/** A JPEG page: solid `gray`, `width` x `height` pixels. */
async function jpegPage(name: string, width: number, height: number, gray: number): Promise<ScanPageInput> {
  const mupdf = await import('mupdf');
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, width, height], false);
  pixmap.clear(gray);
  const bytes = new Uint8Array(pixmap.asJPEG(90));
  pixmap.destroy();
  return { name, bytes, width, height };
}

/** The page sizes in points and the gray at the centre of each page, read by MuPDF. */
async function readBack(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pages = [];
    for (let index = 0; index < doc.countPages(); index += 1) {
      const page = doc.loadPage(index);
      const [x0, y0, x1, y1] = page.getBounds() as [number, number, number, number];
      const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false);
      const centre =
        pixmap.getPixels()[
          Math.floor(pixmap.getHeight() / 2) * pixmap.getWidth() + Math.floor(pixmap.getWidth() / 2)
        ];
      pages.push({ width: x1 - x0, height: y1 - y0, centre: centre as number });
      pixmap.destroy();
    }
    return pages;
  } finally {
    doc.destroy();
  }
}

describe('scanPagesToPdf', () => {
  it('makes one A4 page per picture, in order, each filled by its own picture', async () => {
    const pages = [
      await jpegPage('scan-001.jpg', 300, 400, 30),
      await jpegPage('scan-002.jpg', 400, 300, 220),
    ];
    const out = await scanPagesToPdf({ pages, pageSize: 'a4' }, run);
    expect(out.report.pageCount).toBe(2);
    const read = await readBack(out.bytes);
    expect(read).toHaveLength(2);
    for (const page of read) {
      expect(page.width).toBeCloseTo(595.28, 1);
      expect(page.height).toBeCloseTo(841.89, 1);
    }
    // Order: the dark picture is page 1 (JPEG gray is near, not exact).
    expect(read[0]?.centre).toBeLessThan(60);
    expect(read[1]?.centre).toBeGreaterThan(190);
    expect(out.report.steps[0]).toBe('scan.compose');
    expect(out.report.notes.some((entry) => entry.key === 'op.note.scan.pages')).toBe(true);
  });

  it("uses US letter, and for fit the picture's proportions with an A4 long side", async () => {
    const letter = await scanPagesToPdf(
      { pages: [await jpegPage('a.jpg', 300, 400, 128)], pageSize: 'letter' },
      run,
    );
    const [sheet] = await readBack(letter.bytes);
    expect(sheet?.width).toBeCloseTo(612, 1);
    expect(sheet?.height).toBeCloseTo(792, 1);

    const fit = await scanPagesToPdf(
      {
        pages: [await jpegPage('wide.jpg', 400, 200, 128), await jpegPage('tall.jpg', 150, 300, 128)],
        pageSize: 'fit',
      },
      run,
    );
    const [wide, tall] = await readBack(fit.bytes);
    expect(wide?.width).toBeCloseTo(FIT_LONG_SIDE_PT, 1);
    expect(wide?.height).toBeCloseTo(FIT_LONG_SIDE_PT / 2, 1);
    expect(tall?.height).toBeCloseTo(FIT_LONG_SIDE_PT, 1);
    expect(tall?.width).toBeCloseTo(FIT_LONG_SIDE_PT / 2, 1);
  });

  it('refuses an empty scan with input-missing and never returns a page short', async () => {
    await expect(scanPagesToPdf({ pages: [], pageSize: 'a4' }, run)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'input-missing',
    });
    // A damaged picture among good ones: the image writer would only warn and skip it,
    // which for a scan is a lost page, so the operation fails instead.
    const good = await jpegPage('good.jpg', 200, 200, 100);
    const damaged: ScanPageInput = {
      name: 'damaged.jpg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
      width: 200,
      height: 200,
    };
    const failure = await scanPagesToPdf({ pages: [good, damaged], pageSize: 'a4' }, run).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure.code).toBe('verification-failed');
    // And an aborted signal stops it before any work.
    const controller = new AbortController();
    controller.abort();
    const progress: unknown[] = [];
    await expect(
      scanPagesToPdf(
        { pages: [good], pageSize: 'a4' },
        { signal: controller.signal, onProgress: (entry) => progress.push(entry) },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual([]);
  });

  it('refuses a scan in which a picture could not be embedded instead of returning a page short', async () => {
    const good = await jpegPage('scan-001.jpg', 300, 400, 30);
    const damaged: ScanPageInput = {
      name: 'scan-002.jpg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2]),
      width: 10,
      height: 10,
    };
    const failure = await scanPagesToPdf({ pages: [good, damaged], pageSize: 'a4' }, run).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'verification-failed' });
    expect((failure as ToolError).details.engineMessage).toBe('2 scanned page(s) became 1 page(s)');
  });

  it('refuses a fit page whose picture has not the proportions it was declared with', async () => {
    const page = await jpegPage('scan-001.jpg', 300, 400, 30);
    const failure = await scanPagesToPdf(
      { pages: [{ ...page, width: 400, height: 300 }], pageSize: 'fit' },
      run,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'verification-failed', details: { pageIndex: 0 } });
  });
});
