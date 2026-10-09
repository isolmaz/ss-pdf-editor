import type { OperationOutcome } from 'pdf-core';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { PdfImageInfo } from 'pdf-core/ops/image-edit';
import type { LinkTargetRect } from 'pdf-core/ops/link-edit';
import type { SessionStore, SessionTab } from 'pdf-model';
import { createTranslator, detectDeviceTier } from 'pdf-shared';
import type { StampPlacement } from 'pdf-ui/tools';
import { type OperationRunContext, useLocale } from 'pdf-ui/ui';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { InterfaceMode } from './commands';
import { UpdateBanner } from './components/UpdateBanner';
import { useAnnotationMarks } from './features/annotations/annotation-marks';
import {
  holdEngineValues,
  orphanSweepInFlight,
  useAnnotationStyle,
} from './features/annotations/annotations-store';
import { useAnnotationActions, useSettleNativeEditors } from './features/annotations/use-annotation-actions';
import { createAttachmentActions } from './features/attachments/attachments';
import { useCommentReview } from './features/comments/review';
import { setInterfaceMode, showNotice, useCore } from './features/core/core-store';
import { handleReleased, replaceHandle } from './features/core/handles';
import { useCompactViewport } from './features/core/viewport';
import { ShortcutsDialogHost } from './features/dialogs/DialogSurfaces';
import { createDialogOpeners, createDialogRuns } from './features/dialogs/dialog-actions';
import { dismissOperationDialog, useDialogs } from './features/dialogs/dialogs-store';
import { useStaleDialogDismissal } from './features/dialogs/use-dialog-dismissal';
import { ContextMenuHost, ExportDialogHost } from './features/export/ExportSurfaces';
import { createCurrentBytes, createExportChoice } from './features/export/export-actions';
import { SignatureWarningPrompt } from './features/facts/SignatureWarningPrompt';
import { XfaFormDialogHost } from './features/forms/FormsSurface';
import {
  applyFormDetect as applyFormDetectFor,
  fillField as fillFieldFor,
  openXfaForm as openXfaFormFor,
  saveXfaForm as saveXfaFormFor,
  startFormDetect as startFormDetectFor,
} from './features/forms/form-actions';
import { currentMarkTargets } from './features/marks/marks-store';
import {
  refuseUnappliedRedactions as refuseUnappliedRedactionsFor,
  useRedactionMarks,
} from './features/marks/redaction';
import { useMarkActions, useWriterActions } from './features/marks/use-mark-actions';
import { OpenFileInput, PasswordPromptHost } from './features/open/OpenSurfaces';
import { openAndFingerprint } from './features/open/open-actions';
import { selectedPagesNow, useOpen } from './features/open/open-store';
import { useOpenActions } from './features/open/use-open-actions';
import { usePageActions } from './features/pages/page-actions';
import { persistDraft, saveDraft } from './features/persistence/draft-persist';
import { forgetDraft } from './features/persistence/draft-vault';
import { useDraftRecovery } from './features/persistence/use-draft-recovery';
import { usePersistenceActions } from './features/persistence/use-persistence-actions';
import { useDraftAutosave, useVaultChannel } from './features/persistence/use-vault-sync';
import { openSnapshot } from './features/reading/reading-store';
import { createResultsActions } from './features/results/results-actions';
import { openPrintDialog, setProgress } from './features/results/results-store';
import { discardDocument } from './features/save/close-actions';
import { prepareOutput as prepareDocumentOutput } from './features/save/prepare-output';
import { CloseDocumentHost } from './features/save/SaveSurfaces';
import { saveDocument } from './features/save/save-actions';
import { setCurrentPage, useSave, viewerRef } from './features/save/save-store';
import { useSaveActions } from './features/save/use-save-actions';
import { clearTextEdit, useTextTool } from './features/selection/text-tool-store';
import { useSelectionActions } from './features/selection/use-selection';
import { ShellBody } from './features/shell/ShellBody';
import { ShellHeader } from './features/shell/ShellHeader';
import { PaletteHost, SettingsHost } from './features/shell/ShellOverlays';
import { ShellStatusBar } from './features/shell/ShellStatusBar';
import type { ShellActions } from './features/shell/shell-actions';
import { ToolStrip } from './features/shell/ToolStrip';
import { useDocumentEffects } from './features/shell/use-document-effects';
import { useEditState } from './features/shell/use-edit-state';
import { useShellBindings } from './features/shell/use-shell-bindings';
import { useShellCommands } from './features/shell/use-shell-commands';
import { ImagePickerInput, SignatureDialogHost } from './features/stamps/StampSurface';
import {
  openSignature as openSignatureFor,
  pickImage as pickImageFor,
  placeStamp as stampPlace,
  resizeStamp as stampResize,
} from './features/stamps/stamp-actions';
import type { DocumentContext } from './operations';
import type { SaveStepDescription } from './save-plan';

/**
 * The editor shell: the composition root.
 *
 * A panel or dialog never produces "its own output PDF". It returns produced bytes, and the
 * handlers built here decide what they mean — a new working version (journaled, undoable), a new
 * tab, or a download. The layout (`features/shell/`) subscribes to the stores itself; what
 * remains here is the handlers every feature shares: the translator, the document context, the
 * running operation's controller and the engine handle swap.
 */

export interface AppProps {
  readonly store: SessionStore;
}

export function App({ store }: AppProps) {
  const { locale } = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const tier = useMemo(() => detectDeviceTier(), []);
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useCompactViewport();
  /**
   * The translator, reachable from effect bodies **without** becoming one of their
   * dependencies: a recovery that took `t` in its dep list would run again when the interface
   * language changes and restore every draft a second time, over tabs that are already open.
   */
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  /** The controller of the operation holding the document; the progress overlay's Cancel aborts it. */
  const cancelRef = useRef<AbortController | null>(null);
  const abortOperation = useCallback(() => cancelRef.current?.abort(), []);
  /**
   * A gesture the synchronous gate refuses says so. The gate itself stays synchronous — this
   * only speaks when it closes, because an inert control and a refused action must not look the
   * same.
   */
  const refuseBusy = useCallback(() => showNotice(t('op.busy')), [t]);
  const { activeTab, activeHandle, canEdit } = useEditState(store, tier);
  /** `canEdit` for callbacks that must not act on the render they were created in. */
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const currentPage = useSave((state) => state.currentPage);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const canvasTool = useCore((state) => state.canvasTool);
  const markMode = canvasTool === 'select' ? 'select' : null;
  const lockedTabs = useOpen((state) => state.lockedTabs);
  const selectedPages = useOpen((state) => state.selectedPages);
  const dialogInput = useDialogs((state) => state.dialogInput);
  /** The block the text tool picked, which travels to the dialog in the run context (`features/selection/`). */
  const textEdit = useTextTool((state) => state.edit);
  /**
   * The rectangle the link tool dragged and the image objects read when the image dialog opened:
   * the dialog's `run` must operate on what the user pointed at, not on one re-measured later.
   */
  const [linkRegion, setLinkRegion] = useState<LinkTargetRect | null>(null);
  const [images, setImages] = useState<readonly PdfImageInfo[] | null>(null);
  const { redactionMarks, setRedactionMarks } = useRedactionMarks(store);
  const { setAnnotations } = useAnnotationMarks(store);
  const { author: annotationAuthor } = useAnnotationStyle();

  /** Switch the interface mode; a dialog the simple mode hides must not stay open behind the filter. */
  const changeMode = useCallback(
    (next: InterfaceMode) => {
      setInterfaceMode(next);
      if (next === 'simple') {
        abortOperation();
        dismissOperationDialog();
      }
    },
    [abortOperation],
  );

  /** Print and Snapshot are refused while a redaction mark is unapplied (`features/marks/redaction.ts`). */
  const refuseUnappliedRedactions = useCallback(
    (): boolean => refuseUnappliedRedactionsFor(store, t),
    [store, t],
  );
  const openPrint = useCallback(() => {
    if (!refuseUnappliedRedactions()) openPrintDialog();
  }, [refuseUnappliedRedactions]);
  const openSnapshotMenu = useCallback(() => {
    if (!refuseUnappliedRedactions()) openSnapshot();
  }, [refuseUnappliedRedactions]);

  /**
   * The persistence callbacks the audit pins (`tools/audit/regressions.cjs`): the work is in
   * `features/persistence`, and these bind it to the shell's session and device tier.
   */
  const forgetTabDraft = useCallback((tabId: string) => forgetDraft(store, tabId), [store]);
  const persistTabDraft = useCallback((tabId: string) => persistDraft(store, tabId, tier), [store, tier]);
  const opfsSave = useCallback(() => saveDraft(store, persistTabDraft, t), [store, persistTabDraft, t]);
  const { toggleSensitiveSession, purgeActiveDocument, sweepVault, checkOffline, prepareOfflinePackages } =
    usePersistenceActions(store, t);

  /** A handle that would not shut down says so on the status line, in the current language. */
  const reportReleaseFailure = useCallback(() => showNotice(tRef.current('notice.engineReleaseFailed')), []);
  const handleDocumentReleased = useCallback(
    (handle: PdfDocumentHandle) => handleReleased(handle, reportReleaseFailure),
    [reportReleaseFailure],
  );
  const setHandle = useCallback(
    (tabId: string, handle: PdfDocumentHandle) => replaceHandle(tabId, handle, reportReleaseFailure),
    [reportReleaseFailure],
  );
  const contextFor = useCallback(
    (tab: SessionTab, handle: PdfDocumentHandle): DocumentContext => ({ store, t, tab, handle }),
    [store, t],
  );

  useDocumentEffects({ session: store, t, tab: activeTab, handle: activeHandle, contextFor });
  useDraftRecovery({ store, translator: tRef, openAndFingerprint });
  useDraftAutosave({ session, store, persist: persistTabDraft, translator: tRef });
  useVaultChannel(store, session);

  /** What the forms handlers need from the shell. */
  const formsHost = useMemo(
    () => ({
      store,
      t,
      contextFor,
      refuseBusy,
      setHandle,
      operationRunning: () => cancelRef.current !== null,
    }),
    [contextFor, refuseBusy, setHandle, store, t],
  );
  const openXfaForm = useCallback(() => void openXfaFormFor(formsHost), [formsHost]);
  const saveXfaForm = useCallback(
    (outcome: OperationOutcome & { readonly changed: number }) => saveXfaFormFor(outcome, formsHost),
    [formsHost],
  );
  const fillField = useCallback(
    (name: string, value: string | boolean) => fillFieldFor(name, value, formsHost),
    [formsHost],
  );
  const startFormDetect = useCallback(() => startFormDetectFor(formsHost), [formsHost]);

  const { openFile, openProducedTab, openFromSurface, openFilesFromSurface, openViaPicker, selectRecent } =
    useOpenActions({ session: store, t, tier, cancelRef, refuseBusy, setCurrentPage, setRedactionMarks });

  /** The annotation handlers: the review as a file, the engine's editor takeover, native editors and the orphan sweep. */
  const annotationActions = useAnnotationActions({
    session: store,
    t,
    viewer: viewerRef,
    cancel: cancelRef,
    contextFor,
    setHandle,
  });
  const { takeEngineAnnotations, settleNativeEditors, sweepOrphanAnnotations } = annotationActions;
  useSettleNativeEditors(markMode, annotationActions);

  const prepareOutput = useCallback(
    (tabId: string, controller: AbortController, executedSteps: SaveStepDescription[] = []) =>
      prepareDocumentOutput({ session: store, t, contextFor }, tabId, controller, executedSteps),
    [contextFor, store, t],
  );
  const saveActive = useCallback(
    (tabId = store.active?.id): Promise<boolean> =>
      saveDocument({ session: store, t, cancelRef, refuseBusy, prepareOutput }, tabId),
    [prepareOutput, refuseBusy, store, t],
  );
  const discardTab = useCallback(
    (id: string) => discardDocument({ session: store, cancelRef, translator: tRef, forgetTabDraft }, id),
    [store, forgetTabDraft],
  );
  /** Closing, exporting and the viewer's reports (`features/save/`). */
  const { closeTab, exportActive, checkpointEngineValues, markActiveDirty, handleViewerReady } =
    useSaveActions({
      session: store,
      t,
      cancelRef,
      refuseBusy,
      prepareOutput,
      discardTab,
      takeEngineAnnotations,
    });

  const { openStart, openDialog, showShortcuts, closeShortcuts } = useMemo(
    () => createDialogOpeners({ session: store, t, contextFor, cancelRef, refuseBusy, setImages }),
    [contextFor, refuseBusy, store, t],
  );
  const exportChoice = useMemo(
    () => createExportChoice({ exportActive, openDialog }),
    [exportActive, openDialog],
  );

  /**
   * The frozen input a dialog runs against. `signal` and `onProgress` are absent by
   * construction: the run hook creates both, so a dialog can only ever cancel work it owns.
   */
  const dialogContext: OperationRunContext | null = useMemo(() => {
    if (dialogInput === null) return null;
    return {
      bytes: dialogInput.bytes,
      ...(dialogInput.presets === undefined ? {} : { presets: dialogInput.presets }),
      pageCount: dialogInput.pageCount,
      name: dialogInput.name,
      currentPage,
      selectedPages,
      t,
      ...(redactionMarks.length === 0 ? {} : { redactions: redactionMarks.map((item) => item.mark) }),
      ...(textEdit === null ? {} : { textEdit }),
      ...(linkRegion === null ? {} : { link: linkRegion }),
      ...(images === null ? {} : { images }),
    };
  }, [dialogInput, currentPage, images, linkRegion, selectedPages, redactionMarks, t, textEdit]);
  const dropFrozenSelections = useCallback(() => {
    clearTextEdit();
    setImages(null);
  }, []);
  useStaleDialogDismissal(session, dropFrozenSelections);

  /**
   * What a produced file *means* is decided here and nowhere else: `replace` ends in a journaled
   * working-version change (undoable), `new-tab` opens beside the current document, `download`
   * writes files and touches nothing.
   */
  const currentBytes = useMemo(() => createCurrentBytes({ session: store, contextFor }), [contextFor, store]);
  const resultsActions = useMemo(
    () =>
      createResultsActions({
        session: store,
        t,
        contextFor,
        setHandle,
        cancelRef,
        openProducedTab,
        openDialog,
        refuseBusy,
        refuseUnappliedRedactions,
      }),
    [store, t, contextFor, setHandle, openProducedTab, openDialog, refuseBusy, refuseUnappliedRedactions],
  );
  const { dialogResult, startResult, unlockActiveCopy } = useMemo(
    () =>
      createDialogRuns({
        session: store,
        t,
        contextFor,
        setHandle,
        cancelRef,
        openProducedTab,
        refuseBusy,
        dialogContext,
        lockedTabs,
      }),
    [store, t, contextFor, setHandle, openProducedTab, refuseBusy, dialogContext, lockedTabs],
  );

  /** The writer pipeline and the layers panel's write (`features/marks/writer.ts`). */
  const { applyWriterOutcome, writeLayers } = useWriterActions({
    session: store,
    t,
    contextFor,
    setHandle,
    refuseBusy,
  });
  const attachmentActions = useMemo(
    () => createAttachmentActions({ session: store, t, contextFor, setHandle, applyWriterOutcome }),
    [store, t, contextFor, setHandle, applyWriterOutcome],
  );
  /** Removing, moving and writing marks (`features/marks/`). */
  const { removeTargets, transformTargets, writeFileAnnotation } = useMarkActions({
    session: store,
    t,
    contextFor,
    setHandle,
    refuseBusy,
    cancel: cancelRef,
    canEdit: canEditRef,
    checkpointEngineValues,
  });
  const commentReview = useCommentReview({
    session: store,
    t,
    author: annotationAuthor,
    setAnnotations,
    writeFileAnnotation,
    removeTargets,
  });
  const applyFormDetect = useCallback(
    () => applyFormDetectFor({ store, t, writeFileAnnotation }),
    [store, t, writeFileAnnotation],
  );

  /** The click that places the armed picture: one `/Stamp`, one journal step, then selected. */
  const placeStamp = useCallback(
    (placement: StampPlacement) =>
      stampPlace(placement, { writeFileAnnotation, author: annotationAuthor, t }),
    [annotationAuthor, t, writeFileAnnotation],
  );
  /** A corner handle's drop: the stamp's `/Rect` becomes the new box, nothing else changes. */
  const resizeStamp = useCallback(
    (key: string, rect: readonly [number, number, number, number]) =>
      stampResize(key, rect, { targets: currentMarkTargets(), writeFileAnnotation, t }),
    [t, writeFileAnnotation],
  );
  const openSignature = useCallback(
    () => openSignatureFor({ hasDocument: store.active !== null, canEdit: canEditRef.current, refuseBusy }),
    [refuseBusy, store],
  );
  const pickImage = useCallback(
    () => pickImageFor({ hasDocument: store.active !== null, canEdit: canEditRef.current, refuseBusy }),
    [refuseBusy, store],
  );

  /** Delete, Select all and opening a note (`features/selection/`). */
  const { deleteMarkSelection, selectAllMarks } = useSelectionActions({
    session: store,
    cancel: cancelRef,
    refuseBusy,
    settleNativeEditors,
    sweepOrphanAnnotations,
    removeTargets,
  });

  /** Page actions and undo/redo (`features/pages/page-actions.ts`). */
  const { runPageAction, cancelOperation, stepHistoryNow } = usePageActions({
    session: store,
    t,
    cancel: cancelRef,
    canEdit: canEditRef,
    selectedPages: selectedPagesNow,
    currentPage: currentPageRef,
    holdEngineValues,
    orphanSweepInFlight,
    contextFor,
    setHandle,
    refuseBusy,
    setProgress,
    setCurrentPage,
    settleNativeEditors,
    sweepOrphanAnnotations,
    checkpointEngineValues,
  });

  const actions: ShellActions = {
    t,
    openViaPicker,
    saveActive,
    exportActive,
    closeTab,
    openDialog,
    showShortcuts,
    runPageAction,
    stepHistoryNow,
    openPrint,
    openSnapshotMenu,
    openXfaForm,
    startFormDetect,
    openSignature,
    pickImage,
    deleteMarkSelection,
    selectAllMarks,
    toggleSensitiveSession,
    opfsSave,
    purgeActiveDocument,
    sweepVault,
    checkOffline,
    prepareOfflinePackages,
    changeMode,
  };
  const { commands, runHomeCommand } = useShellCommands(store, tier, actions);
  useShellBindings({ session: store, actions, canEdit: () => canEditRef.current });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the shell is a file drop target; the keyboard-equivalent path is the Open button (Ctrl+O).
    <div
      className="flex h-dvh flex-col bg-kumo-canvas text-kumo-default"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        // Chromium hands a dropped file's handle too, which is what lets it be saved in place
        // and reopened from the recent list. It must be asked for inside the event.
        const pending = Array.from(event.dataTransfer.items)
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFileSystemHandle?.().catch(() => null) ?? Promise.resolve(null));
        const files = Array.from(event.dataTransfer.files);
        void Promise.all(pending).then((found) =>
          openFilesFromSurface(
            files,
            found.map((item) =>
              typeof FileSystemFileHandle !== 'undefined' && item instanceof FileSystemFileHandle
                ? item
                : null,
            ),
          ),
        );
      }}
    >
      <UpdateBanner t={t} />
      <ShellHeader
        session={store}
        tier={tier}
        t={t}
        commands={commands}
        actions={{ openViaPicker, saveActive, exportActive, closeTab, openDialog, abortOperation }}
      />
      <ToolStrip
        session={store}
        tier={tier}
        t={t}
        actions={{ openDialog, openXfaForm, unlockActiveCopy, removeTargets, transformTargets }}
      />
      <ShellBody
        session={store}
        tier={tier}
        t={t}
        commands={commands}
        runHomeCommand={runHomeCommand}
        dialogContext={dialogContext}
        home={{ openFilesFromSurface, openViaPicker, openStart, selectRecent }}
        dock={{ runPageAction, openDialog, writeLayers, attachments: attachmentActions }}
        viewer={{
          openDialog,
          transformTargets,
          onReady: handleViewerReady,
          onDocumentReleased: handleDocumentReleased,
          onModifiedChange: markActiveDirty,
          onPlaceStamp: placeStamp,
          onResizeStamp: resizeStamp,
          onLinkRegion: setLinkRegion,
        }}
        right={{
          openDialog,
          runPageAction,
          stepHistoryNow,
          startFormDetect,
          abortOperation,
          refuseBusy,
          dialogResult,
          removeTargets,
          annotationData: annotationActions,
          commentReview,
          attachments: attachmentActions,
          results: resultsActions,
          currentBytes,
          applyFormDetect,
          fillField,
        }}
        results={resultsActions}
        startResult={startResult}
        cancelOperation={cancelOperation}
      />
      <ShellStatusBar session={store} tier={tier} t={t} actions={{ runPageAction }} />
      <SettingsHost session={store} tier={tier} t={t} actions={actions} />
      <PasswordPromptHost
        t={t}
        onSubmit={(file, handle, password) => void openFile(file, handle, password)}
      />
      <ShortcutsDialogHost t={t} onClose={closeShortcuts} />
      <PaletteHost t={t} commands={commands} changeMode={changeMode} />
      <CloseDocumentHost
        t={t}
        session={store}
        cancelRef={cancelRef}
        discardTab={discardTab}
        saveActive={saveActive}
        exportActive={exportActive}
      />
      <XfaFormDialogHost t={t} onSave={saveXfaForm} />
      <SignatureDialogHost t={t} canRemember={activeTab?.sensitive !== true} />
      <ImagePickerInput t={t} />
      <SignatureWarningPrompt t={t} />
      <ContextMenuHost
        t={t}
        canEdit={canEdit}
        viewer={viewerRef}
        setRedactionMarks={setRedactionMarks}
        onPageAction={runPageAction}
      />
      <ExportDialogHost t={t} tab={activeTab} onExport={exportChoice} />
      <OpenFileInput onFile={(file) => void openFromSurface(file)} />
    </div>
  );
}
