# Review guide

This is the review guide of pull request #28, which merged `test/coverage` into `main` as `8a7d6db`. Every commit of `git log --reverse pre-coverage..8a7d6db^2` is listed below exactly once, grouped by risk, highest first: what was wrong, and the test that proves it. A commit that fits two groups is in the higher one. Test names are quoted as they appear in the test files.

| Group | What | Commits |
| --- | --- | --- |
| 1 | Data integrity, security, signatures: wrong file or document content, lost data, verification | 22 |
| 2 | Other behaviour fixes a user sees | 22 |
| 3 | Code removed as unreachable, and refactors, without behaviour change | 23 |
| 4 | Tooling, CI, coverage, docs | 21 |
| 5 | Test-only | 25 |

## How to review

1. Read groups 1 and 2 in full: 44 commits, each with the defect, the changed code and the test. The claim to check is that the named test fails without the fix. `revert-proof` below does that mechanically; your job is to judge that the test asserts the right thing.
2. Read the diff of group 3 for the "no behaviour change" claim only. The production line counts show where to spend time: `d486147` and `a73ecd1` are the large ones.
3. Skim group 4. Sample group 5 for tests that cannot fail. A test is real when it asserts behaviour (a produced file read back, an exact message, an exact count) and fails when that behaviour breaks. Reject: `skip`, `only`, `todo`, `fixme`; coverage-ignore comments (`c8 ignore`, `v8 ignore`, `istanbul ignore`); assertions on text that is always there; a test that only runs code. A starting search over everything the branch adds:

```
git diff pre-coverage..8a7d6db^2 -- '*.test.ts' '*.test.tsx' 'e2e/*.ts' | grep -nE '^\+.*(\.only\(|\.skip\(|\.todo\(|\.fixme\(|c8 ignore|v8 ignore|istanbul ignore)'
```

`playwright.config.ts` sets `forbidOnly` when `CI` is set.

## revert-proof

`tools/review/revert-proof.json` lists every fix commit of groups 1 and 2 with the test files it touched (`tests`), the files that hold the proving tests (`run`, optional) and a name filter (`filter`) that selects only the proving tests. `kind` is `unit` (Vitest, 31 entries) or `e2e` (Playwright, 13 entries); `kind: "none"` would mark a fix with no automated proof (there is none). `testCommit` (optional) names a later commit that carries the test, and `note` says where an entry covers only part of its commit.

```
node tools/review/revert-proof.mjs [--shard i/n] [--only <sha-prefix>]
```

For each entry it checks out the fix's parent with the fix's test files, runs the proving tests and requires a failure, classified as an assertion failure or a load failure (module not found, missing export, syntax error, no tests found); then checks out the fix and requires a pass. A fix whose defect was a throw or a hang rather than a wrong value names that failure in the entry's `failure`, a regular expression over the test output, so the reviewer can check it is the defect and not a test that cannot load: `dadbb01` (the import's own read-back refusing too few imported values), `6f7c94e` (`readSignatureEvidence` crashing on a hostile attribute set) and `c83ff55` (the probe waiting out its full 10 s). Only an assertion failure, or the declared failure, then a pass counts as `proved`; `load-only` and `not-proved` are reported and make it exit 1. It needs a clean work tree, restores your HEAD afterwards and writes `revert-proof-report.json`. The workflow `.github/workflows/revert-proof.yml` runs it in 6 shards, on demand or on a pull request labelled `revert-proof`.

Known gaps in the proof, so nobody reads more into it than is there:

- Snapshot and attachment sizes (commit 0686d9e): the manifest runs the `view.snapshot` unit test; the attachment-size half is covered only by a browser spec the manifest does not run.
- Office export (commit fbf6f4b): the U+FFFE/U+FFFF word count and the removal of `verifyXlsx` have no test named for them.
- Vault sweep (a14e1fa) and menu-bar keys (5c1b56f): the manifest runs one of the two proofs, a unit test for the first and a browser spec for the second; the other is named in the entry's `note` or in its list below.

## 1. Data integrity, security, signatures (22)

- `2c7b761` Read only a trailer's own /Prev key, past comments and name values
  The revision-chain reader of the signature check took the first `/Prev` text in a trailer: one inside a comment, or a name value spelled `/Prev`, was followed instead of the key, so the revisions written after a signature were miscounted or the chain fell back to counting `%%EOF` markers. Found by the independent review. **Test:** `packages/pdf-core/src/ops/signature-status.test.ts` “does not follow a /Prev that is commented out up to a line feed before the real one” and the five tests beside it.

- `c8abeea` test(pdf-ui): the dialog operations run against real bytes, and a comma stays in a text field
  The form-fill parser split any value containing a comma into a multiple selection, so `Smith, John` left a text field unchanged. **Test:** `packages/pdf-ui/src/ops/forms.test.ts` “writes a comma-separated value to a text field as one string”.
- `154ac35` test(pdf-core): redaction, protection and CMS signing are tested end to end, and three defects go
  Three defects: the redaction audit read past an object's own `endobj`, so a short orphan right before an xref stream was taken for that stream and not reported; `protectDocument` checked the old password and the page tree outside its try/finally, so a wrong password or damaged page tree leaked the engine document and surfaced as a raw engine error; an RSA key bound to SHA-256 asked to sign with SHA-512 produced a CMS claiming SHA-512 over a SHA-256 signature. **Test:** `packages/pdf-core/src/ops/redact-audit.test.ts` “reports an orphan that sits right in front of an xref stream, and not the stream itself”; `packages/pdf-core/src/ops/security.test.ts` “re-protects a locked file only with its old password, and moves it to the new passwords”; `packages/pdf-core/src/ops/security.test.ts` “reports a page tree the engine cannot read as a tool error, not a raw engine failure”; `packages/pdf-core/src/signature-cms.test.ts` “refuses an RSA key whose hash is not the digest the CMS would state”.
- `a14e1fa` fix(vault): a sweep waits for every open window to answer, not for 250 ms
  A window learned another window's keys by a probe that ended after a fixed 250 ms, so a busy background tab answering later had its open document's blob counted as orphaned and deleted by a vault sweep. **Test:** `apps/web/src/vault-channel.test.ts` “a probe waits for every window the lock manager lists, not for a timer (the whole describe)”; end to end `e2e/two-window.spec.ts` “a sweep in one tab keeps the blob only the other tab announces, and sweeps it once that tab is gone”.
- `6f7c94e` test(sign): signing, PKCS#12 import and signature evidence read hostile structures safely
  `readSignatureEvidence` threw a TypeError on a CMS attribute whose SET is empty (pkijs leaves its values unset); input from a PDF can be any shape. **Test:** `packages/pdf-core/src/signature-evidence.test.ts` “skips attributes without values and a signing time that is not a time”.
- `114efee` fix(pdfa): parts 2 and 3 report unmanaged transparency, and every use of an image is read
  The PDF/A checker computed the “transparency without an output intent or /Group /CS” finding and discarded it for parts 2 and 3, where the rule applies; and a second use of the same image on another page was skipped, so an image mask painted in another colour went unchecked. **Test:** `packages/pdf-core/src/ops/pdfa-check.test.ts` “wants parts 2 and 3 to name the blending space when a page uses transparency and has no output intent”; `packages/pdf-core/src/ops/pdfa-check.test.ts` “reads every use of an image: a mask painted in another colour on another page is still judged”; `packages/pdf-core/src/ops/pdfa-check.test.ts` “treats an image soft mask or SMaskInData as transparency on the page in parts 2 and 3”.
- `eb37512` Fail closed on hostile certificate DER and cover trust, standards, sanitize
  Hostile certificate DER was not failed closed: an empty DNS or directory name constraint matched every name, IP constraints were not enforced, unreadable nameConstraints/subjectAltName passed instead of giving indeterminate/malformed, a pathLenConstraint wider than 32 bits was misread, and a hostile extension threw out of `checkTrust` and the revocation walk; separately, text whose body size rounds to 0 turned every block into a heading. **Test:** `packages/pdf-core/src/signature-trust.test.ts` “the describes “DNS name constraints”, “IP address name constraints”, “directory name constraints”, “hostile DER inside certificate extensions””; `packages/pdf-core/src/signature-trust.test.ts` “accepts a pathLenConstraint wider than 32 bits as no limit”; `packages/pdf-core/src/signature-revocation.test.ts` “DER that asn1js throws on, inside certificates and lists (the describe)”; `packages/pdf-core/src/ops/accessibility.test.ts` “has no heading when all the text is too small to count as a size”.
- `17b2b8f` Count a looping action chain once when sanitising, and cover sanitize
  An action chain whose /Next loops back was counted up to 24 times in the sanitise report; annotations written in place in /Kids were attributed to the wrong holder; an unreadable object met by two passes was reported twice; flatten mode with nothing to remove rewrote the file instead of reporting “nothing found”. **Test:** `packages/pdf-core/src/ops/sanitize.test.ts` “counts a script once when its /Next chain loops back on itself”; `packages/pdf-core/src/ops/sanitize.test.ts` “counts each member of a two-action loop once, and each kind under its own category”; `packages/pdf-core/src/ops/sanitize.test.ts` “returns a document with no form untouched when forms are to be removed or flattened”.
- `ad0d195` Keep neighbouring lines and paragraph alignment through find and replace
  A match's erase box was the full ascent-to-descent glyph box, so at tight leading it reached into the next line and MuPDF removed that line's glyphs too; a right-aligned paragraph was promoted to justified; a centred or right-aligned line after a hard break got its edge offset applied as a first-line indent too. **Test:** `packages/pdf-core/src/ops/find-replace.test.ts` “leaves the lines around a changed line whole when the leading is tighter than the glyph boxes”; `packages/pdf-core/src/ops/find-replace.test.ts` “keeps a right-aligned paragraph ending at the same edge when it lays the block out again”; `packages/pdf-core/src/ops/find-replace.test.ts` “keeps the lines of a right-aligned block ending at the right edge”.
- `4149d58` Follow only a real /Prev and count each signature once in signature status
  `previousOffset` found /Prev by plain text search, so a /Prev inside a string or nested dictionary, or a name like /Previous, could steer the revision chain and miscount changes after signing; a chain that stopped short undercounted; an inline signature dictionary reached through /Fields and a page's /Annots counted twice. **Test:** `packages/pdf-core/src/ops/signature-status.test.ts` “does not follow a /Prev that sits inside a string or a nested dictionary of the trailer”; `packages/pdf-core/src/ops/signature-status.test.ts` “reports a signature dictionary shared by several widgets once”; `packages/pdf-core/src/ops/signature-status.test.ts` “reports a merged field and widget with an inline signature dictionary once”.
- `59002eb` Verify signatures of files larger than 16 MiB against their exact bytes
  MuPDF hands /ByteRange numbers over as 32-bit floats, so above 2^24 an offset was rounded and no longer equalled the scanned range: every signature of a file over 16 MiB read as unchecked (layout). **Test:** `packages/pdf-core/src/ops/signature-status.test.ts` “a signed file larger than 16 MiB: is verified against the exact signed bytes although the engine reads its /ByteRange as 32-bit floats”; `packages/pdf-core/src/ops/signature-status.test.ts` “…reads a byte flipped in the far part of such a file as invalid”.
- `fbf6f4b` Join cross-style hyphens and start numbered paragraphs in Office export
  The Office export never joined a line-end hyphen set in a different style from the letters before it, never started a paragraph at `2. numbered`, counted a lone U+FFFE/U+FFFF as a written word (failing verification of a harmless PDF), and `verifyXlsx` re-read the module's own output and could not fail. The last two have no test named for them. **Test:** `packages/pdf-core/src/ops/export-office.test.ts` “joins a word broken by a hyphen, whatever style the hyphen is set in”; `packages/pdf-core/src/ops/export-office.test.ts` “starts a paragraph at a bullet and at a numbered line, not at a decimal or a year”.
- `c88cb88` Report pictures a Word export leaves out
  A picture MuPDF could not draw, and a picture inside a ruled table, were dropped from the DOCX without a word; the report only counted pictures that made it. **Test:** `packages/pdf-core/src/ops/export-office.test.ts` “says so when a picture inside a ruled table is left out, since cells hold text only”; `packages/pdf-core/src/ops/export-office.faults.test.ts` “leaves out a picture that MuPDF could not draw, drawing or not, and says so”.
- `b91ab0f` Tag documents in the interface's language, not always Turkish
  The shell passed `language="tr-TR"` to the accessibility panel whatever the interface language, so tagging a file without /Lang in the English interface wrote /Lang (tr-TR). **Test:** `e2e/ui-tags.spec.ts` “a file with no tags: lists the blocks in drawing order, takes a type, an order and a description, and tags the document (now expects /Lang `en`)”.
- `1127228` Fix Office conversion attributes, form calculations and XFA data import
  Office conversion: xmldom's `getAttribute` returns `''` for a missing attribute, so every `?? default` never applied (every PPTX run with `<a:rPr>` but no `u` was underlined, date-styled XLSX cells without `t` showed serial numbers, an empty XML part crashed with a TypeError); the form calculator accepted malformed numbers (`1.2.3 + 1` was 2.2); a template-only XDP was taken as the data itself on XFA import. **Test:** `packages/pdf-core/src/ops/convert-ooxml.test.ts` “shows a date for the built-in and custom date formats, in either date system”; `packages/pdf-core/src/ops/convert-ooxml.test.ts` “formats runs: bold, italic, underline, size within 4–200 pt, line breaks, and drops empty ones”; `packages/pdf-core/src/ops/convert-ooxml.test.ts` “refuses a duplicate attribute as corrupt and an empty part as empty”; `packages/pdf-core/src/ops/forms.edge.test.ts` “the calculator refuses … with a message naming the token”; `packages/pdf-core/src/ops/xfa-data.test.ts` “finds no data in an XDP or a datasets packet that has no xfa:data”.
- `f39beef` Draw or really remove an inline annotation when preparing PDF/A
  An annotation written inline in /Annots without an appearance was counted as removed during PDF/A preparation but stayed in the file, still without an appearance. **Test:** `packages/pdf-core/src/ops/pdfa-prepare.test.ts` “draws an annotation written inline in /Annots, and removes one it cannot draw from the file too”.
- `b56dcd2` Write a shape's stroke width as its border width
  Rectangles, circles and lines were written with `/Border [0 0 0]` and the stroke only inside the appearance stream, so a reader that rebuilds the appearance drew no border and reopening the file here read no thickness. **Test:** `packages/pdf-core/src/ops/annotation-shapes.test.ts` “writeShapeAnnotations: writes each shape where it was drawn, with its colour, opacity, comment and an appearance (thickness read back)”.
- `0e6ee66` Fix EXIF orientation after fill bytes and XMP attribute reading
  A JPEG whose APP1 marker follows a fill byte (FF FF E1) was read two bytes off, so its EXIF orientation was ignored and the photo came out sideways; an XMP attribute written without a value counted as a present empty value, hiding the element form of the same property. **Test:** `packages/pdf-core/src/ops/images.edge.test.ts` “finds the block after fill bytes: any marker may be preceded by 0xFF padding”; `packages/pdf-core/src/ops/metadata.xmp.test.ts` “ignores a malformed attribute without a value when it looks for one to edit”.
- `4d3ccc3` Fix FDF strings, layer renames and duplicate annotation listings
  FDF octal escapes of one or two digits were not read and a character above U+00FF written unescaped was split into two bytes; a layer rename combined with a state or order change failed verification under the old name; an annotation listed twice in /Annots kept its second entry; a /Differences glyph name like `constructor` was looked up on the object prototype. **Test:** `packages/pdf-core/src/ops/form-data.edge.test.ts` “reads octal escapes of one, two and three digits”; `packages/pdf-core/src/ops/form-data.edge.test.ts` “keeps a character outside Latin-1 that is written unescaped, instead of splitting it into two bytes”; `packages/pdf-core/src/ops/layer-write.edge.test.ts` “runs state, order and rename in that order and reports each step”; `packages/pdf-core/src/ops/layer-write.edge.test.ts` “removes /AS once its last entry is empty, and does not claim usage was kept”; `packages/pdf-core/src/ops/layer-write.edge.test.ts` “names a layer once when the request names it twice, and still verifies what it wrote”; `packages/pdf-core/src/ops/annotation-remove.edge.test.ts` “removes an annotation the page lists twice, both entries, and says it once”; `packages/pdf-core/src/engines/doc-fonts.edge.test.ts` “does not take a glyph named like a property of every object for a character”.
- `6f4b043` Open external links in a new tab instead of leaving the editor
  A click on an external /URI link with the hand tool navigated the editor's own tab to the address, losing the open document and every unsaved mark. **Test:** `e2e/ui-marks-pane.spec.ts` “an external link opens in a new tab and leaves the editor on its document; the selection tool does not follow it”.
- `dadbb01` Import XFA data into forms without a template and into the read datasets
  Importing XFA data into a static form with no template packet failed (“the datasets hold 3 values, 3 were imported”) because the widget fill rewrote the datasets in its own spelling; with two datasets elements in an XDP stream the writer replaced the last while every reader takes the first, so the import was refused. **Test:** `packages/pdf-core/src/ops/xfa-form.test.ts` “binds fields by the shape of their names when the form has no template packet”; `packages/pdf-core/src/ops/xfa-form.test.ts` “keeps the imported data when the fill spells a check box value its own way”; `packages/pdf-core/src/ops/xfa-form.test.ts` “writes the first datasets element of an XDP stream, the one that is read, static or dynamic”.
- `5b382d5` Keep the user's document in front when a draft restores while it opens
  Startup recovery read which document was in front before awaiting each draft's stored file handle, so a document opened during that wait lost the front to the restored draft and the next edit (a placed picture) landed in, and the export carried the marks of, the wrong document. **Test:** `e2e/ui-recovery-race.spec.ts` “a draft restored while the user opens a document does not take the front from it”.

## 2. Other behaviour fixes a user sees (22)

- `f2ec381` Read aloud in the document's language, or the interface's when it declares none
  Read-aloud only ever looked for a local Turkish voice, so on a device without one no document could be read aloud, in either interface language. **Test:** `e2e/ui-read-aloud-lang.spec.ts` “an English interface and a document without /Lang are read with the local English voice”; “a document whose catalog says /Lang de-DE is read with the German voice, not the interface-language one”.
- `c83ff55` Stop a vault sweep probe waiting for a window that closed
  A tab closed just before a sweep could still hold its window lock when the probe listed live windows; it never answered, so the probe waited the full 10 s and refused the sweep. **Test:** `apps/web/src/vault-channel.test.ts` “stops waiting for a listed window once its lock is gone, and a failed re-query changes nothing”; `apps/web/src/vault-channel.test.ts` “keeps waiting for a listed window whose lock is still held, and stops asking once it answers”.
- `80e2ddd` Cancel text edits cleanly during verification and test the text read path
  Aborting a text edit while its result was being verified surfaced as an internal “operation aborted” error, because only DOMException aborts were mapped. **Test:** `packages/pdf-core/src/ops/text-edit.test.ts` “is cancelled as an AbortError when the signal is aborted during the textEdit.verify phase”.
- `5c1b56f` fix(shortcuts): Home and End move inside the menu bar instead of turning the page
  The shell's capture-phase key handler answered PageUp/PageDown/Home/End as page navigation wherever focus was, so End on a focused menu trigger jumped to the last page instead of moving along the menu bar. **Test:** `e2e/app-shortcuts.spec.ts` “End on a focused menu trigger moves along the menu bar and does not turn the page”; unit `apps/web/src/useShortcuts.test.ts` “treats the focus inside a menu bar, menu, list, tree or grid as the widget's own”.
- `dbb0d4f` Keep the scan notice for an unreadable photo and label corner edits Apply
  When a photo in a batch could not be opened its notice was cleared at once as the next photo opened, and editing the corners of an existing page confirmed with the operations' Preview label instead of Apply. **Test:** `e2e/ui-scan.spec.ts` “the refusal is named, photos are chosen from files, the corners are corrected and the pages become a PDF”.
- `4c0b521` List text-compare changes in document order and cover compare and batch
  Text compare sorted added lines after every later change instead of keeping document order, and the batch text-export step reported the exported page count as the document's. **Test:** `packages/pdf-core/src/ops/compare.test.ts` “lists the changes in document order, an added line before the change that follows it”; `packages/pdf-core/src/ops/batch.test.ts` “keeps the page count of the document when a text export covers only some pages”.
- `5683185` Report the scale a newly opened document is drawn at
  Opening a file reset the status bar's zoom to 100% after awaiting the vault write, overwriting the fit-width scale the viewer had reported: the page was drawn at 94% while the bar said 100%. **Test:** `e2e/app-shortcuts.spec.ts` “Ctrl+= , Ctrl+-, Ctrl+1 and Ctrl+0 change the zoom the status bar reports (compares with pdf.js’s --scale-factor)”.
- `cfc159f` Refuse tag moves and groups into an element whose children cannot be rewritten
  A tag drop into, move out of, or group inside a direct (non-editable) structure element was accepted into the draft, and Apply then failed with the unrelated “Select pages first.”. **Test:** `packages/pdf-core/src/ops/structure-model.test.ts` “refuses to change the children of an element it cannot rewrite, as the target, the source or the group parent”; `packages/pdf-core/src/ops/structure.test.ts` “refuses a move into a direct element, which no child could point back at”; `e2e/ui-tags.spec.ts` “an element that is a direct object is listed but cannot be changed or dragged”.
- `f50f5ed` Release the reader when a text export's page selection is refused
  `exportText` validated the page selection before the try/finally that destroys the pdf.js handle, so a refused selection leaked the worker and its copy of the document. **Test:** `packages/pdf-core/src/ops/text-export.faults.test.ts` “releases the worker when the page selection is refused”.
- `9c22a1f` Show the start date of a certificate that is not yet valid
  A signer certificate that is not yet valid read “not valid until {date}” with its expiry date, because only notAfter was carried to the panel. **Test:** `packages/pdf-core/src/signature-trust.test.ts` “enforces validity periods (now also expects notBefore)”.
- `e3cce13` Count unchanged pages once and refuse fractional poster tiles
  An auto-cropped page that needed no change was counted twice, so the note reported double the pages; a poster accepted 1.5 or 2.5 columns or rows. **Test:** `packages/pdf-core/src/ops/page-boxes.test.ts` “counts a page whose crop already is the ink box once, and rewrites a trim box that is not”; `packages/pdf-core/src/ops/impose.test.ts` “a poster grid is whole tiles: refuses a fractional number of columns / rows”.
- `ff1ba7a` Show the current document's size in the export dialog
  The export dialog's “This PDF (size)” always showed the size of the file as first opened, in KB whatever its size, so after compressing or deleting pages it showed the old figure. **Test:** `e2e/web-shell.spec.ts` “the export dialog gives the size of the document as it stands, not of the file first opened”.
- `c892667` End the measure tool on Escape and keep the lens off the pointer's path
  The shell never passed `onStop` to the measure layer, so the documented second Escape on an empty chain did nothing; the magnifier lens sat under the pointer and took pointer events itself, so the page saw the pointer leave. The same commit passes `onProduced` to the print dialog, which makes its existing “Generate Printable PDF” button appear: it opens the imposed file as a new `print.pdf` tab, leaving the source as it was. **Test:** `e2e/ui-layers-measure.spec.ts` “Escape on an empty chain ends the tool”; `e2e/ui-layers-viewer.spec.ts` “the lens follows the pointer over the page, shows the text under it magnified, and the wheel sets the magnification”; the print button: `e2e/ui-print.spec.ts` “Generate Printable PDF: the file is a new A4 tab beside the source, which is left as it was, and the shell is free again” (added in `de51893`).
- `eadf2b3` Keep a loaded batch ruleset when files are chosen afterwards
  Choosing files, or the first scan of a watched folder, after loading a batch ruleset silently discarded the ruleset, so the run used the dialog's own steps instead. **Test:** `e2e/ui-batch.spec.ts` “choosing files after loading a ruleset keeps the loaded ruleset”.
- `0202311` Turn presentation pages with Space and start on the page being read
  Presentation keys were looked up by `KeyboardEvent.key` (Space is `' '`) but the table said `'Space'`, so Space never turned a page; entering full screen refit the page width at the old scroll fraction, so the page being read started cut off at the top. **Test:** `e2e/ui-presentation.spec.ts` “the page keys turn one page each and stop at the ends; Escape ends the presentation”; `e2e/ui-presentation.spec.ts` “it starts on the page being looked at and gives the reader’s zoom back on exit”.
- `eedf6dd` Let dock tabs and the form list keep Home and End; drop unused selector layouts
  The shell's first/last-page shortcuts took Home and End while focus was on the left dock's tab strip or in the form panel's field list, turning the document's page instead of moving inside the widget. **Test:** `e2e/ui-panels15-forms.spec.ts` “Home and End walk to the first and last row instead of turning the page”; `e2e/ui-panels15-tools.spec.ts` “Home and End on a dock tab move between tabs and leave the viewer on its page”.
- `9001bda` Map OCR worker start failures to their reasons
  A tesseract worker that failed to start (missing core, language pack or worker script) surfaced as a raw Error because the worker was acquired outside the block that maps engine messages, so the `ocr-language-missing` and `asset-missing` reasons could never be shown. **Test:** `packages/pdf-core/src/ops/ocr.faults.test.ts` “names a missing language pack, probing the quality the run would really use”; `packages/pdf-core/src/engines/tesseract.worker.test.ts` “does not keep a worker whose start failed, and gives a second caller waiting on it the failure”.
- `8d58a3b` Settle an aborted pdf.js open; keep XMP parsing total; pdf-core at 99.9%
  `openWithPdfjs` never settled when its signal aborted during the load, leaving the caller waiting forever; `parseXmp`, documented never to throw, hit the call-stack limit on a deeply nested packet; an XMP attribute without a namespace was stored as `undefinedplainAttribute`. **Test:** `packages/pdf-core/src/engines/pdfjs-handle.real.test.ts` “settles with the aborted code, within a short time, when the signal fires while the document loads”; `packages/pdf-core/src/engines/pdfjs-handle.abort.test.ts` “settles an abort that fires while the parse is still pending, even if the task cannot be destroyed”; `packages/pdf-core/src/ops/pdfa-xmp.edge.test.ts` “does not throw on a packet nested far deeper than the stack allows”; `packages/pdf-core/src/ops/pdfa-xmp.edge.test.ts` “ignores attributes without a namespace and machinery, and elements without a namespace or in a machinery namespace”.
- `8b4d213` Test sheet detection on crafted pictures; refuse a degenerate working raster
  `detectPage` refused a source under 16 px but then worked on the raster scaled to 400 px on its long side, so a long thin strip (16×2000) ran the whole pipeline on a 2–3 px raster. **Test:** `packages/pdf-core/src/ops/scan-detect.edge.test.ts` “finds nothing in a picture so long and thin that its working raster is under 16 px across”.
- `8b758eb` Announce font list changes in the properties panel; drop unreachable mark paths
  “Font list updated” could never be spoken: the shell clears the font list while re-reading it, so two counts were never compared; one sentence per change is now spoken, signatures first, so opening a signed document still announces its signatures. **Test:** `e2e/ui-rest16c-properties.spec.ts` “undoing a watermark takes its font off the list and the panel announces the new font count”.
- `0686d9e` Make the snapshot tool reachable and measure attachment sizes
  The snapshot panel was mounted but nothing opened it (no `view.snapshot` command); the Properties panel showed “Size unreadable” for every embedded file because pdf.js v6 never fills `attachment.content`. **Test:** `apps/web/src/commands.test.ts` “lists each id once, and exactly the ids this table knows”; `apps/web/src/commands.test.ts` “runs, for every command, exactly the host call its id names” (snapshot); the attachment-size half: `e2e/ui-properties.spec.ts` “the size of an embedded file is measured from its payload” (not run by `revert-proof`).
- `43bcacd` Give a progress bar without a step count no value to read out
  A progress bar for a job that reported no total (or a total of zero) still rendered `aria-valuemax="0" aria-valuenow="0"` and “0/0”, so a screen reader announced a count that does not exist. **Test:** `apps/web/src/components/ActivityOverlay.test.tsx` “shows an indeterminate full bar and only the label for a job that reports no total, or a total of zero”.

## 3. Code removed as unreachable, refactors without behaviour change (23)

- `a73ecd1` test(pdf-core): PDF/UA, its XMP, the content scanner and stamps are covered rule by rule
  Unit tests for PDF/UA, its XMP, the content scanner and stamps; removes branches the commit says are unreachable (the stamp's internal and missing-page errors, PDF/UA's redundant font-file clause, a path-paint check, an inner catch) and routes engine errors through one `engineFailure` helper. No behaviour change claimed; production code +119 −126 lines (the rest is tests).
- `88462ad` test(web): the shell's pure modules are tested on their own
  Unit tests for the shell's pure modules; removes unreachable fallbacks in `annotation-interaction` and `drafts`. No behaviour change claimed; production code +49 −49 lines (the rest is tests).
- `5eeffda` Cover structure editing and form detection
  Coverage of structure editing and form detection; removes guards the callers or MuPDF's invariants already exclude. No behaviour change claimed; production code +94 −75 lines (the rest is tests).
- `a6c4f1d` Use the model's workingPageCount instead of a copy in operations
  `operations.ts` re-implemented pdf-model's `workingPageCount` as `tabPageCount`; the copy is gone and every caller uses the model's helper. No behaviour change claimed; production code +15 −20 lines (the rest is tests).
- `3043f38` Test the trust-root store and drop its impossible null paths
  `fromBase64` strips every non-alphabet character, so its “not base64” null return could never happen; the decoders now return bytes and the null filters in the shell and import panels are gone; unused `serialiseTrustRoots` removed. No behaviour change claimed; production code +18 −25 lines (the rest is tests).
- `dc73192` Cover restored session histories and the remaining draft shapes
  Tests for restored session histories and draft shapes; `#releaseDiscarded` takes the tab it was called for instead of looking it up again, and bounded guards became casts with reasons. No behaviour change claimed; production code +16 −20 lines (the rest is tests).
- `89d1055` Test block reflow directly and drop its index guards
  Direct tests of block reflow; loops iterate values instead of guarding indexes their bounds already keep in range. No behaviour change claimed; production code +9 −17 lines (the rest is tests).
- `d486147` Cover find and replace on hand-built pages and drop impossible guards
  Tests of find-and-replace on hand-built pages; a glyph now carries its TextLine so helpers stop re-looking lines up by index, and index guards are replaced by one bounded accessor (the largest production rewrite in this group). No behaviour change claimed; production code +170 −152 lines (the rest is tests).
- `f68d9b4` Cover the text model's refusals, style facts and paragraph merging
  Tests of the text model's refusals, style facts and paragraph merging; index guards the loops already bound are gone, and the colour is no longer lower-cased after a pattern that admits lower case only. No behaviour change claimed; production code +23 −36 lines (the rest is tests).
- `27e5637` Test font matching and bring pdf-text-engine to full unit coverage
  Tests of font matching; `metricsFor` reuses `missingGlyphsOf` instead of a copy. No behaviour change claimed; production code +6 −16 lines (the rest is tests).
- `78fd92b` Test annotation reading, transforms and data import to full coverage
  Tests of annotation reading, transforms and data import; the two coverage-ignore comments are gone (quarter turns from a lookup table, moved box as min/max of its corners), every indirect id is read through one helper, and checks earlier validation rules out are removed. No behaviour change claimed; production code +137 −127 lines (the rest is tests).
- `034ca26` Test the shell's page actions, history and write verification
  Tests of the shell's page actions, history and write verification; `verifyForWrite` loses its unreachable `unsupported` run state and the rotation/empty-box legality checks pdf.js already makes moot (tests pin both). No behaviour change claimed; production code +7 −21 lines (the rest is tests).
- `ac1d98e` Test the shape, note and marker writers to full coverage
  Tests of the shape, note and marker writers; removes the caller-less `ownedSubtypeFor` and checks unreachable after the validation before them. No behaviour change claimed; production code +47 −49 lines (the rest is tests).
- `9067dd0` Test print page ranges and marquees that graze a corner
  Tests of print page ranges and marquees grazing a corner; `segmentsIntersect` loses its end-on-edge checks since it is only asked about strokes whose ends are outside the rectangle. No behaviour change claimed; production code +6 −3 lines (the rest is tests).
- `481de65` Test the pages, comments, compare, accessibility and outline panels
  Browser tests of the pages, comments, compare, accessibility and outline panels; Move to's clamp and guard are removed because the field's min/max and the browser already refuse other values. No behaviour change claimed; production code +3 −3 lines (the rest is tests).
- `386d928` Test image edits, page inserts and replacements, images to PDF and refusals
  Browser tests of image edits, page inserts and images to PDF; removes `inspectContainer` from `sign.ts`, which had no caller. No behaviour change claimed; production code +0 −14 lines (the rest is tests).
- `c2ce1dc` Test compression, Ghostscript and the pdf.js adapter against their engines
  Tests of compression, Ghostscript and the pdf.js adapter; removes a loader slot check that could never be false and reads text-matrix offsets as the six numbers pdf.js always gives. No behaviour change claimed; production code +6 −3 lines (the rest is tests).
- `1fd7fa9` Test settings, palette, menus, operation forms and busy refusals; drop unused props
  Browser tests of settings, palette, menus, operation forms; drops props and members no caller uses (Tooltip's controlled open, `useOperationRun`'s reset, the header's optional menu props) and simplifies `operations.ts` fact reads. No behaviour change claimed; production code +23 −40 lines (the rest is tests).
- `1777b40` Test the camera scan, viewer search, print and batch edges; drop unread members
  Browser tests of camera scan, search, print and batch edges; drops members nothing reads (`useCamera`'s stop, `SnapshotMenu`'s optional onNotice and failure state, `BatchDialog`'s image branch). No behaviour change claimed; production code +15 −31 lines (the rest is tests).
- `0d779fb` Test PDF/A and PDF/UA panels, panel file choosers and outline fields
  Browser tests of the PDF/A and PDF/UA panels and file choosers; the comment editor was a `<form>` around a lone textarea with no submit control, so its submit handler could never run, and is now a plain container. No behaviour change claimed; production code +4 −8 lines (the rest is tests).
- `bb386e2` Test compare caps, tag plan picking, small drags, text colour and dialog loaders
  Tests of compare caps, tag plan picking, small drags, text colour and dialog loaders; `LensBitmap` asks only for what the geometry reads, and a `stamp-source` rethrow arm that only sees DataView's RangeError is gone. No behaviour change claimed; production code +6 −5 lines (the rest is tests).
- `ff8d9d0` Remove the unrendered header mode switch and its window event
  Removes `ModeSelector` (exported, rendered nowhere) and the `pdf-mode-change` window event whose only dispatcher was the shell itself. No behaviour change claimed; production code +8 −117 lines (the rest is tests).
- `2524520` Drop the tag editor's unreachable generic refusal
  Removes `tags.err.generic` (“That change is not possible.”): `applyStructureEdits` refuses only with a `StructEditError`, so the notice is read from the refusal's reason directly. No behaviour change claimed; production code +10 −10 lines (the rest is tests).

## 4. Tooling, CI, coverage, docs (21)

- `a365ae4` Close the other update tests' page before their origin; the outline survives rasterising
  `e2e/flows-modes.spec.ts` and `e2e/app15-update.spec.ts` get the teardown order of `cb9e6bf`; README and the `optimize.ts` header no longer say rasterising loses the outline; this guide. No product behaviour change.
- `d63b2ce` List every commit since the first guide, and the /Prev fix's proof, in the review guide
  This guide and `tools/review/revert-proof.json`. No product behaviour change.
- `fd5376d` List the read-aloud fix and the CI and docs commits in the review guide
  This guide. No product behaviour change.
- `6a040ec` Ignore the revert-proof report
  `.gitignore`. No product behaviour change.
- `a6e2e4f` Let a revert-proof entry declare the throw or hang its fix removed
  `tools/review/revert-proof.mjs` `failure` patterns, and the `testCommit` of the `8b4d213` and `dbb0d4f` entries. No product behaviour change.
- `647e6d2` Pin the CI runners to Ubuntu 24.04
  Workflows only. No product behaviour change.
- `b854b36` Deploy only main's head, and roll back a smoke check that hangs
  `.github/workflows/ci.yml` deploy job and `tools/deploy/smoke.mjs` runtime cap, from the independent review. No product behaviour change.
- `2e6c60a` Correct the compression, save, privacy and contributor statements the review found false
  Site pages, README and CONTRIBUTING. No product behaviour change.

- `2667a9c` Run the whole suite on GitHub, deploy main after a smoke check, and check docs against the tree
  `.github/workflows/ci.yml`, `nightly.yml`, `revert-proof.yml`, `tools/deploy/smoke.mjs`, `tools/audit/docs-sync.mjs`, `pnpm coverage --min-lines`. No product behaviour change.
- `6b94d9f` Bring README, CONTRIBUTING, architecture and the site in line with the code
  Documentation and site copy only. No product behaviour change.
- `11c3ca0` test(coverage): pnpm coverage measures the unit and browser suites together
  Adds `pnpm coverage` (unit and browser V8 coverage merged by `tools/coverage/report.mjs`), the e2e recording hook in `e2e/test.ts`, a `COVERAGE_BUILD` unminified build switch in `apps/web/vite.config.ts` and the coverage block in `vitest.config.ts`. No product behaviour change.
- `1f2fd3c` docs(site): the landing, legal and 404 pages say what the editor does today, in both languages
  Site pages (landing, privacy, terms, 404, sitemap) rewritten to say what the editor does today, in Turkish and English. No product behaviour change.
- `5bac6b1` test(coverage): every page of a test's context records, not only its first
  Coverage recording in `e2e/test.ts` now covers every page of a test's context, not only the first. No product behaviour change.
- `ea1c354` Count browser coverage on declarations whose two maps start apart
  Coverage report counts browser statements whose two source maps start apart (declarations), in `tools/coverage/report.mjs`. No product behaviour change.
- `575f7ba` Let a full run cap its browser workers with E2E_WORKERS
  `E2E_WORKERS` caps the Playwright workers (`playwright.config.ts`, CONTRIBUTING.md). No product behaviour change.
- `3edffdc` Rewrap the Office export paragraph in architecture.md
  Rewraps one paragraph of architecture.md. No product behaviour change.
- `01d2594` Document how signature ranges are paired above 16 MiB
  architecture.md: how signature ranges are paired above 16 MiB. No product behaviour change.
- `7792744` Document that external links open in a new tab
  README: external links open in a new tab. No product behaviour change.
- `3d782de` Describe how engine guards are tested by fault injection
  CONTRIBUTING.md: how engine guards are tested by fault injection. No product behaviour change.
- `058dea4` Document the Word export's note for pictures it leaves out
  README: the Word export's note for pictures it leaves out. No product behaviour change.
- `a22a4c9` Document browser engine fault injection and how the interface mode travels
  CONTRIBUTING.md and architecture.md: browser engine fault injection and how the interface mode travels. No product behaviour change.

## 5. Test-only (25)

- `05d35d5` Make the refused-camera and window-resize browser tests independent of the host
  The refused-permission tests relied on the browser refusing (a runner without a camera answers `NotFoundError`), and the resize test failed when it read page one while pdf.js swapped its canvas. Test-only; the `dbb0d4f` proof runs from here.
- `fd0aa63` Test the degenerate-raster refusal on a strip the unfixed detector mistook for a sheet
  The first test of `8b4d213` used a flat strip the unfixed detector also found nothing in. Test-only; the `8b4d213` proof runs from here.
- `cb9e6bf` Close the update-banner tests' page before their origin
  The tests closed their second origin while the reloaded page still warmed its lazy chunks, so the worker answered 503. Test-only.
- `7d68e82` Make two pdf.js handle tests fail when their behaviour breaks
  A retry test that accepted a cached rejection and a render-abort test that accepted a finished render, both found by the independent review. Test-only.
- `de51893` Test that a generated print file opens beside an untouched source
  Covers the print button `c892667` made reachable. Test-only.

- `071d171` test: every suite runs pdf.js on its legacy worker, set once in the setup
  Six suites pointed pdf.js at its modern worker (needs `Math.sumPrecise`, missing in this Node), so pdf.js warned and skipped work while the tests passed; the legacy worker is now set once in `vitest.setup.ts`. Test-only.
- `2feab6a` test: browser and behaviour checks assert the outcome, not text that is always there
  Browser and behaviour checks matched text that is always there (a `destPageRef` that was not null with no link, whole-page regexes matching the tools' own titles, an always-rewritten theme); they now read the produced file or the report rows. Test-only.
- `e7d26c7` Make the file-handle and two-window specs wait for state, not timing
  File-handle and two-window specs waited on timing; they now wait for state (Ctrl+O pressed until the picker took the handle, the closed window's lock gone). Test-only.
- `2b75163` Browser tests for the Tags view
  Browser tests of the Tags view, each apply re-read with MuPDF. Test-only.
- `b1ae333` Test the editability verdict ladder
  Unit tests of the editability verdict ladder. Test-only.
- `358f1ef` Test PDF/A preparation against a file with everything PDF/A forbids
  Unit test of PDF/A preparation against one file carrying everything PDF/A forbids. Test-only.
- `b64041c` Test opening protected PDFs and the small dialogs, layers and badges
  Browser tests of password opening, small dialogs, layers and badges. Test-only.
- `4a9c4b5` Test stamp placement, tool properties and the redaction strip
  Browser tests of stamp placement, tool properties and the redaction strip. Test-only.
- `097319b` Test resizing and multi-selecting placed pictures, XFDF and the find bar
  Browser tests of picture resizing and multi-select, XFDF and the find bar. Test-only.
- `dce0a0f` Test converting and opening files, history steps, offline packages and unlocked copies
  Browser tests of converting and opening files, history steps, offline packages and unlocked copies. Test-only.
- `2205362` Test printing, reading aloud, signature pads, picture stamps and XFA dialogs
  Browser tests of printing, reading aloud, signature pads, picture stamps and XFA dialogs. Test-only.
- `07f0d25` Run the offline-preparation test with the service-worker tests
  The offline-preparation spec joins the `@service-worker` tests because it timed out under the full suite's load. Test-only.
- `141f126` Test busy, size, page-limit, picture and redaction refusals and vault recovery
  Browser tests of busy, size, page-limit, picture and redaction refusals and vault recovery. Test-only.
- `f710956` Test palette selection commands, the XFA banner, the page field and update dismissal
  Browser and unit tests of palette selection commands, the XFA banner, the page field and update dismissal. Test-only.
- `ef14ad2` Inject engine failures in the browser and test how the shell handles them
  Browser engine fault injection (`e2e/engine-faults.ts`) and specs of how the shell handles attachment, form, layer and Edit Text failures. Test-only.
- `79144e7` Test merged highlight boxes, presets on resize, form values, locked text and layer headings
  Browser tests of merged highlight boxes, presets on resize, form values, locked text and layer headings. Test-only.
- `20448a7` Test search, signature and XFA engine failures and a busy Start result
  Browser tests of search, signature and XFA engine failures and a busy Start result. Test-only.
- `234da74` Test accessibility, PDF/UA, tags, reading and XFA flatten engine failures
  Browser tests of accessibility, PDF/UA, tags, reading and XFA flatten engine failures. Test-only.
- `352ec17` Wait for the home screen's file input before offering a huge file
  The size-limit spec waits for the home screen's file input before offering the file. Test-only.
- `8f236f5` Test the Properties panel's signatures, trust roots and revocation lists
  Browser tests of the Properties panel's signatures, trust roots and revocation lists. Test-only.
