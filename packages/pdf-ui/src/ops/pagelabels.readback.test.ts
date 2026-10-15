/**
 * What the page-label report says when the read-back returns nothing for the pages the plan
 * was written to. A label that is missing must reach the notes as an empty string and as a
 * mismatch warning — an `undefined` note parameter is printed as a raw `{first}` placeholder.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('pdf-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pdf-core')>()),
  readPageLabels: vi.fn(async () => [] as string[]),
}));

import { runDialog, textPdf } from '../pdf-fixtures';
import { pageLabelsDialog } from './pagelabels';

describe('pageLabelsDialog read-back that finds no label', () => {
  it('reports empty labels and a mismatch instead of leaving placeholder parameters undefined', async () => {
    const result = await runDialog(
      pageLabelsDialog,
      { range: '2', style: 'decimal', prefix: '', start: 1 },
      await textPdf([['a'], ['b'], ['c']]),
    );
    expect(result.report.notes).toContainEqual({
      kind: 'preserved',
      key: 'labels.note.verified',
      params: { first: '', last: '' },
    });
    expect(result.report.notes).toContainEqual({
      kind: 'warning',
      key: 'labels.note.mismatch',
      params: { expected: '1', actual: '' },
    });
  });
});
