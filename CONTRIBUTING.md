# Contributing

Thanks for your interest in SsPdfEditor. Issues and pull requests are welcome.

## Before you start

- Read [`README.md`](README.md) for what the editor does and how to run it, and
  [`architecture.md`](architecture.md) for the module boundaries and the write pipeline.
- For anything larger than a small fix, open an issue first so the approach can be agreed.
- Security problems go to [`SECURITY.md`](SECURITY.md), not to a public issue.

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

- A bug fix comes with a regression test that fails without the fix.
- A test must check behaviour, and must fail when that behaviour breaks.
- Update the affected documentation in the same commit.

## Licence

By contributing you agree that your contribution is licensed under the
AGPL-3.0-or-later, the licence of this repository (see [`LICENSE`](LICENSE)).
