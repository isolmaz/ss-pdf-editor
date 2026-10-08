export const redactPart = {
  'redact.title': 'Redaction (Permanent Erase)',
  'redact.intro': 'Text and graphics in marked areas are permanently deleted from the document.',
  'redact.mode.box': 'Draw rectangle',
  'redact.tool.start': 'Open redaction tool',
  'redact.tool.stop': 'Close redaction tool',
  'redact.marks': 'Marks',
  'redact.marks.empty': 'No marks yet. Draw a box on the page.',
  'redact.markCount': '{count} mark(s)',
  'redact.removeMark': 'Remove mark',
  'redact.clearMarks': 'Clear marks',
  'redact.cleanMetadata': 'Clean metadata and attachments as well',
  'redact.verify.done':
    'Verification: no text remains in the marked areas. Bookmark titles and custom document properties are not checked.',
  'redact.warning.localTrace':
    'Redaction removes content from the exported file; previous copies on your device (original file, draft, thumbnail) should be managed separately.',
  'redact.sensitive.on': 'Sensitive session: persistent draft disabled.',
  'redact.sensitive.off': 'Sensitive session disabled.',
  'redact.imageMethod': 'Image handling',
  'redact.imageMethodHint':
    'What to do when a box overlaps an image: completely remove the image or delete only pixels inside the box.',
  'redact.cleanInfo': 'Metadata (Info + XMP)',
  'redact.cleanAttachments': 'Attachments (all)',
  'redact.cleanHint': 'Selected items will be completely purged from document during redaction.',
  'redact.imageMethod.none': 'Do not touch images',
  'redact.imageMethod.remove': 'Completely remove image',
  'redact.imageMethod.pixels': 'Erase pixels inside box only',
} as const;
