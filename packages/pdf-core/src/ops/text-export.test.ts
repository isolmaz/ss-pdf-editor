/**
 * Text export against real bytes, read back through pdf.js. The wrong answers that matter:
 * two words glued together or one word split by a kerning gap, a wrapped paragraph kept as
 * several (or two paragraphs merged), pages in selection order instead of document order,
 * a scanned page missing from the report of empty pages, a BOM in the Markdown file or none
 * in the text file Notepad has to read as UTF-8, and a bad selection that leaves the
 * engine's worker running.
 */

import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { exportText } from './text-export';

const run = { signal: new AbortController().signal };

/** One 600×400 page per content stream, Helvetica as `/F`. */
async function pages(...contents: string[]): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  contents.forEach((content, index) => {
    doc.insertPage(index, doc.addPage([0, 0, 600, 400], 0, { Font: { F: font } }, content));
  });
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

const at = (x: number, y: number, text: string, size = 12) => `BT /F ${size} Tf ${x} ${y} Td (${text}) Tj ET`;

/** A heading, a two-line paragraph, a gap, and a second paragraph; words and kerning on one line. */
const ARTICLE = [
  at(50, 360, 'Baslik', 24),
  at(50, 320, 'Birinci paragraf'),
  at(50, 305, 'ikinci satir'),
  at(50, 240, 'Hel'),
  at(50 + 17.34, 240, 'lo'),
  at(140, 240, 'World'),
  // A slightly raised piece still belongs to the line.
  at(200, 240.4, 'again'),
].join('\n');

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

describe('exportText', () => {
  it('writes plain text with the line breaks the page has, a blank line between paragraphs and a BOM', async () => {
    const result = await exportText(
      await pages(ARTICLE),
      { pages: [0], format: 'text', baseName: 'Rapor.PDF' },
      run,
    );
    expect(result.file.name).toBe('Rapor.txt');
    expect(result.file.mime).toBe('text/plain;charset=utf-8');
    expect([...result.file.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = decode(result.file.bytes).slice(1);
    expect(text).toBe('Baslik\n\nBirinci paragraf\nikinci satir\n\nHello World again\n');
    expect(result.emptyPages).toEqual([]);
    expect(result.characterCount).toBe(
      'Baslik\n\nBirinci paragraf\nikinci satir\n\nHello World again'.length,
    );
  });

  it('re-flows a wrapped paragraph into one line for Markdown, with no BOM, and breaks pages with a rule', async () => {
    const result = await exportText(
      await pages(ARTICLE, at(50, 300, 'Ikinci sayfa')),
      { pages: [0, 1], format: 'markdown', baseName: 'Rapor' },
      run,
    );
    expect(result.file.name).toBe('Rapor.md');
    expect(result.file.mime).toBe('text/markdown;charset=utf-8');
    expect(decode(result.file.bytes)).toBe(
      'Baslik\n\nBirinci paragraf ikinci satir\n\nHello World again\n\n---\n\nIkinci sayfa\n',
    );
  });

  it('numbers the pages between them in plain text, in document order whatever the selection order', async () => {
    const result = await exportText(
      await pages(at(50, 300, 'Bir'), at(50, 300, 'Iki'), at(50, 300, 'Uc')),
      { pages: [2, 0], format: 'text', baseName: 'x' },
      run,
    );
    expect(decode(result.file.bytes).slice(1)).toBe('Bir\n\n----- 3 -----\n\nUc\n');
  });

  it('reports a page without text as empty and counts only the characters it exported', async () => {
    const result = await exportText(
      await pages(at(50, 300, 'Abc'), '0 0 10 10 re f'),
      { pages: [0, 1], format: 'markdown', baseName: 'x' },
      run,
    );
    expect(result.emptyPages).toEqual([1]);
    expect(result.characterCount).toBe(3);
    expect(decode(result.file.bytes)).toBe('Abc\n\n---\n\n\n');
  });

  it('ignores a line of spaces, and reports a page of nothing but spaces as empty', async () => {
    const result = await exportText(
      await pages(`${at(50, 300, 'Bir')}\n${at(50, 285, ' ')}\n${at(50, 270, 'Iki')}`, at(50, 300, '   ')),
      { pages: [0, 1], format: 'markdown', baseName: 'x' },
      run,
    );
    // The spaces carry no line of their own: the two words are 30 pt apart, so two paragraphs.
    expect(decode(result.file.bytes)).toBe('Bir\n\nIki\n\n---\n\n\n');
    expect(result.emptyPages).toEqual([1]);
  });

  it('reports progress per page', async () => {
    const events: string[] = [];
    await exportText(
      await pages(at(50, 300, 'a'), at(50, 300, 'b')),
      { pages: [0, 1], format: 'text', baseName: 'x' },
      {
        signal: run.signal,
        onProgress: (event) => events.push(`${event.phase}:${event.labelKey}:${event.done}/${event.total}`),
      },
    );
    expect(events).toEqual([
      'text:op.progress.textExport:0/2',
      'text:op.progress.textExport:1/2',
      'text:op.progress.textExport:2/2',
    ]);
  });

  it('refuses an empty selection', async () => {
    await expect(
      exportText(await pages('0 0 1 1 re f'), { pages: [], format: 'text', baseName: 'x' }, run),
    ).rejects.toMatchObject({ code: 'selection-empty', details: { engineMessage: 'no pages to export' } });
  });

  it.each([-1, 1, 0.5, Number.NaN])('refuses page index %s as out of bounds', async (pageIndex) => {
    const failure = await exportText(
      await pages(at(50, 300, 'a')),
      { pages: [0, pageIndex], format: 'text', baseName: 'x' },
      run,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({
      code: 'range-invalid',
      details: { engineMessage: 'page index out of bounds', pageIndex },
    });
  });

  it('is cancelled before any work by an aborted signal, and between pages', async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      exportText(
        await pages(at(50, 300, 'a')),
        { pages: [0], format: 'text', baseName: 'x' },
        { signal: before.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const during = new AbortController();
    await expect(
      exportText(
        await pages(at(50, 300, 'a'), at(50, 300, 'b')),
        { pages: [0, 1], format: 'text', baseName: 'x' },
        {
          signal: during.signal,
          onProgress: (event) => {
            if (event.done === 1) during.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
