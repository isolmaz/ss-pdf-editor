/**
 * Opening and running the operation dialogs: freeze the working bytes, load the capability's
 * spec, host it in the tools panel, and carry its result to the place the spec says
 * (download, a new tab, or the working document); plus the standalone operations that start a
 * document, the shortcut list and the protected-file unlock.
 *
 * The feature's own state is `dialogs-store.ts`. What the shell still holds — the translator
 * and the tab opener — arrives as deps; the active tab, its handle, the dialog the user
 * has open and the busy gate are read **at call time**.
 */

import type { PdfImageInfo } from 'pdf-core/ops/image-edit';
import { copyForEngine, type SessionStore, workingPageCount } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import type { FieldValue } from 'pdf-ui';
import {
  dialogById,
  hasDialog,
  isStandaloneDialog,
  type OperationRunContext,
  type OpRunResult,
} from 'pdf-ui/ui';
import { listPdfImages } from '../../lazy-ops';
import { appendWarning, failureNotices, noticeLine } from '../../notices';
import {
  applyProducedBytes,
  downloadFiles,
  materializeBase,
  pendingOverlays,
  redactionNeedles,
} from '../../operations';
import { heldByPendingRedactions } from '../../save-plan';
import {
  beginOperation,
  clearNotice,
  endOperation,
  isBusy,
  openRightPanel,
  operationRunning,
  refuseBusy,
  selectTool,
  setBusy,
  showNotice,
} from '../core/core-store';
import { documentContext } from '../core/document';
import { handleFor, swapHandle } from '../core/handles';
import { redactedWordsRead } from '../marks/redaction-store';
import { openScanDialog, setProgress } from '../results/results-store';
import {
  closeStartDialog,
  dialogsStore,
  dismissOperationDialog,
  operationDialogOpened,
  shortcutsClosed,
  shortcutsOpened,
  startDialogOpened,
} from './dialogs-store';

/** What the shell still holds that opening a dialog runs on. */
export interface DialogOpenerDeps {
  readonly session: SessionStore;
  readonly t: Translator;
  /** The image dialog's target list, or `null` when the dialog opened is not that one. */
  readonly setImages: (images: readonly PdfImageInfo[] | null) => void;
}

export function createDialogOpeners(deps: DialogOpenerDeps) {
  const { t } = deps;

  /**
   * Open an operation that starts a document (`isStandaloneDialog`). It needs no tab and
   * freezes no bytes, so it skips everything `openDialog` does for a document and only
   * loads its spec; `StartDialog` hosts it and `startResult` opens its result.
   */
  function openStart(id: string): void {
    if (isBusy()) {
      refuseBusy(t);
      return;
    }
    clearNotice();
    void dialogById(id).then((spec) => {
      if (spec !== undefined) startDialogOpened(spec);
    });
  }

  /**
   * Dialog opening materialises the base **first**: the dialog's `run` receives
   * frozen bytes, so a form value typed a second earlier cannot be lost between
   * opening the panel and pressing Apply.
   */
  function openDialog(id: string, presets?: Readonly<Record<string, FieldValue>>): void {
    // The camera scanner is a modal of its own, not an operation dialog.
    if (id === 'scan-camera') {
      clearNotice();
      openScanDialog();
      return;
    }
    if (!hasDialog(id)) return;
    if (isStandaloneDialog(id)) {
      openStart(id);
      return;
    }
    // The tab and its handle are read at call time, like every other entry
    // point: a control one render old must not freeze the previous handle.
    const tab = deps.session.active;
    const handle = tab === null ? null : (handleFor(tab.id) ?? null);
    if (tab === null || handle === null) return;
    clearNotice();
    if (isBusy() || operationRunning()) {
      refuseBusy(t);
      return;
    }
    const controller = beginOperation();
    setBusy(true);
    /**
     * The frozen bytes are only valid for the version they came from: a tab
     * switch, a close or an operation landing while this runs makes them an
     * input to a document that is no longer in front. The check runs after
     * every `await`, so the dialog either opens with a coherent input or does
     * not open at all.
     */
    const stale = () => {
      const current = deps.session.active;
      return controller.signal.aborted || current?.id !== tab.id || current.working.id !== tab.working.id;
    };
    void (async () => {
      try {
        const bytes = await materializeBase(documentContext(deps.session, t, tab, handle), {
          signal: controller.signal,
        });
        if (stale()) return;
        // The spec is a dynamic import: a capability's dialog code loads when the
        // capability is opened, which is what keeps fifteen dialogs out of the
        // first-paint bundle.
        const spec = await dialogById(id);
        if (spec === undefined || stale()) return;
        if (heldByPendingRedactions(spec) && pendingOverlays(tab).redactions.length > 0) {
          throw new ToolError('pending-redactions', { engine: 'model' });
        }
        // The image dialog's target list is document data, so it is read here, from
        // the same frozen bytes the run receives (`pdf-core/ops/image-edit.ts`).
        const listing =
          id === 'image-edit'
            ? await listPdfImages(bytes, { signal: controller.signal }).then((images) => images.images)
            : null;
        if (stale()) return;
        deps.setImages(listing);
        operationDialogOpened(
          {
            tabId: tab.id,
            workingId: tab.working.id,
            name: tab.name,
            pageCount: workingPageCount(tab),
            bytes,
            ...(presets === undefined ? {} : { presets }),
          },
          spec,
        );
        // **Every operation opens in the tools panel**, beside the document it will
        // change, whichever right-dock tab is showing: one capability in one place, with
        // one set of buttons. Modals are kept for the decisions that block (password,
        // close, signature warning, export choice, print).
        openRightPanel('tools');
      } catch (error) {
        if (controller.signal.aborted) return;
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        if (endOperation(controller)) setBusy(false);
      }
    })();
  }

  /**
   * The Help menu's shortcut list. It is deliberately not `openDialog`: that path
   * freezes the open document's bytes for a run, and help has no document, no bytes
   * and no run — it answers with no tab open, in either interface mode.
   *
   * A modal surface takes the pointer, so an armed tool is put away first, exactly as
   * the palette does it: a measure overlay left armed under the dialog would swallow
   * its clicks.
   */
  function showShortcuts(): void {
    /**
     * `document.activeElement` is `<body>` whenever nothing holds the focus, and `<body>`
     * is an `HTMLElement` that stays connected for the life of the page: storing it would
     * make the close path below "focus `<body>`" — the one outcome it exists to prevent.
     * Only an element that was really focused counts as the opener.
     */
    const opener = document.activeElement;
    selectTool('select');
    shortcutsOpened(opener instanceof HTMLElement && opener !== document.body ? opener : null);
  }

  function closeShortcuts(): void {
    shortcutsClosed();
    /**
     * Focus goes back where it came from, or to the shell's own first control: the
     * opener is often a menu trigger that is still mounted, but the palette's search
     * field is not, and a dialog that leaves focus on `<body>` costs the keyboard user
     * their place. The same rule the close-tab prompt follows.
     */
    requestAnimationFrame(() => {
      const target = dialogsStore.get().shortcutsTrigger;
      if (target?.isConnected) target.focus();
      else document.querySelector<HTMLElement>('[role="menubar"] [role="menuitem"], main button')?.focus();
    });
  }

  return { openStart, openDialog, showShortcuts, closeShortcuts };
}

/** What the shell still holds that carrying a dialog's result runs on. */
export interface DialogRunDeps {
  readonly session: SessionStore;
  readonly t: Translator;
  /** Open produced bytes as a new tab; resolves with the stored-copy warning, if any. */
  readonly openProducedTab: (name: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<string | null>;
  /** What the dialog's run received: the redaction marks it was frozen with. */
  readonly dialogContext: OperationRunContext | null;
  /** The open password of each protected tab. */
  readonly lockedTabs: ReadonlyMap<string, string>;
}

export function createDialogRuns(deps: DialogRunDeps) {
  const { t } = deps;

  /** The result of the operation open in the tools panel. */
  async function dialogResult(result: OpRunResult): Promise<void> {
    const { dialogInput: input, dialogSpec: spec } = dialogsStore.get();
    if (input === null || spec === null) return;
    /**
     * The result belongs to the tab and version the dialog froze, not to
     * whatever is active when the click lands. Read both fresh from the store:
     * a tab switch or a landed operation between opening and applying must
     * refuse the result rather than write one document's bytes onto another.
     */
    const tab = deps.session.getSnapshot().tabs.find((item) => item.id === input.tabId) ?? null;
    const handle = tab === null ? null : (handleFor(tab.id) ?? null);
    if (
      tab === null ||
      handle === null ||
      tab.working.id !== input.workingId ||
      deps.session.active?.id !== input.tabId
    ) {
      dismissOperationDialog();
      return;
    }
    if (isBusy() || operationRunning()) {
      refuseBusy(t);
      return;
    }
    const controller = beginOperation();
    setBusy(true);
    const first = result.files[0];
    /**
     * The dialog is done the moment its result action has been taken, and it closes
     * here rather than waiting for a "Kapat" press. Two reasons: the outcome is
     * already reported where the product says it belongs — the notice line, the
     * History dock and the save report — and a dialog left mounted past its last
     * action is what left an invisible Base UI backdrop over the shell, swallowing
     * the next click anywhere in the app.
     */
    try {
      const kind = result.deliver ?? spec.resultKind;
      if (kind === 'download') {
        downloadFiles(result.files);
        showNotice(
          result.noticeKey === undefined
            ? t('op.result.downloaded', { name: first?.name ?? '' })
            : t(result.noticeKey, result.noticeParams ?? {}),
        );
        dismissOperationDialog();
        return;
      }
      if (first === undefined) return;
      if (kind === 'new-tab') {
        const warning = await deps.openProducedTab(first.name, first.bytes, controller.signal);
        showNotice(
          appendWarning(
            result.noticeKey === undefined
              ? t('op.result.opened', { name: first.name })
              : t(result.noticeKey, result.noticeParams ?? {}),
            warning,
          ),
        );
        dismissOperationDialog();
        return;
      }
      const next = await applyProducedBytes(
        documentContext(deps.session, t, tab, handle),
        first.bytes,
        result.report.pageCount,
        { key: spec.titleKey },
        result.report.engine,
        result.report.steps,
        { signal: controller.signal },
        spec.id === 'redact' ? { annotations: [], measures: [], redactions: [] } : undefined,
      );
      swapHandle(t, tab.id, next);
      if (spec.id === 'redact') {
        /**
         * The words this redaction removed, read from the bytes it ran on — the marks
         * the run received are frozen in `dialogContext`, and `input.bytes` is the
         * version they were measured against. Taken *before* the notice
         * because the audit that needs them runs later, on bytes where those words are
         * already gone.
         */
        const marks = deps.dialogContext?.redactions ?? [];
        void redactionNeedles(input.bytes, marks, { signal: new AbortController().signal })
          .then((terms) => redactedWordsRead(tab.id, terms))
          .catch(() => undefined);
      }
      showNotice(
        result.noticeKey === undefined
          ? t('op.result.applied', { label: t(spec.titleKey) })
          : t(result.noticeKey, result.noticeParams ?? {}),
      );
      dismissOperationDialog();
      return;
    } catch (error) {
      if (controller.signal.aborted) return;
      const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
      showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
    } finally {
      if (endOperation(controller)) setBusy(false);
    }
  }

  /**
   * The result of a standalone operation: it has no document to replace, so it either
   * downloads or opens as a new tab, and the modal closes once that has happened.
   */
  async function startResult(result: OpRunResult): Promise<void> {
    const spec = dialogsStore.get().startSpec;
    if (spec === null) return;
    const first = result.files[0];
    if ((result.deliver ?? spec.resultKind) === 'download') {
      downloadFiles(result.files);
      showNotice(t('op.result.downloaded', { name: first?.name ?? '' }));
      closeStartDialog();
      return;
    }
    if (first === undefined) return;
    if (isBusy() || operationRunning()) {
      refuseBusy(t);
      return;
    }
    const controller = beginOperation();
    setBusy(true);
    try {
      const warning = await deps.openProducedTab(first.name, first.bytes, controller.signal);
      closeStartDialog();
      showNotice(appendWarning(t('op.result.opened', { name: first.name }), warning));
    } catch (error) {
      if (controller.signal.aborted) return;
      showNotice(noticeLine(failureNotices(error, 'error.internal.message'), t));
    } finally {
      if (endOperation(controller)) setBusy(false);
    }
  }

  /** Build an unlocked copy of a protected tab, in a new tab; the original stays protected. */
  async function unlockActiveCopy(): Promise<void> {
    const tab = deps.session.active;
    const password = tab === null ? undefined : deps.lockedTabs.get(tab.id);
    if (tab === null || password === undefined || isBusy()) return;
    setBusy(true);
    // The progress overlay's Cancel aborts the running operation: registering the run is what
    // makes that button stop this work rather than nothing.
    const controller = beginOperation();
    try {
      // Loaded on demand: unlocking is reached by a gesture, so it stays off the first paint.
      const { unlockDocument } = await import('pdf-core/ops/security');
      const outcome = await unlockDocument(copyForEngine(tab.source.master), password, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      const warning = await deps.openProducedTab(
        tab.name.replace(/\.pdf$/i, `-${t('security.unlock.suffix')}.pdf`),
        outcome.bytes,
      );
      // What unlocking cost the file (a signature that no longer validates) must reach the
      // user: the report's `lost` notes are the only place that is said.
      const lost = outcome.report.notes
        .filter((entry) => entry.kind === 'lost')
        .map((entry) => t(entry.key, entry.params ?? {}))
        .join(' ');
      showNotice(appendWarning(appendWarning(t('locked.done'), lost === '' ? null : lost), warning));
    } catch (error) {
      const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'mupdf' });
      showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
    } finally {
      endOperation(controller);
      setProgress(null);
      setBusy(false);
    }
  }

  return { dialogResult, startResult, unlockActiveCopy };
}
