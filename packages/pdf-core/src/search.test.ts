/**
 * Full-document search over the text the reader extracts. The wrong answers that matter:
 * an offset that points into the wrong place after a case fold changed a string's length
 * (`İ`), a repeated term that matches its own tail, a snippet that loses its ellipsis or
 * its offset, a second query that asks the engine again, a long scan that never lets the
 * event loop run, and a cancellation that is not the contract's `aborted` code.
 *
 * Pages are real (a PDF built here, read by pdf.js); where a test needs text that no
 * standard-14 page can spell, or a failing reader, the real handle answers `getPageText`
 * with the chosen text and everything else is the engine's own.
 */

import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from './engines/mupdf';
import { openWithPdfjs, type PdfDocumentHandle } from './engines/pdfjs-handle';
import { searchPdfText } from './search';

async function pdf(...pages: string[]): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  pages.forEach((text, index) => {
    doc.insertPage(
      index,
      doc.addPage([0, 0, 600, 200], 0, { Font: { F: font } }, `BT /F 10 Tf 10 100 Td (${text}) Tj ET`),
    );
  });
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The engine's handle on a one-page document, with the page count and page text replaced. */
async function readerOf(
  pageCount: number,
  textOf: (pageIndex: number) => Promise<string> | string,
  calls: number[] = [],
): Promise<PdfDocumentHandle> {
  const handle = await openWithPdfjs(await pdf('x'));
  return {
    ...handle,
    pageCount,
    getPageText: async (pageIndex) => {
      calls.push(pageIndex);
      return textOf(pageIndex);
    },
  };
}

describe('searchPdfText', () => {
  it('finds every match in document order across the pages of a real document, ignoring case', async () => {
    const handle = await openWithPdfjs(await pdf('Hello world, hello again', 'nothing here', 'HELLO'));
    try {
      const matches = await searchPdfText(handle, 'Hello');
      const texts = await Promise.all([0, 1, 2].map((index) => handle.getPageText(index)));
      expect(matches.map((match) => [match.pageIndex, match.index, match.length])).toEqual([
        [0, 0, 5],
        [0, 13, 5],
        [2, 0, 5],
      ]);
      expect(texts[0]?.slice(13, 18)).toBe('hello');
      expect(matches.map((match) => match.snippet)).toEqual([texts[0], texts[0], texts[2]]);
      expect(matches.map((match) => match.snippetOffset)).toEqual([0, 13, 0]);
    } finally {
      await handle.destroy();
    }
  });

  it('has no matches for an empty query and does not read a page', async () => {
    const calls: number[] = [];
    expect(await searchPdfText(await readerOf(3, () => 'abc', calls), '')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('does not let a repeated term match its own tail', async () => {
    const matches = await searchPdfText(await readerOf(1, () => 'aaaaa'), 'aa');
    expect(matches.map((match) => match.index)).toEqual([0, 2]);
  });

  it('keeps offsets valid in the original text when a character folds to a longer string', async () => {
    // `İ` lowercases to `i̇` (two code units); the fold keeps it as it is, so the offset of
    // the second word is its position in the page's own text and `İstanbul` is not `istanbul`.
    const text = 'İstanbul istanbul ISTANBUL';
    const matches = await searchPdfText(await readerOf(1, () => text), 'istanbul');
    expect(
      matches.map((match) => [match.index, text.slice(match.index, match.index + match.length)]),
    ).toEqual([
      [9, 'istanbul'],
      [18, 'ISTANBUL'],
    ]);
  });

  it('clips a snippet to 32 characters of context with ellipses, and offsets the match inside it', async () => {
    const left = 'a'.repeat(50);
    const right = 'b'.repeat(50);
    const [match] = await searchPdfText(await readerOf(1, () => `${left}NEEDLE${right}`), 'needle');
    expect(match?.snippet).toBe(`…${'a'.repeat(32)}NEEDLE${'b'.repeat(32)}…`);
    expect(match?.snippetOffset).toBe(1 + 32);
    expect(match?.snippet.slice(match.snippetOffset, match.snippetOffset + match.length)).toBe('NEEDLE');
    // Near the edges there is nothing to clip and no ellipsis.
    const [edge] = await searchPdfText(await readerOf(1, () => 'ab needle cd'), 'needle');
    expect(edge).toMatchObject({ snippet: 'ab needle cd', snippetOffset: 3 });
  });

  it('reports the pages scanned so far after each page', async () => {
    const progress: [number, number][] = [];
    await searchPdfText(await readerOf(3, () => 'x'), 'y', {
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('answers a second query from the extracted text, without asking the engine again — even for a page with no text', async () => {
    const calls: number[] = [];
    const handle = await readerOf(2, (index) => (index === 0 ? '' : 'one two'), calls);
    expect((await searchPdfText(handle, 'one')).map((match) => match.pageIndex)).toEqual([1]);
    expect((await searchPdfText(handle, 'two')).map((match) => match.pageIndex)).toEqual([1]);
    expect(calls).toEqual([0, 1]);
  });

  it('hands the event loop a turn every 32 pages', async () => {
    const events: string[] = [];
    setTimeout(() => events.push('timer'), 0);
    await searchPdfText(
      await readerOf(40, (index) => {
        events.push(`page ${index}`);
        return 'x';
      }),
      'y',
    );
    expect(events.indexOf('timer')).toBeGreaterThan(events.indexOf('page 31'));
    expect(events.indexOf('timer')).toBeLessThan(events.indexOf('page 32'));
  });

  it('ends with the aborted code when the signal is already aborted, without reading a page', async () => {
    const calls: number[] = [];
    const controller = new AbortController();
    controller.abort();
    const failure = await searchPdfText(await readerOf(2, () => 'x', calls), 'x', {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({
      code: 'aborted',
      details: { engine: 'pdfjs', engineMessage: 'signal aborted' },
    });
    expect(calls).toEqual([]);
  });

  it('ends with the aborted code when the signal is aborted between pages', async () => {
    const calls: number[] = [];
    const controller = new AbortController();
    const failure = await searchPdfText(await readerOf(5, () => 'x', calls), 'y', {
      signal: controller.signal,
      onProgress: (done) => {
        if (done === 2) controller.abort();
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'aborted' });
    expect(calls).toEqual([0, 1]);
  });

  it('maps a failing page read to a ToolError of the reader and passes a ToolError through', async () => {
    const cause = new Error('worker died');
    const failure = await searchPdfText(
      await readerOf(1, () => {
        throw cause;
      }),
      'x',
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({
      code: 'internal',
      details: { engine: 'pdfjs', engineMessage: 'worker died' },
    });
    expect((failure as ToolError).cause).toBe(cause);

    const own = new ToolError('range-invalid', { engine: 'pdfjs', engineMessage: 'no such page' });
    const passed = await searchPdfText(
      await readerOf(1, () => {
        throw own;
      }),
      'x',
    ).catch((error: unknown) => error);
    expect(passed).toBe(own);
  });
});
