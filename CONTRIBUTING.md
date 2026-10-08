# Contributing

Thanks for your interest in SsPdfEditor. Issues and pull requests are welcome.

## Before you start

- Read [`README.md`](README.md) for what the editor does and how to run it, and
  [`architecture.md`](architecture.md) for the module boundaries and the write pipeline.
- For anything larger than a small fix, open an issue first so the approach can be agreed.
- Security problems go to [`SECURITY.md`](SECURITY.md), not to a public issue.
- Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

Requirements: Node 26 (see `.nvmrc`) and pnpm 9.

```sh
pnpm install
pnpm dev                     # the editor on a local dev server
```

## Checks

Every change must pass the local gates. `pnpm ci:verify` runs on your machine the checks of the
`verify` job in CI except its final `wrangler deploy --dry-run` (`pnpm worker:deploy:dry`); the individual commands are:

```sh
pnpm typecheck
pnpm check                   # Biome lint and format (also run by the pre-commit hook)
pnpm check:docs              # the file paths, pnpm scripts and commands the docs name must exist
pnpm fetch:engines --sync     # once per fresh clone: the unit tests read the fetched fonts
pnpm unit                    # Vitest, the non-vacuity guard and the source-level regressions
pnpm build && pnpm assemble:dist
pnpm e2e                     # Playwright against the assembled dist/ (signing specs need openssl)
pnpm ci:behavior             # the behaviour checks in tools/spikes/ (needs openssl)
```

`pnpm check:docs` (`tools/audit/docs-sync.mjs`) reads the documentation and fails when a file
path, a `pnpm` script or a command it names does not exist. When you rename a file or a script,
update the docs that name it in the same commit.

### Continuous integration

GitHub Actions runs `.github/workflows/ci.yml` on every pull request, on every push to `main`
and on manual dispatch:

- **`verify`** installs with the frozen lockfile and runs `pnpm typecheck`, `pnpm check`,
  `pnpm check:docs`, `pnpm fetch:engines --sync`, `pnpm unit`, `pnpm audit:model-types`,
  `pnpm build`, `pnpm verify:assets`, `pnpm check:licenses`, `pnpm assemble:dist` and
  `wrangler deploy --dry-run`.
- **`e2e`** (after `verify`) runs the Playwright suite in four shards. Each shard builds
  `dist/` itself, installs Playwright Chromium (cached) and runs
  `playwright test --project=chromium --shard=N/4` with `E2E_WORKERS=2`. The HTML report and
  the traces of a failed shard are uploaded and kept for 7 days.
- **`e2e-service-worker`** (after `e2e`) runs `playwright test --project=service-worker
  --no-deps`.
- **`behavior`** (after `verify`) runs `pnpm ci:behavior`.
- **`fidelity`** (after `verify`) runs `pnpm fidelity`, the PDF → Word export accuracy test (below),
  with a LibreOffice installed from the official `.deb` tarball pinned by version and sha256. It
  gates `deploy` like the jobs above (a `null` threshold is measured, not gated); the report goes
  to the job summary and the `fidelity` artifact.
- **`deploy`** runs only on a push to `main`, after every job above has passed: `wrangler deploy`
  with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, then
  `tools/deploy/smoke.mjs` against `https://pdf.isolmaz.com`. If the smoke check fails or
  runs past its time limit, the job runs `wrangler rollback` to the previous version and fails.
  Deploys run one at a time and a running one is never cancelled; a commit that is no longer
  `main`'s head when its deploy starts deploys nothing, so a late older run cannot replace a
  newer build.

`.github/workflows/nightly.yml` runs daily and on manual dispatch. It runs `pnpm coverage
--min-lines=98`, which fails when total line coverage is under 98 % and uploads the report, and
the Playwright suite in four shards with `--repeat-each=2 --retries=0 --fail-on-flaky-tests`, so
a flaky test fails the night.

`.github/workflows/revert-proof.yml` runs on manual dispatch and on a pull request labelled
`revert-proof`. For every fix on the list that `tools/review/revert-proof.mjs` reads, the fix's
own test must fail on the fix commit's parent and pass on the fix commit.

Branch `main` is protected: a pull request is required, `verify`, `e2e` (all four shards),
`e2e-service-worker`, `behavior` and `fidelity` must pass, and force-pushes are blocked. Pull requests are
merged with a merge commit, never squashed or rebased, so each commit keeps naming one fix and
its test. A reviewer who did not write the change records PASS or FAIL on the pull request, and
documentation that does not describe a behaviour change is a FAIL. [`REVIEW.md`](REVIEW.md), the
review guide of pull request #28, lists its commits by risk, each fix with the test that
proves it, and is the model for a large pull request's guide; how changes land is in
[`docs/integration-plan.md`](docs/integration-plan.md).

### Tests and coverage

`pnpm coverage` measures what the two suites execute together, on the sources under
`packages/*/src` and `apps/*/src`: the unit suite under V8 coverage, then the whole Playwright
suite against an unminified build of the editor, mapped back to the sources through the
build's source maps and added to the unit figures statement by statement
(`tools/coverage/report.mjs`). It prints a table per package and writes the report to
`coverage/report/` (`html/index.html`); it rebuilds the production `dist/` before it exits.
`pnpm coverage --skip-e2e` reports the unit suite alone, and `pnpm coverage --min-lines=98` exits
with an error when the total line coverage is under 98 % (the nightly run does this). On a machine
you are working on, `E2E_WORKERS=4` caps the browsers Playwright runs at once and
`VITEST_MAX_WORKERS=8` the unit workers; both apply to `pnpm e2e`, `pnpm unit` and
`pnpm coverage`. Playwright serves `dist/` on port 4178 and, outside CI, reuses a server already
listening there; when two checkouts run their suites at once, give each its own `E2E_PORT` so
neither tests the other's build. Code that runs in a web worker (Ghostscript) or in the service worker is not
recorded by a page, so it is not in the browser figures.

The OCR specs generate their own inputs (a scan rendered from known printed lines, and a text PDF),
so they run on a clean checkout.

Every spec imports `test` and `expect` from `e2e/test.ts`, not from `playwright/test`: its automatic
fixture fails a test when any page of its browser context (a second window, the print window too)
logged a console error or threw an uncaught exception. A test that provokes an error on purpose
names it with `test.use({ allowedErrors: [/…/] })`.

`pnpm fidelity` measures how faithful "Export to Word" is (`e2e/fidelity/`). Each sample × export
mode opens the PDF in the app, exports the DOCX through the dialog, converts it back to PDF with
LibreOffice (`LIBREOFFICE=/path/to/soffice`, else `soffice` on the PATH), renders both PDFs with
MuPDF and compares them: SSIM at 100 dpi (rendered at 200 dpi and
averaged) per page, word accuracy per document. It needs the
assembled `dist/` like `pnpm e2e`, and it is its own Playwright project, present only when
`FIDELITY` is set, so `pnpm e2e` and `pnpm coverage` never run it. The results are
`test-results/fidelity/` (the DOCX and PDF of each run, `report.json`, `report.md`). The comparison
functions have unit tests (`e2e/fidelity/compare.test.ts`, run by `pnpm unit`). Details:

- **Samples.** `e2e/fidelity/samples.ts` generates the repository's own pages in code, all Turkish
  text in embedded Noto Sans: `cv`, `columns`, `table`, `form`, `cards`, `text-over-image` and the
  scans `cv-scan` and `cards-scan`; and, from `samples-graphics.ts`, the graphics-heavy pages
  `shapes` (geometry and a flow diagram), `chart` (pie, bar and line charts), `text-in-image`
  (vector text plus two pictures that contain text), `overlay` (photo with a 50 % band, gradient
  header, soft-masked emblem, translucent text and panels), `rotated` (text at 45°, 90° and 270°, a
  stamp), `mixed-page` (vector heading above a scanned typed paragraph), `slide` (16:9) and
  `invoice`. Their scans are `shapes-scan`, `invoice-scan` (200 dpi) and `invoice-scan-rough`
  (150 dpi, skewed 2.5°, noisy, unevenly lit). The text that exists only as pixels in a picture
  (`text-in-image`, `mixed-page`) is the sample's `imageText`; the report's "Text inside pictures"
  table counts how many of its words the conversion holds as text (none is expected without OCR).
- **Modes.** The spec's `MODES` table has one entry per way of exporting, each picking its radio
  buttons in the dialog: `flow` (Flowing text), `page-images` (One picture per page) and `layout`
  (Text and pictures, exact layout). A new Word layout is one more entry, plus its keys in
  `thresholds.json`. A sample that is image-only is judged against its ground truth (the text of the
  page it was made from), not against its own words, so the OCR path of `layout` is measured the same way.
- **Filters** (comma-separated, set before `pnpm fidelity`; the list is at the top of
  `e2e/fidelity/fidelity.spec.ts`): `FIDELITY_MODES=layout` runs one mode; `FIDELITY_SAMPLES=cv,form`
  runs the samples whose id contains one of those words; `FIDELITY_ORIGINS=generated,public` drops
  the local ones. Arguments after `pnpm fidelity` go to Playwright (`pnpm fidelity --workers=1`).
  `E2E_WORKERS` caps the browsers.
- **Two worktrees at once.** Playwright serves `dist/` on port 4178; give each checkout its own
  `E2E_PORT` (`E2E_PORT=4179 pnpm fidelity`) so neither measures the other's build, and run each
  checkout's own `pnpm build && pnpm assemble:dist` first.
- **LibreOffice.** `LIBREOFFICE` is the path to `soffice` (`soffice.exe` on Windows). CI uses 26.2.6;
  another version can move the numbers, so compare runs made with the same one. The conversion
  to PDF turns comment export off (`ExportNotes`), so the comments that mark low-confidence OCR words
  do not appear on the rendered page.
- **Thresholds.** `e2e/fidelity/thresholds.json` maps mode → `default` and per-sample overrides to
  `{ ssim, words }`. SSIM gates the worst page, word accuracy the whole document. `null` means
  measured, not gated: a run reports such a number without failing. `page-images` gates SSIM 0.95
  for every sample; `layout` gates SSIM 0.95 and words 0.99 for each committed sample that reaches
  them (every generated page but `overlay`, whose SSIM is 0.93, gates its own SSIM at 0.91), a floor
  just under the measured value for the two that do not yet (`irs-fw4-2022`, `usgs-fs2020-3042`),
  and measured floors for the scans read by OCR (`cv-scan`, `cards-scan`, `shapes-scan`,
  `invoice-scan`, `invoice-scan-rough`, `nasa-tm-vacuum-1965`); `flow` gates words only, for the
  graphics samples 0.05 under the measured value (none for their scans, which flow does not read).
  The text inside pictures (below) is measured, never gated. A sample's own key, even `null`, wins over the
  mode's `default`. To gate a number, set it a little
  under the lowest value measured on CI's LibreOffice, and say in the commit what it is.
- **Local samples.** Every `*.pdf` in the folder e2e/fixtures/local (git-ignored, so absent from a fresh clone: the files are the
  owner's and never leave the machine) is a sample of origin `local`; a sibling `<name>.gt.txt` is its
  ground truth, pages separated by a form feed or a line holding only `\f`. A PDF without any text is
  treated as a scan. Without that folder the run has only the generated samples and the
  redistributable ones in `e2e/fidelity/corpus.json`; the owner's CV and its transcript are not in
  the repository, so the numbers measured on them cannot be reproduced by anyone else.
- **OCR evaluation tools.** `tools/measure/ocr/` benchmarks Tesseract against PaddleOCR and OnnxTR
  engines and layout models in Chromium, on 24 synthetic Turkish pages and, when present, the
  local CV; `docs/ocr-evaluation.md` has the results (why Tesseract with Turkish + English is the
  shipped engine, and why words under 90 % confidence are flagged). `tools/measure/ocr/README.md`
  lists the commands (`setup.mjs`, `build-testset.mjs`, `run.mjs`, `score.mjs`, `diff-words.mjs`);
  they install their own dependencies into a temp folder and never touch `package.json`. They are
  run by hand, not by CI. To measure what the exact layout does with a scan end to end, use `pnpm
  fidelity` with `FIDELITY_MODES=layout` on the scan samples (`cv-scan`, `cards-scan`, `invoice-scan-rough`, or a local one);
  to change the engine or the threshold, rerun the benchmark and update `docs/ocr-evaluation.md` in
  the same commit.

A test that installs, updates or reloads through the service worker is tagged `@service-worker`
(`test('…', { tag: '@service-worker' }, …)`): those run in their own Playwright project once the rest
of the suite has passed, because their timing depends on an idle machine. To run one of them alone,
add `--no-deps` (`pnpm e2e e2e/offline.spec.ts --no-deps`); without it the whole suite runs first.

- A bug fix comes with a regression test that fails without the fix.
- A test must check behaviour, and must fail when that behaviour breaks.
- A guard against a misbehaving engine or a hostile file stays even when no real file reaches
  it, and is tested by fault injection: a `*.faults.test.ts` next to the operation wraps
  `loadMupdf` in a proxy that makes the engine misbehave at the step under test (see
  `packages/pdf-core/src/ops/structure.faults.test.ts`). In the browser, `e2e/engine-faults.ts`
  does the same for the running app: it serves MuPDF through a wrapper and wraps pdf.js's
  worker, so a spec can make one named engine call fail, or hold it to stage a race, and
  assert what the user sees and that the file is unchanged. Code that nothing can reach is
  deleted instead; coverage-ignore comments are not used.
- Update the affected documentation in the same commit.

## Adding a language

The interface ships in Turkish and English. To add a language:

1. Add a dictionary file under `packages/shared/src/i18n/` that exports a `Dictionary`
   (any subset of the keys in `tr.ts`; a missing key falls back, so a partial translation
   is usable).
2. Add one entry to `LOCALES` in `packages/shared/src/i18n/locales.ts`: its BCP 47 `id`,
   its own name (`nativeName`), its English name (`englishName`), `dir` (`rtl` for Arabic, Hebrew, Persian, Urdu), `fallback: 'en'` and a
   `load` that imports the file, so the dictionary is downloaded only when the language is
   chosen.

The language picker lists it, the browser's language selects it on a first visit, and
dates and numbers are formatted with its `id`.

A right-to-left language mirrors the interface through `<html dir>`, so interface code
uses logical classes (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `border-s`/`border-e`,
`rounded-s`/`rounded-e`, `text-start`/`text-end`) and `inset-inline-*` /
`margin-inline-*` in CSS. A previous/next or collapse arrow takes `rtl:-scale-x-100`, and
a measurement (`82.4 MB / 512.0 MB`) sits in `dir="ltr"`. Physical `left`/`right` stay
only where a position comes from the page or the pointer: the layers drawn over a PDF
page, the camera picture and the magnifier lens.

## Repository hygiene

`pnpm install` installs the git hooks: its `prepare` script runs `tools/hooks/install.mjs`,
which sets `core.hooksPath` to `.githooks`. Both hooks run `tools/hooks/guard.mjs`.

The pre-commit hook checks the staged files. It refuses engine builds, traineddata, wasm
and font binaries, private keys and env files, then runs `biome check --staged`. The
pre-push hook checks every tracked file against the same rules and also refuses any file
over 5 MiB; the size limit is not checked on commit. Engines and fonts are fetched by
`pnpm fetch:engines` and pinned in `tools/asset-pins.json`, never committed. A new font
family is an `@expo-google-fonts/<family>` package pinned to an exact version, a row in
`tools/fetch-engines.mjs`, its licence texts in `tools/assemble-dist.mjs`, and an entry in
`packages/pdf-core/src/ops/ocr-font-catalog.ts`; its regular face must spell `ğĞıİşŞçÇöÖüÜ`.
Only SIL OFL-1.1 or Apache-2.0 fonts are accepted.

A new dependency must carry a free licence; `pnpm check:licenses` audits every installed
package and fails on one that is neither free nor recognised.

## Licence

By contributing you agree that your contribution is licensed under the
AGPL-3.0-or-later, the licence of this repository (see [`LICENSE`](LICENSE)).
