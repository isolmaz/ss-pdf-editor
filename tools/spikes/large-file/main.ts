/**
 * Spike #5 — large-file memory (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * Answers the question the plan defers to this spike: what does a 300 MB /
 * 1500+ page document actually cost in the browser, and do the provisional
 * numeric targets (`WORKLOG.md §3`) hold?
 *
 *   load (`/spike5/fixture.pdf`, Node-built) → getDocument() → first page →
 *   N pages at 100 % → saveDocument() → destroy()   [→ optional degradation probe]
 *
 * The fixture is **not** built here. Two earlier runs died in the in-page
 * fixture stage and produced no numbers at all; the recorded fix
 * (`NOTES.md`) moves fixture construction to Node (`make-fixture.mjs`) and
 * serves it from the dev server, so this page has exactly one job: measure.
 *
 * Every number comes from the running page; nothing is estimated. Memory is
 * sampled **during** the run (10 ms JS heap, 250 ms agent cluster) because the
 * step-boundary samples cannot see the old/new buffer overlap inside
 * `saveDocument()` — and because the page cannot force a GC, the caveat in
 * `peaks.caveat` is part of the reading.
 *
 * Query parameters (all optional):
 *   id=<string>        fixture/run id recorded in the result
 *   label=<string>     human label for the run
 *   render=<n>         pages to render at `scale` (default 10)
 *   scale=<number>     render scale (default 1 = 100 %)
 *   save=0             skip the saveDocument() step
 *   verify=1           re-open the saved buffer to check the field value (costly)
 *   degrade=1          run the memory-pressure degradation probe last
 *   fixture=<path>     fixture URL (default `/spike5/fixture.pdf`)
 */
import type { PDFDocumentProxy } from './engine';
import {
  findMarkerInTail,
  isIncrementalOver,
  openDocument,
  probeFieldAnnotation,
  renderPageToCanvas,
  saveWithFormValue,
  startCancellableRender,
} from './engine';
import {
  HeapPoller,
  jsHeapUsedBytes,
  memoryApiInfo,
  nextFrame,
  PeakMemoryTracker,
  sampleMemory,
} from './memory';
import { FIELD_NAME, FIELD_SAVED_VALUE } from './recipe.mjs';
import { createResult, formatBytes, formatMs, publish, publishPrevious, setPhase } from './report';
import type { FixtureInfo, RunInfo, SaveInfo, SpikeResult, TargetCheck } from './types';

const TARGET_BYTES = 300 * 1024 * 1024;
const TARGET_PAGES = 1500;
const K6_PAGES = 2000;
const PHASE_HEAP_POLL_MS = 10;
const PROGRESS_EVERY_BYTES = 64 * 1024 * 1024;

const result = createResult(environment(), memoryApiInfo());

/** What this page believes it is holding, in bytes — a sanity total next to the API numbers. */
const accounted = { master: 0, engineCopy: 0, saveBuffer: 0, canvases: 0 };

function accountedTotal(): number {
  return accounted.master + accounted.engineCopy + accounted.saveBuffer + accounted.canvases;
}

function environment(): SpikeResult['environment'] {
  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: navigatorWithMemory.deviceMemory ?? null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    startedAt: new Date().toISOString(),
  };
}

function check(name: string, pass: boolean, detail: string): void {
  result.checks.push({ name, pass, detail });
}

function note(text: string): void {
  result.notes.push(text);
}

function target(description: string, measured: string, verdict: TargetCheck['verdict']): void {
  result.targets.push({ target: description, measured, verdict });
}

/** Records a retained-memory sample at a step boundary and republishes the page. */
async function memoryStep(step: string, comment: string): Promise<number | null> {
  const reading = await sampleMemory(step, comment, accountedTotal());
  result.memory.push(reading.step);
  result.breakdown.push(...reading.breakdown);
  if (reading.error) note(`${step}: ${reading.error}`);
  publish(result);
  return reading.step.agentClusterBytes;
}

interface RunOptions {
  readonly id: string;
  readonly label: string;
  readonly renderPages: number;
  readonly scale: number;
  readonly save: boolean;
  readonly verifyByReopen: boolean;
  readonly degrade: boolean;
  readonly fixturePath: string;
}

function readOptions(): RunOptions {
  const query = new URLSearchParams(location.search);
  const integer = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(query.get(name) ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const scaleValue = Number.parseFloat(query.get('scale') ?? '');
  const id = query.get('id') ?? 'large-file';
  return {
    id,
    label: query.get('label') ?? `${id} run`,
    renderPages: integer('render', 10),
    scale: Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : 1,
    save: query.get('save') !== '0',
    verifyByReopen: query.get('verify') === '1',
    degrade: query.get('degrade') === '1',
    fixturePath: query.get('fixture') ?? '/spike5/fixture.pdf',
  };
}

/** Pulls the fixture into this page over HTTP, reporting progress so a stall is visible from outside. */
async function loadFixture(
  options: RunOptions,
): Promise<{ bytes: Uint8Array; ms: number; info: FixtureInfo }> {
  // The host serves the generator's summary sidecar next to the PDF
  // (`/spike5/fixture.pdf` → `/spike5/fixture.json`).
  const summaryPath = `${options.fixturePath.replace(/\.pdf$/i, '')}.json`;
  setPhase(`${options.id}: fetching ${summaryPath}`);
  const summaryResponse = await fetch(summaryPath, { cache: 'no-store' });
  if (!summaryResponse.ok) throw new Error(`fixture.json → HTTP ${summaryResponse.status}`);
  const summary = (await summaryResponse.json()) as Record<string, number | string>;

  setPhase(`${options.id}: fetching ${formatBytes(Number(summary.bytes))} fixture`);
  const started = performance.now();
  const response = await fetch(options.fixturePath, { cache: 'no-store' });
  if (!response.ok) throw new Error(`fixture → HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? summary.bytes);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('fetch returned no readable stream');
  const buffer = new Uint8Array(declared > 0 ? declared : 1);
  let received = 0;
  let reportedAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > buffer.byteLength) throw new Error('fixture grew while streaming');
    buffer.set(value, received);
    received += value.byteLength;
    if (received - reportedAt >= PROGRESS_EVERY_BYTES) {
      reportedAt = received;
      setPhase(`${options.id}: fetched ${formatBytes(received)} of ${formatBytes(declared)}`);
    }
  }
  const ms = performance.now() - started;
  if (received !== declared) {
    throw new Error(`fixture truncated: ${received} bytes arrived, ${declared} declared`);
  }
  const info: FixtureInfo = {
    id: options.id,
    origin: `node tools/spikes/large-file/make-fixture.mjs (${String(summary.raster)} @ ${String(summary.dpi)} dpi, q${String(summary.quality)})`,
    pages: Number(summary.pages),
    bytes: received,
    dpi: Number(summary.dpi),
    raster: String(summary.raster),
    quality: Number(summary.quality),
    grain: Number(summary.grain),
    perPageJpegBytes: Number(summary.perPageJpegBytes),
    minJpegBytes: Number(summary.minJpegBytes),
    maxJpegBytes: Number(summary.maxJpegBytes),
    distinctJpegSizes: Number(summary.distinctJpegSizes),
    jpegBytes: Number(summary.jpegBytes),
    pdfOverJpegRatio: Number(summary.pdfOverJpegRatio),
    generateMs: Number(summary.totalMs),
  };
  return { bytes: buffer, ms, info };
}

async function measureSave(
  document: PDFDocumentProxy,
  fixture: { readonly bytes: Uint8Array },
  options: RunOptions,
): Promise<SaveInfo> {
  const probe = await probeFieldAnnotation(document, FIELD_NAME);
  note(
    `${options.label}: page-1 widget probe → found=${probe.found}, id=${probe.id}, keys=${probe.keys.join('|')}`,
  );

  const candidates: string[] = [];
  if (probe.id) candidates.push(probe.id);
  candidates.push(FIELD_NAME);

  const poller = new HeapPoller(PHASE_HEAP_POLL_MS);
  poller.start();
  const attempt = await saveWithFormValue(document, candidates, FIELD_SAVED_VALUE);
  const peakHeap = poller.stop();

  if (!attempt.output) {
    check(`${options.label}: saveDocument() with a form change`, false, attempt.error ?? 'no output');
    return {
      attempted: true,
      keyUsed: null,
      keysTried: attempt.keysTried,
      ms: attempt.ms,
      inputBytes: fixture.bytes.byteLength,
      outputBytes: null,
      deltaBytes: null,
      incrementalFormat: null,
      markerFoundInTail: null,
      fieldValueAfterReopen: null,
      peakHeapDuringSaveBytes: peakHeap,
      error: attempt.error,
    };
  }

  const output = attempt.output;
  accounted.saveBuffer = output.byteLength;
  const incremental = isIncrementalOver(output, fixture.bytes);
  const marker = findMarkerInTail(output, FIELD_SAVED_VALUE) >= 0;
  await memoryStep(
    `${options.label}: saveDocument() returned`,
    `save buffer held: ${formatBytes(output.byteLength)} = master ${formatBytes(fixture.bytes.byteLength)} + delta ${formatBytes(output.byteLength - fixture.bytes.byteLength)}`,
  );

  let fieldValueAfterReopen: string | null = null;
  if (options.verifyByReopen) {
    const reopened = await openDocument(output.slice());
    const reopenedProbe = await probeFieldAnnotation(reopened.document, FIELD_NAME);
    fieldValueAfterReopen = reopenedProbe.fieldValue === undefined ? null : String(reopenedProbe.fieldValue);
    await reopened.loadingTask.destroy();
  }

  accounted.saveBuffer = 0;
  const afterDrop = await sampleMemory(
    `${options.label}: save buffer dropped`,
    'what the saving state costs once the returned buffer is released',
    accountedTotal(),
  );
  result.memory.push(afterDrop.step);
  result.breakdown.push(...afterDrop.breakdown);
  publish(result);

  check(
    `${options.label}: save returns a full-size buffer`,
    output.byteLength > fixture.bytes.byteLength,
    `${formatBytes(output.byteLength)} for a ${formatBytes(fixture.bytes.byteLength)} input (+${formatBytes(output.byteLength - fixture.bytes.byteLength)})`,
  );
  check(
    `${options.label}: save is incremental in format`,
    incremental,
    'output starts with the exact input bytes',
  );
  check(
    `${options.label}: the form change landed in the appended update`,
    marker,
    `marker "${FIELD_SAVED_VALUE}" found in the appended tail`,
  );
  if (options.verifyByReopen) {
    check(
      `${options.label}: saved field value survives a re-open`,
      fieldValueAfterReopen === FIELD_SAVED_VALUE,
      `re-opened field value = ${JSON.stringify(fieldValueAfterReopen)}`,
    );
  }

  return {
    attempted: true,
    keyUsed: attempt.keyUsed,
    keysTried: attempt.keysTried,
    ms: attempt.ms,
    inputBytes: fixture.bytes.byteLength,
    outputBytes: output.byteLength,
    deltaBytes: output.byteLength - fixture.bytes.byteLength,
    incrementalFormat: incremental,
    markerFoundInTail: marker,
    fieldValueAfterReopen,
    peakHeapDuringSaveBytes: peakHeap,
    error: null,
  };
}

/** Opens the loaded fixture, renders pages, saves, and releases — the run the spike exists for. */
async function measureRun(
  fixture: { bytes: Uint8Array; ms: number; info: FixtureInfo },
  options: RunOptions,
): Promise<RunInfo> {
  accounted.master = fixture.bytes.byteLength;
  const run: RunInfo = {
    id: options.id,
    label: options.label,
    pages: fixture.info.pages,
    bytes: fixture.bytes.byteLength,
    loadMs: fixture.ms,
    openMs: 0,
    firstPageMs: null,
    openToFirstPageMs: null,
    render: null,
    save: null,
    dataDetachedAfterOpen: false,
    destroyMs: null,
    releasedAgentClusterBytes: null,
    error: null,
  };

  const openPoller = new HeapPoller(PHASE_HEAP_POLL_MS);
  openPoller.start();
  accounted.engineCopy = fixture.bytes.byteLength; // the disposable copy handed to pdf.js (K15)
  setPhase(`${options.label}: getDocument()`);
  const opened = await openDocument(fixture.bytes.slice());
  const peakHeapDuringOpen = openPoller.stop();
  run.openMs = opened.openMs;
  run.dataDetachedAfterOpen = opened.dataDetached;

  const afterOpen = await memoryStep(
    `${options.label}: getDocument() resolved`,
    'parser + worker + document structures + the engine copy (transferred into the worker)',
  );
  note(
    `${options.label}: open ${formatMs(run.openMs)}, peak JS heap during open ${formatBytes(peakHeapDuringOpen)}, engine copy detached=${run.dataDetachedAfterOpen}`,
  );

  // First page at 100 % — the "time to readable page" number.
  const canvases: HTMLCanvasElement[] = [];
  setPhase(`${options.label}: first page render`);
  const firstPageStart = performance.now();
  const firstCanvas = document.createElement('canvas');
  await renderPageToCanvas(opened.document, 1, options.scale, firstCanvas);
  run.firstPageMs = performance.now() - firstPageStart;
  run.openToFirstPageMs = run.openMs + run.firstPageMs;
  canvases.push(firstCanvas);
  accounted.canvases = firstCanvas.width * firstCanvas.height * 4;
  await memoryStep(
    `${options.label}: first page rendered`,
    `one ${firstCanvas.width}×${firstCanvas.height} canvas (${formatBytes(accounted.canvases)})`,
  );

  if (options.renderPages > 1) {
    const perPageMs: number[] = [];
    for (let pageNumber = 2; pageNumber <= options.renderPages; pageNumber += 1) {
      setPhase(`${options.label}: rendering page ${pageNumber}/${options.renderPages}`);
      const canvas = document.createElement('canvas');
      const rendered = await renderPageToCanvas(opened.document, pageNumber, options.scale, canvas);
      canvases.push(canvas);
      perPageMs.push(rendered.ms);
    }
    accounted.canvases = canvases.reduce(
      (total, canvas) => total + canvas.width * canvas.height * 4,
      accounted.canvases,
    );
    run.render = {
      pages: canvases.length,
      scale: options.scale,
      perPageMs,
      totalMs: perPageMs.reduce((total, value) => total + value, 0),
      canvasBytes: accounted.canvases,
    };
    await memoryStep(
      `${options.label}: ${canvases.length} pages rendered`,
      `render cache holds ${formatBytes(accounted.canvases)} of canvas backstore (${formatBytes(accounted.canvases / canvases.length)}/page)`,
    );
  }

  if (options.save) {
    setPhase(`${options.label}: saveDocument()`);
    run.save = await measureSave(opened.document, fixture, options);
    note(
      `${options.label}: save ${formatMs(run.save.ms)} → ${formatBytes(run.save.outputBytes)} returned (input ${formatBytes(run.save.inputBytes)})`,
    );
  }

  setPhase(`${options.label}: destroy()`);
  const destroyPoller = new HeapPoller(PHASE_HEAP_POLL_MS);
  destroyPoller.start();
  const destroyStart = performance.now();
  await opened.loadingTask.destroy();
  run.destroyMs = performance.now() - destroyStart;
  const peakHeapDuringDestroy = destroyPoller.stop();
  accounted.engineCopy = 0;
  const afterDestroy = await memoryStep(
    `${options.label}: destroy()`,
    `engine released; the page still holds the master copy and ${canvases.length} render-cache canvas(es)`,
  );
  run.releasedAgentClusterBytes =
    afterOpen !== null && afterDestroy !== null ? afterOpen - afterDestroy : null;
  note(
    `${options.label}: destroy() ${formatMs(run.destroyMs)}, peak JS heap during destroy ${formatBytes(peakHeapDuringDestroy)}, ` +
      `agent cluster released by destroy ${formatBytes(run.releasedAgentClusterBytes)}`,
  );
  accounted.canvases = 0;
  return run;
}

/** Allocates until something gives, while the large document is still open (`degrade=1`). */
async function degradationProbe(proxy: PDFDocumentProxy, master: Uint8Array): Promise<void> {
  setPhase('degradation probe');
  const chunk = 256 * 1024 * 1024;
  const ceiling = 8 * 1024 * 1024 * 1024;
  const held: ArrayBuffer[] = [];
  let failedAtBytes: number | null = null;
  let failureMode = 'never failed — allocation stopped at the probe ceiling';
  const allocationStart = performance.now();

  while (held.length * chunk < ceiling) {
    try {
      const buffer = new ArrayBuffer(chunk);
      new Uint8Array(buffer).fill(7);
      held.push(buffer);
    } catch (caught) {
      failedAtBytes = held.length * chunk;
      failureMode = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
      break;
    }
  }
  const allocationMs = performance.now() - allocationStart;

  let renderDuringPressureMs: number | null = null;
  let cancelDuringPressureMs: number | null = null;
  let cancelHonoured: boolean | null = null;
  let frameGapMs: number | null = null;
  let secondHeavyJob = 'not attempted';
  let survived = true;

  try {
    // Can the app still do work at all?
    const canvas = document.createElement('canvas');
    const renderStart = performance.now();
    await renderPageToCanvas(proxy, 3, 1, canvas);
    renderDuringPressureMs = performance.now() - renderStart;

    // UI responsiveness: one animation frame under pressure.
    const first = await nextFrame();
    const second = await nextFrame();
    frameGapMs = second - first;

    // Cancel: start real work, cancel it, and see how long the engine takes to give up.
    const cancellable = await startCancellableRender(proxy, 4, 4);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const cancelAt = performance.now();
    cancellable.cancel();
    const cancelled = await cancellable.done;
    cancelDuringPressureMs = performance.now() - cancelAt;
    cancelHonoured = cancelled.cancelled || cancelled.error !== null;
    note(`degradation: cancel under pressure → ${JSON.stringify(cancelled)}`);
  } catch (caught) {
    survived = false;
    failureMode = `${failureMode}; an operation failed under pressure: ${caught instanceof Error ? caught.message : String(caught)}`;
  }

  // The §3.4 contract is "refuse a second heavy job", not "try anyway and hope".
  try {
    const secondStart = performance.now();
    const second = await openDocument(master.slice());
    await second.document.getPage(1);
    await second.loadingTask.destroy();
    secondHeavyJob = `accepted — a second full open succeeded in ${formatMs(performance.now() - secondStart)} (the app refuses nothing)`;
  } catch (caught) {
    secondHeavyJob = `rejected: ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`;
  }

  result.degradation = {
    documentOpen: true,
    extraAllocatedBytes: held.reduce((total, buffer) => total + buffer.byteLength, 0),
    allocationMs,
    failedAtBytes,
    failureMode,
    renderDuringPressureMs,
    cancelDuringPressureMs,
    cancelHonoured,
    frameGapMs,
    secondHeavyJob,
    heapDuringPressureBytes: jsHeapUsedBytes(),
    survived,
  };
  held.length = 0;
  publish(result);
}

function evaluateTargets(run: RunInfo, info: FixtureInfo): void {
  const nearThreeHundredMb = run.bytes >= TARGET_BYTES * 0.9;
  const atCeiling = nearThreeHundredMb && run.pages >= TARGET_PAGES;
  const saved = run.save !== null && run.save.error === null && run.save.outputBytes !== null;
  target(
    '300 MB open ≤ 15 s',
    nearThreeHundredMb
      ? `${formatMs(run.openMs)} to getDocument() (${run.pages} pages / ${formatBytes(run.bytes)}); load over HTTP ${formatMs(run.loadMs)}`
      : `not tested at this size — ${run.pages} pages / ${formatBytes(run.bytes)} is below the 300 MB tier (open ${formatMs(run.openMs)})`,
    nearThreeHundredMb ? (run.openMs <= 15000 ? 'confirmed' : 'missed') : 'not tested',
  );
  target(
    `desktop ceiling ${K6_PAGES} pages / 300 MB (K6): opened, rendered and saved`,
    atCeiling
      ? `${run.pages} pages / ${formatBytes(run.bytes)} opened in ${formatMs(run.openMs)}, ` +
          `${run.render?.pages ?? 0} page(s) rendered, save ${saved ? `${formatMs(run.save?.ms ?? null)} → ${formatBytes(run.save?.outputBytes)}` : 'not completed'}`
      : `not tested at the tier — this run is ${run.pages} pages / ${formatBytes(run.bytes)}; ` +
          `opened in ${formatMs(run.openMs)}${saved ? `, saved in ${formatMs(run.save?.ms ?? null)}` : ', save did not complete'}`,
    atCeiling ? (saved ? 'confirmed' : 'missed') : 'not tested',
  );
  target(
    'mobile viewing mode above ~300 pages / 64 MB (§3.4)',
    'not measurable on desktop Chromium: there is no iOS canvas-backstore ceiling to hit here — this run only supplies the per-page render cost',
    'not tested',
  );
  check(
    `${info.id}: every page kept its own JPEG payload`,
    info.distinctJpegSizes > info.pages / 2 && info.pdfOverJpegRatio > 0.95,
    `PDF ${formatBytes(info.bytes)} ÷ JPEG payload ${formatBytes(info.jpegBytes)} = ${info.pdfOverJpegRatio.toFixed(3)}; ` +
      `${info.distinctJpegSizes} distinct payload sizes across ${info.pages} pages`,
  );
}

async function main(): Promise<void> {
  const options = readOptions();
  publishPrevious();
  publish(result);
  note(`memory APIs: ${JSON.stringify(result.memoryApi)}`);
  note(
    `fixture is built in Node (make-fixture.mjs) and served by the spike host; this page only measures ` +
      `(render ${options.renderPages} page(s) at scale ${options.scale}, save=${options.save}, degrade=${options.degrade})`,
  );

  await memoryStep('baseline', 'page loaded, nothing open, no fixture in memory');

  const tracker = new PeakMemoryTracker();
  tracker.start();

  const fixture = await loadFixture(options);
  result.fixtures.push(fixture.info);
  note(
    `fixture loaded: ${fixture.info.pages} pages / ${formatBytes(fixture.info.bytes)} in ${formatMs(fixture.ms)} ` +
      `(${formatBytes(fixture.info.perPageJpegBytes)}/page, ${fixture.info.distinctJpegSizes} distinct JPEG payloads)`,
  );
  await memoryStep(
    `${options.label}: fixture loaded over HTTP`,
    'master copy held (the product keeps this in the source vault)',
  );

  const run = await measureRun(fixture, options);
  result.runs.push(run);
  evaluateTargets(run, fixture.info);

  result.peaks = await tracker.stop();
  note(
    `sampled peaks: JS heap ${formatBytes(result.peaks.jsHeapPeakBytes)} over ${result.peaks.jsHeapSamples} samples ` +
      `(${result.peaks.jsHeapIntervalMs} ms), agent cluster ${formatBytes(result.peaks.agentClusterPeakBytes)} over ` +
      `${result.peaks.agentClusterSamples} samples (${result.peaks.agentClusterIntervalMs} ms, ${result.peaks.agentClusterFailures} failed)`,
  );
  publish(result);

  if (options.degrade) {
    setPhase('degradation probe: reopening the fixture');
    const pressureDocument = await openDocument(fixture.bytes.slice());
    accounted.engineCopy = fixture.bytes.byteLength;
    await degradationProbe(pressureDocument.document, fixture.bytes);
    await pressureDocument.loadingTask.destroy();
    accounted.engineCopy = 0;
  } else {
    note('degradation probe not run (pass ?degrade=1 to include it)');
  }

  accounted.master = 0;
  accounted.engineCopy = 0;
  accounted.saveBuffer = 0;
  accounted.canvases = 0;
  await memoryStep(
    'after every fixture released',
    'what the page still holds once the master copy is dropped',
  );
  setPhase('done');
  publish(result);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  result.failures.push(message);
  setPhase(`error — ${message}`, 'error');
  publish(result);
});
