/**
 * The Office readers on minimal packages built in the test: the structure each format
 * promises (headings, table cells, one table per sheet, one page-sized part per slide),
 * Turkish text that survives the XML round trip, and a damaged part that is reported as
 * `corrupt-document` (unreadable) or as a loss note (repaired) rather than read as an empty file.
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { docxToHtml, escapeHtml, pptxToHtml, xlsxToHtml } from './convert-ooxml';
import { docx, pptx, xlsx } from './ooxml-fixtures';

describe('convert-ooxml', () => {
  it('reads a docx into a heading, a paragraph and a table, with Turkish letters intact', async () => {
    const { parts } = await docxToHtml(await docx(), 'a.docx');
    const html = parts[0]?.html ?? '';
    expect(html).toContain('<h1>Başlık Çalışması</h1>');
    expect(html).toContain("<p>İstanbul'da ığdır şehri.</p>");
    expect(html).toMatch(/<table><tr><td><p>Hücre A<\/p><\/td><td><p>Hücre B<\/p><\/td><\/tr><\/table>/);
  });

  it('reads an xlsx sheet into one table: shared strings, numbers right-aligned, merged cells', async () => {
    const result = await xlsxToHtml(await xlsx(), 'a.xlsx');
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.html).toBe(
      '<h2>Veri</h2><table class="sheet"><tr><td>Şehir</td><td>Nüfus</td></tr>' +
        '<tr><td>Iğdır</td><td class="n">42</td></tr></table>',
    );
    const merged = await xlsxToHtml(
      await xlsx({
        sheet: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
          <row r="1"><c r="A1" t="inlineStr"><is><t>Geniş</t></is></c></row>
          <row r="2"><c r="C2" t="b"><v>1</v></c></row></sheetData>
          <mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>`,
      }),
      'b.xlsx',
    );
    const html = merged.parts[0]?.html ?? '';
    expect(html).toContain('<td colspan="2">Geniş</td><td>&#160;</td></tr>');
    expect(html).toContain('<td>TRUE</td>');
  });

  it('reads a pptx slide at the slide size, title as heading, bullet as list, in reading order', async () => {
    const { parts } = await pptxToHtml(await pptx(), 'a.pptx');
    expect(parts).toHaveLength(1);
    expect(parts[0]?.page).toEqual({ width: 720, height: 540 });
    expect(parts[0]?.html).toBe(
      '<div class="slide"><h1>Sunum Başlığı</h1><ul><li>Şişli maddesi</li></ul></div>',
    );
  });

  it('fails with corrupt-document on bytes that are no zip and on malformed XML', async () => {
    await expect(docxToHtml(new TextEncoder().encode('not a zip'), 'x.docx')).rejects.toMatchObject({
      code: 'corrupt-document',
    });
    const broken = await JSZip.loadAsync(await xlsx());
    broken.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="x');
    const bytes = await broken.generateAsync({ type: 'uint8array' });
    await expect(xlsxToHtml(bytes, 'broken.xlsx')).rejects.toMatchObject({ code: 'corrupt-document' });
  });

  it('converts a sheet cut off mid-row but reports the damaged part as a loss', async () => {
    const whole = await xlsxToHtml(await xlsx(), 'a.xlsx');
    expect(whole.notes.some((item) => item.key === 'op.note.convert.xmlDamaged')).toBe(false);
    const cut = await xlsxToHtml(
      await xlsx({
        sheet: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
          <row r="1"><c r="A1" t="inlineStr"><is><t>Yarım</t></is></c></row><row r="2"></worksheet>`,
      }),
      'cut.xlsx',
    );
    expect(cut.parts[0]?.html).toContain('<td>Yarım</td>');
    const loss = cut.notes.find((item) => item.key === 'op.note.convert.xmlDamaged');
    expect(loss?.kind).toBe('lost');
    expect(loss?.params).toEqual({ parts: 'xl/worksheets/sheet1.xml' });
  });

  it('says a zip without the format main part is the wrong kind of file, and escapes HTML', async () => {
    const empty = await new JSZip().file('hello.txt', 'x').generateAsync({ type: 'uint8array' });
    await expect(pptxToHtml(empty, 'x.pptx')).rejects.toMatchObject({ code: 'unsupported-format' });
    await expect(docxToHtml(empty, 'x.docx')).rejects.toMatchObject({ code: 'unsupported-format' });
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});
