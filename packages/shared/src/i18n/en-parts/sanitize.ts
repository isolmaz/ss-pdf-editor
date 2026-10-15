/** Sanitise the document (`pdf-core/ops/sanitize.ts`). */

export const sanitizePart = {
  'sanitize.title': 'Sanitize document',
  'sanitize.intro':
    'Removes what the pages do not show but the file holds: scripts, attachments, metadata, hidden layers. The result is verified; digital signatures become invalid.',
  'sanitize.remove': 'What to remove',
  'sanitize.removeHint':
    'Web links and comments are off by default because they are part of the content. Hidden layers are removed only where the page stays identical.',
  'sanitize.opt.javascript':
    'JavaScript and actions that run code (launching programs, importing files, submitting forms)',
  'sanitize.opt.files': 'Attached files',
  'sanitize.opt.metadata': 'Document metadata (the producer line stays)',
  'sanitize.opt.private': 'Private application data',
  'sanitize.opt.thumbnails': 'Thumbnails',
  'sanitize.opt.layers': 'Hidden layers',
  'sanitize.opt.links': 'External links',
  'sanitize.opt.comments': 'Comments and annotations',
  'sanitize.forms': 'Form fields',
  'sanitize.formsHint':
    'Flattening writes the values into the page and deletes the fields; removing deletes the fields and draws nothing.',
  'sanitize.forms.keep': 'Leave as they are',
  'sanitize.forms.flatten': 'Flatten into the page',
  'sanitize.forms.remove': 'Remove',
  'sanitize.done': 'Document sanitized: {count} items removed.',
  'tools.sanitize': 'Sanitize document',
  'tools.sanitizeDesc': 'Remove scripts, attachments, metadata and hidden content in one step',
  'home.tool.sanitize': 'Remove scripts, attached files, metadata and hidden layers; the output is verified.',

  'op.progress.sanitize.scan': 'Scanning and cleaning the document',
  'op.progress.sanitize.save': 'Writing the file',
  'op.progress.sanitize.verify': 'Reading the output back to verify it',
  'op.progress.sanitize.render': 'Comparing how the pages look',

  'op.note.sanitize.removed.javascript': 'Scripts and active actions: {found} found, {removed} removed.',
  'op.note.sanitize.none.javascript': 'No scripts or active actions.',
  'op.note.sanitize.removed.files': 'Attached files: {found} found, {removed} removed.',
  'op.note.sanitize.none.files': 'No attached files.',
  'op.note.sanitize.removed.metadata': 'Metadata: {found} items found, {removed} removed.',
  'op.note.sanitize.none.metadata': 'No metadata to remove.',
  'op.note.sanitize.removed.private': 'Private application data: {found} found, {removed} removed.',
  'op.note.sanitize.none.private': 'No private application data.',
  'op.note.sanitize.removed.thumbnails': 'Thumbnails: {found} found, {removed} removed.',
  'op.note.sanitize.none.thumbnails': 'No thumbnails.',
  'op.note.sanitize.removed.links': 'External links: {found} found, {removed} removed.',
  'op.note.sanitize.none.links': 'No external links.',
  'op.note.sanitize.removed.comments': 'Comments: {found} found, {removed} removed.',
  'op.note.sanitize.none.comments': 'No comments or markup.',
  'op.note.sanitize.removed.forms': 'Form fields: {found} found, {removed} removed.',
  'op.note.sanitize.none.forms': 'No form fields.',
  'op.note.sanitize.removed.layers':
    'Hidden layers: {removed} pieces of content from switched-off layers were removed and {dropped} layer definitions deleted.',
  'op.note.sanitize.none.layers': 'No hidden layer content.',
  'op.note.sanitize.removed.unused': 'Unused objects: {found} objects dropped.',
  'op.note.sanitize.none.unused': 'No unused objects.',
  'op.note.sanitize.layersLeft':
    '{count} hidden layer pieces were left in place because cutting them out could not be shown to be exact.',
  'op.note.sanitize.layersUndecided':
    'The visibility of {count} pieces of layer content (a visibility expression) could not be decided; they were not touched.',
  'op.note.sanitize.layersUnreadable':
    '{count} content streams could not be read; hidden layer content in them was not searched for.',
  'op.note.sanitize.formsLeft':
    '{count} form fields (buttons or signature fields) could not be flattened and remain.',
  'op.note.sanitize.signatureBroken':
    'The document carries a digital signature. Sanitizing rewrites the file, so the signature is no longer valid.',
  'op.note.sanitize.xfaDropped':
    'The XFA form definition was dropped; the form fields were handled separately.',
  'op.note.sanitize.media':
    '{count} 3D or rich media annotations are present; their own scripts are not read and were not changed.',
  'op.note.sanitize.unreadable': '{count} objects could not be read and were not scanned.',
  'op.note.sanitize.rendered':
    'Appearance verified: {pages} pages were drawn pixel for pixel the same before and after.',
  'op.note.sanitize.pictureChanges':
    'The pages were not compared before and after, because part of the selection changes what they show (comments, form fields, links, file attachment icons).',
  'op.note.sanitize.revisionsDropped':
    'The file held {count} revisions. It was rewritten as one, so nothing an earlier revision still contained is left in it.',
  'op.note.sanitize.nothing':
    'None of the selected categories held anything to remove; the file was not changed.',
} as const;
