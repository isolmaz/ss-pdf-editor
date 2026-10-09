// @vitest-environment happy-dom
/**
 * The modal host of an operation that starts a document: the form it shows, and that the
 * backdrop and Escape leave it open while a run is in flight.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OperationReport } from 'pdf-core';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartDialog } from './StartDialog';
import type { OperationDialogSpec, OperationRunContext, OpRunResult } from './types';

const t = createTranslator('en');
const context: OperationRunContext = {
  bytes: new Uint8Array(),
  pageCount: 0,
  name: '',
  currentPage: 0,
  selectedPages: [],
  t,
};
const report: OperationReport = {
  engine: 'model',
  pageCount: 1,
  inputBytes: 0,
  outputBytes: 10,
  incremental: false,
  steps: [],
  notes: [],
};
const produced: OpRunResult = { files: [], report };

function show() {
  let finish: (result: OpRunResult) => void = () => {};
  const spec: OperationDialogSpec = {
    id: 'blank',
    titleKey: 'op.result.title',
    introKey: 'op.scope.empty',
    confirmKey: 'op.result.newTab',
    resultKind: 'new-tab',
    standalone: true,
    fields: [],
    run: () =>
      new Promise<OpRunResult>((resolve) => {
        finish = resolve;
      }),
  };
  const onClose = vi.fn();
  const onResult = vi.fn();
  render(<StartDialog t={t} spec={spec} context={context} onClose={onClose} onResult={onResult} />);
  return { onClose, onResult, finish: (result: OpRunResult) => finish(result) };
}

afterEach(cleanup);

describe('StartDialog', () => {
  it('names the dialog after the operation and describes it with the intro', () => {
    show();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe(
      screen.getByRole('heading', { name: 'Operation report' }).id,
    );
    expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByText('No pages selected.').id);
  });

  it('closes on Escape while nothing runs', async () => {
    const { onClose } = show();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on Escape while a run is in flight, and opens the one result through the form', async () => {
    const { onClose, onResult, finish } = show();
    await userEvent.click(screen.getByRole('button', { name: 'Open in new tab' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Processing…');

    finish(produced);
    await userEvent.click(await screen.findByRole('button', { name: 'Open in new tab' }));
    expect(onResult).toHaveBeenCalledExactlyOnceWith(produced);
  });
});
