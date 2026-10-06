/**
 * Conversion to PDF end to end: the output is real, selectable vector text on the chosen
 * page size (read back with MuPDF), Turkish letters survive, a document's headings become
 * the outline, and a file the converter does not read is refused by name.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { type ConvertRequest, convertToPdf } from './convert';
import { docx, pptx, xlsx } from './ooxml-fixtures';

const run = { signal: new AbortController().signal };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const base = { pageSize: 'a4', orientation: 'portrait', marginMm: 15 } as const;

async function read(bytes: Uint8Array) {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pages = Array.from({ length: doc.countPages() }, (_value, index) => {
      const page = doc.loadPage(index);
      const [x0, y0, x1, y1] = page.getBounds();
      return {
        size: [x1 - x0, y1 - y0],
        text: page.toStructuredText('preserve-whitespace').asText(),
      };
    });
    return { pages, title: doc.getMetaData('info:Title'), outline: doc.loadOutline() };
  } finally {
    doc.destroy();
  }
}

describe('convertToPdf', () => {
  it('converts a text file to selectable text on the chosen page, titled by the file name', async () => {
    const out = await convertToPdf(
      { ...base, name: 'notlar.txt', bytes: encode('Çalışma notları\nİkinci satır ığ') },
      run,
    );
    const pdf = await read(out.bytes);
    expect(out.format).toBe('txt');
    expect(out.report.pageCount).toBe(pdf.pages.length);
    expect(pdf.pages.length).toBeGreaterThan(0);
    expect(pdf.pages[0]?.size).toEqual([595, 842]);
    expect(pdf.pages[0]?.text).toContain('Çalışma notları');
    expect(pdf.pages[0]?.text).toContain('İkinci satır ığ');
    expect(pdf.title).toBe('notlar');
  });

  it('converts a semicolon CSV to a table whose cells all extract, and honours landscape', async () => {
    const out = await convertToPdf(
      {
        ...base,
        orientation: 'landscape',
        pageSize: 'letter',
        name: 'tablo.csv',
        bytes: encode('Şehir;Nüfus\nIğdır;42\nÇorum;7'),
      },
      run,
    );
    const pdf = await read(out.bytes);
    expect(pdf.pages[0]?.size).toEqual([792, 612]);
    for (const cell of ['Şehir', 'Nüfus', 'Iğdır', '42', 'Çorum']) expect(pdf.pages[0]?.text).toContain(cell);
    // The semicolon was the delimiter: the cells are not one run "Şehir;Nüfus".
    expect(pdf.pages[0]?.text).not.toContain('Şehir;Nüfus');
  });

  it('converts a docx: text extracts and its heading becomes the outline', async () => {
    const out = await convertToPdf({ ...base, name: 'rapor.docx', bytes: await docx() }, run);
    const pdf = await read(out.bytes);
    expect(pdf.pages[0]?.text).toContain('Başlık Çalışması');
    expect(pdf.pages[0]?.text).toContain("İstanbul'da ığdır şehri.");
    expect(pdf.pages[0]?.text).toContain('Hücre A');
    expect(pdf.outline?.map((item) => item.title)).toEqual(['Başlık Çalışması']);
    expect(out.report.steps).toContain('convert.outline');
  });

  it('lays out a slide at the slide size and a sheet as a page of cells', async () => {
    const slides = await read(
      (await convertToPdf({ ...base, name: 's.pptx', bytes: await pptx() }, run)).bytes,
    );
    expect(slides.pages[0]?.size).toEqual([720, 540]);
    expect(slides.pages[0]?.text).toContain('Sunum Başlığı');
    const sheet = await read(
      (await convertToPdf({ ...base, name: 'v.xlsx', bytes: await xlsx() }, run)).bytes,
    );
    expect(sheet.pages[0]?.text).toContain('Iğdır');
    expect(sheet.pages[0]?.text).toContain('42');
  });

  it('refuses an unknown extension, an unknown page size and a corrupt docx', async () => {
    const request = (patch: Partial<ConvertRequest>): ConvertRequest => ({
      ...base,
      name: 'a.txt',
      bytes: encode('x'),
      ...patch,
    });
    await expect(convertToPdf(request({ name: 'a.doc' }), run)).rejects.toMatchObject({
      code: 'unsupported-format',
    });
    await expect(convertToPdf(request({ pageSize: 'a0' as never }), run)).rejects.toMatchObject({
      code: 'range-invalid',
    });
    await expect(convertToPdf(request({ name: 'b.docx', bytes: encode('nope') }), run)).rejects.toMatchObject(
      {
        code: 'corrupt-document',
      },
    );
  });
});
