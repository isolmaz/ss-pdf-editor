// @vitest-environment happy-dom
/**
 * One operation's form, whichever surface hosts it: what it asks, what it refuses to run, what
 * it shows while running, after a failure or a cancel, and what the result step offers.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OperationProgress, OperationReport } from 'pdf-core';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationForm } from './OperationForm';
import type {
  DialogParams,
  OperationDialogSpec,
  OperationRunContext,
  OpRunContext,
  OpRunResult,
} from './types';

const t = createTranslator('en');

const context: OperationRunContext = {
  bytes: new Uint8Array(),
  pageCount: 3,
  name: 'a.pdf',
  currentPage: 0,
  selectedPages: [],
  t,
};
const report: OperationReport = {
  engine: 'model',
  pageCount: 3,
  inputBytes: 10,
  outputBytes: 10,
  incremental: true,
  steps: [],
  notes: [],
};
const file = { name: 'out.pdf', bytes: new Uint8Array([1]), mime: 'application/pdf' };
const clean: OpRunResult = { files: [file], report };
const warned: OpRunResult = {
  files: [file],
  report: { ...report, notes: [{ kind: 'warning', key: 'op.note.stamp.noPrint' }] },
};

/** A run the test settles by hand; `runs` records the params and context each start saw. */
function job(overrides: Partial<OperationDialogSpec> = {}) {
  let tick: (progress: OperationProgress) => void = () => {};
  let resolve: (result: OpRunResult) => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const runs: { params: DialogParams; context: OpRunContext }[] = [];
  const spec: OperationDialogSpec = {
    id: 'probe',
    titleKey: 'op.result.title',
    confirmKey: 'op.apply',
    resultKind: 'replace',
    fields: [{ kind: 'text', id: 'label', labelKey: 'op.scope', defaultValue: 'plain' }],
    run: (params, runContext) => {
      runs.push({ params, context: runContext });
      tick = runContext.onProgress;
      return new Promise<OpRunResult>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
    },
    ...overrides,
  };
  return {
    spec,
    runs,
    tick: (progress: OperationProgress) => tick(progress),
    resolve: (result: OpRunResult) => resolve(result),
    reject: (cause: unknown) => reject(cause),
  };
}

function show(spec: OperationDialogSpec, overrides: Partial<OperationRunContext> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onResult: vi.fn<(result: OpRunResult) => void | Promise<void>>(),
    onRunningChange: vi.fn(),
  };
  const form = (onResult: typeof handlers.onResult) => (
    <OperationForm
      t={t}
      spec={spec}
      context={{ ...context, ...overrides }}
      renderTitle={(text) => <h2>{text}</h2>}
      renderIntro={(text) => <p data-testid="intro">{text}</p>}
      {...handlers}
      onResult={onResult}
    />
  );
  const { rerender } = render(form(handlers.onResult));
  return { ...handlers, hostChanged: (onResult: typeof handlers.onResult) => rerender(form(onResult)) };
}

const click = (name: string) => userEvent.click(screen.getByRole('button', { name }));
const field = () => screen.getByRole('textbox', { name: 'Page range' });

afterEach(cleanup);

describe('OperationForm settings step', () => {
  it('opens on the spec defaults, with the title and the intro', () => {
    const { spec } = job({ introKey: 'op.scope.empty' });
    show(spec);
    expect(screen.getByRole('heading', { name: 'Operation report' })).toBeTruthy();
    expect(screen.getByTestId('intro').textContent).toBe('No pages selected.');
    expect((field() as HTMLInputElement).value).toBe('plain');
    // No numbered step marker: the form is one screen, and a review only exists when one is due.
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
  });

  it('lets the spec seed fields from the context, and the opener preset overrule both', () => {
    const { spec } = job({ initialValues: (runContext) => ({ label: runContext.name }) });
    show(spec);
    expect((field() as HTMLInputElement).value).toBe('a.pdf');
    cleanup();
    show(spec, { presets: { label: 'preset' } });
    expect((field() as HTMLInputElement).value).toBe('preset');
  });

  it('opens a selection scope on the current page when nothing is selected, and on the selection otherwise', async () => {
    const probe = job({
      fields: [{ kind: 'pageScope', id: 'scope', labelKey: 'op.scope', default: 'selection' }],
    });
    show(probe.spec, { currentPage: 1, selectedPages: [] });
    expect(screen.getByRole('combobox', { name: 'Page range' }).textContent).toBe('Current page (2)');
    await click('Apply');
    expect(probe.runs[0]?.params.scope).toBe('current');
    cleanup();
    show(probe.spec, { currentPage: 1, selectedPages: [0, 2] });
    expect(screen.getByRole('combobox', { name: 'Page range' }).textContent).toBe('Selected pages (2)');
  });

  it('runs with the values the user typed and the frozen context', async () => {
    const probe = job();
    show(probe.spec);
    await userEvent.clear(field());
    await userEvent.type(field(), 'typed');
    await click('Apply');
    expect(probe.runs).toHaveLength(1);
    expect(probe.runs[0]?.params).toEqual({ label: 'typed' });
    expect(probe.runs[0]?.context.name).toBe('a.pdf');
    expect(probe.runs[0]?.context.pageCount).toBe(3);
  });

  it('offers the options a document-derived field resolves from the frozen context', () => {
    const { spec } = job({
      fields: [
        {
          kind: 'choice',
          id: 'target',
          labelKey: 'op.scope',
          defaultValue: '0|Im0',
          options: (runContext) => [{ value: '0|Im0', label: `${runContext.name} image` }],
        },
        { kind: 'text', id: 'ignored', labelKey: 'op.scope.placeholder', defaultValue: '' },
      ],
    });
    show(spec);
    expect(screen.getByRole('combobox', { name: 'Page range' }).textContent).toBe('a.pdf image');
  });

  it('refuses to run while a field is wrong', async () => {
    const probe = job({
      fields: [{ kind: 'number', id: 'n', labelKey: 'op.scope', defaultValue: 5, min: 1, max: 10 }],
    });
    show(probe.spec);
    const input = screen.getByRole('spinbutton', { name: 'Page range' });
    await userEvent.clear(input);
    await userEvent.type(input, '99');
    const confirm = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.click(confirm);
    expect(probe.runs).toHaveLength(0);
  });

  it('closes without applying anything', async () => {
    const { spec } = job();
    const { onClose, onResult } = show(spec);
    await click('Cancel');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe('OperationForm destructive confirmation', () => {
  it('asks twice, puts the way out first and runs only on the second answer', async () => {
    const probe = job({ destructive: true });
    show(probe.spec);
    await click('Apply');
    expect(probe.runs).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toBe(
      'This operation may permanently delete content. Continue?',
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

    await click('Continue');
    expect(probe.runs).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('OperationForm while running', () => {
  it('reports each phase and its page count, hides the fields and says when a tick has no count yet', async () => {
    const probe = job();
    const { onRunningChange } = show(probe.spec);
    await click('Apply');
    expect(onRunningChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('status').textContent).toBe('Processing…');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();

    probe.tick({ phase: 'render', labelKey: 'op.running', done: 2, total: 5 });
    await waitFor(() => expect(screen.getByText('2/5 page(s)')).toBeTruthy());
    expect(screen.getByRole('meter', { name: 'Operation progress' })).toBeTruthy();

    probe.tick({ phase: 'render', labelKey: 'op.running', total: 5 });
    await waitFor(() => expect(screen.getByText('0/5 page(s)')).toBeTruthy());

    probe.tick({ phase: 'prepare', labelKey: 'op.cancelled' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Operation cancelled.'));
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('fills a phase sentence`s own counters with whole numbers instead of printing {done} or a fraction', async () => {
    const probe = job();
    show(probe.spec);
    await click('Apply');

    // OCR reports `position + fraction`: 2.4 is the third page, part-way through.
    probe.tick({ phase: 'ocr', labelKey: 'ocr.running', done: 2.4, total: 10 });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Recognizing page 3/10'));
    expect(screen.getByText('2/10 page(s)')).toBeTruthy();

    probe.tick({ phase: 'ocr', labelKey: 'ocr.running', done: 10, total: 10 });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Recognizing page 10/10'));
    expect(screen.getByText('10/10 page(s)')).toBeTruthy();
  });

  it('cancels the job on request, keeps the fields for a retry and says it was cancelled', async () => {
    const probe = job();
    const { onRunningChange, onClose } = show(probe.spec);
    await click('Apply');
    const [leave, stop] = screen.getAllByRole('button', { name: 'Cancel' });
    expect(leave).toBeTruthy();
    await userEvent.click(stop as HTMLElement);

    expect(probe.runs[0]?.context.signal.aborted).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Operation cancelled.');
    expect((field() as HTMLInputElement).value).toBe('plain');
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
    expect(onClose).not.toHaveBeenCalled();

    await click('Apply');
    expect(probe.runs).toHaveLength(2);
  });

  it('cancels a running job when the dialog is left', async () => {
    const probe = job();
    const { onClose } = show(probe.spec);
    await click('Apply');
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0] as HTMLElement);
    expect(probe.runs[0]?.context.signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('OperationForm after a failure', () => {
  it('shows what happened, what to do and the engine text, and keeps the fields for a retry', async () => {
    const probe = job();
    show(probe.spec);
    await click('Apply');
    probe.reject(new Error('kaboom'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Something unexpected went wrong.Try again; report it if it keeps happening.',
    );
    expect(alert.querySelector('[data-dialog-diagnostic]')?.getAttribute('data-dialog-diagnostic')).toBe(
      'kaboom',
    );
    expect((field() as HTMLInputElement).value).toBe('plain');

    await click('Apply');
    expect(probe.runs).toHaveLength(2);
  });

  it('shows no diagnostic when the engine gave no text', async () => {
    const probe = job();
    show(probe.spec);
    await click('Apply');
    probe.reject(new ToolError('internal', { engine: 'test' }));
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('[data-dialog-diagnostic]')).toBeNull();
  });
});

describe('OperationForm result step', () => {
  async function finished(
    result: OpRunResult,
    overrides: Partial<OperationDialogSpec> = {},
    delivery: () => void | Promise<void> = () => new Promise<void>(() => undefined),
  ) {
    const probe = job({ introKey: 'op.scope.empty', ...overrides });
    const handlers = show(probe.spec);
    handlers.onResult.mockImplementation(delivery);
    await click('Apply');
    probe.resolve(result);
    return handlers;
  }
  const review = () => screen.findByRole('heading', { level: 3, name: 'Review the result' });

  it('hands a clean result to the host at once: no report, no second button, no way out mid-delivery', async () => {
    const { onResult, onClose, onRunningChange } = await finished(clean);
    await waitFor(() => expect(onResult).toHaveBeenCalledExactlyOnceWith(clean));
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Processing…');
    expect(screen.queryByRole('button')).toBeNull();
    expect(onRunningChange).toHaveBeenLastCalledWith(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hands the result over once however often the host renders the form with a new handler', async () => {
    const { onResult, hostChanged } = await finished(clean);
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    const other = vi.fn<(result: OpRunResult) => void | Promise<void>>();
    hostChanged(other);
    hostChanged(onResult);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('falls back to the review when the host ends its delivery and the form is still there', async () => {
    const { onResult, onRunningChange } = await finished(clean, {}, async () => undefined);
    await review();
    expect(screen.getByText('3 page(s)')).toBeTruthy();
    expect(onRunningChange).toHaveBeenLastCalledWith(false);

    await click('Apply to document');
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenLastCalledWith(clean);
  });

  it('keeps the review for a result with a warning, and applies only through the one button', async () => {
    const { onResult, onClose } = await finished(warned);
    await review();
    expect(screen.queryByTestId('intro')).toBeNull();
    expect(onResult).not.toHaveBeenCalled();

    await click('Apply to document');
    expect(onResult).toHaveBeenCalledExactlyOnceWith(warned);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the review for a result that has no file to apply, since its report is the answer', async () => {
    const { onResult } = await finished({ files: [], report });
    await review();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('discards the result on Close', async () => {
    const { onResult, onClose } = await finished(warned);
    await review();
    await click('Close');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('names the review action after what the result becomes', async () => {
    await finished(warned, { resultKind: 'new-tab' });
    await review();
    expect(screen.getByRole('button', { name: 'Open in new tab' })).toBeTruthy();
  });

  it('lets a run overrule the spec: a replace dialog that produced data offers a download', async () => {
    const { onResult } = await finished({ ...warned, deliver: 'download' });
    await review();
    await click('Download');
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('still asks once before a destructive run, and delivers its clean result without asking again', async () => {
    const probe = job({ destructive: true });
    const { onResult } = show(probe.spec);
    await click('Apply');
    await click('Continue');
    probe.resolve(clean);
    await waitFor(() => expect(onResult).toHaveBeenCalledExactlyOnceWith(clean));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
