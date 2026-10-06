/** Prepare form: find the fields of a flat PDF and create them (`pdf-core/ops/form-detect.ts`). */

export const formDetectPart = {
  'formDetect.title': 'Detect form fields',
  'cmd.formDetect.label': 'Detect form fields…',
  'home.tool.formDetect':
    'Find the lines, boxes and tick squares of a flat form and turn them into real form fields.',
  'op.progress.formDetect': 'Scanning pages for form fields',

  'formDetect.panel.intro':
    'Guess where a form without fields is meant to be filled in, review the guesses, and add them as real form fields.',
  'formDetect.panel.start': 'Detect fields',
  'formDetect.panel.scanning': 'Scanning pages…',
  'formDetect.panel.found': '{count} fields found: {high} labelled, {medium} guessed.',
  'formDetect.panel.none': 'No place to fill in was found in this document.',
  'formDetect.panel.hint':
    'Look over the frames on the page. Remove one you do not want with ✕; the rest are added.',
  'formDetect.panel.create': 'Add {count} fields',
  'formDetect.panel.cancel': 'Cancel',
  'formDetect.panel.again': 'Detect again',
  'formDetect.panel.list': 'Detected fields',
  'formDetect.panel.removedCount': '{count} fields removed.',
  'formDetect.panel.restore': 'Bring removed fields back',
  'formDetect.panel.nothingLeft': 'No fields left to add.',
  'formDetect.remove': 'Remove the field {name}',
  'formDetect.candidate': '{name} — {kind}, page {page}',
  'formDetect.confidence.high': 'Labelled',
  'formDetect.confidence.medium': 'Guessed',
  'formDetect.confidence.high.hint': 'There is a label beside it and a drawn place to write.',
  'formDetect.confidence.medium.hint':
    'The label or the place was inferred (a caption under a line, a label ending in a colon, a table header…).',
  'formDetect.needsOcr':
    '{pages} page(s) are only a picture with no text; there is no label to name a field from, so they were skipped. Run OCR first.',
  'formDetect.raster':
    '{pages} page(s) are scans: only horizontal lines were read from the pixels; boxes and circles cannot be found and the fields are guesses.',
  'formDetect.already': '{count} place(s) skipped because a form field is already there.',
  'formDetect.truncated': 'There are too many candidates; the first {count} are listed.',
  'formDetect.done': '{count} form fields added.',
  'formDetect.stale': 'The document changed; detect the fields again.',
  'formDetect.source.line': 'line',
  'formDetect.source.blank': 'dotted or underscored blank',
  'formDetect.source.box': 'box',
  'formDetect.source.comb': 'cell box',
  'formDetect.source.cell': 'table cell',
  'formDetect.source.glyph': 'mark character',
  'formDetect.source.square': 'square',
  'formDetect.source.circle': 'circle',
  'formDetect.source.colon': 'label with a colon',

  'formDetect.note.created': '{count} form fields created where they were found.',
  'formDetect.note.pageUnchanged':
    'The pages look the same: the fields were laid transparently over the lines, boxes and squares.',
  'formDetect.note.verified':
    'Every field was checked by reading the file again: name, type, page and position are as asked.',
  'formDetect.note.review':
    'Fields are guessed from how the page is drawn; check their names and positions, and fix them in the form field list if needed.',
} as const;
