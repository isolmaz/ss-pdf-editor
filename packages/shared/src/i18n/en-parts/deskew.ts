export const deskewPart = {
  'deskew.title': 'Straighten pages',
  'deskew.intro':
    'Measures how far each scanned page is tilted and turns its content upright. The scan is not re-encoded and the page size stays; annotations stay in place.',
  'deskew.done': '{count} page(s) straightened.',
  'home.tool.deskew': 'Measure and fix tilted scanned pages.',
  'op.progress.deskew': 'Measuring page tilt',

  'deskew.note.straightened': 'Page {page}: {angle:degrees} of tilt removed.',
  'deskew.note.level': 'Page {page} is already straight; left as it was.',
  'deskew.note.unclear': 'Page {page} skipped: no clear text lines.',
  'deskew.note.edge': 'Page {page} skipped: turning it by {angle:degrees} would push text off the page.',
  'deskew.note.lossless':
    'Scans were not re-encoded: only a rotation was added to the page content. Page size and boxes are unchanged.',
  'deskew.note.annotations':
    '{count} straightened page(s) carry annotations, links or form fields; they stayed in place and may no longer line up with the content.',
  'deskew.note.unchanged': 'There is nothing to straighten on the selected pages; no file was written.',
} as const;
