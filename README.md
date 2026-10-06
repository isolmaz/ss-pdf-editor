# SsPdfEditor

A PDF editor that runs entirely in the browser. Documents are opened from the device,
edited in the tab and written back to the device — there is no server-side processing, no
account, no subscription and no telemetry. The deployed build is a static asset tree; the
only server involved is one that hands files back.

- **Product name:** SsPdfEditor
- **Published surface:** <https://pdf.isolmaz.com/> (landing) and `/editor/` (the app)
- **Licence:** AGPL-3.0-or-later (see [`LICENSE`](LICENSE))
- **Source:** <https://github.com/isolmaz/ss-pdf-editor> (the editor's Help menu links to it)
- **Security reports:** see [`SECURITY.md`](SECURITY.md); contributions: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Author:** isolmaz `<info@isolmaz.com>`

This file is the operator's view: what the product does, how to run it, and what its
limits are. The internal design — module boundaries, the write pipeline, the coordinate
spaces, the verification contract — is in [`architecture.md`](architecture.md).

---

## See it in action

Recorded from the built app with a sample document (`tools/spikes/readme-media.mjs`
regenerates every clip).

| | |
| --- | --- |
| **Open, navigate, zoom.** Pages, thumbnails and zoom; nothing is uploaded. <br> ![Opening a PDF and moving through its pages](docs/media/open-and-navigate.gif) | **Mark up.** Highlight text, draw shapes and freehand, add text; every mark is a real PDF annotation. <br> ![Highlighting, drawing and adding text](docs/media/annotate.gif) |
| **Organise pages.** Rotate a page from its thumbnail, drag pages into a new order, undo any step. <br> ![Rotating and reordering pages](docs/media/pages.gif) | **Fill and sign.** Type into form fields and sign with a PKCS#12 identity (PAdES B-B) with a visible stamp. <br> ![Filling a field and signing the document](docs/media/fill-and-sign.gif) |
| **Redact for real.** Marked content is removed from the file, then verified gone, not just covered. <br> ![Redacting a line of text](docs/media/redact.gif) | **Every tool, one keystroke away.** `Ctrl+K` finds any command; export to PDF, compressed PDF, images or text. <br> ![The command palette and the export dialog](docs/media/palette-and-export.gif) |

---

## Table of contents

1. [See it in action](#see-it-in-action)
2. [What it does](#what-it-does)
3. [Privacy and security posture](#privacy-and-security-posture)
4. [Document limits](#document-limits)
5. [Getting started](#getting-started)
6. [Command reference](#command-reference)
7. [Repository layout](#repository-layout)
8. [Quality gates](#quality-gates)
9. [Build, assemble, deploy](#build-assemble-deploy)
10. [Offline use](#offline-use)
11. [Honest limits and known gaps](#honest-limits-and-known-gaps)

---

## What it does

The editor is organised around three ideas: **read**, **edit**, **prove it worked**. Every
capability below is implemented in this repository and reachable from the UI (menu bar,
`Ctrl+K` command palette, the tool rail, docks or the home screen).

### Reading and navigation

- Continuous virtualised scrolling, text selection and search with match highlighting,
  driven by pdf.js's own viewer stack.
- Single-page, book and full-screen presentation modes; magnifier lens; a snapshot tool
  that composes visible pages into one PNG.
- Reading mode: the page as a text column, with read-aloud through locally installed
  speech voices only.
- Page thumbnails, outline and document tabs, plus an idle-time recent-files list (a recent
  entry reopens the document it names, matched by identity, never by file name).
- **The document never moves under the reader.** Marks, selection frames, measurements and
  staged redactions live inside the viewer's scroll content, so they scroll and zoom with the
  page. Arming a tool, an operation's progress and its notice never shift the page: the tool
  strip has a fixed height, and progress and notices float over the document. A narrowed
  window re-fits a "fit width" page. Until a document's first page has painted, the viewer
  shows that it is preparing the pages and keeps the marks hidden.
- **Password-protected files open.** The editor asks for the open password (a wrong one is
  refused on the spot) and opens the document read-only: it can be read, searched and
  printed. "Create unlocked copy" makes an unprotected copy in a new tab to edit; the
  original file stays protected. The password is held in memory for the session only.
- Keyboard shortcut help from the Help menu or `Ctrl+K` palette, available in Turkish
  and English even before opening a document. The list is the binding table itself, so a
  chord that is printed is a chord that runs — and the tool buttons carry no invented
  single-letter shortcuts.

### Annotating, forms, measuring

- Highlight (selected text or continuous freehand strokes), ink, notes, stamps, underline,
  strike-out, squiggly and geometric shapes.
- **Add text:** click on a page and type. The text is written into the file as a `/FreeText`
  annotation drawn with the embedded Noto Sans, so Turkish letters survive in every reader;
  on a rotated page the text stays upright the way it was typed. Its colour and size are
  its own, separate from the marker's style.
- **One armed tool at a time, every tool on the rail.** The rail beside the document shows
  every canvas tool — select, hand, edit text, add text, text markup, ink, shapes, note,
  link, measure, redact — and the rail, the menus, the `Ctrl+K` palette, the context menu and
  the keyboard all read and write the same value. The four text-markup looks (highlight,
  underline, strike-out, squiggly) share one rail button; the tool strip picks the look.
  Text selected before a markup tool is armed is marked at once — "select, right-click,
  Highlight" marks the selection — and "Redact" in the context menu turns the selection into
  staged redaction areas.
- **One selection surface for every mark on the page**: session annotations, measurements,
  staged redactions and annotations already in the file. Click a mark, drag a marquee or
  use `Ctrl+A`; then delete, rotate 90°, drag to move or nudge by 5 pt. Each edit is undoable.
  Saved links can be selected without being followed; the hand tool still follows them.
- The standalone eraser is removed. Selection deletes **whole marks**, never page text,
  images, form widgets or popup windows. Secure content removal remains redaction.
- Marker colour, opacity, thickness and author are controlled by the app. Multiply blending
  keeps text readable while drawing and after release; freehand strokes stay continuous
  on export. Pen and marker remain armed for the next stroke.
- The tool strip occupies its own fixed-height row above the canvas and opens with one
  sentence saying what the pointer does now. Selection shows delete, rotate, move and clear
  controls; the measure tool shows its scale, grid and snapping; redaction shows the staged
  area count and the explicit Apply; other tools show only properties they actually support.
- Pending-mark edits and undo/redo retain the page canvas. Byte rewrites retain the old
  painted view until the replacement paints, preserving page, zoom, scroll and form values.
- Page and view controls (previous/next, page number, zoom, fit width, rotate, page panel,
  reading mode, presentation) sit in the status bar, not over the page. "Rotate" and the
  context menu's page actions act on the pages selected in the page panel, or on the page on
  screen when none is selected.
- Below 1024 px both docks start collapsed and can be reopened as overlaid panels, so the
  canvas gets the width and the tools stay one click away; the rail buttons and the icons
  that need one carry a real tooltip (`role="tooltip"`), not a title attribute.
- **Every operation opens the same way:** in the tools panel beside the document, in two
  numbered steps — settings, then *Preview* runs the operation and shows its report, and
  the report's own button applies it (or opens / downloads the result). "Close" discards a
  result. Rarely changed settings sit in a closed "Advanced options" section; modal windows
  are kept for decisions that block (password, unsaved changes, signature warning, export
  choice, print, settings).
- **Settings** (the gear in the header, or `Ctrl+K` → Settings): language, theme, the simple
  or advanced interface mode (each described), the sensitive session, draft storage and
  cleanup, offline preparation and the shortcut list.
- **Save and Export are different.** *Save* writes over the file you opened (Chromium,
  opened through the file picker); for a document with no file behind it the same button
  reads *Save as…* and asks where to write. *Export* always downloads a copy and leaves the
  open file alone. A browser without the File System Access API (Firefox, Safari) offers
  Export only.
- Comments panel listing both session marks and annotations already in the file.
- Form filling with an AcroForm inventory; field creation, flags, flattening and simple
  calculations; form data import/export as FDF or JSON (an export downloads the data file and
  leaves the document alone).
- Measurement tools (distance, perimeter, area) with scale, unit, grid and snapping; the
  measurements are written into the file as real PDF annotations.

### Pages and structure

- Insert, delete, duplicate, reorder, rotate, extract, split, replace and merge — page
  composition goes through pdf.js `extractPages` so outlines, AcroForm fields and page
  labels travel with the pages.
- Page boxes (Media/Crop/Trim/Bleed/Art), including auto-crop from ink bounds.
- Page labels (roman/decimal/prefix styles), outline editing, link annotations with a URI
  allow-list, embedded file attachments.
- N-up / booklet / poster imposition and a duplex print-sheet builder.
- Compression in two modes: structural re-save, or image rasterisation with honest
  size reporting (growth is reported as growth, not as a gain).

### Text

- Text editing with block-local reflow in the original page (`pdf-text-engine`): pick a
  text block, retype it, and the tool erases the original glyph run and draws the
  replacement in the same box. The block boxes follow zoom, scroll and page rotation, and
  word boundaries come from the spaces the page reports as well as from glyph gaps (italic
  glyph boxes overlap across a space, which once glued a paragraph's words together). Editability is measured per block first, so a block that
  cannot be reproduced faithfully is marked **not editable** rather than silently damaged.
- Text export (plain text or Markdown) and image export/import (images → PDF, PDF → images).

### Redaction, security, signing

- **True redaction:** marks become MuPDF redaction annotations, `applyRedactions` removes
  the glyphs from the content stream, and the file is rewritten (`garbage=compact,
  compress,clean`). Nothing is painted over; the produced bytes are re-opened and checked
  glyph by glyph before they are handed back. An object-level audit then reports residual
  terms, earlier revisions and structural leftovers. A staged mark is drawn on the page and
  stays an **intent** until Apply is run explicitly — a save with marks still staged is
  refused rather than quietly dropping them through.
- AES-256 encryption and permission bits, with the output re-opened and verified
  afterwards. Security **downloads** the encrypted copy: a protected file is read-only in the
  editor, so it is never applied to the document being edited.
- PAdES B-B signing from a PKCS#12 identity, with a four-part verdict (integrity, trust,
  revocation, coverage) and verification against certificates the user imported.

### OCR, accessibility, comparison, batch

- OCR (Turkish and English) that writes an invisible, selectable text layer with a real
  `/ToUnicode` map; scanned pages can be detected first, and pages that already carry text
  are skipped by default.
- Accessibility: a facts-only check (no score, no conformance claim), a real tagged-PDF
  writer that splices marked content into the page streams and verifies the result, and
  `/Alt` + `/TU` writers for image and field descriptions.
- Document comparison, text-level and pixel-level, with the method always named.
- Batch processing of many files against one ordered rule set, with per-item reporting.

---

## Privacy and security posture

These are properties of the build, not promises:

- **No document bytes leave the device.** Files are read with the File System Access API
  (or a file input), processed in the tab, and written back with a save picker or a
  download. There is no upload path and no server API — the deployed Worker serves static
  files only.
- **No third-party requests.** Every engine (pdf.js, MuPDF, Tesseract, fonts) is served
  from this origin under `/engines/**` and `/fonts/**`, pinned by SHA-256 in
  [`tools/asset-pins.json`](tools/asset-pins.json). Tesseract's worker, core and language
  paths are passed explicitly precisely so its CDN defaults are never used. The
  `Content-Security-Policy` in [`public/_headers`](public/_headers) sets
  `connect-src 'self'`, so a stray network call is a policy violation, not just a bug.
- **A strict CSP in production, from one source of truth.** [`public/_headers`](public/_headers)
  carries `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'` (no
  `'unsafe-inline'`, no `'unsafe-eval'`), `style-src 'self' 'unsafe-inline'` — the one
  relaxation, and it is for styles only: the overlays position marks with a computed inline
  `style` attribute — plus `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` and
  `frame-ancestors 'none'`. The same file drives the Vite dev server and the local
  preview server, so development runs under the production policy rather than a relaxed
  substitute (the dev server appends `'unsafe-inline'` to `script-src` alone, for the React
  refresh preamble, and says so in its log). Every response also carries `nosniff`,
  `Referrer-Policy: no-referrer`, a deny-all `Permissions-Policy` and
  `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, so other hosts on
  the domain are unaffected).
- **Cross-origin isolation is declared, not assumed.** `/editor/*` gets
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
  from the header file; the Playwright suite drives the built distribution under exactly
  those headers.
- **The service worker caches static assets only.** It refuses non-`GET` requests and
  anything outside `/editor/`, `/engines/`, `/fonts/` and a few root files. Document bytes
  are never written to `CacheStorage`.
- **Drafts are local and scoped.** Unsaved work is persisted in the origin-private file
  system (OPFS). A **sensitive session** (any document opened with a password) opts out of
  persistence entirely, and vault cleanup refuses to delete anything when the reference
  inventory cannot be read completely — orphan bytes cost space, deleted live bytes cost a
  document.
- **Deleting a draft is logical, not forensic.** Removing entries from OPFS does not
  overwrite the underlying bytes, and it cannot reach a copy the user downloaded. The UI
  does not describe it as secure erasure.

---

## Document limits

Two tiers, defined once in [`packages/shared/src/limits.ts`](packages/shared/src/limits.ts):

| | Desktop | Mobile |
|---|---|---|
| Warn above | 1 500 pages | — |
| Hard ceiling | 2 000 pages / 300 MB | 2 000 pages / 300 MB |
| Viewing-only above | — | 300 pages / 64 MB |
| Render cache | 512 MB | 128 MB |

Above the viewing-only threshold the document still opens and renders, but editing is
disabled and the UI says why. Build budgets live beside them: ≤ 250 KiB gzip for the
first-paint JavaScript, ≤ 60 KiB for the landing page, ≤ 25 MiB per asset.

Undo history is bounded by a snapshot budget of `max(3 × file size, 64 MB)` with at least
the two newest versions always kept. A step whose bytes have been evicted is reported as
**unavailable** in the history panel rather than replayed onto the wrong base.

---

## Getting started

Requirements: **Node ≥ 26** and **pnpm 9.15.9** (both pinned — `.nvmrc`, `packageManager`).

```bash
pnpm install --frozen-lockfile
pnpm fetch:engines --sync   # copies the pinned engine binaries into public/engines + public/fonts
pnpm dev                    # editor at http://localhost:5173
```

`pnpm fetch:engines` is not optional on a fresh clone: engine binaries are never committed
([`tools/hooks/guard.mjs`](tools/hooks/guard.mjs) blocks them), and it copies them out of
the local pnpm store — **nothing is downloaded from a CDN**.

Other dev servers: `pnpm --filter site dev` (landing, port 5175) and `pnpm dev:spikes`
(throwaway prototype harness, port 5174, cross-origin isolated).

---

## Command reference

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server for the editor |
| `pnpm build` | Builds the landing (`apps/site/dist`) then the editor (`apps/web/dist`) |
| `pnpm assemble:dist` | Composes the deployable `dist/` from the two builds, `public/`, the pinned engines, generated offline manifest, notices and licence texts |
| `pnpm preview` | Serves the assembled `dist/` under the production header policy (port 4178) |
| `pnpm typecheck` | `tsc -b` over the whole workspace |
| `pnpm lint` / `pnpm check` / `pnpm format` | Biome lint / lint+format check / format write |
| `pnpm unit` | Vitest, then the non-vacuity guard, then the source-level regressions |
| `pnpm e2e` | Playwright against the **assembled** `dist/` (Chromium); build first with `pnpm build && pnpm assemble:dist`. `e2e/flows-document.spec.ts`, `e2e/flows-pages.spec.ts`, `e2e/flows-modes.spec.ts` and `e2e/flows-commands.spec.ts` hold the editor flow tests (the last needs the `openssl` command line, which makes the signing identity) |
| `pnpm measure:model` | Journal/snapshot measurement run (not a gate) |
| `pnpm fetch:engines [--sync\|--update]` | Copies engine binaries from the pnpm store and verifies/rewrites the pin table |
| `pnpm verify:assets` | Re-hashes every pinned file and fails on any difference |
| `pnpm check:licenses` | Dependency licence audit |
| `pnpm audit:regressions` | The source-level regression harness on its own |
| `pnpm audit:model-types` | Strict re-typecheck of the DOM-free modules |
| `pnpm ci:verify` | The full repository gate (see below) |
| `pnpm ci:full` | `ci:verify` plus the three browser/behaviour harnesses |
| `pnpm worker:deploy[:dry]` | `assemble:dist` then `wrangler deploy` (pinned 4.135.0) |

---

## Repository layout

```
apps/
  web/          the editor PWA (Vite base /editor/) — the shell, its state and its paths
  site/         the landing and legal pages (static HTML, six pages, TR + EN)
packages/
  shared/       error contract, limits, i18n catalogue (tr complete, en mirror)
  model/        session store, operation journal, drafts, vault policy, save router
  core/         engine adapters (pdf.js, MuPDF, Tesseract) and every operation
  text-engine/  text model, editability measurement, block-local reflow, font catalogue
  ui/           React surfaces: viewer, docks, panels, dialogs, overlays, mark tools, printing
public/         _headers, sw.js, theme boot, 404, manifest, robots/sitemap, engines, fonts
tools/
  assemble-dist.mjs   build the deployable dist/
  fetch-engines.mjs   copy + pin engine binaries (also hosts the verify implementation)
  check-licenses.mjs  licence audit
  audit/              regression harness, non-vacuity gate, model typecheck
  vite/hosting.mjs    parses public/_headers for dev + preview
  preview-dist.mjs    production-policy static server
  hooks/guard.mjs     pre-commit / pre-push tree guard (+ biome check on staged files)
  spikes/             throwaway prototypes and browser harnesses (nothing here ships);
                      mupdf-fixture.mjs builds and reads their PDFs on MuPDF;
                      readme-media.mjs records the README clips into docs/media/
docs/media/     the README's feature clips (GIF)
e2e/            Playwright specs: shell and shortcut help, document, tool marks and the
                selection editing, editor stability (scroll, layout, rotate, typed text,
                protected files), offline, two windows, OCR; the editor flows
                (`flows-document`, `flows-pages`, `flows-modes` for modes and signing,
                `flows-commands` for the other menu-bar commands); and the marketing site
                (`site.spec.ts`: link/anchor/language/SEO integrity, language switch,
                CTA, 404, theme boot, CSP-clean resources, phone layout)
```

---

## Quality gates

`pnpm ci:verify` runs, in order: `install --frozen-lockfile` → `typecheck` → `check` (lint + format) →
`unit` → `audit:model-types` → `build` → `fetch:engines --sync` → `verify:assets` →
`check:licenses` → `assemble:dist`.

`pnpm ci:full` adds `ci:behavior`: two browser harnesses and a signing harness:

- `tools/spikes/phase3-check.mjs` — the Phase 3 acceptance sentence end to end
  (open → search → highlight → comment → fill a form → delete 2 pages, add 1 →
  header/footer → save → reopen) against the assembled distribution.
- `tools/spikes/phase4-check.mjs` — a text-edit round trip that re-reads the produced
  bytes.
- `tools/spikes/sign-check.mts` — signing with an OpenSSL identity through the product's
  own import/sign/verify path, including a one-byte tamper case that must break the
  verdict.

The browser harnesses exercise the default simple mode and switch through the UI before
advanced operations. Missing Chromium fails with installation instructions. To target an
already-running server, set `VERIFY_ORIGIN` explicitly; the harnesses do not silently reuse it.

`pnpm unit` is a gate, not a report: after Vitest it runs
[`tools/audit/require-tests.mjs`](tools/audit/require-tests.mjs) (an empty run fails) and
[`tools/audit/regressions.cjs`](tools/audit/regressions.cjs) — browser-free checks over the
real sources, including save-path semantics, draft validation, service-worker behaviour and
vault garbage collection. It prints how many checks it ran; read that number.

The gates are local and they are the whole gate — the repository has no GitHub Actions
workflow: `pnpm ci:verify`, then `pnpm ci:full` when
a change touches an engine path, both before committing. Publisher of record is Cloudflare:
the build pipeline validates the same command (`pnpm ci:verify`) and its configured deploy
command runs `pnpm run worker:deploy` — the same one available by hand — so a push is the
point at which a change becomes live, and the deployed surface is verified after it.

A save is verified rather than assumed, and the app says so before it offers one: Save and
Export stay disabled until the inspection that describes the **current** version has
answered, and a write then compares the produced bytes with the document on screen over
twelve declared facts. A fact this build cannot check is reported `unverified` or
`degraded` — never folded into a blanket "verified", and a fact that broke when the
operation had not declared it throws instead of writing.

---

## Build, assemble, deploy

`pnpm assemble:dist` produces exactly what is uploaded:

| Source | Lands at |
|---|---|
| `apps/site/dist` | `dist/` root (landing at `/`, legal pages, `/en/`) |
| `apps/web/dist` | `dist/editor/` |
| `public/` | `dist/` root (`_headers`, `sw.js`, `404.html`, `robots.txt`, `sitemap.xml`, `manifest.webmanifest`, `theme-boot.js`, `engines/**`, `fonts/**`) |

It also writes `dist/offline-manifest.json`, stamps `dist/sw.js` (a missing
`__CACHE_VERSION__` placeholder is a hard failure — the build refuses to ship an
unversioned worker), and copies `LICENSE` together with the bundled licence texts into
`dist/licenses/`. `LICENSE` is the one required root file: a missing one aborts the
assemble step. Missing licence texts from the installed packages are a hard failure too —
every third-party obligation the distribution carries travels as those texts, indexed by
`dist/licenses/INDEX.json`. The step also reads the editor's source maps and fails when
a bundled npm package has no licence entry.

Deployment is a Cloudflare Worker that serves `dist/` as static assets
([`wrangler.jsonc`](wrangler.jsonc)) — no Functions, no SSR, no database, and the request
path never executes application JavaScript. `compatibility_date` is pinned,
`/gizlilik` and `/kosullar` resolve without the extension, and unknown paths get the
styled Turkish 404 page. The assembled `dist/_headers` travels with the upload, so the CSP
and the `/editor/*` COOP/COEP pair are enforced by the host rather than by a dashboard
setting.

```bash
pnpm build && pnpm assemble:dist
pnpm worker:deploy          # npx --yes wrangler@4.135.0 deploy
pnpm worker:deploy:dry      # same, --dry-run
```

Cloudflare's build pipeline runs the validation command against the pushed commit and then
the deploy command above; the same deploy is available by hand. Either way the live surface
— <https://pdf.isolmaz.com/> and `/editor/` — is checked after the push: the changed path is
exercised against the deployed build, and a failure there is reported as a failure rather
than assumed away because the local gate was green.

---

## Offline use

`public/sw.js` is scoped to `/editor/` and caches static assets only. Capability
readiness is a **set-containment** test over the exact paths each engine fetches
([`apps/web/src/offline-packages.json`](apps/web/src/offline-packages.json)): a
half-downloaded language pack reports `missing` with the absent paths named, rather than
"ready". The cache name carries a release identity derived from the pin table, so an
immutable-cached engine can never be served under a different shell build; a new release
never reads the previous release's cache.

Precaching happens only when the user asks for it (Settings → Offline use, or the offline
commands in the palette), and an interrupted preparation is reported with the paths that
failed. It fetches what core editing needs: the shell, pdf.js, MuPDF (every writer runs on
it) and the fonts. The OCR engine and its
language data are not part of it.

---

## Honest limits and known gaps

**Signing.** PAdES B-B only: a detached CMS signature, no RFC 3161 timestamp, and **no
revocation checking** — the revocation field is always `indeterminate` because there is
no network to consult an OCSP responder or CRL, by design. Trust comes only from
certificates the user imported; an empty trust store reports `not-checked`, never
`untrusted`. Certificate chain validation does not implement RFC 5280 policy processing.
Signing supports RSA PKCS#1 v1.5 and ECDSA (P-256/384/521) with SHA-256/384/512 from a
PKCS#12 container.

**Accessibility.** The check reports facts, not a score, and makes no PDF/UA conformance
claim. It does not evaluate reading order, tables, lists, contrast, font embedding or
whether an alt text is any good — and `unchecked` is a real state, not a pass. Tagging a
document that already has a structure tree is refused rather than merged.

**Redaction audit.** The post-redaction audit scans raw bytes, so it cannot see inside
deflated streams or object streams. It says so, and it suppresses the orphan-object
verdict entirely when object streams are present instead of implying a clean file.

**Deleting marks.** Selection deletes annotations, not page content: text
and images inside a page's content stream are not annotations, so removing them is
redaction's job. A removal rewrites the document (the incremental fast path ends there) and
is undoable like any other operation — and it is not a forensic scrub, because the bytes the
user opened remain wherever they came from.

**Typed text.** Each save that adds typed text embeds the full Noto Sans program (about
630 KB) once for that write (MuPDF's `addFont`, Identity-H with a `/ToUnicode` CMap); the
face is not subset. A reader that regenerates a `/FreeText` appearance from `/DA`
instead of drawing its `/AP` falls back to Helvetica. `/Contents` carries the session
marker ahead of the text, the same identity convention every mark this app writes uses.

**Protected documents.** A password-protected file opens read-only. Every writer re-opens
the bytes it edits, and rewriting a protected file would mean silently dropping or
re-applying its protection, so editing starts from an explicit unlocked copy.

**Text editing.** Only horizontal text in a shipped font is editable. Vertical or reversed
lines, skewed baselines and Type3 text are marked not editable; a base-14 or unknown
embedded font is editable but re-rendered in a substitute face, and the UI says which.

**Versioned drafts.** Drafts carry a schema version. A draft written by an older schema is
skipped by the restore path rather than misread — and a malformed journal makes the whole
draft unreadable on purpose, because silently dropping one entry would shift every later
state.

**Missing design-phase documents.** Comments throughout the code cite `PLAN.md`,
`AGENTS.md`, `REPORT.md` and `WORKLOG.md` (items such as `K9`, `K12`, `K17`, `R06`,
`F11`). Those documents are **not** part of this tree, so those identifiers cannot be
resolved from the repository; the comments that carry them are self-contained, but the
numbering has no local index. `architecture.md` records the design rules they describe in
prose rather than by number.
