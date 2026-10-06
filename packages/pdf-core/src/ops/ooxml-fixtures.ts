/**
 * Minimal Office Open XML packages built in a test with JSZip, for the converter tests
 * (`convert-ooxml.test.ts`, `convert.test.ts`). Each holds just the parts the readers
 * need: one paragraph/table, one sheet, one slide.
 */

import JSZip from 'jszip';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const rels = (items: readonly (readonly [string, string, string])[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${NS_REL}">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${NS_R}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`;

async function pack(files: Readonly<Record<string, string>>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array' });
}

/** A document of a heading, a paragraph and a two-cell table row. */
export function docx(options: { readonly body?: string } = {}): Promise<Uint8Array> {
  const body =
    options.body ??
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Başlık Çalışması</w:t></w:r></w:p>
     <w:p><w:r><w:t>İstanbul'da ığdır şehri.</w:t></w:r></w:p>
     <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Hücre A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Hücre B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  return pack({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${NS_W}"><w:body>${body}</w:body></w:document>`,
  });
}

/** One sheet `Veri`: a header row, a text row and a number row. Row 2 uses shared strings. */
export function xlsx(options: { readonly sheet?: string } = {}): Promise<Uint8Array> {
  const sheet =
    options.sheet ??
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>
    </sheetData></worksheet>`;
  return pack({
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}"><sheets><sheet name="Veri" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml']]),
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Şehir</t></si><si><t>Nüfus</t></si><si><t>Iğdır</t></si></sst>`,
  });
}

/** One 10 in × 7.5 in slide: a title and a bullet. */
export function pptx(): Promise<Uint8Array> {
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  return pack({
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${p}" xmlns:r="${NS_R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId2', 'slide', 'slides/slide1.xml']]),
    'ppt/slides/slide1.xml': `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>Sunum Başlığı</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="B"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="500000"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>Şişli maddesi</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`,
  });
}
