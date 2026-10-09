# OCR engine evaluation (local, in-browser)

Question: should SsPdfEditor keep Tesseract (tesseract.js 6.0.1 / core 6.1.2, tur+eng) or move to, or add, a
PaddleOCR / OnnxTR pipeline running on onnxruntime-web? All engines were run fully locally in Chromium
(Playwright), WASM execution provider, 4 threads, below-normal process priority, no network at inference time.
Reproduce with `tools/measure/ocr/README.md`.

The "CV" columns and rows are measured on the owner's own résumé (a PDF in the git-ignored folder e2e/fixtures/local and its
transcript `.gt.txt`). Those files are private, git-ignored and not in the repository, so the CV numbers below are a record
that others cannot rerun; everything marked synthetic (24 generated Turkish pages) is reproducible with the tools in
`tools/measure/ocr/`. The one-off scripts that drew the two layout test pages (`lay1`, `lay2`) and the classical
connected-component baseline (`genlayout.mjs`, `classical.mjs`) were not kept in the repository either; their results are
recorded here.

## Result

**Keep Tesseract (`tesseract.js` 6.0.1 + `tesseract.js-core` 6.1.2 simd-lstm, `tur`+`eng` best_int traineddata) as the
only engine. No candidate beat it on Turkish text, on the owner's CV, or on speed. Do not add a second engine now.**

| config | CER synthetic | CER CV | Turkish-letter recall | WER (all) | cold ms (CV page, incl. load) | warm ms/page (CV page) | download MB (gzip) | licence (code + weights) |
|---|---|---|---|---|---|---|---|---|
| **tess tur+eng best_int** (shipped) | 0.03% | **0.27%** | 99.9% | **0.6%** | 7100 | 7097 | **7.7** | Apache-2.0 / Apache-2.0 |
| tess tur+eng fast | 0.03% | 0.29% | 99.9% | 0.6% | 7422 | 6824 | 21.6 | Apache-2.0 / Apache-2.0 |
| tess tur best_int | 0.04% | 0.43% | 100.0% | 1.0% | 5790 | 5760 | 4.7 | Apache-2.0 / Apache-2.0 |
| tess tur fast | 0.04% | 0.44% | 100.0% | 1.0% | 5974 | 5634 | 10.6 | Apache-2.0 / Apache-2.0 |
| PP-OCRv5 mobile det + v5 latin mobile rec | 0.18% | 0.75% | 99.4% | 1.7% | 9583 | 9093 | 15.6 | Apache-2.0 / Apache-2.0 |
| PP-OCRv6 small det + small rec | 0.74% | 0.34% | 95.4% | 5.1% | 14915 | 13714 | 29.7 | Apache-2.0 / Apache-2.0 |
| PP-OCRv6 tiny det + small rec | 0.72% | 0.29% | 95.3% | 4.8% | 16727 | 16168 | 23.8 | Apache-2.0 / Apache-2.0 |
| PP-OCRv6 tiny det + tiny rec | 2.80% | 2.64% | 76.3% | 18.0% | 3464 | 3147 | 9.4 | Apache-2.0 / Apache-2.0 |
| OnnxTR db_mobilenet_v3_large + parseq multilingual v1 | 14.55% | 13.01% | 35.2% | 57.7% | 56565 | 53523 | 74.2 | Apache-2.0 / Apache-2.0 |

Extra rows, run on a subset only (CV + synthetic pages s01–s05, so synthetic CER is not directly comparable with the rows above):

| config | CER synthetic (s01–s05) | CER CV | Turkish-letter recall | WER (all) | cold ms (CV) | warm ms/page (CV) | download MB (gzip) | licence |
|---|---|---|---|---|---|---|---|---|
| PP-OCRv6 medium det + medium rec | 0.15% | 0.43% | 97.5% | 2.3% | 116906 | 73873 | 103.6 | Apache-2.0 / Apache-2.0 |
| PP-OCRv5 server det + server rec | 4.80% | 22.42% | 41.8% | 65.8% | 82218 | 84369 | 159.0 | Apache-2.0 / Apache-2.0 |

PP-OCRv6 medium is 10× slower than Tesseract and still behind it on the CV (0.43% vs 0.27%). PP-OCRv5 server returned only 148 words on the CV (vs 640+ expected) and its dictionary lacks İ/Ğ; discard.

### Layout models (measured)

The earlier "0 regions" result was a harness bug, not the models: `run.mjs` printed `lines.length` (always 0 for a layout adapter) and the JSON in fact held 23 (plus-L) / 262 (V3) regions. The old 800×800, RGB, /255, `scale_factor = [h, w]` preprocessing already matched the official config; the real defects were that V3's output has 7 columns (the 7th is the reading order, so stride 6 mis-decoded every row after the first), V3's label list was missing, and nothing was ever drawn. `page/bench.mjs` now follows each model's own config:

| model | input | output decoding | threshold |
|---|---|---|---|
| PP-DocLayout plus-L / V3 (`inference.yml`) | Resize 800×800 (no aspect ratio), RGB, `NormalizeImage mean 0 std 1` + default `is_scale` = **/255** (raw 0–255 gives only score < 0.07 junk), inputs `image`, `im_shape = [800,800]`, `scale_factor = [800/h, 800/w]` | `[N,6]` `[cls, score, x0,y0,x1,y1]` (V3: `[N,7]`, + reading order) in source-image pixels; label lists from the yml (20 / 25 classes) | `draw_threshold` 0.5 |
| YOLOv8n general6 (RapidLayout v1.2.0) | plain resize 640×640, RGB, /255 | `[1,10,8400]` = cx,cy,w,h + 6 class scores, class-aware NMS 0.5; labels from the ONNX metadata | 0.25 |
| DocLayout-YOLO DocStructBench | letterbox 1024×1024 (centred, pad 114), RGB, /255 | NMS-free `[1,N,6]` = x0,y0,x1,y1,score,class in letterbox pixels; labels from the ONNX metadata | 0.2 (its default) |

Chromium 153, onnxruntime-web 1.30.0 WASM, 4 threads, below-normal priority, CV page 1818×2573. "cold" = first CV page after the session was created (init = fetch + graph compile, listed separately), "warm" = mean of CV runs 2–3. Model size = gzip of the `.onnx` (the onnxruntime-web runtime adds ≈ 3.7 MB gzip). Regions are those at or above the threshold; the photo / figure / table boxes were compared by IoU with the known box (synthetic pages: where the generator drew it; CV photo: the tight box of the photo, taken from the models' consensus and checked by eye on the annotated PNGs, so its IoU is slightly biased towards the models).

| model | size (gzip / raw) | licence | init ms | cold / warm ms (CV) | CV regions (classes) | CV photo isolated? (label, score, IoU) | synthetic pages: figure / photo, table (IoU) |
|---|---|---|---|---|---|---|---|
| PP-DocLayout plus-L | 117.6 / 129.7 MB | Apache-2.0 | 670 | 1578 / 1778 | 23: 14 text, 8 paragraph_title, 1 image | yes: `image` 0.95, 0.98 | lay1 chart: `chart` 0.69 + `image` 0.58 (0.97); table 0.98 (0.97). lay2 photo: `image` 0.96 (0.96); table 0.98 (0.98) |
| PP-DocLayoutV3 | 117.8 / 130.5 MB | Apache-2.0 | 800–1190 | 2000–2790 / 2230–2630 (noisy run-to-run) | 29: 20 text, 7 paragraph_title, 1 header, 1 image | yes: `image` 0.94, 0.94 | lay1: `chart` 0.82 (0.96); table 0.96 (0.98). lay2: `image` 0.94 (0.95); table 0.96 (0.98) |
| YOLOv8n general6 (360LayoutAnalysis, RapidLayout conversion) | 10.9 / 12.2 MB | Apache-2.0 (weights trained with the AGPL Ultralytics toolchain; not cleared) | 250 | 156 / 130 | 31 at ≥ 0.25 (15 at ≥ 0.5): 23 Text, 7 Title, 1 Figure | yes: `Figure` 0.91, 0.94 | lay1: `Figure` 0.94 (0.98); `Table` 0.96 (0.96). lay2: `Figure` 0.66 (0.91); `Table` only 0.37 (0.98) |
| DocLayout-YOLO DocStructBench | 66.7 / 75.3 MB | **AGPL-3.0** | 620 | 2887 / 3461 | 25: 16 plain text, 8 title, 1 figure | yes: `figure` 0.91, 0.93 | lay1: `figure` 0.96 (0.97); `table` 0.97 (0.96). lay2: `figure` 0.97 (0.97); `table` 0.98 (0.98) |

Annotated CV and synthetic-page outputs: `<workspace>/results/layout-<config>.png` (CV), `layout-<config>-lay1.png`, `-lay2.png`; raw regions in `layout-<config>.json`. Synthetic pages `lay1` (two-column paper: bar chart + caption, table, body text) and `lay2` (grey page, three white shadowed cards: the CV photo, a table, text) are drawn by `genlayout.mjs` in the workspace.

What the models do and do not give on the CV: all four isolate the photo as a single image/figure region (IoU 0.93–0.98 with its tight box) and all four box every text block, with titles/headings separated from body text. **None returns the white cards as regions** — they box the text inside the cards, never the card container — so the card/shadow structure is invisible to a layout model exactly as it is to a word-box approach. On the synthetic pages all four find the chart/photo and the table (IoU ≥ 0.91, tables ≥ 0.96) except YOLOv8n, whose table on lay2 scores 0.37 (below a 0.5 cut-off).

Classical baseline on the same CV (workspace `classical.mjs`): erase the Tesseract (`tess-tur-best`) word boxes (681 words, +6 px), threshold luminance < 200, dilate 12 px, label connected components → **exactly one component**, `[43,53,266,337]`, IoU 0.92 with the photo box, zero model size, a few ms. With a smaller pad/dilation the same image yields the photo plus two 12×12 px specks. This was only run on the CV (single-image page, photo = the only non-text content); it was not run on `lay1`/`lay2` (no OCR word boxes were produced for them).

Sizes: Tesseract rows include `tesseract.esm.min.js`, worker, core wasm + wasm.js and the traineddata (.gz); ONNX rows
include `onnxruntime-web` 1.30.0 `ort.wasm.min.mjs` + `ort-wasm-simd-threaded.{mjs,wasm}` (≈ 3.7 MB gzip) plus the
models (gzip). The CV page is 1818 × ~2570 px (the 1190-pt-wide single-image PDF page rendered at 1.53×); synthetic
pages are ~1170 × 650 px, so per-page synthetic times are about 5–10× lower than the CV numbers. Cold = first CV page
in a fresh browser context including engine/model load; warm = mean of pages 2–3. For Tesseract the load cost is small
relative to recognition; for ONNX the runtime + model compile dominates cold time of the small configs.

Breakdown by synthetic condition (CER; 24 pages, NotoSans/other fonts, Turkish prose, ALL CAPS, digits, noise/blur, dark card):

| config | clean ≥ 11 pt | small 8–10 pt | noise/blur | card / dark | ALL CAPS | digits/mixed |
|---|---|---|---|---|---|---|
| tess tur+eng best_int | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.79% |
| tess tur best_int | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 1.11% |
| PP-OCRv5 mobile + latin rec | 0.03% | 0.00% | 0.00% | 0.95% | 0.18% | 0.00% |
| PP-OCRv6 small | 0.41% | 0.19% | 1.53% | 0.37% | 6.46% | 0.32% |
| PP-OCRv6 tiny det + small rec | 0.44% | 0.13% | 1.22% | 0.58% | 6.46% | 0.48% |
| PP-OCRv6 tiny | 2.77% | 2.68% | 2.04% | 2.62% | 9.59% | 2.38% |
| OnnxTR db_mnv3_large + parseq | 14.84% | 14.33% | 13.31% | 12.33% | 16.05% | 27.66% |

Per-letter recall, all images pooled (share of GT occurrences recognised correctly):

| config | ç | ğ | ı | İ | ö | ş | ü | Ç | Ğ | Ö | Ş | Ü | â |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tess tur+eng best_int | 100 | 100 | 100 | 98.0 | 100 | 100 | 100 | 100 | 100 | 100 | 96.0 | 100 | 100 |
| tess tur best_int | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| PP-OCRv5 mobile + latin rec | 100 | 100 | 98.4 | 95.9 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| PP-OCRv6 small | 100 | 100 | 91.6 | 42.9 | 100 | 100 | 100 | 91.3 | 0.0 | 100 | 100 | 100 | 100 |
| PP-OCRv6 tiny | 100 | 100 | 38.4 | 18.4 | 100 | 99.8 | 100 | 100 | 0.0 | 100 | 76.0 | 100 | 100 |
| OnnxTR parseq multilingual | 84 | 0 | 0 | 0 | 99 | 0 | 95 | 100 | 0 | 100 | 0 | 74 | 96 |

Findings behind the numbers:

- **PP-OCRv6** dictionary (18 708 entries small/medium, 6 904 tiny) contains every Turkish letter, so the weakness is
  the model, not the vocabulary: dotless `ı` and capital `İ` are frequently emitted as `i` / `I` (small: ı 91.6 %, İ 42.9 %,
  so `uygulamasının` → `uygulamasinın`, a word-initial `İ` → `i`) and ALL-CAPS text gets 6.5 % CER. Tiny is unusable (17.8 % wrong words).
- **PP-OCRv5 latin mobile** is good on letters (ı 98.4 %) but on the CV it still turns `ı`→`i` in 12 words, misses the
  three-line education block in the CV's footer card and merges adjacent words (`ÜniversitesiYöntim`).
- **PP-OCRv5 server rec** dictionary has **no `İ` and no `Ğ`** (checked in the shipped `inference.yml`), so it cannot be
  used for Turkish regardless of its other accuracy.
- **OnnxTR parseq multilingual v1** vocabulary (195 chars) has **no `ğ ı İ ş Ğ Ş`** (checked in `config.json`) — hence 35 % letter
  recall. It also produced duplicated fragments (`WeWeb`, `alalan`) with my straight-box DBNet post-processor; that
  part may be a post-processing artefact and was not investigated, because the vocabulary alone disqualifies it. It is also the slowest (≈ 54 s per CV page).
- **Tesseract** remaining CV errors are all the same family: `SQL`→`SOL`, `HTML5`→`HTMLS5`, `Şub`→`Sub`, a leading `İ` read as `i`
  in one word, and the vertical card dividers read as `—`/`(7`. Nothing Turkish-specific.
- The synthetic set is clean rendered text, which favours Tesseract's training distribution; the CV (a real
  phone/PDF export) is the better indicator and gives the same ordering.

## Ground-truth audit

Words that every engine got wrong on the CV were re-checked on 1818-px crops: `gerçekleştirdim.MSSQL` (the PDF really has
no space after the full stop: GT correct), `HTML5` (correct), a month–month date range (the dash is an en dash: GT correct;
scoring folds dashes anyway). **No corrections were needed to the CV transcript.**

## Low-confidence threshold (pooled over all 25 images; "flagged" = word confidence < θ)

| engine | θ | flagged words | precision (flagged that are wrong) | recall (wrong that are flagged) | F1 |
|---|---|---|---|---|---|
| tess tur+eng best_int (16 wrong / 2811 words) | 0.80 | 0.2% | 57% | 25% | 0.35 |
| | **0.85** | 0.4% | 58% | 44% | 0.50 |
| | 0.90 | 0.6% | 44% | 50% | 0.47 |
| | 0.95 | 6.3% | 8% | 88% | 0.14 |
| tess tur best_int (25 wrong / 2811) | 0.85 | 0.8% | 64% | 56% | 0.60 |
| | 0.90 | 1.1% | 53% | 64% | 0.58 |
| PP-OCRv5 mobile latin (41 wrong / 2815) | 0.90 | 0.9% | 50% | 32% | 0.39 |
| | **0.95** | 2.1% | 41% | 59% | 0.48 |
| | 0.98 | 5.5% | 24% | 93% | 0.39 |

Tesseract confidence (0–1, word level) separates wrong words reasonably: **flag words with confidence < 0.90** (UI "low
confidence" highlight; ≈ 0.5–1 % of words, about half of them genuinely wrong, and ≈ 50–64 % of all errors caught).
Use < 0.85 for a stricter, mostly-correct flag set. PP-OCR confidences are saturated near 1.0 and separate much worse.

## Recommendation

1. **Primary (and only) engine: Tesseract via tesseract.js, unchanged.** Pins that already exist in `tools/asset-pins.json`:
   `tesseract.js` **6.0.1**, `tesseract.js-core` **6.1.2** (`tesseract-core-simd-lstm.wasm(.js)`), `@tesseract.js-data/tur`
   **1.0.0** and `@tesseract.js-data/eng` **1.0.0** (`best` = best_int quantised, gzip, 4.7 MB for tur alone; whole stack for
   tur+eng 7.7 MB gzip). Run `tur+eng` together when the document may contain English technical terms (CER 0.27 % vs 0.43 %,
   WER 0.6 % vs 1.0 % on the CV); `fast` data brings no accuracy gain and is 2–3× larger on the wire.
2. **No second engine for now.** The best ONNX alternative (PP-OCRv5 mobile det + latin rec: 15.6 MB gzip, ≈ 9 s/CV page,
   CER CV 0.75 %, WER 1.7 %) is worse on accuracy and not faster. PP-OCRv6 small/medium are worse on Turkish `ı/İ`
   and caps; OnnxTR and PP-OCRv5 server lack Turkish letters in their vocabularies. If a second engine is later wanted
   for photographed or very noisy documents (not covered by this test set) the only candidate that qualifies is the
   pair below — pin it only after a dedicated photo/noise evaluation.

   | file | bytes | sha256 |
   |---|---|---|
   | [PP-OCRv5_mobile_det_onnx `inference.onnx`](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx) | 4 826 518 | `a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d` |
   | [latin_PP-OCRv5_mobile_rec_onnx `inference.onnx`](https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx/resolve/89d3a50e2c27e2e7cceeab0e944c25c807d5db4f/inference.onnx) | 8 042 023 | `7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498` |
   | `onnxruntime-web` **1.30.0** (`ort.wasm.min.mjs`, `ort-wasm-simd-threaded.{mjs,wasm}`) | ≈ 3.7 MB gzip | npm integrity |

   Full pinned list for every model that was evaluated (URLs at fixed revisions, bytes, sha256, licence) is in
   `tools/measure/ocr/models.json`; the character dictionaries come from each model's `inference.yml` (`PostProcess.character_dict`).
3. **Bundle cost of what is recommended:** 0 MB additional (already shipped). Adding the optional pair would cost ≈ 16 MB gzip on demand (onnxruntime-web 3.7 + models ≈ 12 + dictionary), matching the 15.6 MB measured.
4. **Layout models: do not ship any.** Measured above: they isolate the photo (IoU 0.93–0.98) but so does the classical step (erase OCR word boxes, connected components: one component, IoU 0.92, 0 MB); none of them finds the card containers; their extra value is semantic labels and table boxes, which the OCR-word-box + connected-component pipeline does not produce [INFERENCE: not needed for the planned export]. Cost: PP-DocLayout 118 MB gzip and 1.6–2.6 s/page, DocLayout-YOLO 67 MB / 3 s and **AGPL-3.0** (excluded), YOLOv8n general6 11 MB (+3.7 MB runtime) / 0.13 s but with unstable table scores (0.37 on one page) and unclear weight licensing. Revisit only if a photo/figure test set shows the classical step failing (light-background photos, thin-line charts, photos that touch text), and in that case start from YOLOv8n general6 (smallest, fastest) rather than PP-DocLayout.

## Output mapping

Tesseract (`worker.recognize(image, {}, { blocks: true })` → `data.blocks[].paragraphs[].lines[].words[]`):

```ts
{ text: w.text.trim(), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, confidence: w.confidence / 100 }
```
Coordinates are image pixels, origin top-left, y down; convert to PDF points with `pt = px * 72 / renderDpi`, flipping y
(`yPdf = pageHeightPt - y * 72/dpi`). Lines: `{ text: line.text, x0..y1: line.bbox, confidence: line.confidence / 100, words }`.
Drop empty-text words. This is what `tools/measure/ocr/page/bench.mjs` does. (The app's own adapter,
`packages/pdf-core/src/engines/tesseract.ts`, keeps Tesseract's 0–100 and the export divides it by 100 before comparing it with 0.90; the 0–1
scale above is the benchmark's.)

PP-OCR (only if a second engine is ever added): DBNet det output → box per text line (straight-box post-processing in
bench.mjs `dbBoxes`: threshold `inference.yml` PostProcess `thresh`/`box_thresh`/`unclip_ratio`) → recognition per line crop
(height 48, CTC greedy decode with the model dictionary + blank at index 0 + trailing space entry) → line `{text, box, confidence = mean of the
non-space symbol probabilities}`; words = split at emitted space symbols, x positions interpolated from the CTC frame index across the box width,
word confidence = mean probability of its symbols.

### How the Word export uses it

The exact Word layout (`packages/pdf-core/src/ops/docx-layout-ocr.ts`, `ocr-scene.ts`; described in `architecture.md`) reads a page
that is only pictures with the engine chosen here: `tesseract.js` through `recognizePage`, the `best` (integer) models, in the
languages ticked in the Export dialog (default `tur`+`eng`, the pair measured above). Words below 0.90 confidence get a Word comment and
are listed in the report: the threshold of the table above (about 0.5–1 % of words flagged, about half of them truly wrong). A page that
already has a reliable invisible text layer (fewer than 10 % replacement characters or turned lines) is not recognised again; an unreliable one is read as a page without a layer. A page with real text over a scan, or a picture of text on a page of real text, is read with the real text painted over (`ops/docx-layout-mixed.ts`); a picture counts as text only with 8 words on 2 lines, 80 % mean confidence and 15 % of its ink under the words, thresholds taken from OCR of pictures of letters, tables, forms, charts, diagrams and logos. The measurements of the whole path (SSIM and word accuracy of the exported
scans after a round trip through LibreOffice) come from `pnpm fidelity` (`FIDELITY_MODES=layout`), see `CONTRIBUTING.md`.

## Method

- Test set (`tools/measure/ocr/build-testset.mjs`, `texts.mjs`): 24 synthetic pages rendered with mupdf from Turkish text (prose, ALL CAPS, digits/mixed,
  small sizes 8–10 pt, noise/blur, dark card) with per-word ink boxes as ground truth, plus the owner's CV
  (a PDF in the git-ignored folder e2e/fixtures/local, 53-line GT `.gt.txt`, local only, never uploaded).
- Normalisation before scoring: NFC, curly quotes/dashes folded, whitespace collapsed; `|` removed on the CV (drawn dividers).
  CER/WER = Levenshtein / GT length, micro-averaged. Turkish-letter recall from the character alignment.
- Cold/warm timings from `run.mjs` in a fresh Chromium context per config; WASM EP, `numThreads = 4`, `crossOriginIsolated` page served by
  a local HTTP server with COOP/COEP.
- Limitations: one real document; synthetic text is clean-rendered; straight-box (no rotated text) DB post-processing of my own
  implementation was used for the ONNX engines; WebGPU was not part of the table.

## Sources

- tesseract.js: <https://github.com/naptha/tesseract.js> · tesseract.js-core: <https://github.com/naptha/tesseract.js-core> · tessdata_best: <https://github.com/tesseract-ocr/tessdata_best> — Apache-2.0
- PaddleOCR / PP-OCRv5 / PP-OCRv6 ONNX exports: <https://huggingface.co/PaddlePaddle> (e.g. <https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx>, <https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx>) — Apache-2.0
- PP-DocLayout: <https://huggingface.co/PaddlePaddle/PP-DocLayout_plus-L_onnx>, <https://huggingface.co/PaddlePaddle/PP-DocLayoutV3_onnx> — Apache-2.0
- OnnxTR: <https://github.com/felixdittrich92/OnnxTR>, weights <https://huggingface.co/Felix92> — Apache-2.0 (docTR: <https://github.com/mindee/doctr>)
- onnxruntime-web: <https://www.npmjs.com/package/onnxruntime-web> — MIT
- DocLayout-YOLO weights are AGPL-3.0: measured for completeness only, not eligible for shipping.
- YOLOv8n general6: <https://github.com/RapidAI/RapidLayout> (v1.2.0 ONNX conversion, Apache-2.0) of <https://github.com/360AILAB-NLP/360LayoutAnalysis> (Apache-2.0; trained with Ultralytics YOLOv8).
