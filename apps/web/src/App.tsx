import type { AnnotationMark } from 'pdf-core';
import { openWithPdfjs, type PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
// The annotation and form ops are imported by **module**, not through the
// package barrel: a barrel re-export keeps every operation module in the graph the
// entry chunk is built from (measured: 160 kB of op code in the first paint),
// and the engine chunk it pulls in is what the ≤250 KiB budget is there to keep
// out.
import { readAnnotations } from 'pdf-core/ops/annotations';
import {
  CONVERT_ACCEPT,
  CONVERT_PICKER_ACCEPT,
  convertFormatOf,
  formatLabel,
  isImageName,
  pdfNameFor,
  unsupportedDocumentKind,
} from 'pdf-core/ops/convert-formats';
import { fieldValueText } from 'pdf-core/ops/form-value';
import type { ProtectionState } from 'pdf-core/ops/security';
import {
  type JsonValue,
  type SessionStore,
  type SessionTab,
  sha256Hex,
  sourceKeyFor,
  workingPageCount,
} from 'pdf-model';
import { checkDocumentLimits, createTranslator, detectDeviceTier, ToolError } from 'pdf-shared';
import { lazy, Suspense } from 'react';

/**
 * The signature prompt rides the same boundary as the capability dialogs: it is needed
 * once per save of a signed document, and the first paint must not carry it.
 */
const CloseDocumentDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.CloseDocumentDialog };
});
const SettingsDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.SettingsDialog };
});
const PasswordDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.PasswordDialog };
});

import { CaretLeft, CaretRight, Command, FilePdf, FolderOpen, GearSix } from '@phosphor-icons/react';
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
import { PdfViewerPane, type ViewerApi } from 'pdf-ui/viewer';
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
  heldEngineValues,
  holdEngineValues,
  orphanSweepInFlight,
  releaseEngineValues,
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
  coreStore,
  hideLeftDock,
  hideRightDock,
  isBusy,
  openLeftPanel,
  openRightPanel,
  selectLeftTab,
  selectRightTab,
  selectShape,
  selectTool,
  setBusy,
  setInterfaceMode,
  showLeftDock,
  showNotice,
  showNoticeIfEmpty,
  showRightDock,
  toggleLeftDock,
  toggleRightDock,
  useCore,
} from './features/core/core-store';
import {
  adoptHandle,
  dropHandle,
  handleFor,
  handleInUse,
  handleReleased,
  replaceHandle,
  useDocumentHandle,
} from './features/core/handles';
import { useCompactViewport } from './features/core/viewport';
import { BatchDialogHost, ShortcutsDialogHost, StartDialogHost } from './features/dialogs/DialogSurfaces';
import { createDialogOpeners, createDialogRuns } from './features/dialogs/dialog-actions';
import {
  dialogsStore,
  dismissOperationDialog,
  openBatchDialog,
  useDialogs,
} from './features/dialogs/dialogs-store';
import { useStaleDialogDismissal } from './features/dialogs/use-dialog-dismissal';
import { ContextMenuHost, ExportDialogHost } from './features/export/ExportSurfaces';
import { createCurrentBytes, createExportChoice, showContextMenu } from './features/export/export-actions';
import { openExportDialog } from './features/export/export-store';
import { currentFacts, currentFactsError, useCurrentFacts } from './features/facts/facts-store';
import { PropertiesFacts } from './features/facts/PropertiesFacts';
import { RedactionAuditView } from './features/facts/RedactionAuditView';
import { SignatureWarningPrompt } from './features/facts/SignatureWarningPrompt';
import { confirmSignature, useSignaturePending } from './features/facts/signature-prompt';
import { trustStore, useStoredTrust } from './features/facts/trust-store';
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
  existingInventoryRead,
  existingInventoryUnknown,
  retryInspection,
  useCurrentForms,
  useExistingAnnotations,
  useForms,
} from './features/forms/forms-store';
import { useFormInventory } from './features/forms/use-form-inventory';
import { useMarkTargets } from './features/marks/mark-targets';
import { currentMarkTargets } from './features/marks/marks-store';
import { editableOverlays, useVisibleMarks } from './features/marks/overlays';
import { RedactionDock, RedactionMarkLayer } from './features/marks/RedactionSurfaces';
import {
  refuseUnappliedRedactions as refuseUnappliedRedactionsFor,
  useRedactionMarks,
} from './features/marks/redaction';
import { erasedWordsOf, redactedWordsForgotten } from './features/marks/redaction-store';
import { useMarkActions, useWriterActions } from './features/marks/use-mark-actions';
import { MeasureOverlay } from './features/measure/MeasureOverlay';
import { MeasureSettingsStrip } from './features/measure/MeasureSettingsStrip';
import { armMeasure, useMeasureMode } from './features/measure/measure-store';
import { usePageActions } from './features/pages/page-actions';
import { persistDraft, saveDraft } from './features/persistence/draft-persist';
import { forgetDraft } from './features/persistence/draft-vault';
import { draftStorage, draftWrites } from './features/persistence/persistence-store';
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
import { ImagePickerInput, SignatureDialogHost, StampPlacementHost } from './features/stamps/StampSurface';
import {
  openSignature as openSignatureFor,
  pickImage as pickImageFor,
  placeStamp as stampPlace,
  resizeStamp as stampResize,
} from './features/stamps/stamp-actions';
import { convertToPdf, imagesToPdf, inspectProtection, verifySignatures } from './lazy-ops';
import {
  appendWarning,
  engineValuesNotices,
  failureNotices,
  noticeLine,
  storedCopyWarning,
  verificationNotices,
} from './notices';
import {
  type DocumentContext,
  downloadFiles,
  hasEngineEdits,
  materializeBase,
  type PageAction,
  pendingOverlays,
  verifyForWrite,
  type WriteVerification,
} from './operations';
import { addRecentDocument } from './recent';
import { ensureWriteAccess, getRecentHandle, putRecentHandle, reopenFromHandle } from './recent-handles';
import {
  appliedVersionBytes,
  signatureWarning as decideSignatureWarning,
  planSaveExecution,
  type SaveExecutionPlan,
  type SaveStepDescription,
} from './save-plan';
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
/**
 * The text tool's overlay — it reads the page's structured text and parses the font
 * metric tables, so it arrives with the tool.
 */
const TextLayer = lazy(async () => {
  const module = await import('pdf-ui/text-edit');
  return { default: module.TextLayer };
});

/**
 * Open a document with the engine and fingerprint its bytes, side by side — the two only
 * read the bytes, so neither waits for the other. `Promise.all` would reject on the first
 * failure and abandon the other half: a fingerprint that fails after the engine opened the
 * document left that handle (a pdf.js worker and its parsed document) alive with no owner.
 * Both halves are awaited here, a handle the other half's failure made useless is destroyed,
 * and the error thrown is the engine's when it failed (a password request is its answer), else
 * the fingerprint's.
 */
async function openAndFingerprint(
  opening: Promise<PdfDocumentHandle>,
  fingerprinting: Promise<string>,
): Promise<readonly [PdfDocumentHandle, string]> {
  const [opened, fingerprint] = await Promise.allSettled([opening, fingerprinting]);
  if (opened.status === 'fulfilled' && fingerprint.status === 'fulfilled') {
    return [opened.value, fingerprint.value];
  }
  if (opened.status === 'fulfilled') await opened.value.destroy().catch(() => undefined);
  throw opened.status === 'rejected' ? opened.reason : (fingerprint as PromiseRejectedResult).reason;
}

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
  const saveLock = useRef(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const viewerApi = useRef<ViewerApi | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  const [zoom, setZoomState] = useState(1);
  const [currentPage, setCurrentPage] = useState(0);
  const notice = useCore((state) => state.notice);
  const busy = useCore((state) => state.busy);
  /**
   * A gesture the synchronous gate refuses says so. The gate itself stays
   * synchronous — this only speaks when it closes, because an inert control and a
   * refused action must not look the same.
   */
  const refuseBusy = useCallback(() => showNotice(t('op.busy')), [t]);
  const [closeRequest, setCloseRequest] = useState<string | null>(null);
  const closeTrigger = useRef<HTMLElement | null>(null);
  const reading = useReading((state) => state.reading);
  const magnifierOn = useReading((state) => state.magnifierOn);
  /** Surface state: dialogs, palette, docks, page selection, progress, tools. */
  const dialogSpec = useDialogs((state) => state.dialogSpec);
  const dialogInput = useDialogs((state) => state.dialogInput);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Language, theme, interface mode, privacy and offline preferences — one dialog. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showHomeScreen, setShowHomeScreen] = useState(true);
  /**
   * The command a home-screen tool promised to run once its document is open: the tool was
   * picked first and the file asked for after, so the command waits for the tab.
   */
  const pendingHomeCommand = useRef<string | null>(null);
  /** A file is being read and parsed: the overlay says so until its tab exists. */
  const [opening, setOpening] = useState(false);
  /**
   * A protected file waiting for its open password, and whether the last one was refused.
   * The file (and its handle, for save-in-place) is kept so the retry opens the same one.
   */
  const [passwordPrompt, setPasswordPrompt] = useState<{
    readonly file: File;
    readonly handle?: FileSystemFileHandle;
    readonly incorrect: boolean;
  } | null>(null);
  /**
   * Tabs opened with a password, and that password — **in memory only**, never in a
   * draft. Such a tab is read-only: every writer re-opens the bytes it edits, and a
   * protected file cannot be rewritten without dropping or re-applying its protection,
   * a decision the user makes explicitly with "create unlocked copy".
   */
  const [lockedTabs, setLockedTabs] = useState<ReadonlyMap<string, string>>(() => new Map());
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
  /** A stamp just written: selected as soon as the re-read inventory lists it. */
  const selectAfterWrite = useRef<string | null>(null);
  const shape = useCore((state) => state.shape);
  /**
   * The common layer's selection: target keys across all four mark families, in the
   * one identity space `annotation-interaction.ts` builds. Nothing else may hold a
   * "selected mark" — the single-id state this replaces mixed session mark ids,
   * engine storage keys and pdf.js annotation ids in one string.
   */
  const [selectedKeys, setSelectedKeys] = useState<readonly string[]>([]);
  const selectedKeysRef = useRef<readonly string[]>(selectedKeys);
  selectedKeysRef.current = selectedKeys;
  const compactViewport = useCore((state) => state.compactViewport);
  const leftDock = useCore((state) => state.leftDock);
  const rightDock = useCore((state) => state.rightDock);
  useCompactViewport();
  const rightTab = useCore((state) => state.rightTab);
  const [selectedPages, setSelectedPages] = useState<readonly number[]>([]);
  const progress = useResults((state) => state.progress);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /**
   * The redaction and text tools are **derived** from `canvasTool`, never stored:
   * `canvasTool === 'redact'` means the redaction layer owns the pointer, and
   * `canvasTool === 'text'` mounts the block overlay whose selection travels to the
   * dialog in the run context.
   */
  const [textEdit, setTextEdit] = useState<NonNullable<OperationRunContext['textEdit']> | null>(null);
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
  /**
   * The working bytes the text tool reads the page model from. Materialised when the
   * tool is armed rather than on every render: `materializeBase` runs the engine's own
   * deltas, which is real work, and the model must describe the document as it is at
   * the moment the user points at a paragraph.
   */
  const [textToolBytes, setTextToolBytes] = useState<Uint8Array | null>(null);
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
   * The tools slices need a render when the viewer API arrives, and a ref does not
   * re-render — so the API is mirrored into state while the shortcut layer keeps
   * reading the ref (same object, two access patterns).
   */
  const [viewer, setViewer] = useState<ViewerApi | null>(null);
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
  const textTool = canvasTool === 'text';
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
  const signaturePending = useSignaturePending();

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

  const openFile = useCallback(
    async (file: File, fileHandle?: FileSystemFileHandle, password?: string) => {
      clearNotice();
      if (isBusy()) {
        // A tool picked on the home screen waits for this document; an open refused never
        // brings it, so the tool must not run on whatever is opened next.
        pendingHomeCommand.current = null;
        refuseBusy();
        return;
      }
      const earlyVerdict = checkDocumentLimits(tier, 0, file.size);
      setBusy(true);
      setOpening(true);
      try {
        /**
         * The size gate runs **inside** the guarded block. Thrown before it, the
         * error escaped the function itself: the drop zone, the home screen and the file
         * input all call this fire-and-forget, so an oversized file produced no notice at
         * all — the one failure the limit exists to explain.
         */
        if (earlyVerdict.kind === 'blocked') {
          throw new ToolError('file-too-large', { engine: 'model' });
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        // The fingerprint is independent of the open and only reads the bytes, so it
        // runs alongside the engine instead of after it: on a 130 MB document that is
        // a few hundred milliseconds off the path the user waits on.
        const [handle, sha256] = await openAndFingerprint(
          openWithPdfjs(bytes, password === undefined ? {} : { password }),
          sha256Hex(bytes),
        );
        const fileVerdict = checkDocumentLimits(tier, handle.pageCount, bytes.byteLength);
        if (fileVerdict.kind === 'blocked') {
          await handle.destroy();
          throw new ToolError(fileVerdict.reason === 'pages' ? 'page-limit' : 'file-too-large', {
            engine: 'model',
            ...(fileVerdict.reason === 'pages' ? { path: file.name } : {}),
          });
        }
        // Read before the tab exists: it only needs the engine handle, and a rejection here
        // is an open failure with nothing registered — the handle is released like the
        // limit-blocked one above, and the original error is the one reported.
        let encrypted: boolean;
        try {
          encrypted = (await handle.raw.getPermissions()) !== null;
        } catch (error) {
          await handle.destroy().catch(() => undefined);
          throw error;
        }
        const tab = store.openDocument({
          name: file.name,
          bytes,
          sha256,
          pageCount: handle.pageCount,
          ...(fileHandle === undefined ? {} : { handle: fileHandle }),
        });
        adoptHandle(tab.id, handle);
        if (password !== undefined) {
          setLockedTabs((current) => new Map(current).set(tab.id, password));
          showNotice(t('locked.banner'));
        }
        addRecentDocument({
          id: tab.id,
          name: file.name,
          sizeBytes: file.size,
          pageCount: handle.pageCount,
        });
        setShowHomeScreen(false);
        let storageWarning: string | null = null;
        if (encrypted) store.setSensitive(tab.id, true);
        else {
          // The tab is registered: keeping a recovery copy is not part of opening. A write
          // that fails (storage full, OPFS unavailable) costs the copy, never the
          // document, and is reported as exactly that — not as an open failure below.
          try {
            await draftStorage().putSource(sourceKeyFor(tab.id, sha256), bytes);
            // A reference to the file, never its bytes; a sensitive session keeps none.
            if (fileHandle !== undefined) await putRecentHandle(tab.id, fileHandle);
          } catch (error) {
            storageWarning = storedCopyWarning(error, t);
          }
        }
        setCurrentPage(0);
        // No zoom reset here: the viewer reports the scale it draws the new document at
        // (fit width), and a reset after the awaits above would overwrite that report.
        setSelectedPages([]);
        setRedactionMarks([]);
        const limitNotice =
          fileVerdict.kind === 'warn'
            ? t('limit.warn.pages')
            : fileVerdict.kind === 'viewing-only'
              ? t(fileVerdict.reason === 'pages' ? 'limit.viewingOnly.pages' : 'limit.viewingOnly.bytes')
              : null;
        // One notice line: the limit and the storage warning say different things and both stay.
        if (limitNotice !== null) showNotice(appendWarning(limitNotice, storageWarning));
        else if (storageWarning !== null) showNotice(storageWarning);
      } catch (error) {
        const toolError =
          error instanceof ToolError ? error : new ToolError('corrupt-document', { engine: 'model' });
        // A protected file is a question, not a failure: ask for the password and open
        // the same file again with it.
        if (toolError.code === 'password-required' || toolError.code === 'wrong-password') {
          setPasswordPrompt({
            file,
            ...(fileHandle === undefined ? {} : { handle: fileHandle }),
            incorrect: toolError.code === 'wrong-password',
          });
          return;
        }
        pendingHomeCommand.current = null;
        showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        setOpening(false);
        setBusy(false);
      }
    },
    [store, t, tier, setRedactionMarks, refuseBusy],
  );

  /**
   * The fire-and-forget way in.
   *
   * Four surfaces open a file — the picker, the drop zone, the home screen and the
   * hidden input — and three of them have no promise to await, so `void openFile(...)`
   * there left a rejection with nowhere to go: the browser's unhandled-rejection report
   * is not a notice, and the user saw a document that simply did not open. One wrapper
   * for the four, so the handling cannot be forgotten at one of them.
   */
  const openFromSurface = useCallback(
    async (file: File, handle?: FileSystemFileHandle): Promise<void> => {
      try {
        // A Word, Excel, HTML or text file is not refused: it is converted, and the PDF
        // opens in its own tab (`pdf-core/ops/convert.ts`). A `.pdf` always opens as one.
        if (!file.name.toLowerCase().endsWith('.pdf')) {
          if (convertFormatOf(file.name) !== null || isImageName(file.name)) {
            await convertAndOpenRef.current(file);
            return;
          }
          const kind = unsupportedDocumentKind(file.name);
          if (kind !== null) {
            // No document comes of this file, so a tool picked for it is dropped.
            pendingHomeCommand.current = null;
            showNotice(t('convert.unsupported', { kind }));
            return;
          }
        }
        await openFile(file, handle);
      } catch (error) {
        pendingHomeCommand.current = null;
        showNotice(noticeLine(failureNotices(error, 'error.corrupt-document.message'), t));
      }
    },
    [openFile, t],
  );

  /**
   * Several files at once (a drop, a multi-file pick on the home screen): each opens in its
   * own tab, one after the other, because an open holds the busy gate until it settles.
   */
  const openFilesFromSurface = useCallback(
    async (
      files: readonly File[],
      fileHandles: readonly (FileSystemFileHandle | null)[] = [],
    ): Promise<void> => {
      for (const file of files) {
        // Paired by name, not position: the drop's item list and file list are separate.
        const handle = fileHandles.find((item) => item?.name === file.name) ?? undefined;
        await openFromSurface(file, handle);
      }
    },
    [openFromSurface],
  );

  /**
   * Open with the File System Access picker when it exists: the returned
   * handle is what makes in-place **Save** possible later. Without it the shell
   * keeps its file-input path and Save stays disabled in favour of Export — the
   * browser-matrix contract, not a defect.
   */
  const openViaPicker = useCallback(async () => {
    if (typeof showOpenFilePicker !== 'function') {
      fileInput.current?.click();
      return;
    }
    let picked: FileSystemFileHandle | undefined;
    try {
      [picked] = await showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          { description: t('open.pdfFilter'), accept: { 'application/pdf': ['.pdf'] } },
          {
            description: t('open.anyFilter'),
            accept: { 'application/pdf': ['.pdf'], ...CONVERT_PICKER_ACCEPT },
          },
        ],
      });
    } catch (error) {
      // A cancelled picker is a user decision, not an error worth a banner — and only a
      // *picker* failure gets the picker's sentence: an open that failed has its own
      // message and hint, which `openFromSurface` reports.
      if (error instanceof DOMException && error.name === 'AbortError') {
        // A tool picked first must not run on whatever document is opened later.
        pendingHomeCommand.current = null;
        return;
      }
      pendingHomeCommand.current = null;
      showNotice(t('open.pickerFailed'));
      return;
    }
    if (picked === undefined) return;
    const file = await picked.getFile();
    await openFromSurface(file, picked);
  }, [openFromSurface, t]);

  /**
   * Open produced bytes as a new tab (extract, split, unlock, image→PDF results).
   *
   * It settles once the tab is registered, and a rejection means *no* tab was opened. Storing
   * the recovery copy comes after that and is not part of opening: when it fails the tab
   * stays and the resolved value is the warning sentence for the caller to put on its notice
   * line (`null` when the copy is stored). The caller owns the notice because it sets its own
   * success line right after, and the shell has one line: a warning set here would be
   * replaced by that line.
   */
  const openProducedTab = useCallback(
    async (name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string | null> => {
      const earlyVerdict = checkDocumentLimits(tier, 0, bytes.byteLength);
      if (earlyVerdict.kind === 'blocked') {
        throw new ToolError('file-too-large', { engine: 'model' });
      }
      const [handle, sha256] = await openAndFingerprint(openWithPdfjs(bytes), sha256Hex(bytes));
      /**
       * Opening is the transition, so a cancelled caller — the tab it came from
       * was closed while the dialog's result was opening — must not leave an
       * orphan tab behind: the handle is destroyed and nothing is registered.
       */
      if (signal?.aborted === true) {
        await handle.destroy();
        throw new ToolError('aborted', { engine: 'model' });
      }
      const fileVerdict = checkDocumentLimits(tier, handle.pageCount, bytes.byteLength);
      if (fileVerdict.kind === 'blocked') {
        await handle.destroy();
        throw new ToolError(fileVerdict.reason === 'pages' ? 'page-limit' : 'file-too-large', {
          engine: 'model',
          ...(fileVerdict.reason === 'pages' ? { path: name } : {}),
        });
      }
      const tab = store.openDocument({ name, bytes, sha256, pageCount: handle.pageCount });
      adoptHandle(tab.id, handle);
      addRecentDocument({
        id: tab.id,
        name,
        sizeBytes: bytes.byteLength,
        pageCount: handle.pageCount,
      });
      setShowHomeScreen(false);
      let warning: string | null = null;
      try {
        await draftStorage().putSource(sourceKeyFor(tab.id, sha256), bytes);
      } catch (error) {
        warning = storedCopyWarning(error, t);
      }
      setCurrentPage(0);
      return warning;
    },
    [store, t, tier],
  );

  /**
   * A document in another format, opened: converted in this tab with the defaults (the
   * locale's paper, portrait — a spreadsheet landscape — and a 15 mm margin), then opened
   * as a new PDF tab. A picture is placed on a page of the same paper, as "Images to PDF"
   * would. The conversion's own notes say what it approximated; the File menu's
   * "Convert to PDF" offers the same conversion with every option.
   */
  const convertAndOpen = useCallback(
    async (file: File): Promise<void> => {
      const format = convertFormatOf(file.name);
      if (format === null && !isImageName(file.name)) return;
      clearNotice();
      if (isBusy() || cancelRef.current !== null) {
        pendingHomeCommand.current = null;
        refuseBusy();
        return;
      }
      const controller = new AbortController();
      cancelRef.current = controller;
      setBusy(true);
      setOpening(true);
      try {
        const letter = /^en-(?:US|CA)\b/i.test(navigator.language);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (format === null) {
          // A picture becomes a page the way "Images to PDF" makes one: on the paper,
          // contained, its EXIF turn applied.
          const pictures = await imagesToPdf(
            {
              images: [{ name: file.name, bytes }],
              pageSize: letter ? 'letter' : 'a4',
              fit: 'contain',
              marginMm: 0,
              applyExif: true,
            },
            { signal: controller.signal },
          );
          const warning = await openProducedTab(pdfNameFor(file.name), pictures.bytes, controller.signal);
          showNotice(appendWarning(t('convert.imageOpened'), warning));
          return;
        }
        const outcome = await convertToPdf(
          {
            name: file.name,
            bytes,
            pageSize: letter ? 'letter' : 'a4',
            orientation: format === 'xlsx' || format === 'csv' || format === 'tsv' ? 'landscape' : 'portrait',
            marginMm: 15,
          },
          { signal: controller.signal },
        );
        const warning = await openProducedTab(pdfNameFor(file.name), outcome.bytes, controller.signal);
        const caveats = outcome.report.notes
          .filter((item) => item.key !== 'op.note.convert.done')
          .map((item) => t(item.key, item.params));
        showNotice(
          appendWarning(
            [t('convert.opened', { format: formatLabel(format) }), ...caveats].join(' '),
            warning,
          ),
        );
      } catch (error) {
        pendingHomeCommand.current = null;
        if (controller.signal.aborted) return;
        showNotice(noticeLine(failureNotices(error, 'error.unsupported-format.message'), t));
      } finally {
        setOpening(false);
        if (cancelRef.current === controller) {
          cancelRef.current = null;
          setBusy(false);
        }
      }
    },
    [openProducedTab, refuseBusy, t],
  );
  const convertAndOpenRef = useRef(convertAndOpen);
  convertAndOpenRef.current = convertAndOpen;

  /**
   * The annotation handlers: the review as a file, the engine's editor takeover, native
   * editors and the orphan sweep (`features/annotations/`). What the shell still owns is
   * handed in: the viewer's API, the running operation's controller, and the way a tab becomes
   * an operation context.
   */
  const annotationActions = useAnnotationActions({
    session: store,
    t,
    viewer: viewerApi,
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
    async (
      tabId: string,
      controller: AbortController,
      executedSteps: SaveStepDescription[] = [],
    ): Promise<{
      tab: SessionTab;
      handle: PdfDocumentHandle;
      bytes: Uint8Array;
      outputProtection: ProtectionState;
      execution: SaveExecutionPlan;
      outputHash: string;
      verification: WriteVerification;
    } | null> => {
      const tab = store.getSnapshot().tabs.find((item) => item.id === tabId) ?? null;
      const handle = tab === null ? null : (handleFor(tab.id) ?? null);
      if (tab === null || handle === null) return null;

      if (
        currentFacts(tab) === null ||
        currentForms?.tabId !== tab.id ||
        currentForms.version !== tab.working.id ||
        formFields === null
      ) {
        showNotice(
          t(
            currentFactsError(tab) !== null || currentForms?.error
              ? 'inspection.failed'
              : 'inspection.loading',
          ),
        );
        return null;
      }

      /**
       * Redaction marks are **not** applied by materialization: they are intents the user
       * has staged, and the destructive step is theirs to run. Refusing here is the whole
       * point — the alternative is a Save that marks the tab clean while the delivered file
       * still contains the content the user asked to remove. This is deliberately
       * not automatic redaction; the user applies or clears the marks.
       */
      if (pendingOverlays(tab).redactions.length > 0) {
        showNotice(`${t('error.pending-redactions.message')} ${t('error.pending-redactions.hint')}`);
        return null;
      }

      const base = await materializeBase(
        contextFor(tab, handle),
        { signal: controller.signal },
        executedSteps,
        editableOverlays(tab),
      );
      const outputProtection = await inspectProtection(base);

      const execution = planSaveExecution({
        tab,
        engineDirty: hasEngineEdits(handle),
        annotations: editableOverlays(tab).annotations,
        baseBytes: base,
        encryptedOutput: outputProtection.encrypted,
        executedSteps,
      });

      // The opened file and the produced version are each judged against their own
      // bytes (`signatureWarning`): an edit that already broke the opened file's
      // signature is still announced, and a just-signed export is not.
      const warning = await decideSignatureWarning(
        base,
        tab.source.master,
        tab.working.produced?.bytes ?? null,
        (bytes) => verifySignatures(bytes, controller.signal, { roots: trustStore.get().rootBytes }),
        appliedVersionBytes(tab, store.snapshotsFor(tab.id)),
      );
      if (warning !== null && !(await confirmSignature(warning.signatures, warning.fate === 'appended', t))) {
        return null;
      }

      if (
        controller.signal.aborted ||
        store.getSnapshot().tabs.find((item) => item.id === tab.id)?.working.id !== tab.working.id
      ) {
        return null;
      }

      /**
       * The run's **own** steps identify the operation: the historical steps are
       * already inside the live handle these bytes are compared against, so declaring
       * them again would only weaken the promise the check makes. What the run itself
       * materialised — engine values, annotations, measurements — is exactly the delta
       * verification has to allow for.
       */
      const verification = await verifyForWrite(base, {
        expectedPageCount: workingPageCount(tab),
        sourceHandle: handle,
        steps: executedSteps.map((step) => step.id),
        expectedFormFields: formFields.map((field) => ({
          name: field.name,
          value: fieldValueText(field.value),
        })),
        signal: controller.signal,
      });

      const outputHash = await sha256Hex(base);
      return {
        tab,
        handle,
        bytes: base,
        outputProtection,
        execution,
        outputHash,
        verification,
      };
    },
    [contextFor, currentForms, formFields, store, t],
  );

  const saveActive = useCallback(
    async (tabId = store.active?.id): Promise<boolean> => {
      const tab = store.getSnapshot().tabs.find((item) => item.id === tabId) ?? null;
      if (tab === null) return false;
      if (saveLock.current || isBusy()) {
        refuseBusy();
        return false;
      }

      /**
       * Ownership is taken **before** anything can await. `showSaveFilePicker` is a
       * promise the user can leave open for minutes, and a second Save (a shortcut, a
       * second click) that starts while it is open would run a second preparation and a
       * second write against the same document — two commits, one of them for bytes the
       * other already replaced. The `finally` below releases it on every path,
       * including cancellation.
       */
      const controller = new AbortController();
      cancelRef.current = controller;
      saveLock.current = true;
      clearNotice();
      setBusy(true);
      try {
        let target = tab.source.handle;
        // A handle read back from IndexedDB (a restored draft, a reopened recent entry) has
        // no write access until the user grants it: asked here, the first await of the click.
        if (target !== undefined && !(await ensureWriteAccess(target))) {
          throw new ToolError('permission-denied', { engine: 'model' });
        }
        if (target === undefined && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
          try {
            const suggestedName = tab.name.toLowerCase().endsWith('.pdf') ? tab.name : `${tab.name}.pdf`;
            target = await (
              window as unknown as {
                showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
              }
            ).showSaveFilePicker({
              suggestedName,
              types: [{ description: t('open.pdfFilter'), accept: { 'application/pdf': ['.pdf'] } }],
            });
          } catch (error) {
            if ((error as Error).name === 'AbortError') return false;
            // continue with target = undefined for direct download fallback
          }
        }

        /**
         * The conflict baseline belongs to the file that is about to be written, not to
         * the document that was opened. A newly picked destination is normally empty, and
         * another file the user chose explicitly is theirs to overwrite — comparing either
         * against the *source* hash rejected every Save As that was not a re-save of the
         * original. The in-place path keeps the original/last-written protection.
         */
        const targetIsSource = target !== undefined && target === tab.source.handle;
        const expected = targetIsSource
          ? (tab.outputs.at(-1)?.writtenTo?.sha256 ?? tab.source.sha256)
          : target === undefined
            ? null
            : await sha256Hex(new Uint8Array(await (await target.getFile()).arrayBuffer()));

        const executedSteps: SaveStepDescription[] = [];
        const prepared = await prepareOutput(tab.id, controller, executedSteps);
        if (prepared === null) return false;

        const { tab: preparedTab, bytes, outputProtection, execution, outputHash, verification } = prepared;

        if (target !== undefined) {
          if (expected !== null) {
            const actual = new Uint8Array(await (await target.getFile()).arrayBuffer());
            if ((await sha256Hex(actual)) !== expected) throw new ToolError('conflict', { engine: 'model' });
          }

          if (controller.signal.aborted) return false;
          const writable = await target.createWritable();
          try {
            if (controller.signal.aborted) throw new ToolError('aborted', { engine: 'model' });
            await writable.write(bytes as unknown as FileSystemWriteChunkType);
            if (controller.signal.aborted) throw new ToolError('aborted', { engine: 'model' });
            await writable.close();
          } catch (error) {
            await writable.abort().catch(() => undefined);
            throw error;
          }
          // Only now is this handle the document's own file: attaching it before the write
          // succeeded would make the next Save write in place over a file this one never
          // managed to commit.
          store.setHandle(preparedTab.id, target);
        } else {
          // Direct download fallback when File System Access is not available
          const fileName = tab.name.toLowerCase().endsWith('.pdf') ? tab.name : `${tab.name}.pdf`;
          downloadFiles([{ name: fileName, bytes, mime: 'application/pdf' }]);
        }

        store.addOutput(preparedTab.id, {
          id: crypto.randomUUID(),
          // The version the *preparation* produced, not the one captured before the
          // picker: an edit made while the picker was open must not be recorded as saved.
          fromWorkingVersion: preparedTab.working.id,
          fromState: preparedTab.working.stateId,
          encrypted: outputProtection.encrypted,
          steps: execution.steps.map((step) => `${step.engine}:${step.id}`),
          appliedSteps: execution.appliedSteps.map((step) => `${step.engine}:${step.id}`),
          incremental: execution.plan.incremental,
          // The fact table itself, not a summary of it: the notice below says
          // what the save established, and the output keeps the record a later surface
          // can read back.
          verification,
          writtenTo: { fileName: preparedTab.name, savedAt: Date.now(), sha256: outputHash },
        });
        showNotice(
          noticeLine(
            [{ key: 'save.done', params: { name: preparedTab.name } }, ...verificationNotices(verification)],
            t,
          ),
        );
        return true;
      } catch (error) {
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
        return false;
      } finally {
        if (cancelRef.current === controller) cancelRef.current = null;
        saveLock.current = false;
        setBusy(false);
      }
    },
    [prepareOutput, refuseBusy, store, t],
  );

  const discardTab = useCallback(
    (id: string) => {
      if (store.active?.id === id) cancelRef.current?.abort();
      const abandoned = dropHandle(id);
      if (abandoned !== undefined) {
        // Closing a tab is not a place where a failure may be swallowed, and it
        // is not a place where one may be thrown at the user either: the document is
        // gone from the session, so the release is reported and the close proceeds.
        void abandoned.destroy().catch(() => showNotice(tRef.current('notice.engineReleaseFailed')));
      }
      store.closeTab(id);
      releaseEngineValues(id);
      redactedWordsForgotten(id);
      draftWrites.current = draftWrites.current
        .then(async () => {
          // The reference graph is read fresh and *whole*: the previous version derived it
          // from `readDrafts()`, which reports an unreadable or unlistable vault as “no
          // drafts” — the exact input that makes a shared source blob look unreferenced.
          // An incomplete inventory deletes nothing and says so.
          const removed = await forgetTabDraft(id);
          if (removed === null) showNotice(tRef.current('vault.incomplete'));
        })
        .catch(() => showNotice(tRef.current('error.write-failed.message')));
    },
    [store, forgetTabDraft],
  );

  const closeTab = useCallback(
    (id: string) => {
      if (isBusy() || cancelRef.current !== null || dialogsStore.get().dialogSpec !== null) {
        refuseBusy();
        return;
      }
      const tab = store.getSnapshot().tabs.find((item) => item.id === id);
      if (tab === undefined) return;
      const handle = handleFor(id);
      if (tab.dirty || (handle !== undefined && hasEngineEdits(handle))) {
        closeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        store.setActive(id);
        clearNotice();
        setCloseRequest(id);
        return;
      }
      discardTab(id);
    },
    [discardTab, refuseBusy, store],
  );

  const cancelClose = useCallback(() => {
    setCloseRequest(null);
    requestAnimationFrame(() => {
      const target = closeTrigger.current;
      if (target?.isConnected) target.focus();
      else
        document.querySelector<HTMLElement>('[data-document-tab][aria-current="true"], main button')?.focus();
    });
  }, []);

  // The viewer hands back its imperative API once per document; keep the callback
  // identity stable so the viewer is not torn down on every render.
  /**
   * Marks the engine's own annotation editor produced are taken over here.
   *
   * The engine holds them in its storage, where the next `saveDocument()` would
   * write them. The app needs them in its own list first — the journal, the comment
   * panel and the retag step all read that list — so each captured entry becomes a
   * mark and its storage entry is removed. Leaving it would make the same
   * annotation arrive twice: once from the storage and once from the writer.
   */
  const handleViewerReady = useCallback(
    (api: ViewerApi | null) => {
      viewerApi.current = api;
      setViewer(api);
      if (api === null) {
        existingInventoryUnknown();
        return;
      }
      handleInUse(api.document);
      setZoomState(api.getZoom());
      takeEngineAnnotations(api);
      // Every annotation the file already carries, listed once per document so the
      // comment panel can show the document's own notes beside the new marks.
      const controller = new AbortController();
      const tab = store.active;
      const bytesKey = tab === null ? null : (tab.working.produced?.id ?? 'source');
      void readAnnotations(api.document, { signal: controller.signal })
        .then((found) => {
          // Keyed to the bytes the read describes: a read that lands after a byte
          // operation replaced that version describes a document nobody is looking at,
          // and it is dropped rather than shown.
          if (viewerApi.current !== api || tab === null || bytesKey === null) return;
          existingInventoryRead({ tabId: tab.id, bytesKey, annotations: found });
        })
        .catch((error) => {
          if (viewerApi.current !== api) return;
          // A failed read is unknown, not an empty document. Keep saved-mark edits
          // unavailable rather than normalizing against an invented empty inventory.
          existingInventoryUnknown();
          const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'pdfjs' });
          showNotice(t(failure.messageKey));
        });
      // A draft that carried engine-side edits applies them as soon as its document is
      // the one on screen; the tab stays dirty until a real save writes them.
      const id = store.active?.id;
      if (id === undefined) return;
      const pending = heldEngineValues(id) ?? pendingOverlays(store.active).engineValues;
      if (pending === undefined) return;
      void api
        .applyEngineValues(pending)
        .then((applied) => {
          if (viewerApi.current !== api) return;
          // The staged copy goes only once the engine has taken it: a rejection
          // must leave the entries where a retry can still reach them, and a restore
          // that applied **nothing** is reported with its own count instead of the
          // silence the previous version kept for exactly that case.
          releaseEngineValues(id);
          takeEngineAnnotations(api);
          const restoration = noticeLine(
            engineValuesNotices({ applied, carried: pending.entries.length, dropped: pending.dropped }),
            t,
          );
          // A successful byte edit restores the carried form state as part of its
          // redraw. Keep that operation's result; incomplete restoration still wins.
          if (applied < pending.entries.length || pending.dropped > 0) showNotice(restoration);
          else showNoticeIfEmpty(restoration);
        })
        .catch((error) => {
          if (viewerApi.current !== api) return;
          // The delta stays staged: it is the only copy of edits the document cannot see.
          showNotice(noticeLine(failureNotices(error, 'error.write-failed.message'), t));
        });
    },
    [store, t, takeEngineAnnotations],
  );
  const handleScaleChange = useCallback((scale: number) => setZoomState(scale), []);
  /**
   * The overlays measure the pages when they render, and they live inside the viewer's
   * scroll content — so a scroll needs nothing, but a layout change (zoom, fit-width on
   * a resize, a spread change, a rewritten document) needs one render. The pane reports
   * those, and this counter is the render.
   */
  const [, setLayoutRevision] = useState(0);
  const handleLayoutChange = useCallback(() => setLayoutRevision((value) => value + 1), []);

  /**
   * Fold the engine's live storage — the form values that were typed and the native
   * entries it still holds — into the session's own overlay state.
   *
   * This is the checkpoint every gesture that will later be *undone through the
   * journal* depends on. An overlay step restores the mark state of its own moment,
   * and the engine's storage is not part of any of it: without this, typing into a
   * form field and then undoing a mark edit would reopen the bytes from before the
   * typing and restore the older overlay state — losing a value the user can see.
   * Capturing first puts the value in the step's own `before`, where undo restores it
   * and the viewer re-applies it.
   *
   * Returns whether anything changed, so a caller that only needs the fresh state can
   * tell a real checkpoint from a no-op without reading the store again.
   */
  const checkpointEngineValues = useCallback(async (): Promise<boolean> => {
    const api = viewerApi.current;
    const tab = store.active;
    if (api === null || tab === null || api.document !== handleFor(tab.id)) return false;
    const engineValues = await api.captureEngineValues();
    if (viewerApi.current !== api) return false;
    const latest = store.getSnapshot().tabs.find((item) => item.id === tab.id);
    if (
      latest === undefined ||
      store.active?.id !== tab.id ||
      handleFor(tab.id) !== api.document ||
      latest.working.produced?.id !== tab.working.produced?.id
    )
      return false;
    const overlays = pendingOverlays(latest);
    const previous = overlays.engineValues ?? { entries: [], dropped: 0 };
    if (JSON.stringify(previous) === JSON.stringify(engineValues)) return false;
    // Each keystroke in a form field lands here; a burst of them is one undo step.
    store.setOverlays(tab.id, { ...overlays, engineValues } as unknown as JsonValue, 'ann.engineEdit', {
      coalesceWithinMs: 1500,
    });
    return true;
  }, [store]);

  /**
   * A form value or annotation changed in the engine: the tab is dirty until a write
   * succeeds. A change that came from the annotation editor is taken over as a mark
   * at the same moment, because the engine holds it as an editable object and the
   * app needs the geometry in its own model before the next save.
   */
  const markActiveDirty = useCallback(() => {
    const api = viewerApi.current;
    const tab = store.active;
    if (api === null || tab === null || api.document !== handleFor(tab.id)) return;
    takeEngineAnnotations(api);
    void checkpointEngineValues().catch((error) => {
      const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'pdfjs' });
      showNotice(t(failure.messageKey));
    });
  }, [checkpointEngineValues, store, t, takeEngineAnnotations]);

  /**
   * Export: writes the **current version** as a new file. Without a
   * File System Access handle this is the only way to keep work — and it must be
   * *this* file, not the bytes the user opened.
   */
  const exportActive = useCallback(
    async (tabId = store.active?.id) => {
      // Read the tab at call time like every other entry point: the export must write
      // the version the user is looking at, not the one the rendering control saw.
      const tab = store.getSnapshot().tabs.find((item) => item.id === tabId) ?? null;
      if (tab === null) return;
      if (isBusy()) {
        refuseBusy();
        return;
      }
      const controller = new AbortController();
      cancelRef.current = controller;
      setBusy(true);
      try {
        const prepared = await prepareOutput(tab.id, controller);
        if (prepared === null) return;

        const { bytes } = prepared;
        const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = tab.name;
        anchor.click();
        // Blob URLs are cleaned up right after the operation.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        // The browser-matrix contract: without an in-place handle the user
        // must know why this writes a *new* file instead of saving the one they opened.
        // The verification table travels with it either way: an export is a
        // write, and what the checks established belongs on the same line as the news
        // that it happened.
        showNotice(
          noticeLine(
            [
              {
                key: tab.source.handle === undefined ? 'export.explained' : 'save.done',
                params: { name: tab.name },
              },
              ...verificationNotices(prepared.verification),
            ],
            t,
          ),
        );
      } catch (error) {
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        if (cancelRef.current === controller) cancelRef.current = null;
        setBusy(false);
      }
    },
    [prepareOutput, refuseBusy, store, t],
  );

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
    setTextEdit(null);
    setImages(null);
  }, []);
  useStaleDialogDismissal(session, dropFrozenSelections);

  /**
   * Freeze the working bytes for the text tool the moment it is armed. Arming is a
   * user gesture, so this is one engine pass per tool activation — not a per-render
   * cost — and the model cannot describe a document the user has already changed.
   */
  useEffect(() => {
    if (!textTool || activeTab === null || activeHandle === null) {
      setTextToolBytes(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await materializeBase(contextFor(activeTab, activeHandle), {
          signal: new AbortController().signal,
        });
        if (!cancelled) setTextToolBytes(bytes);
      } catch (error) {
        if (cancelled) return;
        setTextToolBytes(null);
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
        selectTool('select');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, activeHandle, contextFor, t, textTool]);

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

  /**
   * The selection a page action must act on, kept in a ref as well as in state. The
   * buttons that emit page actions live in the panel, and a control rendered in an
   * earlier commit holds that commit's closure — measured: a rotate whose handler was
   * one render old did nothing at all (no notice, no error, no progress), and it
   * started working the moment anything else re-rendered the panel. Reading the ref
   * makes the handler independent of the render it was created in.
   */
  const selectedPagesRef = useRef<readonly number[]>(selectedPages);
  selectedPagesRef.current = selectedPages;
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
    selectAfterWrite,
  });
  const removeTargetsRef = useRef(removeTargets);
  removeTargetsRef.current = removeTargets;

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

  /** The stamp a write just added is selected once the re-read inventory lists it. */
  useEffect(() => {
    const key = selectAfterWrite.current;
    if (key === null || !markTargets.some((target) => target.key === key)) return;
    selectAfterWrite.current = null;
    setSelectedKeys([key]);
  }, [markTargets]);

  /**
   * `Delete` acts on the **whole** common selection — every family at once, and on the
   * marks the user can see rather than on whichever list happens to be first.
   *
   * Recovered native records are adopted first, so a draft's annotation cannot be
   * left outside the journal-owned selection. New gestures are already session
   * marks. `false` means the key was not the shell's to answer, so it is not swallowed.
   */
  const deleteMarkSelection = useCallback((): boolean => {
    const keys = selectedKeysRef.current;
    if (keys.length === 0) return false;
    if (orphanSweepInFlight() === null && (isBusy() || cancelRef.current !== null)) {
      refuseBusy();
      return false;
    }
    if (settleNativeEditors()) void sweepOrphanAnnotations();
    return removeTargetsRef.current(keys);
  }, [refuseBusy, settleNativeEditors, sweepOrphanAnnotations]);

  /**
   * `Ctrl/Cmd+A` selects every mark the common layer can act on. It answers only in the
   * select tool with a document open and marks to select: anywhere else the key belongs
   * to the engine (while one of its tools is armed) or to the page's own text, and the
   * shell declines it instead of stealing it.
   */
  const selectAllMarks = useCallback((): boolean => {
    if (coreStore.get().canvasTool !== 'select') return false;
    if (store.active === null || existingAnnotations === null) return false;
    const keys = currentMarkTargets().map((target) => target.key);
    if (keys.length === 0) return false;
    setSelectedKeys(keys);
    return true;
  }, [existingAnnotations, store]);

  /**
   * A selection never outlives what it names. **Leaving the common layer's modes**
   * clears it outright — a selection made with the select tool has no meaning under a
   * highlighter, and the strip must not offer to delete marks the user is not looking
   * at — and changing the document clears it too, because one document's marks are not
   * another's. A selection that survives into a new walking version keeps only the
   * keys that are still there: a removal removes its own keys, an undo can bring
   * others back.
   *
   * Entering the modes is deliberately *not* a clear: the note tool selects the note it
   * just made as it returns to `select`, and that selection is the point.
   */
  useEffect(() => {
    if (markMode === null) setSelectedKeys([]);
  }, [markMode]);

  useEffect(() => {
    if (activeTab?.id === undefined) return;
    setSelectedKeys([]);
  }, [activeTab?.id]);

  useEffect(() => {
    // A byte rewrite temporarily has no inventory. That is not evidence that the
    // selected objects disappeared; prune only once their replacement was read.
    if (existingAnnotations === null) return;
    setSelectedKeys((keys) => {
      if (keys.length === 0) return keys;
      const live = new Set(markTargets.map((target) => target.key));
      const kept = keys.filter((key) => live.has(key));
      return kept.length === keys.length ? keys : kept;
    });
  }, [existingAnnotations, markTargets]);

  /** Opens the note the common layer just created: selected, visible, contents editable. */
  const openNote = useCallback((mark: AnnotationMark) => {
    selectTool('select');
    setSelectedKeys([markTargetKey('annotation', mark.id, mark.pageIndex)]);
    openRightPanel('comments');
  }, []);

  /** Page actions and undo/redo (`features/pages/page-actions.ts`). */
  const { runPageAction, cancelOperation, stepHistoryNow } = usePageActions({
    session: store,
    t,
    cancel: cancelRef,
    canEdit: canEditRef,
    selectedPages: selectedPagesRef,
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
        setZoom: (value) => viewerApi.current?.setZoom(value),
        setSpread: (mode) => viewerApi.current?.setSpreadMode(mode),
        toggleFullscreen: () => void toggleFullscreen(),
        toggleReading,
        toggleMagnifier,
        openSnapshot: openSnapshotMenu,
        toggleLeftDock,
        toggleRightDock,
        selectAllPages: () => setSelectedPages(Array.from({ length: pageCount }, (_v, index) => index)),
        clearSelection: () => setSelectedPages([]),
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
        setShowHomeScreen(false);
        command.run();
        return;
      }
      pendingHomeCommand.current = commandId;
      void openViaPicker();
    },
    [activeHandle, activeTab, commands, openViaPicker],
  );

  useEffect(() => {
    const pending = pendingHomeCommand.current;
    // The open that brought the document is still holding the busy gate until it settles:
    // a dialog asked for before then is refused as "another operation is running".
    if (pending === null || viewer === null || activeHandle === null || busy) return;
    pendingHomeCommand.current = null;
    const command = commands.find((item) => item.id === pending);
    if (command !== undefined && command.disabled !== true) command.run();
  }, [viewer, activeHandle, busy, commands]);

  // The plain file input's own "cancel" (no File System Access picker): the tool picked
  // first is dropped, so it cannot run on a document opened later for another reason.
  useEffect(() => {
    const input = fileInput.current;
    if (input === null) return undefined;
    const clear = () => {
      pendingHomeCommand.current = null;
    };
    input.addEventListener('cancel', clear);
    return () => input.removeEventListener('cancel', clear);
  }, []);

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
        zoomIn: () => viewerApi.current?.setZoom(Math.min(4, zoom + 0.25)),
        zoomOut: () => viewerApi.current?.setZoom(Math.max(0.25, zoom - 0.25)),
        zoomReset: () => viewerApi.current?.setZoom(1),
        fitWidth: () => viewerApi.current?.setZoom('page-width'),
        nextPage: () => viewerApi.current?.goToPage(currentPage + 1),
        previousPage: () => viewerApi.current?.goToPage(currentPage - 1),
        firstPage: () => viewerApi.current?.goToPage(0),
        lastPage: () => viewerApi.current?.goToPage(Math.max(0, pageCount - 1)),
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
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4 select-none">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* `bg-pdf-accent`/`text-pdf-on-accent` are the product's own contrast
                pair: `bg-kumo-strong` is not a token Kumo declares, which left this
                mark a transparent chip with white glyph on white (found by the
                compiled-CSS audit). Same pair as the editor header's mark. */}
            <div className="flex size-7 shrink-0 items-center justify-center rounded bg-pdf-accent text-pdf-on-accent">
              <FilePdf size={18} weight="fill" />
            </div>
            {/* Below 400px the wordmark is dropped rather than clipped to one letter:
                the mark still identifies the app, and the controls keep their real
                size. */}
            <span className="hidden shrink-0 text-sm font-semibold text-kumo-strong min-[400px]:inline">
              {PRODUCT_TITLE}
            </span>
            <span className="hidden text-xs text-kumo-subtle md:inline">{t('shell.homeTagline')}</span>
          </div>
          {/* `shrink-0` keeps the controls at their real size: without it flex
              shrinks them below their content and the row overflows the viewport
              on a phone. The identity above is what yields, via `min-w-0`. */}
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={GearSix}
              onClick={() => setSettingsOpen(true)}
              title={t('settings.open')}
              aria-label={t('settings.open')}
            />
            {activeTab !== null ? (
              <Button size="sm" variant="outline" onClick={() => setShowHomeScreen(false)}>
                {t('shell.backToDocument')} ({activeTab.name})
              </Button>
            ) : null}
            {/* Below `md` the icon carries the control and the tooltip names it;
                the full label is what pushed the row past the viewport edge. */}
            <Button
              size="sm"
              variant="ghost"
              icon={Command}
              onClick={() => setPaletteOpen(true)}
              title={t('shell.commandPalette')}
              aria-label={t('shell.commandPalette')}
            >
              <span className="hidden md:inline">{t('shell.commandPaletteShort')}</span>
            </Button>
            <Button size="sm" variant="primary" icon={FolderOpen} onClick={() => void openViaPicker()}>
              {t('shell.open')}
            </Button>
          </div>
        </header>
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
          onHome={() => setShowHomeScreen(true)}
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
          onSearch={() => viewerApi.current?.openFind()}
          onPalette={() => setPaletteOpen(true)}
          menu={
            <MenuBar t={t} commands={mode === 'simple' ? visibleCommands(commands, 'simple') : commands} />
          }
          tabs={session.tabs.map((tab) => ({ id: tab.id, name: tab.name, dirty: tab.dirty }))}
          activeTabId={session.activeId}
          onSelectTab={(id) => {
            if (store.active?.id !== id) cancelRef.current?.abort();
            store.setActive(id);
            setSelectedPages([]);
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
              onClearSelection={() => setSelectedKeys([])}
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
            onSelectRecent={async (item) => {
              const matched = store
                .getSnapshot()
                // By identity only: two different files may share a name, and matching on
                // it opened whichever tab happened to carry that name.
                .tabs.find((tab) => tab.id === item.id);
              if (matched) {
                store.setActive(matched.id);
                setShowHomeScreen(false);
                return;
              }
              // The file the entry was opened from, reopened directly (Chromium keeps the
              // handle; the browser asks for permission again on this click).
              const stored = await getRecentHandle(item.id);
              if (stored !== null) {
                const reopened = await reopenFromHandle(stored);
                if (reopened.kind === 'file') {
                  await openFromSurface(reopened.file, reopened.handle);
                  return;
                }
                showNotice(
                  t(reopened.kind === 'denied' ? 'home.reopen.denied' : 'home.reopen.missing', {
                    name: item.name,
                  }),
                );
                // A refused permission is the user's answer; the picker would ask again.
                if (reopened.kind === 'denied') return;
              }
              try {
                const drafts = await draftStorage().readDrafts();
                const matchedDraft = drafts.find((d) => d.id === item.id);
                if (matchedDraft) {
                  const bytes = await draftStorage().getSource(matchedDraft.sourceKey);
                  if (bytes) {
                    const [handle, sha256] = await openAndFingerprint(openWithPdfjs(bytes), sha256Hex(bytes));
                    const tab = store.openDocument({
                      id: matchedDraft.id,
                      name: matchedDraft.name,
                      bytes,
                      sha256,
                      pageCount: matchedDraft.pageCount,
                    });
                    adoptHandle(tab.id, handle);
                    store.setActive(tab.id);
                    setShowHomeScreen(false);
                    return;
                  }
                }
              } catch (error) {
                // The draft could not be read back: say so, then offer the picker so the
                // user can open the file itself.
                showNotice(noticeLine(failureNotices(error, 'error.corrupt-document.message'), t));
              }
              void openViaPicker();
            }}
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
                  onSelectionChange={setSelectedPages}
                  onPageAction={runPageAction}
                  editing={canEdit}
                  version={activeTab.working.stateId}
                  marks={visibleMarks.annotations}
                  onGoToPage={(pageIndex) => viewerApi.current?.goToPage(pageIndex)}
                  onNotice={showNotice}
                  onHighlightQuery={(query) => viewerApi.current?.find(query)}
                  onLayersChanged={() => void viewerApi.current?.refreshOptionalContent()}
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
                onScaleChange={handleScaleChange}
                onModifiedChange={markActiveDirty}
                onLayoutChange={handleLayoutChange}
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
                          onSelectionChange={setSelectedKeys}
                          onMove={(keys, dx, dy) => void transformTargets(keys, { dx, dy, rotation: 0 })}
                          onResize={resizeStamp}
                          resizeLabel={t('stamp.resize')}
                        />
                      ) : null}
                      <StampPlacementHost viewer={viewer} canEdit={canEdit} t={t} onPlace={placeStamp} />
                      <FieldCandidateHost t={t} tab={activeTab} viewer={viewer} canEdit={canEdit} />
                      {/*
                The text tool wears its own layer rather than sharing the annotation
                one: it reads the page's structured text (an engine call) and paints
                block boxes, and the annotation layer's gesture set has nothing to do
                with it. Both are inert unless their own tool is armed, and the layer
                only mounts once its bytes are in hand — anything else would paint a
                model of a document nobody asked for.
              */}
                      {textTool && viewer !== null && textToolBytes !== null ? (
                        <Suspense fallback={null}>
                          <TextLayer
                            t={t}
                            viewer={viewer}
                            bytes={textToolBytes}
                            pageIndex={currentPage}
                            onSelect={(selection) => {
                              setTextEdit({
                                pageIndex: selection.pageIndex,
                                block: selection.block,
                                model: selection.model,
                                fonts: selection.fonts,
                              });
                              selectTool('select');
                              openDialog('text-edit');
                            }}
                            onClose={() => selectTool('select')}
                          />
                        </Suspense>
                      ) : null}
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
                        setTextEdit(null);
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
                          setSelectedKeys([]);
                          return;
                        }
                        const mark = annotations.find((item) => item.id === id);
                        if (mark !== undefined) {
                          setSelectedKeys([markTargetKey('annotation', mark.id, mark.pageIndex)]);
                        }
                      }}
                      onGoToPage={(pageIndex) => viewerApi.current?.goToPage(pageIndex)}
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
                        onGoToPage={(pageIndex) => viewerApi.current?.goToPage(pageIndex)}
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
                      onGoToPage={(pageIndex) => viewerApi.current?.goToPage(pageIndex)}
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
                      goToPage={(pageIndex) => viewerApi.current?.goToPage(pageIndex)}
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
              viewerRef={viewerApi}
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
              onGoToPage={(pageIndex) => viewerApi.current?.goToPage(pageIndex)}
              zoom={zoom}
              onZoomChange={(next) => viewerApi.current?.setZoom(next)}
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
      {passwordPrompt === null ? null : (
        <Suspense fallback={null}>
          <PasswordDialog
            t={t}
            name={passwordPrompt.file.name}
            incorrect={passwordPrompt.incorrect}
            onCancel={() => {
              pendingHomeCommand.current = null;
              setPasswordPrompt(null);
            }}
            onSubmit={(password) => {
              const { file, handle } = passwordPrompt;
              setPasswordPrompt(null);
              void openFile(file, handle, password);
            }}
          />
        </Suspense>
      )}
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
      {closeRequest !== null && !signaturePending ? (
        <Suspense fallback={null}>
          <CloseDocumentDialog
            t={t}
            name={session.tabs.find((tab) => tab.id === closeRequest)?.name ?? ''}
            canSave={session.tabs.find((tab) => tab.id === closeRequest)?.source.handle !== undefined}
            busy={busy}
            notice={notice}
            onCancel={() => {
              cancelRef.current?.abort();
              cancelClose();
            }}
            onDiscard={() => {
              if (!isBusy()) {
                discardTab(closeRequest);
                cancelClose();
              }
            }}
            onExport={() => void exportActive(closeRequest)}
            onSave={() =>
              void saveActive(closeRequest).then((saved) => {
                const tab = store.getSnapshot().tabs.find((item) => item.id === closeRequest);
                if (saved && tab !== undefined && !tab.dirty) {
                  discardTab(closeRequest);
                  cancelClose();
                }
              })
            }
          />
        </Suspense>
      ) : null}
      <XfaFormDialogHost t={t} onSave={saveXfaForm} />
      <SignatureDialogHost t={t} canRemember={activeTab?.sensitive !== true} />
      <ImagePickerInput t={t} />
      <SignatureWarningPrompt t={t} />
      <ContextMenuHost
        t={t}
        canEdit={canEdit}
        viewer={viewerApi}
        setRedactionMarks={setRedactionMarks}
        onPageAction={runPageAction}
      />
      <ExportDialogHost t={t} tab={activeTab} onExport={exportChoice} />
      <input
        ref={fileInput}
        type="file"
        accept={`application/pdf,.pdf,${CONVERT_ACCEPT}`}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.item(0);
          if (file != null) void openFromSurface(file);
          event.target.value = '';
        }}
      />
    </div>
  );
}
