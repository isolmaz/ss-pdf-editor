/**
 * Reporting for spike #5 (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * Renders the measurement tables, mirrors everything onto
 * `window.__spikeResult` and persists a copy to localStorage after every step,
 * so the degradation probe (which is allowed to crash the tab) cannot take the
 * numbers with it.
 */
import type { SpikeResult } from './types';

const STORAGE_KEY = 'spike5.large-file.result';

/** Last phase text, mirrored into the published result so the JSON is self-describing. */
let lastPhase = 'boot';

/**
 * Every spike on this harness publishes its own result on `window`, each with
 * its own type, so the globals are written through a local shape instead of an
 * ambient `interface Window` augmentation — two augmentations of the same
 * property with different types do not compile in one program.
 */
interface SpikeGlobals {
  __spikeResult?: SpikeResult;
  __spikePreviousResult?: SpikeResult;
  /** Written on every phase change: the outside poller watches this to tell a slow step from a stalled one. */
  __spikeProgress?: { phase: string; kind: 'run' | 'error'; at: number; atIso: string };
}

function spikeGlobals(): SpikeGlobals {
  return window as unknown as SpikeGlobals;
}

export function createResult(
  environment: SpikeResult['environment'],
  memoryApi: SpikeResult['memoryApi'],
): SpikeResult {
  return {
    environment,
    memoryApi,
    peaks: {
      jsHeapPeakBytes: null,
      jsHeapSamples: 0,
      jsHeapIntervalMs: 0,
      agentClusterPeakBytes: null,
      agentClusterSamples: 0,
      agentClusterFailures: 0,
      agentClusterIntervalMs: 0,
      caveat: 'not sampled yet',
    },
    fixtures: [],
    runs: [],
    memory: [],
    breakdown: [],
    degradation: null,
    targets: [],
    checks: [],
    notes: [],
    phase: 'boot',
    failures: [],
  };
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const mib = bytes / (1024 * 1024);
  if (Math.abs(mib) >= 1024) return `${(mib / 1024).toFixed(2)} GiB`;
  if (Math.abs(mib) >= 10) return `${mib.toFixed(1)} MiB`;
  if (Math.abs(mib) >= 1) return `${mib.toFixed(2)} MiB`;
  return `${bytes} B`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

function tableBody(id: string): HTMLTableSectionElement {
  const element = document.querySelector(`#${id} tbody`);
  if (!(element instanceof HTMLTableSectionElement)) throw new Error(`missing table body: #${id}`);
  return element;
}

function row(cells: Array<string | Node>, className = ''): HTMLTableRowElement {
  const element = document.createElement('tr');
  if (className) element.className = className;
  for (const cell of cells) {
    const td = document.createElement('td');
    if (typeof cell === 'string') td.textContent = cell;
    else td.append(cell);
    element.append(td);
  }
  return element;
}

function span(text: string, className: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function verdictNode(verdict: SpikeResult['targets'][number]['verdict']): HTMLSpanElement {
  if (verdict === 'confirmed') return span('confirmed', 'pass');
  if (verdict === 'missed') return span('MISSED', 'fail');
  return span('not tested', 'miss');
}

export function setPhase(text: string, kind: 'run' | 'error' = 'run'): void {
  const element = document.querySelector('#phase');
  if (element instanceof HTMLElement) {
    element.textContent = text;
    element.dataset.phase = kind;
  }
  const at = Date.now();
  lastPhase = text;
  spikeGlobals().__spikeProgress = { phase: text, kind, at, atIso: new Date(at).toISOString() };
}

export function publish(result: SpikeResult): void {
  result.phase = lastPhase;
  spikeGlobals().__spikeResult = result;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
  render(result);
}

export function publishPrevious(): void {
  const stored = localStorage.getItem(STORAGE_KEY);
  const target = document.querySelector('#previous-raw');
  if (!stored || !(target instanceof HTMLElement)) return;
  try {
    spikeGlobals().__spikePreviousResult = JSON.parse(stored) as SpikeResult;
    target.textContent = stored;
  } catch {
    target.textContent = stored;
  }
}

function renderEnvironment(result: SpikeResult): void {
  const body = tableBody('environment');
  body.replaceChildren(
    row(['User agent', result.environment.userAgent]),
    row(['Platform', result.environment.platform]),
    row(['CPUs', String(result.environment.hardwareConcurrency)]),
    row([
      'deviceMemory',
      result.environment.deviceMemoryGb === null ? '—' : `${result.environment.deviceMemoryGb} GB`,
    ]),
    row(['crossOriginIsolated', String(result.environment.crossOriginIsolated)]),
    row(['measureUserAgentSpecificMemory', String(result.memoryApi.uaSpecificMemory)]),
    row(['performance.memory', String(result.memoryApi.jsHeap)]),
    row(['JS heap limit', formatBytes(result.memoryApi.jsHeapLimitBytes)]),
    row(['Started', result.environment.startedAt]),
  );
}

function renderFixtures(result: SpikeResult): void {
  const body = tableBody('fixtures');
  body.replaceChildren();
  for (const fixture of result.fixtures) {
    body.append(
      row([
        fixture.id,
        String(fixture.pages),
        formatBytes(fixture.bytes),
        `${formatBytes(fixture.perPageJpegBytes)} (${fixture.raster} @ ${fixture.dpi} dpi, q${fixture.quality}, grain ${fixture.grain})`,
        `${formatMs(fixture.generateMs)} (Node)`,
      ]),
    );
    body.append(
      row([
        '↳ distinct embedded JPEG sizes',
        `${fixture.distinctJpegSizes} of ${fixture.pages}`,
        `JPEG payload total ${formatBytes(fixture.jpegBytes)}`,
        `min ${formatBytes(fixture.minJpegBytes)} / max ${formatBytes(fixture.maxJpegBytes)}`,
        `PDF ÷ JPEG = ${fixture.pdfOverJpegRatio.toFixed(3)}`,
      ]),
      row(['↳ origin', fixture.origin, '', '', '']),
    );
  }
}

function renderPeaks(result: SpikeResult): void {
  const body = tableBody('peaks');
  body.replaceChildren();
  const peaks = result.peaks;
  body.append(
    row([
      `JS heap peak (every ${peaks.jsHeapIntervalMs} ms)`,
      formatBytes(peaks.jsHeapPeakBytes),
      `${peaks.jsHeapSamples} samples`,
      'performance.memory.usedJSHeapSize — excludes ArrayBuffer backing stores',
    ]),
    row([
      `Agent-cluster peak (every ${peaks.agentClusterIntervalMs} ms)`,
      formatBytes(peaks.agentClusterPeakBytes),
      `${peaks.agentClusterSamples} samples, ${peaks.agentClusterFailures} failed`,
      'performance.measureUserAgentSpecificMemory() — forces a GC on every call',
    ]),
    row(['Caveat', peaks.caveat, '', '']),
  );
}

function renderMemory(result: SpikeResult): void {
  const body = tableBody('memory');
  body.replaceChildren();
  const heapValues = result.memory
    .map((step) => step.jsHeapBytes)
    .filter((value): value is number => value !== null);
  const peakHeap = heapValues.length > 0 ? Math.max(...heapValues) : null;
  const peakCluster = Math.max(...result.memory.map((step) => step.agentClusterBytes ?? 0), 0);

  result.memory.forEach((step, index) => {
    const before = index === 0 ? null : (result.memory[index - 1]?.jsHeapBytes ?? null);
    const delta = step.jsHeapBytes !== null && before !== null ? step.jsHeapBytes - before : null;
    const isPeak = step.agentClusterBytes !== null && step.agentClusterBytes === peakCluster;
    const deltaText = delta === null ? '—' : `${delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}`;
    const heapText =
      formatBytes(step.jsHeapBytes) +
      (step.jsHeapBytes !== null && step.jsHeapBytes === peakHeap ? ' (peak)' : '');
    body.append(
      row(
        [
          step.step,
          formatBytes(step.agentClusterBytes) + (isPeak ? ' (peak)' : ''),
          heapText,
          deltaText,
          step.comment,
        ],
        isPeak ? 'total' : '',
      ),
    );
  });

  const note = document.querySelector('#memory-note');
  if (note instanceof HTMLElement) {
    note.textContent =
      'Agent-cluster total = performance.measureUserAgentSpecificMemory() (main realm + pdf.js worker, GC forced before measuring). ' +
      'JS heap = performance.memory.usedJSHeapSize, which excludes ArrayBuffer backing stores — a 300 MB master copy is invisible to it, which is exactly why both are shown.';
  }
}

function renderBreakdown(result: SpikeResult): void {
  const body = tableBody('breakdown');
  body.replaceChildren();
  for (const entry of result.breakdown) {
    body.append(row([entry.step, entry.label, formatBytes(entry.bytes), entry.types.join(', ')]));
  }
}

function renderTimings(result: SpikeResult): void {
  const body = tableBody('timings');
  body.replaceChildren();
  for (const run of result.runs) {
    body.append(
      row([
        `${run.label} — open (parser + worker handshake)`,
        formatMs(run.openMs),
        '',
        `${run.pages} pages / ${formatBytes(run.bytes)}`,
      ]),
    );
    body.append(
      row([
        `${run.label} — first page rendered`,
        formatMs(run.firstPageMs),
        'first page ≤ 2.5 s for ≤ 10 MB files',
        run.firstPageMs === null
          ? '—'
          : `${run.openToFirstPageMs === null ? '' : `open+render ${formatMs(run.openToFirstPageMs)}`}`,
      ]),
    );
  }
  for (const target of result.targets) {
    body.append(row([target.target, target.measured, target.target, verdictNode(target.verdict)]));
  }
}

function renderSave(result: SpikeResult): void {
  const body = tableBody('save');
  body.replaceChildren();
  for (const run of result.runs) {
    const save = run.save;
    if (!save) continue;
    body.append(
      row(['Run', run.label]),
      row([
        'Annotation-storage key',
        save.keyUsed ?? `none of ${save.keysTried.join(', ') || '(no candidates)'}`,
      ]),
      row(['Input (master copy)', formatBytes(save.inputBytes)]),
      row(['Output buffer returned', formatBytes(save.outputBytes)]),
      row(['Delta (new bytes)', formatBytes(save.deltaBytes)]),
      row([
        'Full-size write',
        `${formatBytes(save.outputBytes)} = originalData.length + delta (PLAN.md §3.3/2)`,
      ]),
      row(['Incremental file format', String(save.incrementalFormat)]),
      row(['New field value found in appended update', String(save.markerFoundInTail)]),
      row(['Field value after re-open', save.fieldValueAfterReopen ?? 'not re-opened']),
      row(['Save time', formatMs(save.ms)]),
      row(['Peak JS heap during save', formatBytes(save.peakHeapDuringSaveBytes)]),
      row(['Error', save.error ?? 'none']),
    );
  }
}

function renderDegradation(result: SpikeResult): void {
  const body = tableBody('degradation');
  body.replaceChildren();
  const item = result.degradation;
  if (!item) {
    body.append(row(['probe', 'not reached']));
    return;
  }
  body.append(
    row(['Document open during probe', String(item.documentOpen)]),
    row(['Extra buffer allocated', formatBytes(item.extraAllocatedBytes)]),
    row(['Allocation time', formatMs(item.allocationMs)]),
    row(['Failed at', item.failedAtBytes === null ? 'never failed' : formatBytes(item.failedAtBytes)]),
    row(['Failure mode observed', item.failureMode]),
    row(['Render under pressure', formatMs(item.renderDuringPressureMs)]),
    row(['Cancel latency under pressure', formatMs(item.cancelDuringPressureMs)]),
    row(['Cancel honoured', String(item.cancelHonoured)]),
    row(['Frame gap under pressure', formatMs(item.frameGapMs)]),
    row(['JS heap during pressure', formatBytes(item.heapDuringPressureBytes)]),
    row(['Second heavy job (a second full open)', item.secondHeavyJob]),
    row(['Tab survived', String(item.survived)]),
  );
}

function renderChecks(result: SpikeResult): void {
  const body = tableBody('checks');
  body.replaceChildren();
  for (const check of result.checks) {
    body.append(row([check.name, check.pass ? span('pass', 'pass') : span('FAIL', 'fail'), check.detail]));
  }
}

function renderSummary(result: SpikeResult): void {
  const element = document.querySelector('#summary-text');
  if (!(element instanceof HTMLElement)) return;
  const biggest = [...result.fixtures].sort((a, b) => b.bytes - a.bytes)[0];
  const sampledPeak = result.peaks.agentClusterPeakBytes;
  const memoryPeak = sampledPeak ?? Math.max(...result.memory.map((step) => step.agentClusterBytes ?? 0), 0);
  const peakLabel =
    sampledPeak === null ? 'peak agent-cluster memory (step samples)' : 'sampled agent-cluster peak';
  const failed = result.checks.filter((check) => !check.pass).length;
  const missed = result.targets.filter((target) => target.verdict === 'missed').length;
  element.textContent =
    biggest === undefined
      ? `running — phase: ${result.phase}`
      : `${biggest.pages} pages / ${formatBytes(biggest.bytes)} fixture · ${peakLabel} ${formatBytes(memoryPeak)} · ` +
        `${result.checks.length - failed}/${result.checks.length} checks pass · ${missed} provisional target(s) missed · phase: ${result.phase}`;
}

function renderRaw(result: SpikeResult): void {
  const element = document.querySelector('#raw');
  if (!(element instanceof HTMLElement)) return;
  element.textContent = JSON.stringify(result, null, 2);
}

export function render(result: SpikeResult): void {
  renderEnvironment(result);
  renderFixtures(result);
  renderPeaks(result);
  renderMemory(result);
  renderBreakdown(result);
  renderTimings(result);
  renderSave(result);
  renderDegradation(result);
  renderChecks(result);
  renderSummary(result);
  renderRaw(result);
}
