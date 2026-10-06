/**
 * DOM rendering for spike #2 — a compact table plus `window.__spikeResult`.
 * Nothing here is product UI; it exists so a human can see the same numbers the
 * automation reads.
 */
import type { CheckResult, SpikeResult } from './types';

declare global {
  interface Window {
    __spikeResult?: SpikeResult;
    __spikePhase?: string;
    __spikeStep?: string;
  }
}

export function check(
  id: string,
  label: string,
  ok: boolean,
  expected: unknown,
  actual: unknown,
  detail?: string,
): CheckResult {
  return { id, label, ok, expected: String(expected), actual: String(actual), ...(detail ? { detail } : {}) };
}

/** The page never reloads itself: the driver (or this button) does it for real. */
export function wireReloadButton(id: string): void {
  document.getElementById(id)?.addEventListener('click', () => location.reload());
}

export function setPhase(phase: string, text: string): void {
  window.__spikePhase = phase;
  const element = document.getElementById('phase');
  if (element) {
    element.textContent = `${phase} — ${text}`;
    element.dataset.phase = phase;
  }
  const summary = document.getElementById('summary-text');
  if (summary) summary.textContent = text;
}

export function publish(result: SpikeResult): void {
  window.__spikeResult = result;
  renderChecks(result.checks);
  renderNumbers(metricRows(result));
  const raw = document.getElementById('raw');
  if (raw) raw.textContent = JSON.stringify(result, null, 2);
  setPhase(
    result.phase === 'done' ? (result.verdict === 'PASS' ? 'done' : 'failed') : result.phase,
    summaryLine(result),
  );
}

function summaryLine(result: SpikeResult): string {
  const failed = result.checks.filter((entry) => !entry.ok).length;
  return `${result.verdict} — ${result.checks.length - failed}/${result.checks.length} checks passed, ${result.mismatches.length} digest mismatches, ${result.restored ? `${result.restored.replayedEntries} entries replayed after reload` : 'phase 1 only'}`;
}

function renderChecks(checks: readonly CheckResult[]): void {
  const body = document.querySelector('#checks tbody');
  if (!body) return;
  body.textContent = '';
  for (const entry of checks) {
    const row = document.createElement('tr');
    row.className = entry.ok ? 'ok' : 'bad';
    for (const value of [entry.label, entry.expected, entry.actual, entry.ok ? 'ok' : 'MISMATCH']) {
      const cell = document.createElement('td');
      cell.className = 'mono';
      cell.textContent = value;
      row.append(cell);
    }
    if (entry.detail) row.title = entry.detail;
    body.append(row);
  }
}

function renderNumbers(rows: readonly (readonly [string, string])[]): void {
  const body = document.querySelector('#numbers tbody');
  if (!body) return;
  body.textContent = '';
  for (const [metric, value] of rows) {
    const row = document.createElement('tr');
    const left = document.createElement('td');
    left.textContent = metric;
    const right = document.createElement('td');
    right.className = 'mono';
    right.textContent = value;
    row.append(left, right);
    body.append(row);
  }
}

function metricRows(result: SpikeResult): (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = [
    ['phase', result.phase],
    ['verdict', result.verdict],
    ['operations', String(result.steps.operations)],
    ['operations distinct', String(result.steps.operationsDistinct)],
    ['undo / redo (phase 1)', `${result.steps.undo} / ${result.steps.redo}`],
    ['undo / redo (after reload)', `${result.steps.continuedUndo} / ${result.steps.continuedRedo}`],
    ['digest mismatches', String(result.mismatches.length)],
    ['crossOriginIsolated', String(result.isolation.crossOriginIsolated)],
  ];
  if (result.restored) {
    rows.push(
      ['restored entries / cursor', `${result.restored.entries} / ${result.restored.cursor}`],
      ['replayed after reload', String(result.restored.replayedEntries)],
      ['digest matched persisted cursor', String(result.restored.digestMatchesPersistedCursor)],
      ['stamp source after reopen', result.restored.stampSource],
    );
  }
  if (result.engineEvidence) {
    rows.push(
      ['pdf.js version', String(result.engineEvidence.pdfjsVersion)],
      ['CommandManager maxSize', String(result.engineEvidence.defaultMaxSize)],
      ['engine history is the store', 'no (function objects)'],
    );
  }
  for (const [key, value] of Object.entries(result.timings))
    rows.push([`t: ${key}`, `${value.toFixed(1)} ms`]);
  return rows;
}
