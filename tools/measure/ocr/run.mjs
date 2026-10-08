// Runs OCR engine configurations in Chromium and records raw outputs and timings.
//
//   node tools/measure/ocr/run.mjs --list
//   node tools/measure/ocr/run.mjs tess-tur-best ppocrv6-small          # named configs
//   node tools/measure/ocr/run.mjs --all                                # every config (long)
//   node tools/measure/ocr/run.mjs ppocrv6-small-gpu --images cv,s01    # subset of images
//
// Each config gets a fresh browser context (cold caches). The CV page is processed first and
// three times: run 1 is the "cold" page (model load time is added to it), runs 2-3 are the warm
// numbers. Synthetic images follow, once each. Results: WORK/results/<config>.json
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { ensureDir, HERE, importFromWork, MODELS_DIR, REPO, RESULTS_DIR, TESTSET_DIR, WORK } from './lib.mjs';

const manifest = JSON.parse(readFileSync(path.join(HERE, 'models.json'), 'utf8'));
const ORT_DIST = path.join(WORK, 'node_modules/onnxruntime-web/dist');
const TESS = path.join(REPO, 'public/engines/tesseract');

/** files (relative to a root) each family needs on the wire, for the download-size column */
const ORT_WASM_FILES = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'].map(
  (f) => path.join(ORT_DIST, f),
);
const ORT_GPU_FILES = [
  'ort.webgpu.min.mjs',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
].map((f) => path.join(ORT_DIST, f));
const tessFiles = (quality, langs) =>
  [
    'tesseract.esm.min.js',
    'worker.min.js',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm',
    ...langs.map((l) => `lang/${quality}/${l}.traineddata.gz`),
  ].map((f) => path.join(TESS, f));

const onnx = (ids) => ids.map((id) => path.join(MODELS_DIR, `${id}.onnx`));

const paddle = (det, rec, extra = {}) => ({ engine: 'paddle', det, rec, ep: 'wasm', ...extra });
export const CONFIGS = {
  'tess-tur-fast': {
    engine: 'tesseract',
    quality: 'fast',
    langs: ['tur'],
    files: tessFiles('fast', ['tur']),
  },
  'tess-tur-best': {
    engine: 'tesseract',
    quality: 'best',
    langs: ['tur'],
    files: tessFiles('best', ['tur']),
  },
  'tess-tur+eng-best': {
    engine: 'tesseract',
    quality: 'best',
    langs: ['tur', 'eng'],
    files: tessFiles('best', ['tur', 'eng']),
  },
  'tess-tur+eng-fast': {
    engine: 'tesseract',
    quality: 'fast',
    langs: ['tur', 'eng'],
    files: tessFiles('fast', ['tur', 'eng']),
  },
  'ppocrv5-mobile-latin': {
    ...paddle('ppocrv5-det-mobile', 'ppocrv5-rec-latin-mobile'),
    files: [...ORT_WASM_FILES, ...onnx(['ppocrv5-det-mobile', 'ppocrv5-rec-latin-mobile'])],
  },
  'ppocrv6-tiny': {
    ...paddle('ppocrv6-det-tiny', 'ppocrv6-rec-tiny'),
    files: [...ORT_WASM_FILES, ...onnx(['ppocrv6-det-tiny', 'ppocrv6-rec-tiny'])],
  },
  'ppocrv6-small': {
    ...paddle('ppocrv6-det-small', 'ppocrv6-rec-small'),
    files: [...ORT_WASM_FILES, ...onnx(['ppocrv6-det-small', 'ppocrv6-rec-small'])],
  },
  'ppocrv6-medium': {
    ...paddle('ppocrv6-det-medium', 'ppocrv6-rec-medium'),
    files: [...ORT_WASM_FILES, ...onnx(['ppocrv6-det-medium', 'ppocrv6-rec-medium'])],
    slow: true,
  },
  'ppocrv6-tinydet-smallrec': {
    ...paddle('ppocrv6-det-tiny', 'ppocrv6-rec-small'),
    files: [...ORT_WASM_FILES, ...onnx(['ppocrv6-det-tiny', 'ppocrv6-rec-small'])],
  },
  'ppocrv5-server': {
    ...paddle('ppocrv5-det-server', 'ppocrv5-rec-server'),
    files: [...ORT_WASM_FILES, ...onnx(['ppocrv5-det-server', 'ppocrv5-rec-server'])],
    slow: true,
  },
  'onnxtr-fast': {
    engine: 'onnxtr',
    det: 'onnxtr-det-db-mobilenet-v3-large',
    rec: 'onnxtr-rec-crnn-mobilenet-v3-small',
    ep: 'wasm',
    files: [
      ...ORT_WASM_FILES,
      ...onnx(['onnxtr-det-db-mobilenet-v3-large', 'onnxtr-rec-crnn-mobilenet-v3-small']),
    ],
  },
  'onnxtr-accurate': {
    engine: 'onnxtr',
    det: 'onnxtr-det-fast-base',
    rec: 'onnxtr-rec-parseq-multilingual-v1',
    ep: 'wasm',
    files: [...ORT_WASM_FILES, ...onnx(['onnxtr-det-fast-base', 'onnxtr-rec-parseq-multilingual-v1'])],
    slow: true,
  },
  'onnxtr-dbmobile-parseq': {
    engine: 'onnxtr',
    det: 'onnxtr-det-db-mobilenet-v3-large',
    rec: 'onnxtr-rec-parseq-multilingual-v1',
    ep: 'wasm',
    files: [
      ...ORT_WASM_FILES,
      ...onnx(['onnxtr-det-db-mobilenet-v3-large', 'onnxtr-rec-parseq-multilingual-v1']),
    ],
  },
  // thresholds: PP-DocLayout draw_threshold (inference.yml), RapidLayout YOLOv8 default, DocLayout-YOLO default conf
  'layout-ppdoclayout-plus-l': {
    engine: 'layout',
    model: 'layout-pp-doclayout-plus-l',
    layoutKind: 'paddle',
    threshold: 0.5,
    ep: 'wasm',
    files: [...ORT_WASM_FILES, ...onnx(['layout-pp-doclayout-plus-l'])],
    layout: true,
  },
  'layout-ppdoclayout-v3': {
    engine: 'layout',
    model: 'layout-pp-doclayout-v3',
    layoutKind: 'paddle',
    threshold: 0.5,
    ep: 'wasm',
    files: [...ORT_WASM_FILES, ...onnx(['layout-pp-doclayout-v3'])],
    layout: true,
  },
  'layout-yolov8n-general6': {
    engine: 'layout',
    model: 'layout-yolov8n-general6',
    layoutKind: 'yolov8',
    threshold: 0.25,
    ep: 'wasm',
    files: [...ORT_WASM_FILES, ...onnx(['layout-yolov8n-general6'])],
    layout: true,
  },
  'layout-doclayout-yolo': {
    engine: 'layout',
    model: 'layout-doclayout-yolo-docstructbench',
    layoutKind: 'e2e',
    threshold: 0.2,
    ep: 'wasm',
    files: [...ORT_WASM_FILES, ...onnx(['layout-doclayout-yolo-docstructbench'])],
    layout: true,
  },
};
// WebGPU twins of the ONNX configs
for (const name of [
  'ppocrv6-tiny',
  'ppocrv6-small',
  'ppocrv6-medium',
  'ppocrv5-mobile-latin',
  'layout-ppdoclayout-plus-l',
  'layout-ppdoclayout-v3',
  'layout-yolov8n-general6',
  'layout-doclayout-yolo',
]) {
  const base = CONFIGS[name];
  CONFIGS[`${name}-gpu`] = {
    ...base,
    ep: 'webgpu',
    files: base.files.filter((f) => !ORT_WASM_FILES.includes(f)).concat(ORT_GPU_FILES),
  };
}

const MIME = {
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.onnx': 'application/octet-stream',
  '.gz': 'application/gzip',
};

async function prepareDicts() {
  const yaml = await importFromWork('yaml/dist/index.js');
  const parse = yaml.parse ?? yaml.default.parse;
  ensureDir(path.join(WORK, 'dicts'));
  for (const model of manifest.models) {
    const ymlFile = path.join(MODELS_DIR, `${model.id}.inference.yml`);
    if (!model.id.includes('-rec-') || !existsSync(ymlFile)) continue;
    const doc = parse(readFileSync(ymlFile, 'utf8'));
    const dict = doc.PostProcess?.character_dict;
    if (Array.isArray(dict))
      writeFileSync(path.join(WORK, 'dicts', `${model.id}.json`), JSON.stringify(dict.map(String)));
  }
}

function startServer() {
  const roots = [
    ['/ort/', ORT_DIST],
    ['/engines/tesseract/', TESS],
    ['/models/', MODELS_DIR],
    ['/dicts/', path.join(WORK, 'dicts')],
    ['/images/', path.join(TESTSET_DIR, 'images')],
    ['/', path.join(HERE, 'page')],
  ];
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const [prefix, root] = roots.find(([p]) => url.startsWith(p)) ?? [];
    const rel = url === '/' ? 'index.html' : url.slice(prefix.length);
    const file = path.join(root, rel);
    if (!root || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-store',
    });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function downloadSizes(files) {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    raw += bytes.length;
    // `.gz` language packs are already compressed on disk; everything else is gzip -9
    gzip += file.endsWith('.gz') ? bytes.length : gzipSync(bytes, { level: 9 }).length;
  }
  return { rawBytes: raw, gzipBytes: gzip };
}

/** Draws the regions of the last run of each page on the page image: WORK/results/<config>.png (CV), <config>-<page>.png */
async function annotateRegions(name, runs) {
  const { createCanvas, loadImage } = await importFromWork('@napi-rs/canvas/index.js');
  const palette = [
    '#e6194b',
    '#3cb44b',
    '#4363d8',
    '#f58231',
    '#911eb4',
    '#008080',
    '#9a6324',
    '#800000',
    '#808000',
    '#000075',
  ];
  const colours = new Map();
  for (const id of ['cv', 'lay1', 'lay2']) {
    const run = runs.filter((r) => r.id === id).at(-1);
    if (!run) continue;
    const image = await loadImage(path.join(TESTSET_DIR, 'images', id === 'cv' ? 'cv.png' : `${id}.png`));
    const canvas = createCanvas(image.width, image.height);
    const g = canvas.getContext('2d');
    g.drawImage(image, 0, 0);
    const lw = Math.max(3, Math.round(image.width / 400));
    g.lineWidth = lw;
    g.font = `bold ${Math.round(image.width / 55)}px Arial`;
    for (const r of run.regions) {
      if (!colours.has(r.label)) colours.set(r.label, palette[colours.size % palette.length]);
      const colour = colours.get(r.label);
      g.strokeStyle = colour;
      g.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      const text = `${r.label} ${r.score.toFixed(2)}`;
      const tw = g.measureText(text).width;
      g.fillStyle = colour;
      g.fillRect(
        r.x0,
        Math.max(0, r.y0 - lw - Math.round(image.width / 50)),
        tw + 8,
        Math.round(image.width / 50),
      );
      g.fillStyle = '#fff';
      g.fillText(text, r.x0 + 4, Math.max(Math.round(image.width / 55), r.y0 - lw - 4));
    }
    writeFileSync(
      path.join(RESULTS_DIR, id === 'cv' ? `${name}.png` : `${name}-${id}.png`),
      canvas.toBuffer('image/png'),
    );
  }
}

async function runConfig(name, config, imageIds, server) {
  const gt = JSON.parse(readFileSync(path.join(TESTSET_DIR, 'gt.json'), 'utf8'));
  const known = new Map(gt.images.map((i) => [i.id, i]));
  // synthetic layout pages (WORK/testset/images/lay*.png): drawn by a one-off generator that is not
  // part of the repo, so they are used only when the files are there
  for (const id of ['lay1', 'lay2']) {
    if (existsSync(path.join(TESTSET_DIR, 'images', `${id}.png`))) known.set(id, { id, file: `${id}.png` });
  }
  const ids = imageIds ?? gt.images.map((i) => i.id);
  const order = config.layout
    ? ['cv', 'lay1', 'lay2']
    : config.slow && !imageIds
      ? ['cv', 's01', 's02', 's09', 's10', 's17', 's18', 's20', 's23']
      : ids;
  const browser = await chromium.launch({
    headless: true,
    args:
      config.ep === 'webgpu'
        ? [
            '--enable-unsafe-webgpu',
            '--enable-features=WebGPU',
            '--ignore-gpu-blocklist',
            '--enable-webgpu-developer-features',
          ]
        : [],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${name}] console.error: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.benchReady === true);
    const env = await page.evaluate(() => window.bench.env());
    const init = await page.evaluate((cfg) => window.bench.init(cfg), config);
    console.log(
      `[${name}] init ${init.initMs.toFixed(0)} ms ${JSON.stringify({ ...init, initMs: undefined })}`,
    );
    const runs = [];
    const schedule = [];
    for (const id of order) {
      if (!known.has(id)) continue;
      const repeats = id === 'cv' ? 3 : 1;
      for (let r = 0; r < repeats; r++) schedule.push([id, r]);
    }
    for (const [id, repeat] of schedule) {
      const result = await page.evaluate((file) => window.bench.run(file), known.get(id).file);
      runs.push({ id, repeat, ...result });
      const words = result.lines?.reduce((n, l) => n + (l.words?.length ?? 0), 0) ?? 0;
      console.log(
        `[${name}] ${id}#${repeat} ${result.ms.toFixed(0)} ms, ${result.regions?.length ?? result.lines?.length} ${result.regions ? 'regions' : 'lines'}, ${words} words`,
      );
    }
    await page.evaluate(() => window.bench.dispose());
    if (config.layout) await annotateRegions(name, runs);
    const out = {
      name,
      config: { ...config, files: undefined },
      env,
      init,
      sizes: downloadSizes(config.files),
      runs,
      finishedAt: new Date().toISOString(),
    };
    ensureDir(RESULTS_DIR);
    writeFileSync(path.join(RESULTS_DIR, `${name}.json`), JSON.stringify(out));
  } finally {
    await browser.close();
  }
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const [name, c] of Object.entries(CONFIGS))
    console.log(`${name}${c.slow ? ' (slow: subset)' : ''}${c.layout ? ' (layout)' : ''}`);
  process.exit(0);
}
const imagesFlag = args.indexOf('--images');
const imageIds = imagesFlag >= 0 ? args[imagesFlag + 1].split(',') : null;
const names = args.includes('--all')
  ? Object.keys(CONFIGS)
  : args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--images');
await prepareDicts();
const server = await startServer();
try {
  for (const name of names) {
    if (!CONFIGS[name]) throw new Error(`unknown config ${name}; use --list`);
    try {
      await runConfig(name, CONFIGS[name], imageIds, server);
    } catch (error) {
      console.log(`[${name}] FAILED: ${error.message}`);
    }
  }
} finally {
  server.close();
}
