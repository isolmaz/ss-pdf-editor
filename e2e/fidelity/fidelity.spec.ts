/**
 * PDF → Word export fidelity: how close is what a user gets from "Export to Word" to the
 * PDF they started from?
 *
 * Every sample (generated, public, local) × every export mode in `MODES` is one test: the
 * PDF is opened in the real app, exported through the dialog and saved, LibreOffice turns
 * the DOCX back into a PDF, and MuPDF renders both PDFs at 100 dpi. Per page the structural
 * similarity (SSIM) of the two renderings is measured, and the words of the original (or the
 * sample's ground truth, for scans) are compared with the words of the round trip.
 *
 * Run it with `pnpm fidelity` (needs `dist/` built and assembled, and LibreOffice). The
 * `fidelity` Playwright project exists only when `FIDELITY` is set, which that script does.
 *
 * Environment:
 *   LIBREOFFICE          path to soffice / soffice.exe (default: `soffice` on the PATH)
 *   FIDELITY_SAMPLES     comma-separated sample-id substrings to run (default: all)
 *   FIDELITY_MODES       comma-separated mode ids to run (default: all of `MODES`)
 *   FIDELITY_ORIGINS     comma-separated subset of generated,public,local (default: all three)
 *   E2E_WORKERS          parallel browsers, as for the rest of the suite
 *
 * Results: `test-results/fidelity/<sample>__<mode>.docx|.pdf`, one `results/*.json` per test
 * and the merged `report.json` / `report.md` (`pnpm fidelity` merges them; so does
 * `node --experimental-strip-types e2e/fidelity/report.ts`).
 *
 * Gates: `thresholds.json` maps mode → `default` and per-sample overrides to
 * `{ ssim, words }`; `null` means "measured, not gated". SSIM is gated on the worst page,
 * word accuracy on the whole document.
 *
 * Adding an export mode is one line in `MODES`: the way to pick it in the dialog.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator } from 'playwright/test';
import { expect, test } from '../test';
import { openPdf, runCommand } from '../ui-helpers';
import { compareWords, joinHyphenation, normalizeWords, resizeBilinear, ssim } from './compare';
import { localSamples, publicSamples } from './corpus';
import { toPdf } from './libreoffice';
import { type MeasuredPage, measurePdf } from './pdf-measure';
import {
  FIDELITY_DIR,
  type FidelityResult,
  type PageResult,
  safeName,
  type Threshold,
  type Verdict,
  writeResult,
} from './report';
import { type FidelitySample, generatedSamples } from './samples';

interface Mode {
  id: string;
  label: string;
  /** Pick this mode in the open "Export to Word, Excel or CSV" dialog. */
  select(region: Locator): Promise<void>;
}

const MODES: readonly Mode[] = [
  {
    id: 'flow',
    label: 'Word (DOCX)',
    select: async (region) => {
      await region.getByRole('radio', { name: /Word \(DOCX\)/ }).check();
    },
  },
];

/** A page size may differ this much (relative, per axis) and still be resampled for comparison. */
const SIZE_TOLERANCE = 0.02;
const WORD_LIST = 10;

const listEnv = (name: string): string[] | undefined => {
  const value = process.env[name]?.trim();
  return value
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : undefined;
};

const thresholdTable = JSON.parse(
  readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, Partial<Threshold>>>;

function thresholdFor(mode: string, sample: string): Threshold {
  const table = thresholdTable[mode] ?? {};
  return {
    ssim: table[sample]?.ssim ?? table.default?.ssim ?? null,
    words: table[sample]?.words ?? table.default?.words ?? null,
  };
}

async function loadSamples(): Promise<FidelitySample[]> {
  const origins = listEnv('FIDELITY_ORIGINS') ?? ['generated', 'public', 'local'];
  const loaded = [
    ...(origins.includes('generated') ? await generatedSamples() : []),
    ...(origins.includes('public') ? await publicSamples() : []),
    ...(origins.includes('local') ? await localSamples() : []),
  ];
  const wanted = listEnv('FIDELITY_SAMPLES');
  const samples = wanted ? loaded.filter((s) => wanted.some((part) => s.id.includes(part))) : loaded;
  const seen = new Set<string>();
  for (const sample of samples) {
    if (seen.has(sample.id)) throw new Error(`duplicate fidelity sample id "${sample.id}"`);
    seen.add(sample.id);
  }
  return samples;
}

const samples = await loadSamples();
const modeFilter = listEnv('FIDELITY_MODES');
const modes = modeFilter ? MODES.filter((mode) => modeFilter.includes(mode.id)) : MODES;

test.use({
  viewport: { width: 1440, height: 900 },
  // MuPDF prints its own warnings on real-world files ("console: warning: …"); they are not app errors.
  allowedErrors: [/^console: warning: /],
});
test.describe.configure({ timeout: 900_000 });

/** The original is measured once per worker and sample; its modes run back to back. */
let originalCache: { id: string; pages: MeasuredPage[] } | undefined;
async function measureOriginal(sample: FidelitySample): Promise<MeasuredPage[]> {
  if (originalCache?.id !== sample.id) {
    originalCache = { id: sample.id, pages: await measurePdf(sample.bytes) };
  }
  return originalCache.pages;
}

const pct = (value: number | null): string => (value === null ? '–' : `${(value * 100).toFixed(1)}%`);
const preview = (words: readonly string[], n = 8): string =>
  `[${words.slice(0, n).join(' ')}${words.length > n ? ' …' : ''}]`;

/** Export the open document as DOCX through the dialog and save the download. */
async function exportThroughUi(
  page: Parameters<typeof openPdf>[0],
  sample: FidelitySample,
  mode: Mode,
  docxPath: string,
): Promise<void> {
  await openPdf(page, `${safeName(sample.id)}.pdf`, sample.bytes);
  await runCommand(page, 'Export to Word');
  const form = page.getByRole('region', { name: 'Export to Word, Excel or CSV' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await mode.select(form);
  const download = form.getByRole('button', { name: 'Download', exact: true });
  await download.click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 600_000 });
  const saved = page.waitForEvent('download', { timeout: 120_000 });
  await download.click();
  const file = await saved;
  expect(file.suggestedFilename()).toMatch(/\.docx$/);
  await file.saveAs(docxPath);
}

function measure(
  sample: FidelitySample,
  original: readonly MeasuredPage[],
  converted: readonly MeasuredPage[],
  threshold: Threshold,
): Pick<
  FidelityResult,
  | 'pages'
  | 'minSsim'
  | 'meanSsim'
  | 'wordAccuracy'
  | 'expectedWords'
  | 'actualWords'
  | 'missingCount'
  | 'extraCount'
  | 'substitutedCount'
  | 'missingFirst'
  | 'extraFirst'
  | 'failures'
  | 'verdict'
> {
  const notes: string[] = [];
  const violations: string[] = [];
  const truth = sample.ocr && sample.groundTruth ? sample.groundTruth : undefined;
  const expectedPages = original.map((p, i) =>
    normalizeWords(truth ? joinHyphenation(truth[i] ?? '') : p.text),
  );
  const actualPages = converted.map((p) => normalizeWords(p.text));
  const samePageCount = original.length === converted.length;
  if (!samePageCount) {
    const note = `page count ${original.length} → ${converted.length}`;
    notes.push(note);
    violations.push(note);
  }

  const pages: PageResult[] = original.map((source, index) => {
    const result: PageResult = { page: index + 1, ssim: 0 };
    const target = converted[index];
    if (!target) {
      result.missing = true;
      notes.push(`page ${index + 1}: absent from the converted PDF (SSIM counted as 0)`);
      return result;
    }
    const dw = Math.abs(target.gray.width - source.gray.width) / source.gray.width;
    const dh = Math.abs(target.gray.height - source.gray.height) / source.gray.height;
    if (dw > SIZE_TOLERANCE || dh > SIZE_TOLERANCE) {
      result.sizeFailure = {
        original: [Math.round(source.size[0]), Math.round(source.size[1])],
        converted: [Math.round(target.size[0]), Math.round(target.size[1])],
      };
      notes.push(
        `page ${index + 1}: page-size failure, ${result.sizeFailure.original.join('×')} pt → ${result.sizeFailure.converted.join('×')} pt (SSIM counted as 0)`,
      );
      return result;
    }
    result.ssim = ssim(source.gray, resizeBilinear(target.gray, source.gray.width, source.gray.height));
    return result;
  });

  if (samePageCount) {
    for (const entry of pages) {
      const expected = expectedPages[entry.page - 1] ?? [];
      if (expected.length === 0) continue;
      const diff = compareWords(expected, actualPages[entry.page - 1] ?? []);
      entry.words = {
        accuracy: diff.accuracy,
        missing: diff.missing,
        extra: diff.extra,
        substituted: diff.substituted,
      };
    }
  }

  const minSsim = threshold.ssim;
  if (minSsim !== null) {
    for (const entry of pages) {
      if (entry.ssim >= minSsim) continue;
      const words = entry.words;
      violations.push(
        `page ${entry.page}: SSIM ${entry.ssim.toFixed(4)} < ${minSsim}` +
          (words
            ? `; words ${pct(words.accuracy)}, missing ${words.missing.length} ${preview(words.missing)}, extra ${words.extra.length} ${preview(words.extra)}`
            : ''),
      );
    }
  }

  const expectedAll = expectedPages.flat();
  const actualAll = actualPages.flat();
  const total = expectedAll.length > 0 ? compareWords(expectedAll, actualAll) : undefined;
  const wordAccuracy = total?.accuracy ?? null;
  if (threshold.words !== null) {
    if (!total) {
      violations.push('word accuracy is gated but the original has no text to compare with');
    } else if (total.accuracy < threshold.words) {
      violations.push(
        `word accuracy ${pct(total.accuracy)} < ${pct(threshold.words)}: missing ${total.missing.length} ${preview(total.missing)}, extra ${total.extra.length} ${preview(total.extra)}, substituted ${total.substituted.length} ${preview(
          total.substituted.map(([a, b]) => `${a}→${b}`),
          5,
        )}`,
      );
    }
  }

  const ssims = pages.map((p) => p.ssim);
  const gated = threshold.ssim !== null || threshold.words !== null;
  const verdict: Verdict = gated ? (violations.length > 0 ? 'fail' : 'pass') : 'measured';
  return {
    pages,
    minSsim: ssims.length > 0 ? Math.min(...ssims) : null,
    meanSsim: ssims.length > 0 ? ssims.reduce((a, b) => a + b, 0) / ssims.length : null,
    wordAccuracy,
    expectedWords: expectedAll.length,
    actualWords: actualAll.length,
    missingCount: total?.missing.length ?? 0,
    extraCount: total?.extra.length ?? 0,
    substitutedCount: total?.substituted.length ?? 0,
    missingFirst: total?.missing.slice(0, WORD_LIST) ?? [],
    extraFirst: total?.extra.slice(0, WORD_LIST) ?? [],
    failures: [...new Set([...notes, ...violations])],
    verdict,
  };
}

for (const sample of samples) {
  for (const mode of modes) {
    test(`${sample.id} [${mode.id}]`, async ({ page }) => {
      const base = `${safeName(sample.id)}__${safeName(mode.id)}`;
      const docxPath = join(FIDELITY_DIR, `${base}.docx`);
      const threshold = thresholdFor(mode.id, sample.id);
      const identity = {
        sample: sample.id,
        title: sample.title,
        origin: sample.origin,
        ocr: sample.ocr,
        mode: mode.id,
        modeLabel: mode.label,
        threshold,
      };
      let original: MeasuredPage[] = [];
      let written = false;
      try {
        original = await measureOriginal(sample);
        await exportThroughUi(page, sample, mode, docxPath);
        const pdfPath = await toPdf(docxPath, FIDELITY_DIR);
        const converted = await measurePdf(new Uint8Array(readFileSync(pdfPath)));
        const measured = measure(sample, original, converted, threshold);
        const result: FidelityResult = {
          ...identity,
          originalPages: original.length,
          convertedPages: converted.length,
          ...measured,
          files: { docx: `${base}.docx`, pdf: `${base}.pdf` },
        };
        writeResult(result);
        written = true;
        if (result.verdict === 'fail') {
          throw new Error(
            `${sample.id} [${mode.id}] is below its fidelity threshold:\n${result.failures.join('\n')}`,
          );
        }
      } catch (error) {
        // A gated failure has already written its result; anything else died before measuring.
        if (!written) {
          const message = error instanceof Error ? error.message : String(error);
          writeResult({
            ...identity,
            originalPages: original.length,
            convertedPages: null,
            pages: [],
            minSsim: null,
            meanSsim: null,
            wordAccuracy: null,
            expectedWords: 0,
            actualWords: 0,
            missingCount: 0,
            extraCount: 0,
            substitutedCount: 0,
            missingFirst: [],
            extraFirst: [],
            verdict: 'error',
            failures: [],
            error: message,
            files: {},
          });
        }
        throw error;
      }
    });
  }
}
