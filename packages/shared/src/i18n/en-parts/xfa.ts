/** XFA forms (`pdf-core/ops/xfa-form.ts`, `xfa-flatten.ts`, `pdf-ui/dialogs/XfaFormDialog.tsx`). */

export const xfaPart = {
  // the notice under the tool strip
  'xfa.banner.static':
    'Static XFA form. Fields are filled as a normal form, and every write updates the XFA data too.',
  'xfa.banner.dynamic':
    'Dynamic XFA form. The page shown is only the “Please wait…” placeholder; open the form with “Fill XFA form”.',
  'xfa.banner.more': 'What is supported?',
  'xfa.banner.supported':
    'Supported: filling a static form and keeping its XFA data in step, viewing, filling and saving a dynamic form, exporting and importing the XFA data, flattening. Not supported: XFA scripts (FormCalc, JavaScript), validation, calculation, dynamic show/hide.',
  'xfa.banner.fill': 'Fill XFA form',
  'xfa.banner.remove': 'Remove XFA',
  'xfa.banner.flatten': 'Flatten to a normal PDF',
  'xfa.banner.data': 'XFA data…',

  // commands
  'xfa.cmd.fill': 'Fill XFA form…',
  'xfa.cmd.remove': 'Remove XFA (keep the AcroForm)…',
  'xfa.cmd.flatten': 'Flatten XFA form to a normal PDF…',
  'xfa.cmd.data': 'Export or import XFA data…',
  'home.tool.xfa': 'Fill an XFA form, flatten it to a normal PDF, or remove the XFA.',

  // fill dialog
  'xfa.fill.title': 'Fill XFA form',
  'xfa.fill.intro':
    'The form is drawn by pdf.js’s XFA renderer. What you type is saved into the document’s XFA data; the page inside the file stays the placeholder.',
  'xfa.fill.loading': 'Preparing the form…',
  'xfa.fill.limits':
    'XFA scripts (FormCalc, JavaScript), validations, calculations and dynamic show/hide do not run; a field that depends on one only shows its stored value.',
  'xfa.fill.save': 'Save to document',
  'xfa.fill.export': 'Export data (XML)',
  'xfa.fill.close': 'Close',
  'xfa.fill.discard': 'Close without saving',
  'xfa.fill.unsaved':
    'What you typed is not saved into the document yet. Use “Save to document”, or close without saving.',
  'xfa.fill.nothing': 'The form has no change to save.',
  'xfa.fill.saved': '{count} value(s) saved into the document’s XFA data.',

  // remove
  'xfa.remove.title': 'Remove XFA',
  'xfa.remove.intro':
    'Removes the XFA from a static form. The fields and their values (the AcroForm) stay exactly as they are, and readers use only them. XFA scripts, calculations and validations are lost.',
  'xfa.remove.confirm': 'Remove XFA',
  'xfa.remove.done': 'XFA removed; the form fields were kept.',

  // data
  'xfa.data.title': 'XFA data',
  'xfa.data.intro':
    'Export the form’s XFA data as XML, or bring the data of an XML file into the form. In a static form the fields are filled from it too.',
  'xfa.data.fileHint': 'Acrobat’s “Export data” file (XML or XDP).',

  // flatten
  'xfa.flatten.title': 'Flatten XFA form to a normal PDF',
  'xfa.flatten.intro':
    'The pages of a dynamic form are drawn in the browser and written to a new PDF as pictures, with an invisible text layer on top so they can be searched and copied. Fill the form and save it into the document first: what you typed is flattened too. The result opens in a new tab.',
  'xfa.flatten.resolution': 'Resolution',
  'xfa.flatten.resolution.1.5': '108 dpi (small file)',
  'xfa.flatten.resolution.2': '144 dpi (recommended)',
  'xfa.flatten.resolution.3': '216 dpi (sharp, large file)',
  'xfa.flatten.done': '{count} page(s) flattened to a normal PDF.',
  'op.progress.xfa.flatten': 'Drawing the form pages',

  // report notes
  'xfa.note.synced': '{count} field value(s) were written into the XFA data too.',
  'xfa.note.notSynced':
    '{count} field(s) could not be written into the XFA data (a date or number field with a display picture, or a field with no data binding); they keep their old value in the XFA.',
  'xfa.note.removed': 'XFA removed; the document keeps only its AcroForm.',
  'xfa.note.fieldsKept': '{count} form field(s) and their values were kept as they were.',
  'xfa.note.scriptsLost': 'XFA scripts, calculations, validations and any usage rights are gone.',
  'xfa.note.imported': '{count} data value(s) were imported into the form’s XFA data.',
  'xfa.note.widgetsFilled': '{count} form field(s) were filled from this data.',
  'xfa.note.exported': '{count} data value(s) exported.',
  'xfa.note.dataSaved': '{count} value(s) saved into the document’s XFA data.',
  'xfa.note.templateKept': 'The XFA template and the other packets are unchanged.',
  'xfa.note.nothingChanged': 'The data is the same as before: no change was written to the form.',
  'xfa.note.flattened': '{count} XFA page(s) became normal PDF pages.',
  'xfa.note.flattenPictures':
    'The pages are pictures: the resolution was fixed when they were drawn, and the text is searchable and copyable only through an invisible layer.',
  'xfa.note.fieldsGone':
    'The fields can no longer be filled; the XFA template, data and scripts are not in the document.',
  'xfa.note.fonts':
    'The text was drawn with the browser’s fonts, not the form’s; line breaks may differ slightly.',
} as const;
