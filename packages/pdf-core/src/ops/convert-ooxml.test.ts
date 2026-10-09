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

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
/** A 1 x 1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function pack(files: Readonly<Record<string, string | Uint8Array>>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const relsXml = (items: readonly string[]): string =>
  `<Relationships xmlns="${NS_REL}">${items.join('')}</Relationships>`;
const rel = (id: string, target: string, mode = ''): string =>
  `<Relationship Id="${id}" Type="${NS_R}/x" Target="${target}"${mode}/>`;
const workbook = (sheets: string, extra = ''): string =>
  `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}">${extra}<sheets>${sheets}</sheets></workbook>`;
const sheetXml = (rows: string, tail = ''): string =>
  `<worksheet xmlns="${NS_MAIN}"><sheetData>${rows}</sheetData>${tail}</worksheet>`;

/** A one-sheet workbook with the given sheet body and optional extra parts. */
const book = (
  sheet: string,
  parts: Readonly<Record<string, string>> = {},
  options: { readonly extra?: string } = {},
): Promise<Uint8Array> =>
  pack({
    'xl/workbook.xml': workbook('<sheet name="S" sheetId="1" r:id="rId1"/>', options.extra),
    'xl/_rels/workbook.xml.rels': relsXml([rel('rId1', 'worksheets/sheet1.xml')]),
    'xl/worksheets/sheet1.xml': sheet,
    ...parts,
  });

const cells = async (bytes: Uint8Array) => (await xlsxToHtml(bytes, 'b.xlsx')).parts[0]?.html ?? '';

describe('xlsx cells: types, dates, merges and limits', () => {
  const styles = (formats: string, xfs: string) =>
    `<styleSheet xmlns="${NS_MAIN}"><numFmts>${formats}</numFmts><cellXfs>${xfs}</cellXfs></styleSheet>`;

  it('shows a date for the built-in and custom date formats, in either date system', async () => {
    const parts = {
      'xl/styles.xml': styles(
        '<numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.00"/><numFmt numFmtId="166"/><numFmt numFmtId="167" formatCode="&quot;d&quot;0 [Red]\\d"/>',
        '<xf/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="167"/>',
      ),
    };
    const rows = `<row r="1">
      <c r="A1"><v>45000</v></c>
      <c r="B1" s="1"><v>45000</v></c>
      <c r="C1" s="2"><v>45000.5</v></c>
      <c r="D1" s="3"><v>45000</v></c>
      <c r="E1" s="4"><v>45000</v></c>
      <c r="F1" s="5"><v>45000</v></c>
      <c r="G1" s="1"/>
      <c r="H1" s="9"><v>45000</v></c></row>`;
    const html = await cells(await book(sheetXml(rows), parts));
    // Style 0 has no format, 3 is a plain number, 4 has a format with no code, 5 a code of quoted and escaped letters.
    expect(html).toBe(
      '<h2>S</h2><table class="sheet"><tr><td class="n">45000</td><td>2023-03-15</td>' +
        '<td>2023-03-15 12:00:00</td><td class="n">45000</td><td class="n">45000</td><td class="n">45000</td>' +
        '<td>&#160;</td><td class="n">45000</td></tr></table>',
    );
    const system1904 = await cells(
      await book(sheetXml('<row r="1"><c r="A1" s="1"><v>45000</v></c></row>'), parts, {
        extra: '<workbookPr date1904="true"/>',
      }),
    );
    expect(system1904).toContain('<td>2027-03-16</td>');
  });

  it('reads a stylesheet that lists no cell formats, a numFmt with no id and a cell format with none', async () => {
    const parts = {
      'xl/styles.xml': `<styleSheet xmlns="${NS_MAIN}"><numFmts><numFmt formatCode="yyyy"/></numFmts></styleSheet>`,
    };
    expect(
      await cells(await book(sheetXml('<row r="1"><c r="A1" s="0"><v>45000</v></c></row>'), parts)),
    ).toBe('<h2>S</h2><table class="sheet"><tr><td class="n">45000</td></tr></table>');
  });

  it('reads booleans, inline rich text, shared strings out of range and cells without a reference', async () => {
    const sheet = sheetXml(`<row r="1">
      <c r="A1" t="b"><v>0</v></c>
      <c r="B1" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r><r/></is></c>
      <c r="C1" t="inlineStr"/>
      <c r="D1" t="s"><v>99</v></c>
      <c r="E1" t="s"><v>0</v></c>
      <c><v>7</v></c>
      <c r="??"><v>8</v></c>
      <c r="F1"/></row>`);
    const html = await cells(
      await book(sheet, {
        'xl/sharedStrings.xml': `<sst xmlns="${NS_MAIN}"><si><r><t>x</t></r><r><t>y</t></r></si></sst>`,
      }),
    );
    expect(html).toBe(
      '<h2>S</h2><table class="sheet"><tr><td>FALSE</td><td>ab</td><td>&#160;</td><td>&#160;</td><td>xy</td></tr></table>',
    );
  });

  it('spans merged cells over rows and columns and ignores a merge it cannot read', async () => {
    const sheet = sheetXml(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1" t="inlineStr"><is><t>b</t></is></c></row>
       <row r="2"><c r="A2" t="inlineStr"><is><t>c</t></is></c><c r="B2" t="inlineStr"><is><t>d</t></is></c></row>
       <row r="3"><c r="A3" t="inlineStr"><is><t>e</t></is></c></row>`,
      '<mergeCells><mergeCell ref="A1:B2"/><mergeCell ref="A3"/><mergeCell ref="??:??"/><mergeCell/></mergeCells>',
    );
    expect(await cells(await book(sheet))).toBe(
      '<h2>S</h2><table class="sheet"><tr><td rowspan="2" colspan="2">a</td></tr><tr></tr><tr><td>e</td><td>&#160;</td></tr></table>',
    );
  });

  it('shows an empty sheet as a dash and counts the cells past the used-range limit', async () => {
    expect(await cells(await book(sheetXml('<row r="1"><c r="A1"/></row>')))).toBe(
      '<h2>S</h2><p class="empty">—</p>',
    );
    const wide = await xlsxToHtml(
      await book(
        sheetXml(
          '<row r="1"><c r="A1"><v>1</v></c><c r="CW1"><v>2</v></c></row><row r="5001"><c r="A5001"><v>3</v></c></row>',
        ),
      ),
      'w.xlsx',
    );
    expect(wide.parts[0]?.html).toBe('<h2>S</h2><table class="sheet"><tr><td class="n">1</td></tr></table>');
    expect(wide.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.convert.xlsxTruncated',
      params: { rows: 5000, columns: 100, cells: 2 },
    });
  });

  it('skips sheets whose relationship or part is missing, and refuses a workbook with no readable sheet', async () => {
    const bytes = await pack({
      'xl/workbook.xml': workbook(
        '<sheet name="NoRel" r:id="rIdX"/><sheet sheetId="3"/><sheet name="NoPart" r:id="rId2"/><sheet name="Real" r:id="rId1"/>',
      ),
      'xl/_rels/workbook.xml.rels': relsXml([
        rel('rId1', 'worksheets/sheet1.xml'),
        rel('rId2', 'worksheets/gone.xml'),
        `<Relationship Target="worksheets/sheet1.xml"/>`,
        `<Relationship Id="rId9"/>`,
      ]),
      'xl/worksheets/sheet1.xml': sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>'),
    });
    const result = await xlsxToHtml(bytes, 'x.xlsx');
    expect(result.parts.map((part) => part.html)).toEqual([
      '<h2>Real</h2><table class="sheet"><tr><td class="n">1</td></tr></table>',
    ]);
    const none = await pack({
      'xl/workbook.xml': workbook('<sheet name="NoRel" r:id="rIdX"/>'),
    });
    await expect(xlsxToHtml(none, 'x.xlsx')).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { engineMessage: 'the workbook has no sheets' },
    });
    const empty = await pack({ 'hello.txt': 'x' });
    await expect(xlsxToHtml(empty, 'x.xlsx')).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { engineMessage: 'no xl/workbook.xml' },
    });
  });
});

describe('relationships and parts', () => {
  const sheetPart = sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>');
  const expected = '<h2>S</h2><table class="sheet"><tr><td class="n">1</td></tr></table>';

  it.each([
    ['an absolute target', '/xl/worksheets/sheet1.xml'],
    ['a target that climbs and repeats', '../xl/./worksheets//sheet1.xml'],
  ])('finds the sheet through %s', async (_name, target) => {
    const bytes = await pack({
      'xl/workbook.xml': workbook('<sheet name="S" r:id="rId1"/>'),
      'xl/_rels/workbook.xml.rels': relsXml([rel('rId1', target)]),
      'xl/worksheets/sheet1.xml': sheetPart,
    });
    expect(await cells(bytes)).toBe(expected);
  });

  it('reads the relationships of a part that sits at the root of the package', async () => {
    const bytes = await pack({
      'xl/workbook.xml': workbook('<sheet name="S" r:id="rId1"/>'),
      'xl/_rels/workbook.xml.rels': relsXml([rel('rId1', '/sheet.xml')]),
      'sheet.xml': sheetPart,
    });
    expect(await cells(bytes)).toBe(expected);
    const slide = await pack({
      'ppt/presentation.xml': `<p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': relsXml([rel('rId1', '/slide.xml')]),
      'slide.xml': `<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId5"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
      '_rels/slide.xml.rels': relsXml([rel('rId5', 'pic.png')]),
      'pic.png': Buffer.from(PNG_BASE64, 'base64'),
    });
    const result = await pptxToHtml(slide, 'p.pptx');
    expect(result.parts[0]?.html).toBe(
      `<div class="slide"><p><img src="data:image/png;base64,${PNG_BASE64}"></p></div>`,
    );
  });

  it('reads an r:id whose prefix the file never declares', async () => {
    const bytes = await pack({
      'xl/workbook.xml': `<workbook xmlns="${NS_MAIN}"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': relsXml([rel('rId1', 'worksheets/sheet1.xml')]),
      'xl/worksheets/sheet1.xml': sheetPart,
    });
    const result = await xlsxToHtml(bytes, 'u.xlsx');
    expect(result.parts[0]?.html).toBe(expected);
  });

  it('refuses a part that expands past the size limit, whatever it is named', async () => {
    const bytes = await pack({
      'xl/workbook.xml': `<workbook>${' '.repeat(65 * 1024 * 1024)}</workbook>`,
    });
    await expect(xlsxToHtml(bytes, 'bomb.xlsx')).rejects.toMatchObject({
      code: 'file-too-large',
      details: { path: 'xl/workbook.xml' },
    });
  }, 60_000);

  it('refuses a duplicate attribute as corrupt and an empty part as empty', async () => {
    await expect(
      xlsxToHtml(await book(sheetXml('', '').replace('<sheetData>', '<sheetData a="1" a="2">')), 'd.xlsx'),
    ).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { path: 'xl/worksheets/sheet1.xml' },
    });
    await expect(
      xlsxToHtml(await book(sheetXml(''), { 'xl/sharedStrings.xml': '' }), 'e.xlsx'),
    ).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { path: 'xl/sharedStrings.xml', engineMessage: 'empty XML' },
    });
  });

  it('takes the title from docProps/core.xml, trimmed, and none when it is empty or missing', async () => {
    const core = (title: string) =>
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${title}</cp:coreProperties>`;
    const titled = await xlsxToHtml(
      await book(sheetXml(''), { 'docProps/core.xml': core('<dc:title>  Rapor  </dc:title>') }),
      't.xlsx',
    );
    expect(titled.title).toBe('Rapor');
    const blank = await xlsxToHtml(
      await book(sheetXml(''), { 'docProps/core.xml': core('<dc:title> </dc:title>') }),
      't.xlsx',
    );
    expect(blank.title).toBeNull();
    const absent = await xlsxToHtml(await book(sheetXml(''), { 'docProps/core.xml': core('') }), 't.xlsx');
    expect(absent.title).toBeNull();
    expect((await xlsxToHtml(await book(sheetXml('')), 't.xlsx')).title).toBeNull();
  });
});

describe('pptx shapes, text and tables', () => {
  const slideXml = (tree: string, attributes = ''): string =>
    `<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"${attributes}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`;
  const deck = (
    slides: Readonly<Record<string, string>>,
    options: { readonly size?: string; readonly files?: Readonly<Record<string, string | Uint8Array>> } = {},
  ): Promise<Uint8Array> => {
    const names = Object.keys(slides);
    return pack({
      'ppt/presentation.xml': `<p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}"><p:sldIdLst>${names
        .map((_name, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`)
        .join(
          '',
        )}<p:sldId id="900" r:id="rIdGone"/><p:sldId id="901"/></p:sldIdLst>${options.size ?? ''}</p:presentation>`,
      'ppt/_rels/presentation.xml.rels': relsXml(
        names.map((name, index) => rel(`rId${index + 1}`, `slides/${name}.xml`)),
      ),
      ...Object.fromEntries(Object.entries(slides).map(([name, xml]) => [`ppt/slides/${name}.xml`, xml])),
      ...options.files,
    });
  };
  const text = (value: string, props = '') => `<a:r>${props}<a:t>${value}</a:t></a:r>`;
  const shape = (paragraphs: string, at = '', placeholder = '') =>
    `<p:sp><p:nvSpPr><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr>${at}</p:spPr><p:txBody>${paragraphs}</p:txBody></p:sp>`;
  const off = (x: number, y: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="10" cy="10"/></a:xfrm>`;
  const html = async (tree: string, options?: Parameters<typeof deck>[1]) =>
    (await pptxToHtml(await deck({ s1: slideXml(tree) }, options), 'p.pptx')).parts[0]?.html ?? '';

  it('formats runs: bold, italic, underline, size within 4–200 pt, line breaks, and drops empty ones', async () => {
    const paragraph = `<a:p>
      ${text('plain')}
      ${text('b', '<a:rPr b="1"/>')}
      ${text('i', '<a:rPr i="1"/>')}
      ${text('u', '<a:rPr u="sng"/>')}
      ${text('n', '<a:rPr u="none" sz="1800"/>')}
      ${text('t', '<a:rPr sz="100"/>')}
      ${text('h', '<a:rPr sz="30000"/>')}
      ${text('bi', '<a:rPr b="1" i="1" u="sng" sz="2400"/>')}
      ${text('')}<a:r><a:rPr/></a:r><a:br/><a:fld><a:t>7</a:t></a:fld><a:other><a:t>skipped</a:t></a:other></a:p>`;
    expect(await html(shape(paragraph))).toBe(
      '<div class="slide"><p>plain<b>b</b><i>i</i><u>u</u><span style="font-size:18pt">n</span>t' +
        'h<span style="font-size:24pt"><u><i><b>bi</b></i></u></span><br>7</p></div>',
    );
  });

  it('closes a bullet list before a paragraph, numbers count as bullets, and empty paragraphs vanish', async () => {
    const paragraphs = `
      <a:p><a:pPr><a:buChar char="-"/></a:pPr>${text('one')}</a:p>
      <a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>${text('two')}</a:p>
      <a:p>${text('')}</a:p>
      <a:p>${text('after')}</a:p>
      <a:p><a:pPr/>${text('again')}</a:p>`;
    expect(await html(shape(paragraphs))).toBe(
      '<div class="slide"><ul><li>one</li><li>two</li></ul><p>after</p><p>again</p></div>',
    );
  });

  it('orders shapes top to bottom, then left to right, then as written; a shape with no offset is at the origin', async () => {
    const tree =
      shape(`<a:p>${text('c')}</a:p>`, off(5, 5)) +
      shape(`<a:p>${text('b')}</a:p>`, off(9, 5)) +
      shape(`<a:p>${text('z')}</a:p>`) +
      shape(`<a:p>${text('y')}</a:p>`) +
      shape(`<a:p>${text('a')}</a:p>`, off(0, 1)) +
      '<p:cxnSp/>';
    expect(await html(tree)).toBe('<div class="slide"><p>z</p><p>y</p><p>a</p><p>c</p><p>b</p></div>');
  });

  it('descends into groups, makes a centred title a heading and skips a shape with no text', async () => {
    const group = `<p:grpSp>${shape(`<a:p>${text('inner')}</a:p>`)}<p:sp><p:spPr/></p:sp></p:grpSp>`;
    const title = shape(`<a:p>${text('Başlık')}</a:p>`, off(0, 0), '<p:ph type="ctrTitle"/>');
    expect(await html(title + group)).toBe('<div class="slide"><h1>Başlık</h1><p>inner</p></div>');
  });

  it('reads a table at the width its frame has on the slide, with spans, merges and empty cells', async () => {
    const cell = (body: string, attributes = '') =>
      `<a:tc${attributes}>${body === '' ? '' : `<a:txBody><a:p>${text(body)}</a:p></a:txBody>`}</a:tc>`;
    const table = `<a:tbl><a:tr>${cell('a', ' gridSpan="2"')}${cell('x', ' hMerge="1"')}${cell('c')}</a:tr><a:tr>${cell('d')}${cell('', '')}${cell('f', ' vMerge="1"')}</a:tr></a:tbl>`;
    const frame = (extent: string) =>
      `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/>${extent}</p:xfrm><a:graphic><a:graphicData>${table}</a:graphicData></a:graphic></p:graphicFrame>`;
    const rows =
      '<tr><td colspan="2"><p>a</p></td><td><p>c</p></td></tr><tr><td><p>d</p></td><td></td></tr></table>';
    expect(await html(frame('<a:ext cx="635000" cy="10"/>'))).toBe(
      `<div class="slide"><table style="width:50.0pt">${rows}</div>`,
    );
    expect(await html(frame('<a:ext cx="0" cy="10"/>'))).toBe(`<div class="slide"><table>${rows}</div>`);
    expect(await html(frame(''))).toBe(`<div class="slide"><table>${rows}</div>`);
    // A graphic frame that holds no table (a chart) draws nothing.
    expect(await html('<p:graphicFrame><p:xfrm><a:ext cx="5" cy="5"/></p:xfrm></p:graphicFrame>')).toBe(
      '<div class="slide"><p></p></div>',
    );
  });

  it('inlines pictures at their slide size, and counts what it cannot show', async () => {
    const pic = (embed: string, extent: string) =>
      `<p:pic><p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/>${extent}</a:xfrm></p:spPr></p:pic>`;
    const slide = slideXml(
      pic('rId1', '<a:ext cx="1270000" cy="635000"/>') +
        pic('rId1', '') +
        pic('rId1', '<a:ext cx="0" cy="635000"/>') +
        pic('rId2', '<a:ext cx="1" cy="1"/>') +
        pic('rId3', '<a:ext cx="1" cy="1"/>') +
        pic('rId4', '<a:ext cx="1" cy="1"/>') +
        pic('rId5', '<a:ext cx="1" cy="1"/>') +
        '<p:pic><p:blipFill/></p:pic>' +
        '<p:pic><p:blipFill><a:blip/></p:blipFill></p:pic>',
    );
    const bytes = await deck(
      { s1: slide },
      {
        files: {
          'ppt/slides/_rels/s1.xml.rels': relsXml([
            rel('rId1', '../media/p.PNG'),
            rel('rId2', '../media/vector.emf'),
            rel('rId3', 'https://example.test/p.png', ' TargetMode="External"'),
            rel('rId4', '../media/missing.png'),
          ]),
          'ppt/media/p.PNG': Buffer.from(PNG_BASE64, 'base64'),
          'ppt/media/vector.emf': new Uint8Array([1, 2, 3]),
        },
      },
    );
    const result = await pptxToHtml(bytes, 'p.pptx');
    const uri = `data:image/png;base64,${PNG_BASE64}`;
    expect(result.parts[0]?.html).toBe(
      `<div class="slide"><p><img src="${uri}" style="width:100.0pt;height:50.0pt"></p><p><img src="${uri}"></p><p><img src="${uri}"></p></div>`,
    );
    // The EMF, the external link, the part that is not in the file, the relationship that is not there and the empty blip fill.
    expect(result.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.convert.imagesSkipped',
      params: { count: 6 },
    });
  });

  it('keeps every picture of a slide, in the order they are drawn, and reports nothing skipped', async () => {
    const pic = (embed: string, cx: number, cy: number) =>
      `<p:pic><p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr><a:xfrm><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr></p:pic>`;
    const bytes = await deck(
      {
        s1: slideXml(pic('rId1', 127000, 254000) + pic('rId2', 381000, 127000) + pic('rId1', 254000, 254000)),
      },
      {
        files: {
          'ppt/slides/_rels/s1.xml.rels': relsXml([
            rel('rId1', '../media/a.png'),
            rel('rId2', '../media/b.png'),
          ]),
          'ppt/media/a.png': Buffer.from(PNG_BASE64, 'base64'),
          'ppt/media/b.png': Buffer.from(PNG_BASE64, 'base64'),
        },
      },
    );
    const result = await pptxToHtml(bytes, 'p.pptx');
    const uri = `data:image/png;base64,${PNG_BASE64}`;
    expect(result.parts[0]?.html).toBe(
      `<div class="slide"><p><img src="${uri}" style="width:10.0pt;height:20.0pt"></p><p><img src="${uri}" style="width:30.0pt;height:10.0pt"></p><p><img src="${uri}" style="width:20.0pt;height:20.0pt"></p></div>`,
    );
    expect(result.notes.map((item) => item.key)).toEqual(['op.note.convert.pptxApproximate']);
  });

  it('uses the slide size the file declares, else 10 x 7.5 inches; skips hidden slides and slides it cannot find', async () => {
    const slides = {
      s1: slideXml(shape(`<a:p>${text('shown')}</a:p>`)),
      s2: slideXml(shape(`<a:p>${text('hidden')}</a:p>`), ' show="0"'),
      s3: slideXml(''),
      s4: `<p:sld xmlns:p="${NS_P}"/>`,
    };
    const sized = await pptxToHtml(
      await deck(slides, { size: '<p:sldSz cx="12700000" cy="7620000"/>' }),
      'p.pptx',
    );
    expect(sized.parts.map((part) => part.page)).toEqual([
      { width: 1000, height: 600 },
      { width: 1000, height: 600 },
      { width: 1000, height: 600 },
    ]);
    // An empty slide is one empty paragraph, so the part still takes a page.
    expect(sized.parts[1]?.html).toBe('<div class="slide"><p></p></div>');
    expect(sized.parts[0]?.html).toBe('<div class="slide"><p>shown</p></div>');
    const unsized = await pptxToHtml(await deck({ s1: slides.s1 }), 'p.pptx');
    expect(unsized.parts[0]?.page).toEqual({ width: 720, height: 540 });
  });

  it('refuses a presentation with no slide it can read, and skips a slide whose part is missing', async () => {
    const hidden = await deck({ s1: slideXml('', ' show="0"') });
    await expect(pptxToHtml(hidden, 'p.pptx')).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { engineMessage: 'the presentation has no slides' },
    });
    const missing = await pack({
      'ppt/presentation.xml': `<p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': relsXml([rel('rId1', 'slides/gone.xml')]),
    });
    await expect(pptxToHtml(missing, 'p.pptx')).rejects.toMatchObject({ code: 'unsupported-format' });
  });
});
