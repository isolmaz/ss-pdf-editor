/**
 * The blank document: the page count, size and orientation a reader sees, read back
 * through MuPDF, and the refusals for a count or size that is a typo.
 */

import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { blankPageDimensions, createBlankDocument } from './create';

const run = { signal: new AbortController().signal };

async function inspect(bytes: Uint8Array) {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pages = Array.from({ length: doc.countPages() }, (_value, index) => {
      const [x0, y0, x1, y1] = doc.loadPage(index).getBounds();
      return [x1 - x0, y1 - y0];
    });
    return { pages, title: doc.getMetaData('info:Title') };
  } finally {
    doc.destroy();
  }
}

describe('createBlankDocument', () => {
  it('writes the asked number of pages at the size, swapping the sides for landscape', async () => {
    const portrait = await createBlankDocument({ size: 'a4', orientation: 'portrait', pageCount: 3 }, run);
    expect((await inspect(portrait.bytes)).pages).toEqual([
      [595, 842],
      [595, 842],
      [595, 842],
    ]);
    expect(portrait.report.pageCount).toBe(3);
    const landscape = await createBlankDocument(
      { size: 'letter', orientation: 'landscape', pageCount: 1, title: '  Plan  ' },
      run,
    );
    const read = await inspect(landscape.bytes);
    expect(read.pages).toEqual([[792, 612]]);
    expect(read.title).toBe('Plan');
    expect(blankPageDimensions('legal', 'landscape')).toEqual([1008, 612]);
  });

  it('refuses a page count outside 1-500 and an unknown size', async () => {
    for (const pageCount of [0, 501, 1.5, Number.NaN]) {
      await expect(
        createBlankDocument({ size: 'a4', orientation: 'portrait', pageCount }, run),
      ).rejects.toMatchObject({ code: 'range-invalid' });
    }
    await expect(
      createBlankDocument({ size: 'b7' as never, orientation: 'portrait', pageCount: 1 }, run),
    ).rejects.toBeInstanceOf(ToolError);
  });
});
