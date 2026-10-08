<div align="center">

<img src="public/favicon.svg" width="88" height="88" alt="SsPdfEditor logo">

<h1>SsPdfEditor</h1>

<p><b>A free PDF editor that runs entirely in your browser.</b><br>
Edit, sign, redact and OCR your PDFs — the file never leaves your device.</p>

<p>
<a href="https://github.com/isolmaz/ss-pdf-editor/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI" src="https://github.com/isolmaz/ss-pdf-editor/actions/workflows/ci.yml/badge.svg?branch=main"></a>
<img alt="license AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue">
<img alt="data local only" src="https://img.shields.io/badge/data-local%20only-2ea44f">
<img alt="no account" src="https://img.shields.io/badge/account-none-2ea44f">
<img alt="offline PWA" src="https://img.shields.io/badge/offline-PWA-5a3fc0">
<img alt="languages" src="https://img.shields.io/badge/languages-TR%20%7C%20EN-555">
<img alt="engines" src="https://img.shields.io/badge/engines-MuPDF%20%7C%20pdf.js%20%7C%20Tesseract-555">
</p>

<p><a href="https://pdf.isolmaz.com/editor/"><b>Open the editor</b></a> · <a href="https://pdf.isolmaz.com/">Website</a> · <a href="#quick-start">Run locally</a> · <a href="https://github.com/isolmaz/ss-pdf-editor/issues/new/choose">Report a bug</a></p>

</div>

---

## Features

| | |
| :---: | :---: |
| **Open, navigate, zoom** — thumbnails, outline, tabs<br>![Opening a PDF and moving through its pages](docs/media/open-and-navigate.gif) | **Search** — every match, across pages<br>![Searching the document](docs/media/search.gif) |
| **Mark up** — highlight, shapes, ink, typed text<br>![Highlighting, drawing and adding text](docs/media/annotate.gif) | **Edit text** — retype a paragraph in place<br>![Editing a paragraph in place](docs/media/edit-text.gif) |
| **Organise pages** — rotate, reorder, undo<br>![Rotating and reordering pages](docs/media/pages.gif) | **Watermark** — stamp every page<br>![Adding a watermark](docs/media/watermark.gif) |
| **Fill and sign** — forms and PAdES signatures<br>![Filling a field and signing the document](docs/media/fill-and-sign.gif) | **Protect** — AES-256 password and permissions<br>![Encrypting the document](docs/media/protect.gif) |
| **Redact for real** — content removed, then verified gone<br>![Redacting a line of text](docs/media/redact.gif) | **OCR** — make a scan searchable<br>![Recognising a scanned document](docs/media/ocr.gif) |
| **Measure** — distance, perimeter, area<br>![Measuring on the page](docs/media/measure.gif) | **Compare** — what changed between two versions<br>![Comparing two documents](docs/media/compare.gif) |
| **Reading mode** — the page as clean text, read aloud<br>![Reading mode](docs/media/reading-mode.gif) | **Dark theme, Turkish and English**<br>![Switching to the dark theme and Turkish](docs/media/theme-and-language.gif) |
| **Command palette and export** — `Ctrl+K` finds any tool<br>![The command palette and the export dialog](docs/media/palette-and-export.gif) | **And more** — see the full list below ⬇️ |

### Everything it can do

| | |
| --- | --- |
| 📖 **Read** | Continuous scroll · search · thumbnails · outline · tabs · recent files · book and presentation modes · magnifier · snapshot · reading mode with read-aloud |
| ✏️ **Annotate** | Highlight · underline · strike-out · squiggly · ink · shapes · notes · stamps · typed text · links · images · move, rotate, resize and delete any mark · comment threads with replies and review status · XFDF, FDF and JSON import and export |
| 📝 **Forms** | Fill · create fields · detect fields on a flat form · flags · flatten · calculations · FDF/JSON import and export · XFA forms (static and dynamic): fill, data in and out, flatten to a normal PDF, remove the XFA |
| 📄 **Pages** | New blank document · insert · delete · duplicate · reorder · rotate · extract · split · replace · merge (several files, in any order) · page boxes and auto-crop · labels |
| 🔤 **Text** | Edit in place with reflow · find and replace across the document · export as text or Markdown · pages to images · images to PDF · scan with the camera · Word, Excel, PowerPoint, HTML, text, CSV and EPUB to PDF · PDF to Word, Excel and CSV |
| 🗂️ **Structure** | Outline · attachments · layers · properties and XMP · header/footer · Bates numbering · watermark |
| 🔐 **Security** | True redaction with an audit · sanitize (scripts, attachments, metadata, hidden layers, with a verified report) · AES-256 encryption · remove a password · drawn, typed or photographed signatures and initials · PAdES signing · signature verification with imported CRLs, embedded revocation data and RFC 3161 timestamps |
| 🧰 **Tools** | OCR in 27 languages · accessibility check, PDF/UA check and tags / reading-order editor · alt text · text and pixel comparison · batch processing · compression · PDF/A conversion and check |
| 🖨️ **Print** | Page ranges · N-up · booklet · poster · duplex sheets |
| ⚙️ **Workflow** | Home screen with every tool by task · `Ctrl+K` palette · undo/redo history · local drafts · save over the original or export a copy · simple and advanced modes (chosen in Settings) · offline |

## Quick start

You need **Node ≥ 26** and **pnpm 9.15.9**.

```bash
pnpm install --frozen-lockfile
pnpm fetch:engines --sync   # copies the pinned engines from the pnpm store (no CDN)
pnpm dev                    # http://localhost:5173
```

---

## Contents

1. [Features in detail](#features-in-detail)
2. [Privacy and security](#privacy-and-security)
3. [Document limits](#document-limits)
4. [Honest limits](#honest-limits)
5. [Development](#development)
6. [Quality gates](#quality-gates)
7. [Build and deploy](#build-and-deploy)
8. [Offline use](#offline-use)
9. [Contributing](#contributing)
10. [License](#license)

---

## Features in detail

Every capability below is implemented in this repository. You can reach each one from the
UI: the menu bar, the `Ctrl+K` palette, the tool rail, the docks or the home screen.

### Reading and navigation

- **Home screen.** *Start* opens a PDF (or several, each in its own tab), creates a blank
  document, builds a PDF from images, merges several PDFs in the order you choose or starts
  a batch run, and lists recent documents with search, sorting and stars. *All tools* lays
  every tool out by task; pick a tool first and the editor asks for the file when the tool
  needs one. A file that does not open drops the tool, so it never runs on a later document.
- **Viewer.** pdf.js's own viewer stack drives continuous virtualised scrolling, text
  selection and search with match highlighting. With the hand tool a link in the page is
  followed: an internal one goes to its page, an external one opens in a new browser tab, so
  the open document and its unsaved changes stay where they are.
- **View modes.** You get single-page, book and full-screen presentation modes, a
  magnifier lens, and a snapshot tool (**View → Snapshot**, or the palette) that combines the
  pages in view into one PNG to copy or download.
  - Presentation starts on the page at the top of the viewer and fits it to the screen width.
    Space, `→` and `PageDown` turn to the next page, `←` and `PageUp` to the previous one,
    `Home` and `End` go to the first and last page. `Esc` ends it, and so does the browser
    leaving full screen. A browser that refuses full screen still shows the presentation
    layout in the page. Leaving restores the zoom you had.
- **Reading mode.** The page is shown as a text column. Read-aloud speaks it a sentence at a
  time, with pause, stop and a speed control, and uses only a speech voice installed on the
  device for the document's own language (the catalog `/Lang`, matched on its primary
  subtag) or, when the file declares none, for the interface language; without such a
  voice it is unavailable and says so.
- **Navigation aids.** Thumbnails, the outline and document tabs. The recent-files list
  reopens a document by its identity, never by its file name. In Chromium-based browsers it
  reopens the file itself (the browser asks for permission again, and once more for write
  access the first time you save over it); elsewhere it asks you to choose the file.
- **The document never moves under you.** Marks, selections, measurements and staged
  redactions scroll and zoom with their page. Tools, progress and notices never shift
  the page.
- **Password-protected files.** The editor asks for the password and opens the file
  read-only. "Create unlocked copy" opens an editable copy in a new tab, and the password
  is kept in memory only.
- **Shortcut list.** It is available in both languages from Help or `Ctrl+K`, even with no
  document open. The list is the binding table itself, so every chord it prints works.
  `Home`, `End`, `PageUp` and `PageDown` turn the document's page, except while the focus is
  in a menu bar or menu, a list, tree or grid, a tab strip or the form panel's field list:
  those keep the keys to move inside themselves.

### Annotating, forms, measuring

- **Markup.** Highlight (selected text or freehand), ink, notes, stamps, underline,
  strike-out, squiggly and geometric shapes are all available.
- **Add text.** Click and type. The text is written as a `/FreeText` annotation with
  embedded Noto Sans, so Turkish letters survive in every reader. It stays upright on
  rotated pages.
- **One tool rail.** The rail holds every canvas tool: select, hand, edit text, add text,
  markup, ink, shapes, note, link, measure and redact.
  - The rail, menus, palette, context menu and keyboard all share one armed tool.
  - Text you selected before arming a markup tool is marked at once.
- **One selection for every mark.** This covers session marks, measurements, staged
  redactions and annotations already in the file.
  - Select by clicking, with a marquee or with `Ctrl+A`.
  - Then delete, rotate 90°, drag, or nudge by 5 pt. Every edit can be undone.
  - Selection deletes whole marks only, never page content. To remove page content
    securely, use redaction.
- **Style.** The app sets colour, opacity, thickness and author. Multiply blending keeps
  text readable, and freehand strokes stay continuous in the exported file. A rectangle,
  circle or line writes its thickness as the annotation's border width (`/BS /W` and
  `/Border`), so other readers draw it and this editor reads the same thickness back.
- **Comment threads.** In the Notes panel every comment can be answered and given a review
  status (Accepted, Rejected, Cancelled, Completed), as in Acrobat.
  - A reply is a real PDF reply (`/IRT`) and a status is a real `/State` record (text
    strings, as the PDF standard defines them), so Acrobat, Foxit and other readers show
    the same thread. Replies and statuses already in a file are listed under their comment.
  - A comment already in the file gets the reply at once, as one undoable step. A comment
    not saved yet keeps it until the comment itself is written.
  - Deleting a comment deletes its replies and statuses with it.
- **Comment exchange.** Comments can be exported and imported as **XFDF** (the XML format
  review tools share), FDF (Acrobat's container) or JSON (this app's lossless form).
  - XFDF carries the comments already in the file as well as the unsaved ones, with their
    replies and statuses. JSON and FDF carry the unsaved ones.
  - Imported comments arrive as unsaved marks that can still be edited.
- **Operations in two steps.** Every operation opens in the tools panel. First you set it
  up, then *Preview* runs it and shows a report. The report's own button applies the
  result. Pop-up windows are used only for decisions that block, such as a password,
  unsaved changes, a signature warning, export, print or settings, plus the XFA form
  viewer, which needs the room.
- **Save versus Export.** *Save* writes over the file you opened; this needs Chromium
  and its File System Access API. *Export* always downloads a copy; its dialog shows the
  size of the document as it is now, not as it was opened. Firefox and Safari offer Export
  only.
- **Forms.** The editor lists the AcroForm fields. You can create fields, set flags,
  flatten them and add simple calculations. Form data can be imported or exported as FDF
  or JSON; exporting downloads only the data file.
  - **Detect fields** (Forms panel, or `Ctrl+K`) prepares a flat form: it proposes text
    fields, checkboxes, radio groups and signature fields from underlines, dotted leaders,
    boxes, cells, comb boxes, circles and colon labels. Fields are named from the nearest
    label. You see every candidate on the page, remove the ones you do not want and add the
    rest in one undoable step; the result is re-read before it is saved.
- **XFA forms.** A PDF form can carry XFA (Adobe's XML form format) next to or instead of
  its AcroForm. The editor says so in a notice under the tool strip, and what it does
  depends on the kind of form:
  - *Static* XFA (the widgets are in the PDF): filled like any form, and every write also
    updates the XFA data, so Acrobat shows the same values. Filling in place appends that
    update to the file instead of rewriting it, so a signature the form already carries
    keeps covering what it signed. *Remove XFA* keeps only the AcroForm.
  - *Dynamic* XFA (the PDF page is only a "Please wait…" placeholder): *Fill XFA form*
    draws it with pdf.js's XFA renderer in its own window, saves what you typed into the
    form's data, and can export that data as XML. *Flatten to a normal PDF* writes the
    laid-out pages as pictures with an invisible text layer.
  - *XFA data* exports and imports the form's data as the XML file Acrobat's "Export data"
    writes; in a static form the fields are filled from it too.
- **Measurement.** Measure distance, perimeter and area with a scale, units, a grid and
  snapping. The results are written as real PDF annotations. `Esc` clears the chain being
  measured, and a second `Esc` returns to the select tool.
- **Small screens.** Below 1024 px both docks start collapsed and reopen as overlays.

### Pages and structure

- **Page operations.** Insert, delete, duplicate, reorder, rotate, extract, split, replace
  and merge.
  - A new document starts as blank pages of A3, A4, A5, Letter or Legal, in either
    orientation.
  - Merging several files builds a new document in the order you set; its metadata comes
    from the first file, and the report says so.
  - Composition goes through pdf.js `extractPages`, so outlines, form fields and page
    labels travel with the pages.
  - The Pages panel selects by click, `Ctrl`, `Shift` or the keyboard. It moves the
    selection with `Alt` or `Ctrl` plus the arrow keys, the up and down buttons, the *Move
    to* field or drag and drop, and its toolbar rotates, duplicates, deletes and extracts.
    The toolbar buttons, the *Move to* field and dragging are disabled while the document
    is viewing-only.
- **Page boxes.** You can edit the Media, Crop, Trim, Bleed and Art boxes. Auto-crop sets
  the box from the ink bounds.
- **Structure.**
  - Page labels.
  - Outline editing.
  - Links, limited by a URI allow-list.
  - Attachments: add, save and remove in the Attachments panel; the Properties panel lists
    each one with its size, read from the file, and shows "Size unreadable" for one whose
    data cannot be read.
  - Layers (OCG).
  - Header and footer, Bates numbering and watermarks.
- **Printing.** N-up, booklet and poster imposition, plus a duplex print-sheet builder.
- **Compression.** There are two modes: a structural re-save (lossless), or turning the
  selected pages into images (lossy: their text layer, links and annotations are lost; the
  outline still leads to them).
  If the file grows, the report says so.

### Text

- **Text editing with reflow.** Pick a text block and retype it. The editor removes the
  original glyphs and draws the new text in the same box.
  - Editability is measured per block first.
  - A block that cannot be reproduced faithfully is marked **not editable**.
- **Find and replace.** **Edit → Find and replace** (`Ctrl+H`), or **Replace…** in the find
  bar, replaces a text everywhere it occurs, with match case, whole words and a page range.
  The old glyphs are really removed, and the result is checked with a second PDF engine.
  - The new text is drawn where the old one was, at its size and in its colour. When it is
    wider or narrower, the rest of the line moves along; text after a tab stop keeps its
    place. A match across a line break, or one that does not fit its line, lays the
    paragraph out again, and every other word keeps its own font, size and colour. The
    paragraph keeps its alignment (left, centred, right or justified), and the erased area
    stops where the lines above and below begin, so a neighbouring line is not removed with
    the match.
  - It uses the document's own font whenever that font already draws every character the
    new text needs (in a merged file, the copy of the font the page itself uses). Otherwise
    it uses a close standard font (Helvetica, Times, Courier) or Noto Sans, sized to match,
    and the report names the font.
  - Searching without match case treats `I`/`ı` and `İ`/`i` as Turkish and English
    readers expect: `istanbul` finds `İSTANBUL`, and `sık` never matches `sik`.
- **Export and import.** Export text as plain text or Markdown. Export pages as images, or
  build a PDF from images.
- **Other documents to PDF.** DOCX, XLSX, PPTX, HTML, TXT/MD, CSV/TSV, EPUB and FB2 are
  converted in the browser by MuPDF's layout engine. The result is real text you can select
  and search.
  - Opening or dropping such a file converts it and opens the PDF in a new tab; a dropped
    image opens as a PDF page. **File → Convert to PDF** offers the page size, orientation
    and margin, and joins several files into one PDF in the order you set.
  - Word goes through mammoth: headings, lists, tables, links and images. Each Excel sheet
    becomes a table of its used range, with date-formatted cells shown as dates, and each
    slide becomes a page of the slide's size with its text, tables and pictures in reading
    order.
  - Headings become the outline. `http:`, `https:` and `mailto:` links and links inside the
    document become link annotations. The title comes from the file or its name.
  - Text and CSV that are not UTF-8 are read as Windows-1254, and the report says so.
- **PDF to Word, Excel and CSV.** **Export → Word, Excel or CSV** (also in the tools panel,
  the palette and the home screen) rebuilds the pages in the browser as an editable file.
  - **Word (DOCX):** paragraphs that reflow, with their fonts, sizes, bold, italic and
    colour. A line that starts with a bullet, or with one or two digits and a full stop or
    bracket, starts a new paragraph. Larger type becomes Heading 1–3, so Word's navigation
    pane and table of contents see it. Alignment, indents and spacing are measured from the
    page, each page keeps its size and orientation, and two-column text is read column by
    column. Ruled tables become Word tables with their merged cells. Tables without rules
    are recognised from the spacing of the text and become borderless tables. Pictures keep
    their transparency; charts and drawings made of vector graphics are carried as pictures, their labels staying text over them.
    A picture that cannot be read, or one inside a table cell, is left out, and the report
    says how many.
  - **Word layout.** Word has three layouts, chosen in the Export dialog and in the form: *Text
    and pictures, exact layout* (the default; "Metin + resim, tam düzen" in Turkish), *Flowing
    text* (described above, the one to edit at length) and *One picture per page*. Word's pages
    stop at 22 inches (55.88 cm) a side, so in the exact layout and in the picture layout a
    larger page is shrunk in proportion to fit, text sizes and offsets with it, and the report
    says which pages and by how much.
    - **Exact layout.** Each page keeps the geometry it has in the PDF: a section of the page's
      size with no margins, the drawing behind in paint order and the text boxes above it.
      - **Fonts.** The fonts the page's visible text uses are embedded in the DOCX, so Word
        draws the glyphs the PDF draws. TrueType and CFF programs (`FontFile2`, `FontFile3`)
        are the PDF's own subsets, rebuilt as small TrueType files with a Unicode map of the
        glyphs the pages show and a name table Word can use, and stored obfuscated as the
        Word format asks (`.odttf`); a ligature glyph (such as "fi") is mapped only as the ligature, never
        as its first letter. The licence flag is kept as the PDF has it: a font whose
        embedding permission is "restricted" is not embedded, and neither is a Type 1 font or
        one that cannot be rebuilt. Such a font is named by its kind, so Word draws a close
        one: a family Windows ships (Calibri, Cambria, Segoe UI…) keeps its name, sans faces
        become Arial, serif faces Times New Roman and monospaced faces Courier New (by name,
        else by the font's own serif and monospace flags). The report says how many fonts were
        embedded.
      - **Text.** Lines are grouped into paragraphs (same size, regular line pitch, one
        alignment; a bullet starts a new one) and paragraphs that stack evenly into one editable
        text box, placed so that the first baseline lands on the PDF's, with exact line spacing
        and no insets. Text turned a quarter turn is a vertical text box. Word sets sizes in
        half-points and draws letters at the font's own advances, so every word carries a
        character spacing (and a width scale where the face differs) that puts each letter, and
        each space, where the PDF has it. A justified paragraph is written left-aligned: the
        words are already fitted to their places, and Word's own justification would stretch
        the fitted spaces a second time. The trade-off is that text you type into such a
        paragraph is not justified again. Centred and right-aligned paragraphs keep their
        alignment.
      - **Shapes, pictures, links.** Lines, rectangles, curves, fills and strokes (colour,
        transparency, dashes, caps, joins) are Word shapes (an upright rectangle is a Word
        rectangle). Pictures are anchored where they sit, with their transform, soft mask and
        clip applied (JPEG for an opaque photograph, PNG otherwise), each as a rectangle filled
        with the picture, so that it stacks with the shapes in paint order. `http:`, `https:` and
        `mailto:` links are links on the text. What Word cannot draw is placed as a picture
        instead, rendered without the text so the text stays editable: gradients, patterns,
        soft masks, blend modes and clips that are curves, text or image masks (a clip with
        straight edges is kept as shapes when the content lies inside it), and a page of more
        than 1500 drawings as one picture. The report counts the text boxes, shapes,
        pictures and those regions.
      - **Scanned pages (OCR).** A page that shows pictures covering at least half of it and
        no visible text is read with Tesseract, in the browser, with the best model, in the
        languages ticked in the form (default Turkish and English; the 27 OCR languages are
        offered). The page is rendered at the scan's own resolution (150–300 dpi). The words
        become editable text boxes with the size and colour measured from the scan, bold per
        word (from the width of its strokes), italic per line (from whether the ink stands
        straighter when it is sheared back), underline where a rule lies under the word (a
        link), and the family (Arial, Times New Roman or Courier New) whose letter widths fit
        the words best, each word at its scanned place. Paragraphs are put in reading order
        column by column, and a grid of cards row by row. What OCR did not read (photos, logos,
        cards, shading) is cut out as pictures behind the text, over a page-sized rectangle of
        the page colour, and the words are erased from them, with their accents and dots and
        the faint ripples a JPEG leaves around letters. Icons, link-icon corners, bars between
        items and bullets that OCR made into symbols, the dot of an İ read as a word of its own,
        a word read twice and the specks along a scanner's edge are not text.
      - **Reading a scan twice.** A page with underlined words is read a second time with the
        underlines erased, because a link's rule makes OCR misread the letters above it. Every
        word OCR is less than 95 % sure of is then read again alone, enlarged up to three
        times, with the ticked languages together; the new reading is kept only if it is surer
        and changes letters into letters, never dropping or adding a character. A run of
        capitals ("SQL") is read again with English alone, which has no word "sol" to pull it
        astray. A word with a gap wider than a space inside it (a phone number run together) is
        split at the gap and each piece read alone. At most 150 such reads are made per page
        (words with a gap first, then the least sure); if one cannot run, the first reading
        stands.
      - **Scan details.** When the PDF already has an invisible OCR text layer (this app's OCR
        leaves one), its words are used and OCR is not run. A word read with less than 90 %
        confidence is marked with a Word comment, and the report lists those words by page.
        With no language ticked, or when the engine cannot start, a scan stays a picture and
        the report says so. How the engine and the 90 % threshold were chosen:
        [docs/ocr-evaluation.md](docs/ocr-evaluation.md).
    - **Flowing text** is described above.
    - **One picture per page** draws every page exactly as a viewer shows it (annotations and
      form fields included, on white paper) and puts it in its own section as one picture
      anchored behind the text. The page is drawn at 200 dpi from its corner, at one scale on
      both axes (fewer dpi only when a page would pass 40 megapixels), and the section and the
      picture are the page's size to the twip, so the picture is the page pixel for pixel and a
      scan is not resampled. It is JPEG (quality 92) for a page that is at least half pictures
      (a photograph or scan), PNG otherwise. The look is exact, but the text cannot be edited in
      Word.
  - **Excel (XLSX):** one sheet per table, with merged cells and the column widths of the
    rules. A page without any table becomes one sheet of its rows. A value becomes a number
    only when it reads one way: `1.234,56` and `1,234.56` do, but `1.234` stays text (a
    thousand, or one point two three four?), and so does `007`.
  - **CSV:** the same tables in one UTF-8 file, with the comma or semicolon that Excel
    expects in your region. A text cell that starts with `=`, `+`, `-` or `@` would run as a
    formula when the file is opened, so it is written with a leading `'` (negative numbers
    are left alone), and the report counts them.
  - A Word file (any layout) is read back with mammoth (an independent reader) and a CSV file with a CSV
    parser before it is offered; an Excel file is not read back. The report says what was
    approximated.

### Scanning with the camera

**File → Scan with camera** (also on the home screen, in the palette and as a source in
**Insert pages**) turns photographs of a document into a PDF, like a phone scanner app, with
nothing leaving the browser.

- **Camera or files.** The live preview opens the rear camera on a phone and offers a
  camera picker on a laptop; the photograph is taken at the highest resolution the camera
  offers. **Choose photos** takes pictures from files instead, which is also the way on a
  device without a camera or when the camera permission is refused. Denied, missing,
  in-use and insecure-connection cases each say what to do, in Turkish and English.
- **The page is found for you.** An outline follows the page in the preview, and the
  photograph is analysed again on capture. A small detector (no OpenCV) finds the page's four
  straight edges even where a finger or glare breaks them. If it is not sure it says so and
  leaves the corners for you to place.
- **Four corners to drag.** A magnifier follows the finger, and the arrow keys move a
  selected corner. The straightened page is shown next to the photograph as you move them.
- **Straightened, not just cropped.** The page is warped to a rectangle, and its shape is
  worked out from the perspective, so a page photographed at an angle comes out as an A4
  page and not a stretched one.
- **Four looks.** Original colour, grayscale, black and white (adaptive threshold, so a
  shadow does not turn half the page black) and **Enhanced** (even lighting, white paper,
  colour kept).
- **Several pages.** Thumbnails to reorder, rotate, delete, retake and re-edit the corners
  of (re-editing the corners of a page ends with **Apply**), then A4, Letter or
  fit-to-image pages and a JPEG quality. A photo that cannot be opened is reported, and the
  notice stays while the next photo opens. The PDF opens as a new tab; you are offered the
  OCR tool on it, which makes it searchable. If the PDF cannot be opened (another operation
  is still running, it is over a size or page limit, or opening fails), the scan dialog says
  why and stays open with your pages, and **Create PDF** can be pressed again; no tab is
  opened.
- **Into an open document.** In **Insert pages**, the source **Scan with camera** inserts
  the straightened pages after the page you choose.

### Redaction, security, signing

- **True redaction.**
  - Marks become MuPDF redaction annotations, and `applyRedactions` removes the glyphs.
  - The file is then rewritten with `garbage=compact,compress,clean`, and the output is
    re-checked glyph by glyph.
  - An object-level audit reports any remaining terms, earlier revisions and leftover
    structure.
  - A staged mark stays an intent until you apply it. Saving while marks are still staged
    is refused.
- **Sanitize.** One dialog removes what the pages do not show.
  - Categories: scripts and code-running actions, attached files, metadata, private
    application data, thumbnails and hidden layers (on by default); external links, comments
    and form fields (flatten or remove; off by default).
  - The report lists what was found and removed per category. The output is re-read and each
    chosen category must count zero, or nothing is returned.
  - A file with earlier revisions (incremental saves) is always rewritten as one, even when
    the latest revision holds nothing to remove: an earlier one can still contain what a
    later save deleted. When the file has one revision and none of the chosen categories is
    present, it is returned unchanged and the report says nothing was found.
  - When the selection does not change the picture, up to 40 pages are rendered before and
    after and must match pixel for pixel.
  - Limits: no "embedded search index" category (its place in the file is not specified),
    scripts inside 3D and rich media are reported but not edited, hidden-layer content that
    cannot be cut out exactly stays and is reported, and a digital signature does not
    survive.
  - A dynamic XFA form keeps its content only in the XFA, so a run that would remove the XFA
    (scripts, or form fields) is refused; flatten the XFA form to a normal PDF first.
- **Encryption.** AES-256 with permission bits; the output is re-opened and verified. The
  encrypted copy is downloaded, not applied to the open document.
- **Simple signatures and images.** Draw a signature, type your name in one of two
  handwriting faces, or take it from a photo of a signature on paper (the paper is made
  transparent). Choose signature or initials and black, blue or navy ink, then click where
  it goes on the page.
  - It is written into the file at once as a `/Stamp` annotation with an image
    appearance, as one step that undo takes back. It stays upright on turned pages.
  - **Add an image** places a PNG, JPEG, WebP, GIF or BMP the same way; transparency is
    kept, and a JPEG that needs no turn or shrink keeps its own bytes.
  - Select a placed picture to move or turn it, or resize it from a corner handle (or the
    arrow keys on a focused handle). Resizing changes only `/Rect`; the image is not
    re-encoded.
  - **Remember on this device** is off by default. When ticked, the picture stays in this
    browser's local storage only, and every saved entry can be deleted from the dialog.
- **Signing.** PAdES B-B from a PKCS#12 identity, with a visible stamp.
  - The verdict has four separate parts: integrity, trust, revocation and coverage.
  - Signatures of files larger than 16 MiB are checked against the exact byte ranges stored
    in the file (MuPDF reports them rounded above that size); a range that cannot be paired
    with the stored one leaves the signature unchecked.
  - Trust is checked only against certificates you imported. A certificate that is not yet
    valid is reported with the date it becomes valid; any other shows its expiry date.
  - Revocation is read from lists already on your device, never fetched: CRLs you import in
    the signature panel (DER or PEM, kept in the app's own storage until you remove them) and
    the CRLs and OCSP responses stored in the PDF (the `/DSS` and the signature's own
    revocation archive). Each certificate in the chain is reported not revoked, revoked (with
    date and reason, and whether that is before or after the signature) or unknown. A list
    issued before the signature, or one past its next-update date when no trusted timestamp
    fixes the signing time, cannot rule out a revocation: the summary then says the lists are
    too old instead of "not revoked".
  - RFC 3161 timestamps are verified offline, both a signature's own timestamp and
    document timestamps (`ETSI.RFC3161`): the hash it covers, its signature, the authority's
    time-stamping certificate and, with a root you imported, its chain. A timestamp from an
    authority you trust is the time the signature is judged at.

### OCR, accessibility, comparison, batch

- **OCR.** Recognition adds an invisible, selectable text layer with a real `/ToUnicode`
  map. Pages that already have text are skipped by default.
  - 27 languages: Turkish, English, German, French, Spanish, Italian, Portuguese, Dutch,
    Polish, Czech, Hungarian, Romanian, Swedish, Azerbaijani, Kurdish (Kurmanji), Russian,
    Ukrainian, Bulgarian, Greek, Arabic, Persian, Hebrew, Hindi, Chinese (simplified and
    traditional), Japanese and Korean.
  - The OCR engine and every language pack are served by this site. Turkish and English are
    the two packs listed in the offline manifest, but Settings → Offline use does not fetch
    them (see [Offline use](#offline-use)). The engine and each pack are downloaded the first
    time you run OCR with them; after that they work offline too. If the engine or a language
    pack cannot be started (a missing core, pack or worker script), the notice says that the
    language or an engine package is missing, and the next run tries again.
  - Words in scripts the embedded Noto Sans cannot spell (Arabic, Hebrew, CJK) are written in
    a glyph-less font whose codes are the text itself, so they can be searched and copied.
    Right-to-left words come back in reading order.
  - Why Tesseract and no other engine, and why words below 90 % confidence are the ones
    flagged: [docs/ocr-evaluation.md](docs/ocr-evaluation.md). The same OCR reads scanned pages
    for the exact Word layout (see [PDF to Word, Excel and CSV](#text)).
- **Accessibility.** One panel with three views.
  - **Report.** The quick check reports facts only: no score and no conformance claim.
    A tagged-PDF writer adds structure tags to the file and verifies the result, and
    `/Alt` and `/TU` writers set descriptions for images and form fields.
  - **PDF/UA.** A check modelled on the Matterhorn Protocol: 34 rules, each marked pass,
    fail, needs-a-person, not applicable or not checked, with a Turkish or English explanation, how to
    fix it, and a link to the page or the element. It covers the tagged-PDF flag, the
    structure tree, title and `DisplayDocTitle`, `/Lang`, content marking, figure alt text,
    tables, headings, lists, links (`OBJR`), annotations, form tooltips, fonts (embedded,
    `/ToUnicode`, characters that map to Unicode), `/Tabs /S`, the `pdfuaid` identifier in
    the XMP packet and bookmarks for long documents. Colour contrast is **not measured**,
    and the report says so. Quick fixes write the title, language (its field starts as the
    file's `/Lang`, or the interface's language when there is none; tagging a file without
    `/Lang` also writes the interface's language), `DisplayDocTitle`, tab order, link
    descriptions, field tooltips, artifact markers for drawn lines, and Link/Form/Annot
    elements for annotations. The `pdfuaid:part` declaration is offered only when every
    automated rule passes; the rules that need a person stay unverified.
  - **Tags.** The structure tree as an editable outline, with numbered boxes over the pages
    showing the reading order. Reorder by drag or by Alt+arrow keys, change an element's
    type (P, H1–H6, Figure, Table, L, LI and the other standard types), set a figure's alt
    text or a header cell's scope, group elements or make a list, mark content as an
    artifact. A file with no tags shows the order its content is drawn in; change it and the
    types, then tag the document. Edits are a draft applied in one write, verified by
    reading the file back. A move into, out of or grouping inside an element whose children
    cannot be rewritten is refused at the drop ("That element cannot be changed here.").
- **PDF/A.** **Tools → Save as PDF/A** converts the document to PDF/A-2b (the default),
  PDF/A-3b or PDF/A-1b and opens the result in a new tab; the original stays open. The
  **PDF/A** panel (palette: *PDF/A check*) checks any file, converted or not.
  - The conversion runs Ghostscript 10.06 compiled to WebAssembly in a worker, loaded only
    when the tool is used. Colours become sRGB with an sRGB output intent, every font is
    embedded, and the XMP metadata is written from the document's own title, author and dates.
    Form fields are flattened, scripts and forbidden annotations removed, and missing
    annotation appearances drawn first (an annotation written inline in a page's `/Annots`
    included; one that cannot be drawn is removed and counted in the report), so filled-in
    form values and links survive in PDF/A-2b and 3b.
  - Before the result is offered, the checker runs on it. **A file that breaks a rule is never
    handed over**: the operation stops and says which rule failed.
  - A file that already claims the chosen level is left as it is only when it passes every
    rule and the checker could read all of it; otherwise it is converted like any other.
  - The checker covers 20 rule groups (header, trailer, encryption, file structure, streams,
    XMP metadata, the `pdfaid` claim, XMP extension schemas, XMP against the Info dictionary,
    output intent, device colour, transparency, fonts, images, graphics state, actions,
    annotations, forms, layers, embedded files). It reports each rule as passed, broken (with
    page and the thing at fault, and the ISO clause) or unchecked, and lists what it never
    looks at. For PDF/A-2 and 3 it reports a page that uses transparency without an output
    intent or a `/Group /CS`, and every use of an image is read, on every page it appears.
    **It is not a full veraPDF validation.** Its rules were calibrated against veraPDF
    1.30 while developing it (same pass or fail verdict on every fixture used).
  - The report compares sampled pages before and after: the share of words still extractable
    and a grey render, so a conversion that changed the look or the text says so.
- **Comparison.** Compare two documents by text or by pixels; the report always says which
  method it used. Text changes are listed in document order, and the line list is capped
  (the report says when it is).
- **Batch.** Run one ordered set of steps over many files, with a report for each file. The
  steps are extract pages, compress, OCR, page labels, header/footer and page numbering,
  document properties, text export and security (password and permissions).
  - A set of steps can be saved as a JSON ruleset and loaded again. A loaded ruleset runs as
    it is, with the dialog's own steps disabled, until you choose *Discard loaded ruleset*;
    choosing files afterwards does not discard it.
  - Where the browser offers a directory picker (Chromium), *Watch Folder* queues the PDFs
    of a folder and queues them again when the folder changes.

---

## Privacy and security

These describe how the build works; they are not promises.

- **No document bytes leave the device.** There is no upload path and no server API. The
  deployed Worker serves static files only.
- **No third-party requests.**
  - Every engine and font is served from this origin, pinned by SHA-256 in
    [`tools/asset-pins.json`](tools/asset-pins.json).
  - The CSP sets `connect-src 'self'`.
- **A strict CSP from one source of truth.** [`public/_headers`](public/_headers) sets:
  - `default-src 'self'`;
  - `script-src 'self' 'wasm-unsafe-eval'`, with no `'unsafe-inline'` and no `'unsafe-eval'`;
  - `style-src 'self' 'unsafe-inline'`, the only relaxation, needed because marks are
    positioned with inline styles;
  - `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` and
    `frame-ancestors 'none'`;
  - `nosniff`, `Referrer-Policy: no-referrer`, HSTS, and a `Permissions-Policy` that turns
    off the microphone, location, payment and device APIs and allows the camera to this
    origin only (`camera=(self)`, for the document scanner).

  The dev and preview servers apply the same file. The dev server adds only
  `'unsafe-inline'` for scripts, for React refresh, and logs that it does.
- **Cross-origin isolation.** `/editor/*` is served with
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
  The e2e suite runs under exactly these headers.
- **The service worker caches static assets only.** It never stores document bytes.
- **Drafts stay local.** Unsaved work is kept in the origin-private file system (OPFS).
  - A **sensitive session** saves nothing; any document opened with a password starts one.
  - The recent list keeps the file name, size, page count, when it was last opened and
    whether it is starred in `localStorage`. In Chromium it also keeps a *handle* to the
    file in IndexedDB — a reference the browser asks permission for again, never the file's
    bytes. A sensitive session keeps no handle: marking a document sensitive, or purging it,
    forgets its handle, and so do removing an entry and clearing the list.
  - A signature picture is kept only when you tick **Remember on this device**: in
    `localStorage`, at most six, each deletable from the signature dialog. A sensitive
    session does not offer it.
  - Cleanup refuses to delete anything when it cannot fully read which drafts are in use.
    Every open window of the editor holds a Web Lock while it is open, and a cleanup waits
    until each of them has said which documents it holds; a window that stays silent for
    10 seconds makes the cleanup refuse, and a window that closed meanwhile is no longer
    waited for.
  - When drafts are restored at start-up, the document you opened meanwhile stays in front;
    a draft whose document you already opened is skipped, and the others are restored.
  - If the browser's storage refuses the recovery copy of a document you open (storage
    full, for example), the document still opens and the notice says that its recovery copy
    could not be stored and why; until a draft save succeeds, its unsaved changes would not
    survive a closed tab or a crash. A later draft save that fails the same way shows the
    same sentence.
- **Deleting a draft is not secure erasure.** It does not overwrite the bytes on disk, and
  the UI never claims that it does.

---

## Document limits

The limits are defined once, in
[`packages/shared/src/limits.ts`](packages/shared/src/limits.ts):

| | Desktop | Mobile |
|---|---|---|
| Warn above | 1 500 pages | — |
| Hard ceiling | 2 000 pages / 300 MB | 2 000 pages / 300 MB |
| Viewing-only above | — | 300 pages / 64 MB |
| Render cache | 512 MB | 128 MB |

- **Viewing-only.** Above this threshold the document still opens and renders, but editing
  is disabled and the UI says why.
- **Undo history.** Kept snapshots are limited to `max(3 × file size, 64 MB)`. The two
  newest versions are always kept, and an evicted step is shown as **unavailable**.
- **Build budgets.** These are targets that are measured by hand. No script or quality gate
  measures the built output against them; `BUILD_BUDGETS` in `packages/shared/src/limits.ts`
  only holds the numbers, and `pnpm assemble:dist` only prints the sizes of what it
  assembles.
  - ≤ 250 KiB gzip for the first-paint JavaScript. Not met yet: measured 2026-10-06 the
    entry chunk is 219 KiB, but with the UI chunks it preloads the first paint is 313 KiB,
    because the editor shell still loads with the home screen (`architecture.md` §2).
  - ≤ 60 KiB for the landing page.
  - ≤ 25 MiB per asset.

---

## Honest limits

- **Converting to PDF.**
  - The conversion keeps a document's content, not its exact look. Page layout, fonts,
    headers and footers are not reproduced. Neither are slide positions and themes, or
    spreadsheet formatting, column widths and charts. Formulas show their saved result.
    Each report says what was approximated.
  - The old binary DOC, XLS and PPT formats, OpenDocument and RTF are not converted, and the
    app says so.
  - An HTML page's stylesheets and images on the internet are not loaded.
- **Converting from PDF.** A PDF records where each glyph goes, not paragraphs, tables or
  columns, so the export reconstructs them and can be wrong.
  - Exact positions, text boxes, headers and footers, form fields and annotations are not
    reproduced. A paragraph that continues in the next column stays split in two.
  - A table without rules is a guess from the spacing; the report says how many there were.
  - A chart or drawing becomes a picture drawn without its text; the labels on it stay
    editable text over the picture, which sits behind them and moves with the text around
    it.
  - Scanned pages have no text to export until OCR has added it.
- **Scanning with the camera.**
  - The page is found from its edges, so a page of the same brightness as what it lies on,
    or a background full of straight lines, may not be found; the corners are then yours to
    place. The outline is a suggestion and the dialog says when it found none.
  - The shape of a page photographed at an angle is worked out assuming square pixels and an
    uncropped photograph; a crop or an unusual lens makes a small error. A page with folds or
    a curl is flattened as if it were a plane.
  - A photograph is decoded at up to 4096 px on its long side and a page is rendered at up
    to 2600 px (about A4 at 220 dpi); a scan is not meant for archival reproduction.
  - The camera needs a secure connection (https or localhost); the app's response headers
    allow it for this site only.
- **Simple signatures.** A drawn, typed or photographed signature is a picture on the page,
  not a certified digital signature: it proves nothing about who signed or whether the
  document changed afterwards. The dialog says so; use certificate signing for that.
- **Signing.**
  - Only PAdES B-B is written: a new signature carries no timestamp (there is no network to
    ask an authority), and no revocation data.
  - Revocation is only as good as the lists you provide: with no list for an issuer the
    answer is `unknown`, and a list issued before the signature cannot rule out a later
    revocation (the panel says so). Indirect CRLs, delta CRLs on their own and partitioned
    CRLs are not processed. Both OCSP and CRL entries use the revocation date, not the
    invalidity date.
  - A timestamp from an authority you have not imported is shown but not relied on. Document
    timestamps are not used to judge the signatures before them.
  - An empty trust store reports `not-checked`.
  - RFC 5280 policy processing is not implemented.
  - Supported keys are RSA PKCS#1 v1.5 and ECDSA P-256/384/521, with SHA-256/384/512.
- **Accessibility.**
  - The PDF/UA check is automated and cannot prove conformance: reading order, alt-text
    quality and changes of language need a person, and colour contrast is not measured.
    The file is only marked `pdfuaid:part = 1` when every automated rule passes.
  - Tagging an untagged file orders content as it is drawn and guesses headings from font
    size; a document that already has a structure tree is edited in the Tags view, not
    re-tagged. Links, fields and annotations are tagged by a separate quick fix and land at
    the end of the document until moved.
  - The tags editor cannot turn an element into an artifact when its content sits inside a
    form XObject or it owns a link, field or annotation, does not edit per-element `/Lang`,
    and the annotation fix leaves a parent tree that is not a flat `Nums` array alone.
- **Redaction audit.**
  - The audit scans raw bytes, so it cannot see inside compressed streams or object
    streams.
  - It says so, and when object streams are present it skips the orphan-object verdict.
- **PDF/A.**
  - The checker is a subset of veraPDF. A clean result is not a certificate: font programs,
    ICC profile bodies, exact file syntax, XMP value formats and the accessibility rules of
    level A are not checked, and the panel lists them on every run.
  - Ghostscript rewrites the whole file. Digital signatures stop validating, form fields are
    flattened into the page, the tag structure is not kept, hidden annotations are dropped,
    and the Producer field reads `GPL Ghostscript 10.06.0`. The report lists each of these.
  - A font that is not embedded in the source is replaced by a similar one; the letter shapes
    can differ and the report counts them.
  - PDF/A-1b forbids transparency, so pages that use it are turned into pictures: their text
    can no longer be selected, their links are lost and the file can grow many times over.
    PDF/A-2b and 3b keep such pages as they are.
  - Attachments survive only in PDF/A-3b. A password-protected file is refused.
  - Text can come out different where a font has ligatures or a custom encoding and no
    `/ToUnicode`; the report gives the share of words that still extract.
- **Deleting marks.** Only annotations are deleted, never page content. A deletion rewrites
  the file and can be undone. It is not a forensic scrub.
- **Typed text.** A reader that ignores `/AP` falls back to Helvetica.
- **Embedded fonts.** Typed text, headers and footers, the OCR text layer and edited text
  embed only the glyphs they draw (about 40 KB of Noto Sans instead of 629 KB). The
  document's own fonts are left as they are. The font that form fields type with is
  embedded whole, so a reader can type any character into a field later.
- **XFDF.** Appearance streams and rich-text styling do not travel: rich text is read as
  plain text, and a rotated mark is exported as it was drawn, unrotated. A private
  `Marked` check mark is shown but not written or imported. Stamps, links and form fields
  are not comments and are left out of the export, and the notice counts them.
- **Protected documents.** These are read-only. To edit one, make an explicit unlocked copy.
- **Text editing.** Only horizontal text is editable. Vertical text, skewed baselines and
  Type3 text are not. Unknown fonts are re-rendered in a substitute font, and the UI says
  so.
- **Detect fields.** A heuristic: it proposes, you confirm.
  - It reads vector drawings and text. On a scan that already has OCR text it finds only
    horizontal rules, so boxes, checkboxes and circles are missed; a picture-only scan is
    refused with a note to run OCR first.
  - Unlabelled lines, a select that shows only a placeholder and private-use checkbox
    glyphs (such as Wingdings) are missed, and a signature caption on a document that is
    not a form can be proposed.
  - Measured only on generated fixtures, where it scored full precision and 92 % to 100 %
    recall on forms; those fixtures were written alongside the rules, so expect less on
    real forms.
- **Find and replace.**
  - Matches in scanned, rotated, skewed or Type3 text are left alone and counted in the
    report; run OCR first to make a scan searchable.
  - An embedded font holds only the glyphs its producer used, so a replacement that needs
    a character the page never draws in that font uses a substitute font.
  - A table cell is never laid out as a paragraph. A replacement too long for its cell is
    drawn smaller, down to 60 %, or left unchanged and reported.
  - A hyphen at a line end before a lower-case letter is read as hyphenation and dropped
    when a paragraph is laid out again. A compound broken at its own hyphen loses that
    hyphen too.
  - A standard font is not embedded; the reader supplies it.
- **XFA forms.**
  - XFA scripts (FormCalc and JavaScript), validations, calculations and dynamic show/hide
    never run, in the viewer or anywhere else; a field that depends on one shows its stored
    value. Rows cannot be added to a repeating section.
  - A static form's fields are mirrored into its XFA data by the template's own binding.
    A date or number field with a display picture (other than a plain date picture), a field
    with `bind match="none"`, a global or explicit data reference, and a radio group read
    back on import, are not mirrored; the report counts them, and they keep their old value
    in the XFA.
  - Removing the XFA drops its scripts and any usage rights the file carried.
  - A flattened dynamic form is pictures plus an invisible text layer, drawn with the
    browser's fonts rather than the form's, at the resolution picked when it was drawn.
  - The XFA renderer is pdf.js's: a form that relies on features it does not implement
    (scripts, some layouts, barcodes) draws incompletely.
  - Only two hand-built XFA 3.3 files were tested, no real-world form; see
    `architecture.md` §5.10.
- **Drafts.** Drafts carry a schema version. A draft from an older schema is skipped, and a
  malformed journal makes the whole draft unreadable on purpose. A draft whose stored file
  is gone is reported as damaged and not restored; the other drafts still are.
- **Early engine spikes.** Some code comments mention a measurement from an *early engine
  spike*. That prototype was removed before the public release, and each comment states
  what was measured.

---

## Development

### Commands

| Command | What it does |
|---|---|
| `pnpm prepare` | Sets `core.hooksPath` to `.githooks` so the git hooks run; it runs by itself after `pnpm install` |
| `pnpm dev` | Vite dev server for the editor (`pnpm --filter site dev` for the landing, port 5175) |
| `pnpm build` | Builds the landing (`apps/site/dist`), then the editor (`apps/web/dist`) |
| `pnpm assemble:dist` | Composes the deployable `dist/` |
| `pnpm preview` | Serves `dist/` under the production headers (port 4178, or `--port N`; Playwright passes `E2E_PORT`) |
| `pnpm typecheck` | `tsc -b` over the workspace |
| `pnpm lint` / `check` / `format` | Biome: lint / lint and format check / format write |
| `pnpm unit` | Vitest, then the non-vacuity guard, then the source-level regressions; `VITEST_MAX_WORKERS=N` caps the unit workers |
| `pnpm e2e` | Playwright against the assembled `dist/` (the signing specs need `openssl`); `E2E_WORKERS=N` caps the browsers running at once |
| `pnpm coverage [--skip-e2e] [--min-lines=N]` | Unit and browser coverage of `packages/*/src` and `apps/*/src`, added together statement by statement; per-package table and `coverage/report/html/` (rebuilds the production `dist/` before it exits); `--min-lines=N` fails the run when the total line coverage is under N % |
| `pnpm measure:model` | Journal and snapshot measurements (not a gate) |
| `pnpm fetch:engines [--sync\|--update]` | Copies engine binaries from the pnpm store and checks or rewrites the pins |
| `pnpm verify:assets` | Re-hashes every pinned file |
| `pnpm check:licenses` | Dependency licence audit |
| `pnpm check:docs` | Checks that the file paths, `pnpm` scripts and commands the documentation names exist |
| `pnpm audit:regressions` / `audit:model-types` | Regression harness / strict typecheck of the DOM-free modules |
| `pnpm ci:behavior` | The behaviour harnesses in `tools/spikes/`: the phase 3 and phase 4 browser drivers against the assembled `dist/`, then the signing check (needs `openssl`) |
| `pnpm ci:verify` / `ci:full` | The full local gate / the same plus `ci:behavior` |
| `pnpm worker:deploy[:dry]` | `assemble:dist`, then `wrangler deploy` |

Engine binaries are never committed, and the pre-commit hook blocks them. On a fresh
clone, `pnpm fetch:engines --sync` is therefore required.

### Repository layout

```
apps/
  web/              the editor PWA (served at /editor/)
  site/             landing and legal pages (static HTML, TR + EN)
packages/
  shared/           error contract, limits, i18n (Turkish and English)
  pdf-model/        session store, operation journal, drafts, save router
  pdf-core/         engine adapters (pdf.js, MuPDF, Tesseract) and every operation
  pdf-text-engine/  text model, editability, reflow, fonts
  pdf-ui/           React surfaces: viewer, panels, dialogs, tools, printing
public/             _headers, sw.js, 404.html (Turkish) and en/404.html (English),
                    manifest, robots/sitemap
tools/              dist assembly, engine pins, licence audit, regression and docs checks,
                    coverage report, deploy smoke check, revert-proof, git hooks,
                    behaviour checks (spikes/), README clip recorder
e2e/                Playwright specs for the editor flows and the site, and the engine
                    fault injection (engine-faults.ts)
docs/               integration-plan.md; media/ holds the README clips
REVIEW.md           the review guide of PR #28: its commits by risk, each fix with its test
.github/            workflows (CI, nightly, revert-proof), issue and pull request templates
```

---

## Quality gates

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request, on every push to
`main` and on manual dispatch. Its jobs:

- **`verify`** runs the steps listed below, then `wrangler deploy --dry-run`.
- **`e2e`** (after `verify`) runs the whole Playwright suite in four shards. Each shard builds
  `dist/` itself, installs Playwright Chromium (cached) and runs
  `playwright test --project=chromium --shard=N/4` with `E2E_WORKERS=2`. The HTML report and
  the traces of a failure are uploaded for 7 days.
- **`e2e-service-worker`** (after `e2e`) runs `playwright test --project=service-worker --no-deps`.
- **`behavior`** (after `verify`) runs `pnpm ci:behavior`, the OpenSSL signing round trip.
- **`fidelity`** (after `verify`) runs `pnpm fidelity`, the PDF → Word export accuracy test: every
  sample is exported through the UI in each Word layout (`flow`, `page-images`, `layout`), converted
  back with LibreOffice 26.2.6 and compared (SSIM at 100 dpi (rendered at 200 dpi and averaged) per
  page, word accuracy in reading order per document) against the thresholds in
  `e2e/fidelity/thresholds.json`; a `null` threshold is measured, not gated. Locally: `pnpm fidelity`
  with `LIBREOFFICE` set to the path of `soffice`. The report goes to the job summary and the
  `fidelity` artifact.
- **`deploy`** runs only on a push to `main`, after every job above has passed; see
  [Build and deploy](#build-and-deploy).

`.github/workflows/nightly.yml` runs daily and on manual dispatch: `pnpm coverage
--min-lines=98`, which fails under 98 % total line coverage and uploads the report, and the
Playwright suite in four shards with `--repeat-each=2 --retries=0 --fail-on-flaky-tests`.
`.github/workflows/revert-proof.yml` runs on manual dispatch and on a pull request labelled
`revert-proof`: for every fix on the list that `tools/review/revert-proof.mjs` reads, the
fix's own test must fail on the fix commit's parent and pass on the fix commit.

Branch `main` is protected: a pull request is required, `verify`, `e2e` (all four shards),
`e2e-service-worker`, `behavior` and `fidelity` must pass, and force-pushes are blocked. Pull requests
are merged with a merge commit. [`REVIEW.md`](REVIEW.md), the review guide of pull request #28, lists
its commits by risk, each fix with the test that proves it; [`docs/integration-plan.md`](docs/integration-plan.md) describes
how changes land.

- **`pnpm ci:verify`** runs the checks of the `verify` job on your machine, in order (the job
  also ends with `wrangler deploy --dry-run`, which is `pnpm worker:deploy:dry`):
  1. `install --frozen-lockfile`
  2. `typecheck`
  3. `check`
  4. `check:docs` (the file paths, `pnpm` scripts and commands the documentation names must
     exist)
  5. `fetch:engines --sync` (the unit tests read the fetched fonts from `public/fonts`)
  6. `unit`
  7. `audit:model-types`
  8. `build`
  9. `verify:assets`
  10. `check:licenses`
  11. `assemble:dist`
- **`pnpm ci:full`** adds `ci:behavior`:
  - `tools/spikes/phase3-check.mjs` runs the acceptance sentence end to end in a real
    browser. That sentence is: open, search, highlight, comment, fill a form, delete two
    pages and add one, add a header and footer, save, reopen.
  - `tools/spikes/phase4-check.mjs` runs a text-edit round trip and reads the produced
    bytes back.
  - `tools/spikes/sign-check.mts` signs with an OpenSSL identity, including a one-byte
    tamper case that must break the verdict.
- **`pnpm unit`** is a gate, not a report:
  - [`require-tests.mjs`](tools/audit/require-tests.mjs) fails the run if no tests were
    found.
  - [`regressions.cjs`](tools/audit/regressions.cjs) runs browser-free checks over the
    real sources.
- **Saves are verified.**
  - Save and Export stay disabled until the inspection of the current version has
    answered.
  - Each write is checked against twelve declared facts.
  - A fact that cannot be checked is reported as partly verified (`degraded`) or not checked
    (`unsupported`) with its reason, never folded into "verified".

---

## Build and deploy

`pnpm assemble:dist` produces exactly what is uploaded:

| Source | Lands at |
|---|---|
| `apps/site/dist` | `dist/` root (landing, legal pages, `/en/`) |
| `apps/web/dist` | `dist/editor/` |
| `public/` | `dist/` root (`_headers`, `sw.js`, `404.html`, `en/404.html`, manifest, `engines/**`, `fonts/**`) |

The same step also does the following:

- writes `dist/offline-manifest.json`;
- stamps the service-worker version;
- copies `LICENSE` and every bundled licence text into `dist/licenses/`, indexed by
  `INDEX.json`.

A missing licence or version placeholder stops the build.

Deployment is a Cloudflare Worker that serves `dist/` as static assets
([`wrangler.jsonc`](wrangler.jsonc)). There are no Functions, no SSR and no database.

A push to `main` deploys on its own: the `deploy` job of `.github/workflows/ci.yml` runs only
after `verify`, `e2e`, `e2e-service-worker`, `behavior` and `fidelity` have passed. It runs `wrangler
deploy` with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, then
`tools/deploy/smoke.mjs` against `https://pdf.isolmaz.com`. If the smoke check fails or
runs past its time limit, the job runs `wrangler rollback` to the previous version and fails.
Only one deploy runs at a time and a running one is never cancelled; a commit that is no longer
`main`'s head when its deploy starts deploys nothing.

To build and deploy by hand:

```bash
pnpm build && pnpm assemble:dist
pnpm worker:deploy          # npx --yes wrangler@4.135.0 deploy
pnpm worker:deploy:dry      # same, with --dry-run
```

---

## Offline use

- **Scope.** `public/sw.js` is scoped to `/editor/` and caches static assets only.
- **Shell.** The editor's start page, the scripts it starts with, its Turkish and
  English text and its interface fonts are cached when the worker installs, so a reload
  without a network still shows a working home screen in its own typefaces.
- **On request only.** The rest is precached only when you ask for it, in
  Settings → Offline use.
  It covers the shell, pdf.js, MuPDF and the fonts. It does not fetch OCR, although the
  manifest lists a `tesseract` capability (the OCR engine and the Turkish and English
  packs), and it does not fetch the PDF/A converter (15.5 MB of WebAssembly) either. The
  service worker stores any file under `/engines/` the first time it is fetched, so the OCR
  engine, a language pack and the converter are cached when you first use them online and
  work offline after that.
- **Readiness.** It is checked path by path, for the same capabilities the preparation
  fetches; OCR, cached on first use, is not counted against it. A half-downloaded pack is
  reported as `missing`, with the missing paths named.
- **Release isolation.** The cache name carries a release identity, so a new release never
  reads an older cache.

---

## Contributing

Issues and pull requests are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and
the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as described
in [`SECURITY.md`](SECURITY.md). For the internal design, see
[`architecture.md`](architecture.md).

---

## License

SsPdfEditor
Copyright (C) 2026 isolmaz <info@isolmaz.com>

This program is free software: you can redistribute it and/or modify it under the terms of
the GNU Affero General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. It is distributed in the
hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [`LICENSE`](LICENSE) for the full
text.

The project must use AGPL-3.0-or-later because the distribution ships MuPDF, which is
licensed AGPL-3.0-or-later. It also ships Ghostscript (AGPL-3.0-only, through
`@bentopdf/gs-wasm`) for PDF/A conversion; the combined work is distributed under the
GNU Affero General Public License version 3. The editor's **Help → Source code (AGPL-3.0)** command links
to this repository, as section 13 of the licence requires.

### Bundled fonts

The fonts the app ships are fetched by `pnpm fetch:engines` from pinned npm packages, served from
the same origin and pinned by size and SHA-256 in `tools/asset-pins.json`. All are SIL Open Font
License 1.1 (the licence texts are copied to `dist/licenses/`):

- **Document text.** Noto Sans is embedded by stamps, headers and the OCR text layer. A scan exported
  to Word can also be set in Roboto, Open Sans, Montserrat, Inter, Source Sans 3, Poppins (sans),
  Merriweather, Noto Serif (serif) or Roboto Mono (mono). All ten are static TrueType in regular, italic, bold and bold italic.
  Each covers the Turkish letters. Lato was left out because
  its faces lack Ğ/ğ, İ and Ş/ş.
- **Interface and signatures:** Space Grotesk, DM Sans, Dancing Script and Great Vibes.
