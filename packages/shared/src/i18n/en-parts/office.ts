export const officePart = {
  'export.office.title': 'Export to Word, Excel or CSV',
  'export.office.intro':
    'Export the pages’ text, tables and pictures to an editable Word document, or their tables to an Excel workbook or a CSV file. Everything happens in this browser.',
  'export.office.format': 'Format',
  'export.office.format.docx': 'Word (DOCX)',
  'export.office.format.docxHint':
    'Paragraphs, headings, tables and pictures; the text reflows and can be edited.',
  'export.office.format.xlsx': 'Excel (XLSX)',
  'export.office.format.xlsxHint': 'One sheet per ruled table; pages without one row by row.',
  'export.office.format.csv': 'CSV',
  'export.office.format.csvHint': 'The tables in one file, an empty line between them.',
  'export.office.layout': 'Word layout',
  'export.office.layout.exact': 'Text and pictures, exact layout',
  'export.office.layout.exactHint': 'Editable text boxes; shapes, pictures, colours and links in place.',
  'export.office.layout.flow': 'Flowing text (best for editing)',
  'export.office.layout.flowHint':
    'Paragraphs, headings and tables you can edit in Word; the exact look of the page is not kept.',
  'export.office.layout.pageImages': 'One picture per page (exact look)',
  'export.office.layout.pageImagesHint':
    'Each page becomes one picture that looks exactly like the page; its text cannot be edited in Word.',
  'export.office.ocrLanguages': 'Languages of scanned pages',
  'export.office.ocrLanguagesHint':
    'Pages without text (scans) are read with OCR in these languages and become editable text in Word; words it was unsure of get a comment.',
  'export.office.delimiter': 'Delimiter',
  'export.office.delimiter.comma': 'Comma (,)',
  'export.office.delimiter.semicolon': 'Semicolon (;) — what Excel expects in many European locales',
  'export.office.done': 'Exported: {name}',
  'export.office.sheet.table': 'Table {n}',
  'export.office.sheet.page': 'Page {n}',
  'export.office.option': 'Word, Excel or CSV',
  'export.office.download': 'Download as Word, Excel or CSV',
  'tools.exportOffice': 'Export as Word, Excel or CSV',
  'tools.exportOfficeDesc': 'Export the PDF to Word, Excel or CSV',
  'home.tool.exportOffice': 'Turn the PDF into an editable Word document, or its tables into Excel or CSV.',

  'op.progress.exportOffice.read': 'Reading the page layout',
  'op.progress.exportOffice.write': 'Writing the file',
  'op.note.exportOffice.done':
    '{pages} pages were exported to {format}, and the file was read back to check it.',
  'op.note.exportOffice.docxApproximate':
    'The text was exported as flowing paragraphs: exact positions on the page, multi-column flow, drawings, form fields and annotations are not. Fonts are named; where one is not installed, Word uses a similar one.',
  'op.note.exportOffice.layout':
    'The page layout was rebuilt: {boxes} text boxes, {shapes} shapes and {pictures} pictures at their places; the text can be edited.',
  'op.note.exportOffice.hiddenText':
    '{count} characters of hidden text (text the PDF draws without showing it) were left out of the document.',
  'op.note.exportOffice.layoutFieldsLost':
    '{count} form fields hold a value that the PDF does not draw, so it is not in the document.',
  'op.note.exportOffice.layoutRasters':
    '{count} regions Word cannot draw (gradients, masks) were placed as pictures.',
  'op.note.exportOffice.fontsEmbedded':
    '{count} fonts were embedded in the document, so the text shows in its original typefaces.',
  'op.note.exportOffice.pageImages':
    'Each page was exported as one picture of the page at {dpi} dpi; the look is kept, but its text cannot be edited in Word.',
  'op.note.exportOffice.pageScaled':
    'Word does not accept pages larger than 22 inches (55.88 cm); these pages were scaled down proportionally (smallest ratio {percent}%): {pages}.',
  'op.note.exportOffice.tables': '{count} ruled tables were exported as tables, with their merged cells.',
  'op.note.exportOffice.streamTables':
    '{count} tables without rules were recognised from the spacing of the text and exported as borderless tables; check their columns.',
  'op.note.exportOffice.pictures': '{count} pictures were exported.',
  'op.note.exportOffice.picturesLost':
    '{count} pictures were not exported: their image data could not be read, or they sit inside a table, whose cells hold text only.',
  'op.note.exportOffice.sheets': 'The workbook has {count} sheets.',
  'op.note.exportOffice.numbers':
    '{count} cells were written as numbers. Values that read two ways (1.234: a thousand, or one point two three four?) were left as text.',
  'op.note.exportOffice.csvRows': '{rows} rows were written from {tables} tables.',
  'op.note.exportOffice.csvFormulas':
    "{count} cells began with =, +, - or @ and would run as formulas in a spreadsheet; they start with ' so they open as text.",
  'op.note.exportOffice.outsideText':
    'On pages with tables, the text outside the tables (titles, captions) was not exported.',
  'op.note.exportOffice.unruled':
    'No ruled table was found on these pages; their text was split into columns by its spacing, so check the columns: {pages}.',
  'op.note.exportOffice.noText':
    'These pages hold no readable text (they look scanned); run OCR first for editable text: {pages}.',
  'op.note.exportOffice.ocrPages':
    'These pages are pictures, so they were read with OCR; their text is editable text boxes in Word and the rest sits behind it as pictures: {pages}.',
  'op.note.exportOffice.ocrFont':
    'The scanned text is set in {families}, the typeface the scan appears to use, and the font is embedded in the document.',
  'op.note.exportOffice.ocrLowConfidence':
    '{count} words were read with low confidence and marked with a comment in Word (page number in brackets): {words}',
  'op.note.exportOffice.ocrUnavailable':
    'These pages are pictures but OCR was not available for this export; they stayed pictures and their text cannot be edited: {pages}.',
  'op.note.exportOffice.unreadable':
    '{count} characters have no Unicode meaning in the document and could not be exported (they show as �).',
} as const;
