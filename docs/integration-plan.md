# Integration plan: `test/coverage` → `main`, and how changes land from now on

Decisions taken with the owner (2026-10-08). Every step has an acceptance check a machine or a
second agent can verify; a step is done when its check holds, not when someone says so.

## How every change lands

1. Work happens on a branch; one pull request per change.
2. GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and every push to
   `main`: `verify` (typecheck, Biome, unit suite, model audit, docs sync, build, asset pins,
   licences, dist), the whole Playwright suite in four shards, the service-worker tests, and
   the signing/engine behaviour checks, and the PDF → Word fidelity test (`fidelity`). All of them are required checks on `main`.
3. A reviewer that did not write the change reads it and records PASS or FAIL on the pull
   request. Documentation (README, CONTRIBUTING, architecture, site TR/EN) is part of the
   review: a behaviour change that is not reflected there is a FAIL.
4. Merged with a merge commit (no squash, no rebase): each commit names one fix and its test.
5. A push to `main` deploys: `wrangler deploy` to the `pdf-editor` Worker
   (`pdf.isolmaz.com`), then a smoke check of the live site; a failed smoke check rolls the
   Worker back to the previous version.
6. Nightly (`.github/workflows/nightly.yml`): `pnpm coverage` with a floor of 98 % total
   lines, and the Playwright suite twice with no retries, failing on any flaky test.

## Integrating `test/coverage`

| # | Step | Acceptance |
|---|---|---|
| 1 | CI, nightly and deploy workflows; coverage floor; docs-sync check | Files in the branch; `pnpm check:docs` passes locally |
| 2 | Docs and site brought in line with the code | `pnpm check:docs` passes; README, CONTRIBUTING, architecture and every site page (TR/EN) describe the current behaviour |
| 3 | `REVIEW.md` (commits by risk) and the fail-before/pass-after proof | Every fix commit listed with the test that proves it; `revert-proof` shows each test failing on the fix's parent and passing on the fix |
| 4 | Draft pull request | Every CI job green on GitHub (Linux) |
| 5 | Independent review | Reviewer records PASS; every FAIL fixed by a new commit and re-reviewed |
| 6 | Merge | `pre-coverage` tag on the old `main`; merge commit; deploy job and live smoke check green |
| 7 | Protect `main` | Pull request required; required checks as in "How every change lands"; force-push and deletion blocked |
| 8 | Branch clean-up | Every local branch other than `main` is deleted only after its tip is kept: as a local `archive/<name>` tag and in a verified `git bundle` outside the work tree. History from before the public repository is not pushed to the public `origin`; the private `archive` remote (the previous repository) is left as it is |
| 9 | Final sync | On `main`: docs, site, code and CI agree; final report with the HEAD SHA, CI runs, coverage and live site status |

Rollback: `git` back to the `pre-coverage` tag for the code, `wrangler rollback` for the live
Worker.
