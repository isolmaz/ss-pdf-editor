export const pageeditPart = {
  'insert.title': 'Insert Pages',
  'insert.intro':
    'Pages from the chosen source are inserted into the current document. Composition writes via the engine document: annotations and form values are preserved. Catalog is rewritten — viewer preferences, language, output intents and layer config are not carried over.',
  'insert.source': 'Source',
  'insert.source.blank': 'Blank page',
  'insert.source.image': 'From images',
  'insert.source.document': 'From another PDF',
  'insert.position': 'Position (after page N)',
  'insert.positionHint':
    'N is 1-based page number: 1 inserts after the first page. Use 0 to insert at the beginning, or total page count to insert at the end.',
  'insert.count': 'Page count to insert',
  'insert.countHint': 'Pages are created at the selected size with empty content.',
  'insert.size': 'Page size',
  'insert.size.a4': 'A4',
  'insert.size.letter': 'Letter',
  'insert.size.match': 'Same as current page',
  'insert.sizeMatchHint':
    'Size is taken from the currently viewed page at insertion time; rotated pages match orientation as read.',
  'insert.fit': 'Image placement',
  'insert.fit.fit': 'Fit',
  'insert.fit.fill': 'Fill (crop overflow)',
  'insert.fit.stretch': 'Stretch (ignore aspect ratio)',
  'insert.margin': 'Margin (mm)',
  'insert.marginHint': 'Padding between image and page edge.',
  'insert.images': 'Images',
  'insert.imagesHint': 'Each image becomes one page; PNG and JPEG supported, unreadable files skipped.',
  'insert.document': 'Source PDF',
  'insert.documentHint': 'Selected pages are copied directly from source document.',
  'insert.range': 'Source page range',
  'insert.rangeHint': 'Leave blank to insert all pages of source document.',
  'insert.progress.prepare': 'Preparing pages to insert',
  'insert.progress.place': 'Placing pages',
  'insert.note.storage': 'Annotations and form values carried over from document storage.',
  'insert.note.catalog':
    'Composition writes a new catalog: viewer preferences, language, output intents, layer (OCG) config and open action are not carried over.',
  'insert.note.info': 'Document metadata (title, author, dates) copied from base document.',
  'insert.note.labels':
    'Page labels: each page kept the label its own document gave it; a page from a document without page labels is numbered by its page number there (a new blank page reads 1).',
  'insert.note.inserted': '{count} page(s) inserted; first page at position {position}.',
  'insert.note.skipped': '{count} image(s) could not be inserted and were skipped.',

  'replace.title': 'Replace Pages',
  'replace.intro':
    'Selected pages are replaced in-place by pages produced from source; total page count does not change. Composition writes a new catalog: viewer preferences, language and layer configuration are not carried over.',
  'replace.source': 'Source for replacement pages',
  'replace.source.blank': 'Blank page',
  'replace.source.image': 'Image',
  'replace.source.document': 'Another PDF',
  'replace.countHint': 'Must produce as many replacement pages as pages being replaced.',
  'replace.sizeHint':
    '“Same as current page” generates each replacement page at the exact dimensions of the page it replaces.',
  'replace.progress.prepare': 'Preparing replacement pages',
  'replace.progress.replace': 'Replacing pages',
  'replace.note.replaced': '{count} page(s) replaced.',

  'print.scaleShrink': 'Shrink oversized pages',
  'print.perSheet': 'Pages per sheet',
  'print.booklet': 'Booklet (imposition)',
  'print.bookletHint':
    'Pages are ordered for booklet binding with duplex printing; requires four pages per physical sheet.',
  'print.duplex': 'Two-sided (duplex)',
  'print.duplex.simplex': 'Single-sided',
  'print.duplex.longEdge': 'Flip on long edge',
  'print.duplex.shortEdge': 'Flip on short edge',
  'print.duplexHint':
    'Reverse sides are placed on sheets in the produced file; choose the matching flip axis on your printer.',
  'print.margin': 'Margins (mm)',
  'print.marginHint': 'Padding at sheet edge; cells are arranged inside this padding.',
  'print.produce': 'Generate Printable PDF',
  'print.fileName': 'print.pdf',
  'print.imposeHint':
    'Pages per sheet, booklet, duplex and margin settings are applied to the generated PDF; “Print” sends pages as-is.',
  'print.producing': 'Preparing sheets: {done}/{total}',
  'print.produced': 'Print file ready: {name}',
  'print.progress.sheets': 'Generating sheets',
  'print.note.sheets': '{sheets} sheet(s), {sides} side(s) produced.',
  'print.note.simplex': 'Single-sided: no back sides generated, no duplex printer setting required.',
  'print.note.duplexLong':
    'Reverse sides placed for long-edge binding; select duplex print and flip on long edge in printer dialog.',
  'print.note.duplexShort':
    'Reverse sides placed for short-edge binding; select duplex print and flip on short edge in printer dialog.',
  'print.note.booklet':
    'Booklet imposition written for duplex printing; fold line is parallel to short edge, select flip on short edge.',
  'print.note.padded': 'Added {count} blank page(s) to complete signature booklet.',
  'print.note.actual':
    'Actual size: {count} page(s) larger than cell cropped at boundary to avoid overlapping neighboring cells.',
  'print.note.cropMarks': 'Crop marks added to cell cut corners.',
  'print.note.vector': 'Page content remained vector: text is selectable and searchable.',
  'print.note.lost': 'Imposition does not carry links, annotations, form fields or bookmarks.',
  'print.note.info': 'Document info (title, author) copied from source document.',
} as const;
