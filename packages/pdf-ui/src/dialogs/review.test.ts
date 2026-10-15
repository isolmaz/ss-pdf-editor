/**
 * Which results are read before they reach the document: anything lost, warned about or
 * approximated, and a result with nothing to apply. Everything else is delivered at once.
 */

import type { OperationNote, OperationReport } from 'pdf-core/ops/types';
import { describe, expect, it } from 'vitest';
import { resultNeedsReview } from './review';
import type { OpRunResult } from './types';

const file = { name: 'out.pdf', bytes: new Uint8Array([1]), mime: 'application/pdf' };

function result(notes: readonly OperationNote[], files: OpRunResult['files'] = [file]): OpRunResult {
  const report: OperationReport = {
    engine: 'model',
    steps: [],
    notes,
    inputBytes: 10,
    outputBytes: 10,
    pageCount: 1,
    incremental: true,
  };
  return { files, report };
}

describe('resultNeedsReview', () => {
  it('delivers a result with no notes, or only what was done and what was kept, at once', () => {
    expect(resultNeedsReview(result([]))).toBe(false);
    expect(
      resultNeedsReview(
        result([
          { kind: 'changed', key: 'op.note.stamp.drawn', params: { count: 3 } },
          { kind: 'preserved', key: 'op.note.stamp.untouchedPages', params: { count: 2 } },
        ]),
      ),
    ).toBe(false);
  });

  it('reviews anything that was lost', () => {
    expect(resultNeedsReview(result([{ kind: 'lost', key: 'op.note.merge.outlineLost' }]))).toBe(true);
  });

  it('reviews any warning, among a run of harmless notes too', () => {
    expect(
      resultNeedsReview(
        result([
          { kind: 'changed', key: 'op.note.stamp.drawn', params: { count: 3 } },
          { kind: 'warning', key: 'op.note.stamp.noPrint' },
          { kind: 'preserved', key: 'op.note.stamp.untouchedPages', params: { count: 2 } },
        ]),
      ),
    ).toBe(true);
  });

  it('reviews a change that says the output is not what was asked for, and no other change', () => {
    expect(resultNeedsReview(result([{ kind: 'changed', key: 'op.note.findReplace.shrunk' }]))).toBe(true);
    expect(resultNeedsReview(result([{ kind: 'changed', key: 'op.note.findReplace.replaced' }]))).toBe(false);
    // The same sentence as a guarantee is not a caveat.
    expect(resultNeedsReview(result([{ kind: 'preserved', key: 'op.note.findReplace.shrunk' }]))).toBe(false);
  });

  it('reads the report of a result that has no file to apply', () => {
    expect(resultNeedsReview(result([], []))).toBe(true);
    expect(resultNeedsReview(result([{ kind: 'preserved', key: 'form.note.valid' }], []))).toBe(true);
  });
});
