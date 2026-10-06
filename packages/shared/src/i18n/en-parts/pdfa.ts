/** PDF/A: conversion dialog, report notes, checker rules and panel (mirror of `parts/pdfa.ts`). */

export const pdfaPart = {
  'pdfa.title': 'Save as PDF/A',
  'pdfa.intro':
    'Converts the document to PDF/A, the long-term archiving standard: every font is embedded, colours are converted to sRGB and the metadata is written in the standard form. Everything happens in this browser, and the conversion engine loads only when this tool is used. Right after converting, the output is checked by our own checker, and a file that breaks a rule is never offered. This check is not a full veraPDF validation.',
  'pdfa.level': 'Level',
  'pdfa.level.2b': 'PDF/A-2b (recommended)',
  'pdfa.level.2bHint': 'Based on PDF 1.7. Transparency is allowed, so pages keep their look.',
  'pdfa.level.1b': 'PDF/A-1b',
  'pdfa.level.1bHint':
    'The oldest and strictest level. Pages that use transparency become pictures: their text can no longer be selected, their links are lost and the file can grow a lot.',
  'pdfa.level.3b': 'PDF/A-3b',
  'pdfa.level.3bHint': 'Like PDF/A-2b, and it also keeps embedded files (attachments).',
  'pdfa.done': 'The PDF/A file is ready: {name}',
  'pdfa.doneAlready': 'The file already says it is {level} and passed the check; it was left as it is.',
  'tools.pdfa': 'Save as PDF/A',
  'tools.pdfaDesc': 'Convert the document to the PDF/A archive format and check it',
  'home.tool.pdfa': 'Convert the document to PDF/A-1b, 2b or 3b; the output is checked against the rules.',
  'pdfa.command.check': 'PDF/A check',

  'op.progress.pdfa.prepare': 'Preparing the document for PDF/A',
  'op.progress.pdfa.convert': 'Converting to PDF/A',
  'op.progress.pdfa.verify': 'Checking the output against the PDF/A rules',

  'op.note.pdfa.converted': 'The document was converted to {level} (Ghostscript).',
  'op.note.pdfa.colour':
    'Colours were converted to sRGB and an sRGB output intent (OutputIntent) was added; every font is embedded.',
  'op.note.pdfa.fontsSubstituted':
    '{count} font(s) were not embedded in the file; Ghostscript embedded similar fonts in their place, so letter shapes may differ from the original font.',
  'op.note.pdfa.transparencyFlattened':
    'PDF/A-1 does not allow transparency: pages that use it were flattened, and their text and links may have become a picture.',
  'op.note.pdfa.formsFlattened':
    '{count} form field(s) were drawn into the page; they can no longer be filled in.',
  'op.note.pdfa.widgetsRemoved': '{count} form button(s) or signature field(s) were removed.',
  'op.note.pdfa.signatures':
    '{count} digital signature(s) no longer validate: the file was rewritten, so signatures cannot be kept.',
  'op.note.pdfa.actionsRemoved':
    '{count} script(s) or action(s) (JavaScript, Launch…) were removed; PDF/A does not allow them.',
  'op.note.pdfa.attachmentsRemoved':
    '{count} embedded file(s) were removed ({names}); {level} does not allow attachments. Choose PDF/A-3b to keep them.',
  'op.note.pdfa.attachmentsKept': '{count} embedded file(s) were kept.',
  'op.note.pdfa.annotationsRemoved':
    '{count} annotation(s) were removed ({types}): types the level does not allow, or appearances that could not be drawn.',
  'op.note.pdfa.annotationsDropped':
    '{count} annotation(s) are not in the output ({types}): Ghostscript does not carry hidden or non-displayed annotations.',
  'op.note.pdfa.printFlagged': 'The Print flag PDF/A requires was set on {count} annotation(s).',
  'op.note.pdfa.appearancesDrawn': 'A missing appearance stream was drawn for {count} annotation(s).',
  'op.note.pdfa.encryptionRemoved': 'Encryption was removed; PDF/A does not allow an encrypted file.',
  'op.note.pdfa.lost.tags':
    'The tag structure (accessibility tree) was not kept: the output is untagged. PDF/A-1b, 2b and 3b do not require tags.',
  'op.note.pdfa.lost.outlines': 'The bookmarks are not in the output.',
  'op.note.pdfa.lost.labels': 'The page labels (numbering) are not in the output.',
  'op.note.pdfa.lost.layers': 'The layers (optional content) are not in the output.',
  'op.note.pdfa.producer':
    'The Producer field is now “{producer}”: Ghostscript writes this field itself and it cannot be changed.',
  'op.note.pdfa.textKept':
    'On the {pages} sampled page(s), {percent} of the original words can still be extracted from the output.',
  'op.note.pdfa.textLoss':
    'The text does not extract the same on some pages ({percent} of the original words were found; pages: {pages}). Search and copy may be missing or different on those pages.',
  'op.note.pdfa.pictureKept':
    'The {pages} sampled page(s) were rendered in grey before and after and compared; the largest mean difference is {difference}.',
  'op.note.pdfa.pictureDiffers':
    'These pages look different from the original: {pages}. Look at them before saving the output.',
  'op.note.pdfa.verified': 'The output was checked against {rules} {level} rule(s) and none was broken.',
  'op.note.pdfa.alreadyCompliant':
    'The file already says it is {level} and breaks none of the rules checked; it was not rewritten.',
  'op.note.pdfa.limits':
    'This check is not a full veraPDF validation: it only looks at rules that can be decided from the object structure and the content streams (see the “not checked” list in the PDF/A panel).',

  'panel.pdfa': 'PDF/A',
  'pdfa.panel.check': 'Check',
  'pdfa.panel.convert': 'Save as PDF/A…',
  'pdfa.panel.target': 'Level to check',
  'pdfa.panel.target.auto': 'What the file claims (PDF/A-2b if nothing)',
  'pdfa.panel.empty':
    'This check looks at whether the file says it is PDF/A, and whether it meets the rules that can be checked. Press “Check” to start.',
  'pdfa.panel.summary': '{pages} page(s) · {checked} rule(s) checked · {violations} violation(s)',
  'pdfa.panel.page': 'Page {page}',
  'pdfa.panel.clause': 'ISO 19005-{part}, clause {clause}',
  'pdfa.panel.more': 'and {count} more',
  'pdfa.panel.notChecked': 'What this check does not look at',
  'pdfa.panel.disclaimer':
    'This is not a full veraPDF validation. Of veraPDF’s several hundred rules, only those that can be decided from the object structure and the content streams are checked; a clean result is not a certificate.',
  'pdfa.group.fail': 'Rules that are broken',
  'pdfa.group.unchecked': 'Rules that could not be checked',
  'pdfa.group.pass': 'Rules that pass',
  'pdfa.group.na': 'Rules that do not apply to this level',
  'pdfa.verdict.no-claim': 'The file does not say it is PDF/A (no pdfaid in its XMP).',
  'pdfa.verdict.no-claim.checked': 'It was checked against {level} anyway: {count} violation(s) found.',
  'pdfa.verdict.claims-and-meets': 'The file says it is {level} and breaks none of the rules checked.',
  'pdfa.verdict.claims-with-violations': 'The file says it is {level} but breaks {count} rule(s).',
  'pdfa.verdict.unreadable': 'The file could not be read (it may need a password); it was not checked.',

  'pdfa.rule.header': 'The file header is valid (the %PDF-1.x line and a binary comment line)',
  'pdfa.violation.header':
    'The file header does not meet PDF/A: the PDF version or the binary comment line is wrong',
  'pdfa.rule.trailer':
    'The end of the file and the /ID are valid (%%EOF, no data after it, /ID in the trailer)',
  'pdfa.violation.trailer':
    'The end of the file or the trailer is wrong: %%EOF is missing, data follows it, or /ID is missing',
  'pdfa.rule.encryption': 'No encryption',
  'pdfa.violation.encryption': 'The file is encrypted (/Encrypt); PDF/A does not allow encryption',
  'pdfa.rule.structure':
    'The file structure is sound (no repair was needed; no object or xref streams in part 1)',
  'pdfa.violation.structure':
    'The file structure does not meet PDF/A: the cross-reference table had to be repaired, or part 1 has an object or xref stream',
  'pdfa.rule.streams': 'No LZW, external file or Crypt filter in any stream',
  'pdfa.violation.streams':
    'A forbidden stream feature is used: LZW compression, an external file reference or a Crypt filter',
  'pdfa.rule.xmp': 'The XMP metadata stream is present and valid',
  'pdfa.violation.xmp': 'The XMP metadata stream is missing or invalid',
  'pdfa.rule.xmp-claim': 'The PDF/A identification in the XMP (pdfaid:part, pdfaid:conformance) is right',
  'pdfa.violation.xmp-claim': 'The PDF/A identification (pdfaid) is missing or contradicts the level checked',
  'pdfa.rule.xmp-schemas': 'Every XMP property comes from a described schema',
  'pdfa.violation.xmp-schemas': 'The XMP has namespaces that are not described by a PDF/A extension schema',
  'pdfa.rule.xmp-info': 'The Info dictionary agrees with the XMP (part 1 only)',
  'pdfa.violation.xmp-info': 'Values in the Info dictionary are missing from the XMP or differ from it',
  'pdfa.rule.output-intent': 'The output intent (OutputIntent) carries a valid ICC profile',
  'pdfa.violation.output-intent': 'The output intent is missing or its ICC profile is invalid',
  'pdfa.rule.device-colour':
    'Device-dependent colours (DeviceRGB, DeviceCMYK, DeviceGray) are used only with a matching output intent',
  'pdfa.violation.device-colour':
    'A device-dependent colour is used without a matching output intent or default colour space',
  'pdfa.rule.transparency': 'Transparency meets the rule',
  'pdfa.violation.transparency':
    'Transparency breaks the rule: forbidden in part 1 (alpha, blend mode, soft mask, group); in parts 2 and 3 the group needs a /CS when there is no output intent',
  'pdfa.rule.fonts': 'Every font that paints visible text is embedded in the file',
  'pdfa.violation.fonts': 'Some fonts are not embedded or are incompletely described',
  'pdfa.rule.images': 'No forbidden key in images (/Alternates, /OPI, /Interpolate true)',
  'pdfa.violation.images': 'Images carry forbidden keys',
  'pdfa.rule.graphics-state': 'No forbidden key in the graphics state (/TR, /HTP, halftones, PostScript)',
  'pdfa.violation.graphics-state': 'The graphics state or an XObject carries forbidden keys',
  'pdfa.rule.actions': 'No forbidden action (JavaScript, Launch, Sound, Movie, ResetForm…)',
  'pdfa.violation.actions': 'Forbidden actions or scripts are present',
  'pdfa.rule.annotations':
    'Annotations are fine (no forbidden type, Print flag and appearance stream present)',
  'pdfa.violation.annotations':
    'Annotations are not fine: a forbidden type, a missing Print flag or a missing appearance stream',
  'pdfa.rule.forms': 'Form fields are fine (no NeedAppearances, XFA or field action)',
  'pdfa.violation.forms': 'Form rule broken: NeedAppearances true, XFA data or a field action',
  'pdfa.rule.layers': 'Layers are fine (none in part 1)',
  'pdfa.violation.layers':
    'Layer rule broken: layers in part 1, or a configuration without /Name or with /AS',
  'pdfa.rule.embedded-files': 'Embedded files are fine',
  'pdfa.violation.embedded-files':
    'Embedded-file rule broken: part 1 allows no attachment, part 2 only PDF/A files, and in part 3 every file needs /AFRelationship and a media type',

  'pdfa.notChecked.fontPrograms': 'The inside of embedded font programs (missing glyphs, damaged font files)',
  'pdfa.notChecked.iccBody': 'The tags of the ICC profile (only its header is read)',
  'pdfa.notChecked.syntax':
    'File syntax details (line endings, number formats); also invisible when the parser repairs a damaged structure',
  'pdfa.notChecked.xmpValues':
    'The value formats of XMP properties, and the exact match with the Info dictionary in parts 2 and 3',
  'pdfa.notChecked.embeddedPdf': 'Whether the embedded files are themselves PDF/A',
  'pdfa.notChecked.accessibility':
    'The rules of conformance level A (accessibility): tags, logical structure, Unicode mappings',
  'pdfa.notChecked.limits':
    'In very large files part of the content streams is skipped; the rules concerned then show under “could not be checked”',
} as const;
