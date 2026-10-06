export const convertPart = {
  'convert.title': 'Convert a document to PDF',
  'convert.intro':
    'Convert a Word, Excel, PowerPoint, HTML, text, CSV, EPUB or FB2 file to PDF in this browser. Several files become one PDF in the order of the list.',
  'convert.files': 'Files',
  'convert.hint':
    'DOCX, XLSX, PPTX, HTML, TXT, MD, CSV, TSV, EPUB, FB2. The old DOC, XLS and PPT formats are not supported.',
  'convert.pageSize': 'Page size',
  'convert.margin': 'Margin (mm)',
  'convert.command': 'Convert a document to PDF (Word, Excel, PowerPoint…)',
  'convert.converting': 'Converting {name} to PDF…',
  'convert.opened': 'The {format} file was converted to PDF and opened in a new tab.',
  'convert.unsupported':
    '{kind} files cannot be converted. Supported formats: DOCX, XLSX, PPTX, HTML, TXT, MD, CSV, TSV, EPUB, FB2. Save the file in one of them and try again.',
  'convert.imageOpened': 'The image was opened as a PDF page in a new tab.',
  'open.anyFilter': 'PDF and convertible documents',

  'op.progress.convert.read': 'Reading the document',
  'op.progress.convert.write': 'Laying out pages and writing the PDF',
  'op.note.convert.done': '{name}: the {format} file was converted to a {pages}-page PDF.',
  'op.note.convert.docxApproximate':
    'The Word document’s text, headings, lists, tables, links and images were carried over; its page layout, fonts, headers and footers and footnote placement are not reproduced exactly.',
  'op.note.convert.xlsxApproximate':
    'Each sheet became one table of its used range; formulas show their saved results only. Charts, cell formatting and column widths are not carried over.',
  'op.note.convert.xlsxTruncated':
    'Tables were cut to {rows} rows and {columns} columns; {cells} cells were left out.',
  'op.note.convert.pptxApproximate':
    'Each slide became a page of its own size, with its text, tables and pictures in reading order. The slide design (positions, backgrounds, themes) is not reproduced exactly.',
  'op.note.convert.imagesSkipped':
    '{count} images were left out because their format is not supported (such as EMF, WMF or SVG).',
  'op.note.convert.csvTruncated': 'The table was cut to {rows} rows; the file had {total}.',
  'op.note.convert.encoding': 'The file was not UTF-8; it was read as {encoding}.',
  'op.note.convert.remoteSkipped':
    'The page’s stylesheets or images on the internet were not loaded: this application does not connect to the network.',
  'op.note.convert.linksSkipped': '{count} links were left out because their address scheme is not safe.',

  'home.start.convert.title': 'Convert to PDF',
  'home.start.convert.desc': 'Make a PDF from a Word, Excel, PowerPoint, HTML or text file.',
  'home.tool.convert': 'Convert Word, Excel, PowerPoint, HTML, text and e-books to PDF.',
} as const;
