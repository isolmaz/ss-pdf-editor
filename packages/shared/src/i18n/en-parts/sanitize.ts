/** Sanitise the document (`pdf-core/ops/sanitize.ts`). */

export const sanitizePart = {
  'sanitize.title': 'Sanitize document',
  'sanitize.intro':
    'Remove, in one step, what the document carries that its pages do not show: scripts, attached files, metadata, hidden layers and private application data. Everything runs in this browser. The output is read back and every category you chose is checked to be really gone. Objects nothing refers to are always dropped. Digital signatures become invalid.',
  'sanitize.remove': 'What to remove',
  'sanitize.removeHint':
    'JavaScript covers launching programs, importing files and submitting forms too; links inside the document stay. The producer line stays in the metadata. Links to the web and comments are off by default: they are part of the content, and removing them changes how the pages look. Hidden layers are cut out only where the page can be shown to look the same.',
  'sanitize.opt.javascript': 'JavaScript and actions that run code',
  'sanitize.opt.files': 'Attached files',
  'sanitize.opt.metadata': 'Document metadata',
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
  'tools.sanitize': 'Sanitize Document',
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
    'The XFA form definition was dropped; the AcroForm fields were handled separately.',
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
