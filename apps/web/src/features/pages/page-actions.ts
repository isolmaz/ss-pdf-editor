/**
 * What the user does to a document's pages and to its history: rotate, delete, move, insert,
 * undo, redo, and the Cancel on the progress overlay. The feature owns no state of its own —
 * the document is the session's, the busy gate and notice line are the core's — so these are
 * handlers over what the shell hands in. Every handler reads the tab, its engine handle and the
 * busy gate at the moment it runs, never from the render that created it.
 */

import type { OperationProgress } from 'pdf-core/ops/types';
import type { EngineValuesDraft, SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { useCallback } from 'react';
import {
  applyHistoryStep,
  applyPageAction,
  type PageAction,
  pageActionLabel,
  pendingOverlays,
} from '../../operations';
import {
  cancelOperation as abortOperation,
  beginOperation,
  endOperation,
  isBusy,
  operationRunning,
  refuseBusy,
  setBusy,
  showNotice,
} from '../core/core-store';
import { canEdit, documentContext } from '../core/document';
import { handleFor, swapHandle } from '../core/handles';
import {
  failureNotice,
  historyNotice,
  historyPress,
  operationGate,
  pageSelection,
  stillCurrent,
} from './history-plan';

/** What a page action needs from the shell. */
export interface ActionHost {
  readonly session: SessionStore;
  readonly t: Translator;
  /** The page panel's selection. */
  readonly selectedPages: { readonly current: readonly number[] };
  /** The page on screen. */
  readonly currentPage: { readonly current: number };
  readonly setProgress: (progress: OperationProgress | null) => void;
}

/** What a history step needs from the shell. */
export interface StepHost {
  readonly session: SessionStore;
  readonly t: Translator;
  /** Keep a tab's mark values until its viewer can take them; `undefined` forgets what was kept. */
  readonly holdEngineValues: (tabId: string, values: EngineValuesDraft | undefined) => void;
  readonly setCurrentPage: (update: (page: number) => number) => void;
}

/** What an undo/redo press needs from the shell, beyond the step itself. */
export interface PressHost extends StepHost {
  /** The orphan sweep in flight, if any. */
  readonly orphanSweepInFlight: () => Promise<void> | null;
  /** Commit the engine's pending gesture; `true` when it left something to sweep. */
  readonly settleNativeEditors: () => boolean;
  readonly sweepOrphanAnnotations: () => Promise<void>;
  /** Fold the engine's live form values into the journal. */
  readonly checkpointEngineValues: () => Promise<boolean>;
}

/** Page-structure actions: journaled, cancellable. */
export function runPageAction(host: ActionHost, action: PageAction): void {
  const { session, t } = host;
  const tab = session.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  const gate = operationGate({
    hasDocument: tab !== null && handle !== null,
    canEdit: canEdit(session),
    running: operationRunning(),
    busy: isBusy(),
  });
  if (gate === 'ignore' || tab === null || handle === null) return;
  if (gate === 'refuse') {
    refuseBusy(t);
    return;
  }
  setBusy(true);
  const named = 'pages' in action ? action.pages : undefined;
  const selection = pageSelection(named, host.selectedPages.current, host.currentPage.current);
  const controller = beginOperation();
  host.setProgress({ phase: 'pages', labelKey: 'op.step.pages', total: 1, done: 0 });
  void (async () => {
    try {
      const next = await applyPageAction(documentContext(session, t, tab, handle), selection, action, {
        signal: controller.signal,
        onProgress: host.setProgress,
      });
      if (next !== null) {
        swapHandle(t, tab.id, next);
        // The notice names what actually happened: a delete and a move are different journal
        // steps and the History panel shows both.
        const label = pageActionLabel(action, selection.length);
        showNotice(t('op.result.applied', { label: t(label.key, label.params) }));
      } else {
        // A page action that did nothing says so: an inert control and a refused action must
        // not look the same.
        showNotice(t('op.result.noChangePages'));
      }
    } catch (error) {
      showNotice(failureNotice(error, t));
    } finally {
      if (endOperation(controller)) {
        host.setProgress(null);
        setBusy(false);
      }
    }
  })();
}

/** The progress overlay's Cancel: stop what holds the document, and say so. */
export function requestCancel(host: Pick<ActionHost, 't'>): void {
  abortOperation();
  showNotice(host.t('op.cancelRequested'));
}

/**
 * Undo/redo. The model moves its own state and reports which bytes the viewer must show;
 * mounting them is the app's half of the contract. A step whose snapshot the session no longer
 * holds is reported, never guessed.
 */
export async function stepHistory(host: StepHost, direction: 'undo' | 'redo'): Promise<void> {
  const { session, t } = host;
  const tab = session.active;
  const handle = tab === null ? undefined : handleFor(tab.id);
  const gate = operationGate({
    hasDocument: tab !== null && handle !== undefined,
    canEdit: true,
    running: operationRunning(),
    busy: isBusy(),
  });
  if (gate === 'ignore' || tab === null || handle === undefined) return;
  if (gate === 'refuse') {
    refuseBusy(t);
    return;
  }
  const controller = beginOperation();
  setBusy(true);
  try {
    const result = await applyHistoryStep(documentContext(session, t, tab, handle), direction, {
      signal: controller.signal,
    });
    if (result === null) {
      if (session.active?.id === tab.id) showNotice(t('op.undo.unavailable'));
      return;
    }
    if (result.handle !== handle) {
      const values = pendingOverlays(session.active).engineValues;
      host.holdEngineValues(tab.id, values);
      swapHandle(t, tab.id, result.handle);
      host.setCurrentPage((page) => Math.min(page, result.handle.pageCount - 1));
    }
    showNotice(historyNotice(direction, result.entry, t));
  } catch (error) {
    if (session.active?.id !== tab.id || controller.signal.aborted) return;
    showNotice(failureNotice(error, t));
  } finally {
    if (endOperation(controller)) setBusy(false);
  }
}

/** The steps pressed and not yet finished: each runs when the one before it has. */
let historyTail: Promise<void> = Promise.resolve();
let historyPending = 0;

/**
 * Undo/redo with the engine's pending gesture folded in first, so there is **one** history
 * rather than two.
 *
 * pdf.js owns a highlight or an ink stroke until something commits it — and this app takes that
 * editor over the moment it commits. An undo that ran before the takeover would therefore undo
 * a different step than the one the user just made, or leave the mark they can see untouched
 * while the engine undid a record nothing else holds. Committing and taking over first makes
 * the two one step: the takeover journals the new mark, and the undo the user asked for is the
 * undo of exactly that.
 *
 * `false` declines the key: with no document, or while an operation is already running,
 * `Ctrl+Z` is not the shell's to answer and is left to whatever owns it.
 *
 * **Steps queue, they are never dropped.** A step spans several awaits (the sweep, the engine
 * checkpoint, the model's own move), so a second press lands while the first is still in
 * flight. Refusing it as "busy" — or letting it run beside the first, where `stepHistory`
 * returns silently on the held lock — loses the press: two quick undos would undo one step. A
 * press that arrives while history steps are pending is chained behind them and runs when the
 * one before has finished.
 */
export function stepHistoryNow(host: PressHost, direction: 'undo' | 'redo'): boolean {
  const { session, t } = host;
  const tab = session.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  const press = historyPress({
    hasDocument: tab !== null && handle !== null,
    queued: historyPending > 0,
    sweeping: host.orphanSweepInFlight() !== null,
    running: operationRunning(),
    busy: isBusy(),
  });
  if (press === 'decline' || tab === null) return false;
  if (press === 'refuse') {
    refuseBusy(t);
    return false;
  }
  if (host.settleNativeEditors()) void host.sweepOrphanAnnotations();
  const run = async (): Promise<void> => {
    // A step queued behind another starts from the version that one produced, so the handle is
    // read when this step begins, not when the key was pressed.
    const start = handleFor(tab.id);
    if (!stillCurrent(session.active?.id, tab.id, start, start)) return;
    // The sweep replaces the working version, so it must be over before the checkpoint reads
    // the engine and before the model moves.
    const sweep = host.orphanSweepInFlight();
    if (sweep !== null) await sweep;
    if (!stillCurrent(session.active?.id, tab.id, handleFor(tab.id), start)) return;
    if (isBusy() || operationRunning()) {
      refuseBusy(t);
      return;
    }
    // The engine's live storage is checkpointed first, for the same reason an erase
    // checkpoints it: a history step restores the mark state of *its own* moment, and a form
    // value typed a second ago is not in any step yet — undoing without this would reopen the
    // bytes from before the typing and drop a value the user can still see on the page.
    await host.checkpointEngineValues();
    if (stillCurrent(session.active?.id, tab.id, handleFor(tab.id), start))
      await stepHistory(host, direction);
  };
  historyPending += 1;
  historyTail = historyTail
    .then(run)
    .catch((error) => {
      if (session.active?.id !== tab.id) return;
      showNotice(failureNotice(error, t));
    })
    .finally(() => {
      historyPending -= 1;
    });
  return true;
}

/**
 * The handlers bound to the shell's host. Their identities follow the host's own, so the
 * command list and the shortcut layer that take them rebuild exactly when they used to.
 */
export function usePageActions(host: PressHost & ActionHost) {
  const {
    session,
    t,
    selectedPages,
    currentPage,
    holdEngineValues,
    orphanSweepInFlight,
    setProgress,
    setCurrentPage,
    settleNativeEditors,
    sweepOrphanAnnotations,
    checkpointEngineValues,
  } = host;
  const run = useCallback(
    (action: PageAction) => runPageAction({ session, t, selectedPages, currentPage, setProgress }, action),
    [session, t, selectedPages, currentPage, setProgress],
  );
  const step = useCallback(
    (direction: 'undo' | 'redo') => stepHistory({ session, t, holdEngineValues, setCurrentPage }, direction),
    [session, t, holdEngineValues, setCurrentPage],
  );
  const stepNow = useCallback(
    (direction: 'undo' | 'redo') =>
      stepHistoryNow(
        {
          session,
          t,
          holdEngineValues,
          orphanSweepInFlight,
          setCurrentPage,
          settleNativeEditors,
          sweepOrphanAnnotations,
          checkpointEngineValues,
        },
        direction,
      ),
    [
      session,
      t,
      holdEngineValues,
      orphanSweepInFlight,
      setCurrentPage,
      settleNativeEditors,
      sweepOrphanAnnotations,
      checkpointEngineValues,
    ],
  );
  return { runPageAction: run, stepHistory: step, stepHistoryNow: stepNow };
}
