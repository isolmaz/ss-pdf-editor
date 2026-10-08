// Scores WORK/results/*.json against the ground truth and prints/saves the comparison tables.
//
//   node tools/measure/ocr/score.mjs            → WORK/results/summary.json + summary.md (and stdout)
//
// Metrics (all micro-averaged over the images an engine was run on):
//  - CER: Levenshtein distance over characters / GT characters. GT and prediction are
//    normalised first (NFC, curly quotes/dashes folded, whitespace collapsed, line breaks → space,
//    and for the CV `|` removed: the vertical dividers in that layout are drawing, not text).
//  - WER: Levenshtein over whitespace-separated tokens / GT tokens.
//  - Turkish-letter recall: of the GT occurrences of ç ğ ı İ ö ş ü Ç Ğ Ö Ş Ü â, the share that the
//    character alignment marks as correctly recognised.
//  - Word-box IoU (synthetic images only): vs the ink box of each GT word, for words matched by text.
//  - Low-confidence evidence: a predicted word is "right" when the word alignment pairs it with an
//    identical GT word; for each threshold, flagged = confidence < threshold.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR, TESTSET_DIR } from './lib.mjs';

const LICENCE = {
  tess: 'Apache-2.0 (tesseract.js, core, tessdata)',
  paddle: 'Apache-2.0 (code + weights)',
  onnxtr: 'Apache-2.0 (OnnxTR/docTR code + weights)',
};
const TR_LETTERS = [...'çğıİöşüÇĞÖŞÜâ'];
const PHOTO_PT = [32, 38, 171, 217]; // photo of the CV, page points (read from the crops)
const CV_SCALE = 1818 / 1190;

export function normalise(text, { stripPipes = false } = {}) {
  let t = text
    .normalize('NFC')
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—−‐‑]/g, '-')
    .replace(/[\u200b\u00ad\ufeff]/g, '');
  if (stripPipes) t = t.replace(/[|¦│]/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** Levenshtein with backtrace. Returns { distance, ops } where ops[i] describes GT index i: 'm' | 's' | 'd'. */
export function align(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const dir = new Uint8Array((n + 1) * (m + 1));
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    dir[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    dir[i * (m + 1)] = 2;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      let best = sub;
      let d = ref[i - 1] === hyp[j - 1] ? 0 : 1; // 0 match, 1 substitute
      if (del < best) {
        best = del;
        d = 2;
      }
      if (ins < best) {
        best = ins;
        d = 3;
      }
      cur[j] = best;
      dir[i * (m + 1) + j] = d;
    }
    [prev, cur] = [cur, prev];
  }
  const distance = prev[m];
  const refOps = new Array(n);
  const pairs = []; // [refIndex, hypIndex] for match/substitute
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const d = dir[i * (m + 1) + j];
    if (i > 0 && j > 0 && (d === 0 || d === 1)) {
      refOps[i - 1] = d === 0 ? 'm' : 's';
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (i > 0 && (d === 2 || j === 0)) {
      refOps[i - 1] = 'd';
      i--;
    } else j--;
  }
  return { distance, refOps, pairs: pairs.reverse() };
}

/** Word alignment where a substitution between similar words is cheaper than delete+insert. */
function alignWords(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const cost = (a, b) => {
    if (a === b) return 0;
    const maxLen = Math.max(a.length, b.length);
    return 0.4 + 0.6 * Math.min(1, charDistance(a, b) / maxLen);
  };
  const dp = new Float32Array((n + 1) * (m + 1));
  const dir = new Uint8Array((n + 1) * (m + 1));
  for (let j = 1; j <= m; j++) {
    dp[j] = j;
    dir[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    dp[i * (m + 1)] = i;
    dir[i * (m + 1)] = 2;
    for (let j = 1; j <= m; j++) {
      const sub = dp[(i - 1) * (m + 1) + j - 1] + cost(ref[i - 1], hyp[j - 1]);
      const del = dp[(i - 1) * (m + 1) + j] + 1;
      const ins = dp[i * (m + 1) + j - 1] + 1;
      let best = sub;
      let d = 0;
      if (del < best) {
        best = del;
        d = 2;
      }
      if (ins < best) {
        best = ins;
        d = 3;
      }
      dp[i * (m + 1) + j] = best;
      dir[i * (m + 1) + j] = d;
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const d = dir[i * (m + 1) + j];
    if (i > 0 && j > 0 && d === 0) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (i > 0 && (d === 2 || j === 0)) i--;
    else j--;
  }
  return pairs.reverse();
}

function charDistance(a, b) {
  const m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++)
      cur[j] = Math.min(prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
    prev = cur;
  }
  return prev[m];
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter || 1);
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length === 0
    ? Number.NaN
    : s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const gt = JSON.parse(readFileSync(path.join(TESTSET_DIR, 'gt.json'), 'utf8'));
const gtById = new Map(gt.images.map((i) => [i.id, i]));
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98];

function scoreImage(image, run) {
  const strip = image.kind === 'cv';
  const refText = normalise(image.lines.join(' '), { stripPipes: strip });
  const predWords = run.lines.flatMap((l) => l.words ?? []);
  const hypText = normalise(run.lines.map((l) => l.text).join(' '), { stripPipes: strip });
  const refChars = [...refText];
  const a = align(refChars, [...hypText]);
  const refTokens = refText.split(' ').filter(Boolean);
  const hypTokens = hypText.split(' ').filter(Boolean);
  const wordDistance = alignWordsDistance(refTokens, hypTokens);
  const letters = {};
  for (const l of TR_LETTERS) letters[l] = { total: 0, ok: 0 };
  for (const [i, ch] of refChars.entries())
    if (letters[ch]) {
      letters[ch].total++;
      if (a.refOps[i] === 'm') letters[ch].ok++;
    }

  // word-level alignment for confidence + boxes
  const predNorm = predWords.map((w) => normalise(w.text, { stripPipes: strip })).map((t) => t);
  const keep = predNorm.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  const predTok = keep.map((i) => predNorm[i]);
  const pairs = alignWords(refTokens, predTok);
  const wordInfo = predTok.map((t, k) => ({ conf: predWords[keep[k]].confidence, ok: false, text: t }));
  const refWordBoxes = strip ? null : image.words.filter((w) => w.text.length > 0);
  const ious = [];
  for (const [ri, pk] of pairs) {
    if (refTokens[ri] === predTok[pk]) wordInfo[pk].ok = true;
    if (!strip && refWordBoxes[ri]?.box && refTokens[ri] === predTok[pk]) {
      const p = predWords[keep[pk]];
      ious.push(iou(refWordBoxes[ri].box, [p.x0, p.y0, p.x1, p.y1]));
    }
  }
  let boxHits = 0;
  if (!strip) {
    for (const w of refWordBoxes) {
      if (!w.box) continue;
      if (predWords.some((p) => iou(w.box, [p.x0, p.y0, p.x1, p.y1]) >= 0.5)) boxHits++;
    }
  }
  // CV: words whose centre falls on the photo
  let photoWords = 0;
  if (strip) {
    const px = PHOTO_PT.map((v) => v * CV_SCALE);
    for (const p of predWords) {
      const cx = (p.x0 + p.x1) / 2;
      const cy = (p.y0 + p.y1) / 2;
      if (cx >= px[0] && cx <= px[2] && cy >= px[1] && cy <= px[3]) photoWords++;
    }
  }
  return {
    refLen: refChars.length,
    edits: a.distance,
    refWords: refTokens.length,
    wordEdits: wordDistance,
    letters,
    wordInfo,
    ious,
    boxHits,
    boxTotal: strip ? 0 : refWordBoxes.filter((w) => w.box).length,
    photoWords,
    hypLen: [...hypText].length,
  };
}

function alignWordsDistance(ref, hyp) {
  // exact token Levenshtein (integer costs) for WER
  const n = ref.length;
  const m = hyp.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++)
      cur[j] = Math.min(prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
    prev = cur;
  }
  return prev[m];
}

function aggregate(items) {
  const sum = (f) => items.reduce((s, x) => s + f(x), 0);
  const letters = {};
  for (const l of TR_LETTERS)
    letters[l] = { total: sum((x) => x.letters[l].total), ok: sum((x) => x.letters[l].ok) };
  const trTotal = TR_LETTERS.reduce((s, l) => s + letters[l].total, 0);
  const trOk = TR_LETTERS.reduce((s, l) => s + letters[l].ok, 0);
  const ious = items.flatMap((x) => x.ious);
  return {
    cer: sum((x) => x.edits) / sum((x) => x.refLen),
    wer: sum((x) => x.wordEdits) / sum((x) => x.refWords),
    trRecall: trTotal ? trOk / trTotal : Number.NaN,
    letters,
    iouMean: ious.length ? ious.reduce((a, b) => a + b, 0) / ious.length : Number.NaN,
    boxRecall: sum((x) => x.boxTotal) ? sum((x) => x.boxHits) / sum((x) => x.boxTotal) : Number.NaN,
    insertedChars: sum((x) => Math.max(0, x.hypLen - x.refLen)),
    photoWords: sum((x) => x.photoWords),
  };
}

function confidenceTable(infos) {
  const wrong = infos.filter((w) => !w.ok).length;
  return {
    words: infos.length,
    wrongWords: wrong,
    rows: THRESHOLDS.map((theta) => {
      const flagged = infos.filter((w) => w.conf < theta);
      const flaggedWrong = flagged.filter((w) => !w.ok).length;
      return {
        theta,
        flaggedShare: flagged.length / infos.length,
        precision: flagged.length ? flaggedWrong / flagged.length : Number.NaN,
        recall: wrong ? flaggedWrong / wrong : Number.NaN,
      };
    }),
  };
}

const SYN_GROUPS = {
  'clean ≥11 pt': (s) => s.cond === 'clean' && s.size >= 11 && s.kind === 'prose',
  'small 8–10 pt clean': (s) => s.cond === 'clean' && s.size <= 10,
  'noise/blur': (s) => ['noise', 'blur', 'noiseblur'].includes(s.cond),
  'card / dark': (s) => ['cardblue', 'dark', 'darknoise', 'cardteal'].includes(s.cond),
  'ALL CAPS': (s) => s.kind === 'caps',
  'digits/mixed': (s) => s.kind === 'mixed',
};

const summary = {};
for (const file of readdirSync(RESULTS_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'summary.json')
  .sort()) {
  const result = JSON.parse(readFileSync(path.join(RESULTS_DIR, file), 'utf8'));
  if (result.config.layout) continue;
  const scored = new Map();
  for (const run of result.runs) {
    if (run.repeat > 0) continue;
    const image = gtById.get(run.id);
    scored.set(run.id, { image, s: scoreImage(image, run) });
  }
  const syn = [...scored.values()].filter((x) => x.image.kind === 'synthetic');
  const cv = scored.get('cv');
  const cvRuns = result.runs.filter((r) => r.id === 'cv');
  const synRuns = result.runs.filter((r) => r.id !== 'cv');
  const groups = {};
  for (const [name, pred] of Object.entries(SYN_GROUPS)) {
    const members = syn.filter((x) => pred(x.image.spec));
    if (members.length) groups[name] = aggregate(members.map((x) => x.s)).cer;
  }
  const family = result.config.engine === 'tesseract' ? 'tess' : result.config.engine;
  summary[result.name] = {
    images: scored.size,
    synthetic: syn.length ? aggregate(syn.map((x) => x.s)) : null,
    cv: cv ? aggregate([cv.s]) : null,
    all: aggregate([...scored.values()].map((x) => x.s)),
    groups,
    confidence: confidenceTable([...scored.values()].flatMap((x) => x.s.wordInfo)),
    confidenceCv: cv ? confidenceTable(cv.s.wordInfo) : null,
    perImageCer: Object.fromEntries([...scored].map(([id, x]) => [id, x.s.edits / x.s.refLen])),
    coldMs: cvRuns[0] ? result.init.initMs + cvRuns[0].ms : null,
    initMs: result.init.initMs,
    warmCvMs: median(cvRuns.slice(1).map((r) => r.ms)),
    warmSynMsMedian: median(synRuns.map((r) => r.ms)),
    detRunCvMs: median(cvRuns.slice(1).map((r) => r.timings?.detRun ?? Number.NaN)),
    recCvMs: median(cvRuns.slice(1).map((r) => r.timings?.rec ?? Number.NaN)),
    downloadMB: result.sizes.gzipBytes / 1e6,
    rawMB: result.sizes.rawBytes / 1e6,
    ep: result.config.ep ?? 'wasm',
    licence: LICENCE[family],
    cvLines: cvRuns[0]?.lines.length ?? null,
  };
}

writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 1));

const pct = (x, d = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '–');
const lines = [];
lines.push(
  '| config | EP | CER syn | CER CV | TR recall (all) | WER (all) | cold ms (CV) | warm ms/page (CV) | download MB (gzip) | licence |',
);
lines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const [name, r] of Object.entries(summary)) {
  lines.push(
    `| ${name} | ${r.ep} | ${pct(r.synthetic?.cer)} | ${pct(r.cv?.cer)} | ${pct(r.all.trRecall, 1)} | ${pct(r.all.wer, 1)} | ${r.coldMs?.toFixed(0)} | ${r.warmCvMs.toFixed(0)} | ${r.downloadMB.toFixed(1)} | ${r.licence ?? ''} |`,
  );
}
lines.push('');
lines.push(
  `| config | ${Object.keys(SYN_GROUPS).join(' | ')} | box IoU (matched words) | box recall@0.5 | photo words (CV) |`,
);
lines.push(
  `|---|${Object.keys(SYN_GROUPS)
    .map(() => '---')
    .join('|')}|---|---|---|`,
);
for (const [name, r] of Object.entries(summary)) {
  lines.push(
    `| ${name} | ${Object.keys(SYN_GROUPS)
      .map((g) => pct(r.groups[g]))
      .join(
        ' | ',
      )} | ${Number.isFinite(r.synthetic?.iouMean) ? r.synthetic.iouMean.toFixed(2) : '–'} | ${pct(r.synthetic?.boxRecall, 1)} | ${r.cv?.photoWords ?? '–'} |`,
  );
}
lines.push('');
lines.push('Per-letter recall (all images pooled):');
lines.push('');
lines.push(`| config | ${TR_LETTERS.join(' | ')} |`);
lines.push(`|---|${TR_LETTERS.map(() => '---').join('|')}|`);
for (const [name, r] of Object.entries(summary)) {
  lines.push(
    `| ${name} | ${TR_LETTERS.map((l) => pct(r.all.letters[l].total ? r.all.letters[l].ok / r.all.letters[l].total : Number.NaN, 1)).join(' | ')} |`,
  );
}
lines.push('');
lines.push(
  'Low-confidence flagging (pooled over all images; precision = share of flagged words that are wrong, recall = share of wrong words flagged):',
);
lines.push('');
for (const [name, r] of Object.entries(summary)) {
  lines.push(
    `**${name}** — ${r.confidence.words} words, ${r.confidence.wrongWords} wrong (${pct(r.confidence.wrongWords / r.confidence.words, 1)})`,
  );
  lines.push('');
  lines.push('| θ | flagged | precision | recall |');
  lines.push('|---|---|---|---|');
  for (const row of r.confidence.rows)
    lines.push(
      `| ${row.theta} | ${pct(row.flaggedShare, 1)} | ${pct(row.precision, 1)} | ${pct(row.recall, 1)} |`,
    );
  lines.push('');
}
writeFileSync(path.join(RESULTS_DIR, 'summary.md'), lines.join('\n'));
console.log(lines.join('\n'));
