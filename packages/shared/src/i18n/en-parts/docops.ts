export const docopsPart = {
  'op.progress.metadata': 'Writing document properties',
  'op.progress.stamp': 'Drawing stamp',
  'op.progress.impose': 'Generating sheets',
  'op.progress.compress.render': 'Converting pages to image',
  'op.progress.compress.assemble': 'Rebuilding document',
  'op.progress.textExport': 'Extracting text',

  'op.note.metadata.infoDropped': 'Info metadata fields (title, author, dates) deleted.',
  'op.note.metadata.producerKept': 'Producer string preserved: {producer}',
  'op.note.metadata.xmpDropped': 'XMP metadata packet deleted.',
  'op.note.metadata.xmpCreated': 'New XMP metadata packet written.',
  'op.note.metadata.xmpMerged': 'XMP metadata packet updated; other packet entries untouched.',
  'op.note.metadata.xmpUntouched': 'XMP packet unchanged.',

  'op.note.stamp.drawn': 'Stamp drawn on {count} page(s).',
  'op.note.stamp.fontEmbedded': 'Font embedded: {font} (required for proper character rendering).',
  'op.note.stamp.rotateAware':
    'Position calculated according to page rotation on {count} page(s); stamp reads upright on screen.',
  'op.note.stamp.untouchedPages': '{count} unselected page(s) untouched.',
  'op.note.stamp.fileTokenEmpty': '{file} token left empty because document has no title.',
  'op.note.stamp.overContent': 'Watermark drawn over page content.',
  'op.note.stamp.imageEmbedded': 'Watermark image embedded: {name}',
  'op.note.stamp.noPrint':
    'Print restriction applied via PDF Optional Content Group (OCG, print state off); viewers ignoring OCG may still print.',

  'op.note.impose.sheets': '{sheets} sheet(s) produced.',
  'op.note.impose.padded': 'Added {count} blank page(s) to complete signature booklet.',
  'op.note.impose.rotated': '{count} page(s) rotated 90° to fit cell.',
  'op.note.impose.cropMarks': 'Crop alignment marks added.',
  'op.note.impose.vector': 'Page content remained vector: text is selectable and searchable.',
  'op.note.impose.infoCopied': 'Document properties (Info) copied to new document.',
  'op.note.impose.lostInteractive':
    'Links, annotations, form fields and outline bookmarks not carried to new sheets.',

  'op.note.compress.infoDropped': 'Info fields (title, author, dates) stripped.',
  'op.note.compress.infoKept': 'Info metadata preserved.',
  'op.note.compress.structureContent': 'Content, links, annotations, bookmarks and form fields preserved.',
  'op.note.compress.rasterized':
    '{count} page(s) rasterized to image: text layer, links and annotations lost on these pages; bookmarks still lead to them.',
  'op.note.compress.greyscale': 'Pages converted to greyscale.',
  'op.note.compress.rotationBaked':
    'Rotation baked into image on {count} page(s); page size became visible dimensions.',
  'op.note.compress.otherPages': '{count} unselected page(s) kept unchanged.',
  'op.note.compress.infoCopied': 'Document properties (Info) kept.',
} as const;
