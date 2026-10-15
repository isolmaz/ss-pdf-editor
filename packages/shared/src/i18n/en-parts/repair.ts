/** Repair a damaged PDF (mirror of `parts/repair.ts`). */

export const repairPart = {
  'repair.title': 'Repair PDF',
  'repair.intro':
    'Choose a damaged PDF. Its structure is rebuilt from what can be read and the result opens in a new tab; the original is not changed.',
  'repair.file': 'PDF file',
  'repair.hint': 'Try it on a file that does not open, or opens with pages missing.',
  'repair.suffix': 'repaired',
  'repair.done': 'The file was repaired: {name}.',
  'repair.doneClean': 'The file needed no repair; it was rewritten as {name}.',
  'home.tool.repair':
    'Rebuild a damaged PDF that will not open or shows pages missing, and save a clean copy.',
  'open.repairHint': 'Try “Repair PDF” in the File menu.',
  'op.note.repair.rebuilt': 'The file was damaged; its structure was rebuilt from the objects found in it.',
  'op.note.repair.check':
    'Check the pages: content that could not be read from the damaged file cannot be restored.',
  'op.note.repair.rewritten':
    'The file needed no repair; it was rewritten as a clean file with unused objects removed.',
  'op.note.repair.signatureBroken':
    'The document carries a digital signature. Repairing rewrites the file, so the signature is no longer valid.',
  'op.note.repair.verified': 'Repair verified: the new file opens as it is and has {pages} page(s).',
} as const;
