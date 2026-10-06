/**
 * Model-side measurements (`PLAN.md §7`, `R09`).
 *
 *   pnpm measure:model
 *
 * These are `it()` cases that **print** numbers instead of asserting them, and they run
 * under `vitest.measure.config.ts` rather than `pnpm unit`, for one reason: a measurement
 * that fails a build is a measurement somebody will tune until it passes, and then it stops
 * being a measurement. The output is the evidence; the thresholds are the reader's.
 *
 * What is measured:
 *
 *  - **Journal cost against history depth.** `append` copies the array it keeps, which is
 *    the price of handing out stable snapshots (`F11`). Whether that price matters at
 *    realistic depths is a question for a number, not a preference.
 *  - **Snapshot retention against the byte budget.** `#remember` applies a byte budget but
 *    also keeps a minimum number of snapshots whatever the budget says, so a document whose
 *    versions are each larger than the budget keeps that minimum. This reports the shape
 *    that does, and what it costs.
 *  - **Engine-value encode/decode**, because the draft writer runs it on every debounced
 *    save.
 *
 * What is **not** measured, and is not claimed: frame rate, render latency, OCR throughput,
 * or browser heap. Those need the engines and a real browser; these numbers are model byte
 * counts and Node wall-clock timings.
 */

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { decodeEngineValues, encodeEngineValues, sourceKeyFor } from '../../packages/pdf-model/src/drafts';
import { SessionStore } from '../../packages/pdf-model/src/session';

const MIB = 1024 * 1024;
const rows: string[] = [];

function report(metric: string, value: string, detail: string): void {
  rows.push(`${metric.padEnd(30)} ${value.padStart(14)}  ${detail}`);
}

/** Median of `runs` timings of `work`, in milliseconds. */
function medianMs(runs: number, work: () => void): number {
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    work();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

/** A store with one 10-page document open and `depth` operations already applied. */
function storeAtDepth(depth: number, versionBytes = 1024): { store: SessionStore; tabId: string } {
  const store = new SessionStore();
  const tab = store.openDocument({
    name: 'measure.pdf',
    bytes: new Uint8Array(64 * 1024),
    sha256: 'a'.repeat(64),
    pageCount: 10,
  });
  for (let index = 0; index < depth; index += 1) {
    store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array(versionBytes),
      pageCount: 10,
      labelKey: 'op.progress.compose.rotate',
      engine: 'mupdf',
      steps: ['rotate'],
      overlays: null,
    });
  }
  return { store, tabId: tab.id };
}

function applyOne(store: SessionStore, tabId: string): void {
  store.applyOperation({
    tabId,
    bytes: new Uint8Array(1024),
    pageCount: 10,
    labelKey: 'op.progress.compose.rotate',
    engine: 'mupdf',
    steps: ['rotate'],
    overlays: null,
  });
}

describe('measurements', () => {
  it('reports journal and retention numbers', async () => {
    for (const depth of [100, 1_000, 10_000]) {
      const { store, tabId } = storeAtDepth(depth);
      report(
        'journal.append',
        `${medianMs(200, () => applyOne(store, tabId)).toFixed(4)} ms`,
        `history depth ${depth}`,
      );
      report(
        'journal.undo+redo',
        `${medianMs(200, () => {
          store.undo(tabId);
          store.redo(tabId);
        }).toFixed(4)} ms`,
        `history depth ${depth}`,
      );
    }

    for (const versionMiB of [8, 40, 130]) {
      const { store, tabId } = storeAtDepth(6, versionMiB * MIB);
      const retained = store.snapshotsFor(tabId);
      const bytes = retained.reduce((sum, item) => sum + item.bytes.byteLength, 0);
      report(
        'snapshots.retained',
        `${(bytes / MIB).toFixed(1)} MiB`,
        `${retained.length} version(s) of ${versionMiB} MiB`,
      );
    }

    const entries = Array.from({ length: 500 }, (_, index): [string, Record<string, unknown>] => [
      `annot-${index}`,
      {
        value: `Metin ${index}`,
        kind: 'highlight',
        rect: [100, 200, 300, 240],
        pageIndex: index % 10,
        bitmap: new Blob([new Uint8Array(24 * 1024)]),
      },
    ]);
    const encodeStarted = performance.now();
    const encoded = await encodeEngineValues(entries);
    report(
      'engineValues.encode',
      `${(performance.now() - encodeStarted).toFixed(2)} ms`,
      `500 annotations, 11.7 MiB of bitmaps`,
    );
    const decodeStarted = performance.now();
    decodeEngineValues(encoded);
    report('engineValues.decode', `${(performance.now() - decodeStarted).toFixed(2)} ms`, '500 annotations');
    report('engineValues.dropped', `${encoded.dropped}`, 'entries refused by the 2 MiB bitmap budget');
    report(
      'sourceKeyFor',
      `${(medianMs(2000, () => sourceKeyFor('tab', 'b'.repeat(64))) * 1000).toFixed(2)} µs`,
      'content-addressed',
    );

    console.log(`\nmeasure:model — Node ${process.version}\n${rows.join('\n')}\n`);
    // The only assertion: the measurement ran. The numbers are the deliverable.
    expect(rows.length).toBeGreaterThan(0);
  });
});
