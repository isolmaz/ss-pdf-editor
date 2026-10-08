// Builds the synthetic Turkish test set: PDFs with known text (mupdf), rasterised at a known
// dpi, with light degradations, plus ground truth (lines, words, ink boxes in pixels) and the
// owner's CV page rasterised at the resolution of its embedded image.
//
//   node tools/measure/ocr/build-testset.mjs
//
// Output (all under WORK, nothing is committed): testset/images/*.png, testset/pdf/*.pdf,
// testset/gt.json  ({ images: [{ id, file, width, height, dpi, spec, lines: [...], words: [...] }] }).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CV_GT, CV_PDF, ensureDir, importFromWork, REPO, TESTSET_DIR, WORK } from './lib.mjs';
import { MIXED, PROSE } from './texts.mjs';

// The other faces come from a folder of .ttf files (the Fonts folder of a LibreOffice install, or
// any folder with Noto Serif/Sans Bold, Liberation Sans/Serif, DejaVu Sans/Serif, Carlito):
// set OCRBENCH_FONTS, or put them in WORK/fonts.
const FONT_DIR = process.env.OCRBENCH_FONTS ?? path.join(WORK, 'fonts');
const NOTO_DIR = path.join(REPO, 'public/fonts/noto');
const FONTS = {
  NotoSans: path.join(NOTO_DIR, 'NotoSans-Regular.ttf'),
  NotoSerif: path.join(FONT_DIR, 'NotoSerif-Regular.ttf'),
  NotoSansBold: path.join(FONT_DIR, 'NotoSans-Bold.ttf'),
  LiberationSans: path.join(FONT_DIR, 'LiberationSans-Regular.ttf'),
  LiberationSansItalic: path.join(FONT_DIR, 'LiberationSans-Italic.ttf'),
  LiberationSerif: path.join(FONT_DIR, 'LiberationSerif-Regular.ttf'),
  DejaVuSans: path.join(FONT_DIR, 'DejaVuSans.ttf'),
  DejaVuSerif: path.join(FONT_DIR, 'DejaVuSerif.ttf'),
  Carlito: path.join(FONT_DIR, 'Carlito-Regular.ttf'),
};

/** [id, font, pt, dpi, condition, content] — conditions are defined in `STYLE`. */
const SPECS = [
  ['s01', 'NotoSans', 12, 200, 'clean', 'prose'],
  ['s02', 'NotoSans', 8, 150, 'clean', 'prose'],
  ['s03', 'NotoSans', 8, 300, 'clean', 'prose'],
  ['s04', 'NotoSans', 10, 150, 'clean', 'prose'],
  ['s05', 'NotoSans', 16, 150, 'clean', 'prose'],
  ['s06', 'NotoSans', 24, 150, 'clean', 'prose'],
  ['s07', 'NotoSerif', 12, 200, 'clean', 'prose'],
  ['s08', 'NotoSerif', 10, 150, 'noise', 'prose'],
  ['s09', 'LiberationSans', 12, 200, 'clean', 'prose'],
  ['s10', 'LiberationSans', 9, 200, 'noiseblur', 'prose'],
  ['s11', 'LiberationSerif', 11, 200, 'clean', 'prose'],
  ['s12', 'LiberationSerif', 14, 150, 'noiseblur', 'prose'],
  ['s13', 'DejaVuSans', 10, 200, 'clean', 'prose'],
  ['s14', 'DejaVuSans', 12, 150, 'blur', 'prose'],
  ['s15', 'DejaVuSerif', 12, 300, 'clean', 'prose'],
  ['s16', 'Carlito', 11, 200, 'clean', 'prose'],
  ['s17', 'NotoSans', 12, 200, 'cardblue', 'prose'],
  ['s18', 'NotoSans', 12, 200, 'dark', 'prose'],
  ['s19', 'LiberationSans', 10, 150, 'darknoise', 'prose'],
  ['s20', 'NotoSerif', 12, 200, 'cardteal', 'prose'],
  ['s21', 'NotoSansBold', 12, 200, 'clean', 'prose'],
  ['s22', 'LiberationSansItalic', 12, 200, 'clean', 'prose'],
  ['s23', 'NotoSans', 12, 200, 'clean', 'caps'],
  ['s24', 'NotoSans', 12, 300, 'clean', 'mixed'],
];

// bg: page, card: card fill (or null), fg: text colour (RGB 0..1), noise: gaussian sigma (0..255), blur: box passes
const STYLE = {
  clean: { bg: [1, 1, 1], card: null, fg: [0, 0, 0], noise: 0, blur: 0 },
  noise: { bg: [1, 1, 1], card: null, fg: [0.05, 0.05, 0.05], noise: 9, blur: 0 },
  blur: { bg: [1, 1, 1], card: null, fg: [0, 0, 0], noise: 0, blur: 1 },
  noiseblur: { bg: [1, 1, 1], card: null, fg: [0.05, 0.05, 0.05], noise: 7, blur: 1 },
  cardblue: { bg: [0.94, 0.94, 0.94], card: [0.86, 0.92, 0.99], fg: [0.07, 0.1, 0.18], noise: 0, blur: 0 },
  dark: { bg: [0.1, 0.12, 0.17], card: null, fg: [0.95, 0.95, 0.95], noise: 0, blur: 0 },
  darknoise: { bg: [0.1, 0.12, 0.17], card: null, fg: [0.92, 0.92, 0.92], noise: 8, blur: 1 },
  cardteal: { bg: [1, 1, 1], card: [0.06, 0.46, 0.43], fg: [1, 1, 1], noise: 0, blur: 0 },
};

const PAGE_W = 420;
const MARGIN = 26;

// Deterministic PRNG so the set is identical on every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

const mupdf = await importFromWork('mupdf/dist/mupdf.js');
ensureDir(path.join(TESTSET_DIR, 'images'));
ensureDir(path.join(TESTSET_DIR, 'pdf'));

const fontCache = new Map();
function loadFont(name) {
  if (!fontCache.has(name)) {
    if (!existsSync(FONTS[name]))
      throw new Error(`font ${name} not found at ${FONTS[name]} (set OCRBENCH_FONTS)`);
    fontCache.set(name, new mupdf.Font(name, readFileSync(FONTS[name])));
  }
  return fontCache.get(name);
}

function contentLines(kind, seed) {
  const rand = mulberry32(seed);
  const pool = kind === 'mixed' ? [...MIXED, ...PROSE.slice(0, 6)] : PROSE;
  const picked = [];
  const order = [...pool.keys()].sort(() => rand() - 0.5);
  for (let i = 0; picked.length < 40 && i < order.length * 2; i++) picked.push(pool[order[i % order.length]]);
  let text = picked.join(' ');
  if (kind === 'caps') text = text.toLocaleUpperCase('tr');
  return text;
}

function wrap(text, font, size, maxWidth, maxLines) {
  const lines = [];
  const words = text.split(' ');
  let current = [];
  let width = 0;
  const space = font.advanceGlyph(font.encodeCharacter(' ')) * size;
  const wordWidth = (word) => {
    let w = 0;
    for (const ch of word) {
      const gid = font.encodeCharacter(ch);
      if (gid === 0)
        throw new Error(`glyph missing for U+${ch.codePointAt(0).toString(16)} in ${font.getName?.() ?? ''}`);
      w += font.advanceGlyph(gid) * size;
    }
    return w;
  };
  for (const word of words) {
    const w = wordWidth(word);
    if (current.length > 0 && width + space + w > maxWidth) {
      lines.push(current);
      if (lines.length === maxLines) return lines;
      current = [];
      width = 0;
    }
    width += (current.length > 0 ? space : 0) + w;
    current.push({ word, width: w });
  }
  if (current.length > 0 && lines.length < maxLines) lines.push(current);
  return lines;
}

function buildPdf(spec, laid, style, pageH) {
  const [, fontName, size] = spec;
  const font = loadFont(fontName);
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
  const device = writer.beginPage([0, 0, PAGE_W, pageH]);
  const rgb = mupdf.ColorSpace.DeviceRGB;
  const rect = (x0, y0, x1, y1, color) => {
    const p = new mupdf.Path();
    p.rect(x0, y0, x1, y1);
    device.fillPath(p, false, mupdf.Matrix.identity, rgb, color, 1);
  };
  rect(0, 0, PAGE_W, pageH, style.bg);
  if (style.card) rect(14, 14, PAGE_W - 14, pageH - 14, style.card);
  const space = font.advanceGlyph(font.encodeCharacter(' ')) * size;
  for (const line of laid) {
    const text = new mupdf.Text();
    text.showString(
      font,
      [size, 0, 0, -size, MARGIN, line.baseline],
      line.words.map((w) => w.word).join(' '),
    );
    device.fillText(text, mupdf.Matrix.identity, rgb, style.fg, 1);
  }
  writer.endPage();
  writer.close();
  return { bytes: buffer.asUint8Array().slice(), space };
}

function inkBox(data, W, H, n, bg, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1));
  y1 = Math.min(H, Math.ceil(y1));
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * n;
      const diff = Math.max(
        Math.abs(data[i] - bg[0]),
        Math.abs(data[i + 1] - bg[1]),
        Math.abs(data[i + 2] - bg[2]),
      );
      if (diff >= 90) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX + 1, maxY + 1];
}

function boxBlur(data, W, H, n, passes) {
  const tmp = new Uint8ClampedArray(data.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < n; c++) {
          const l = data[(y * W + Math.max(0, x - 1)) * n + c];
          const m = data[(y * W + x) * n + c];
          const r = data[(y * W + Math.min(W - 1, x + 1)) * n + c];
          tmp[(y * W + x) * n + c] = (l + 2 * m + r) / 4;
        }
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < n; c++) {
          const t = tmp[(Math.max(0, y - 1) * W + x) * n + c];
          const m = tmp[(y * W + x) * n + c];
          const b = tmp[(Math.min(H - 1, y + 1) * W + x) * n + c];
          data[(y * W + x) * n + c] = (t + 2 * m + b) / 4;
        }
      }
    }
  }
}

const images = [];
for (const [index, spec] of SPECS.entries()) {
  const [id, fontName, size, dpi, cond, kind] = spec;
  const style = STYLE[cond];
  const font = loadFont(fontName);
  const lineHeight = size * 1.38;
  const maxLines = size <= 12 ? 11 : size <= 16 ? 9 : 6;
  const text = contentLines(kind, 1000 + index);
  const lines = wrap(text, font, size, PAGE_W - 2 * MARGIN, maxLines);
  const pageH = Math.ceil(2 * MARGIN + lines.length * lineHeight);
  const laid = lines.map((words, i) => ({ words, baseline: MARGIN + size + i * lineHeight }));
  const { bytes, space } = buildPdf(spec, laid, style, pageH);
  writeFileSync(path.join(TESTSET_DIR, 'pdf', `${id}.pdf`), bytes);

  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const scale = dpi / 72;
  const pm = doc
    .loadPage(0)
    .toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const W = pm.getWidth();
  const H = pm.getHeight();
  const n = pm.getNumberOfComponents();
  const clean = pm.getPixels().slice();
  const bg = (style.card ?? style.bg).map((v) => Math.round(v * 255));

  const words = [];
  const gtLines = [];
  for (const [li, line] of laid.entries()) {
    let x = MARGIN;
    gtLines.push(line.words.map((w) => w.word).join(' '));
    for (const w of line.words) {
      const box = inkBox(
        clean,
        W,
        H,
        n,
        bg,
        (x - 0.5) * scale,
        (line.baseline - size * 1.05) * scale,
        (x + w.width + 0.5) * scale,
        (line.baseline + size * 0.38) * scale,
      );
      words.push({ text: w.word, line: li, box });
      x += w.width + space;
    }
  }

  const px = pm.getPixels();
  if (style.blur > 0) boxBlur(px, W, H, n, style.blur);
  if (style.noise > 0) {
    const rand = mulberry32(5000 + index);
    for (let i = 0; i < W * H; i++) {
      const g = gaussian(rand) * style.noise;
      for (let c = 0; c < n; c++) px[i * n + c] += g;
    }
  }
  const file = `${id}.png`;
  writeFileSync(path.join(TESTSET_DIR, 'images', file), pm.asPNG());
  images.push({
    id,
    file,
    width: W,
    height: H,
    dpi,
    kind: 'synthetic',
    spec: { fontName, size, dpi, cond, kind },
    lines: gtLines,
    words,
  });
  console.log(
    `${id} ${fontName} ${size}pt ${dpi}dpi ${cond}/${kind}: ${W}x${H}, ${gtLines.length} lines, ${words.length} words`,
  );
}

// The owner's CV: rasterised at the pixel size of its embedded image (110 dpi, 1818x2572).
if (existsSync(CV_PDF) && existsSync(CV_GT)) {
  const doc = mupdf.Document.openDocument(readFileSync(CV_PDF), 'application/pdf');
  const page = doc.loadPage(0);
  const scale = 1818 / 1190;
  const pm = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  writeFileSync(path.join(TESTSET_DIR, 'images', 'cv.png'), pm.asPNG());
  const lines = readFileSync(CV_GT, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  images.push({
    id: 'cv',
    file: 'cv.png',
    width: pm.getWidth(),
    height: pm.getHeight(),
    dpi: scale * 72,
    kind: 'cv',
    spec: {},
    lines,
    words: [],
  });
  console.log(`cv ${pm.getWidth()}x${pm.getHeight()} ${lines.length} GT lines`);
} else {
  console.log('CV fixture or transcript not present — skipping the cv image');
}

writeFileSync(path.join(TESTSET_DIR, 'gt.json'), JSON.stringify({ images }, null, 1));
