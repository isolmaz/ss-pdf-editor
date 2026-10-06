/**
 * Document comparison, engine only (`ops/compare.ts`): does the text diff name the line
 * that changed and stay silent about the page that did not, does the rendered comparison
 * see a one-word edit in pixels while calling the untouched page identical, is a
 * page-count difference reported rather than truncated away, and is a bound that was hit
 * reported as `truncated`?
 *
 * Usage: `npx tsx tools/spikes/compare-probe.mts`
 *
 * Two environment shims, both measured, neither product behaviour:
 *
 *  - **pdf.js's worker.** The adapter points `GlobalWorkerOptions.workerSrc` at
 *    `/engines/pdfjs/pdf.worker.mjs` — an HTTP root a Node process does not have, and
 *    without the legacy Node path pdf.js refuses to set up its fake worker
 *    ("Setting up fake worker failed", measured). So the worker file inside the
 *    installed package is used instead. The adapter assigns `workerSrc` when it first
 *    imports pdf.js, so a plain assignment here would win or lose by import order; the
 *    property is pinned with a no-op setter to make the outcome deterministic.
 *  - **The raster surface.** `@napi-rs/canvas` is pdfjs-dist's **own optional
 *    dependency** (it ships for exactly this), resolved through pdfjs-dist's dependency
 *    link instead of being installed here — no dependency is added to the workspace. A
 *    missing binary fails the probe loudly rather than skipping a check. The wrapper
 *    supplies `style`, which the adapter writes and a native canvas does not have.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as mupdf from 'mupdf';
import { type CompareCanvas, compareText, compareVisual } from 'pdf-core/ops/compare';
import { ToolError } from 'pdf-shared';
import * as pdfjs from 'pdfjs-dist';
import { createFixture } from './mupdf-fixture.mjs';

const require = createRequire(import.meta.resolve('pdfjs-dist'));
const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
{
  const pinned = pathToFileURL(workerPath).href;
  Object.defineProperty(pdfjs.GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    enumerable: true,
    get: () => pinned,
    // The adapter's browser-relative `/engines/...` path is meaningless in Node.
    set: () => undefined,
  });
}

interface NativeCanvasModule {
  createCanvas(width: number, height: number): unknown;
}

let nativeCanvas: NativeCanvasModule;
try {
  nativeCanvas = (await import(pathToFileURL(require.resolve('@napi-rs/canvas')).href)) as NativeCanvasModule;
} catch (error) {
  throw new Error(
    `@napi-rs/canvas (pdfjs-dist's own optional dependency) could not be loaded: ${(error as Error).message}`,
  );
}

/**
 * A DOM-shaped canvas over the native one: the adapter writes `canvas.style.width`, which
 * a native canvas does not have, and every method must keep its receiver when proxied.
 */
function createCanvas(): CompareCanvas {
  const target = nativeCanvas.createCanvas(1, 1) as unknown as Record<string, unknown>;
  const style: Record<string, string> = {};
  return new Proxy(target, {
    get: (source, property) => {
      if (property === 'style') return style;
      const value = Reflect.get(source, property, source);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(source) : value;
    },
    set: (source, property, value) => Reflect.set(source, property, value, source),
  }) as unknown as CompareCanvas;
}

const dir = join(tmpdir(), `pdf-editor-compare-${String(process.pid)}`);
mkdirSync(dir, { recursive: true });

/** The line both non-oversized documents carry, and the one the copy replaces it with. */
const SHARED_LINE = 'Orijinal satir burada';
const CHANGED_LINE = 'Degisen satir burada';

const PAGE_SIZE: [number, number] = [500, 400];
const BODY_SIZE = 18;
const BODY_LEADING = 26;

/** Page 1 carries the editable line, page 2 is byte-for-byte the same in every variant. */
const PAGE_ONE_LINES = ['Baslik: karsilastirma', SHARED_LINE, 'Ortak satir', 'Son satir'];
const PAGE_TWO_LINES = ['Ikinci sayfa', 'Bu sayfa hic degismedi'];

async function buildDocument(pages: readonly (readonly string[])[]): Promise<Uint8Array> {
  const doc = createFixture(mupdf);
  for (const lines of pages) {
    const page = doc.addPage(PAGE_SIZE[0], PAGE_SIZE[1]);
    for (const [index, line] of lines.entries()) {
      page.text(line, {
        x: 40,
        y: PAGE_SIZE[1] - 60 - index * BODY_LEADING,
        size: BODY_SIZE,
      });
    }
  }
  return doc.save();
}

/** The oversized pair: one page of 560 lines, every line different on the two sides. */
const OVERSIZED_LINES = 560;

async function buildOversized(prefix: string): Promise<Uint8Array> {
  const lines = [...Array(OVERSIZED_LINES).keys()].map((index) => `${prefix} satir ${String(index + 1)}`);
  const height = OVERSIZED_LINES * 6 + 40;
  const doc = createFixture(mupdf);
  const page = doc.addPage(400, height);
  for (const [index, line] of lines.entries()) {
    page.text(line, { x: 20, y: height - 20 - index * 6, size: 5 });
  }
  return doc.save();
}

/** One line of 200 words per side: past the word-level matrix cap either way it splits. */
const WORD_LINE_WORDS = 200;

async function buildLongLine(prefix: string): Promise<Uint8Array> {
  const words = [...Array(WORD_LINE_WORDS).keys()].map((index) => `${prefix}${String(index + 1)}`);
  const doc = createFixture(mupdf);
  doc.addPage(2400, 120).text(words.join(' '), { x: 20, y: 60, size: 6 });
  return doc.save();
}

const base = await buildDocument([PAGE_ONE_LINES, PAGE_TWO_LINES]);
const changed = await buildDocument([
  PAGE_ONE_LINES.map((line) => (line === SHARED_LINE ? CHANGED_LINE : line)),
  PAGE_TWO_LINES,
]);
const extra = await buildDocument([PAGE_ONE_LINES, PAGE_TWO_LINES, ['Ucuncu sayfa', 'Bu sayfa fazladan']]);
const oversizedLeft = await buildOversized('Sol');
const oversizedRight = await buildOversized('Sag');
const longLineLeft = await buildLongLine('alfa');
const longLineRight = await buildLongLine('beta');
writeFileSync(join(dir, 'base.pdf'), base);
writeFileSync(join(dir, 'changed.pdf'), changed);
writeFileSync(join(dir, 'extra.pdf'), extra);
writeFileSync(join(dir, 'oversized-left.pdf'), oversizedLeft);
writeFileSync(join(dir, 'oversized-right.pdf'), oversizedRight);

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = async (name: string, fn: () => Promise<string> | string) => {
  try {
    checks.push({ name, ok: true, detail: await fn() });
  } catch (error) {
    checks.push({ name, ok: false, detail: String((error as Error)?.message ?? error).slice(0, 300) });
  }
  const entry = checks.at(-1);
  if (entry === undefined) return;
  console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${name} — ${entry.detail}`);
};

function context(signal: AbortSignal = new AbortController().signal) {
  return { signal, onProgress: () => undefined };
}

await check('text: the changed page names the changed line, at word level', async () => {
  const result = await compareText(base, changed, context());
  const page = result.pages[0];
  if (page === undefined || page.status !== 'changed') {
    throw new Error(`page 1 is ${String(page?.status)}`);
  }
  if (page.changed !== 1 || page.added !== 0 || page.removed !== 0) {
    throw new Error(
      `counts: changed ${String(page.changed)}, added ${String(page.added)}, removed ${String(page.removed)}`,
    );
  }
  const change = page.lines[0];
  if (change === undefined || change.kind !== 'changed') {
    throw new Error(`first change is ${String(change?.kind)}`);
  }
  if (change.text !== CHANGED_LINE || change.previous !== SHARED_LINE) {
    throw new Error(`named "${String(change.previous)}" -> "${change.text}"`);
  }
  const removed = (change.words ?? []).filter((word) => word.kind === 'removed').map((word) => word.text);
  const added = (change.words ?? []).filter((word) => word.kind === 'added').map((word) => word.text);
  if (removed.join() !== 'Orijinal' || added.join() !== 'Degisen') {
    throw new Error(`words: removed ${removed.join('|')}, added ${added.join('|')}`);
  }
  if (change.leftLine !== 2 || change.rightLine !== 2) {
    throw new Error(`line numbers ${String(change.leftLine)}/${String(change.rightLine)}`);
  }
  return `line ${String(change.leftLine)}: "${change.previous}" -> "${change.text}", words -${removed.join('|')} +${added.join('|')}`;
});

await check('text: the identical page reports zero changes', async () => {
  const result = await compareText(base, changed, context());
  const page = result.pages[1];
  if (page === undefined || page.status !== 'identical') {
    throw new Error(`page 2 is ${String(page?.status)}`);
  }
  if (page.changed !== 0 || page.added !== 0 || page.removed !== 0 || page.lines.length !== 0) {
    throw new Error(
      `page 2 reported changed ${String(page.changed)}, added ${String(page.added)}, removed ${String(page.removed)}, ${String(page.lines.length)} lines`,
    );
  }
  if (result.summary.changedPages !== 1 || result.summary.identicalPages !== 1) {
    throw new Error(
      `summary: ${String(result.summary.changedPages)} changed, ${String(result.summary.identicalPages)} identical`,
    );
  }
  return `page 2 identical, ${String(page.leftLines)} lines on both sides, summary 1 changed / 1 identical`;
});

await check('text: the extra page is reported, with the extractor’s own line counts', async () => {
  const result = await compareText(base, extra, context());
  if (result.leftPageCount !== 2 || result.rightPageCount !== 3 || result.pageCountDelta !== 1) {
    throw new Error(
      `counts ${String(result.leftPageCount)} / ${String(result.rightPageCount)}, delta ${String(result.pageCountDelta)}`,
    );
  }
  const addedPage = result.pages[2];
  if (addedPage === undefined || addedPage.status !== 'added') {
    throw new Error(`page 3 is ${String(addedPage?.status)}`);
  }
  if (addedPage.leftLines !== 0 || addedPage.added !== 2 || addedPage.lines[0]?.text !== 'Ucuncu sayfa') {
    throw new Error(
      `page 3: ${String(addedPage.added)} added lines, first "${String(addedPage.lines[0]?.text)}"`,
    );
  }
  if (result.summary.addedPages !== 1 || result.summary.identicalPages !== 2) {
    throw new Error(
      `summary: ${String(result.summary.addedPages)} added, ${String(result.summary.identicalPages)} identical`,
    );
  }
  return `2 -> 3 pages, delta ${String(result.pageCountDelta)}, page 3 added with ${String(addedPage.added)} lines`;
});

await check('text: nothing is marked truncated when no bound was hit', async () => {
  const result = await compareText(base, changed, context());
  if (result.truncated || result.truncationReasons.length > 0) {
    throw new Error(`truncated: ${String(result.truncated)} ${result.truncationReasons.join('|')}`);
  }
  const perPage = result.pages.filter((page) => page.truncated);
  if (perPage.length > 0) throw new Error(`${String(perPage.length)} pages marked truncated`);
  return `truncated false, no reason, ${String(result.pages.length)} pages clean`;
});

await check('visual: the changed page differs, the identical page does not', async () => {
  const result = await compareVisual(base, changed, context(), { createCanvas, dpi: 40 });
  const changedPage = result.pages[0];
  const identicalPage = result.pages[1];
  if (changedPage === undefined || identicalPage === undefined) throw new Error('missing pages');
  if (result.dpi !== 40) throw new Error(`dpi ${String(result.dpi)}`);
  if (changedPage.status !== 'changed') {
    throw new Error(`page 1 is ${changedPage.status} at ${changedPage.differencePercent.toFixed(3)} %`);
  }
  if (changedPage.differencePercent <= result.thresholdPercent || changedPage.differingTiles === 0) {
    throw new Error(
      `page 1: ${changedPage.differencePercent.toFixed(3)} % over ${String(changedPage.differingTiles)}/${String(changedPage.tileCount)} tiles`,
    );
  }
  if (identicalPage.status !== 'identical' || identicalPage.differingPixels !== 0) {
    throw new Error(
      `page 2 is ${identicalPage.status} with ${String(identicalPage.differingPixels)} differing pixels`,
    );
  }
  if (result.truncated)
    throw new Error(`visual comparison reported truncated: ${result.truncationReasons.join('|')}`);
  return `page 1 changed ${changedPage.differencePercent.toFixed(3)} % (${String(changedPage.differingTiles)}/${String(changedPage.tileCount)} tiles), page 2 ${identicalPage.differencePercent.toFixed(3)} %`;
});

await check('visual: the page-count difference is reported, not truncated', async () => {
  const result = await compareVisual(base, extra, context(), { createCanvas });
  if (result.pageCountDelta !== 1 || result.leftPageCount !== 2 || result.rightPageCount !== 3) {
    throw new Error(
      `${String(result.leftPageCount)} -> ${String(result.rightPageCount)}, delta ${String(result.pageCountDelta)}`,
    );
  }
  const addedPage = result.pages[2];
  if (addedPage === undefined || addedPage.status !== 'added') {
    throw new Error(`page 3 is ${String(addedPage?.status)}`);
  }
  if (addedPage.leftSize !== null || addedPage.rightSize === null) {
    throw new Error(
      `page 3 sizes: left ${JSON.stringify(addedPage.leftSize)}, right ${JSON.stringify(addedPage.rightSize)}`,
    );
  }
  if (result.pages[0]?.status !== 'identical' || result.pages[1]?.status !== 'identical') {
    throw new Error('a page that is the same in both documents was not called identical');
  }
  return `delta ${String(result.pageCountDelta)}, page 3 added (${String(addedPage.rightSize.width)}x${String(addedPage.rightSize.height)} at ${String(result.dpi)} dpi)`;
});

await check('both methods: one document against itself reports nothing', async () => {
  const text = await compareText(base, base, context());
  const visual = await compareVisual(base, base, context(), { createCanvas });
  if (text.summary.changedPages !== 0 || text.pages.some((page) => page.status !== 'identical')) {
    throw new Error(`text: ${String(text.summary.changedPages)} changed pages`);
  }
  const differing = visual.pages.filter((page) => page.differingPixels !== 0);
  if (differing.length > 0) {
    throw new Error(`visual: ${String(differing.length)} pages differ`);
  }
  return `${String(text.pages.length)} pages identical in both methods (${String(visual.summary.identicalPages)} rendered pages, 0 differing pixels)`;
});

await check('oversized text input: truncated is set, with the reasons and the cap', async () => {
  const result = await compareText(oversizedLeft, oversizedRight, context());
  const page = result.pages[0];
  if (page === undefined) throw new Error('no page reported');
  if (page.leftLines !== OVERSIZED_LINES || page.rightLines !== OVERSIZED_LINES) {
    throw new Error(
      `the extractor produced ${String(page.leftLines)}/${String(page.rightLines)} lines, the fixture drew ${String(OVERSIZED_LINES)}`,
    );
  }
  if (!result.truncated || !page.truncated) throw new Error('truncated is not set');
  const reasons = [...page.reasons].sort().join('|');
  if (!page.reasons.includes('line-matrix') || !page.reasons.includes('line-list')) {
    throw new Error(`reasons: ${reasons}`);
  }
  if (page.lines.length !== 200)
    throw new Error(`${String(page.lines.length)} lines reported, not the 200 cap`);
  const accounted = page.changed + page.added + page.removed;
  if (accounted !== OVERSIZED_LINES) {
    throw new Error(`${String(accounted)} lines accounted for, ${String(OVERSIZED_LINES)} differ`);
  }
  return `reasons ${reasons}, ${String(page.lines.length)} of ${String(accounted)} changes listed`;
});

await check('text: a changed line past the word cap is named line-level, and says why', async () => {
  const result = await compareText(longLineLeft, longLineRight, context());
  const page = result.pages[0];
  if (page === undefined || page.status !== 'changed') throw new Error(`page 1 is ${String(page?.status)}`);
  if (page.changed + page.added + page.removed < 1) throw new Error('no change reported');
  const detailed = page.lines.filter((change) => change.words !== null);
  if (detailed.length > 0) throw new Error(`${String(detailed.length)} pairs ran the word diff past the cap`);
  if (!page.reasons.includes('word-matrix')) throw new Error(`reasons: ${page.reasons.join('|')}`);
  if (!page.truncated || !result.truncated) throw new Error('truncated is not set');
  return `${String(page.changed)} changed lines, words null, reasons ${page.reasons.join('|')}`;
});

await check('visual: a raster over the cap is unavailable and reported', async () => {
  const result = await compareVisual(base, changed, context(), {
    createCanvas,
    limits: { maxRasterPixels: 1000 },
  });
  const page = result.pages[0];
  if (page === undefined || page.status !== 'unavailable' || page.reason !== 'page-too-large') {
    throw new Error(`page 1 is ${String(page?.status)} / ${String(page?.reason)}`);
  }
  if (!result.truncated || !result.truncationReasons.includes('raster-cap')) {
    throw new Error(`truncated ${String(result.truncated)} ${result.truncationReasons.join('|')}`);
  }
  // Both fixture pages are the same size, so the cap blocks both — and a blocked page is
  // never "compared with 0 % difference".
  if (result.summary.pagesCompared !== 0 || result.summary.unavailablePages !== result.pages.length) {
    throw new Error(
      `summary: ${String(result.summary.unavailablePages)} unavailable, ${String(result.summary.pagesCompared)} compared of ${String(result.pages.length)}`,
    );
  }
  return `page 1 unavailable (page-too-large), ${String(result.summary.pagesCompared)} of ${String(result.pages.length)} pages compared`;
});

await check('an aborted signal stops the comparison with the mapped error', async () => {
  const controller = new AbortController();
  controller.abort();
  try {
    await compareText(base, changed, context(controller.signal));
  } catch (error) {
    if (!(error instanceof ToolError)) throw new Error(`not a ToolError: ${(error as Error).name}`);
    if (error.code !== 'aborted') throw new Error(`code ${error.code}`);
    return `refused with ${error.code} / ${error.messageKey}`;
  }
  throw new Error('an aborted signal produced a result');
});

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(`  ${String(checks.length - failed.length)} passed, ${String(failed.length)} failed`);
console.log(`  fixtures: ${dir}`);
for (const entry of failed) console.log(`  FAILED: ${entry.name} — ${entry.detail}`);
process.exit(failed.length === 0 ? 0 : 1);
