// Browser-side engine adapters. Loaded by page/index.html and driven by run.mjs through
// `window.bench`. Every adapter returns the same shape:
//
//   { lines: [{ text, x0, y0, x1, y1, confidence, words: [{ text, x0, y0, x1, y1, confidence }] }],
//     timings: { ... ms per stage }, extra: {...} }
//
// Coordinates are pixels of the input image (origin top-left, y down).

const threads = Math.min(4, navigator.hardwareConcurrency ?? 4);

// ───────────────────────────── image helpers ─────────────────────────────

async function loadBitmap(name) {
  const response = await fetch(`/images/${name}`);
  const blob = await response.blob();
  return { blob, bitmap: await createImageBitmap(blob) };
}

function resizedImageData(source, sx, sy, sw, sh, dw, dh) {
  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}

// ───────────────────────────── DB post-processing ─────────────────────────────
// Straight-box variant of the DBNet post-processor shared by PaddleOCR and docTR: threshold the
// probability map, label connected components, score each by the mean probability over its
// bounding box, then un-clip (expand by area * ratio / perimeter, the same offset
// pyclipper applies to an axis-aligned rectangle). Rotated text is out of scope for this benchmark.

function dbBoxes(prob, W, H, { thresh, boxThresh, unclip, minSize = 3, open = false }) {
  let bitmap = new Uint8Array(W * H);
  for (let i = 0; i < bitmap.length; i++) bitmap[i] = prob[i] >= thresh ? 1 : 0;
  if (open) {
    // 3x3 opening (erode then dilate), as docTR does.
    const eroded = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        eroded[i] =
          bitmap[i] &
          bitmap[i - 1] &
          bitmap[i + 1] &
          bitmap[i - W] &
          bitmap[i + W] &
          bitmap[i - W - 1] &
          bitmap[i - W + 1] &
          bitmap[i + W - 1] &
          bitmap[i + W + 1];
      }
    const dilated = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        dilated[i] =
          eroded[i] |
          eroded[i - 1] |
          eroded[i + 1] |
          eroded[i - W] |
          eroded[i + W] |
          eroded[i - W - 1] |
          eroded[i - W + 1] |
          eroded[i + W - 1] |
          eroded[i + W + 1];
      }
    bitmap = dilated;
  }
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const boxes = [];
  for (let start = 0; start < bitmap.length; start++) {
    if (!bitmap[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % W;
      const y = (i - x) / W;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && bitmap[i - 1] && !seen[i - 1]) {
        seen[i - 1] = 1;
        stack[sp++] = i - 1;
      }
      if (x < W - 1 && bitmap[i + 1] && !seen[i + 1]) {
        seen[i + 1] = 1;
        stack[sp++] = i + 1;
      }
      if (y > 0 && bitmap[i - W] && !seen[i - W]) {
        seen[i - W] = 1;
        stack[sp++] = i - W;
      }
      if (y < H - 1 && bitmap[i + W] && !seen[i + W]) {
        seen[i + W] = 1;
        stack[sp++] = i + W;
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (Math.min(w, h) < minSize || count < 4) continue;
    let sum = 0;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) sum += prob[y * W + x];
    const score = sum / (w * h);
    if (score < boxThresh) continue;
    const d = (w * h * unclip) / (2 * (w + h));
    const x0 = Math.max(0, minX - d);
    const y0 = Math.max(0, minY - d);
    const x1 = Math.min(W, maxX + 1 + d);
    const y1 = Math.min(H, maxY + 1 + d);
    if (Math.min(x1 - x0, y1 - y0) < minSize + 2) continue;
    boxes.push({ x0, y0, x1, y1, score });
  }
  return boxes;
}

/** Group word/box records into lines by vertical overlap (reading order: top to bottom, left to right). */
function groupLines(items) {
  const sorted = [...items].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const lines = [];
  for (const item of sorted) {
    const cy = (item.y0 + item.y1) / 2;
    const h = item.y1 - item.y0;
    const line = lines.find((l) => Math.abs(cy - l.cy) < 0.5 * Math.max(h, l.h));
    if (line) {
      line.items.push(item);
      line.cy = (line.cy * (line.items.length - 1) + cy) / line.items.length;
      line.h = Math.max(line.h, h);
    } else lines.push({ cy, h, items: [item] });
  }
  return lines
    .sort((a, b) => a.cy - b.cy)
    .map((l) => {
      const words = l.items.sort((a, b) => a.x0 - b.x0);
      return {
        text: words.map((w) => w.text).join(' '),
        x0: Math.min(...words.map((w) => w.x0)),
        y0: Math.min(...words.map((w) => w.y0)),
        x1: Math.max(...words.map((w) => w.x1)),
        y1: Math.max(...words.map((w) => w.y1)),
        confidence: words.reduce((s, w) => s + w.confidence, 0) / words.length,
        words,
      };
    });
}

/** Reading order for line records: rows by vertical overlap, left to right inside a row. */
function readingOrder(items) {
  return groupLines(items).flatMap((row) => row.words);
}

// ───────────────────────────── onnxruntime-web ─────────────────────────────

const ortCache = {};
async function loadOrt(ep) {
  const key = ep === 'webgpu' ? 'webgpu' : 'wasm';
  if (!ortCache[key]) {
    const ort = await import(key === 'webgpu' ? '/ort/ort.webgpu.min.mjs' : '/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = '/ort/';
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.proxy = false;
    ortCache[key] = ort;
  }
  return ortCache[key];
}

async function createSession(ort, modelId, ep) {
  const t0 = performance.now();
  const bytes = new Uint8Array(await (await fetch(`/models/${modelId}.onnx`)).arrayBuffer());
  const t1 = performance.now();
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
    enableMemPattern: false,
  });
  return { session, fetchMs: t1 - t0, createMs: performance.now() - t1 };
}

// ───────────────────────────── PaddleOCR (PP-OCRv5 / PP-OCRv6) ─────────────────────────────

const PADDLE_DET = {
  // thresholds from each model's inference.yml PostProcess block
  'ppocrv6-det-tiny': { thresh: 0.2, boxThresh: 0.4, unclip: 1.4 },
  'ppocrv6-det-small': { thresh: 0.2, boxThresh: 0.45, unclip: 1.4 },
  'ppocrv6-det-medium': { thresh: 0.2, boxThresh: 0.45, unclip: 1.4 },
  'ppocrv5-det-mobile': { thresh: 0.3, boxThresh: 0.6, unclip: 1.5 },
  'ppocrv5-det-server': { thresh: 0.3, boxThresh: 0.6, unclip: 1.5 },
};

const paddle = {
  async init(cfg) {
    const ort = await loadOrt(cfg.ep);
    const det = await createSession(ort, cfg.det, cfg.ep);
    const rec = await createSession(ort, cfg.rec, cfg.ep);
    const dict = await (await fetch(`/dicts/${cfg.rec}.json`)).json();
    this.state = { ort, cfg, det, rec, dict };
    return {
      fetchMs: det.fetchMs + rec.fetchMs,
      createMs: det.createMs + rec.createMs,
      dictSize: dict.length,
    };
  },

  async recognize(name) {
    const { ort, cfg, det, rec, dict } = this.state;
    const { bitmap } = await loadBitmap(name);
    const timings = {};
    const t0 = performance.now();

    // ── detection ──
    const maxSide = cfg.detMaxSide ?? 2048;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const dw = Math.max(32, Math.round((bitmap.width * scale) / 32) * 32);
    const dh = Math.max(32, Math.round((bitmap.height * scale) / 32) * 32);
    const img = resizedImageData(bitmap, 0, 0, bitmap.width, bitmap.height, dw, dh);
    const input = new Float32Array(3 * dw * dh);
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    // PaddleOCR feeds BGR; mean/std are applied by channel position.
    for (let i = 0; i < dw * dh; i++) {
      input[i] = (img.data[i * 4 + 2] / 255 - mean[0]) / std[0];
      input[dw * dh + i] = (img.data[i * 4 + 1] / 255 - mean[1]) / std[1];
      input[2 * dw * dh + i] = (img.data[i * 4] / 255 - mean[2]) / std[2];
    }
    const t1 = performance.now();
    const out = await det.session.run({
      [det.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, dh, dw]),
    });
    const probTensor = out[det.session.outputNames[0]];
    const t2 = performance.now();
    const [mapH, mapW] = probTensor.dims.slice(-2);
    const boxesMap = dbBoxes(probTensor.data, mapW, mapH, { minSize: 3, ...PADDLE_DET[cfg.det] });
    const sx = bitmap.width / mapW;
    const sy = bitmap.height / mapH;
    const boxes = boxesMap.map((b) => ({
      x0: Math.max(0, b.x0 * sx),
      y0: Math.max(0, b.y0 * sy),
      x1: Math.min(bitmap.width, b.x1 * sx),
      y1: Math.min(bitmap.height, b.y1 * sy),
      score: b.score,
    }));
    timings.detPre = t1 - t0;
    timings.detRun = t2 - t1;
    timings.detPost = performance.now() - t2;

    // ── recognition ──
    const t3 = performance.now();
    const crops = boxes.map((b, index) => ({ index, box: b, ratio: (b.x1 - b.x0) / (b.y1 - b.y0) }));
    crops.sort((a, b) => a.ratio - b.ratio);
    const results = new Array(boxes.length);
    const batchSize = cfg.recBatch ?? 6;
    const H = 48;
    for (let s = 0; s < crops.length; s += batchSize) {
      const batch = crops.slice(s, s + batchSize);
      const maxRatio = Math.max(320 / 48, ...batch.map((c) => c.ratio));
      const W = Math.min(3200, Math.max(16, Math.floor(H * maxRatio)));
      const data = new Float32Array(batch.length * 3 * H * W);
      const widths = [];
      for (const [bi, c] of batch.entries()) {
        const rw = Math.max(8, Math.min(W, Math.ceil(H * c.ratio)));
        widths.push(rw);
        const b = c.box;
        const px = resizedImageData(bitmap, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, rw, H);
        const base = bi * 3 * H * W;
        for (let y = 0; y < H; y++)
          for (let x = 0; x < rw; x++) {
            const p = (y * rw + x) * 4;
            const o = y * W + x;
            // BGR, (v/255 - 0.5) / 0.5
            data[base + o] = px.data[p + 2] / 127.5 - 1;
            data[base + H * W + o] = px.data[p + 1] / 127.5 - 1;
            data[base + 2 * H * W + o] = px.data[p] / 127.5 - 1;
          }
      }
      const r = await rec.session.run({
        [rec.session.inputNames[0]]: new ort.Tensor('float32', data, [batch.length, 3, H, W]),
      });
      const logits = r[rec.session.outputNames[0]];
      const [, T, V] = logits.dims;
      const blank = 0;
      const withSpace = V === dict.length + 2;
      const chars = (idx) => (idx === blank ? '' : idx - 1 < dict.length ? dict[idx - 1] : ' ');
      void withSpace;
      for (const [bi, c] of batch.entries()) {
        const seq = [];
        let prev = -1;
        for (let t = 0; t < T; t++) {
          const o = (bi * T + t) * V;
          let best = 0;
          let bv = -Infinity;
          for (let v = 0; v < V; v++) {
            const val = logits.data[o + v];
            if (val > bv) {
              bv = val;
              best = v;
            }
          }
          if (best !== blank && best !== prev) seq.push({ ch: chars(best), p: bv, t0: t, t1: t });
          else if (best !== blank && best === prev && seq.length) {
            seq[seq.length - 1].t1 = t;
            if (bv > seq[seq.length - 1].p) seq[seq.length - 1].p = bv;
          }
          prev = best;
        }
        // Words split at emitted spaces; x positions come from the CTC frame index.
        const b = c.box;
        const boxW = b.x1 - b.x0;
        const frameToX = (frame) => b.x0 + frame * (W / T) * (boxW / widths[bi]);
        const words = [];
        let cur = [];
        const flush = () => {
          if (!cur.length) return;
          const text = cur.map((q) => q.ch).join('');
          const half = boxW / Math.max(1, seq.length) / 2;
          const x0 = Math.max(b.x0, frameToX(cur[0].t0 + 0.5) - half);
          const x1 = Math.min(b.x1, frameToX(cur[cur.length - 1].t1 + 0.5) + half);
          words.push({
            text,
            x0,
            x1,
            y0: b.y0,
            y1: b.y1,
            confidence: cur.reduce((sum, q) => sum + q.p, 0) / cur.length,
          });
          cur = [];
        };
        for (const q of seq) {
          if (q.ch === ' ') flush();
          else cur.push(q);
        }
        flush();
        for (let i = 0; i + 1 < words.length; i++) {
          if (words[i].x1 > words[i + 1].x0) {
            const mid = (words[i].x1 + words[i + 1].x0) / 2;
            words[i].x1 = mid;
            words[i + 1].x0 = mid;
          }
        }
        if (words.length) {
          words[0].x0 = b.x0;
          words[words.length - 1].x1 = b.x1;
        }
        const nonSpace = seq.filter((q) => q.ch !== ' ');
        results[c.index] = {
          text: seq
            .map((q) => q.ch)
            .join('')
            .trim(),
          x0: b.x0,
          y0: b.y0,
          x1: b.x1,
          y1: b.y1,
          confidence: nonSpace.length ? nonSpace.reduce((s, q) => s + q.p, 0) / nonSpace.length : 0,
          words,
          detScore: b.score,
        };
      }
    }
    timings.rec = performance.now() - t3;
    const lines = readingOrder(results.filter((l) => l.text.length > 0));
    timings.total = performance.now() - t0;
    return { lines, timings, extra: { detInput: [dw, dh], boxes: boxes.length } };
  },

  async dispose() {
    for (const s of [this.state?.det, this.state?.rec]) await s?.session.release?.();
    this.state = null;
  },
};

// ───────────────────────────── OnnxTR (docTR ONNX) ─────────────────────────────

const onnxtr = {
  async init(cfg) {
    const ort = await loadOrt(cfg.ep);
    const det = await createSession(ort, cfg.det, cfg.ep);
    const rec = await createSession(ort, cfg.rec, cfg.ep);
    const recCfg = await (await fetch(`/models/${cfg.rec}.config.json`)).json();
    const detCfg = await (await fetch(`/models/${cfg.det}.config.json`)).json();
    this.state = { ort, cfg, det, rec, recCfg, detCfg };
    return {
      fetchMs: det.fetchMs + rec.fetchMs,
      createMs: det.createMs + rec.createMs,
      vocab: recCfg.vocab.length,
    };
  },

  async recognize(name) {
    const { ort, cfg, det, rec, recCfg, detCfg } = this.state;
    const { bitmap } = await loadBitmap(name);
    const timings = {};
    const t0 = performance.now();
    // ── detection: letterbox into the model's fixed square input (preserve aspect, symmetric pad) ──
    const [, DH, DW] = detCfg.input_shape;
    const s = Math.min(DW / bitmap.width, DH / bitmap.height);
    const rw = Math.round(bitmap.width * s);
    const rh = Math.round(bitmap.height * s);
    const padX = Math.floor((DW - rw) / 2);
    const padY = Math.floor((DH - rh) / 2);
    const canvas = new OffscreenCanvas(DW, DH);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, DW, DH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, padX, padY, rw, rh);
    const img = ctx.getImageData(0, 0, DW, DH);
    const input = new Float32Array(3 * DW * DH);
    for (let i = 0; i < DW * DH; i++)
      for (let c = 0; c < 3; c++)
        input[c * DW * DH + i] = (img.data[i * 4 + c] / 255 - detCfg.mean[c]) / detCfg.std[c];
    const t1 = performance.now();
    const out = await det.session.run({
      [det.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DH, DW]),
    });
    const logits = out[det.session.outputNames[0]];
    const t2 = performance.now();
    const prob = new Float32Array(DW * DH);
    for (let i = 0; i < prob.length; i++) prob[i] = 1 / (1 + Math.exp(-logits.data[i]));
    const mapBoxes = dbBoxes(prob, DW, DH, {
      thresh: 0.3,
      boxThresh: cfg.boxThresh ?? 0.1,
      unclip: 1.5,
      minSize: 2,
      open: true,
    });
    const boxes = mapBoxes
      .map((b) => ({
        x0: Math.max(0, (b.x0 - padX) / s),
        y0: Math.max(0, (b.y0 - padY) / s),
        x1: Math.min(bitmap.width, (b.x1 - padX) / s),
        y1: Math.min(bitmap.height, (b.y1 - padY) / s),
        score: b.score,
      }))
      .filter((b) => b.x1 - b.x0 > 2 && b.y1 - b.y0 > 2);
    timings.detPre = t1 - t0;
    timings.detRun = t2 - t1;
    timings.detPost = performance.now() - t2;

    // ── recognition ──
    const t3 = performance.now();
    const [, RH, RW] = recCfg.input_shape;
    const isParseq = recCfg.arch === 'parseq';
    const vocab = [...recCfg.vocab];
    const embedding = isParseq ? [...vocab, '<eos>', '<sos>', '<pad>'] : vocab;
    const jobs = [];
    for (const [index, b] of boxes.entries()) {
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      // docTR splits crops whose aspect ratio exceeds 8 into overlapping windows of ratio 6.
      if (w / h > 8) {
        const splitW = Math.ceil(h * 6);
        const step = splitW - Math.floor(splitW * 0.5);
        const starts = [];
        for (let x = 0; x + splitW <= w; x += step) starts.push(x);
        if (!starts.length || starts[starts.length - 1] + splitW < w) starts.push(Math.max(0, w - splitW));
        for (const x of starts)
          jobs.push({ index, sx: b.x0 + x, sy: b.y0, sw: Math.min(splitW, w), sh: h, part: true });
      } else jobs.push({ index, sx: b.x0, sy: b.y0, sw: w, sh: h, part: false });
    }
    const texts = new Array(jobs.length);
    const batchSize = 32;
    for (let st = 0; st < jobs.length; st += batchSize) {
      const batch = jobs.slice(st, st + batchSize);
      const data = new Float32Array(batch.length * 3 * RH * RW);
      for (const [bi, j] of batch.entries()) {
        const sc = Math.min(RW / j.sw, RH / j.sh);
        const cw = Math.max(1, Math.round(j.sw * sc));
        const ch = Math.max(1, Math.round(j.sh * sc));
        const px0 = Math.floor((RW - cw) / 2);
        const py0 = Math.floor((RH - ch) / 2);
        const c = new OffscreenCanvas(RW, RH);
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.fillStyle = '#000';
        cx.fillRect(0, 0, RW, RH);
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(bitmap, j.sx, j.sy, j.sw, j.sh, px0, py0, cw, ch);
        const d = cx.getImageData(0, 0, RW, RH).data;
        const base = bi * 3 * RH * RW;
        for (let i = 0; i < RW * RH; i++)
          for (let k = 0; k < 3; k++)
            data[base + k * RW * RH + i] = (d[i * 4 + k] / 255 - recCfg.mean[k]) / recCfg.std[k];
      }
      const r = await rec.session.run({
        [rec.session.inputNames[0]]: new ort.Tensor('float32', data, [batch.length, 3, RH, RW]),
      });
      const lg = r[rec.session.outputNames[0]];
      const [, T, V] = lg.dims;
      for (const [bi] of batch.entries()) {
        let text = '';
        const probs = [];
        let prev = -1;
        for (let t = 0; t < T; t++) {
          const o = (bi * T + t) * V;
          let best = 0;
          let mx = -Infinity;
          for (let v = 0; v < V; v++)
            if (lg.data[o + v] > mx) {
              mx = lg.data[o + v];
              best = v;
            }
          let sum = 0;
          for (let v = 0; v < V; v++) sum += Math.exp(lg.data[o + v] - mx);
          const p = 1 / sum;
          if (isParseq) {
            const sym = embedding[best];
            if (sym === '<eos>' || sym === undefined) break;
            if (sym === '<sos>' || sym === '<pad>') continue;
            text += sym;
            probs.push(p);
          } else {
            // CRNN: blank is the last class
            if (best !== V - 1 && best !== prev) {
              text += embedding[best];
              probs.push(p);
            }
            prev = best;
          }
        }
        texts[st + bi] = {
          text,
          confidence: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0,
        };
      }
    }
    timings.rec = performance.now() - t3;
    const words = [];
    for (const [index, b] of boxes.entries()) {
      const parts = jobs.map((j, ji) => ({ j, t: texts[ji] })).filter((x) => x.j.index === index);
      const text = parts.map((x) => x.t.text).join('');
      if (!text.trim()) continue;
      const confs = parts.filter((x) => x.t.text).map((x) => x.t.confidence);
      words.push({
        text,
        x0: b.x0,
        y0: b.y0,
        x1: b.x1,
        y1: b.y1,
        confidence: confs.length ? Math.min(...confs) : 0,
        detScore: b.score,
      });
    }
    const lines = groupLines(words);
    timings.total = performance.now() - t0;
    return { lines, timings, extra: { detInput: [DW, DH], boxes: boxes.length, scale: s } };
  },

  async dispose() {
    for (const s of [this.state?.det, this.state?.rec]) await s?.session.release?.();
    this.state = null;
  },
};

// ───────────────────────────── Tesseract (the product's pinned build) ─────────────────────────────

const tesseract = {
  async init(cfg) {
    const t0 = performance.now();
    const module = await import('/engines/tesseract/tesseract.esm.min.js');
    const Tesseract = module.default ?? module;
    const t1 = performance.now();
    const worker = await Tesseract.createWorker(cfg.langs, 1, {
      workerPath: '/engines/tesseract/worker.min.js',
      corePath: '/engines/tesseract/tesseract-core-simd-lstm.wasm.js',
      langPath: `/engines/tesseract/lang/${cfg.quality}`,
      gzip: true,
      cacheMethod: 'none',
    });
    this.state = { worker, cfg };
    return { fetchMs: t1 - t0, createMs: performance.now() - t1 };
  },

  async recognize(name) {
    const { blob } = await loadBitmap(name);
    const t0 = performance.now();
    const { data } = await this.state.worker.recognize(
      blob,
      {},
      { blocks: true, text: false, hocr: false, tsv: false },
    );
    const lines = [];
    for (const block of data.blocks ?? [])
      for (const paragraph of block.paragraphs)
        for (const line of paragraph.lines) {
          const words = line.words
            .map((w) => ({
              text: w.text.trim(),
              x0: w.bbox.x0,
              y0: w.bbox.y0,
              x1: w.bbox.x1,
              y1: w.bbox.y1,
              confidence: w.confidence / 100,
            }))
            .filter((w) => w.text.length > 0);
          if (!words.length) continue;
          lines.push({
            text: words.map((w) => w.text).join(' '),
            x0: line.bbox.x0,
            y0: line.bbox.y0,
            x1: line.bbox.x1,
            y1: line.bbox.y1,
            confidence: line.confidence / 100,
            words,
          });
        }
    return { lines, timings: { total: performance.now() - t0 }, extra: { pageConfidence: data.confidence } };
  },

  async dispose() {
    await this.state?.worker.terminate();
    this.state = null;
  },
};

// ───────────────────────────── Layout models (ONNX) ─────────────────────────────
// Three input/output conventions, each taken from the model's own config / the pinned reference
// implementation (see docs/ocr-evaluation.md):
//
//  paddle  PP-DocLayout plus-L / V3. inference.yml: Resize 800x800 (keep_ratio false, cubic),
//          NormalizeImage mean 0 std 1 with the default is_scale (= /255), Permute (HWC->CHW), RGB.
//          Inputs `image` [1,3,800,800], `im_shape` [1,2] = [800,800], `scale_factor` [1,2] =
//          [800/h, 800/w]. Output 0 is [N, 6] = [class, score, x0, y0, x1, y1] (plus-L) or [N, 7]
//          (V3: the 7th column is the reading order), boxes already in source-image pixels;
//          output 1 is N. draw_threshold 0.5.
//  yolov8  360LayoutAnalysis YOLOv8n "general6", RapidLayout v1.2.0: plain resize to 640x640, /255,
//          RGB, output [1, 4+classes, 8400] = cx, cy, w, h, class scores; class-aware NMS.
//  e2e     DocLayout-YOLO DocStructBench: letterbox (centered, pad 114) to 1024x1024, /255, RGB,
//          output [1, N, 6] = x0, y0, x1, y1, score, class in letterboxed pixels (NMS inside the
//          graph); default conf 0.2. A raw [1, 4+classes, anchors] head is also handled.

const LAYOUT_LABELS = {
  'layout-pp-doclayout-plus-l': [
    'paragraph_title',
    'image',
    'text',
    'number',
    'abstract',
    'content',
    'figure_title',
    'formula',
    'table',
    'reference',
    'doc_title',
    'footnote',
    'header',
    'algorithm',
    'footer',
    'seal',
    'chart',
    'formula_number',
    'aside_text',
    'reference_content',
  ],
  'layout-pp-doclayout-v3': [
    'abstract',
    'algorithm',
    'aside_text',
    'chart',
    'content',
    'display_formula',
    'doc_title',
    'figure_title',
    'footer',
    'footer_image',
    'footnote',
    'formula_number',
    'header',
    'header_image',
    'image',
    'inline_formula',
    'number',
    'paragraph_title',
    'reference',
    'reference_content',
    'seal',
    'table',
    'text',
    'vertical_text',
    'vision_footnote',
  ],
  'layout-yolov8n-general6': ['Text', 'Title', 'Figure', 'Table', 'Caption', 'Equation'],
  'layout-doclayout-yolo-docstructbench': [
    'title',
    'plain text',
    'abandon',
    'figure',
    'figure_caption',
    'table',
    'table_caption',
    'table_footnote',
    'isolate_formula',
    'formula_caption',
  ],
};

function iou(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
}

/** class-aware greedy NMS over candidates sorted by score */
function nms(candidates, iouThreshold) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of sorted) if (!kept.some((k) => k.cls === c.cls && iou(k, c) > iouThreshold)) kept.push(c);
  return kept;
}

/** HWC RGBA ImageData -> CHW float32 RGB, scaled to 0..1 */
function toChw(img, w, h) {
  const input = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++)
    for (let c = 0; c < 3; c++) input[c * plane + i] = img.data[i * 4 + c] / 255;
  return input;
}

function letterbox(bitmap, size) {
  const scale = Math.min(size / bitmap.height, size / bitmap.width);
  const nw = Math.round(bitmap.width * scale);
  const nh = Math.round(bitmap.height * scale);
  const left = Math.floor((size - nw) / 2);
  const top = Math.floor((size - nh) / 2);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, left, top, nw, nh);
  return { data: ctx.getImageData(0, 0, size, size), scale, left, top };
}

const layout = {
  async init(cfg) {
    const ort = await loadOrt(cfg.ep);
    const model = await createSession(ort, cfg.model, cfg.ep);
    this.state = { ort, cfg, model };
    return {
      fetchMs: model.fetchMs,
      createMs: model.createMs,
      inputs: model.session.inputNames,
      outputs: model.session.outputNames,
    };
  },

  async recognize(name) {
    const { ort, cfg, model } = this.state;
    const { session } = model;
    const { bitmap } = await loadBitmap(name);
    const labels = LAYOUT_LABELS[cfg.model];
    const threshold = cfg.threshold;
    const t0 = performance.now();
    let feeds;
    let letter = null;
    if (cfg.layoutKind === 'paddle') {
      const S = 800;
      const img = resizedImageData(bitmap, 0, 0, bitmap.width, bitmap.height, S, S);
      feeds = {
        image: new ort.Tensor('float32', toChw(img, S, S), [1, 3, S, S]),
        im_shape: new ort.Tensor('float32', Float32Array.from([S, S]), [1, 2]),
        scale_factor: new ort.Tensor(
          'float32',
          Float32Array.from([S / bitmap.height, S / bitmap.width]),
          [1, 2],
        ),
      };
    } else if (cfg.layoutKind === 'yolov8') {
      const S = 640;
      const img = resizedImageData(bitmap, 0, 0, bitmap.width, bitmap.height, S, S);
      feeds = { [session.inputNames[0]]: new ort.Tensor('float32', toChw(img, S, S), [1, 3, S, S]) };
    } else {
      const S = 1024;
      letter = letterbox(bitmap, S);
      feeds = { [session.inputNames[0]]: new ort.Tensor('float32', toChw(letter.data, S, S), [1, 3, S, S]) };
    }
    const t1 = performance.now();
    const out = await session.run(feeds);
    const t2 = performance.now();
    const det = out[session.outputNames[0]];
    const regions = [];
    const push = (cls, score, x0, y0, x1, y1, extra = {}) => {
      if (score < threshold) return;
      regions.push({
        label: labels[cls] ?? String(cls),
        score,
        x0: Math.max(0, x0),
        y0: Math.max(0, y0),
        x1: Math.min(bitmap.width, x1),
        y1: Math.min(bitmap.height, y1),
        ...extra,
      });
    };
    if (cfg.layoutKind === 'paddle') {
      const cols = det.dims[1];
      for (let i = 0; i < det.dims[0]; i++) {
        const o = i * cols;
        push(
          det.data[o],
          det.data[o + 1],
          det.data[o + 2],
          det.data[o + 3],
          det.data[o + 4],
          det.data[o + 5],
          cols > 6 ? { order: det.data[o + 6] } : {},
        );
      }
    } else if (cfg.layoutKind === 'yolov8') {
      const [, attrs, anchors] = det.dims;
      const classes = attrs - 4;
      const sx = bitmap.width / 640;
      const sy = bitmap.height / 640;
      const candidates = [];
      for (let a = 0; a < anchors; a++) {
        let best = 0;
        let cls = 0;
        for (let c = 0; c < classes; c++) {
          const s = det.data[(4 + c) * anchors + a];
          if (s > best) {
            best = s;
            cls = c;
          }
        }
        if (best < threshold) continue;
        const cx = det.data[a];
        const cy = det.data[anchors + a];
        const w = det.data[2 * anchors + a];
        const h = det.data[3 * anchors + a];
        candidates.push({
          cls,
          score: best,
          x0: (cx - w / 2) * sx,
          y0: (cy - h / 2) * sy,
          x1: (cx + w / 2) * sx,
          y1: (cy + h / 2) * sy,
        });
      }
      for (const k of nms(candidates, 0.5)) push(k.cls, k.score, k.x0, k.y0, k.x1, k.y1);
    } else {
      const unletter = (x, y) => [(x - letter.left) / letter.scale, (y - letter.top) / letter.scale];
      if (det.dims[2] === 6) {
        for (let i = 0; i < det.dims[1]; i++) {
          const o = i * 6;
          const [x0, y0] = unletter(det.data[o], det.data[o + 1]);
          const [x1, y1] = unletter(det.data[o + 2], det.data[o + 3]);
          push(det.data[o + 5], det.data[o + 4], x0, y0, x1, y1);
        }
      } else {
        const [, attrs, anchors] = det.dims;
        const candidates = [];
        for (let a = 0; a < anchors; a++) {
          let best = 0;
          let cls = 0;
          for (let c = 0; c < attrs - 4; c++) {
            const s = det.data[(4 + c) * anchors + a];
            if (s > best) {
              best = s;
              cls = c;
            }
          }
          if (best < threshold) continue;
          const cx = det.data[a];
          const cy = det.data[anchors + a];
          const w = det.data[2 * anchors + a];
          const h = det.data[3 * anchors + a];
          const [x0, y0] = unletter(cx - w / 2, cy - h / 2);
          const [x1, y1] = unletter(cx + w / 2, cy + h / 2);
          candidates.push({ cls, score: best, x0, y0, x1, y1 });
        }
        for (const k of nms(candidates, 0.7)) push(k.cls, k.score, k.x0, k.y0, k.x1, k.y1);
      }
    }
    const t3 = performance.now();
    return {
      lines: [],
      regions,
      timings: { pre: t1 - t0, run: t2 - t1, post: t3 - t2, total: t3 - t0 },
      extra: { outputs: session.outputNames, dims: session.outputNames.map((n) => out[n].dims) },
    };
  },

  async dispose() {
    await this.state?.model.session.release?.();
    this.state = null;
  },
};

const engines = { paddle, onnxtr, tesseract, layout };
let active = null;

window.bench = {
  async env() {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    return {
      userAgent: navigator.userAgent,
      crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      webgpu: Boolean(adapter),
      webgpuInfo: adapter
        ? {
            vendor: adapter.info?.vendor,
            architecture: adapter.info?.architecture,
            description: adapter.info?.description,
          }
        : null,
    };
  },
  async init(cfg) {
    active = engines[cfg.engine];
    const t0 = performance.now();
    const details = await active.init(cfg);
    return { initMs: performance.now() - t0, ...details };
  },
  async run(name) {
    const t0 = performance.now();
    const result = await active.recognize(name);
    return { ms: performance.now() - t0, ...result };
  },
  async dispose() {
    await active?.dispose();
    active = null;
  },
};
window.benchReady = true;
