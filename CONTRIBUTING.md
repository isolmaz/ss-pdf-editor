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

Every change must pass the local gates; this repository runs no hosted CI:

```sh
pnpm typecheck
pnpm check                   # Biome lint and format (also run by the pre-commit hook)
pnpm unit                    # Vitest, the non-vacuity guard and the source-level regressions
pnpm build && pnpm assemble:dist
pnpm e2e                     # Playwright against the assembled dist/ (signing specs need openssl)
```

The OCR specs need two real documents that are not in the repository: put a scanned PDF
with no text layer at `e2e/fixtures/local/scanned.pdf` and a PDF that carries text at
`e2e/fixtures/local/text.pdf` (the folder is ignored). Without them those specs skip and
say why.

- A bug fix comes with a regression test that fails without the fix.
- A test must check behaviour, and must fail when that behaviour breaks.
- Update the affected documentation in the same commit.

## Adding a language

The interface ships in Turkish and English. To add a language:

1. Add a dictionary file under `packages/shared/src/i18n/` that exports a `Dictionary`
   (any subset of the keys in `tr.ts`; a missing key falls back, so a partial translation
   is usable).
2. Add one entry to `LOCALES` in `packages/shared/src/i18n/locales.ts`: its BCP 47 `id`,
   its own name, `dir` (`rtl` for Arabic, Hebrew, Persian, Urdu), `fallback: 'en'` and a
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
`pnpm fetch:engines` and pinned in `tools/asset-pins.json`, never committed.

A new dependency must carry a free licence; `pnpm check:licenses` audits every installed
package and fails on one that is neither free nor recognised.

## Licence

By contributing you agree that your contribution is licensed under the
AGPL-3.0-or-later, the licence of this repository (see [`LICENSE`](LICENSE)).
