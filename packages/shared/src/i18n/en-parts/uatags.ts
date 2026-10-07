/**
 * PDF/UA check and the tags editor (`ops/pdfua.ts`, `ops/structure.ts`,
 * `panels/PdfUaView.tsx`, `panels/TagsView.tsx`, `panels/ReadingOrderLayer.tsx`).
 *
 * Key families:
 *   - `ua.rule.<id>.name | why | fix` — what a rule checks, why it matters, how to fix it;
 *   - `ua.rule.<id>.detail[.<reason>]` — the sentence for one failing place;
 *   - `ua.rule.<id>.ok` — what a passing rule says it found;
 *   - `ua.unchecked.<reason>` — why a rule could not be checked, shared by every rule;
 *   - `ua.*` — the panel's own chrome and the quick fixes;
 *   - `op.note.ua.*` / `op.note.tags.*` / `op.progress.*` — write notes and progress lines;
 *   - `tags.*` — the tags view and its error sentences (`tags.err.<StructEditError reason>`).
 *
 * The check is modelled on the Matterhorn Protocol and says so; nothing here claims
 * conformance, and colour contrast is named as not measured.
 */

export const uatagsPart = {
  'a11y.view.report': 'Report',
  'a11y.view.ua': 'PDF/UA',
  'a11y.view.tags': 'Tags',

  'op.progress.tags.write': 'Writing structure changes',
  'op.progress.tags.verify': 'Verifying the structure',
  'op.progress.ua.check': 'Checking PDF/UA rules',
  'op.progress.ua.fix': 'Applying PDF/UA fixes',

  'op.note.tags.reordered': '{count} element(s) moved.',
  'op.note.tags.retagged': '{count} element(s) given a new type.',
  'op.note.tags.altSet': 'Alternative text written for {count} element(s).',
  'op.note.tags.altCleared': 'Alternative text removed from {count} element(s).',
  'op.note.tags.scopeSet': 'Scope set on {count} header cell(s).',
  'op.note.tags.grouped': '{count} group(s) created.',
  'op.note.tags.unwrapped': '{count} wrapper element(s) dissolved.',
  'op.note.tags.artifact': '{count} element(s) became artifacts ({sequences} content sequence(s) rewritten).',
  'op.note.tags.contentRewritten': 'Content streams rewritten on {pages} page(s).',
  'op.note.tags.parentTreeCleared': '{count} entry(ies) removed from the parent tree.',
  'op.note.tags.contentPartlyMissing':
    '{count} marked-content sequence(s) could not be found in the page content; the elements were removed anyway.',

  'op.note.ua.titleSet': 'Document title written: {title}',
  'op.note.ua.xmpCreated': 'An XMP packet was created to hold the title.',
  'op.note.ua.displayTitleSet': 'DisplayDocTitle set to true.',
  'op.note.ua.langSet': 'Document language set to {lang}.',
  'op.note.ua.tabsSet': 'Tab order set to the structure on {count} page(s).',
  'op.note.ua.markedSet': 'The file is marked as tagged (/Marked true).',
  'op.note.ua.markedNoTree': 'Not marked: the file has no structure tree for the mark to describe.',
  'op.note.ua.pathsMarked': '{count} drawn path(s) on {pages} page(s) marked as artifacts.',
  'op.note.ua.pathsNone': 'No unmarked path drawing was found.',
  'op.note.ua.contentsSet': 'Link description written: {text}',
  'op.note.ua.tooltipSet': 'Tooltip of field {name} written: {tooltip}',
  'op.note.ua.annotsTagged':
    '{count} annotation(s) put in the structure tree (Link, Form or Annot elements at the end of the document).',
  'op.note.ua.annotsNone': 'No untagged annotation was found.',
  'op.note.ua.annotsNoTree': 'Annotations not tagged: the file has no structure tree.',
  'op.note.ua.annotsTreeShape':
    'Annotations not tagged: the parent tree of this file has a layout this editor does not extend.',
  'op.note.ua.targetMissing': '{count} target object(s) could not be found in the document.',
  'op.note.ua.uaMarked': 'PDF/UA-1 declared in the XMP metadata.',
  'op.note.ua.uaKept': 'The file already declares PDF/UA-{part}; left unchanged.',
  'op.note.ua.markRefused':
    'PDF/UA not declared: {count} automated rule(s) still fail or could not be checked.',
  'op.note.ua.manualRemain':
    'Reading order, quality of descriptions and language changes still need a person to verify.',

  /* ---- the PDF/UA view ---- */
  'ua.check': 'Check again',
  'ua.filter.label': 'Show',
  'ua.filter.all': 'All rules',
  'ua.filter.fail': 'Failing and unchecked',
  'ua.filter.manual': 'Needs a person',
  'ua.summary':
    '{pass} passed, {fail} failed, {manual} need a person, {na} not applicable, {unchecked} not checked.',
  'ua.declared.yes': 'The file declares PDF/UA-{part}.',
  'ua.declared.no': 'The file does not declare PDF/UA conformance.',
  'ua.disclaimer':
    'An automated check modelled on the Matterhorn Protocol. It cannot prove conformance: reading order, the quality of descriptions and language changes need a person, and colour contrast is not measured at all.',
  'ua.state.pass': 'Pass',
  'ua.state.fail': 'Fail',
  'ua.state.manual': 'Check by hand',
  'ua.state.na': 'Not applicable',
  'ua.state.unchecked': 'Not checked',
  'ua.page': 'Page {page}',
  'ua.openElement': 'Open this element in the Tags view',
  'ua.instances.more': '… and {count} more.',
  'ua.fixHow': 'How to fix:',
  'ua.reference': 'Matterhorn checkpoint group {matterhorn} · ISO 14289-1 clause {iso}',

  'ua.unchecked.untagged': 'Not checked: the file has no structure tree.',
  'ua.unchecked.truncated': 'Not checked: the document is larger than this check can walk.',
  'ua.unchecked.unreadable': 'Not checked: this part of the file could not be read.',

  'ua.fix.save': 'Save',
  'ua.fix.contents.label': 'Description of this link',
  'ua.fix.tooltip.label': 'Tooltip for {name}',
  'ua.fix.title.label': 'Document title',
  'ua.fix.title.save': 'Set title',
  'ua.fix.lang.label': 'Language tag',
  'ua.fix.lang.save': 'Set language',
  'ua.fix.lang.hint': 'For example en-US, tr-TR or de-DE.',
  'ua.fix.display-title': 'Show the title in the window bar',
  'ua.fix.tabs': 'Set tab order to the structure',
  'ua.fix.marked': 'Mark the file as tagged',
  'ua.fix.artifact-paths': 'Mark drawn lines and backgrounds as artifacts',
  'ua.fix.artifact-paths.hint':
    'Wraps unmarked path drawing in artifact markers. Text and images are not touched.',
  'ua.fix.tag-annots': 'Put links, fields and annotations in the structure tree',
  'ua.fix.tag-annots.hint':
    'Adds a Link, Form or Annot element for each one at the end of the document. Move them in the Tags view.',
  'ua.fix.mark-pdfua': 'Declare PDF/UA-1',
  'ua.fix.mark-pdfua.ready':
    'Every automated rule passes. Declaring does not certify the rules that need a person.',
  'ua.fix.mark-pdfua.blocked': 'Not offered while an automated rule fails or could not be checked.',

  'ua.group.document': 'Document',
  'ua.group.structure': 'Structure',
  'ua.group.content': 'Content marking',
  'ua.group.graphics': 'Graphics',
  'ua.group.tables': 'Tables',
  'ua.group.lists': 'Lists',
  'ua.group.links': 'Links',
  'ua.group.forms': 'Forms and annotations',
  'ua.group.fonts': 'Fonts and text',
  'ua.group.navigation': 'Navigation',

  /* ---- rules ---- */
  'ua.rule.marked.name': 'File is marked as tagged',
  'ua.rule.marked.why':
    '/MarkInfo /Marked true tells a reader the file has a structure tree. Without it, assistive technology ignores the tags.',
  'ua.rule.marked.fix':
    'Set /Marked true with the quick fix. It only makes sense once the file has a structure tree, so tag the document first.',
  'ua.rule.marked.detail': '/MarkInfo << /Marked true >> is missing.',

  'ua.rule.title.name': 'Document title (dc:title in XMP)',
  'ua.rule.title.why':
    'PDF/UA requires the title in the XMP metadata. Readers announce it instead of the file name.',
  'ua.rule.title.fix': 'Enter a title below. It is written to the XMP packet and to the Info dictionary.',
  'ua.rule.title.detail.none': 'The document has no title.',
  'ua.rule.title.detail.info-only':
    'The title exists only in the Info dictionary ({title}); the XMP packet has no dc:title.',
  'ua.rule.title.detail.info-only-no-xmp':
    'The title exists only in the Info dictionary ({title}); the file has no XMP packet.',

  'ua.rule.display-title.name': 'Window shows the title (DisplayDocTitle)',
  'ua.rule.display-title.why':
    '/ViewerPreferences /DisplayDocTitle true makes the viewer show the title instead of the file name.',
  'ua.rule.display-title.fix': 'Use the quick fix below to set DisplayDocTitle.',
  'ua.rule.display-title.detail': '/DisplayDocTitle is not true.',

  'ua.rule.lang.name': 'Document language (/Lang)',
  'ua.rule.lang.why':
    'A screen reader picks its pronunciation from the language. With a missing or invalid tag it guesses.',
  'ua.rule.lang.fix': 'Enter a language tag such as en-US or tr-TR below.',
  'ua.rule.lang.detail.missing': 'The catalogue has no /Lang entry.',
  'ua.rule.lang.detail.invalid': '"{lang}" is not a valid language tag.',
  'ua.rule.lang.ok': 'Language: {lang}.',

  'ua.rule.pdfua-id.name': 'PDF/UA identifier in XMP',
  'ua.rule.pdfua-id.why': 'A file that conforms declares pdfuaid:part = 1 in its XMP metadata.',
  'ua.rule.pdfua-id.fix':
    'The quick fix declares it, but only when every automated rule passes. The rules that need a person stay your responsibility.',
  'ua.rule.pdfua-id.detail.none': 'No pdfuaid:part is declared.',
  'ua.rule.pdfua-id.detail.other': 'pdfuaid:part is {part}, not 1.',

  'ua.rule.encryption.name': 'Encryption lets screen readers in',
  'ua.rule.encryption.why':
    'A file whose permissions forbid text access for accessibility cannot be read by assistive technology.',
  'ua.rule.encryption.fix': 'Save again with the accessibility permission allowed, or without encryption.',
  'ua.rule.encryption.detail': 'The permissions forbid content access for accessibility (bit 10).',

  'ua.rule.xfa.name': 'No XFA form',
  'ua.rule.xfa.why': 'XFA forms are dynamic and cannot be made to conform to PDF/UA.',
  'ua.rule.xfa.fix': 'Convert the form to a standard AcroForm.',
  'ua.rule.xfa.detail': 'The AcroForm carries an XFA entry.',

  'ua.rule.struct-tree.name': 'Structure tree (/StructTreeRoot)',
  'ua.rule.struct-tree.why':
    'The tags give a reader the structure and the reading order. An untagged file has neither.',
  'ua.rule.struct-tree.fix': 'Tag the document with the tag button of the Report view, or in the Tags view.',
  'ua.rule.struct-tree.detail.none': 'The file has no structure tree.',
  'ua.rule.struct-tree.detail.unreadable': 'The structure tree could not be read.',
  'ua.rule.struct-tree.ok': '{elements} structure element(s).',

  'ua.rule.role-map.name': 'Custom types map to standard types',
  'ua.rule.role-map.why':
    'A type outside the standard set means nothing to a reader unless /RoleMap maps it to one.',
  'ua.rule.role-map.fix':
    'Give the element a standard type in the Tags view, or add the custom type to /RoleMap.',
  'ua.rule.role-map.detail.remapped': 'The standard type {role} is remapped to {to}.',
  'ua.rule.role-map.detail.unresolved': '{role} maps to {to}, which never resolves to a standard type.',
  'ua.rule.role-map.detail.unmapped': 'The type {role} is not a standard type and not in /RoleMap.',

  'ua.rule.artifact-nesting.name': 'Artifacts and tagged content do not mix',
  'ua.rule.artifact-nesting.why':
    'Content is either tagged or an artifact. A sequence that is both is read unpredictably.',
  'ua.rule.artifact-nesting.fix': 'Retag the content in the Tags view, or tag the document again.',
  'ua.rule.artifact-nesting.detail':
    'Page {page}: {count} marked-content sequence(s) nest an artifact and tagged content in each other.',

  'ua.rule.headings.name': 'Heading levels',
  'ua.rule.headings.why':
    'Headings let a screen reader user jump around and understand the outline. Levels must not be skipped.',
  'ua.rule.headings.fix':
    'Change the heading types in the Tags view: H1 first, no level skipped, and not H mixed with H1 to H6.',
  'ua.rule.headings.detail.mixed': 'The document mixes the unnumbered H with H1 to H6.',
  'ua.rule.headings.detail.first': 'The first heading is H{level}, not H1.',
  'ua.rule.headings.detail.skip': 'A heading jumps from H{from} to H{to}.',

  'ua.rule.reading-order.name': 'Reading order is logical',
  'ua.rule.reading-order.why':
    'Only a person can judge whether the order a reader follows matches the meaning of the page.',
  'ua.rule.reading-order.fix':
    'Open the Tags view: the numbers on the page are the order. Reorder with drag and drop or the arrow buttons.',
  'ua.rule.reading-order.detail.untagged':
    'The file has no tags, so the order is only the order the content is drawn in.',

  'ua.rule.tagged-content.name': 'All content is tagged or an artifact',
  'ua.rule.tagged-content.why':
    'Content that is neither is invisible to assistive technology or read in no particular order.',
  'ua.rule.tagged-content.fix':
    'Tag the document, then mark decoration such as lines and backgrounds as artifacts. The quick fix below handles drawn paths.',
  'ua.rule.tagged-content.detail':
    'Page {page}: {count} unmarked item(s) ({text} text, {paths} path, {images} image).',
  'ua.rule.tagged-content.detail.unreadable': 'Page {page}: the content stream could not be read.',

  'ua.rule.mcid-references.name': 'Tree and content refer to each other',
  'ua.rule.mcid-references.why':
    'Every marked-content id on a page must appear in the tree, and the tree must not refer to ids that are not there. Otherwise a reader loses the link.',
  'ua.rule.mcid-references.fix':
    'Tag the document again with the tag button of the Report view. Edits in the Tags view keep the references consistent.',
  'ua.rule.mcid-references.detail.no-parent-tree': 'The structure tree has no /ParentTree.',
  'ua.rule.mcid-references.detail.orphan':
    'Page {page}: {count} marked-content id(s) are not referenced by the tree.',
  'ua.rule.mcid-references.detail.dangling':
    'Page {page}: the tree refers to {count} marked-content id(s) the page does not contain.',
  'ua.rule.mcid-references.detail.duplicate':
    'Page {page}: {count} marked-content id(s) are referenced more than once.',
  'ua.rule.mcid-references.detail.no-struct-parents':
    'Page {page} has no /StructParents although the tree refers to its content.',

  'ua.rule.image-only.name': 'Pages are not only a picture',
  'ua.rule.image-only.why':
    'A page that is a single image has no text for a reader. It needs text recognition first.',
  'ua.rule.image-only.fix': 'Run OCR from the tools, then tag the document.',
  'ua.rule.image-only.detail': 'Page {page} is one large image without text.',

  'ua.rule.figure-alt.name': 'Figures have alternative text',
  'ua.rule.figure-alt.why':
    'A reader announces a figure\'s alternative text in place of the image. Without it the picture is skipped or read as "graphic".',
  'ua.rule.figure-alt.fix':
    'Select the figure in the Tags view and type a description, or mark it as an artifact if it is only decoration.',
  'ua.rule.figure-alt.detail': 'A {role} element has no alternative text.',
  'ua.rule.figure-alt.ok': '{figures} figure(s), all described.',

  'ua.rule.alt-quality.name': 'Alternative text is meaningful',
  'ua.rule.alt-quality.why':
    'A program can see that a description exists, not whether it says what the image shows.',
  'ua.rule.alt-quality.fix': 'Read each description and check that it conveys what the image shows.',

  'ua.rule.contrast.name': 'Colour contrast',
  'ua.rule.contrast.why':
    'Contrast belongs to how the page looks, not to its structure. This check does not measure it, and a pass here says nothing about it.',
  'ua.rule.contrast.fix':
    'Check contrast with a tool made for it, on the rendered page, against the WCAG ratios.',

  'ua.rule.table-structure.name': 'Table structure',
  'ua.rule.table-structure.why':
    'A table must be Table, TR, TH or TD (optionally THead, TBody, TFoot) so a reader can announce rows and columns.',
  'ua.rule.table-structure.fix':
    'Fix the nesting in the Tags view: drag cells into rows and rows into the table.',
  'ua.rule.table-structure.detail.cell-outside-row': 'A {role} cell is not inside a TR.',
  'ua.rule.table-structure.detail.row-outside-table': 'A TR is not inside a Table, THead, TBody or TFoot.',
  'ua.rule.table-structure.detail.row-child': 'A TR holds a {role}; only TH and TD are allowed.',
  'ua.rule.table-structure.detail.part-child': 'A table section holds a {role}; only TR is allowed.',
  'ua.rule.table-structure.detail.table-child':
    'A Table holds a {role}; only TR, THead, TBody, TFoot and Caption are allowed.',
  'ua.rule.table-structure.ok': '{tables} table(s) are well formed.',

  'ua.rule.table-headers.name': 'Tables have header cells',
  'ua.rule.table-headers.why':
    'Without header cells a reader cannot say which column or row a cell belongs to.',
  'ua.rule.table-headers.fix': 'Retag the cells of the first row or column as TH in the Tags view.',
  'ua.rule.table-headers.detail': 'This table has no TH cell.',

  'ua.rule.table-scope.name': 'Header cells say what they head',
  'ua.rule.table-scope.why':
    'A TH needs a scope (Row, Column, Both), or the data cells need /Headers, so a reader knows which header belongs to which cell.',
  'ua.rule.table-scope.fix': 'Select the TH cell in the Tags view and set its scope.',
  'ua.rule.table-scope.detail':
    '{count} header cell(s) of this table have neither a scope nor an id that data cells refer to.',

  'ua.rule.table-regular.name': 'Irregular tables name their headers',
  'ua.rule.table-regular.why':
    'In a table whose spans break the grid, a reader cannot work out the headers; each data cell needs explicit /Headers.',
  'ua.rule.table-regular.fix':
    'Make the grid regular by merging or splitting cells in the source document, or link every data cell to its headers.',
  'ua.rule.table-regular.detail': 'This table is irregular and {count} data cell(s) have no /Headers.',

  'ua.rule.list-structure.name': 'List structure',
  'ua.rule.list-structure.why':
    'L, LI, Lbl and LBody let a reader announce "list of 5 items" and step through it.',
  'ua.rule.list-structure.fix':
    'In the Tags view, select the items and use Make list, or fix the nesting by dragging.',
  'ua.rule.list-structure.detail.list-child': 'An L holds a {role}; only LI is allowed.',
  'ua.rule.list-structure.detail.item-outside-list': 'An LI is not inside an L.',
  'ua.rule.list-structure.detail.item-child': 'An LI holds a {role}; only Lbl and LBody are allowed.',
  'ua.rule.list-structure.detail.no-body': 'An LI has no LBody.',
  'ua.rule.list-structure.detail.part-outside-item': 'A {role} is not inside an LI.',
  'ua.rule.list-structure.ok': '{lists} list(s) are well formed.',

  'ua.rule.link-tagged.name': 'Links are tagged',
  'ua.rule.link-tagged.why':
    'A link annotation must sit in a Link element that points to it, so a reader can announce and activate it in reading order.',
  'ua.rule.link-tagged.fix':
    'Use the quick fix below to give each link a Link element, then move it to its place in the reading order in the Tags view.',
  'ua.rule.link-tagged.detail.untagged': 'The link annotation is not in the structure tree.',
  'ua.rule.link-tagged.detail.wrong-element': 'The link sits inside a {role} element, not a Link.',
  'ua.rule.link-tagged.detail.no-annotation': 'A Link element does not refer to any link annotation.',
  'ua.rule.link-tagged.ok': '{links} link(s) are tagged.',

  'ua.rule.link-alt.name': 'Links have a description',
  'ua.rule.link-alt.why':
    'The /Contents of a link (or the alternative text of its element) is what a reader announces when the visible text is missing or unclear.',
  'ua.rule.link-alt.fix': 'Write a description for the link below.',
  'ua.rule.link-alt.detail': 'This link has no description.',
  'ua.rule.link-alt.ok': '{links} link(s) have a description.',

  'ua.rule.annot-tagged.name': 'Annotations are tagged and described',
  'ua.rule.annot-tagged.why':
    'An annotation outside the structure tree is skipped by a reader, and one without text has nothing to announce.',
  'ua.rule.annot-tagged.fix':
    'Use the quick fix below to give each annotation an Annot element. Add a /Contents text to those that have none.',
  'ua.rule.annot-tagged.detail.untagged': 'A {subtype} annotation is not in the structure tree.',
  'ua.rule.annot-tagged.detail.wrong-element': 'The annotation sits inside a {role} element, not an Annot.',
  'ua.rule.annot-tagged.detail.no-contents': 'A {subtype} annotation has no /Contents.',
  'ua.rule.annot-tagged.ok': '{annotations} annotation(s) are tagged.',

  'ua.rule.form-tagged.name': 'Form fields are tagged',
  'ua.rule.form-tagged.why':
    'A field must sit in a Form element that points to it, so a reader finds it in reading order.',
  'ua.rule.form-tagged.fix':
    'Use the quick fix below to give each field a Form element, then move it to its place in the reading order in the Tags view.',
  'ua.rule.form-tagged.detail.untagged': 'The form field is not in the structure tree.',
  'ua.rule.form-tagged.detail.wrong-element': 'The field sits inside a {role} element, not a Form.',
  'ua.rule.form-tagged.ok': '{widgets} form field(s) are tagged.',

  'ua.rule.form-tooltip.name': 'Form fields have a tooltip',
  'ua.rule.form-tooltip.why':
    'A field\'s /TU entry is the label a reader announces. Without it the field is "edit, blank".',
  'ua.rule.form-tooltip.fix': 'Write a tooltip for the field below.',
  'ua.rule.form-tooltip.detail': 'This field has no tooltip.',
  'ua.rule.form-tooltip.ok': '{fields} field(s) have a tooltip.',

  'ua.rule.tab-order.name': 'Tab order follows the structure',
  'ua.rule.tab-order.why':
    '/Tabs /S makes the Tab key move through links and fields in structure order on pages that have them.',
  'ua.rule.tab-order.fix': 'Use the quick fix below to set /Tabs /S on these pages.',
  'ua.rule.tab-order.detail': 'Page {page} has annotations but no /Tabs /S.',

  'ua.rule.font-embedded.name': 'Fonts are embedded',
  'ua.rule.font-embedded.why':
    'A font that is not embedded can be replaced by the reader, which changes the characters and the layout.',
  'ua.rule.font-embedded.fix': 'Embed the fonts when exporting the source document.',
  'ua.rule.font-embedded.detail': 'Font {font} is not embedded (used on {pages} page(s)).',
  'ua.rule.font-embedded.ok': '{fonts} font(s), all embedded.',

  'ua.rule.font-unicode.name': 'Fonts map to Unicode',
  'ua.rule.font-unicode.why':
    "A reader extracts text through the font's ToUnicode map or a standard encoding. Without one, the text reads as garbage.",
  'ua.rule.font-unicode.fix':
    'Export again with a font that has a ToUnicode map (OpenType or TrueType with Unicode).',
  'ua.rule.font-unicode.detail.bad-map':
    'Font {font}: the ToUnicode map is invalid or maps to U+0000 or U+FFFE (used on {pages} page(s)).',
  'ua.rule.font-unicode.detail.no-map':
    'Font {font} has no ToUnicode map and no standard encoding (used on {pages} page(s)).',
  'ua.rule.font-unicode.ok': '{fonts} font(s) map to Unicode.',

  'ua.rule.char-mapping.name': 'Characters have a Unicode value',
  'ua.rule.char-mapping.why': 'Characters a reader cannot map come out as the replacement character U+FFFD.',
  'ua.rule.char-mapping.fix': 'Export again with fonts that carry a ToUnicode map; a scanned page needs OCR.',
  'ua.rule.char-mapping.detail': 'Page {page}: {count} character(s) cannot be mapped to Unicode.',

  'ua.rule.lang-parts.name': 'Changes of language are marked',
  'ua.rule.lang-parts.why':
    'A passage in another language needs /Lang on its element so it is pronounced correctly. A program cannot tell what language a passage is in.',
  'ua.rule.lang-parts.fix':
    'Look for passages in other languages. The Tags view does not edit the language of an element yet.',

  'ua.rule.bookmarks.name': 'Long documents have bookmarks',
  'ua.rule.bookmarks.why': 'In a document of more than 20 pages, bookmarks are how a reader navigates.',
  'ua.rule.bookmarks.fix': 'Add bookmarks with the outline tool.',
  'ua.rule.bookmarks.detail': 'The document has {pages} pages and no bookmarks.',
  'ua.rule.bookmarks.ok': 'The document has bookmarks.',

  /* ---- the tags view ---- */
  'tags.scope.label': 'Show',
  'tags.scope.page': 'Page {page}',
  'tags.scope.all': 'Whole document',
  'tags.toolbar': 'Reorder',
  'tags.up': 'Move up',
  'tags.down': 'Move down',
  'tags.outdent': 'Move out of the parent',
  'tags.indent': 'Move into the previous element',
  'tags.tree.label': 'Structure tree',
  'tags.empty': 'No elements to show on this page.',
  'tags.expand': 'Expand',
  'tags.collapse': 'Collapse',
  'tags.mappedTo': 'Standard type: {role}',
  'tags.noAlt': 'No alternative text',
  'tags.noAlt.short': 'no alt',
  'tags.moreRows': '{count} more rows are hidden. Narrow the view to one page.',
  'tags.select.hint':
    'Select an element to change its type, description or position. Ctrl or Shift selects several. Alt with the arrow keys moves it.',
  'tags.type': 'Type',
  'tags.artifact': 'Artifact',
  'tags.artifact.help': 'Mark as an artifact: it leaves the reading order',
  'tags.alt.label': 'Alternative text',
  'tags.alt.set': 'Set',
  'tags.scope.th': 'Scope',
  'tags.scope.none': 'Not set',
  'tags.scope.column': 'Column',
  'tags.scope.row': 'Row',
  'tags.scope.both': 'Both',
  'tags.group': 'Group in',
  'tags.group.role': 'Type of the new group',
  'tags.unwrap': 'Dissolve',
  'tags.makeList': 'Make list',
  'tags.multi': '{count} elements selected.',
  'tags.draft.none': 'No changes yet.',
  'tags.draft.count': '{count} change(s) not yet applied.',
  'tags.undo': 'Undo',
  'tags.discard': 'Discard',
  'tags.apply': 'Apply to document',

  'tags.untagged.title': 'This file has no tags.',
  'tags.untagged.explain':
    'A reader falls back on the order the content is drawn in. Below is that order, page by page. Change the types or the order, then tag the document.',
  'tags.untagged.page': 'Page {page} of {count}',
  'tags.untagged.noBlocks': 'Nothing to tag on this page.',
  'tags.untagged.list': 'Content blocks in reading order',
  'tags.untagged.figure': '[image]',
  'tags.untagged.skipped': '{count} block(s) on this page cannot be tagged.',
  'tags.untagged.artifactPaths': 'Mark drawn lines and backgrounds as artifacts',
  'tags.untagged.language': 'Language {lang} is written when the file has none.',
  'tags.untagged.apply': 'Tag document',

  'tags.overlay.item': '{number}: {role}',

  'tags.err.missing': 'That element no longer exists.',
  'tags.err.not-editable': 'That element cannot be changed here.',
  'tags.err.cycle': 'An element cannot be moved into itself.',
  'tags.err.not-siblings': 'Only elements with the same parent can be grouped.',
  'tags.err.role': 'That is not a standard structure type.',
  'tags.err.alt': 'An empty description is not written.',
  'tags.err.has-content': 'That element holds page content, so it cannot be dissolved.',
  'tags.err.interactive':
    'That element holds a link, a field or an annotation and cannot become an artifact.',
  'tags.err.in-stream': "That element's content is inside a form object this editor does not rewrite.",
  'tags.err.duplicate-key': 'That group already exists.',
  'tags.err.root': 'The document element cannot be moved, grouped or removed.',
  'tags.err.generic': 'That change is not possible.',
} as const;
