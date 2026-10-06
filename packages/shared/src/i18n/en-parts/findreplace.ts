/** Find and replace across the document (`pdf-core/ops/find-replace.ts`). */

export const findReplacePart = {
  'findReplace.title': 'Find and replace',
  'findReplace.intro':
    'Find a text in the document and replace it everywhere it occurs. The old text is really removed; the new one is written in its place, at the same size and colour.',
  'findReplace.confirm': 'Replace all',
  'findReplace.find': 'Find',
  'findReplace.replace': 'Replace with',
  'findReplace.replaceHint': 'Leave it empty to delete the text that is found.',
  'findReplace.matchCase': 'Match case',
  'findReplace.wholeWord': 'Whole words only',
  'findReplace.done': '{count} matches replaced.',
  'findReplace.fromFindBar': 'Replace…',
  'cmd.findReplace.label': 'Find and replace…',
  'home.tool.findReplace': 'Replace a text everywhere in the document.',
  'op.progress.findReplace.read': 'Reading the pages',
  'op.note.findReplace.replaced': '{count} matches replaced (page {pages}).',
  'op.note.findReplace.shrunk':
    '{count} replacements were drawn slightly smaller than the text around them so they fit.',
  'op.note.findReplace.ownFont': 'The new text uses the document’s own font ({font}).',
  'op.note.findReplace.moved':
    'On {count} lines the new text did not fit in place; the rest of the line moved along in its own font.',
  'op.note.findReplace.reflowed':
    '{count} paragraphs were laid out again because the new text did not fit on its line.',
  'op.note.findReplace.overflow':
    '{count} paragraphs did not fit their old area and run further down; check them.',
  'op.note.findReplace.noRoom':
    '{count} matches did not fit their table cell even at the smallest size and were left unchanged.',
  'op.note.findReplace.skipped':
    '{count} matches are in text that cannot be edited (scanned, rotated or Type3) and were left unchanged (page {pages}).',
  'op.note.findReplace.standardFace':
    'The new text uses a standard font that is not embedded ({font}); the reader supplies it.',
} as const;
