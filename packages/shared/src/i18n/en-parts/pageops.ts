export const pageopsPart = {
  'op.progress.compose.extract': 'Composing pages…',
  'op.progress.compose.rotate': 'Applying rotation',
  'op.progress.merge.documents': 'Merging documents…',
  'op.progress.split.parts': 'Generating parts',
  'op.progress.images.embed': 'Embedding images',
  'op.progress.images.render': 'Rendering pages to images',
  'op.note.compose.storage': 'Annotations and form values carried over from document storage.',
  'op.note.compose.catalog':
    'Viewer preferences, language, output intents, layer settings and the open action are not carried over to the new file.',
  'op.note.compose.rotation': 'Rotation applied to {count} page(s) (source rotation + requested angle).',
  'op.note.compose.outlineCopies':
    'Some bookmarks have a destination that could not be read, so the duplicated pages may have left them repeated up to {copies} times.',
  'op.note.compose.verified': 'Composition verified: {pages} page(s).',
  'op.note.merge.metadata':
    'Metadata from added documents not carried over; Info and XMP taken from base document.',
  'op.note.merge.encryptionDropped':
    'Password protection of the merged documents was not carried over; the merged file is unprotected.',
  'op.note.merge.structure':
    'Merged structure measured: {outline} bookmark(s), {labels} page label entries, {fields} form field(s).',
  'op.note.merge.labels':
    'Page labels: each page kept the label its own document gave it; pages of an added document without page labels are numbered 1, 2, … within that document.',
  'op.note.merge.labelsLost':
    'Page labels were planned as {expected} range(s), but the result retained {actual}.',
  'op.note.merge.outlineLost': 'Base document had {expected} bookmark(s), result retained {actual}.',
  'op.note.merge.sharedFields':
    '{count} form field name(s) appear in more than one merged document; fields with the same name now share one value.',
  'op.note.merge.verified': 'Merge verified: {pages} page(s).',
  'op.note.merge.interleaved':
    'Front and back sides alternated: {fronts} front page(s) and {backs} back page(s).',
  'op.note.merge.backsReversed': 'The back sides were taken from the last page to the first.',
  'op.note.merge.unequalFronts':
    'The front sides have {count} more page(s) than the back sides; the extra pages follow at the end.',
  'op.note.merge.unequalBacks':
    'The back sides have {count} more page(s) than the front sides; the extra pages follow at the end.',
  'op.note.images.unsupported': 'Unsupported image skipped: {name}',
  'op.note.images.failed': 'Image could not be added (may be corrupt) and was skipped: {name}',
  'op.note.images.exif': 'EXIF orientation applied on {count} image(s).',
} as const;
