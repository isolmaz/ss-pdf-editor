/**
 * The fidelity report: every sample × mode test writes one JSON file (`writeResult`), and
 * `mergeReports` folds them into `report.json` and `report.md`. Workers run in parallel, so
 * nothing is shared between tests except the directory.
 *
 * Also a command: `node --experimental-strip-types e2e/fidelity/report.ts [dir]` (or `tsx`).
 * This file is plain erasable TypeScript with node-only imports for exactly that reason.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `test-results/fidelity/` — documents, converted PDFs, `results/*.json`, `report.*`. */
export const FIDELITY_DIR = fileURLToPath(new URL('../../test-results/fidelity/', import.meta.url));

export interface PageResult {
  page: number;
  /** 0 when the page is missing from the converted PDF or its size could not be reconciled. */
  ssim: number;
  /** The converted PDF has no such page. */
  missing?: boolean;
  /** Page sizes (points) differ by more than 2 %: not resized, not comparable. */
  sizeFailure?: { original: [number, number]; converted: [number, number] };
  /** Per-page word comparison; present only when both PDFs have the same page count. */
  words?: {
    accuracy: number | null;
    missing: string[];
    extra: string[];
    substituted: Array<[string, string]>;
  };
}

export type Verdict = 'pass' | 'fail' | 'measured' | 'error';

export interface Threshold {
  ssim: number | null;
  words: number | null;
}

export interface FidelityResult {
  sample: string;
  title: string;
  origin: string;
  ocr: boolean;
  mode: string;
  modeLabel: string;
  originalPages: number;
  convertedPages: number | null;
  pages: PageResult[];
  minSsim: number | null;
  meanSsim: number | null;
  /** Whole-document word accuracy; null when the expected text is empty. */
  wordAccuracy: number | null;
  expectedWords: number;
  actualWords: number;
  missingCount: number;
  extraCount: number;
  substitutedCount: number;
  missingFirst: string[];
  extraFirst: string[];
  threshold: Threshold;
  verdict: Verdict;
  /** One line per gated violation or recorded structural failure. */
  failures: string[];
  /** Set when the test died before it could measure (export, conversion or render failed). */
  error?: string;
  files: { docx?: string; pdf?: string };
}

const RESULTS = 'results';

export const safeName = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, '_');

export function writeResult(result: FidelityResult, dir: string = FIDELITY_DIR): void {
  const target = join(dir, RESULTS);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, `${safeName(result.sample)}__${safeName(result.mode)}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

function readResults(dir: string): FidelityResult[] {
  const target = join(dir, RESULTS);
  let names: string[];
  try {
    names = readdirSync(target)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => JSON.parse(readFileSync(join(target, name), 'utf8')) as FidelityResult);
}

const pct = (value: number | null): string => (value === null ? '–' : `${(value * 100).toFixed(1)}%`);
const ssimText = (value: number | null): string => (value === null ? '–' : value.toFixed(4));
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function thresholdText(threshold: Threshold): string {
  if (threshold.ssim === null && threshold.words === null) return 'not gated';
  const ssimPart = threshold.ssim === null ? 'SSIM –' : `SSIM ≥ ${threshold.ssim}`;
  const wordsPart = threshold.words === null ? 'words –' : `words ≥ ${threshold.words}`;
  return `${ssimPart}; ${wordsPart}`;
}

export function renderMarkdown(results: readonly FidelityResult[]): string {
  const count = (verdict: Verdict) => results.filter((r) => r.verdict === verdict).length;
  const lines = [
    '# PDF → Word export fidelity',
    '',
    '_SSIM: structural similarity of original and round-tripped page, rendered at 100 dpi in grayscale (1 = identical); min/mean are over pages. Word accuracy: 1 − word edit distance ÷ number of original words, words in reading order, line-end hyphenation joined on both sides._',
    '',
    `${results.length} sample × mode runs: ${count('pass')} pass, ${count('fail')} fail, ${count('error')} error, ${count('measured')} measured only (no gate).`,
    '',
    '| Sample | Origin | Mode | Pages (in → out) | Min SSIM | Mean SSIM | Word accuracy | Missing / extra | First 10 missing words | Threshold | Verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    lines.push(
      `| ${[
        cell(r.sample),
        cell(r.origin),
        cell(r.mode),
        `${r.originalPages} → ${r.convertedPages ?? '?'}`,
        ssimText(r.minSsim),
        ssimText(r.meanSsim),
        pct(r.wordAccuracy),
        `${r.missingCount} / ${r.extraCount}`,
        cell(r.missingFirst.join(' ')),
        cell(thresholdText(r.threshold)),
        r.verdict,
      ].join(' | ')} |`,
    );
  }
  const problems = results.filter((r) => r.failures.length > 0 || r.error);
  if (problems.length > 0) {
    lines.push('', '## Findings', '');
    for (const r of problems) {
      lines.push(`### ${r.sample} · ${r.mode} — ${r.verdict}`, '');
      if (r.error) lines.push(`- error: ${r.error.split('\n')[0]}`);
      for (const failure of r.failures) lines.push(`- ${failure}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Merge every per-test JSON under `dir` into `report.json` + `report.md`. */
export function mergeReports(dir: string = FIDELITY_DIR): { results: FidelityResult[]; failed: number } {
  const results = readResults(dir).sort(
    (a, b) => a.sample.localeCompare(b.sample, 'en') || a.mode.localeCompare(b.mode, 'en'),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(dir, 'report.md'), renderMarkdown(results));
  return { results, failed: results.filter((r) => r.verdict === 'fail' || r.verdict === 'error').length };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.argv[2] === undefined ? FIDELITY_DIR : resolve(process.argv[2]);
  const { results, failed } = mergeReports(dir);
  console.log(`fidelity report: ${results.length} result(s), ${failed} failing — ${join(dir, 'report.md')}`);
}
