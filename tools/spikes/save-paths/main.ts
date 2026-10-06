/**
 * Spike #1 driver — runs every branch, renders the table, publishes
 * `window.__spikeResult` for the browser-automation read-back.
 *
 * Throwaway prototype (`PLAN.md §9/K21`); never shipped.
 */
import { BRANCHES, type BranchOutcome, type SpikeContext } from './branches';
import { buildFixture, makeOverlayPng } from './fixture';
import { spikeWindow } from './globals';
import {
  type BranchResult,
  type MeasurementPerformance,
  MemorySampler,
  measureMemory,
  Recorder,
} from './harness';
import { inspectWithPdfjs } from './readers';

const results: BranchResult[] = [];

function cell(row: HTMLTableRowElement, text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  row.append(td);
  return td;
}

function kibValue(bytes: number | null): string {
  return bytes === null ? 'n/a' : `${(bytes / 1024).toFixed(1)} KiB`;
}

function renderRow(result: BranchResult): void {
  const row = document.createElement('tr');
  row.id = `row-${result.id}`;
  if (!result.ok) row.className = 'branch-failed';
  cell(row, result.title);
  cell(row, kibValue(result.inputBytes), 'num');
  cell(row, kibValue(result.outputBytes), 'num');
  cell(row, `${result.deltaBytes >= 0 ? '+' : ''}${(result.deltaBytes / 1024).toFixed(1)} KiB`, 'num');
  cell(row, result.ms.toFixed(0), 'num');
  cell(row, kibValue(result.memBefore), 'num');
  cell(row, kibValue(result.memAfter), 'num');
  cell(
    row,
    result.incrementalFormat === null ? 'n/a' : result.incrementalFormat ? 'yes (format)' : 'full rewrite',
    result.incrementalFormat === null ? undefined : result.incrementalFormat ? 'pass' : 'fail',
  );
  const failures = result.checks.filter((check) => !check.pass);
  const cellDetails = cell(
    row,
    `${result.checks.length - failures.length}/${result.checks.length} pass`,
    failures.length === 0 ? 'pass' : 'fail',
  );
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'details';
  details.append(summary);
  const list = document.createElement('ul');
  list.className = 'checks';
  for (const check of result.checks) {
    const item = document.createElement('li');
    if (!check.pass) item.className = 'bad';
    item.textContent = `${check.name} — ${check.detail}`;
    list.append(item);
  }
  for (const note of result.notes) {
    const item = document.createElement('li');
    item.textContent = `note — ${note}`;
    list.append(item);
  }
  details.append(list);
  cellDetails.append(details);
  if (result.error) {
    const error = document.createElement('p');
    error.className = 'fail';
    error.textContent = result.error;
    cellDetails.append(error);
  }
  cell(
    row,
    failures.length === 0 && result.error === null ? 'PASS' : 'FAIL',
    failures.length === 0 && !result.error ? 'pass' : 'fail',
  );
  const existing = document.getElementById(row.id);
  if (existing) existing.replaceWith(row);
  else document.getElementById('rows')?.append(row);
}

function report(result: BranchResult, index: number, total: number): void {
  results.push(result);
  spikeWindow.__spikeResult = results;
  spikeWindow.__spikeProgress = `${index + 1}/${total} ${result.title}`;
  renderRow(result);
  const progress = document.getElementById('progress');
  if (progress) progress.textContent = spikeWindow.__spikeProgress;
}

async function runBranch(branch: (typeof BRANCHES)[number], context: SpikeContext): Promise<BranchResult> {
  const recorder = new Recorder();
  const memoryBefore = await measureMemory();
  const sampler = new MemorySampler();
  sampler.start();
  const started = performance.now();
  let outcome: BranchOutcome | null = null;
  let error: string | null = null;
  try {
    outcome = await branch.run(context, recorder);
  } catch (thrown) {
    error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    recorder.check('branch completed without throwing', false, error);
  }
  const ms = performance.now() - started;
  const peak = sampler.stop();
  const memoryAfter = await measureMemory();
  const deltaBytes = (outcome?.bytesOut ?? 0) - (outcome?.bytesIn ?? 0);
  return {
    id: branch.id,
    title: branch.title,
    ok: error === null && recorder.failed() === 0,
    inputBytes: outcome?.bytesIn ?? 0,
    outputBytes: outcome?.bytesOut ?? 0,
    deltaBytes,
    ms: Math.round(ms),
    memoryApi: memoryAfter.api,
    memBefore: memoryBefore.bytes,
    memAfter: memoryAfter.bytes,
    memDelta:
      memoryBefore.bytes !== null && memoryAfter.bytes !== null
        ? memoryAfter.bytes - memoryBefore.bytes
        : null,
    peak,
    planPaths: outcome?.planPaths ?? 'n/a',
    planIncremental: outcome?.planIncremental ?? null,
    incrementalFormat: outcome?.incrementalFormat ?? null,
    checks: recorder.checks,
    notes: recorder.notes,
    error,
  };
}

async function runAll(): Promise<BranchResult[]> {
  const button = document.getElementById('run') as HTMLButtonElement | null;
  if (button) button.disabled = true;
  const env = document.getElementById('env');
  try {
    if (env) env.textContent = 'building fixture…';
    const fixture = await buildFixture(5);
    const png = await makeOverlayPng();
    const source = await inspectWithPdfjs(fixture.bytes);
    const context: SpikeContext = { fixture, png, source };
    const isolation = globalThis.crossOriginIsolated === true;
    const perf = performance as MeasurementPerformance;
    const baseEnv = `fixture ${(fixture.bytes.byteLength / 1024).toFixed(1)} KiB · ${fixture.pageCount} pages · token ${fixture.token} · crossOriginIsolated=${isolation} · isolated-API=${typeof perf.measureUserAgentSpecificMemory === 'function'}`;
    if (env) env.textContent = baseEnv;
    for (const [index, branch] of BRANCHES.entries()) {
      if (env) env.textContent = `${baseEnv} · branch ${index + 1}/${BRANCHES.length}: ${branch.title}`;
      report(await runBranch(branch, context), index, BRANCHES.length);
    }
    if (env) env.textContent = baseEnv;
    const detail = document.getElementById('detail');
    if (detail) {
      detail.hidden = false;
      detail.textContent = JSON.stringify(results, null, 2);
    }
    return results;
  } catch (thrown) {
    const message =
      thrown instanceof Error ? `${thrown.name}: ${thrown.message}\n${thrown.stack ?? ''}` : String(thrown);
    spikeWindow.__spikeError = message;
    if (env) env.textContent = `harness error: ${message}`;
    return results;
  } finally {
    if (button) button.disabled = false;
  }
}

spikeWindow.__spikeRun = runAll;
document.getElementById('run')?.addEventListener('click', () => {
  void runAll();
});
