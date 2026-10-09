import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
// The annotation and form ops are imported by **module**, not through the
// package barrel: a barrel re-export keeps every operation module in the graph the
// entry chunk is built from (measured: 160 kB of op code in the first paint),
// and the engine chunk it pulls in is what the ≤250 KiB budget is there to keep
// out.

import { type SessionStore, type SessionTab, workingPageCount } from 'pdf-model';
import { checkDocumentLimits, createTranslator, detectDeviceTier } from 'pdf-shared';
import { lazy, Suspense } from 'react';

const SettingsDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.SettingsDialog };
});

import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import type { OperationOutcome } from 'pdf-core';
import type { PdfImageInfo } from 'pdf-core/ops/image-edit';
import type { LinkTargetRect } from 'pdf-core/ops/link-edit';
import {
  type CanvasToolId,
  MarkInteractionLayer,
  markTargetKey,
  type StampPlacement,
  ToolProperties,
  usePresentation,
} from 'pdf-ui/tools';
import type { AnnotationTool, OperationRunContext } from 'pdf-ui/ui';
import {
  AnnotationLayer,
  Button,
  Dock,
  DocumentPanel,
  HistoryPanel,
  MenuBar,
  StatusBar,
  ToolsRailPanel,
  useLocale,
  useTheme,
} from 'pdf-ui/ui';
import { PdfViewerPane } from 'pdf-ui/viewer';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  buildCommands,
  type InterfaceMode,
  SIMPLE_MODE_DOCK_TABS,
  SIMPLE_MODE_RAIL_GROUPS,
  STANDALONE_COMMAND_IDS,
  visibleCommands,
} from './commands';
import { ActivityOverlay } from './components/ActivityOverlay';
import { HomeScreen } from './components/HomeScreen';
import { ModernEditorHeader } from './components/ModernEditorHeader';
import { PageNavigation } from './components/PageNavigation';
import { ToolRail } from './components/ToolRail';
import { UpdateBanner } from './components/UpdateBanner';
import { useAnnotationMarks } from './features/annotations/annotation-marks';
import {
  chooseAuthor,
  chooseColor,
  chooseFontSize,
  chooseOpacity,
  chooseTextColor,
  chooseThickness,
  holdEngineValues,
  orphanSweepInFlight,
  useAnnotationStyle,
} from './features/annotations/annotations-store';
import {
  useAnnotationActions,
  usePublishExistingAnnotations,
  useSettleNativeEditors,
} from './features/annotations/use-annotation-actions';
import { createAttachmentActions } from './features/attachments/attachments';
import { CommentsDock } from './features/comments/CommentsDock';
import { useCommentReview } from './features/comments/review';
import {
  clearNotice,
  hideLeftDock,
  hideRightDock,
  openLeftPanel,
  openRightPanel,
  selectLeftTab,
  selectRightTab,
  selectShape,
  selectTool,
  setInterfaceMode,
  showLeftDock,
  showNotice,
  showRightDock,
  toggleLeftDock,
  toggleRightDock,
  useCore,
} from './features/core/core-store';
import { handleReleased, replaceHandle, useDocumentHandle } from './features/core/handles';
import { useCompactViewport } from './features/core/viewport';
import { BatchDialogHost, ShortcutsDialogHost, StartDialogHost } from './features/dialogs/DialogSurfaces';
import { createDialogOpeners, createDialogRuns } from './features/dialogs/dialog-actions';
import { dismissOperationDialog, openBatchDialog, useDialogs } from './features/dialogs/dialogs-store';
import { useStaleDialogDismissal } from './features/dialogs/use-dialog-dismissal';
import { ContextMenuHost, ExportDialogHost } from './features/export/ExportSurfaces';
import { createCurrentBytes, createExportChoice, showContextMenu } from './features/export/export-actions';
import { openExportDialog } from './features/export/export-store';

import { useCurrentFacts } from './features/facts/facts-store';
import { PropertiesFacts } from './features/facts/PropertiesFacts';
import { RedactionAuditView } from './features/facts/RedactionAuditView';
import { SignatureWarningPrompt } from './features/facts/SignatureWarningPrompt';
import { useStoredTrust } from './features/facts/trust-store';
import { useDocumentFacts } from './features/facts/use-document-facts';
import { FieldCandidateHost, FormsPanel, XfaBanner, XfaFormDialogHost } from './features/forms/FormsSurface';
import {
  applyFormDetect as applyFormDetectFor,
  fillField as fillFieldFor,
  openXfaForm as openXfaFormFor,
  saveXfaForm as saveXfaFormFor,
  startFormDetect as startFormDetectFor,
} from './features/forms/form-actions';
import {
  retryInspection,
  useCurrentForms,
  useExistingAnnotations,
  useForms,
} from './features/forms/forms-store';
import { useFormInventory } from './features/forms/use-form-inventory';
import { useMarkTargets } from './features/marks/mark-targets';
import { currentMarkTargets } from './features/marks/marks-store';
import { useVisibleMarks } from './features/marks/overlays';
import { RedactionDock, RedactionMarkLayer } from './features/marks/RedactionSurfaces';
import {
  refuseUnappliedRedactions as refuseUnappliedRedactionsFor,
  useRedactionMarks,
} from './features/marks/redaction';
import { erasedWordsOf } from './features/marks/redaction-store';
import { useMarkActions, useWriterActions } from './features/marks/use-mark-actions';
import { MeasureOverlay } from './features/measure/MeasureOverlay';
import { MeasureSettingsStrip } from './features/measure/MeasureSettingsStrip';
import { armMeasure, useMeasureMode } from './features/measure/measure-store';
import { HomeHeader, OpenFileInput, PasswordPromptHost } from './features/open/OpenSurfaces';
import { openAndFingerprint } from './features/open/open-actions';
import {
  awaitHomeCommand,
  clearPageSelection,
  dropHomeCommand,
  hideStartScreen,
  openStore,
  selectAllPages,
  selectedPagesNow,
  selectPages,
  showStartScreen,
  useOpen,
} from './features/open/open-store';
import { useOpenActions } from './features/open/use-open-actions';
import { usePageActions } from './features/pages/page-actions';
import { persistDraft, saveDraft } from './features/persistence/draft-persist';
import { forgetDraft } from './features/persistence/draft-vault';
import { useDraftRecovery } from './features/persistence/use-draft-recovery';
import { usePersistenceActions } from './features/persistence/use-persistence-actions';
import { useDraftAutosave, useVaultChannel } from './features/persistence/use-vault-sync';
import { ReadingLayers } from './features/reading/ReadingLayers';
import { ReadingOrderLayer } from './features/reading/ReadingOrderLayer';
import { openSnapshot, toggleMagnifier, toggleReading, useReading } from './features/reading/reading-store';
import { useDocumentLanguage } from './features/reading/use-document-language';
import {
  AccessibilityDock,
  PdfADock,
  PrintDialogHost,
  ScanDialogHost,
} from './features/results/ResultsSurfaces';
import { createResultsActions } from './features/results/results-actions';
import { openPrintDialog, openScanDialog, setProgress, useResults } from './features/results/results-store';
import { discardDocument } from './features/save/close-actions';
import { prepareOutput as prepareDocumentOutput } from './features/save/prepare-output';
import { CloseDocumentHost } from './features/save/SaveSurfaces';
import { saveDocument } from './features/save/save-actions';
import { layoutChanged, setCurrentPage, useSave, viewerRef, zoomChanged } from './features/save/save-store';
import { useSaveActions } from './features/save/use-save-actions';
import { clearMarkSelection, selectMarks, useSelection } from './features/selection/selection-store';
import { TextToolSurface } from './features/selection/TextToolSurface';
import { clearTextEdit, useTextTool } from './features/selection/text-tool-store';
import { useSelectionActions, useSelectionEffects } from './features/selection/use-selection';
import { useTextToolBytes } from './features/selection/use-text-tool-bytes';
import { ImagePickerInput, SignatureDialogHost, StampPlacementHost } from './features/stamps/StampSurface';
import {
  openSignature as openSignatureFor,
  pickImage as pickImageFor,
  placeStamp as stampPlace,
  resizeStamp as stampResize,
} from './features/stamps/stamp-actions';
import { type DocumentContext, type PageAction, pendingOverlays } from './operations';
import type { SaveStepDescription } from './save-plan';
import { useShellShortcuts } from './useShortcuts';

/**
 * The editor shell.
 *
 * The reader with every capability wired into it. The shape that matters here: a panel or dialog never produces "its own output PDF".
 * It returns produced bytes, and this file is the only place that decides what
 * they mean — a new working version (journaled, undoable), a new tab, or a
 * download.
 */

/** The product name the shell falls back to; `index.html`'s `<title>` carries the same string. */
const PRODUCT_TITLE = 'SsPdfEditor';

/**
 * The canonical tool → the overlay's creation gesture.
 *
 * Selection belongs to the common interaction layer. Every annotation creator
 * stays controlled by the shell; arming pdf.js's separate editors would repaint
 * the base canvas and introduce a second selection and history owner.
 */
const ANNOTATION_LAYER_TOOLS: Readonly<Partial<Record<CanvasToolId, AnnotationTool>>> = {
  highlight: 'highlight',
  underline: 'underline',
  strikeout: 'strikeout',
  squiggly: 'squiggly',
  ink: 'ink',
  shapes: 'shapes',
  note: 'note',
  link: 'link',
  freetext: 'freetext',
};

export interface AppProps {
  readonly store: SessionStore;
}

/**
 * The command palette is the only consumer of Kumo's command palette, which held the entry
 * chunk over the budget. It is reached by a gesture, so it loads on demand — and `main.tsx`
 * prefetches it while the browser is idle, so the first `Ctrl+K` is not a visible wait.
 */
const CommandPalette = lazy(async () => {
  const module = await import('pdf-ui/palette');
  return { default: module.CommandPalette };
});
/**
 * The comparison panel reads the working bytes, so it rides the dock panels' own boundary
 * rather than the first paint.
 */
const ComparePanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.ComparePanel };
});

export function App({ store }: AppProps) {
  const { theme, setTheme } = useTheme();
  const { locale } = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const tier = useMemo(() => detectDeviceTier(), []);
  const [memoryUsage, setMemoryUsage] = useState<{ usedBytes: number; budgetBytes: number } | undefined>(
    undefined,
  );
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot);
  /**
   * The translator, reachable from effect bodies **without** becoming one of their
   * dependencies. Recovery used to take `t` in its dep list, so changing the interface
   * language re-ran it: every draft was restored a second time, over tabs that were
   * already open.
   */
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const cancelRef = useRef<AbortController | null>(null);
  /** The viewer's zoom and page, and the layout counter that renders the overlays again (`features/save/`). */
  const zoom = useSave((state) => state.zoom);
  const currentPage = useSave((state) => state.currentPage);
  useSave((state) => state.layoutRevision);
  const notice = useCore((state) => state.notice);
  const busy = useCore((state) => state.busy);
  /**
   * A gesture the synchronous gate refuses says so. The gate itself stays
   * synchronous — this only speaks when it closes, because an inert control and a
   * refused action must not look the same.
   */
  const refuseBusy = useCallback(() => showNotice(t('op.busy')), [t]);
  const reading = useReading((state) => state.reading);
  const magnifierOn = useReading((state) => state.magnifierOn);
  /** Surface state: dialogs, palette, docks, page selection, progress, tools. */
  const dialogSpec = useDialogs((state) => state.dialogSpec);
  const dialogInput = useDialogs((state) => state.dialogInput);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Language, theme, interface mode, privacy and offline preferences — one dialog. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const showHomeScreen = useOpen((state) => state.showHomeScreen);
  const opening = useOpen((state) => state.opening);
  const lockedTabs = useOpen((state) => state.lockedTabs);
  /**
   * **The one canvas tool.** Every surface
   * that can arm or stop a tool writes this value and nothing else — the left rail,
   * the menu, the palette, the right rail, the context menu, the text/link/redaction
   * routes and the engine's own mode reset. The parallel states this replaces
   * (`leftTool`, `annotationTool`, `textTool`, `redactionActive`, `measureMode`) were
   * five answers to one question, and the toolbar showed the wrong one whenever a
   * route other than the rail armed a tool.
   *
   * It is a `CanvasToolId`: the rail's ids plus the tools only the menus reach
   * (underline, strikeout, squiggly, redact, measure, link). The id is the armed
   * state; nothing else is.
   */
  const canvasTool = useCore((state) => state.canvasTool);
  const shape = useCore((state) => state.shape);
  /** The common layer's selection (`features/selection/`). */
  const selectedKeys = useSelection((state) => state.selectedKeys);
  const compactViewport = useCore((state) => state.compactViewport);
  const leftDock = useCore((state) => state.leftDock);
  const rightDock = useCore((state) => state.rightDock);
  useCompactViewport();
  const rightTab = useCore((state) => state.rightTab);
  const selectedPages = useOpen((state) => state.selectedPages);
  const progress = useResults((state) => state.progress);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** The block the text tool picked, which travels to the dialog in the run context (`features/selection/`). */
  const textEdit = useTextTool((state) => state.edit);
  /**
   * The rectangle the link tool dragged, held here for the same reason the text
   * selection is: the dialog's `run` must operate on the region the user pointed at,
   * not on one re-measured after the fact.
   */
  const [linkRegion, setLinkRegion] = useState<LinkTargetRect | null>(null);
  /**
   * The image objects of the working document, read when the image dialog is opened —
   * the same rule the text block follows: the list the user picks from must describe the
   * bytes the run will edit.
   */
  const [images, setImages] = useState<readonly PdfImageInfo[] | null>(null);
  const leftTab = useCore((state) => state.leftTab);
  /** Simple or advanced (`interface-mode.ts`): read once on load, changed only by `changeMode`. */
  const mode = useCore((state) => state.mode);
  const changeMode = useCallback((next: InterfaceMode) => {
    setInterfaceMode(next);
    // A dialog the simple mode hides must not stay open behind the filter: closing it
    // returns the user to a surface the mode actually offers, rather than leaving them
    // on a screen the menus can no longer reach.
    if (next === 'simple') {
      cancelRef.current?.abort();
      dismissOperationDialog();
    }
  }, []);
  /** Leave the simple mode; the palette's "hidden by the simple mode" hint calls this. */
  const useAdvancedMode = useCallback(() => changeMode('advanced'), [changeMode]);
  /** The drawn redaction marks of the active tab (`features/marks/redaction.ts`). */
  const { redactionMarks, setRedactionMarks } = useRedactionMarks(store);
  /**
   * The annotation marks of the active tab and the look the next one is drawn with
   * (`features/annotations/`). The marks are the tab's pending overlay, not engine state.
   */
  const { annotations, setAnnotations } = useAnnotationMarks(store);
  const {
    color: annotationColor,
    textColor,
    fontSize,
    opacity: annotationOpacity,
    thickness: annotationThickness,
    author: annotationAuthor,
  } = useAnnotationStyle();
  /** The measurements the session holds (the measure tool's own state is `features/measure`). */
  const measureMarks = pendingOverlays(store.active).measures;
  // The file's own annotations and form fields, each keyed to the bytes it was read from
  // (`features/forms`); the forms store owns them.
  const inspectionRevision = useForms((state) => state.inspectionRevision);

  /**
   * The tools slices need a render when the viewer API arrives: the save store holds it, the
   * shortcut layer and the handlers read `viewerRef.current`, and this is the render.
   */
  const viewer = useSave((state) => state.viewer);
  const presentation = usePresentation(viewer);
  // The language the open document declares follows the viewer API, which is replaced with
  // every document; the reading pane reads it from the reading store.
  useDocumentLanguage(viewer);

  const activeTab = session.tabs.find((tab) => tab.id === session.activeId) ?? null;

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
  const activeHandle = useDocumentHandle(activeTab?.id ?? null);
  const pageCount = activeTab === null ? 0 : workingPageCount(activeTab);
  const currentForms = useCurrentForms(activeTab);
  const formFields = currentForms?.fields ?? null;

  /**
   * The file's annotations for the bytes on screen — `null` while the read is still in
   * flight, or when it describes a version that is no longer current.
   */
  const existingAnnotations = useExistingAnnotations(activeTab);
  usePublishExistingAnnotations(existingAnnotations);
  const visibleMarks = useVisibleMarks(activeTab);

  /** Which measurement is armed; `null` whenever the ruler does not own the pointer. */
  const measureMode = useMeasureMode();
  /** Only creation gestures reach the annotation overlay. */
  const annotationLayerTool = ANNOTATION_LAYER_TOOLS[canvasTool] ?? null;
  const markMode = canvasTool === 'select' ? 'select' : null;

  /** Every mark the page shows, in the common layer's identity space (`features/marks/mark-targets.ts`). */
  const markTargets = useMarkTargets({
    annotations,
    measures: measureMarks,
    redactions: redactionMarks,
    existing: existingAnnotations,
    viewer,
    t,
  });

  /**
   * The document names the browser's own surfaces: the printed file, a "Save as…"
   * suggestion and the window itself. The print dialog and the export both
   * take their suggested file name from `document.title`, so it follows the active
   * document (and says so when there are unsaved changes) instead of staying the
   * product name while a contract sits open.
   */
  useEffect(() => {
    document.title =
      activeTab === null
        ? PRODUCT_TITLE
        : `${activeTab.name}${activeTab.dirty ? ` — ${t('tab.dirty')}` : ''}`;
  }, [activeTab, t]);

  const verdict = useMemo(() => {
    if (activeTab === null) return checkDocumentLimits(tier, 0, 0);
    const currentBytes = activeTab.working.produced?.bytes.byteLength ?? activeTab.source.size;
    return checkDocumentLimits(tier, workingPageCount(activeTab), currentBytes);
  }, [activeTab, tier]);
  /** Editing is off in viewing mode and while an operation runs. */
  const viewingOnly = verdict.kind === 'viewing-only';
  const locked = activeTab !== null && lockedTabs.has(activeTab.id);
  const canEdit =
    activeTab !== null &&
    activeHandle !== null &&
    viewer?.document === activeHandle &&
    !viewingOnly &&
    !locked &&
    !busy;

  useEffect(() => {
    const budgetBytes = tier === 'mobile' ? 128 * 1024 * 1024 : 512 * 1024 * 1024;
    const sample = () => {
      let usedBytes = 0;
      const perfMem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
      if (typeof perfMem?.usedJSHeapSize === 'number' && perfMem.usedJSHeapSize > 0) {
        usedBytes = perfMem.usedJSHeapSize;
      } else {
        const tabBytes = store.getSnapshot().tabs.reduce((sum, tab) => {
          const srcBytes = tab.source.size;
          const workBytes = tab.working.produced?.bytes.byteLength ?? 0;
          return sum + srcBytes + workBytes;
        }, 0);
        usedBytes = tabBytes + 24 * 1024 * 1024;
      }
      setMemoryUsage({ usedBytes, budgetBytes });
    };
    sample();
    const interval = window.setInterval(sample, 2500);
    return () => clearInterval(interval);
  }, [tier, store]);

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

  useFormInventory({ store, t, tab: activeTab, handle: activeHandle });

  useStoredTrust();
  const documentFacts = useCurrentFacts(activeTab);
  const canPrepareWrite = activeTab !== null && documentFacts !== null && formFields !== null && !busy;
  useDocumentFacts({ store, t, tab: activeTab, handle: activeHandle, revision: inspectionRevision });

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

  useDraftRecovery({ store, translator: tRef, openAndFingerprint });
  useDraftAutosave({ session, store, persist: persistTabDraft, translator: tRef });
  useVaultChannel(store, session);

  const { openFile, openProducedTab, openFromSurface, openFilesFromSurface, openViaPicker, selectRecent } =
    useOpenActions({
      session: store,
      t,
      tier,
      cancelRef,
      refuseBusy,
      setCurrentPage,
      setRedactionMarks,
    });

  /**
   * The annotation handlers: the review as a file, the engine's editor takeover, native
   * editors and the orphan sweep (`features/annotations/`). What the shell still owns is
   * handed in: the viewer's API, the running operation's controller, and the way a tab becomes
   * an operation context.
   */
  const annotationActions = useAnnotationActions({
    session: store,
    t,
    viewer: viewerRef,
    cancel: cancelRef,
    contextFor,
    setHandle,
  });
  const {
    exportAnnotationData,
    importAnnotationData,
    takeEngineAnnotations,
    settleNativeEditors,
    sweepOrphanAnnotations,
  } = annotationActions;
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

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement === null) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  }, []);

  const { openStart, openDialog, showShortcuts, closeShortcuts } = useMemo(
    () => createDialogOpeners({ session: store, t, contextFor, cancelRef, refuseBusy, setImages }),
    [contextFor, refuseBusy, store, t],
  );

  const exportChoice = useMemo(
    () => createExportChoice({ exportActive, openDialog }),
    [exportActive, openDialog],
  );

  /**
   * The frozen input a dialog runs against. `signal` and `onProgress` are absent
   * by construction: the run hook creates both, so a dialog can only ever cancel
   * work it owns.
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

  /** The working bytes the text tool reads its page model from, frozen when it is armed (`features/selection/`). */
  useTextToolBytes(activeTab, activeHandle, contextFor, t);

  /**
   * What a produced file *means* is decided here and nowhere else: `replace` ends
   * in a journaled working-version change (undoable), `new-tab` opens beside the
   * current document, `download` writes files and touches nothing.
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

  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  /** `canEdit` for callbacks that must not act on the render they were created in. */
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

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

  /** Replies, review states and taking a reply back (`features/comments/review.ts`). */
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

  /** Delete, Select all and opening a note, and the effects that keep the selection honest (`features/selection/`). */
  const { deleteMarkSelection, selectAllMarks, openNote } = useSelectionActions({
    session: store,
    cancel: cancelRef,
    refuseBusy,
    settleNativeEditors,
    sweepOrphanAnnotations,
    removeTargets,
  });
  useSelectionEffects({
    markMode,
    tabId: activeTab?.id,
    existing: existingAnnotations,
    targets: markTargets,
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

  const commands = useMemo(
    () =>
      buildCommands({
        t,
        hasDocument: activeTab !== null,
        canEdit,
        canUndo: activeTab?.journal.canUndo ?? false,
        canRedo: activeTab?.journal.canRedo ?? false,
        canSave: canPrepareWrite && activeTab?.source.handle !== undefined,
        canExport: canPrepareWrite,
        selectedPages,
        zoom,
        magnifier: magnifierOn,
        reading,
        leftDock,
        rightDock,
        openFile: () => void openViaPicker(),
        save: () => void saveActive(),
        exportDocument: () => void exportActive(),
        print: openPrint,
        openBatch: openBatchDialog,
        openSignature,
        addImage: pickImage,
        measure: armMeasure,
        measureMode,
        detectFormFields: () => void startFormDetect(),
        showRightTab: (tab) => {
          openRightPanel(tab);
        },
        undo: () => stepHistoryNow('undo'),
        redo: () => stepHistoryNow('redo'),
        rename: () => setRenamingId(activeTab?.id ?? null),
        closeTab: () => {
          if (activeTab !== null) closeTab(activeTab.id);
        },
        openDialog,
        openXfaForm,
        showShortcuts,
        openSettings: () => setSettingsOpen(true),
        pageAction: runPageAction,
        setZoom: (value) => viewerRef.current?.setZoom(value),
        setSpread: (mode) => viewerRef.current?.setSpreadMode(mode),
        toggleFullscreen: () => void toggleFullscreen(),
        toggleReading,
        toggleMagnifier,
        openSnapshot: openSnapshotMenu,
        toggleLeftDock,
        toggleRightDock,
        selectAllPages: () => selectAllPages(pageCount),
        clearSelection: clearPageSelection,
        palette: () => {
          // A modal surface takes the pointer: the measure overlay covers the viewer, so a
          // tool left armed would swallow the palette's own clicks (measured in the harness).
          selectTool('select');
          setPaletteOpen(true);
        },
        openLeftTab: (tab) => {
          openLeftPanel(tab);
        },
        activeTool: canvasTool,
        armTool: (tool) => selectTool(tool),
        selectedMarkCount: selectedKeys.length,
        deleteMarkSelection: () => void deleteMarkSelection(),
        selectAllMarks: () => void selectAllMarks(),
        showRedactionAudit: () => {
          openRightPanel('redaction-audit');
        },
        theme,
        setTheme,
        sensitiveSession: activeTab?.sensitive ?? false,
        toggleSensitiveSession,
        opfsSave,
        purgeActiveDocument,
        sweepVault,
        checkOffline,
        prepareOfflinePackages,
        mode,
        useAdvancedMode,
      }),
    [
      activeTab,
      canvasTool,
      canEdit,
      canPrepareWrite,
      checkOffline,
      closeTab,
      deleteMarkSelection,
      exportActive,
      leftDock,
      magnifierOn,
      openDialog,
      openPrint,
      openSnapshotMenu,
      openXfaForm,
      openViaPicker,
      pageCount,
      prepareOfflinePackages,
      reading,
      rightDock,
      runPageAction,
      saveActive,
      selectedKeys,
      selectedPages,
      selectAllMarks,
      showShortcuts,
      stepHistoryNow,
      t,
      toggleFullscreen,
      zoom,
      measureMode,
      theme,
      setTheme,
      toggleSensitiveSession,
      opfsSave,
      purgeActiveDocument,
      sweepVault,
      mode,
      useAdvancedMode,
      pickImage,
      openSignature,
      startFormDetect,
    ],
  );

  /**
   * A tool picked on the home screen. A standalone command (blank document, images,
   * merge, batch) runs at once; with a document open the command runs on it; with none,
   * the file is asked for first and the command waits for its tab (the effect below).
   */
  const runHomeCommand = useCallback(
    (commandId: string) => {
      const command = commands.find((item) => item.id === commandId);
      if (command === undefined) return;
      if (STANDALONE_COMMAND_IDS.has(commandId)) {
        command.run();
        return;
      }
      if (activeTab !== null && activeHandle !== null) {
        if (command.disabled === true) return;
        hideStartScreen();
        command.run();
        return;
      }
      awaitHomeCommand(commandId);
      void openViaPicker();
    },
    [activeHandle, activeTab, commands, openViaPicker],
  );

  useEffect(() => {
    const pending = openStore.get().pendingHomeCommand;
    // The open that brought the document is still holding the busy gate until it settles:
    // a dialog asked for before then is refused as "another operation is running".
    if (pending === null || viewer === null || activeHandle === null || busy) return;
    dropHomeCommand();
    const command = commands.find((item) => item.id === pending);
    if (command !== undefined && command.disabled !== true) command.run();
  }, [viewer, activeHandle, busy, commands]);

  useShellShortcuts(
    useMemo(
      () => ({
        open: () => void openViaPicker(),
        save: () => void saveActive(),
        exportDocument: () => openExportDialog(),
        // The whole common selection, across every mark family, and only when there is
        // one: the key is not swallowed to mean nothing.
        deleteSelection: deleteMarkSelection,
        print: openPrint,
        zoomIn: () => viewerRef.current?.setZoom(Math.min(4, zoom + 0.25)),
        zoomOut: () => viewerRef.current?.setZoom(Math.max(0.25, zoom - 0.25)),
        zoomReset: () => viewerRef.current?.setZoom(1),
        fitWidth: () => viewerRef.current?.setZoom('page-width'),
        nextPage: () => viewerRef.current?.goToPage(currentPage + 1),
        previousPage: () => viewerRef.current?.goToPage(currentPage - 1),
        firstPage: () => viewerRef.current?.goToPage(0),
        lastPage: () => viewerRef.current?.goToPage(Math.max(0, pageCount - 1)),
        undo: () => stepHistoryNow('undo'),
        redo: () => stepHistoryNow('redo'),
        palette: () => {
          // The second host (the keyboard shortcut layer) takes the same rule: a modal
          // surface takes the pointer, so no tool stays armed under it.
          selectTool('select');
          setPaletteOpen(true);
        },
        toggleLeftDock,
        toggleRightDock,
        reading: toggleReading,
        documentProperties: () => openDialog('properties'),
        findReplace: () => {
          if (!canEditRef.current) return false;
          openDialog('find-replace');
          return true;
        },
        selectAllMarks,
      }),
      [
        currentPage,
        deleteMarkSelection,
        openDialog,
        openPrint,
        openViaPicker,
        pageCount,
        saveActive,
        selectAllMarks,
        stepHistoryNow,
        zoom,
      ],
    ),
  );

  const isHome = activeTab === null || activeHandle === null || showHomeScreen;
  const openTabIds = useMemo(() => new Set(session.tabs.map((tab) => tab.id)), [session.tabs]);

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
      {isHome ? (
        <HomeHeader
          t={t}
          title={PRODUCT_TITLE}
          activeDocumentName={activeTab === null ? null : activeTab.name}
          onSettings={() => setSettingsOpen(true)}
          onPalette={() => setPaletteOpen(true)}
          onOpen={() => void openViaPicker()}
        />
      ) : (
        <ModernEditorHeader
          t={t}
          docName={activeTab.name}
          renaming={renamingId === activeTab.id}
          onRenameCancel={() => setRenamingId(null)}
          onRename={(name) => {
            setRenamingId(null);
            const next = name.trim();
            if (next === '' || next === activeTab.name) return;
            store.renameTab(activeTab.id, next);
            showNotice(t('shell.rename.done', { name: next }));
          }}
          isDirty={activeTab.dirty}
          canEdit={canEdit}
          onConvert={() => openExportDialog()}
          onSign={() => openDialog('sign')}
          onHome={showStartScreen}
          onOpen={() => void openViaPicker()}
          canSave={canPrepareWrite}
          saveMode={
            activeTab.source.handle !== undefined
              ? 'save'
              : typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
                ? 'saveAs'
                : 'none'
          }
          onSave={() => void saveActive()}
          canExport={canPrepareWrite}
          onExport={() => void exportActive()}
          onExportOptions={() => openExportDialog()}
          onSearch={() => viewerRef.current?.openFind()}
          onPalette={() => setPaletteOpen(true)}
          menu={
            <MenuBar t={t} commands={mode === 'simple' ? visibleCommands(commands, 'simple') : commands} />
          }
          tabs={session.tabs.map((tab) => ({ id: tab.id, name: tab.name, dirty: tab.dirty }))}
          activeTabId={session.activeId}
          onSelectTab={(id) => {
            if (store.active?.id !== id) cancelRef.current?.abort();
            store.setActive(id);
            clearPageSelection();
          }}
          onCloseTab={closeTab}
          onSettings={() => setSettingsOpen(true)}
        />
      )}

      {/* The tool strip: one row of **fixed height** whatever the armed tool offers — the
          measure tool's own settings included — so arming a tool never moves the document.
          It scrolls sideways on a narrow screen instead of wrapping into a taller row. */}
      {!isHome ? (
        <div className="flex h-9 shrink-0 items-center overflow-x-auto overflow-y-hidden border-b border-kumo-line bg-kumo-base px-3">
          {locked ? (
            <div role="status" className="flex min-w-max items-center gap-2 text-[11px] text-kumo-warning">
              <span>{t('locked.banner')}</span>
              <Button size="sm" shape="base" disabled={busy} onClick={() => void unlockActiveCopy()}>
                {t('locked.unlockCopy')}
              </Button>
            </div>
          ) : measureMode !== null && viewer !== null ? (
            <MeasureSettingsStrip
              t={t}
              // Colour, opacity, thickness and author are the annotation style: a
              // ruler and a highlighter are the same kind of mark, so the ruler's
              // settings edit the same state the marker tools do.
              color={annotationColor}
              onColor={chooseColor}
              opacity={annotationOpacity}
              onOpacity={chooseOpacity}
              thickness={annotationThickness}
              onThickness={chooseThickness}
              author={annotationAuthor}
              onAuthor={chooseAuthor}
            />
          ) : (
            <ToolProperties
              t={t}
              tool={canvasTool}
              color={annotationColor}
              opacity={annotationOpacity}
              thickness={annotationThickness}
              author={annotationAuthor}
              shape={shape}
              textColor={textColor}
              fontSize={fontSize}
              onTextColor={chooseTextColor}
              onFontSize={chooseFontSize}
              redactionCount={redactionMarks.length}
              onApplyRedaction={() => openDialog('redact')}
              onTool={selectTool}
              selectedCount={selectedKeys.length}
              disabled={!canEdit || (canvasTool === 'select' && existingAnnotations === null)}
              onColor={chooseColor}
              onOpacity={chooseOpacity}
              onThickness={chooseThickness}
              onAuthor={chooseAuthor}
              onShape={selectShape}
              // Selection actions share one intent across every mark family.
              onDeleteSelection={() => void removeTargets(selectedKeys)}
              onRotateSelection={() => void transformTargets(selectedKeys, { dx: 0, dy: 0, rotation: 90 })}
              onMoveSelection={(dx, dy) => void transformTargets(selectedKeys, { dx, dy, rotation: 0 })}
              onClearSelection={clearMarkSelection}
            />
          )}
        </div>
      ) : null}
      {!isHome ? (
        <XfaBanner t={t} tab={activeTab} canEdit={canEdit} onFill={openXfaForm} onOpenDialog={openDialog} />
      ) : null}
      <main className="relative min-h-0 flex-1">
        {isHome ? (
          <HomeScreen
            t={t}
            onOpenFiles={(files) => void openFilesFromSurface(files)}
            onOpenPicker={() => void openViaPicker()}
            onStart={(action) => {
              if (action === 'batch') openBatchDialog();
              else if (action === 'scan') openScanDialog();
              else
                openStart(
                  action === 'blank'
                    ? 'new-document'
                    : action === 'images'
                      ? 'images-to-pdf'
                      : action === 'convert'
                        ? 'convert-to-pdf'
                        : 'merge-files',
                );
            }}
            // The grid is the discovery surface named 'all tools': it lists every tool in either
            // mode (the simple mode filters the menus and the palette, it never disables).
            commands={commands}
            standaloneCommands={STANDALONE_COMMAND_IDS}
            onRunCommand={runHomeCommand}
            activeDocumentName={activeTab === null ? null : activeTab.name}
            openIds={openTabIds}
            onSelectRecent={selectRecent}
            onOpenPalette={() => setPaletteOpen(true)}
            busy={busy}
          />
        ) : (
          <div className="flex h-full">
            {leftDock ? (
              <div className={compactViewport ? 'absolute inset-y-0 start-0 z-40 max-w-full' : 'contents'}>
                <DocumentPanel
                  onToggle={() => hideLeftDock()}
                  document={activeHandle}
                  t={t}
                  currentPage={currentPage}
                  selectedPages={selectedPages}
                  onSelectionChange={selectPages}
                  onPageAction={runPageAction}
                  editing={canEdit}
                  version={activeTab.working.stateId}
                  marks={visibleMarks.annotations}
                  onGoToPage={(pageIndex) => viewerRef.current?.goToPage(pageIndex)}
                  onNotice={showNotice}
                  onHighlightQuery={(query) => viewerRef.current?.find(query)}
                  onLayersChanged={() => void viewerRef.current?.refreshOptionalContent()}
                  onExtract={() => openDialog('extract-pages')}
                  onEditOutline={() => openDialog('outline-edit')}
                  onWriteLayers={(request) => void writeLayers(request)}
                  onAddAttachments={(files) => void attachmentActions.write({ add: files })}
                  onRemoveAttachments={(names) => void attachmentActions.write({ remove: names })}
                  visibleTabs={mode === 'simple' ? SIMPLE_MODE_DOCK_TABS : undefined}
                  tab={leftTab}
                  onTabChange={selectLeftTab}
                />
              </div>
            ) : null}
            <ToolRail t={t} canEdit={canEdit} />
            {/* biome-ignore lint/a11y/noStaticElementInteractions: context menu listener on the document canvas container */}
            <div className="relative min-w-0 flex-1 overflow-hidden" onContextMenu={showContextMenu}>
              {/* Persistent edge handle to reopen Left Dock */}
              {!leftDock ? (
                <button
                  type="button"
                  title={t('nav.togglePages')}
                  aria-label={t('nav.togglePages')}
                  onClick={() => showLeftDock()}
                  className="absolute start-0 top-3 z-30 flex h-9 w-4 items-center justify-center rounded-e-md border border-s-0 border-kumo-line bg-kumo-base/95 text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong pdf-floating-shadow transition-all"
                >
                  <CaretRight size={12} weight="bold" className="rtl:-scale-x-100" />
                </button>
              ) : null}

              {/* Persistent edge handle to reopen Right Dock */}
              {!rightDock ? (
                <button
                  type="button"
                  title={t('tools.all')}
                  aria-label={t('tools.all')}
                  onClick={() => showRightDock()}
                  className="absolute end-0 top-3 z-30 flex h-9 w-4 items-center justify-center rounded-s-md border border-e-0 border-kumo-line bg-kumo-base/95 text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong pdf-floating-shadow transition-all"
                >
                  <CaretLeft size={12} weight="bold" className="rtl:-scale-x-100" />
                </button>
              ) : null}

              <PdfViewerPane
                document={activeHandle}
                documentKey={activeTab?.id}
                t={t}
                handTool={canvasTool === 'hand'}
                onReady={handleViewerReady}
                onDocumentReleased={handleDocumentReleased}
                onCurrentPageChange={setCurrentPage}
                onScaleChange={zoomChanged}
                onModifiedChange={markActiveDirty}
                onLayoutChange={layoutChanged}
                onReplace={canEdit ? (query) => openDialog('find-replace', { find: query }) : undefined}
                // The mark layers live inside the viewer's scroll content, so the browser
                // scrolls them with the pages; outside it they were re-placed only on the
                // next render and slid over the text while the reader scrolled.
                overlay={
                  viewer === null ? null : (
                    <>
                      {/* A protected tab is read-only: no area can be marked on it. */}
                      <RedactionMarkLayer
                        t={t}
                        viewer={viewer}
                        session={store}
                        enabled={!locked && !viewingOnly}
                      />
                      {/*
                Measurements remain visible after switching to selection. Only creation
                and the settings strip follow the armed tool, not the marks themselves.
              */}
                      {viewer !== null ? (
                        <MeasureOverlay
                          t={t}
                          session={store}
                          viewer={viewer}
                          marks={visibleMarks.measures}
                          canEdit={canEdit}
                          color={annotationColor}
                          opacity={annotationOpacity}
                          thickness={annotationThickness}
                          author={annotationAuthor}
                        />
                      ) : null}
                      {/*
                The visual layer survives transient edit locks. Only its creator is
                disarmed: unmounting the marks during a checkpoint made them flash.
              */}
                      {viewer !== null ? (
                        <AnnotationLayer
                          t={t}
                          viewer={viewer}
                          tool={canEdit ? annotationLayerTool : null}
                          marks={visibleMarks.annotations}
                          color={annotationColor}
                          opacity={annotationOpacity}
                          thickness={annotationThickness}
                          author={annotationAuthor}
                          shape={shape}
                          textColor={textColor}
                          fontSize={fontSize}
                          onCreate={(mark) => {
                            setAnnotations((marks) => [...marks, mark]);
                            store.setDirty(activeTab.id, true);
                            // A note is a comment: it opens its contents for editing at once,
                            // selected, so the sentence the user is about to write has a home.
                            if (mark.kind === 'note') openNote(mark);
                          }}
                          onDone={() => selectTool('select')}
                          onRegion={(region) => {
                            // The rectangle is already in the writer's own space; the dialog
                            // only asks where it should point.
                            setLinkRegion(region);
                            openDialog('link-add');
                          }}
                        />
                      ) : null}
                      {/*
                The common layer: one identity space, one hit test, one selection across
                every mark family — the session's annotations, its measurements, its
                redaction intents and the annotations the file already carries. It is
                mounted whenever the viewer is, with `mode={null}` when no tool of its
                own is armed, because a layer that unmounted would drop the selection
                chrome with it.
              */}
                      {viewer !== null ? (
                        <MarkInteractionLayer
                          viewer={viewer}
                          mode={markMode}
                          targets={markTargets}
                          selectedKeys={selectedKeys}
                          // Saved marks become editable only when their current inventory
                          // is ready; unread does not mean the PDF contains no annotations.
                          disabled={!canEdit || existingAnnotations === null}
                          onSelectionChange={selectMarks}
                          onMove={(keys, dx, dy) => void transformTargets(keys, { dx, dy, rotation: 0 })}
                          onResize={resizeStamp}
                          resizeLabel={t('stamp.resize')}
                        />
                      ) : null}
                      <StampPlacementHost viewer={viewer} canEdit={canEdit} t={t} onPlace={placeStamp} />
                      <FieldCandidateHost t={t} tab={activeTab} viewer={viewer} canEdit={canEdit} />
                      <TextToolSurface
                        viewer={viewer}
                        currentPage={currentPage}
                        t={t}
                        onEdit={() => openDialog('text-edit')}
                      />
                      {/* The accessibility panel's numbered reading-order boxes. */}
                      {viewer !== null && rightDock && rightTab === 'accessibility' ? (
                        <Suspense fallback={null}>
                          <ReadingOrderLayer t={t} viewer={viewer} />
                        </Suspense>
                      ) : null}
                    </>
                  )
                }
              />
            </div>
            {rightDock ? (
              <div className={compactViewport ? 'absolute inset-y-0 end-0 z-40 max-w-full' : 'contents'}>
                <Dock
                  t={t}
                  side="right"
                  tabs={[
                    { id: 'tools', label: 'shell.menu.tools' },
                    { id: 'history', label: 'panel.history' },
                    { id: 'comments', label: 'panel.comments' },
                    { id: 'forms', label: 'panel.forms' },
                    { id: 'properties', label: 'props.title' },
                    { id: 'redaction', label: 'panel.redaction' },
                    { id: 'redaction-audit', label: 'audit.title' },
                    { id: 'compare', label: 'panel.compare' },
                    { id: 'accessibility', label: 'panel.accessibility' },
                    { id: 'pdfa', label: 'panel.pdfa' },
                  ]}
                  activeId={rightTab}
                  onSelect={selectRightTab}
                  onToggle={() => hideRightDock()}
                  wide={rightTab === 'accessibility'}
                >
                  {rightTab === 'tools' ? (
                    <ToolsRailPanel
                      t={t}
                      activeSpec={rightDock && rightTab === 'tools' ? dialogSpec : null}
                      context={dialogContext}
                      onSelectTool={(id) => {
                        // Same refusal as the arming half below: the form is not offered on a
                        // tab nothing can be written to, and a protected one says why.
                        if (id === 'redact' && !canEdit) {
                          if (locked) showNotice(t('locked.banner'));
                          else if (busy) refuseBusy();
                          return;
                        }
                        openDialog(id);
                      }}
                      onBackToTools={() => {
                        cancelRef.current?.abort();
                        dismissOperationDialog();
                        // The block selection belongs to exactly one run: leaving it in
                        // place would let a later `text-edit` open on a paragraph the
                        // user is no longer looking at.
                        clearTextEdit();
                      }}
                      onResult={(result) => void dialogResult(result)}
                      onPageAction={(action) => runPageAction(action as PageAction)}
                      onArmTool={(tool) => {
                        // The rail emits the redaction tool today and offered the
                        // highlighter before it; anything else is not a canvas tool and
                        // must not silently arm one.
                        if (tool === 'redact') {
                          if (canEdit) selectTool('redact');
                          else if (locked) showNotice(t('locked.banner'));
                        } else if (tool === 'highlight') selectTool('highlight');
                      }}
                      onOpenPalette={() => setPaletteOpen(true)}
                      onExportModal={() => openExportDialog()}
                      visibleGroups={mode === 'simple' ? SIMPLE_MODE_RAIL_GROUPS : undefined}
                    />
                  ) : rightTab === 'history' ? (
                    <HistoryPanel
                      t={t}
                      entries={activeTab.journal.entries}
                      cursor={activeTab.journal.cursor}
                      onUndo={() => void stepHistoryNow('undo')}
                      onRedo={() => void stepHistoryNow('redo')}
                    />
                  ) : rightTab === 'comments' ? (
                    <CommentsDock
                      t={t}
                      marks={visibleMarks.annotations}
                      existing={existingAnnotations}
                      // The panel's rows name marks by id; the selection is one key
                      // space, so the highlighted row is derived from the target list
                      // rather than by re-spelling a key.
                      selectedId={
                        markTargets.find(
                          (target) => target.family === 'annotation' && selectedKeys.includes(target.key),
                        )?.id ?? null
                      }
                      onSelect={(id) => {
                        // The panel toggles: a second click on the selected row
                        // reports `null`, which is the empty selection.
                        if (id === null) {
                          clearMarkSelection();
                          return;
                        }
                        const mark = annotations.find((item) => item.id === id);
                        if (mark !== undefined) {
                          selectMarks([markTargetKey('annotation', mark.id, mark.pageIndex)]);
                        }
                      }}
                      onGoToPage={(pageIndex) => viewerRef.current?.goToPage(pageIndex)}
                      onEdit={(id, contents) =>
                        setAnnotations((marks) =>
                          marks.map((mark) => (mark.id === id ? { ...mark, contents } : mark)),
                        )
                      }
                      // Panel removal is the same intent as selection Delete: one path,
                      // one journal entry, the same undo.
                      onRemove={(id) => void removeTargets([markTargetKey('annotation', id, 0)])}
                      onClear={() =>
                        void removeTargets(
                          markTargets
                            .filter((target) => target.family === 'annotation')
                            .map((target) => target.key),
                        )
                      }
                      onExportData={(format) => void exportAnnotationData(format)}
                      onImportData={(file) => void importAnnotationData(file)}
                      onReply={commentReview.onReply}
                      onSetState={commentReview.onSetState}
                      onRemoveReply={commentReview.onRemoveReply}
                      disabled={!canEdit}
                    />
                  ) : rightTab === 'properties' ? (
                    <PropertiesFacts
                      t={t}
                      tab={activeTab}
                      disabled={!canEdit}
                      onRetry={retryInspection}
                      onAddAttachments={(files) => void attachmentActions.addToDocument(files)}
                      onRemoveAttachment={(name) => void attachmentActions.removeFromDocument(name)}
                      onReadAttachment={(name) => void attachmentActions.readOut(name)}
                    />
                  ) : rightTab === 'redaction-audit' ? (
                    <RedactionAuditView store={store} t={t} erasedTerms={erasedWordsOf} />
                  ) : rightTab === 'compare' ? (
                    <Suspense
                      fallback={
                        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
                          {t('panel.compare')}
                        </p>
                      }
                    >
                      <ComparePanel
                        key={activeTab.working.id}
                        t={t}
                        // The shell's one route from the session to bytes: a mark drawn a
                        // moment ago is part of what is compared.
                        readDocument={() => currentBytes({ signal: new AbortController().signal })}
                        onGoToPage={(pageIndex) => viewerRef.current?.goToPage(pageIndex)}
                        onNotice={showNotice}
                        disabled={!canEdit}
                      />
                    </Suspense>
                  ) : rightTab === 'accessibility' ? (
                    <AccessibilityDock
                      key={activeTab.working.id}
                      t={t}
                      read={currentBytes}
                      language={locale}
                      currentPage={currentPage}
                      canEdit={canEdit}
                      onGoToPage={(pageIndex) => viewerRef.current?.goToPage(pageIndex)}
                      onWritten={resultsActions.applyAccessibility}
                    />
                  ) : rightTab === 'pdfa' ? (
                    <PdfADock
                      key={activeTab.working.id}
                      t={t}
                      read={currentBytes}
                      onConvert={() => openDialog('pdfa')}
                    />
                  ) : rightTab === 'forms' ? (
                    <FormsPanel
                      t={t}
                      tab={activeTab}
                      canEdit={canEdit}
                      goToPage={(pageIndex) => viewerRef.current?.goToPage(pageIndex)}
                      onDetect={() => void startFormDetect()}
                      onApply={applyFormDetect}
                      onFill={(name, value) => void fillField(name, value)}
                    />
                  ) : (
                    <RedactionDock
                      t={t}
                      marks={redactionMarks}
                      canEdit={canEdit}
                      removeTargets={removeTargets}
                      onApply={() => openDialog('redact')}
                    />
                  )}
                </Dock>
              </div>
            ) : null}
            <ReadingLayers
              t={t}
              locale={locale}
              viewer={viewer}
              viewerRef={viewerRef}
              pageNumber={currentPage}
            />
            <PrintDialogHost t={t} viewer={viewer} onProduced={resultsActions.printProduced} />
          </div>
        )}
        {/*
            Mounted outside the home/editor split: the batch dialog starts from files on disk, so it
            has to open with no document too. Mounted only while it is open: a static import here is what put Kumo's
            dialog primitives on the first-paint graph, and a `lazy` boundary that is
            mounted unconditionally still fetches immediately. The `open` prop stays
            as it was, so the dialog's own open/close contract is unchanged.
          */}
        <StartDialogHost t={t} onResult={startResult} />
        <ScanDialogHost t={t} onDocument={resultsActions.scanDocument} />
        <BatchDialogHost t={t} />
        <ActivityOverlay
          t={t}
          notice={notice}
          onDismiss={clearNotice}
          progress={progress}
          onCancel={cancelOperation}
          activity={opening ? t('open.progress') : null}
        />
      </main>
      <StatusBar
        t={t}
        pageIndex={activeHandle === null ? null : currentPage}
        pageCount={activeTab === null ? null : pageCount}
        zoom={zoom}
        tier={tier}
        limits={verdict}
        signatures={documentFacts?.signatures ?? []}
        memoryUsage={memoryUsage}
        sensitive={activeTab?.sensitive ?? false}
        navigation={
          isHome || activeTab === null ? undefined : (
            <PageNavigation
              t={t}
              currentPage={currentPage}
              pageCount={pageCount}
              onGoToPage={(pageIndex) => viewerRef.current?.goToPage(pageIndex)}
              zoom={zoom}
              onZoomChange={(next) => viewerRef.current?.setZoom(next)}
              {...(canEdit ? { onRotate: () => runPageAction({ kind: 'rotate', direction: 'right' }) } : {})}
              onToggleFullscreen={() => presentation.toggle()}
            />
          )
        }
      />
      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDialog
            t={t}
            onClose={() => setSettingsOpen(false)}
            mode={mode}
            onModeChange={changeMode}
            sensitive={activeTab === null ? null : activeTab.sensitive}
            onToggleSensitive={toggleSensitiveSession}
            onSaveDraft={() => void opfsSave()}
            onPurgeDocument={() => void purgeActiveDocument()}
            onSweepVault={() => void sweepVault()}
            onPrepareOffline={() => void prepareOfflinePackages()}
            onCheckOffline={() => void checkOffline()}
            onShowShortcuts={() => {
              setSettingsOpen(false);
              showShortcuts();
            }}
          />
        </Suspense>
      ) : null}
      <PasswordPromptHost
        t={t}
        onSubmit={(file, handle, password) => void openFile(file, handle, password)}
      />
      <ShortcutsDialogHost t={t} onClose={closeShortcuts} />
      {/* Same boundary as the print dialog: the palette mounts when it opens, so its
          Kumo dependency tree never reaches the entry chunk. */}
      {paletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette
            t={t}
            commands={mode === 'simple' ? visibleCommands(commands, 'simple') : commands}
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            onRun={(command) => {
              setPaletteOpen(false);
              command.run();
            }}
            hiddenByMode={
              mode === 'simple' ? commands.length - visibleCommands(commands, 'simple').length : 0
            }
            onUseAdvanced={useAdvancedMode}
          />
        </Suspense>
      ) : null}
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
