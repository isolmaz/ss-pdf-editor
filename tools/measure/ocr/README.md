# OCR benchmark

Measures Tesseract, PP-OCRv5/v6 (PaddleOCR ONNX), OnnxTR and layout models in Chromium (Playwright, onnxruntime-web WASM,
4 threads). Results and conclusions: `docs/ocr-evaluation.md`. Nothing here touches `package.json`; dependencies and
models live in a temp workspace (`WORK`, see `lib.mjs`; default `%TEMP%/ocrbench`, or `OCRBENCH_DIR`).

```sh
node tools/measure/ocr/setup.mjs            # installs onnxruntime-web/mupdf/yaml into WORK, downloads + sha256-verifies models.json
node tools/measure/ocr/build-testset.mjs    # renders the synthetic pages + ground truth (WORK/testset); the CV is read from e2e/fixtures/local/ when it is there
node tools/measure/ocr/run.mjs --list       # configs
node tools/measure/ocr/run.mjs tess-tur+eng-best ppocrv5-mobile-latin ppocrv6-small onnxtr-dbmobile-parseq
node tools/measure/ocr/run.mjs ppocrv6-medium --images cv,s01,s02   # subset of images
node tools/measure/ocr/score.mjs            # WORK/results/summary.{json,md}: CER/WER, Turkish-letter recall, timings, size, threshold tables
node tools/measure/ocr/diff-words.mjs ppocrv5-mobile-latin cv       # word-level errors; audit the GT where all engines agree against it
```

What the scripts need that is not in the repository:

- **Fonts.** `build-testset.mjs` draws the synthetic pages in Noto Sans (from `public/fonts/noto/`, which `pnpm fetch:engines`
  fetches) and in eight more faces (Noto Serif, Noto Sans Bold, Liberation Sans, Liberation Sans Italic, Liberation Serif,
  DejaVu Sans, DejaVu Serif, Carlito). Point `OCRBENCH_FONTS` at a folder with those `.ttf` files (a LibreOffice install's
  `Fonts` folder has them), or put them in `WORK/fonts`; a missing file stops the script and names it.
- **The owner CV (local only).** The `cv` image (and its `.gt.txt` transcript) comes from
  the owner's PDF and `.gt.txt` in e2e/fixtures/local (named in `lib.mjs`). That folder is git-ignored: the CV is private owner data, never
  committed, never uploaded, and the CV rows of `docs/ocr-evaluation.md` cannot be reproduced without it. Without the files
  `build-testset.mjs` says so and skips the `cv` image; every other number (the 24 synthetic pages) is reproducible by anyone.
- **Layout pages.** The two synthetic layout pages (`lay1.png`, `lay2.png` in `WORK/testset/images/`) are drawn by a generator that is not part of the repository; the layout configs (`layout-*`) run `cv`, `lay1` and `lay2` and skip any that is missing.
  The layout-model table in `docs/ocr-evaluation.md` is a record of that run.
- **Priority.** On Windows run long jobs at below-normal priority (`start /belownormal`, or the Task Manager); children inherit it.

- `run.mjs` processes the CV first, three times (run 1 = cold incl. model load, runs 2–3 = warm), then every synthetic page once; each config
  runs in a fresh browser context. Layout configs (`layout-*`: PP-DocLayout plus-L/V3, YOLOv8n general6, DocLayout-YOLO) record regions instead of text, run the CV plus the two synthetic layout pages (`lay1`, `lay2`) and write annotated PNGs to `WORK/results/layout-*.png`.
- `models.json` pins every model by repo revision URL, byte size, sha256 and licence.
