export const errorsPart = {
  'error.pending-redactions.message':
    'Unapplied redaction marks; saving, exporting, printing and every tool that produces a file or moves pages are held.',
  'error.pending-redactions.hint':
    'Nothing was written. Apply the redactions or clear the marks and try again; a file delivered with the marks unapplied still carries the content they were meant to remove.',
  'error.range-invalid.message': 'Page range could not be parsed.',
  'error.range-invalid.hint': 'Enter a range like 1-3, 5 or 8-10.',
  'error.value-out-of-range.message': 'A field value is outside the allowed range.',
  'error.value-out-of-range.hint': 'Enter a value between the minimum and maximum allowed limits.',
  'error.selection-empty.message': 'Select pages first.',
  'error.selection-empty.hint': 'Select one or more pages from the Pages panel.',
  'error.input-missing.message': 'This operation has nothing to work with yet.',
  'error.input-missing.hint':
    'Choose the file or images it asks for in the panel, or scan a page, then run it again.',
  'error.no-text.message': 'The selected pages hold no readable text.',
  'error.no-text.hint': 'The pages look scanned; run OCR first and try again.',
  'error.no-match.message': 'The search text was not found on the selected pages.',
  'error.no-match.hint':
    'Check the spelling, or turn off match case and whole word and try again. Scanned pages need OCR first.',
  'error.no-xfa.message': 'This document has no XFA form.',
  'error.no-xfa.hint': 'This operation only works on PDF forms that contain XFA.',
  'error.xfa-dynamic.message': 'This is a dynamic XFA form: its content exists only in the XFA template.',
  'error.xfa-dynamic.hint': 'Open it with “Fill XFA form”, or use “Flatten XFA form to a normal PDF”.',
  'error.xfa-static.message': 'This is a static XFA form: its pages are already in the PDF.',
  'error.xfa-static.hint': 'Use “Flatten form fields”, or “Remove XFA” to keep only the AcroForm.',
  'error.password-policy.message': 'Operation halted by password policy.',
  'error.password-policy.hint': 'Cannot encrypt without an open password.',
} as const;
