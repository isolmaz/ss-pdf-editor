#!/usr/bin/env node
/**
 * Node-side fixture generator for spike #5 (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * The two failed runs of this spike both died building the fixture **inside the
 * page**; the recorded fix (`NOTES.md`, "What the next attempt must change") is
 * to build the fixture here, in Node, and let the page do nothing but measure.
 *
 * Recipe per page: a **scanned-text-page** raster at real scan resolution
 * (A4 at `--dpi`, grayscale) painted into a MuPDF pixmap — paper with
 * mid-frequency grain, justified lines of word-like dark bars, a heading, a
 * header/footer rule and (page 1) a signature block — then
 * `Pixmap.asJPEG(quality)` (libjpeg-turbo through the `mupdf` wasm binding in
 * Node) → MuPDF embeds the JPEG as a DCTDecode XObject, drawn full-bleed on
 * an A4 page. Every page gets a different seed, so no two embedded streams are
 * identical.
 *
 * The painter is deliberately *not* single-pixel noise: JPEG quantises
 * one-pixel speckle at q0.72 away to nothing (a 512² speckle page encodes to
 * ~2.7 KB), which would make a "300 MB scan" that renders like an empty page.
 * Words-on-paper carry mid-frequency detail that survives the encoder, which is
 * what a real scan does too.
 *
 *   node tools/spikes/large-file/make-fixture.mjs --pages 400 --dpi 150 --quality 0.6 --out <file.pdf>
 *
 * Output is one JSON object on stdout: the numbers the run note quotes for the
 * fixture (pages, bytes, per-page JPEG payload). The PDF goes to `--out` only —
 * never into the repository (`/tmp` or the OS temp dir).
 */
import { statSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { createFixture } from '../mupdf-fixture.mjs';
import { FIELD_INITIAL_VALUE, FIELD_NAME, PAGE_HEIGHT, PAGE_WIDTH } from './recipe.mjs';

const POINTS_PER_INCH = 72;
const TILE = 256;

function parseArgs(argv) {
  const options = { pages: 10, dpi: 150, quality: 72, grain: 10, out: null, seed: 0x5eed15 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--pages') options.pages = Number.parseInt(value, 10);
    else if (flag === '--dpi') options.dpi = Number.parseInt(value, 10);
    else if (flag === '--quality') options.quality = Number.parseInt(value, 10);
    else if (flag === '--grain') options.grain = Number.parseInt(value, 10);
    else if (flag === '--out') options.out = value;
    else if (flag === '--seed') options.seed = Number.parseInt(value, 10);
    else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  if (!options.out) throw new Error('--out <path> is required');
  if (!Number.isFinite(options.pages) || options.pages < 1) throw new Error('--pages must be >= 1');
  if (!Number.isFinite(options.dpi) || options.dpi < 20) throw new Error('--dpi must be >= 20');
  // `mupdf`'s JPEG quality is libjpeg's 0..100 scale, **not** the canvas 0..1 one.
  if (!Number.isFinite(options.quality) || options.quality < 1 || options.quality > 100) {
    throw new Error('--quality is libjpeg 1..100 (canvas-style 0..1 silently encodes as 0)');
  }
  return options;
}

function xorshift(state) {
  let next = state;
  next ^= next << 13;
  next >>>= 0;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function fillBlock(pixels, stride, x, y, width, height, value) {
  const from = Math.max(0, x);
  const to = Math.min(stride, x + width);
  if (to <= from || width <= 0 || height <= 0) return;
  for (let row = Math.max(0, y); row < y + height; row += 1) {
    pixels.fill(value, row * stride + from, row * stride + to);
  }
}

/**
 * One 256×256 grain tile, reused for every page; the per-page seed shifts it.
 * Paper is `245` ± `amplitude`/2 — the values must stay inside 0..255, because
 * a wrapped pixel would be a black speckle and dominate the JPEG payload.
 */
function makeGrainTile(seed, amplitude) {
  const tile = new Uint8Array(TILE * TILE);
  const base = 245 - Math.floor(amplitude / 2);
  let state = seed | 1;
  for (let index = 0; index < tile.length; index += 1) {
    state = xorshift(state);
    tile[index] = base + (state % (amplitude + 1));
  }
  return tile;
}

function paintPaper(pixels, stride, width, height, tile, offset) {
  const tileRow = new Uint8Array(TILE);
  for (let y = 0; y < height; y += 1) {
    const tileY = (y + offset) & (TILE - 1);
    for (let x = 0; x < TILE; x += 1) tileRow[x] = tile[tileY * TILE + ((x + offset) & (TILE - 1))];
    const row = y * stride;
    let x = 0;
    for (; x + TILE <= width; x += TILE) pixels.set(tileRow, row + x);
    if (x < width) pixels.set(tileRow.subarray(0, width - x), row + x);
  }
}

/**
 * A scanned text page: justified lines of word-like bars, a heavier heading, a
 * header/footer rule and a signature block on page 1. Everything is derived from
 * the page seed, so page *n* is a different document page, not the same one.
 */
function paintScanPage(pixels, stride, width, height, seed, firstPage, grain) {
  const state = { value: seed | 1 };
  const next = () => {
    state.value = xorshift(state.value);
    return state.value;
  };

  paintPaper(pixels, stride, width, height, makeGrainTile(seed, grain), next() & 0xffff);

  const marginX = Math.round(width * 0.1);
  const contentWidth = width - marginX * 2;
  const linePitch = Math.max(6, Math.round(height / 62));
  const textHeight = Math.max(2, Math.round(linePitch * 0.5));

  // Header rule + footer rule, like a scanned form.
  fillBlock(pixels, stride, marginX, Math.round(height * 0.06), contentWidth, 2, 90);
  fillBlock(pixels, stride, marginX, Math.round(height * 0.94), contentWidth, 2, 90);

  let y = Math.round(height * 0.1);
  let lines = 0;
  while (y + textHeight < Math.round(height * 0.9) && lines < 200) {
    const roll = next() % 100;
    if (roll < 6 && lines > 3) {
      // Paragraph break.
      y += Math.round(linePitch * 0.9);
      lines += 1;
      continue;
    }
    const heading = roll >= 94;
    const heightHere = heading ? Math.round(textHeight * 1.7) : textHeight;
    const ink = heading ? 30 + (next() & 0x1f) : 45 + (next() & 0x3f);
    let x = marginX + (roll < 20 ? Math.round(contentWidth * 0.05) : 0);
    const lineEnd = marginX + contentWidth - (next() % 3 === 0 ? Math.round(contentWidth * 0.12) : 0);
    while (x < lineEnd) {
      const wordWidth = Math.round(linePitch * (1.2 + (next() % 400) / 100));
      const gap = Math.max(2, Math.round(linePitch * (0.2 + (next() % 20) / 100)));
      fillBlock(pixels, stride, x, y, Math.min(wordWidth, lineEnd - x), heightHere, ink);
      x += wordWidth + gap;
    }
    if (heading && next() % 2 === 0) {
      y += heightHere + 2;
      fillBlock(pixels, stride, marginX, y, Math.round(contentWidth * 0.4), 2, 70);
    }
    y += linePitch;
    lines += 1;
  }

  if (firstPage) {
    // An ink stamp and a signature rule: the kind of non-text blob a scan has.
    const stampSize = Math.round(contentWidth * 0.18);
    const stampX = marginX + Math.round(contentWidth * 0.55);
    const stampY = Math.round(height * 0.74);
    for (let row = 0; row < stampSize; row += 1) {
      for (let column = 0; column < stampSize; column += 1) {
        const onEdge = row < 3 || column < 3 || row > stampSize - 4 || column > stampSize - 4;
        const ink = onEdge ? 40 : 150 + ((row * column + seed) % 60);
        fillBlock(pixels, stride, stampX + column, stampY + row, 1, 1, ink);
      }
    }
    fillBlock(pixels, stride, marginX, Math.round(height * 0.86), Math.round(contentWidth * 0.3), 2, 60);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const width = Math.round((PAGE_WIDTH / POINTS_PER_INCH) * options.dpi);
  const height = Math.round((PAGE_HEIGHT / POINTS_PER_INCH) * options.dpi);

  // One pixmap, re-painted per page: `getPixels()` is a view into the wasm heap.
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, width, height], false);
  const stride = pixmap.getStride();
  const pixels = pixmap.getPixels();

  const pdfDocument = createFixture(mupdf);
  pdfDocument.info({
    Title: 'spike-5 large-file fixture (generated in Node)',
    Producer: 'PDF Editor spike #5 (throwaway)',
  });

  let jpegBytes = 0;
  let minJpegBytes = Number.POSITIVE_INFINITY;
  let maxJpegBytes = 0;
  const sizes = new Set();
  const _paintStarted = Date.now();
  let paintMs = 0;
  let encodeMs = 0;

  for (let index = 0; index < options.pages; index += 1) {
    const seed = xorshift(options.seed + index * 0x9e3779b1);
    const paintAt = Date.now();
    paintScanPage(pixels, stride, width, height, seed, index === 0, options.grain);
    const encodeAt = Date.now();
    paintMs += encodeAt - paintAt;
    const jpeg = pixmap.asJPEG(options.quality);
    encodeMs += Date.now() - encodeAt;
    jpegBytes += jpeg.byteLength;
    minJpegBytes = Math.min(minJpegBytes, jpeg.byteLength);
    maxJpegBytes = Math.max(maxJpegBytes, jpeg.byteLength);
    sizes.add(jpeg.byteLength);

    // MuPDF keeps a JPEG's compressed bytes: the XObject is the DCTDecode stream itself.
    const page = pdfDocument.addPage(PAGE_WIDTH, PAGE_HEIGHT);
    page.image(jpeg, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });

    if (index === 0) page.textField(FIELD_NAME, [56, 56, 296, 78], FIELD_INITIAL_VALUE);
  }

  const saveStarted = Date.now();
  const bytes = pdfDocument.save('compress,objstms');
  writeFileSync(options.out, bytes);
  const saveMs = Date.now() - saveStarted;

  const summary = {
    out: options.out,
    pages: options.pages,
    dpi: options.dpi,
    raster: `${width}×${height}`,
    quality: options.quality,
    grain: options.grain,
    bytes: statSync(options.out).size,
    jpegBytes,
    perPageJpegBytes: Math.round(jpegBytes / options.pages),
    minJpegBytes: Number.isFinite(minJpegBytes) ? minJpegBytes : 0,
    maxJpegBytes,
    distinctJpegSizes: sizes.size,
    pdfOverJpegRatio: Number((statSync(options.out).size / (jpegBytes || 1)).toFixed(3)),
    paintMs,
    encodeMs,
    saveMs,
    // The generator is Node-side; nothing here is measured inside the browser.
    totalMs: Date.now() - started,
  };
  // Sidecar: the dev server serves it next to the PDF at `/spike5/fixture.json`,
  // and it is what fills the fixture numbers in the run note — the page itself
  // never generates a fixture, so it cannot report how one was built.
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(`${options.out}.json`, serialized);
  process.stdout.write(serialized);
}

await main();
