// Lists the words an engine got wrong on one image: ground-truth word → predicted word (+ confidence).
// Useful for auditing the CV transcript: where several engines agree against the GT, re-read the crop.
//
//   node tools/measure/ocr/diff-words.mjs tess-tur-best cv
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR, TESTSET_DIR } from './lib.mjs';

const [name, id = 'cv'] = process.argv.slice(2);
const gt = JSON.parse(readFileSync(path.join(TESTSET_DIR, 'gt.json'), 'utf8')).images.find(
  (i) => i.id === id,
);
const result = JSON.parse(readFileSync(path.join(RESULTS_DIR, `${name}.json`), 'utf8'));
const run = result.runs.find((r) => r.id === id);
const norm = (t) => t.normalize('NFC').replace(/[|¦]/g, ' ').replace(/\s+/g, ' ').trim();
const ref = norm(gt.lines.join(' ')).split(' ').filter(Boolean);
const hyp = run.lines
  .flatMap((l) => l.words ?? [])
  .map((w) => ({ t: norm(w.text), c: w.confidence }))
  .filter((w) => w.t);

// token alignment (unit costs)
const n = ref.length;
const m = hyp.length;
const dp = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
for (let i = 0; i <= n; i++) dp[i][0] = i;
for (let j = 0; j <= m; j++) dp[0][j] = j;
for (let i = 1; i <= n; i++)
  for (let j = 1; j <= m; j++)
    dp[i][j] = Math.min(
      dp[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1].t ? 0 : 1),
      dp[i - 1][j] + 1,
      dp[i][j - 1] + 1,
    );
let i = n;
let j = m;
const out = [];
while (i > 0 || j > 0) {
  if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1].t ? 0 : 1)) {
    if (ref[i - 1] !== hyp[j - 1].t)
      out.push(`${ref[i - 1]}  →  ${hyp[j - 1].t}   (conf ${hyp[j - 1].c.toFixed(2)})  @ ref word ${i - 1}`);
    i--;
    j--;
  } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
    out.push(`${ref[i - 1]}  →  (missing)  @ ref word ${i - 1}`);
    i--;
  } else {
    out.push(`(extra)  →  ${hyp[j - 1].t}   (conf ${hyp[j - 1].c.toFixed(2)})`);
    j--;
  }
}
console.log(`${name} ${id}: ${out.length} word differences`);
console.log(out.reverse().join('\n'));
