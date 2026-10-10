/**
 * The before/after arithmetic of the PDF/A read-back: which pages are sampled, how much of a
 * page's text survives, whether two renders differ, and which annotations are counted.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { annotationCounts, comparePage, pageWords, samplePageIndices, wordRecall } from './pdfa-compare';

/** One 200 x 200 page per content string, drawn in Helvetica, with optional annotations on page 1. */
async function build(contents: readonly string[], annotations: readonly unknown[] = []): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  for (const [index, content] of contents.entries()) {
    doc.insertPage(index, doc.addPage([0, 0, 200, 200], 0, { Font: { F: font } }, content));
  }
  if (annotations.length > 0) {
    doc.findPage(0).put(
      'Annots',
      annotations.map((entry) => doc.addObject(entry)),
    );
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('pdfa-compare', () => {
  it('samples every page of a short file and the first, the last and an even spread of a long one', () => {
    expect(samplePageIndices(0, 6)).toEqual([]);
    expect(samplePageIndices(3, 6)).toEqual([0, 1, 2]);
    const picked = samplePageIndices(300, 6);
    expect(picked).toHaveLength(6);
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(299);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
    expect(new Set(picked).size).toBe(6);
  });

  it('counts a word as often as the source has it and says nothing when there is nothing to lose', () => {
    expect(wordRecall([], ['a'])).toBeNull();
    expect(wordRecall(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'])).toBe(1);
    // Two "a" in the source, one in the output: one of three words is lost.
    expect(wordRecall(['a', 'a', 'b'], ['a', 'b', 'x'])).toBeCloseTo(2 / 3, 10);
    expect(wordRecall(['a', 'b'], [])).toBe(0);
  });

  it('reads a page back as lower-cased words, and measures a missing block even on a mostly white page', async () => {
    const mupdf = await loadMupdf();
    const text = 'BT /F 14 Tf 20 150 Td (Quarterly Results 2026) Tj ET';
    const block = '0 g 20 20 60 60 re f';
    const source = openPdf(mupdf, await build([`${text}\n${block}`, text]));
    const same = openPdf(mupdf, await build([`${text}\n${block}`, text]));
    const blockLost = openPdf(mupdf, await build([text, text]));
    try {
      expect(pageWords(source, 0)).toEqual(['quarterly', 'results', '2026']);
      const identical = comparePage(mupdf, source, same, 0);
      expect(identical.mean).toBe(0);
      expect(identical.worstBlock).toBe(0);
      expect(identical.shapeDiffers).toBe(false);

      const lost = comparePage(mupdf, source, blockLost, 0);
      // A 60 x 60 pt black square on a 200 x 200 pt page is 9 % of the page, and its blocks are solid.
      expect(lost.mean).toBeGreaterThan(0.05);
      expect(lost.mean).toBeLessThan(0.15);
      expect(lost.worstBlock).toBeGreaterThan(0.9);
      expect(comparePage(mupdf, source, blockLost, 1).mean).toBe(0);
    } finally {
      source.destroy();
      same.destroy();
      blockLost.destroy();
    }
  });

  it('reports a page too wide to leave a single pixel row as entirely different, never as identical', async () => {
    const mupdf = await loadMupdf();
    // 1,000,000 x 1 pt: at the 360 px render width its one point of height is far under a pixel.
    const strip = new mupdf.PDFDocument();
    strip.insertPage(0, strip.addPage([0, 0, 1_000_000, 1], 0, {}, ''));
    const stripBytes = new Uint8Array(strip.saveToBuffer('').asUint8Array());
    strip.destroy();
    const wide = openPdf(mupdf, stripBytes);
    const normal = openPdf(mupdf, await build(['0 g 20 20 60 60 re f']));
    try {
      const result = comparePage(mupdf, wide, normal, 0);
      expect(result).toEqual({ pageIndex: 0, mean: 1, worstBlock: 0, shapeDiffers: true });
    } finally {
      wide.destroy();
      normal.destroy();
    }
  });

  it('counts annotations by subtype and leaves popups out', async () => {
    const mupdf = await loadMupdf();
    const doc = openPdf(
      mupdf,
      await build(
        ['', ''],
        [
          { Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30] },
          { Type: 'Annot', Subtype: 'Text', Rect: [40, 10, 60, 30] },
          { Type: 'Annot', Subtype: 'Link', Rect: [10, 50, 90, 70] },
          { Type: 'Annot', Subtype: 'Popup', Rect: [100, 10, 150, 60] },
          // An entry that is not a dictionary is no annotation; one without a subtype is counted as "?".
          7,
          { Type: 'Annot', Rect: [10, 90, 30, 110] },
        ],
      ),
    );
    try {
      expect(Object.fromEntries(annotationCounts(doc))).toEqual({ Text: 2, Link: 1, '?': 1 });
    } finally {
      doc.destroy();
    }
  });
});
