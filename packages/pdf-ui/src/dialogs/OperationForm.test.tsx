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
const produced: OpRunResult = { files: [], report };

/** A run the test settles by hand; `runs` records the params and context each start saw. */
function job(overrides: Partial<OperationDialogSpec> = {}) {
  let tick: (progress: OperationProgress) => void = () => {};
  let resolve: (result: OpRunResult) => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const runs: { params: DialogParams; context: OpRunContext }[] = [];
  const spec: OperationDialogSpec = {
    id: 'probe',
    titleKey: 'op.result.title',
    confirmKey: 'op.result.apply',
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
    onResult: vi.fn(),
    onRunningChange: vi.fn(),
  };
  render(
    <OperationForm
      t={t}
      spec={spec}
      context={{ ...context, ...overrides }}
      renderTitle={(text) => <h2>{text}</h2>}
      renderIntro={(text) => <p data-testid="intro">{text}</p>}
      {...handlers}
    />,
  );
  return handlers;
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
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toBe('1Settings');
  });

  it('lets the spec seed fields from the context, and the opener preset overrule both', () => {
    const { spec } = job({ initialValues: (runContext) => ({ label: runContext.name }) });
    show(spec);
    expect((field() as HTMLInputElement).value).toBe('a.pdf');
    cleanup();
    show(spec, { presets: { label: 'preset' } });
    expect((field() as HTMLInputElement).value).toBe('preset');
  });

  it('runs with the values the user typed and the frozen context', async () => {
    const probe = job();
    show(probe.spec);
    await userEvent.clear(field());
    await userEvent.type(field(), 'typed');
    await click('Apply to document');
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
    const confirm = screen.getByRole('button', { name: 'Apply to document' }) as HTMLButtonElement;
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
    await click('Apply to document');
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
    await click('Apply to document');
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

  it('cancels the job on request, keeps the fields for a retry and says it was cancelled', async () => {
    const probe = job();
    const { onRunningChange, onClose } = show(probe.spec);
    await click('Apply to document');
    const [leave, stop] = screen.getAllByRole('button', { name: 'Cancel' });
    expect(leave).toBeTruthy();
    await userEvent.click(stop as HTMLElement);

    expect(probe.runs[0]?.context.signal.aborted).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Operation cancelled.');
    expect((field() as HTMLInputElement).value).toBe('plain');
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
    expect(onClose).not.toHaveBeenCalled();

    await click('Apply to document');
    expect(probe.runs).toHaveLength(2);
  });

  it('cancels a running job when the dialog is left', async () => {
    const probe = job();
    const { onClose } = show(probe.spec);
    await click('Apply to document');
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0] as HTMLElement);
    expect(probe.runs[0]?.context.signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('OperationForm after a failure', () => {
  it('shows what happened, what to do and the engine text, and keeps the fields for a retry', async () => {
    const probe = job();
    show(probe.spec);
    await click('Apply to document');
    probe.reject(new Error('kaboom'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Something unexpected went wrong.Try again; report it if it keeps happening.',
    );
    expect(alert.querySelector('[data-dialog-diagnostic]')?.getAttribute('data-dialog-diagnostic')).toBe(
      'kaboom',
    );
    expect((field() as HTMLInputElement).value).toBe('plain');

    await click('Apply to document');
    expect(probe.runs).toHaveLength(2);
  });

  it('shows no diagnostic when the engine gave no text', async () => {
    const probe = job();
    show(probe.spec);
    await click('Apply to document');
    probe.reject(new ToolError('internal', { engine: 'test' }));
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('[data-dialog-diagnostic]')).toBeNull();
  });
});

describe('OperationForm result step', () => {
  async function finished(overrides: Partial<OperationDialogSpec> = {}, result: OpRunResult = produced) {
    const probe = job({ introKey: 'op.scope.empty', ...overrides });
    const handlers = show(probe.spec);
    await click('Apply to document');
    probe.resolve(result);
    await screen.findByRole('heading', { level: 3, name: 'Operation report' });
    return handlers;
  }

  it('shows the report on the second step, without the intro, and applies only through the one button', async () => {
    const { onResult, onClose } = await finished();
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toBe('2Review and apply');
    expect(screen.queryByTestId('intro')).toBeNull();
    expect(screen.getByText('3 page(s)')).toBeTruthy();
    expect(onResult).not.toHaveBeenCalled();

    await click('Apply to document');
    expect(onResult).toHaveBeenCalledExactlyOnceWith(produced);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('discards the result on Close', async () => {
    const { onResult, onClose } = await finished();
    await click('Close');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('names the action after what the result becomes', async () => {
    await finished({ resultKind: 'new-tab' });
    expect(screen.getByRole('button', { name: 'Open in new tab' })).toBeTruthy();
  });

  it('lets a run overrule the spec: a replace dialog that produced data offers a download', async () => {
    const { onResult } = await finished({}, { ...produced, deliver: 'download' });
    await click('Download');
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});
