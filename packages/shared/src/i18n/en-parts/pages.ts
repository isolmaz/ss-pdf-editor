export const pagesPart = {
  'pages.select.all': 'Select all',
  'pages.select.none': 'Clear selection',
  'pages.selected': '{count} page(s) selected',
  'pages.moveUp': 'Move up',
  'pages.moveDown': 'Move down',
  'pages.moveTo': 'Move to',
  'pages.dragHandle': 'Move page {page}',
  'pages.moved': '{count} page(s) moved.',
  'pages.rotate.left': 'Rotate left',
  'pages.rotate.right': 'Rotate right',
  'pages.rotate.done': '{count} page(s) rotated.',
  'pages.delete': 'Delete pages',
  'pages.delete.done': '{count} page(s) deleted.',
  'pages.duplicate': 'Duplicate pages',
  'pages.duplicate.done': '{count} page(s) duplicated.',
  'pages.extract.title': 'Extract pages',
  'pages.extract.intro':
    'Selected pages become a new document; the current one is unchanged. Viewer preferences, language and layer settings are not carried over.',

  'split.title': 'Split document',
  'split.intro':
    'The document is split into separate PDFs by the chosen rule; part count and names show in the report. Viewer preferences, language and layers are dropped.',
  'split.mode': 'Split method',
  'split.mode.ranges': 'By page ranges',
  'split.mode.everyN': 'Every N pages',
  'split.mode.size': 'By file size',
  'split.mode.booklet': 'Booklet imposition',
  'split.mode.bookmarks': 'By bookmarks',
  'split.bookmarkLevel': 'Bookmark level',
  'split.bookmarkLevelHint':
    '1 cuts at the top-level bookmarks; a higher number also cuts at the ones inside them.',
  'split.bookmarks.lead': 'Beginning',
  'split.ranges': 'Page ranges',
  'split.rangesHint': 'Each range becomes a separate file, numbered in ascending order.',
  'split.everyN': 'Page count',
  'split.everyNHint': 'Number of pages per part; in booklet mode, page count per signature.',
  'split.maxSize': 'Max part size (MB)',
  'split.maxSizeHint': 'Parts will not exceed this size; if a single page is larger, it stands alone.',
  'split.partNames': 'Filename prefix',
  'split.partNamesHint':
    'Defaults to the document name; the number, the bookmark title (by bookmarks) and the extension are added.',
  'split.done': '{count} part(s) generated.',
  'split.note.oversized':
    '{count} page(s) are larger than the size limit on their own; a page cannot be cut, so each stays in its own file above the limit (page(s): {pages}).',
  'split.note.bookmarksSkipped':
    '{count} bookmark(s) point to no page of this document and were not used to cut it.',
} as const;
