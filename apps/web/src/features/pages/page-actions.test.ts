// @vitest-environment happy-dom
/**
 * What the user does to a document's pages and history. The session is the real
 * `SessionStore` and the core store is the real one; the only fakes are the engine handles (a
 * handle is a pdf.js worker) and the two operations that would drive them, so every assertion is
 * about the exact calls the handlers make into the session, the operations and the shell.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { JsonValue } from 'pdf-model';
import { SessionStore } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type * as Operations from '../../operations';
import { applyHistoryStep, applyPageAction, type DocumentContext } from '../../operations';
import { coreStore, initialCoreState, isBusy, setBusy } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import {
  type ActionHost,
  cancelOperation,
  type PressHost,
  runPageAction,
  stepHistory,
  stepHistoryNow,
  usePageActions,
} from './page-actions';

vi.mock('../../operations', async (importOriginal) => ({
  ...(await importOriginal<typeof Operations>()),
  applyPageAction: vi.fn(),
  applyHistoryStep: vi.fn(),
}));

const t = createTranslator('en');
const pageAction = vi.mocked(applyPageAction);
const historyStep = vi.mocked(applyHistoryStep);

function fakeHandle(pageCount = 3): PdfDocumentHandle {
  return { pageCount, destroy: vi.fn(async () => undefined) } as unknown as PdfDocumentHandle;
}

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** One macrotask: every microtask the code under test queued has run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Wait for the history chain to drain. A press on a document that is already held by another
 * operation is refused when nothing is pending and queued (and then declined by its own gate)
 * when something is, so `false` means the chain is idle.
 */
async function settle(): Promise<void> {
  await vi.waitFor(() => {
    const probe = pressHost(probeSession, { cancel: { current: new AbortController() } });
    expect(stepHistoryNow(probe, 'undo')).toBe(false);
  });
}

let session: SessionStore;
let tabId: string;
let handle: PdfDocumentHandle;
let probeSession: SessionStore;
const opened: string[] = [];

function openTab(name = 'doc.pdf', pageCount = 3): { id: string; handle: PdfDocumentHandle } {
  const tab = session.openDocument({ name, bytes: new Uint8Array([1]), sha256: name, pageCount });
  const made = fakeHandle(pageCount);
  adoptHandle(tab.id, made);
  opened.push(tab.id);
  return { id: tab.id, handle: made };
}

type ActionMocks = ActionHost & {
  readonly setProgress: Mock;
  readonly setHandle: Mock;
  readonly refuseBusy: Mock;
};

function actionHost(overrides: Partial<ActionHost> = {}): ActionMocks {
  return {
    session,
    t,
    cancel: { current: null },
    canEdit: { current: true },
    selectedPages: { current: [] },
    currentPage: { current: 0 },
    contextFor: (tab, live): DocumentContext => ({ store: session, t, tab, handle: live }),
    setHandle: vi.fn(),
    refuseBusy: vi.fn(),
    setProgress: vi.fn(),
    ...overrides,
  } as ActionMocks;
}

function pressHost(
  target: SessionStore,
  options: {
    sweep?: Promise<void> | null;
    settle?: boolean;
    checkpoint?: () => Promise<boolean>;
    cancel?: { current: AbortController | null };
  } = {},
) {
  const refuseBusy = vi.fn();
  const setHandle = vi.fn();
  const setCurrentPage = vi.fn();
  const sweepOrphanAnnotations = vi.fn(async () => undefined);
  const settleNativeEditors = vi.fn(() => options.settle ?? false);
  const checkpointEngineValues = vi.fn(options.checkpoint ?? (async () => true));
  const host: PressHost = {
    session: target,
    t,
    cancel: options.cancel ?? { current: null },
    engineValues: new Map(),
    orphanSweep: { current: options.sweep ?? null },
    contextFor: (tab, live) => ({ store: target, t, tab, handle: live }),
    setHandle,
    refuseBusy,
    setCurrentPage,
    settleNativeEditors,
    sweepOrphanAnnotations,
    checkpointEngineValues,
  };
  return Object.assign(host, { mocks: { refuseBusy, setHandle, setCurrentPage, sweepOrphanAnnotations } });
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  session = new SessionStore();
  ({ id: tabId, handle } = openTab());
  probeSession = new SessionStore();
  const probe = probeSession.openDocument({
    name: 'probe.pdf',
    bytes: new Uint8Array([1]),
    sha256: 'probe',
    pageCount: 1,
  });
  adoptHandle(probe.id, fakeHandle(1));
  opened.push(probe.id);
  pageAction.mockReset();
  historyStep.mockReset();
});

afterEach(async () => {
  cleanup();
  await settle();
  for (const id of opened.splice(0)) dropHandle(id);
});

describe('runPageAction', () => {
  it('rotates the page on screen when nothing is selected, and says what happened', async () => {
    const next = fakeHandle();
    pageAction.mockResolvedValue(next);
    const host = actionHost({ currentPage: { current: 2 } });

    runPageAction(host, { kind: 'rotate', direction: 'right' });

    expect(isBusy()).toBe(true);
    expect(host.cancel.current).toBeInstanceOf(AbortController);
    expect(host.setProgress).toHaveBeenNthCalledWith(1, {
      phase: 'pages',
      labelKey: 'op.step.pages',
      total: 1,
      done: 0,
    });
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    const [context, selection, action, operation] = pageAction.mock.calls[0] ?? [];
    expect(context).toMatchObject({ store: session, handle });
    expect(context?.tab.id).toBe(tabId);
    expect(selection).toEqual([2]);
    expect(action).toEqual({ kind: 'rotate', direction: 'right' });
    expect(operation?.signal.aborted).toBe(false);
    expect(operation?.onProgress).toBe(host.setProgress);
    expect(host.setHandle).toHaveBeenCalledWith(tabId, next);
    expect(coreStore.get().notice).toBe(
      t('op.result.applied', { label: t('pages.rotate.done', { count: 1 }) }),
    );
    expect(host.setProgress).toHaveBeenLastCalledWith(null);
    expect(host.cancel.current).toBeNull();
  });

  it('acts on the page panel’s selection, and a control that names its pages wins over it', async () => {
    pageAction.mockResolvedValue(fakeHandle());
    const host = actionHost({ selectedPages: { current: [0, 1] } });

    runPageAction(host, { kind: 'delete' });
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    runPageAction(host, { kind: 'rotate', direction: 'left', pages: [2] });
    await vi.waitFor(() => expect(pageAction).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(isBusy()).toBe(false));

    expect(pageAction.mock.calls.map((call) => call[1])).toEqual([[0, 1], [2]]);
    expect(coreStore.get().notice).toBe(
      t('op.result.applied', { label: t('pages.rotate.done', { count: 1 }) }),
    );
  });

  it('says so when the action changed nothing, and keeps the handle', async () => {
    pageAction.mockResolvedValue(null);
    const host = actionHost();

    runPageAction(host, { kind: 'delete' });
    await vi.waitFor(() => expect(isBusy()).toBe(false));

    expect(coreStore.get().notice).toBe(t('op.result.noChangePages'));
    expect(host.setHandle).not.toHaveBeenCalled();
  });

  it('reports a tool error in the tool’s own words and releases the document', async () => {
    const error = new ToolError('aborted', { engine: 'model' });
    pageAction.mockRejectedValue(error);
    const host = actionHost();

    runPageAction(host, { kind: 'delete' });
    await vi.waitFor(() => expect(isBusy()).toBe(false));

    expect(coreStore.get().notice).toBe(`${t(error.messageKey)} ${t(error.hintKey)}`);
    expect(host.cancel.current).toBeNull();
    expect(host.setProgress).toHaveBeenLastCalledWith(null);
  });

  it('reports anything else as an internal error', async () => {
    pageAction.mockRejectedValue(new TypeError('sendWithPromise'));
    const host = actionHost();
    const internal = new ToolError('internal', { engine: 'model' });

    runPageAction(host, { kind: 'delete' });
    await vi.waitFor(() => expect(isBusy()).toBe(false));

    expect(coreStore.get().notice).toBe(`${t(internal.messageKey)} ${t(internal.hintKey)}`);
  });

  it('leaves the document to a newer operation that took it while this one ran', async () => {
    const running = deferred<PdfDocumentHandle | null>();
    pageAction.mockReturnValue(running.promise);
    const host = actionHost();

    runPageAction(host, { kind: 'delete' });
    const newer = new AbortController();
    host.cancel.current = newer;
    running.resolve(null);
    await vi.waitFor(() => expect(coreStore.get().notice).toBe(t('op.result.noChangePages')));

    expect(host.cancel.current).toBe(newer);
    expect(isBusy()).toBe(true);
    expect(host.setProgress).not.toHaveBeenCalledWith(null);
  });

  it('does nothing with no document, with no engine handle, or on a read-only document', () => {
    const closed = actionHost({ session: new SessionStore() });
    runPageAction(closed, { kind: 'delete' });

    dropHandle(tabId);
    const noHandle = actionHost();
    runPageAction(noHandle, { kind: 'delete' });
    adoptHandle(tabId, handle);

    const readOnly = actionHost({ canEdit: { current: false } });
    setBusy(true);
    runPageAction(readOnly, { kind: 'delete' });

    for (const host of [closed, noHandle, readOnly]) {
      expect(host.refuseBusy).not.toHaveBeenCalled();
      expect(host.setProgress).not.toHaveBeenCalled();
    }
    expect(pageAction).not.toHaveBeenCalled();
  });

  it('ignores a press while an operation already holds a controller', () => {
    const host = actionHost({ cancel: { current: new AbortController() } });

    runPageAction(host, { kind: 'delete' });

    expect(host.refuseBusy).not.toHaveBeenCalled();
    expect(pageAction).not.toHaveBeenCalled();
  });

  it('refuses out loud while the document is busy', () => {
    setBusy(true);
    const host = actionHost();

    runPageAction(host, { kind: 'delete' });

    expect(host.refuseBusy).toHaveBeenCalledOnce();
    expect(pageAction).not.toHaveBeenCalled();
    expect(host.cancel.current).toBeNull();
  });
});

describe('cancelOperation', () => {
  it('aborts what holds the document and says the request was heard', () => {
    const controller = new AbortController();

    cancelOperation({ t, cancel: { current: controller } });

    expect(controller.signal.aborted).toBe(true);
    expect(coreStore.get().notice).toBe(t('op.cancelRequested'));
  });

  it('still says it when nothing was running', () => {
    cancelOperation({ t, cancel: { current: null } });

    expect(coreStore.get().notice).toBe(t('op.cancelRequested'));
  });
});

describe('stepHistory', () => {
  const entry = { labelKey: 'pages.rotate.done', labelParams: { count: 1 } };

  it('undoes a mark-only step without replacing the live handle', async () => {
    historyStep.mockResolvedValue({ handle, entry } as never);
    const host = pressHost(session);

    await stepHistory(host, 'undo');

    const [context, direction, operation] = historyStep.mock.calls[0] ?? [];
    expect(context).toMatchObject({ store: session, handle });
    expect(direction).toBe('undo');
    expect(operation?.signal.aborted).toBe(false);
    expect(host.mocks.setHandle).not.toHaveBeenCalled();
    expect(coreStore.get().notice).toBe(t('op.undo.done', { label: t('pages.rotate.done', { count: 1 }) }));
    expect(isBusy()).toBe(false);
    expect(host.cancel.current).toBeNull();
  });

  it('mounts the bytes a byte step restored: new handle, carried engine values, clamped page', async () => {
    const restored = fakeHandle(2);
    const values = { fields: { city: 'Ankara' } };
    session.setOverlays(
      tabId,
      { annotations: [], measures: [], redactions: [], engineValues: values } as unknown as JsonValue,
      'ann.engineEdit',
    );
    historyStep.mockResolvedValue({ handle: restored, entry } as never);
    const host = pressHost(session);

    await stepHistory(host, 'redo');

    expect(host.engineValues.get(tabId)).toEqual(values);
    expect(host.mocks.setHandle).toHaveBeenCalledWith(tabId, restored);
    const update = host.mocks.setCurrentPage.mock.calls[0]?.[0] as (page: number) => number;
    expect([update(0), update(1), update(5)]).toEqual([0, 1, 1]);
    expect(coreStore.get().notice).toBe(t('op.redo.done', { label: t('pages.rotate.done', { count: 1 }) }));
  });

  it('forgets the carried values when the restored step has none', async () => {
    historyStep.mockResolvedValue({ handle: fakeHandle(), entry } as never);
    const host = pressHost(session);
    host.engineValues.set(tabId, { stale: true } as never);

    await stepHistory(host, 'undo');

    expect(host.engineValues.has(tabId)).toBe(false);
  });

  it('says there is nothing to step to', async () => {
    historyStep.mockResolvedValue(null);

    await stepHistory(pressHost(session), 'undo');

    expect(coreStore.get().notice).toBe(t('op.undo.unavailable'));
    expect(isBusy()).toBe(false);
  });

  it('keeps quiet about nothing to step to when the user already left the tab', async () => {
    const answer = deferred<null>();
    historyStep.mockReturnValue(answer.promise);
    const run = stepHistory(pressHost(session), 'undo');
    openTab('other.pdf');
    answer.resolve(null);
    await run;

    expect(coreStore.get().notice).toBeNull();
  });

  it('reports a failure in the tool’s words, and releases the document', async () => {
    const error = new ToolError('aborted', { engine: 'model' });
    historyStep.mockRejectedValue(error);
    const host = pressHost(session);

    await stepHistory(host, 'undo');

    expect(coreStore.get().notice).toBe(`${t(error.messageKey)} ${t(error.hintKey)}`);
    expect(isBusy()).toBe(false);
    expect(host.cancel.current).toBeNull();
  });

  it('says nothing for a failure on a tab the user left, or one the user cancelled', async () => {
    const left = deferred<never>();
    historyStep.mockReturnValueOnce(left.promise);
    const leaving = stepHistory(pressHost(session), 'undo');
    openTab('other.pdf');
    left.reject(new Error('gone'));
    await leaving;
    expect(coreStore.get().notice).toBeNull();

    session.setActive(tabId);
    const cancelled = deferred<never>();
    historyStep.mockReturnValueOnce(cancelled.promise);
    const host = pressHost(session);
    const cancelling = stepHistory(host, 'undo');
    host.cancel.current?.abort();
    cancelled.reject(new ToolError('aborted', { engine: 'model' }));
    await cancelling;
    expect(coreStore.get().notice).toBeNull();
  });

  it('leaves the document to a newer operation that took it while the step ran', async () => {
    const answer = deferred<null>();
    historyStep.mockReturnValue(answer.promise);
    const host = pressHost(session);
    const run = stepHistory(host, 'undo');
    const newer = new AbortController();
    host.cancel.current = newer;
    answer.resolve(null);
    await run;

    expect(host.cancel.current).toBe(newer);
    expect(isBusy()).toBe(true);
  });

  it('does nothing with no document, no handle, or an operation already holding a controller', async () => {
    await stepHistory(pressHost(new SessionStore()), 'undo');
    dropHandle(tabId);
    await stepHistory(pressHost(session), 'undo');
    adoptHandle(tabId, handle);
    const held = pressHost(session, { cancel: { current: new AbortController() } });
    await stepHistory(held, 'undo');

    expect(historyStep).not.toHaveBeenCalled();
    expect(held.mocks.refuseBusy).not.toHaveBeenCalled();
  });

  it('refuses out loud while the document is busy', async () => {
    setBusy(true);
    const host = pressHost(session);

    await stepHistory(host, 'undo');

    expect(host.mocks.refuseBusy).toHaveBeenCalledOnce();
    expect(historyStep).not.toHaveBeenCalled();
  });
});

describe('stepHistoryNow', () => {
  const entry = { labelKey: 'pages.rotate.done', labelParams: { count: 1 } };

  it('declines the key with no document, with nothing said', () => {
    const host = pressHost(new SessionStore());

    expect(stepHistoryNow(host, 'undo')).toBe(false);
    dropHandle(tabId);
    expect(stepHistoryNow(pressHost(session), 'undo')).toBe(false);
    adoptHandle(tabId, handle);

    expect(host.mocks.refuseBusy).not.toHaveBeenCalled();
    expect(coreStore.get().notice).toBeNull();
  });

  it('declines and refuses while an operation is running', () => {
    setBusy(true);
    const host = pressHost(session);

    expect(stepHistoryNow(host, 'undo')).toBe(false);
    expect(host.mocks.refuseBusy).toHaveBeenCalledOnce();
    expect(host.checkpointEngineValues).not.toHaveBeenCalled();
  });

  it('checkpoints the engine, then steps, in that order', async () => {
    const order: string[] = [];
    historyStep.mockImplementation(async () => {
      order.push('step');
      return { handle, entry } as never;
    });
    const host = pressHost(session, {
      checkpoint: async () => {
        order.push('checkpoint');
        return true;
      },
    });

    expect(stepHistoryNow(host, 'undo')).toBe(true);
    await settle();

    expect(order).toEqual(['checkpoint', 'step']);
    expect(host.sweepOrphanAnnotations).not.toHaveBeenCalled();
    expect(coreStore.get().notice).toBe(t('op.undo.done', { label: t('pages.rotate.done', { count: 1 }) }));
  });

  it('sweeps the orphans the engine’s pending gesture left, before it steps', async () => {
    historyStep.mockResolvedValue({ handle, entry } as never);
    const host = pressHost(session, { settle: true });

    stepHistoryNow(host, 'redo');
    await settle();

    expect(host.sweepOrphanAnnotations).toHaveBeenCalledOnce();
    expect(historyStep.mock.calls[0]?.[1]).toBe('redo');
  });

  it('waits for a sweep in flight, and accepts the press even though the sweep holds the document', async () => {
    const sweep = deferred();
    historyStep.mockResolvedValue({ handle, entry } as never);
    setBusy(true);
    const host = pressHost(session, { sweep: sweep.promise });

    expect(stepHistoryNow(host, 'undo')).toBe(true);
    await tick();
    expect(host.checkpointEngineValues).not.toHaveBeenCalled();

    setBusy(false);
    sweep.resolve();
    await settle();

    expect(host.checkpointEngineValues).toHaveBeenCalledOnce();
    expect(historyStep).toHaveBeenCalledOnce();
  });

  it('refuses when an operation took the document while the sweep was settling', async () => {
    const sweep = deferred();
    const host = pressHost(session, { sweep: sweep.promise });

    stepHistoryNow(host, 'undo');
    setBusy(true);
    sweep.resolve();
    await vi.waitFor(() => expect(host.mocks.refuseBusy).toHaveBeenCalledOnce());
    setBusy(false);
    await settle();

    expect(host.checkpointEngineValues).not.toHaveBeenCalled();
    expect(historyStep).not.toHaveBeenCalled();
  });

  it('refuses when a controller was registered while the sweep was settling', async () => {
    const sweep = deferred();
    const cancel = { current: null as AbortController | null };
    const host = pressHost(session, { sweep: sweep.promise, cancel });

    stepHistoryNow(host, 'undo');
    cancel.current = new AbortController();
    sweep.resolve();
    await settle();

    expect(host.mocks.refuseBusy).toHaveBeenCalledOnce();
    expect(historyStep).not.toHaveBeenCalled();
  });

  it('drops the step when the user left the tab, or the handle was replaced, after the press', async () => {
    const host = pressHost(session);
    stepHistoryNow(host, 'undo');
    openTab('other.pdf');
    await settle();
    expect(host.checkpointEngineValues).not.toHaveBeenCalled();

    session.setActive(tabId);
    const sweep = deferred();
    const replaced = pressHost(session, { sweep: sweep.promise });
    stepHistoryNow(replaced, 'undo');
    await tick();
    adoptHandle(tabId, fakeHandle());
    sweep.resolve();
    await settle();
    expect(replaced.checkpointEngineValues).not.toHaveBeenCalled();

    adoptHandle(tabId, handle);
    const gone = pressHost(session);
    stepHistoryNow(gone, 'undo');
    dropHandle(tabId);
    await settle();
    expect(gone.checkpointEngineValues).not.toHaveBeenCalled();
    expect(historyStep).not.toHaveBeenCalled();
  });

  it('drops the step when the document moved while the engine was checkpointed', async () => {
    const checkpoint = deferred<boolean>();
    const host = pressHost(session, { checkpoint: () => checkpoint.promise });

    stepHistoryNow(host, 'undo');
    await vi.waitFor(() => expect(host.checkpointEngineValues).toHaveBeenCalledOnce());
    adoptHandle(tabId, fakeHandle());
    checkpoint.resolve(true);
    await settle();

    expect(historyStep).not.toHaveBeenCalled();
  });

  it('queues a second press behind the first instead of losing it', async () => {
    const first = deferred<boolean>();
    const calls: string[] = [];
    historyStep.mockImplementation(async (_context, direction) => {
      calls.push(direction);
      return { handle, entry } as never;
    });
    const host = pressHost(session, { checkpoint: () => first.promise });

    expect(stepHistoryNow(host, 'undo')).toBe(true);
    // The first is still in flight and holds nothing yet; a busy gate would refuse a lone press.
    setBusy(true);
    expect(stepHistoryNow(host, 'redo')).toBe(true);
    setBusy(false);
    expect(host.mocks.refuseBusy).not.toHaveBeenCalled();
    first.resolve(true);
    await settle();

    expect(calls).toEqual(['undo', 'redo']);
  });

  it('reports a failure of the engine checkpoint in the tool’s words', async () => {
    const error = new ToolError('aborted', { engine: 'model' });
    const host = pressHost(session, { checkpoint: () => Promise.reject(error) });

    stepHistoryNow(host, 'undo');
    await settle();

    expect(coreStore.get().notice).toBe(`${t(error.messageKey)} ${t(error.hintKey)}`);
    expect(historyStep).not.toHaveBeenCalled();
  });

  it('says nothing about a failure on a tab the user already left', async () => {
    const checkpoint = deferred<boolean>();
    const host = pressHost(session, { checkpoint: () => checkpoint.promise });

    stepHistoryNow(host, 'undo');
    await vi.waitFor(() => expect(host.checkpointEngineValues).toHaveBeenCalledOnce());
    openTab('other.pdf');
    checkpoint.reject(new Error('gone'));
    await settle();

    expect(coreStore.get().notice).toBeNull();
  });
});

describe('usePageActions', () => {
  function bound() {
    const host = pressHost(session);
    const actions = actionHost();
    const input = {
      ...host,
      canEdit: actions.canEdit,
      selectedPages: actions.selectedPages,
      currentPage: { current: 1 },
      setProgress: actions.setProgress,
    } as PressHost & ActionHost;
    const rendered = renderHook((props: PressHost & ActionHost) => usePageActions(props), {
      initialProps: input,
    });
    return { host, actions, input, rendered };
  }

  it('runs a page action over the shell’s refs, and Cancel stops it', async () => {
    pageAction.mockResolvedValue(fakeHandle());
    const { host, actions, rendered } = bound();

    act(() => rendered.result.current.runPageAction({ kind: 'delete' }));
    await vi.waitFor(() => expect(isBusy()).toBe(false));

    expect(pageAction.mock.calls[0]?.[1]).toEqual([1]);
    expect(actions.setProgress).toHaveBeenCalledWith(null);

    host.cancel.current = new AbortController();
    const controller = host.cancel.current;
    act(() => rendered.result.current.cancelOperation());
    expect(controller.signal.aborted).toBe(true);
    expect(coreStore.get().notice).toBe(t('op.cancelRequested'));
  });

  it('steps history, now and queued, through the same host', async () => {
    const entry = { labelKey: 'pages.rotate.done', labelParams: { count: 1 } };
    historyStep.mockResolvedValue({ handle, entry } as never);
    const { host, rendered } = bound();

    await act(() => rendered.result.current.stepHistory('undo'));
    expect(historyStep.mock.calls[0]?.[1]).toBe('undo');

    let pressed = false;
    act(() => {
      pressed = rendered.result.current.stepHistoryNow('redo');
    });
    await settle();
    expect(pressed).toBe(true);
    expect(historyStep.mock.calls[1]?.[1]).toBe('redo');
    expect(host.checkpointEngineValues).toHaveBeenCalledOnce();
  });

  it('keeps each handler’s identity while the host is unchanged, and renews it with the host', () => {
    const { input, rendered } = bound();
    const first = rendered.result.current;

    rendered.rerender({ ...input });
    expect(rendered.result.current.runPageAction).toBe(first.runPageAction);
    expect(rendered.result.current.cancelOperation).toBe(first.cancelOperation);
    expect(rendered.result.current.stepHistory).toBe(first.stepHistory);
    expect(rendered.result.current.stepHistoryNow).toBe(first.stepHistoryNow);

    rendered.rerender({ ...input, t: createTranslator('en') });
    expect(rendered.result.current.runPageAction).not.toBe(first.runPageAction);
    expect(rendered.result.current.stepHistoryNow).not.toBe(first.stepHistoryNow);
  });
});
