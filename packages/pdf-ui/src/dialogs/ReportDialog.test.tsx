// @vitest-environment happy-dom
/**
 * The report of a result that was delivered unread: named after the operation, showing the
 * report itself, and closed by its button, Escape or the backdrop — nothing else to answer.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OperationReport } from 'pdf-core';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportDialog } from './ReportDialog';

const t = createTranslator('en');
const report: OperationReport = {
  engine: 'mupdf',
  steps: ['stamp'],
  notes: [{ kind: 'changed', key: 'op.note.stamp.drawn', params: { count: 3 } }],
  inputBytes: 2048,
  outputBytes: 4096,
  pageCount: 3,
  incremental: false,
};

afterEach(cleanup);

function show() {
  const onClose = vi.fn();
  render(<ReportDialog t={t} title="Stamp" report={report} onClose={onClose} />);
  return { onClose };
}

describe('ReportDialog', () => {
  it('is named after the operation and shows the report of the run', () => {
    show();
    const dialog = screen.getByRole('dialog', { name: 'Stamp' });
    expect(within(dialog).getByText('3 page(s)')).toBeTruthy();
    expect(within(dialog).getByText('Stamp drawn on 3 page(s).')).toBeTruthy();
  });

  it('closes on its button, and on Escape, but is only ever asked to close', async () => {
    const { onClose } = show();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog', { name: 'Stamp' })).toBeTruthy();
  });
});
