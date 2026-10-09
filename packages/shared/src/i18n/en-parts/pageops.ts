export const pageopsPart = {
  'op.progress.compose.extract': 'Composing pages…',
  'op.progress.compose.rotate': 'Applying rotation',
  'op.progress.merge.documents': 'Merging documents…',
  'op.progress.split.parts': 'Generating parts',
  'op.progress.images.embed': 'Embedding images',
  'op.progress.images.render': 'Rendering pages to images',
  'op.note.compose.storage': 'Annotations and form values carried over from document storage.',
  'op.note.compose.catalog':
    'Composition writes a new catalog: viewer preferences, language, output intents, layer (OCG) config and open action are not carried over.',
  'op.note.compose.rotation': 'Rotation applied to {count} page(s) (source rotation + requested angle).',
  'op.note.compose.outlineCopies':
    'Some bookmarks have a destination that could not be read, so the duplicated pages may have left them repeated up to {copies} times (extractPages behavior).',
  'op.note.compose.verified': 'Composition verified: {pages} page(s).',
  'op.note.merge.metadata':
    'Metadata from added documents not carried over; Info and XMP taken from base document.',
  'op.note.merge.structure':
    'Merged structure measured: {outline} bookmark(s), {labels} page label entries, {fields} form field(s).',
  'op.note.merge.outlineLost': 'Base document had {expected} bookmark(s), result retained {actual}.',
  'op.note.merge.verified': 'Merge verified: {pages} page(s).',
  'op.note.images.unsupported': 'Unsupported image skipped: {name}',
  'op.note.images.failed': 'Image could not be added (may be corrupt) and was skipped: {name}',
  'op.note.images.exif': 'EXIF orientation applied on {count} image(s).',
} as const;
