import type {
  AnnotationMark,
  ExistingAnnotation,
  FormFieldInfo,
  PdfFontInfo,
  RedactionAudit,
  SignatureVerification,
} from 'pdf-core';
import { listPdfAttachments, readPdfAttachment } from 'pdf-core/attachments';
import { openWithPdfjs, type PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
// The annotation and form ops are imported by **module**, not through the
// package barrel: a barrel re-export keeps every operation module in the graph the
// entry chunk is built from (measured: 160 kB of op code in the first paint),
// and the engine chunk it pulls in is what the ≤250 KiB budget is there to keep
// out.
import {
  parseAnnotationData,
  serializeAnnotationsFdf,
  serializeAnnotationsJson,
  toAppSpace,
} from 'pdf-core/ops/annotation-data';
import type { MarkTransform } from 'pdf-core/ops/annotation-transform';
import { transformPdfAnnotations } from 'pdf-core/ops/annotation-transform';
import { marksFromEngineEntries, readAnnotations } from 'pdf-core/ops/annotations';
import { fieldValueText, fillFormFields, readFormFields } from 'pdf-core/ops/forms';
import { type MeasureMark, type MeasureMode, type MeasureScale, scaleForRatio } from 'pdf-core/ops/measure';
import type { RedactRect } from 'pdf-core/ops/redact';
import { inspectProtection, type ProtectionState } from 'pdf-core/ops/security';
import { verifySignatures } from 'pdf-core/ops/signature-status';
import type { OperationContext, OperationNote, OperationProgress } from 'pdf-core/ops/types';
import {
  addTrustRoot,
  copyForEngine,
  type Draft,
  type DraftInventory,
  type DraftSnapshot,
  draftFor,
  type EngineValuesDraft,
  encodeEngineValues,
  isRestorable,
  type JsonValue,
  keysForDraft,
  type OpenDocumentKeys,
  parseTrustRoots,
  planDocumentCleanup,
  planVaultCleanup,
  removeTrustRoot,
  type SessionStore,
  type SessionTab,
  sha256Hex,
  sortDrafts,
  sourceKeyFor,
  type TrustRoot,
  type TrustRootsFile,
  toDer,
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
const SignatureWarningDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.SignatureWarningDialog };
});
const ExportDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.ExportDialog };
});
const SettingsDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.SettingsDialog };
});
const PasswordDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.PasswordDialog };
});
/**
 * The keyboard shortcut list. Help is not a document operation — it opens with no tab
 * and in either mode — but it carries Kumo's dialog primitives, so it rides the dialog
 * boundary with the other modals rather than the first paint.
 */
const ShortcutsDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.ShortcutsDialog };
});

import { CaretLeft, CaretRight, Command, FilePdf, FolderOpen, GearSix } from '@phosphor-icons/react';
import type { OperationOutcome } from 'pdf-core';
import type { PdfImageInfo } from 'pdf-core/ops/image-edit';
import { listPdfImages } from 'pdf-core/ops/image-edit';
import type { LayerWriteRequest } from 'pdf-core/ops/layer-write';
import type { LinkTargetRect } from 'pdf-core/ops/link-edit';
import type { ProducedDocument } from 'pdf-model';
import type { MessageKey } from 'pdf-shared';
import type { FieldValue, MeasureReading } from 'pdf-ui';
import type { SavedSignature, StampSource } from 'pdf-ui/dialog';
import {
  type CanvasShapeKind,
  type CanvasToolId,
  Magnifier,
  MarkInteractionLayer,
  type MarkTarget,
  markTargetKey,
  ReadingPane,
  SnapshotMenu,
  type StampPlacement,
  StampPlacementLayer,
  selectionBoxes,
  ToolProperties,
  usePresentation,
} from 'pdf-ui/tools';
import type {
  AnnotationTool,
  DocumentPanelTab,
  OperationDialogSpec,
  OperationRunContext,
  OpRunResult,
} from 'pdf-ui/ui';
import {
  AnnotationLayer,
  Button,
  ContextMenu,
  Dock,
  DocumentPanel,
  dialogById,
  HistoryPanel,
  hasDialog,
  isStandaloneDialog,
  MenuBar,
  RedactionLayer,
  RedactionPanel,
  StatusBar,
  ToolsRailPanel,
  useLocale,
  useTheme,
} from 'pdf-ui/ui';
import { PdfViewerPane, type ViewerApi } from 'pdf-ui/viewer';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  buildMarkTargets,
  isEmptyRemoval,
  normalizePendingMarks,
  planMarkRemoval,
  planMarkTransform,
  removalCount,
} from './annotation-interaction';
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
import { isMarkupTool, type MarkupTool, ToolRail } from './components/ToolRail';
import { UpdateBanner } from './components/UpdateBanner';
import { createOpfsDraftStorage, readAppFile, writeAppFile } from './drafts';
import { compressionPresets } from './export-presets';
import { MODE_CHANGE_EVENT, readStoredMode, storeMode } from './interface-mode';
import {
  addAttachments,
  addImageStamp,
  applyLayerWrite,
  auditRedactedDocument,
  listPdfFonts,
  removeAttachments,
  resizeImageStamp,
} from './lazy-ops';
import { auditNotice, engineValuesNotices, failureNotices, noticeLine, verificationNotices } from './notices';
import {
  incompleteCapabilities,
  prepareOffline,
  requestOfflineReadiness,
  requiredCapabilities,
} from './offline';
import {
  applyHistoryStep,
  applyPageAction,
  applyProducedBytes,
  type DocumentContext,
  downloadFiles,
  hasEngineEdits,
  materializeBase,
  type PageAction,
  pageActionLabel,
  pendingOverlays,
  pruneOverlays,
  redactionNeedles,
  removeMarkTargets,
  tabPageCount,
  verifyForWrite,
  type WriteVerification,
} from './operations';
import { addRecentDocument, loadRecentDocuments } from './recent';
import { getRecentHandle, pruneRecentHandles, putRecentHandle, reopenFromHandle } from './recent-handles';
import {
  appliedVersionBytes,
  signatureWarning as decideSignatureWarning,
  planSaveExecution,
  type SaveExecutionPlan,
  type SaveStepDescription,
} from './save-plan';
import { forgetSignature, loadSavedSignatures, rememberSignature } from './signature-store';
import { SHELL_SHORTCUT_GROUPS, useShellShortcuts } from './useShortcuts';
import { createVaultChannel, type VaultChannel } from './vault-channel';

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
const COMPACT_VIEW_QUERY = '(max-width: 1023px)';

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

/**
 * The browser's text selection as pending redaction areas, one per selected line, in
 * the redaction writer's own space. The words the user selected are exactly the words
 * the areas cover, so "select, right-click, Redact" marks what was selected instead of
 * only arming a tool that then waits for a drag.
 */
function selectionRedactAreas(viewer: ViewerApi): readonly RedactRect[] {
  return selectionBoxes(viewer).flatMap((selection) =>
    selection.boxes.map((box) => ({ pageIndex: selection.pageIndex, space: 'app-v1' as const, rect: box })),
  );
}

export interface AppProps {
  readonly store: SessionStore;
}

interface MarkedRect {
  readonly id: string;
  readonly mark: RedactRect;
}

/**
 * What an open operation dialog runs against: frozen bytes plus the identity of
 * the tab and working version they were frozen from. A dialog whose input is no
 * longer that exact version applies nothing.
 */
interface DialogInput {
  readonly tabId: string;
  readonly workingId: string;
  readonly name: string;
  readonly pageCount: number;
  readonly bytes: Uint8Array;
  /** Field values the opener chose before the form existed (the export choice's image format). */
  readonly presets?: Readonly<Record<string, FieldValue>>;
}

/**
 * Dock panels that own a capability's *writer* are loaded when the tab is opened.
 *
 * The properties panel is the only consumer of the font reader, the signature
 * verifier and the embedded-file writer; loading them with the shell would put a
 * capability nobody has asked for into the first paint. The budget is a locked
 * decision, so the split is where it belongs: in the module graph.
 */
const PropertiesPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.PropertiesPanel };
});
const CommentsPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.CommentsPanel };
});
const FormPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.FormPanel };
});
const RedactionAuditPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.RedactionAuditPanel };
});
/**
 * Printing and the command palette are the two surfaces that held the entry chunk
 * over the budget:
 * `PrintDialog` is the only file that puts Kumo's dialog/select/checkbox/input/radio
 * primitives on the first-paint graph, and the palette is the only consumer of
 * Kumo's command palette. Both are reached by a gesture, so both load on demand —
 * and `main.tsx` prefetches them while the browser is idle, so the first `Ctrl+P`
 * or `Ctrl+K` is not a visible wait.
 */
const PrintDialog = lazy(async () => {
  const module = await import('pdf-ui/printing');
  return { default: module.PrintDialog };
});
const CommandPalette = lazy(async () => {
  const module = await import('pdf-ui/palette');
  return { default: module.CommandPalette };
});
/**
 * The batch dialog: a queue of files, not the open document. It carries Kumo's form and
 * dialog primitives, so it lives behind the same boundary as the other dialogs.
 */
const BatchDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.BatchDialog };
});
/**
 * The modal host of an operation that starts a document (blank, images, merge): it runs
 * with no document open, so it cannot live in a tab's tools panel.
 */
const StartDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.StartDialog };
});
/** The simple-signature dialog: draw, type or photograph a signature (`SignatureDialog`). */
const SignatureDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.SignatureDialog };
});
/**
 * The comparison and accessibility panels read the working bytes and (for the
 * accessibility writer) touch the file, so they ride the dock panels' own boundary rather
 * than the first paint.
 */
const ComparePanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.ComparePanel };
});
const AccessibilityPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.AccessibilityPanel };
});
/**
 * The measure layer and its settings strip arrive with the tool: they carry the
 * annotation writer and the ruler geometry, neither of which belongs in the first paint.
 */
const MeasureLayer = lazy(async () => {
  const module = await import('pdf-ui');
  return { default: module.MeasureLayer };
});
const MeasureSettings = lazy(async () => {
  const module = await import('pdf-ui');
  return { default: module.MeasureSettings };
});
/**
 * The text tool's overlay — it reads the page's structured text and parses the font
 * metric tables, so it arrives with the tool.
 */
const TextLayer = lazy(async () => {
  const module = await import('pdf-ui/text-edit');
  return { default: module.TextLayer };
});

export function App({ store }: AppProps) {
  const { theme, setTheme } = useTheme();
  const { locale } = useLocale();
  const draftStorage = useMemo(() => createOpfsDraftStorage(), []);
  const t = useMemo(() => createTranslator(locale), [locale]);
  const tier = useMemo(() => detectDeviceTier(), []);
  const [memoryUsage, setMemoryUsage] = useState<{ usedBytes: number; budgetBytes: number } | undefined>(
    undefined,
  );
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const handles = useRef(new Map<string, PdfDocumentHandle>());
  const retiredHandles = useRef(new Set<PdfDocumentHandle>());
  const releasedHandles = useRef(new WeakSet<PdfDocumentHandle>());
  const [, setHandleVersion] = useState(0);
  /**
   * Engine-side deltas restored from drafts, keyed by tab: they can only be applied
   * once the viewer has loaded that tab's document (`PdfViewerPane` mounts the active
   * document), so they wait here until the pane reports ready for the tab.
   */
  const pendingEngineValues = useRef(new Map<string, EngineValuesDraft>());
  /**
   * The words a document's applied redactions removed.
   *
   * The audit's question is "does this file still carry what was erased", and the marks
   * themselves cannot answer it: a `RedactRect` is geometry, and the words under it are
   * gone from the working bytes the moment the redaction lands. So they are read once,
   * from the bytes the redaction ran on, and kept per tab until the tab is closed.
   */
  const redactedTerms = useRef(new Map<string, readonly string[]>());
  const persistedSnapshots = useRef(new Map<string, readonly string[]>());
  const draftWrites = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Cross-window vault coordination (`vault-channel.ts`). The effect owns creation
   * and disposal together; a render-owned channel stayed closed after StrictMode's
   * setup → cleanup → setup cycle and crashed the next announcement.
   */
  const [channel, setChannel] = useState<VaultChannel | null>(null);
  const liveChannel = useRef<VaultChannel | null>(null);
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
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
  }, []);
  /**
   * A gesture the synchronous gate refuses says so. The gate itself stays
   * synchronous — this only speaks when it closes, because an inert control and a
   * refused action must not look the same.
   */
  const refuseBusy = useCallback(() => setNotice(t('op.busy')), [t]);
  const [closeRequest, setCloseRequest] = useState<string | null>(null);
  const closeTrigger = useRef<HTMLElement | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [magnifierOn, setMagnifierOn] = useState(false);
  const [lensZoom, setLensZoom] = useState(4);
  /** Surface state: dialogs, palette, docks, page selection, progress, tools. */
  const [dialogSpec, setDialogSpec] = useState<OperationDialogSpec | null>(null);
  /**
   * The frozen input of the open dialog: the tab it belongs to, the working
   * version its bytes were materialised from and the bytes themselves. Storing
   * the origin here — instead of reading the *active* tab when the dialog
   * renders — is what stops a tab switch during materialisation from pairing one
   * document's bytes with another document's name, page count and handle, and it
   * makes an operation that landed behind the dialog a reason to dismiss rather
   * than a silent mismatch.
   */
  const [dialogInput, setDialogInput] = useState<DialogInput | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * The shortcut list (`useShortcuts.ts` owns the bindings it prints). Its own state
   * rather than a dialog id: help is not a document operation, so it opens with no tab
   * and in either interface mode.
   */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Language, theme, interface mode, privacy and offline preferences — one dialog. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * What had the focus when the list opened. It is usually still there when the list
   * closes (the Help menu trigger), but a palette search field is gone by then — the
   * close path below falls back rather than dropping focus on `<body>`.
   */
  const shortcutsTrigger = useRef<HTMLElement | null>(null);
  const [showHomeScreen, setShowHomeScreen] = useState(true);
  /**
   * The command a home-screen tool promised to run once its document is open: the tool was
   * picked first and the file asked for after, so the command waits for the tab.
   */
  const pendingHomeCommand = useRef<string | null>(null);
  /** The standalone operation shown in its modal (`StartDialog`), or `null`. */
  const [startSpec, setStartSpec] = useState<OperationDialogSpec | null>(null);
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
  const [canvasTool, setCanvasTool] = useState<CanvasToolId>('select');
  /**
   * The text-markup look the rail's markup button arms: the one used last, from any
   * route (rail, strip, menu, palette, context menu).
   */
  const [markupTool, setMarkupTool] = useState<MarkupTool>('highlight');
  /**
   * The picture the `stamp` tool places with the next click on a page — a signature,
   * initials or an image — and whether the signature dialog is open. Remembered
   * signatures are opt-in and stay in this browser (`signature-store.ts`).
   */
  const [pendingStamp, setPendingStamp] = useState<StampSource | null>(null);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [savedSignatures, setSavedSignatures] = useState<readonly SavedSignature[]>(() =>
    loadSavedSignatures(),
  );
  /** The image picker the "add an image" command opens. */
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  /** A stamp just written: selected as soon as the re-read inventory lists it. */
  const selectAfterWrite = useRef<string | null>(null);
  // The picture belongs to the armed tool: any other tool, from any route, drops it.
  useEffect(() => {
    if (canvasTool !== 'stamp') setPendingStamp(null);
  }, [canvasTool]);
  useEffect(() => {
    if (isMarkupTool(canvasTool)) setMarkupTool(canvasTool);
  }, [canvasTool]);
  /**
   * Which measurement is armed while the ruler owns the pointer. A *sub*-choice, not
   * a second active tool: `measureMode` below is `null` unless `canvasTool` is
   * `'measure'`, so the strip and the menu check cannot disagree with the pointer.
   */
  const [measureSubMode, setMeasureSubMode] = useState<MeasureMode>('distance');
  /** The shape subtype the next shape mark carries. */
  const [shape, setShape] = useState<CanvasShapeKind>('square');
  /**
   * The common layer's selection: target keys across all four mark families, in the
   * one identity space `annotation-interaction.ts` builds. Nothing else may hold a
   * "selected mark" — the single-id state this replaces mixed session mark ids,
   * engine storage keys and pdf.js annotation ids in one string.
   */
  const [selectedKeys, setSelectedKeys] = useState<readonly string[]>([]);
  const canvasToolRef = useRef(canvasTool);
  canvasToolRef.current = canvasTool;
  const selectedKeysRef = useRef<readonly string[]>(selectedKeys);
  selectedKeysRef.current = selectedKeys;
  const [compactViewport, setCompactViewport] = useState(() => window.matchMedia(COMPACT_VIEW_QUERY).matches);
  const [leftDock, setLeftDock] = useState(!compactViewport);
  const [rightDock, setRightDock] = useState(!compactViewport);
  useEffect(() => {
    const media = window.matchMedia(COMPACT_VIEW_QUERY);
    const onChange = () => {
      setCompactViewport(media.matches);
      // Two desktop docks otherwise leave no canvas, hiding the tools beneath them.
      if (media.matches) {
        setLeftDock(false);
        setRightDock(false);
      }
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  const [rightTab, setRightTab] = useState<string>('history');
  const [selectedPages, setSelectedPages] = useState<readonly number[]>([]);
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** Drives which operation dialog is mounted; the value itself is only read by the host's key. */
  const [, setDialogId] = useState<string | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly hasSelection: boolean;
    readonly selectedText?: string;
  } | null>(null);
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
  /** The left dock's visible tab, so a menu or palette command can open a view. */
  const [leftTab, setLeftTab] = useState<DocumentPanelTab>('pages');
  /**
   * Simple or advanced (`interface-mode.ts`). Read once on mount and kept in step with
   * the `pdf-mode-change` event, so the header switch and this state cannot disagree.
   */
  const [mode, setMode] = useState<InterfaceMode>(readStoredMode);
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: InterfaceMode }>).detail;
      if (detail?.mode === 'simple' || detail?.mode === 'advanced') setMode(detail.mode);
    };
    globalThis.addEventListener?.(MODE_CHANGE_EVENT, onChange);
    return () => globalThis.removeEventListener?.(MODE_CHANGE_EVENT, onChange);
  }, []);
  const changeMode = useCallback((next: InterfaceMode) => {
    storeMode(next);
    setMode(next);
    // A dialog the simple mode hides must not stay open behind the filter: closing it
    // returns the user to a surface the mode actually offers, rather than leaving them
    // on a screen the menus can no longer reach.
    if (next === 'simple') {
      cancelRef.current?.abort();
      setDialogId(null);
      setDialogSpec(null);
      setDialogInput(null);
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
  /**
   * Drawn redaction marks. The list needs a stable identity for its rows, and the
   * operation needs the engine rectangle, so the app keeps both instead of letting
   * either side re-derive the other.
   */
  const redactionMarks = pendingOverlays(store.active).redactions;
  const setRedactionMarks = useCallback(
    (change: readonly MarkedRect[] | ((current: readonly MarkedRect[]) => readonly MarkedRect[])) => {
      const tab = store.active;
      if (tab === null) return;
      const overlays = pendingOverlays(tab);
      const next = typeof change === 'function' ? change(overlays.redactions) : change;
      if (next === overlays.redactions || (next.length === 0 && overlays.redactions.length === 0)) return;
      store.setOverlays(tab.id, { ...overlays, redactions: next } as unknown as JsonValue, 'panel.redaction');
    },
    [store],
  );
  /**
   * Annotation marks of the active tab. They are session
   * state, not engine state: the engine owns the gesture for the four types it has
   * an editor for, and the mark it produces is taken over here so the journal, the
   * comment panel and the writer all see the same list.
   *
   * A ref mirrors the state because the save path must read the marks of the
   * **moment it runs**, not of the render that created its callback — the same rule
   * that fixed the page-action defect (a control one render old handed the previous
   * handle to the engine).
   */
  const annotations = pendingOverlays(store.active).annotations;
  const setAnnotations = useCallback(
    (
      change: readonly AnnotationMark[] | ((current: readonly AnnotationMark[]) => readonly AnnotationMark[]),
    ) => {
      const tab = store.active;
      if (tab === null) return;
      const overlays = pendingOverlays(tab);
      const next = typeof change === 'function' ? change(overlays.annotations) : change;
      if (next === overlays.annotations || (next.length === 0 && overlays.annotations.length === 0)) return;
      store.setOverlays(tab.id, { ...overlays, annotations: next } as unknown as JsonValue, 'panel.comments');
    },
    [store],
  );
  const annotationsRef = useRef<readonly AnnotationMark[]>(annotations);
  annotationsRef.current = annotations;
  const [annotationColor, setAnnotationColor] = useState('#ffd400');
  /** Typed text is ink, not a marker: its own colour and size, not the marker's style. */
  const [textColor, setTextColor] = useState('#000000');
  const [fontSize, setFontSize] = useState(12);
  const [annotationOpacity, setAnnotationOpacity] = useState(0.4);
  const [annotationThickness, setAnnotationThickness] = useState(2);
  const [annotationAuthor, setAnnotationAuthor] = useState('');
  /**
   * The measure tool's own state: the scale the document is
   * drawn at, the marks the session holds, the grid settings and the live reading.
   * Colour, opacity, thickness and author are the annotation style — a ruler and a
   * highlighter are the same kind of mark, and two colour pickers would be two answers
   * to one question. The armed ruler itself is `canvasTool === 'measure'`.
   */
  const [measureScale, setMeasureScale] = useState<MeasureScale>(() => scaleForRatio(100));
  const measureMarks = pendingOverlays(store.active).measures;
  const setMeasureMarks = useCallback(
    (change: readonly MeasureMark[] | ((current: readonly MeasureMark[]) => readonly MeasureMark[])) => {
      const tab = store.active;
      if (tab === null) return;
      const overlays = pendingOverlays(tab);
      const next = typeof change === 'function' ? change(overlays.measures) : change;
      if (next === overlays.measures || (next.length === 0 && overlays.measures.length === 0)) return;
      store.setOverlays(tab.id, { ...overlays, measures: next } as unknown as JsonValue, 'tools.measure');
    },
    [store],
  );
  const [measureGrid, setMeasureGrid] = useState(false);
  const [measureSpacing, setMeasureSpacing] = useState(36);
  const [measureSnapGrid, setMeasureSnapGrid] = useState(false);
  const [measureSnapPoints, setMeasureSnapPoints] = useState(false);
  const [measureReading, setMeasureReading] = useState<MeasureReading | null>(null);
  /**
   * The file's own annotations, **keyed to the bytes they were read from**.
   *
   * `readAnnotations` is async, so an inventory that has not arrived yet must not look
   * like a document with no annotations: the common layer's targets — and with them
   * selection and editing — stay unavailable until the inventory describing the
   * version on screen has been read, and a read that lands after a byte operation
   * replaced that version is discarded rather than mixed into the new one.
   *
   * The key is the produced version's own id (or the source master), **not**
   * `working.id`: drawing, erasing or undoing a mark journals an overlay step and
   * mints a new working id without touching a byte, and keying on that would throw
   * away a perfectly good inventory every time the user drew something.
   */
  const [existingInventory, setExistingInventory] = useState<{
    readonly tabId: string;
    readonly bytesKey: string;
    readonly annotations: readonly ExistingAnnotation[];
  } | null>(null);
  /**
   * The form inventory of the active tab. Read from the **working bytes** rather
   * than from the viewer: a field list is a document fact, and re-reading it after
   * every operation keeps it true (a page delete can remove widgets).
   */
  const [formInventory, setFormInventory] = useState<{
    tabId: string;
    version: string;
    fields?: readonly FormFieldInfo[];
    error?: ToolError;
  } | null>(null);
  const [inspectionRevision, setInspectionRevision] = useState(0);
  const [selectedField, setSelectedField] = useState<string | null>(null);

  /**
   * The tools slices need a render when the viewer API arrives, and a ref does not
   * re-render — so the API is mirrored into state while the shortcut layer keeps
   * reading the ref (same object, two access patterns).
   */
  const [viewer, setViewer] = useState<ViewerApi | null>(null);
  const presentation = usePresentation(viewer);

  const activeTab = session.tabs.find((tab) => tab.id === session.activeId) ?? null;
  const activeHandle = activeTab === null ? null : (handles.current.get(activeTab.id) ?? null);
  const pageCount = activeTab === null ? 0 : tabPageCount(activeTab);
  const currentForms =
    activeTab !== null &&
    formInventory?.tabId === activeTab.id &&
    formInventory.version === activeTab.working.id
      ? formInventory
      : null;
  const formFields = currentForms?.fields ?? null;

  /**
   * The file's annotations for the bytes on screen — `null` while the read is still in
   * flight, or when it describes a version that is no longer current.
   */
  const existingBytesKey = activeTab === null ? null : (activeTab.working.produced?.id ?? 'source');
  const existingAnnotations =
    existingInventory !== null &&
    activeTab !== null &&
    existingInventory.tabId === activeTab.id &&
    existingInventory.bytesKey === existingBytesKey
      ? existingInventory.annotations
      : null;
  const editableOverlays = useCallback(
    (tab: SessionTab) => {
      const stored = pendingOverlays(tab);
      if (
        existingInventory?.tabId !== tab.id ||
        existingInventory.bytesKey !== (tab.working.produced?.id ?? 'source')
      )
        return stored;
      const normalized = normalizePendingMarks(stored, existingInventory.annotations);
      return normalized === stored ? stored : { ...stored, ...normalized };
    },
    [existingInventory],
  );
  const visibleMarks = useMemo(
    () => (activeTab === null ? pendingOverlays(null) : editableOverlays(activeTab)),
    [activeTab, editableOverlays],
  );

  /** Which measurement is armed; `null` whenever the ruler does not own the pointer. */
  const measureMode: MeasureMode | null = canvasTool === 'measure' ? measureSubMode : null;
  const redactionActive = canvasTool === 'redact';
  const textTool = canvasTool === 'text';
  /** Only creation gestures reach the annotation overlay. */
  const annotationLayerTool = ANNOTATION_LAYER_TOOLS[canvasTool] ?? null;
  const markMode = canvasTool === 'select' ? 'select' : null;

  /**
   * Every mark the page shows, in the common layer's identity space: the session's
   * annotations, its measurements, its redaction intents and the annotations the file
   * itself carries, with our own saved marks deduplicated against their pending
   * copies (`annotation-interaction.ts`).
   *
   * Memoized on the model it is derived from: the geometry conversion walks every
   * existing annotation and every page, which is not work a re-render should repeat.
   */
  const markTargets = useMemo(
    () =>
      existingAnnotations === null
        ? []
        : buildMarkTargets({
            annotations,
            measures: measureMarks,
            redactions: redactionMarks,
            existing: existingAnnotations,
            // The page's own top edge: `viewBox[3]` read from the fields the viewer
            // has always returned (`y + height`), the same edge `pointToPage` flips
            // against. The writer's own `pageBox` wins where it is available.
            pageTop: (pageIndex) => {
              const geometry = viewer?.pageGeometry(pageIndex) ?? null;
              return geometry === null ? null : geometry.y + geometry.height;
            },
            labelFor: (family, messageKey, subtype) => {
              const name = t(messageKey);
              if (family !== 'existing') return name;
              return subtype === undefined
                ? `${name} · ${t('ann.inFile')}`
                : `${subtype} · ${t('ann.inFile')}`;
            },
          }),
    [annotations, existingAnnotations, measureMarks, redactionMarks, t, viewer],
  );
  const markTargetsRef = useRef<readonly MarkTarget[]>(markTargets);
  markTargetsRef.current = markTargets;

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
    return checkDocumentLimits(tier, tabPageCount(activeTab), currentBytes);
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

  /** The manifest inventory, or `null` when it could not be read completely. */
  const readInventory = useCallback(async (): Promise<DraftInventory> => {
    try {
      if (draftStorage.readDraftInventory !== undefined) return await draftStorage.readDraftInventory();
      return { drafts: await draftStorage.readDrafts(), unreadable: [] };
    } catch {
      return { drafts: [], unreadable: [], enumerationFailed: true };
    }
  }, [draftStorage]);

  /** What every document open in this window holds, in the vault-key vocabulary. */
  const openVaultKeys = useCallback(
    (excludedTabId?: string): readonly OpenDocumentKeys[] =>
      store
        .getSnapshot()
        .tabs.filter((tab) => tab.id !== excludedTabId)
        .map((tab) => ({
          source: sourceKeyFor(tab.id, tab.source.sha256),
          snapshots: persistedSnapshots.current.get(tab.id) ?? [],
        })),
    [store],
  );

  /**
   * The snapshot keys a document retains, per device tier. Desktop keeps the journal's
   * own history; the smaller tiers keep one produced version, because a phone's storage
   * budget is the constraint that matters there.
   */
  const retainedSnapshotsFor = useCallback(
    (tab: SessionTab): readonly ProducedDocument[] =>
      tier === 'desktop'
        ? store.snapshotsFor(tab.id)
        : tab.working.produced === undefined
          ? []
          : [tab.working.produced],
    [store, tier],
  );

  /**
   * Removes one document's stored copies: its manifest, then every blob it owns that no
   * other manifest, open document or window still references.
   *
   * `null` means the inventory was incomplete and **nothing was deleted** — an orphan blob
   * costs space, a deleted live blob costs the user a document. This is deletion from
   * application storage; it does not overwrite the bytes underneath, and it cannot reach a
   * download, an external original or a browser backup.
   */
  const forgetTabDraft = useCallback(
    async (tabId: string): Promise<readonly string[] | null> => {
      if (channel === null) return null;
      const inventory = await readInventory();
      if (inventory.enumerationFailed === true || inventory.unreadable.length > 0) return null;
      const known = inventory.drafts.find((draft) => draft.id === tabId);
      const owned =
        known === undefined ? [...(persistedSnapshots.current.get(tabId) ?? [])] : [...keysForDraft(known)];
      await draftStorage.deleteDraft(tabId);
      const removable = planDocumentCleanup(
        { manifestId: tabId, keys: owned },
        {
          open: openVaultKeys(tabId),
          storedSources: [],
          inventory,
          peerReferences: channel.peerReferences(),
        },
      );
      if (removable === null) return null;
      for (const key of removable) await draftStorage.deleteSource(key);
      persistedSnapshots.current.delete(tabId);
      return removable;
    },
    [channel, draftStorage, openVaultKeys, readInventory],
  );

  /** What one persistence attempt did, so the caller can word the notice honestly. */
  type PersistOutcome = 'written' | 'sensitive' | 'skipped' | 'gone';

  /**
   * The **one** implementation of draft persistence, used by the manual save command and
   * the debounced automatic save alike.
   *
   * The model state is captured synchronously before the first `await`, so the manifest
   * always describes the version whose bytes were written — reading it again after the
   * encoding work would let a fast edit publish a manifest for a state no blob matches.
   */
  const persistTabDraft = useCallback(
    async (tabId: string): Promise<PersistOutcome> => {
      const before = store.getSnapshot().tabs.find((item) => item.id === tabId);
      if (before === undefined) return 'gone';
      if (before.sensitive) {
        // A sensitive document never enters persistence, and whatever an earlier session
        // stored for it leaves now.
        await forgetTabDraft(tabId);
        return 'sensitive';
      }
      const handle = handles.current.get(tabId);
      if (handle === undefined) return 'skipped';
      const map = handle.raw.annotationStorage?.serializable?.map;
      const journal = tier === 'desktop' ? before.journal.entries : [];
      const journalCursor = tier === 'desktop' ? before.journal.cursor : 0;
      const engineValues = await encodeEngineValues(map instanceof Map ? map.entries() : []);
      const sourceKey = sourceKeyFor(before.id, before.source.sha256);
      await draftStorage.putSource(sourceKey, before.source.master);
      const snapshots: DraftSnapshot[] = [];
      for (const snapshot of retainedSnapshotsFor(before)) {
        const key = `snapshot-${snapshot.id}`;
        await draftStorage.putSource(key, snapshot.bytes);
        const { bytes: _bytes, ...description } = snapshot;
        snapshots.push({ ...description, key });
      }
      await draftStorage.writeDraft(
        draftFor({
          id: before.id,
          name: before.name,
          pageCount: tabPageCount(before),
          size: before.source.size,
          sourcePageCount: before.source.pageCount,
          dirty: before.dirty,
          sourceKey,
          journal,
          journalCursor,
          stateId: before.working.stateId,
          savedState: before.savedState,
          ...(before.working.overlays === undefined ? {} : { overlays: before.working.overlays }),
          ...(before.working.produced === undefined ? {} : { workingId: before.working.produced.id }),
          snapshots,
          engineValues,
          now: Date.now(),
        }),
      );
      // The tab may have been closed or marked sensitive while the bytes were written; a
      // manifest for a sensitive document must not survive that race.
      const after = store.getSnapshot().tabs.find((item) => item.id === tabId);
      if (after === undefined || after.sensitive) {
        await forgetTabDraft(tabId);
        return after === undefined ? 'gone' : 'sensitive';
      }
      const keys = snapshots.map((item) => item.key);
      for (const key of persistedSnapshots.current.get(tabId) ?? []) {
        if (!keys.includes(key)) await draftStorage.deleteSource(key);
      }
      persistedSnapshots.current.set(tabId, keys);
      return 'written';
    },
    [draftStorage, forgetTabDraft, retainedSnapshotsFor, store, tier],
  );

  /**
   * The user-requested, **scoped** cleanup: forget this document, here and now.
   *
   * It is the same operation the sensitive toggle performs, offered by name so the user
   * can reach it without changing a session setting, and it reports what actually left the
   * vault. Deletion is from this origin's application storage: the bytes underneath are not
   * overwritten, and any copy the user downloaded, the file they opened it from, and any
   * browser profile backup are outside this application's reach — the notice says so.
   */
  const purgeActiveDocument = useCallback(async () => {
    if (activeTab === null) return;
    if (channel === null) {
      setNotice(t('vault.sweepNoChannel'));
      return;
    }
    try {
      await channel.runExclusive(async () => {
        const queued = draftWrites.current.then(() => forgetTabDraft(activeTab.id));
        draftWrites.current = queued.catch(() => undefined);
        const removed = await queued;
        if (removed === null) setNotice(t('vault.incomplete'));
        else setNotice(t('vault.purged', { count: removed.length }));
      });
    } catch (error) {
      const failure = error instanceof ToolError ? error : new ToolError('write-failed', { engine: 'model' });
      setNotice(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    }
  }, [activeTab, channel, forgetTabDraft, t]);

  /**
   * The orphan sweep: delete the vault blobs no document references any more.
   *
   * It refuses in two cases, both of them stated to the user rather than hidden. An
   * incomplete inventory means the reference graph is unknown. An unreachable peer channel
   * means another window's live documents are invisible, and sweeping then would delete
   * the only copy of something this window never heard about.
   */
  const sweepVault = useCallback(async () => {
    try {
      if (channel === null || !channel.canReachPeers()) {
        setNotice(t('vault.sweepNoChannel'));
        return;
      }
      await channel.runExclusive(async () => {
        await channel.probe();
        const queued = draftWrites.current.then(async () => {
          const inventory = await readInventory();
          const storedSources = (await draftStorage.listSources?.()) ?? [];
          const plan = planVaultCleanup({
            open: openVaultKeys(),
            storedSources,
            inventory,
            peerReferences: channel.peerReferences(),
          });
          if (!plan.ok) {
            setNotice(t('vault.incomplete'));
            return;
          }
          for (const key of plan.deleteKeys) await draftStorage.deleteSource(key);
          setNotice(
            plan.deleteKeys.length === 0
              ? t('vault.sweepNothing')
              : t('vault.swept', { count: plan.deleteKeys.length }),
          );
        });
        draftWrites.current = queued.catch(() => undefined);
        await queued;
      });
    } catch (error) {
      const failure = error instanceof ToolError ? error : new ToolError('write-failed', { engine: 'model' });
      setNotice(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    }
  }, [channel, draftStorage, openVaultKeys, readInventory, t]);

  /**
   * Offline readiness: what the worker's cache actually
   * holds for **this build**, said as it is.
   *
   * `null` is not "nothing is ready": it is "there is no service worker to ask", and the
   * two are different problems with different answers — the previous readiness path could
   * only answer the second one, by looking for a substring in whatever URLs it found.
   * The names `incompleteCapabilities` returns are capability ids (`mupdf`, `tesseract`),
   * joined into the sentence as identifiers, like the engine step ids in a report.
   */
  const checkOffline = useCallback(async () => {
    const readiness = await requestOfflineReadiness();
    if (readiness === null) {
      setNotice(t('offline.unavailable'));
      return;
    }
    const missing = incompleteCapabilities(readiness);
    setNotice(
      missing.length === 0
        ? t('offline.ready')
        : t('offline.incomplete', { count: missing.length, facts: missing.join(', ') }),
    );
  }, [t]);

  /**
   * Fill the cache for the capabilities core editing needs.
   *
   * A preparation that was interrupted is not rounded up to success: `failed` is the
   * paths that did not arrive, and it is reported with the count that did — the failure
   * mode this command exists to make visible is the user believing a half-downloaded
   * package is ready. Readiness is re-read afterwards, so the sentence after the work
   * describes the cache as it now is rather than as the pass intended it.
   */
  const prepareOfflinePackages = useCallback(async () => {
    const required = requiredCapabilities({ ocr: false });
    const result = await prepareOffline(required);
    if (result === null) {
      setNotice(t('offline.unavailable'));
      return;
    }
    if (result.failed.length > 0) {
      setNotice(t('offline.prepareFailed', { count: result.prepared, failed: result.failed.length }));
      return;
    }
    const readiness = await requestOfflineReadiness();
    const missing = readiness === null ? [] : incompleteCapabilities(readiness);
    if (missing.length === 0) {
      setNotice(t('offline.prepared', { count: result.prepared }));
      return;
    }
    setNotice(
      noticeLine(
        [
          { key: 'offline.prepared', params: { count: result.prepared } },
          { key: 'offline.incomplete', params: { count: missing.length, facts: missing.join(', ') } },
        ],
        t,
      ),
    );
  }, [t]);

  const toggleSensitiveSession = useCallback(() => {
    if (activeTab === null) return;
    const next = !activeTab.sensitive;
    store.setSensitive(activeTab.id, next);
    if (!next) {
      setNotice(t('redact.sensitive.off'));
      return;
    }
    // Turning the opt-out **on** is also the moment the stored copies go: leaving them
    // behind would make the toggle a label rather than a decision.
    setNotice(t('redact.sensitive.on'));
    draftWrites.current = draftWrites.current
      .then(() => forgetTabDraft(activeTab.id))
      .then((removed) => {
        if (removed === null) setNotice(t('vault.incomplete'));
      })
      .catch(() => setNotice(t('error.write-failed.message')));
  }, [activeTab, forgetTabDraft, store, t]);

  const opfsSave = useCallback(async () => {
    if (activeTab === null) return;
    if (activeTab.sensitive) {
      setNotice(t('redact.sensitive.on'));
      return;
    }
    try {
      // The same implementation the automatic save uses, and the same write queue: a
      // manual save that took its own path wrote a manifest against a source key nothing
      // ever stored, and could race the debounced one.
      const queued = draftWrites.current.then(() => persistTabDraft(activeTab.id));
      // The queue's own copy swallows the failure so later writes still run; the promise
      // below is what carries the error to the user.
      draftWrites.current = queued.catch(() => undefined);
      const outcome: PersistOutcome = await queued;
      if (outcome === 'written') setNotice(t('setting.opfsSaved'));
      else if (outcome === 'sensitive') setNotice(t('redact.sensitive.on'));
    } catch (error) {
      const failure = error instanceof ToolError ? error : new ToolError('write-failed', { engine: 'model' });
      setNotice(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    }
  }, [activeTab, persistTabDraft, t]);

  const handleDocumentReleased = useCallback((handle: PdfDocumentHandle) => {
    releasedHandles.current.add(handle);
    if (!retiredHandles.current.delete(handle)) return;
    void handle.destroy().catch(() => setNotice(tRef.current('notice.engineReleaseFailed')));
  }, []);

  const setHandle = useCallback(
    (tabId: string, handle: PdfDocumentHandle) => {
      const previous = handles.current.get(tabId);
      handles.current.set(tabId, handle);
      setHandleVersion((version) => version + 1);
      if (previous !== undefined && previous !== handle) {
        // The pane releases its painted predecessor only when replacement pixels
        // are ready. A fixed timeout could destroy it in the middle of a slow delete.
        retiredHandles.current.add(previous);
        if (releasedHandles.current.has(previous)) handleDocumentReleased(previous);
      }
    },
    [handleDocumentReleased],
  );

  const contextFor = useCallback(
    (tab: SessionTab, handle: PdfDocumentHandle): DocumentContext => ({ store, t, tab, handle }),
    [store, t],
  );

  /**
   * The form inventory follows the working version: `working.id` changes when an
   * operation lands, and a stale list would offer to fill a field that no longer
   * exists. `readFormFields` is a read, so the cost is one parse of the bytes the
   * viewer already holds.
   */
  useEffect(() => {
    void inspectionRevision;
    const tab = activeTab;
    const handle = activeHandle;
    if (tab === null || handle === null) {
      setFormInventory(null);
      return undefined;
    }
    const controller = new AbortController();
    setFormInventory({ tabId: tab.id, version: tab.working.id });
    void (async () => {
      try {
        const bytes = await materializeBase(contextFor(tab, handle), { signal: controller.signal });
        const fields = await readFormFields(bytes, controller.signal);
        if (!controller.signal.aborted) setFormInventory({ tabId: tab.id, version: tab.working.id, fields });
      } catch (error) {
        if (!controller.signal.aborted)
          setFormInventory({
            tabId: tab.id,
            version: tab.working.id,
            error: error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' }),
          });
      }
    })();
    return () => controller.abort();
    // `activeTab` carries `working.id`: the effect re-runs when an operation lands,
    // which is exactly when the inventory can have changed.
  }, [activeTab, activeHandle, contextFor, inspectionRevision]);

  /**
   * Document facts for the properties panel: fonts,
   * embedded files, security and the four-state signature verdict. Read per working
   * version — a font list from a previous version is not a fact about this one.
   */
  const [auditReport, setAuditReport] = useState<RedactionAudit | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  /**
   * The signature a pending save would touch, and whether that save rewrites the file.
   * The prompt is state rather than a `window.confirm` so the answer is a real
   * button in the app's own surface. The decision resumes exactly the frozen
   * output operation that asked; it never authorizes a later call or another tab.
   */
  const [signatureWarning, setSignatureWarning] = useState<{
    readonly breaks: boolean;
    readonly signer: string | null;
    readonly fieldName: string;
  } | null>(null);
  const signatureDecision = useRef<((accepted: boolean) => void) | null>(null);
  const confirmSignature = useCallback(
    (signatures: readonly SignatureVerification[], incremental: boolean) => {
      const signature = signatures[0];
      if (signature === undefined) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        signatureDecision.current = resolve;
        setSignatureWarning({
          breaks: !incremental,
          signer: signature.signer,
          fieldName: signature.fieldName === '' ? t('props.sig.unnamed') : signature.fieldName,
        });
      });
    },
    [t],
  );
  /**
   * The certificates the user imported as trust roots. They live in the app's own
   * OPFS directory — a device setting, never a document fact — and the verdicts re-run
   * when the list changes, because a trust decision is exactly what a re-check is for.
   */
  const [trustRoots, setTrustRoots] = useState<readonly TrustRoot[]>([]);
  useEffect(() => {
    let live = true;
    void readAppFile('trust-roots.json').then((raw) => {
      if (live) setTrustRoots(parseTrustRoots(raw).roots);
    });
    return () => {
      live = false;
    };
  }, []);
  /** The roots as bytes, for the verifier; recomputed when the list changes. */
  const trustRootBytes = useMemo(
    () => trustRoots.map((root) => toDer(root)).filter((der): der is Uint8Array => der !== null),
    [trustRoots],
  );
  const [factsInventory, setDocumentFacts] = useState<{
    readonly tabId: string;
    readonly version: string;
    readonly fonts: readonly PdfFontInfo[];
    readonly attachments: readonly {
      readonly name: string;
      readonly description: string;
      readonly size: number | null;
    }[];
    readonly signatures: readonly SignatureVerification[];
    readonly security: { readonly encrypted: boolean; readonly permissions: readonly string[] } | null;
  } | null>(null);

  const [factsError, setFactsError] = useState<{ tabId: string; version: string; error: ToolError } | null>(
    null,
  );
  const documentFacts =
    factsInventory?.tabId === activeTab?.id && factsInventory?.version === activeTab?.working.id
      ? factsInventory
      : null;
  const currentFactsError =
    factsError !== null && factsError.tabId === activeTab?.id && factsError.version === activeTab?.working.id
      ? factsError.error
      : null;
  const canPrepareWrite = activeTab !== null && documentFacts !== null && formFields !== null && !busy;

  useEffect(() => {
    void inspectionRevision;
    const tab = activeTab;
    const handle = activeHandle;
    setFactsError(null);
    if (tab === null || handle === null) {
      setDocumentFacts(null);
      return undefined;
    }
    const controller = new AbortController();
    setDocumentFacts(null);
    void (async () => {
      try {
        const bytes = await materializeBase(contextFor(tab, handle), { signal: controller.signal });
        const [fonts, signatures, attachments, protection] = await Promise.all([
          listPdfFonts(bytes, controller.signal),
          verifySignatures(bytes, controller.signal, { roots: trustRootBytes }),
          listPdfAttachments(handle),
          inspectProtection(bytes),
        ]);
        if (controller.signal.aborted) return;
        setDocumentFacts({
          tabId: tab.id,
          version: tab.working.id,
          fonts,
          signatures,
          attachments: attachments.map((attachment) => ({
            name: attachment.filename,
            description: attachment.description,
            size: attachment.content === null ? null : attachment.content.byteLength,
          })),
          // The protection state comes from the engine's own reader, not from a
          // guess: an unencrypted document reports `encrypted: false` and no
          // permissions, which is a fact and not an empty table.
          security:
            protection === null
              ? null
              : {
                  encrypted: protection.encrypted,
                  // Only the permissions the document actually **grants** are listed:
                  // a table of every bit with a yes/no column would bury the one line
                  // the user is looking for.
                  permissions: Object.entries(protection.permissions)
                    .filter(([, granted]) => granted)
                    .map(([name]) => name),
                },
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setFactsError({
            tabId: tab.id,
            version: tab.working.id,
            error: error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' }),
          });
      }
    })();
    return () => controller.abort();
    // Same rule as the form inventory: the effect re-runs with the working version —
    // and with the trust roots, since importing one is exactly what changes a verdict.
  }, [activeTab, activeHandle, contextFor, trustRootBytes, inspectionRevision]);

  /**
   * The object-level audit of a produced redaction (first safety
   * contract). It runs on the **working bytes**, and the needles it searches for are
   * the words the user asked to erase — the audit answers "did the file keep a trace
   * of what was removed", which the redaction report alone cannot.
   */
  const runRedactionAudit = useCallback(async () => {
    const tab = store.active;
    const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
    if (tab === null || handle === null) return;
    setAuditLoading(true);
    try {
      const bytes = await materializeBase(contextFor(tab, handle));
      /**
       * The needles are the words the user erased: what the applied redactions removed
       * (read from the pre-redaction bytes, `redactedTerms`) plus whatever the marks
       * still pending cover. An empty list is not silently treated as "nothing to find"
       * — the notice below reports how many terms the scan actually had.
       */
      const pending = await redactionNeedles(
        bytes,
        pendingOverlays(tab).redactions.map((item) => item.mark),
        { signal: new AbortController().signal },
      );
      const needles = [...new Set([...(redactedTerms.current.get(tab.id) ?? []), ...pending])];
      const audit = await auditRedactedDocument(bytes, needles);
      setAuditReport(audit);
      setNotice(
        noticeLine(
          [
            auditNotice({
              terms: needles.length,
              contentFindings: audit.findings.filter((finding) => finding.severity === 'content').length,
            }),
          ],
          t,
        ),
      );
    } catch (error) {
      const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
      setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
    } finally {
      setAuditLoading(false);
    }
  }, [contextFor, store, t]);

  /** Embedded files: the three writes the properties panel offers. */
  const addAttachmentsToDocument = useCallback(
    async (files: readonly File[]) => {
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null || files.length === 0) return;
      if (busyRef.current) {
        refuseBusy();
        return;
      }
      setBusy(true);
      try {
        const base = await materializeBase(contextFor(tab, handle));
        const payloads = await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
            mime: file.type.length === 0 ? 'application/octet-stream' : file.type,
          })),
        );
        const outcome = await addAttachments(base, payloads, { signal: new AbortController().signal });
        const next = await applyProducedBytes(
          contextFor(tab, handle),
          outcome.bytes,
          tabPageCount(tab),
          { key: 'props.attach.added', params: { count: outcome.added.length } },
          outcome.report.engine,
          outcome.report.steps,
        );
        setHandle(tab.id, next);
        setNotice(t('props.attach.added', { count: outcome.added.length }));
      } catch (error) {
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        setBusy(false);
      }
    },
    [contextFor, setHandle, setBusy, store, t, refuseBusy],
  );

  const removeAttachmentFromDocument = useCallback(
    async (name: string) => {
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null) return;
      if (busyRef.current) {
        refuseBusy();
        return;
      }
      setBusy(true);
      try {
        const base = await materializeBase(contextFor(tab, handle));
        const outcome = await removeAttachments(base, [name], { signal: new AbortController().signal });
        const next = await applyProducedBytes(
          contextFor(tab, handle),
          outcome.bytes,
          tabPageCount(tab),
          { key: 'props.attach.removed', params: { count: outcome.removed.length } },
          outcome.report.engine,
          outcome.report.steps,
        );
        setHandle(tab.id, next);
        setNotice(
          outcome.missing.length > 0
            ? t('props.attach.missing', { count: outcome.missing.length })
            : t('props.attach.removed', { count: outcome.removed.length }),
        );
      } catch (error) {
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        setBusy(false);
      }
    },
    [contextFor, setHandle, setBusy, store, t, refuseBusy],
  );

  /** Write one embedded file out — the only operation that never touches the document. */
  const readAttachmentOut = useCallback(
    async (name: string) => {
      const handle = activeHandle;
      if (handle === null) return;
      try {
        const attachments = await listPdfAttachments(handle);
        const attachment = attachments.find((entry) => entry.filename === name);
        if (attachment === undefined) return;
        const bytes = await readPdfAttachment(handle, attachment);
        downloadFiles([{ name: attachment.filename, bytes, mime: 'application/octet-stream' }]);
        setNotice(t('props.attach.readNamed', { name: attachment.filename }));
      } catch (error) {
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      }
    },
    [activeHandle, t],
  );

  /**
   * One field filled from the panel: the value goes through the same operation the
   * dialog uses, then the produced bytes become the tab's working version — so the
   * change is journaled, undoable and visible in the viewer like every other edit.
   *
   * A write that would repeat the value the document already holds is dropped here, at the
   * single point every fill goes through. The inline control commits on blur as well as on
   * submit, so one edit arrived as **six identical writes** — six working versions, six
   * journal entries and six inventory reloads — and that churn is what a real press cannot
   * survive: measured, the same click that deletes two pages on a quiet panel does nothing
   * after a fill. The operation is
   * the same one the dialog uses; only a no-op is skipped.
   */
  const fillField = useCallback(
    async (name: string, value: string | boolean) => {
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null) return;
      const current = formFields?.find((field) => field.name === name);
      if (current !== undefined && fieldValueText(current.value) === String(value)) return;
      if (busyRef.current) {
        refuseBusy();
        return;
      }
      setBusy(true);
      try {
        const base = await materializeBase(contextFor(tab, handle));
        const outcome = await fillFormFields(base, [{ name, value }], {
          signal: new AbortController().signal,
        });
        const next = await applyProducedBytes(
          contextFor(tab, handle),
          outcome.bytes,
          tabPageCount(tab),
          { key: 'form.note.filled', params: { count: 1 } },
          outcome.report.engine,
          outcome.report.steps,
        );
        setHandle(tab.id, next);
        setNotice(t('op.result.applied', { label: t('panel.forms') }));
      } catch (error) {
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        setBusy(false);
      }
    },
    [contextFor, formFields, setBusy, setHandle, store, t, refuseBusy],
  );

  /**
   * Drafts: the model data of every open tab — never the source
   * bytes of a document the user opened through a handle. On startup the restorable
   * drafts come back as tabs so closing the browser is not losing work.
   */
  useEffect(() => {
    let disposed = false;
    void (async () => {
      let inventory: {
        readonly drafts: readonly Draft[];
        readonly unreadable: readonly string[];
        readonly enumerationFailed?: boolean;
      };
      if (draftStorage.readDraftInventory !== undefined) {
        inventory = await draftStorage.readDraftInventory();
      } else {
        inventory = { drafts: await draftStorage.readDrafts(), unreadable: [] };
      }
      if (inventory.enumerationFailed === true) {
        if (!disposed) setNotice(tRef.current('error.write-failed.message'));
        return;
      }
      if (inventory.unreadable.length > 0 && !disposed) {
        setNotice(tRef.current('draft.corrupt', { count: inventory.unreadable.length }));
      }
      const drafts = sortDrafts(inventory.drafts);
      let restored = 0;
      let failure: ToolError | null = null;
      for (const draft of drafts) {
        if (!isRestorable(draft)) continue;
        // A draft whose document is already open stays where it is: reopening it would
        // replace a live tab's history with the stored one, and two windows doing that at
        // once would race. The id is the identity, so the check is exact.
        if (store.getSnapshot().tabs.some((tab) => tab.id === draft.id)) continue;
        const bytes = await draftStorage.getSource(draft.sourceKey);
        if (bytes === null) {
          failure = new ToolError('corrupt-document', { engine: 'model' });
          continue;
        }
        try {
          const snapshots = [];
          for (const snapshot of draft.snapshots ?? []) {
            const data = await draftStorage.getSource(snapshot.key);
            if (data !== null) snapshots.push({ ...snapshot, bytes: data });
          }
          const working = snapshots.find((item) => item.id === draft.workingId);
          if (draft.workingId !== undefined && working === undefined)
            throw new ToolError('corrupt-document', { engine: 'model' });
          const [handle, sha256] = await Promise.all([
            openWithPdfjs(working?.bytes ?? bytes),
            sha256Hex(bytes),
          ]);
          if (disposed) {
            await handle.destroy();
            return;
          }
          if (disposed || store.getSnapshot().tabs.some((item) => item.id === draft.id)) {
            await handle.destroy();
            return;
          }
          const activeBeforeRestore = store.getSnapshot().activeId;
          // The handle the document was opened from, if one was kept (`recent-handles.ts`):
          // without it a restored tab could only Export, never Save over its file.
          const fileHandle = await getRecentHandle(draft.id);
          const tab = store.openDocument({
            id: draft.id,
            name: draft.name,
            bytes,
            sha256,
            pageCount: draft.sourcePageCount ?? draft.pageCount,
            ...(fileHandle === null ? {} : { handle: fileHandle }),
          });
          handles.current.set(tab.id, handle);
          store.restoreHistory(tab.id, draft, snapshots);
          if (activeBeforeRestore !== null) store.setActive(activeBeforeRestore);
          persistedSnapshots.current.set(
            tab.id,
            (draft.snapshots ?? []).map((item) => item.key),
          );
          if (draft.engineValues.entries.length > 0) {
            pendingEngineValues.current.set(tab.id, draft.engineValues);
          }
          if (draft.dirty) store.setDirty(tab.id, true);
          addRecentDocument({
            id: tab.id,
            name: tab.name,
            sizeBytes: (working?.bytes ?? bytes).byteLength,
            openedAt: Date.now(),
          });
          restored += 1;
        } catch (error) {
          // Report the failed draft while continuing to recover the other documents.
          failure =
            error instanceof ToolError ? error : new ToolError('corrupt-document', { engine: 'model' });
        }
      }
      if (!disposed && failure !== null) {
        setNotice(`${tRef.current(failure.messageKey)} ${tRef.current(failure.hintKey)}`);
      } else if (!disposed && restored > 0 && inventory.unreadable.length === 0) {
        setNotice(tRef.current('draft.restored', { count: restored }));
      }
      // Handles whose recent entry is gone are forgotten — after the restore, which reads them.
      if (!disposed) await pruneRecentHandles(new Set(loadRecentDocuments().map((item) => item.id)));
    })();
    return () => {
      disposed = true;
    };
    // `t` is deliberately absent: it is read through `tRef`, so switching the
    // interface language no longer replays startup recovery over live tabs.
  }, [draftStorage, store]);

  // Immutable byte snapshots are stored once; each draft update writes only model data.
  useEffect(() => {
    if (session.tabs.length === 0) return undefined;
    const timer = setTimeout(() => {
      draftWrites.current = draftWrites.current
        .then(async () => {
          for (const tab of store.getSnapshot().tabs) await persistTabDraft(tab.id);
        })
        .catch((error) => {
          const failure =
            error instanceof ToolError ? error : new ToolError('write-failed', { engine: 'model' });
          setNotice(`${tRef.current(failure.messageKey)} ${tRef.current(failure.hintKey)}`);
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [session, store, persistTabDraft]);

  useEffect(() => {
    const owned = createVaultChannel();
    liveChannel.current = owned;
    setChannel(owned);
    return () => {
      if (liveChannel.current === owned) liveChannel.current = null;
      owned.close();
    };
  }, []);

  /**
   * Tell the other windows which vault keys this one is holding, so their sweeps treat
   * them as live. `session` is the trigger because the set can only change when the
   * document model does — a new tab, a new snapshot, a closed document — and it is also
   * read here, so the dependency is real rather than incidental.
   */
  useEffect(() => {
    liveChannel.current?.announce(
      session.tabs.flatMap((tab) => [
        sourceKeyFor(tab.id, tab.source.sha256),
        ...(persistedSnapshots.current.get(tab.id) ?? []),
      ]),
    );
  }, [session]);

  const openFile = useCallback(
    async (file: File, fileHandle?: FileSystemFileHandle, password?: string) => {
      setNotice(null);
      if (busyRef.current) {
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
        const [handle, sha256] = await Promise.all([
          openWithPdfjs(bytes, password === undefined ? {} : { password }),
          sha256Hex(bytes),
        ]);
        const fileVerdict = checkDocumentLimits(tier, handle.pageCount, bytes.byteLength);
        if (fileVerdict.kind === 'blocked') {
          await handle.destroy();
          throw new ToolError(fileVerdict.reason === 'pages' ? 'page-limit' : 'file-too-large', {
            engine: 'model',
            ...(fileVerdict.reason === 'pages' ? { path: file.name } : {}),
          });
        }
        const tab = store.openDocument({
          name: file.name,
          bytes,
          sha256,
          pageCount: handle.pageCount,
          ...(fileHandle === undefined ? {} : { handle: fileHandle }),
        });
        handles.current.set(tab.id, handle);
        if (password !== undefined) {
          setLockedTabs((current) => new Map(current).set(tab.id, password));
          setNotice(t('locked.banner'));
        }
        addRecentDocument({
          id: tab.id,
          name: file.name,
          sizeBytes: file.size,
          pageCount: handle.pageCount,
        });
        setShowHomeScreen(false);
        const encrypted = (await handle.raw.getPermissions()) !== null;
        if (encrypted) store.setSensitive(tab.id, true);
        else {
          await draftStorage.putSource(sourceKeyFor(tab.id, sha256), bytes);
          // A reference to the file, never its bytes; a sensitive session keeps none.
          if (fileHandle !== undefined) await putRecentHandle(tab.id, fileHandle);
        }
        setCurrentPage(0);
        setZoomState(1);
        setSelectedPages([]);
        setRedactionMarks([]);
        if (fileVerdict.kind === 'warn') setNotice(t('limit.warn.pages'));
        if (fileVerdict.kind === 'viewing-only') {
          setNotice(
            t(fileVerdict.reason === 'pages' ? 'limit.viewingOnly.pages' : 'limit.viewingOnly.bytes'),
          );
        }
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
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        setOpening(false);
        setBusy(false);
      }
    },
    [draftStorage, setBusy, store, t, tier, setRedactionMarks, refuseBusy],
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
        await openFile(file, handle);
      } catch (error) {
        setNotice(noticeLine(failureNotices(error, 'error.corrupt-document.message'), t));
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
        types: [{ description: t('open.pdfFilter'), accept: { 'application/pdf': ['.pdf'] } }],
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
      setNotice(t('open.pickerFailed'));
      return;
    }
    if (picked === undefined) return;
    const file = await picked.getFile();
    await openFromSurface(file, picked);
  }, [openFromSurface, t]);

  /** Open produced bytes as a new tab (extract, split, unlock, image→PDF results). */
  const openProducedTab = useCallback(
    async (name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> => {
      const earlyVerdict = checkDocumentLimits(tier, 0, bytes.byteLength);
      if (earlyVerdict.kind === 'blocked') {
        throw new ToolError('file-too-large', { engine: 'model' });
      }
      const [handle, sha256] = await Promise.all([openWithPdfjs(bytes), sha256Hex(bytes)]);
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
      handles.current.set(tab.id, handle);
      addRecentDocument({
        id: tab.id,
        name,
        sizeBytes: bytes.byteLength,
        pageCount: handle.pageCount,
      });
      setShowHomeScreen(false);
      await draftStorage.putSource(sourceKeyFor(tab.id, sha256), bytes);
      setCurrentPage(0);
      setZoomState(1);
    },
    [draftStorage, store, tier],
  );

  /**
   * The review as a file (`annotation-data.ts`). The session's
   * marks leave as JSON (lossless) or FDF (the container Acrobat's own comment
   * export uses, carrying the same records), and come back the same way — a mark the
   * engine drew is in the engine's storage and a mark we own is in the session, so
   * neither travels inside the PDF until a save writes it.
   */
  const exportAnnotationData = useCallback(
    (format: 'json' | 'fdf') => {
      const tab = store.active;
      const marks = annotationsRef.current;
      if (tab === null) return;
      if (marks.length === 0) {
        setNotice(t('ann.data.empty'));
        return;
      }
      const pageCount = tabPageCount(tab);
      const bytes =
        format === 'json'
          ? serializeAnnotationsJson(marks, pageCount)
          : serializeAnnotationsFdf(marks, pageCount);
      const name = `${tab.name.replace(/\.pdf$/i, '')}-comments.${format}`;
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: format === 'json' ? 'application/json' : 'application/vnd.fdf',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      // Blob URLs are cleaned up right after the operation.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(t('ann.data.exported', { count: marks.length, name }));
    },
    [store, t],
  );

  const importAnnotationData = useCallback(
    async (file: File) => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = parseAnnotationData(bytes);
        // Acrobat's comments are in PDF user space; the page's own top edge turns them
        // into the app's space. A page the viewer cannot measure is not guessed at: its
        // comments are counted as skipped instead of landing mirrored.
        let unplaced = 0;
        const placed =
          parsed.space === 'app'
            ? parsed.marks
            : parsed.marks.flatMap((mark) => {
                const geometry = viewerApi.current?.pageGeometry(mark.pageIndex) ?? null;
                if (geometry === null) {
                  unplaced += 1;
                  return [];
                }
                return [toAppSpace(mark, geometry.y + geometry.height)];
              });
        const result = { ...parsed, marks: placed, skipped: parsed.skipped + unplaced };
        if (result.marks.length > 0) {
          /**
           * Ids are reminted at the boundary where a foreign file becomes session
           * state. JSON import mints fresh ids, but FDF carries the `/NM` the file was
           * annotated with (`ops/annotation-data.ts`), and that name is not unique
           * across documents — two imports of the same review, or an import over a
           * session that already holds the mark, would produce duplicate identities.
           * Duplicate ids break React keys and make one erase delete several marks,
           * which is exactly the "mark count" defect this work removes.
           */
          setAnnotations((current) => {
            const used = new Set(current.map((mark) => mark.id));
            const imported = result.marks.map((mark) => {
              if (!used.has(mark.id)) {
                used.add(mark.id);
                return mark;
              }
              let id = crypto.randomUUID();
              while (used.has(id)) id = crypto.randomUUID();
              used.add(id);
              return { ...mark, id };
            });
            return [...current, ...imported];
          });
          const id = store.active?.id;
          if (id !== undefined) store.setDirty(id, true);
        }
        setNotice(
          result.skipped === 0
            ? t('ann.data.imported', { count: result.marks.length })
            : `${t('ann.data.imported', { count: result.marks.length })} ${t('ann.data.importSkipped', { count: result.skipped })}`,
        );
      } catch (error) {
        const toolError =
          error instanceof ToolError ? error : new ToolError('unsupported-format', { engine: 'model' });
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      }
    },
    [store, t, setAnnotations],
  );

  /**
   * Takes over every annotation the engine's editor produced, and **returns them**.
   *
   * The engine holds its editors in `annotationStorage`, where the next
   * `saveDocument()` would write them. The app needs them in its own list first —
   * the journal, the comment panel and the retag step all read that list — so each
   * captured entry becomes a mark and its storage entry is removed. Leaving it
   * would make the same annotation arrive twice: once from the storage and once
   * from our own writer.
   *
   * Returning the list, not only storing it, is what lets a save/export started in
   * the same tick see the marks it just captured: the state update has not rendered
   * by then.
   */
  const annotationStyleRef = useRef({
    color: annotationColor,
    opacity: annotationOpacity,
    author: annotationAuthor,
  });
  annotationStyleRef.current = {
    color: annotationColor,
    opacity: annotationOpacity,
    author: annotationAuthor,
  };
  const takeEngineAnnotations = useCallback(
    (api: ViewerApi | null = viewerApi.current): readonly AnnotationMark[] => {
      if (api === null || api.document !== handles.current.get(store.active?.id ?? '')) return [];
      const entries = api.captureAnnotationEntries();
      if (entries.length === 0) return [];
      const boxes: { x: number; y: number; width: number; height: number }[] = [];
      for (let index = 0; index < api.document.pageCount; index += 1) {
        // PDF **user space**, not CSS pixels: the engine's own records and this
        // model both express geometry in points from the page's top-left. Mixing
        // the two mapped every captured mark onto the wrong part of the page —
        // a 1527 px page box against 841.89 pt of geometry (2026-09-16).
        const geometry = api.pageGeometry(index);
        if (geometry === null) continue;
        boxes[index] = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
      }
      const marks = marksFromEngineEntries(entries, boxes, {
        // Read from the ref, never from the render that created this callback: the
        // engine's own record wins where it carries a value, and these are only the
        // defaults for the ones it does not.
        color: annotationStyleRef.current.color,
        opacity: annotationStyleRef.current.opacity,
        author: annotationStyleRef.current.author,
      });
      if (marks.length === 0) return [];
      for (const mark of marks) api.dropAnnotationEntry(mark.id);
      const current = pendingOverlays(store.active).annotations;
      // Engine ids restart when history reopens the viewer. They identify entries
      // only until removal, never durable marks: reusing one would lose the next
      // stroke after undo/redo by confusing it with a restored owned annotation.
      const added = marks.map((mark) => ({ ...mark, id: crypto.randomUUID() }));
      setAnnotations([...current, ...added]);
      setNotice(t('ann.captured', { count: marks.length }));
      // Returned as well as stored: a writer that runs in the same tick reads the
      // fresh marks from here, because the state update above has not rendered yet
      // (`workingBytes` — the export path lost exactly these marks).
      return added;
    },
    // No tool setting is a dependency: this callback is handed to `PdfViewerPane`,
    // whose load effect depends on it, and reading the style from the ref is what
    // stops "change the colour" from tearing down and rebuilding the pdf.js stack.
    [setAnnotations, store, t],
  );
  const takeEngineAnnotationsRef = useRef(takeEngineAnnotations);
  takeEngineAnnotationsRef.current = takeEngineAnnotations;

  /**
   * Restore engine-held annotation records from drafts into controlled session marks.
   * New gestures already belong to the session and never enter native editors.
   *
   * Returns whether the engine still holds entries this app cannot model (a signature
   * or stamp editor it never armed, or a value restored from a draft): those must be
   * materialised into bytes before a common gesture can reach them, and the caller is
   * the only place that knows whether it can afford the write.
   */
  const settleNativeEditors = useCallback((): boolean => {
    const api = viewerApi.current;
    if (api === null) return false;
    takeEngineAnnotationsRef.current(api);
    return api.captureAnnotationEntries().length > 0;
  }, []);

  /**
   * Write the engine's unmodellable entries into the bytes and mount the result as
   * the working version.
   *
   * This is the only path that reaches those entries at all: they are invisible to
   * every list and tool, and the engine's own `saveDocument()` would write them on
   * the next save anyway — so materialising them turns "silently kept, silently
   * written" into a version the journal, the comment panel and the common layer can
   * all see. The marks this session holds are written by the same pass and the
   * pending lists are then cleared, exactly as a save clears them.
   */
  const materializeOrphanAnnotations = useCallback(async (): Promise<void> => {
    if (busyRef.current || cancelRef.current !== null) return;
    const tab = store.getSnapshot().tabs.find((item) => item.id === store.active?.id) ?? null;
    const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
    if (tab === null || handle === null) return;
    const controller = new AbortController();
    cancelRef.current = controller;
    setBusy(true);
    try {
      const executed: SaveStepDescription[] = [];
      const bytes = await materializeBase(contextFor(tab, handle), { signal: controller.signal }, executed);
      if (
        controller.signal.aborted ||
        store.active?.id !== tab.id ||
        store.getSnapshot().tabs.find((item) => item.id === tab.id)?.working.id !== tab.working.id
      )
        return;
      const next = await applyProducedBytes(
        contextFor(tab, handle),
        bytes,
        tabPageCount(tab),
        { key: 'ann.engineEdit' },
        executed[executed.length - 1]?.engine ?? 'pdfjs',
        executed.map((step) => step.id),
        { signal: controller.signal },
      );
      setHandle(tab.id, next);
    } catch (error) {
      if (controller.signal.aborted) return;
      const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
      setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
    } finally {
      if (cancelRef.current === controller) {
        cancelRef.current = null;
        setBusy(false);
      }
    }
  }, [contextFor, setBusy, setHandle, store, t]);

  /**
   * The orphan sweep in flight, if any.
   *
   * The sweep replaces the working version, so it holds the operation lock while it
   * runs — but a gesture that lands *during* it is not a gesture that must be refused:
   * erasing a mark a moment after the tool was armed is exactly the expected sequence.
   * Keeping the promise lets the removal path wait for the sweep instead of reporting
   * a busy document to a user who did nothing wrong.
   */
  const orphanSweep = useRef<Promise<void> | null>(null);
  const sweepOrphanAnnotations = useCallback((): Promise<void> => {
    const run = materializeOrphanAnnotations();
    const tracked = run.then(
      () => {
        if (orphanSweep.current === tracked) orphanSweep.current = null;
      },
      () => {
        if (orphanSweep.current === tracked) orphanSweep.current = null;
      },
    );
    orphanSweep.current = tracked;
    return tracked;
  }, [materializeOrphanAnnotations]);

  /**
   * Entering select hands the pointer to the common layer, and a restored native
   * gesture must not be left half-open when it does: pdf.js keeps its editor in
   * `annotationStorage` until something commits it, and an entry left there is
   * invisible to every list — so it is committed and taken over, and any entry this
   * app cannot model is materialised into bytes rather than silently kept.
   */
  useEffect(() => {
    if (markMode === null) return;
    if (!settleNativeEditors()) return;
    void sweepOrphanAnnotations();
  }, [markMode, settleNativeEditors, sweepOrphanAnnotations]);

  /**
   * Store the roots the panel parsed. The parsing lives in the panel's chunk — it
   * needs pkijs, and the shell must not carry it (see `pdf-ui/panels/trust-roots.ts`).
   */
  const storeTrustRoots = useCallback(
    (imported: readonly TrustRoot[]) => {
      let next: TrustRootsFile = { version: 1, roots: trustRoots };
      for (const root of imported) next = addTrustRoot(next, root);
      setTrustRoots(next.roots);
      void writeAppFile('trust-roots.json', next);
      setNotice(t('props.sig.roots.added', { count: imported.length }));
    },
    [t, trustRoots],
  );

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
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null) return null;

      if (
        documentFacts?.tabId !== tab.id ||
        documentFacts.version !== tab.working.id ||
        currentForms?.tabId !== tab.id ||
        currentForms.version !== tab.working.id ||
        formFields === null
      ) {
        setNotice(
          t(currentFactsError !== null || currentForms?.error ? 'inspection.failed' : 'inspection.loading'),
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
        setNotice(`${t('error.pending-redactions.message')} ${t('error.pending-redactions.hint')}`);
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
        (bytes) => verifySignatures(bytes, controller.signal, { roots: trustRootBytes }),
        appliedVersionBytes(tab, store.snapshotsFor(tab.id)),
      );
      if (warning !== null && !(await confirmSignature(warning.signatures, warning.fate === 'appended'))) {
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
        expectedPageCount: tabPageCount(tab),
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
    [
      confirmSignature,
      contextFor,
      currentFactsError,
      currentForms,
      documentFacts,
      editableOverlays,
      formFields,
      store,
      t,
      trustRootBytes,
    ],
  );

  const saveActive = useCallback(
    async (tabId = store.active?.id): Promise<boolean> => {
      const tab = store.getSnapshot().tabs.find((item) => item.id === tabId) ?? null;
      if (tab === null) return false;
      if (saveLock.current || busyRef.current) {
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
      setNotice(null);
      setBusy(true);
      try {
        let target = tab.source.handle;
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
        setNotice(
          noticeLine(
            [{ key: 'save.done', params: { name: preparedTab.name } }, ...verificationNotices(verification)],
            t,
          ),
        );
        return true;
      } catch (error) {
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
        return false;
      } finally {
        if (cancelRef.current === controller) cancelRef.current = null;
        saveLock.current = false;
        setBusy(false);
      }
    },
    [prepareOutput, refuseBusy, setBusy, store, t],
  );

  const discardTab = useCallback(
    (id: string) => {
      if (store.active?.id === id) cancelRef.current?.abort();
      const abandoned = handles.current.get(id);
      handles.current.delete(id);
      if (abandoned !== undefined) {
        // Closing a tab is not a place where a failure may be swallowed, and it
        // is not a place where one may be thrown at the user either: the document is
        // gone from the session, so the release is reported and the close proceeds.
        void abandoned.destroy().catch(() => setNotice(tRef.current('notice.engineReleaseFailed')));
      }
      store.closeTab(id);
      pendingEngineValues.current.delete(id);
      redactedTerms.current.delete(id);
      draftWrites.current = draftWrites.current
        .then(async () => {
          // The reference graph is read fresh and *whole*: the previous version derived it
          // from `readDrafts()`, which reports an unreadable or unlistable vault as “no
          // drafts” — the exact input that makes a shared source blob look unreferenced.
          // An incomplete inventory deletes nothing and says so.
          const removed = await forgetTabDraft(id);
          if (removed === null) setNotice(tRef.current('vault.incomplete'));
        })
        .catch(() => setNotice(tRef.current('error.write-failed.message')));
    },
    [store, forgetTabDraft],
  );

  const closeTab = useCallback(
    (id: string) => {
      if (busyRef.current || cancelRef.current !== null || dialogSpec !== null) {
        refuseBusy();
        return;
      }
      const tab = store.getSnapshot().tabs.find((item) => item.id === id);
      if (tab === undefined) return;
      const handle = handles.current.get(id);
      if (tab.dirty || (handle !== undefined && hasEngineEdits(handle))) {
        closeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        store.setActive(id);
        setNotice(null);
        setCloseRequest(id);
        return;
      }
      discardTab(id);
    },
    [discardTab, dialogSpec, refuseBusy, store],
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
        setExistingInventory(null);
        return;
      }
      releasedHandles.current.delete(api.document);
      setZoomState(api.getZoom());
      takeEngineAnnotationsRef.current(api);
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
          setExistingInventory({ tabId: tab.id, bytesKey, annotations: found });
        })
        .catch((error) => {
          if (viewerApi.current !== api) return;
          // A failed read is unknown, not an empty document. Keep saved-mark edits
          // unavailable rather than normalizing against an invented empty inventory.
          setExistingInventory(null);
          const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'pdfjs' });
          setNotice(t(failure.messageKey));
        });
      // A draft that carried engine-side edits applies them as soon as its document is
      // the one on screen; the tab stays dirty until a real save writes them.
      const id = store.active?.id;
      if (id === undefined) return;
      const pending = pendingEngineValues.current.get(id) ?? pendingOverlays(store.active).engineValues;
      if (pending === undefined) return;
      void api
        .applyEngineValues(pending)
        .then((applied) => {
          if (viewerApi.current !== api) return;
          // The staged copy goes only once the engine has taken it: a rejection
          // must leave the entries where a retry can still reach them, and a restore
          // that applied **nothing** is reported with its own count instead of the
          // silence the previous version kept for exactly that case.
          pendingEngineValues.current.delete(id);
          takeEngineAnnotationsRef.current(api);
          const restoration = noticeLine(
            engineValuesNotices({ applied, carried: pending.entries.length, dropped: pending.dropped }),
            t,
          );
          // A successful byte edit restores the carried form state as part of its
          // redraw. Keep that operation's result; incomplete restoration still wins.
          setNotice((previous) =>
            applied < pending.entries.length || pending.dropped > 0 ? restoration : (previous ?? restoration),
          );
        })
        .catch((error) => {
          if (viewerApi.current !== api) return;
          // The delta stays staged: it is the only copy of edits the document cannot see.
          setNotice(noticeLine(failureNotices(error, 'error.write-failed.message'), t));
        });
    },
    [store, t],
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
    if (api === null || tab === null || api.document !== handles.current.get(tab.id)) return false;
    const engineValues = await api.captureEngineValues();
    if (viewerApi.current !== api) return false;
    const latest = store.getSnapshot().tabs.find((item) => item.id === tab.id);
    if (
      latest === undefined ||
      store.active?.id !== tab.id ||
      handles.current.get(tab.id) !== api.document ||
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
    if (api === null || tab === null || api.document !== handles.current.get(tab.id)) return;
    takeEngineAnnotations(api);
    void checkpointEngineValues().catch((error) => {
      const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'pdfjs' });
      setNotice(t(failure.messageKey));
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
      if (busyRef.current) {
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
        setNotice(
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
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        if (cancelRef.current === controller) cancelRef.current = null;
        setBusy(false);
      }
    },
    [prepareOutput, refuseBusy, setBusy, store, t],
  );

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement === null) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  }, []);

  /**
   * Dialog opening materialises the base **first**: the dialog's `run` receives
   * frozen bytes, so a form value typed a second earlier cannot be lost between
   * opening the panel and pressing Apply.
   */
  /**
   * Open an operation that starts a document (`isStandaloneDialog`). It needs no tab and
   * freezes no bytes, so it skips everything `openDialog` does for a document and only
   * loads its spec; `StartDialog` hosts it and `handleStartResult` opens its result.
   */
  const openStart = useCallback(
    (id: string) => {
      if (busyRef.current) {
        refuseBusy();
        return;
      }
      setNotice(null);
      void dialogById(id).then((spec) => {
        if (spec !== undefined) setStartSpec(spec);
      });
    },
    [refuseBusy],
  );

  const openDialog = useCallback(
    (id: string, presets?: Readonly<Record<string, FieldValue>>) => {
      if (!hasDialog(id)) return;
      if (isStandaloneDialog(id)) {
        openStart(id);
        return;
      }
      // The tab and its handle are read at call time, like every other entry
      // point: a control one render old must not freeze the previous handle.
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null) return;
      setNotice(null);
      if (busyRef.current || cancelRef.current !== null) {
        refuseBusy();
        return;
      }
      const controller = new AbortController();
      cancelRef.current = controller;
      setBusy(true);
      /**
       * The frozen bytes are only valid for the version they came from: a tab
       * switch, a close or an operation landing while this runs makes them an
       * input to a document that is no longer in front. The check runs after
       * every `await`, so the dialog either opens with a coherent input or does
       * not open at all.
       */
      const stale = () => {
        const current = store.active;
        return controller.signal.aborted || current?.id !== tab.id || current.working.id !== tab.working.id;
      };
      void (async () => {
        try {
          const bytes = await materializeBase(contextFor(tab, handle), { signal: controller.signal });
          if (stale()) return;
          // The spec is a dynamic import: a capability's dialog code loads when the
          // capability is opened, which is what keeps fifteen dialogs out of the
          // first-paint bundle.
          const spec = await dialogById(id);
          if (spec === undefined || stale()) return;
          if (spec.changesPageGeometry && pendingOverlays(tab).redactions.length > 0) {
            throw new ToolError('pending-redactions', { engine: 'model' });
          }
          // The image dialog's target list is document data, so it is read here, from
          // the same frozen bytes the run receives (`pdf-core/ops/image-edit.ts`).
          const listing =
            id === 'image-edit'
              ? await listPdfImages(bytes, { signal: controller.signal }).then((images) => images.images)
              : null;
          if (stale()) return;
          setImages(listing);
          setDialogInput({
            tabId: tab.id,
            workingId: tab.working.id,
            name: tab.name,
            pageCount: tabPageCount(tab),
            bytes,
            ...(presets === undefined ? {} : { presets }),
          });
          setDialogSpec(spec);
          setDialogId(id);
          // **Every operation opens in the tools panel**, beside the document it will
          // change. It used to open there only when that tab happened to be showing and
          // as a modal otherwise — the same capability in two places, with two sets of
          // buttons. Modals are kept for the decisions that block (password, close,
          // signature warning, export choice, print).
          setRightDock(true);
          setRightTab('tools');
        } catch (error) {
          if (controller.signal.aborted) return;
          const toolError =
            error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
          setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
        } finally {
          if (cancelRef.current === controller) {
            cancelRef.current = null;
            setBusy(false);
          }
        }
      })();
    },
    // `existingAnnotations` and the takeover are part of the call: the dialog host
    // freezes the same working bytes a save writes, marks included.
    [contextFor, openStart, setBusy, store, t, refuseBusy],
  );

  /**
   * The Help menu's shortcut list. It is deliberately not `openDialog`: that path
   * freezes the open document's bytes for a run, and help has no document, no bytes
   * and no run — it answers with no tab open, in either interface mode.
   *
   * A modal surface takes the pointer, so an armed tool is put away first, exactly as
   * the palette does it: a measure overlay left armed under the dialog would swallow
   * its clicks.
   */
  const showShortcuts = useCallback(() => {
    /**
     * `document.activeElement` is `<body>` whenever nothing holds the focus, and `<body>`
     * is an `HTMLElement` that stays connected for the life of the page: storing it would
     * make the close path below "focus `<body>`" — the one outcome it exists to prevent.
     * Only an element that was really focused counts as the opener.
     */
    const opener = document.activeElement;
    shortcutsTrigger.current = opener instanceof HTMLElement && opener !== document.body ? opener : null;
    setCanvasTool('select');
    setShortcutsOpen(true);
  }, []);

  const closeShortcuts = useCallback(() => {
    setShortcutsOpen(false);
    /**
     * Focus goes back where it came from, or to the shell's own first control: the
     * opener is often a menu trigger that is still mounted, but the palette's search
     * field is not, and a dialog that leaves focus on `<body>` costs the keyboard user
     * their place. The same rule the close-tab prompt follows.
     */
    requestAnimationFrame(() => {
      const target = shortcutsTrigger.current;
      if (target?.isConnected) target.focus();
      else document.querySelector<HTMLElement>('[role="menubar"] [role="menuitem"], main button')?.focus();
    });
  }, []);

  /**
   * The left rail's selection. It writes **only** the canonical tool: the rail's ids
   * *are* canonical ids, so "which button is pressed" and "which tool owns the pointer"
   * cannot disagree — the divergence this replaces came from the rail writing a second
   * state of its own that no other route updated.
   *
   * The note is the one entry with a second half: its marks are comments, so arming it
   * opens the comment dock the user will edit them in.
   */
  const handleSelectLeftTool = useCallback((tool: CanvasToolId) => {
    setCanvasTool(tool);
    if (tool === 'note') {
      setRightDock(true);
      setRightTab('comments');
    }
  }, []);

  /**
   * The header's tools toggle: the tools panel is either what the right dock shows or
   * it is not, so a second press closes the dock rather than re-selecting the tab.
   */
  const toggleToolsPanel = useCallback(() => {
    if (rightDock && rightTab === 'tools') setRightDock(false);
    else {
      setRightDock(true);
      setRightTab('tools');
    }
  }, [rightDock, rightTab]);

  /** Build an unlocked copy of a protected tab, in a new tab; the original stays protected. */
  const unlockActiveCopy = useCallback(async () => {
    const tab = store.active;
    const password = tab === null ? undefined : lockedTabs.get(tab.id);
    if (tab === null || password === undefined || busyRef.current) return;
    setBusy(true);
    const controller = new AbortController();
    // The progress overlay's Cancel aborts `cancelRef`: registering the run is what makes
    // that button stop this work rather than nothing.
    cancelRef.current = controller;
    try {
      const { unlockDocument } = await import('pdf-core/ops/security');
      const outcome = await unlockDocument(copyForEngine(tab.source.master), password, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      await openProducedTab(
        tab.name.replace(/\.pdf$/i, `-${t('security.unlock.suffix')}.pdf`),
        outcome.bytes,
      );
      setNotice(t('locked.done'));
    } catch (error) {
      const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'mupdf' });
      setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
    } finally {
      if (cancelRef.current === controller) cancelRef.current = null;
      setProgress(null);
      setBusy(false);
    }
  }, [lockedTabs, openProducedTab, setBusy, store, t]);

  const handleExportWithOptions = useCallback(
    (options: {
      kind: 'pdf' | 'compressed' | 'images' | 'text';
      compressionLevel?: string;
      imageFormat?: string;
    }) => {
      if (options.kind === 'pdf') {
        void exportActive();
      } else if (options.kind === 'compressed') {
        // The level chosen in the export dialog fills the form; it was read and dropped.
        openDialog('compress', compressionPresets(options.compressionLevel));
      } else if (options.kind === 'images') {
        // The choice made in the export dialog is the form's starting value; dropping it
        // made a JPG request open a PNG form.
        openDialog('export-images', { format: options.imageFormat === 'jpg' ? 'jpeg' : 'png' });
      } else if (options.kind === 'text') {
        openDialog('export-text');
      }
    },
    [exportActive, openDialog],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const selection = window.getSelection()?.toString().trim() ?? '';
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: selection.length > 0,
      selectedText: selection,
    });
  }, []);

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

  /**
   * A dialog belongs to the version it froze. When the active tab changes — the
   * user switched, closed it, or an operation landed behind the modal — the
   * frozen input is no longer that tab's document, so the dialog is dismissed
   * instead of being applied to bytes it was never opened for.
   */
  useEffect(() => {
    const input = dialogInput;
    if (input === null) return;
    const tab = session.tabs.find((item) => item.id === input.tabId);
    if (tab === undefined || tab.working.id !== input.workingId || session.activeId !== input.tabId) {
      setDialogInput(null);
      setDialogSpec(null);
      setDialogId(null);
      setTextEdit(null);
      setImages(null);
    }
  }, [dialogInput, session]);

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
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
        setCanvasTool('select');
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
  /**
   * The session-to-bytes route the read-only panels take (`workingBytes`): the live tab and
   * handle are read at call time for the same reason a save reads them — a control rendered
   * before the last operation must not hand over the previous version.
   */
  const currentBytes = useCallback(
    async (operation: OperationContext) => {
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null) throw new ToolError('selection-empty', { engine: 'model' });
      return materializeBase(contextFor(tab, handle), operation, undefined, editableOverlays(tab));
    },
    [contextFor, editableOverlays, store],
  );

  /**
   * The accessibility writers' results arrive as bytes plus notes; they land in the session
   * exactly like every other produced file (journal entry → save router), so the panel never
   * writes a file of its own.
   */
  const applyAccessibility = useCallback(
    async (outcome: { readonly bytes: Uint8Array; readonly notes: readonly OperationNote[] }) => {
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null) return;
      const next = await applyProducedBytes(
        contextFor(tab, handle),
        outcome.bytes,
        tabPageCount(tab),
        { key: 'a11y.applied', params: { count: outcome.notes.length } },
        'mupdf',
        outcome.notes.map((note) => note.key),
      );
      setHandle(tab.id, next);
      setNotice(t('a11y.applied', { count: outcome.notes.length }));
    },
    [contextFor, setHandle, store, t],
  );

  const handleDialogResult = useCallback(
    async (result: OpRunResult) => {
      const input = dialogInput;
      if (input === null || dialogSpec === null) return;
      /**
       * The result belongs to the tab and version the dialog froze, not to
       * whatever is active when the click lands. Read both fresh from the store:
       * a tab switch or a landed operation between opening and applying must
       * refuse the result rather than write one document's bytes onto another.
       */
      const tab = store.getSnapshot().tabs.find((item) => item.id === input.tabId) ?? null;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (
        tab === null ||
        handle === null ||
        tab.working.id !== input.workingId ||
        store.active?.id !== input.tabId
      ) {
        setDialogInput(null);
        setDialogId(null);
        setDialogSpec(null);
        return;
      }
      if (busyRef.current || cancelRef.current !== null) {
        refuseBusy();
        return;
      }
      const controller = new AbortController();
      cancelRef.current = controller;
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
      const close = () => {
        setDialogId(null);
        setDialogInput(null);
        setDialogSpec(null);
      };
      try {
        const kind = result.deliver ?? dialogSpec.resultKind;
        if (kind === 'download') {
          downloadFiles(result.files);
          setNotice(
            result.noticeKey === undefined
              ? t('op.result.downloaded', { name: first?.name ?? '' })
              : t(result.noticeKey, result.noticeParams ?? {}),
          );
          close();
          return;
        }
        if (first === undefined) return;
        if (kind === 'new-tab') {
          await openProducedTab(first.name, first.bytes, controller.signal);
          setNotice(t('op.result.opened', { name: first.name }));
          close();
          return;
        }
        const next = await applyProducedBytes(
          contextFor(tab, handle),
          first.bytes,
          result.report.pageCount,
          { key: dialogSpec.titleKey },
          result.report.engine,
          result.report.steps,
          { signal: controller.signal },
          dialogSpec.id === 'redact' ? { annotations: [], measures: [], redactions: [] } : undefined,
        );
        setHandle(tab.id, next);
        if (dialogSpec.id === 'redact') {
          /**
           * The words this redaction removed, read from the bytes it ran on — the marks
           * the run received are frozen in `dialogContext`, and `input.bytes` is the
           * version they were measured against. Taken *before* the notice
           * because the audit that needs them runs later, on bytes where those words are
           * already gone.
           */
          const marks = dialogContext?.redactions ?? [];
          void redactionNeedles(input.bytes, marks, { signal: new AbortController().signal })
            .then((terms) => {
              if (terms.length === 0) return;
              const known = redactedTerms.current.get(tab.id) ?? [];
              redactedTerms.current.set(tab.id, [...new Set([...known, ...terms])]);
            })
            .catch(() => undefined);
        }
        setNotice(
          result.noticeKey === undefined
            ? t('op.result.applied', { label: t(dialogSpec.titleKey) })
            : t(result.noticeKey, result.noticeParams ?? {}),
        );
        close();
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        if (cancelRef.current === controller) {
          cancelRef.current = null;
          setBusy(false);
        }
      }
    },
    [
      contextFor,
      dialogContext,
      dialogInput,
      dialogSpec,
      openProducedTab,
      setBusy,
      setHandle,
      store,
      t,
      refuseBusy,
    ],
  );

  /**
   * The result of a standalone operation: it has no document to replace, so it either
   * downloads or opens as a new tab, and the modal closes once that has happened.
   */
  const handleStartResult = useCallback(
    async (result: OpRunResult) => {
      const spec = startSpec;
      if (spec === null) return;
      const first = result.files[0];
      if ((result.deliver ?? spec.resultKind) === 'download') {
        downloadFiles(result.files);
        setNotice(t('op.result.downloaded', { name: first?.name ?? '' }));
        setStartSpec(null);
        return;
      }
      if (first === undefined) return;
      if (busyRef.current || cancelRef.current !== null) {
        refuseBusy();
        return;
      }
      const controller = new AbortController();
      cancelRef.current = controller;
      setBusy(true);
      try {
        await openProducedTab(first.name, first.bytes, controller.signal);
        setStartSpec(null);
        setNotice(t('op.result.opened', { name: first.name }));
      } catch (error) {
        if (controller.signal.aborted) return;
        setNotice(noticeLine(failureNotices(error, 'error.internal.message'), t));
      } finally {
        if (cancelRef.current === controller) {
          cancelRef.current = null;
          setBusy(false);
        }
      }
    },
    [openProducedTab, refuseBusy, setBusy, startSpec, t],
  );

  /** What a standalone operation runs against: no bytes, no pages, nothing selected. */
  const startContext: OperationRunContext = useMemo(
    () => ({ bytes: new Uint8Array(0), pageCount: 0, name: '', currentPage: 0, selectedPages: [], t }),
    [t],
  );

  /**
   * A writer ran on the working document: journal it, swap the handle, and say what the
   * report said.
   *
   * Three panels now reach a MuPDF writer this way (layer state, attachments add and
   * remove), and the rules they share are the ones that are easy to get subtly wrong:
   * a report that changed nothing must not be journaled (`incremental: true` is the op's
   * own "same bytes back"), the notice carries every note the report is not merely
   * preserving — warnings and losses included, because a panel has no report surface —
   * and the handle swap is what makes the produced bytes the working version.
   */
  const applyWriterOutcome = useCallback(
    async (
      tab: SessionTab,
      handle: PdfDocumentHandle,
      outcome: OperationOutcome,
      labelKey: MessageKey,
    ): Promise<void> => {
      if (outcome.report.incremental) {
        const unchanged = outcome.report.notes.find((entry) => entry.kind !== 'preserved');
        setNotice(unchanged === undefined ? t(labelKey) : t(unchanged.key, unchanged.params ?? {}));
        return;
      }
      const next = await applyProducedBytes(
        contextFor(tab, handle),
        outcome.bytes,
        outcome.report.pageCount,
        { key: labelKey },
        outcome.report.engine,
        outcome.report.steps,
      );
      setHandle(tab.id, next);
      const spoken = outcome.report.notes
        .filter((entry) => entry.kind !== 'preserved')
        .map((entry) => t(entry.key, entry.params ?? {}));
      setNotice(spoken.length === 0 ? t(labelKey) : spoken.join(' '));
    },
    [contextFor, setHandle, t],
  );

  /**
   * The layers panel writes the view state it shows into the file
   * (“layers (OCG) view/edit”).
   *
   * The panel holds the engine's view state and no bytes; this file holds the bytes and
   * no view, so the request travels from there to here — the same ownership rule every
   * other write follows. The bytes are the *working* document, session marks included,
   * so a layer write cannot drop an annotation the user has drawn but not yet saved.
   */
  const writeLayers = useCallback(
    async (request: LayerWriteRequest) => {
      const tab = activeTab;
      const handle = activeHandle;
      if (tab === null || handle === null) return;
      // Read at call time, like every other control that replaces the handle: a panel
      // rendered one commit earlier holds that commit's closure.
      if (busyRef.current) {
        refuseBusy();
        return;
      }
      setBusy(true);
      try {
        const bytes = await materializeBase(contextFor(tab, handle), {
          signal: new AbortController().signal,
        });
        const outcome = await applyLayerWrite(bytes, request, { signal: new AbortController().signal });
        await applyWriterOutcome(tab, handle, outcome, 'panel.layers');
      } catch (error) {
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        setBusy(false);
      }
    },
    [activeTab, activeHandle, applyWriterOutcome, contextFor, setBusy, t, refuseBusy],
  );

  /**
   * The attachments panel's two writes (“attachments add/remove”).
   * Same route as the layer write: the panel hands over the picked files (or the names to
   * drop) and the shell runs the operation on the working document.
   */
  const writeAttachments = useCallback(
    async (request: { readonly add?: readonly File[]; readonly remove?: readonly string[] }) => {
      const tab = activeTab;
      const handle = activeHandle;
      if (tab === null || handle === null) return;
      if (busyRef.current) {
        refuseBusy();
        return;
      }
      setBusy(true);
      try {
        const bytes = await materializeBase(contextFor(tab, handle), {
          signal: new AbortController().signal,
        });
        const operation = { signal: new AbortController().signal };
        let outcome: OperationOutcome;
        if (request.add !== undefined && request.add.length > 0) {
          const additions = await Promise.all(
            request.add.map(async (file) => ({
              name: file.name,
              // `File.arrayBuffer` is the only read that does not need a URL or a reader,
              // and the bytes are what the writer embeds. A browser that knows nothing
              // about the type says `''`, and the writer stores that as no `/Subtype`.
              bytes: new Uint8Array(await file.arrayBuffer()),
              mime: file.type,
            })),
          );
          outcome = await addAttachments(bytes, additions, operation);
        } else if (request.remove !== undefined && request.remove.length > 0) {
          outcome = await removeAttachments(bytes, request.remove, operation);
        } else {
          return;
        }
        await applyWriterOutcome(tab, handle, outcome, 'panel.attachments');
      } catch (error) {
        const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
        setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
      } finally {
        setBusy(false);
      }
    },
    [activeTab, activeHandle, applyWriterOutcome, contextFor, setBusy, t, refuseBusy],
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

  /**
   * **The one removal intent**: the Delete key, selection controls and comment
   * panels call this and nothing else, so every family shares one journal step.
   *
   * It takes the two paths the contract names, and which one runs is decided by the
   * request alone:
   *
   *  - **pending marks only** — one `setOverlays` call, so the whole batch (across all
   *    three session families) is a *single* journal entry and a single undo step;
   *  - **anything the file already carries** — the frozen base is materialised from the
   *    marks that survive, the persisted ids are removed by the core writer, and the
   *    result is mounted by `applyProducedBytes` with the remaining redaction intents.
   *    Nothing is applied until all of that has succeeded, and every `await` is
   *    followed by a stale check, so a failure or a document change behind the
   *    gesture leaves the original state exactly as it was.
   */
  const removeTargets = useCallback(
    (keys: readonly string[]): boolean => {
      const request = planMarkRemoval(markTargetsRef.current, keys);
      if (isEmptyRemoval(request)) return false;
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null || !canEditRef.current) return false;
      const count = removalCount(request);

      /**
       * A pending-only removal whose document has engine-side edits is not a pure
       * overlay edit either: deletion adds the step a later undo will come back
       * through, and typed form values are not in a step yet. They are captured
       * first so the deletion's own `before` carries them.
       */
      if (request.existing.length === 0 && !hasEngineEdits(handle)) {
        store.setOverlays(
          tab.id,
          pruneOverlays(editableOverlays(tab), request) as unknown as JsonValue,
          'ann.remove',
        );
        setNotice(t('ann.removed', { count }));
        return true;
      }

      /**
       * The lock is taken inside the async block, not here: when the orphan sweep is
       * running, this gesture waits for it (it is about to replace the working
       * version) instead of being refused because the shell is busy with its own
       * housekeeping.
       */
      const inFlight = orphanSweep.current;
      if (inFlight === null && (busyRef.current || cancelRef.current !== null)) {
        refuseBusy();
        return false;
      }
      void (async () => {
        const controller = new AbortController();
        try {
          if (inFlight !== null) await inFlight;
          if (busyRef.current || cancelRef.current !== null) {
            refuseBusy();
            return;
          }
          cancelRef.current = controller;
          setBusy(true);
          await checkpointEngineValues();
          if (controller.signal.aborted) return;
          // Read the tab after the checkpoint: it journals a step of its own, so the
          // version id and the overlay state have both moved on. What must *not* have
          // moved is the document the request was planned against — the tab and the
          // bytes behind it.
          const fresh = store.getSnapshot().tabs.find((item) => item.id === tab.id) ?? null;
          if (
            fresh === null ||
            store.active?.id !== tab.id ||
            fresh.working.produced?.id !== tab.working.produced?.id
          )
            return;
          if (request.existing.length === 0) {
            store.setOverlays(
              fresh.id,
              pruneOverlays(editableOverlays(fresh), request) as unknown as JsonValue,
              'ann.remove',
            );
            setNotice(t('ann.removed', { count }));
            return;
          }
          const outcome = await removeMarkTargets(
            contextFor(fresh, handle),
            request,
            { signal: controller.signal },
            [],
            editableOverlays(fresh),
          );
          if (
            controller.signal.aborted ||
            store.active?.id !== tab.id ||
            store.getSnapshot().tabs.find((item) => item.id === tab.id)?.working.id !== fresh.working.id
          )
            return;
          const next = await applyProducedBytes(
            contextFor(fresh, handle),
            outcome.bytes,
            outcome.pageCount,
            { key: 'ann.remove', params: { count } },
            outcome.engine,
            outcome.steps,
            { signal: controller.signal },
            outcome.overlays,
          );
          setHandle(fresh.id, next);
          setNotice(t('ann.removed', { count }));
        } catch (error) {
          if (controller.signal.aborted) return;
          const toolError =
            error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
          setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
        } finally {
          if (cancelRef.current === controller) {
            cancelRef.current = null;
            setBusy(false);
          }
        }
      })();
      return true;
    },
    [checkpointEngineValues, contextFor, editableOverlays, refuseBusy, setBusy, setHandle, store, t],
  );
  const removeTargetsRef = useRef(removeTargets);
  removeTargetsRef.current = removeTargets;

  /** Geometry changes share deletion's frozen-version and engine-delta boundary. */
  const transformTargets = useCallback(
    (keys: readonly string[], transform: MarkTransform): boolean => {
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null || existingAnnotations === null) return false;
      if (busyRef.current || cancelRef.current !== null || !canEditRef.current) return false;
      if (transform.dx === 0 && transform.dy === 0 && transform.rotation === 0) return false;
      const targets = markTargetsRef.current;
      const wanted = new Set(keys);
      const count = targets.filter((target) => wanted.has(target.key)).length;
      if (count === 0) return false;
      const current = editableOverlays(tab);
      const plan = planMarkTransform(current, targets, keys, transform);
      if (plan.existing.length === 0 && !hasEngineEdits(handle)) {
        store.setOverlays(
          tab.id,
          {
            ...current,
            annotations: plan.annotations,
            measures: plan.measures,
            redactions: plan.redactions,
          } as unknown as JsonValue,
          'ann.transform',
        );
        setNotice(t('ann.transformed', { count }));
        return true;
      }
      const controller = new AbortController();
      cancelRef.current = controller;
      setBusy(true);
      void (async () => {
        try {
          await checkpointEngineValues();
          const fresh = store.active;
          if (
            controller.signal.aborted ||
            fresh?.id !== tab.id ||
            fresh.working.produced?.id !== tab.working.produced?.id
          )
            return;
          const before = editableOverlays(fresh);
          const nextPlan = planMarkTransform(before, targets, keys, transform);
          const after = {
            ...before,
            annotations: nextPlan.annotations,
            measures: nextPlan.measures,
            redactions: nextPlan.redactions,
          };
          if (nextPlan.existing.length === 0) {
            store.setOverlays(fresh.id, after as unknown as JsonValue, 'ann.transform');
          } else {
            // Keep pending marks outside the bytes. Otherwise the untouched PDF
            // version and the transformed overlay would both paint the same mark.
            const context = contextFor(fresh, handle);
            const executedSteps: SaveStepDescription[] = [];
            const base = await materializeBase(context, { signal: controller.signal }, executedSteps, {
              ...before,
              annotations: [],
              measures: [],
            });
            const outcome = await transformPdfAnnotations(
              base,
              { targets: nextPlan.existing, transform },
              { signal: controller.signal },
            );
            const next = await applyProducedBytes(
              context,
              outcome.bytes,
              outcome.report.pageCount,
              { key: 'ann.transform' },
              outcome.report.engine,
              [...executedSteps.map((step) => step.id), ...outcome.report.steps],
              { signal: controller.signal },
              after,
            );
            setHandle(fresh.id, next);
          }
          setNotice(t('ann.transformed', { count }));
        } catch (error) {
          if (controller.signal.aborted) return;
          const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
          setNotice(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
        } finally {
          if (cancelRef.current === controller) {
            cancelRef.current = null;
            setBusy(false);
          }
        }
      })();
      return true;
    },
    [checkpointEngineValues, contextFor, editableOverlays, existingAnnotations, setBusy, setHandle, store, t],
  );

  /**
   * One write into a file annotation that is not a geometry edit of the selection: a
   * placed picture, a resized one. The same boundary as `transformTargets` — engine
   * values checkpointed, the version checked after every `await`, pending marks kept
   * out of the bytes and handed back as the remaining overlays — so the stamp is one
   * journal step that undo takes back whole.
   */
  const writeFileAnnotation = useCallback(
    (
      label: { readonly key: MessageKey; readonly params?: Record<string, string | number> },
      write: (
        base: Uint8Array,
        signal: AbortSignal,
      ) => Promise<OperationOutcome & { readonly annotationId?: string }>,
      done: string,
      selectOnPage?: number,
    ): boolean => {
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null) return false;
      if (busyRef.current || cancelRef.current !== null || !canEditRef.current) {
        refuseBusy();
        return false;
      }
      const controller = new AbortController();
      cancelRef.current = controller;
      setBusy(true);
      void (async () => {
        try {
          await checkpointEngineValues();
          const fresh = store.active;
          if (
            controller.signal.aborted ||
            fresh?.id !== tab.id ||
            fresh.working.produced?.id !== tab.working.produced?.id
          )
            return;
          const before = editableOverlays(fresh);
          const context = contextFor(fresh, handle);
          const executedSteps: SaveStepDescription[] = [];
          const base = await materializeBase(context, { signal: controller.signal }, executedSteps, {
            ...before,
            annotations: [],
            measures: [],
          });
          const outcome = await write(base, controller.signal);
          const next = await applyProducedBytes(
            context,
            outcome.bytes,
            outcome.report.pageCount,
            label,
            outcome.report.engine,
            [...executedSteps.map((step) => step.id), ...outcome.report.steps],
            { signal: controller.signal },
            before,
          );
          setHandle(fresh.id, next);
          if (outcome.annotationId !== undefined && selectOnPage !== undefined) {
            selectAfterWrite.current = markTargetKey('existing', outcome.annotationId, selectOnPage);
          }
          setNotice(done);
        } catch (error) {
          if (controller.signal.aborted) return;
          const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
          setNotice(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
        } finally {
          if (cancelRef.current === controller) {
            cancelRef.current = null;
            setBusy(false);
          }
        }
      })();
      return true;
    },
    [checkpointEngineValues, contextFor, editableOverlays, refuseBusy, setBusy, setHandle, store, t],
  );

  /** What a picture is called in the notices and in the comment list readers show. */
  const stampKind = useCallback(
    (role: StampSource['role']) =>
      t(
        role === 'signature'
          ? 'sig.role.signature'
          : role === 'initials'
            ? 'sig.role.initials'
            : 'img.add.label',
      ),
    [t],
  );

  /** The click that places the armed picture: one `/Stamp`, one journal step, then selected. */
  const placeStamp = useCallback(
    (placement: StampPlacement) => {
      const source = pendingStamp;
      if (source === null) return;
      const kind = stampKind(source.role);
      const started = writeFileAnnotation(
        { key: 'sig.placed', params: { kind } },
        (base, signal) =>
          addImageStamp(
            base,
            {
              id: crypto.randomUUID(),
              pageIndex: placement.pageIndex,
              center: placement.center,
              width: placement.width,
              height: placement.height,
              image: source.bytes,
              role: source.role,
              label: kind,
              author: annotationAuthor,
            },
            { signal },
          ),
        t('sig.placed', { kind }),
        placement.pageIndex,
      );
      if (started) setCanvasTool('select');
    },
    [annotationAuthor, pendingStamp, stampKind, t, writeFileAnnotation],
  );

  /** A corner handle's drop: the stamp's `/Rect` becomes the new box, nothing else changes. */
  const resizeStamp = useCallback(
    (key: string, rect: readonly [number, number, number, number]) => {
      const target = markTargetsRef.current.find((candidate) => candidate.key === key);
      if (target === undefined || target.family !== 'existing' || target.resizable !== true) {
        setNotice(t('stamp.notResizable'));
        return;
      }
      writeFileAnnotation(
        { key: 'stamp.resize' },
        (base, signal) =>
          resizeImageStamp(base, { pageIndex: target.pageIndex, id: target.id, rect }, { signal }),
        t('stamp.resized'),
      );
    },
    [t, writeFileAnnotation],
  );

  /** Arm the `stamp` tool with a picture; the next click on a page places it. */
  const armStamp = useCallback(
    (source: StampSource) => {
      setPendingStamp(source);
      setCanvasTool('stamp');
      setNotice(t('sig.placing'));
    },
    [t],
  );

  const openSignature = useCallback(() => {
    if (store.active === null) return;
    if (busyRef.current || !canEditRef.current) {
      refuseBusy();
      return;
    }
    setSignatureOpen(true);
  }, [refuseBusy, store]);

  const pickImage = useCallback(() => {
    if (store.active === null) return;
    if (busyRef.current || !canEditRef.current) {
      refuseBusy();
      return;
    }
    imageInputRef.current?.click();
  }, [refuseBusy, store]);

  const onImagePicked = useCallback(
    async (file: File) => {
      const { imageFromFile } = await import('pdf-ui/dialog');
      const source = await imageFromFile(file);
      if (source === null) {
        setNotice(t('img.add.failed', { name: file.name }));
        return;
      }
      armStamp(source);
    },
    [armStamp, t],
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
    if (orphanSweep.current === null && (busyRef.current || cancelRef.current !== null)) {
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
    if (canvasToolRef.current !== 'select') return false;
    if (store.active === null || existingAnnotations === null) return false;
    const keys = markTargetsRef.current.map((target) => target.key);
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
    setCanvasTool('select');
    setSelectedKeys([markTargetKey('annotation', mark.id, mark.pageIndex)]);
    setRightDock(true);
    setRightTab('comments');
  }, []);

  /** Page-structure actions: journaled, cancellable. */
  const runPageAction = useCallback(
    (action: PageAction) => {
      /**
       * The tab and its engine handle are read at call time, never from the render that
       * created this callback. A page action replaces the handle, so a control one render
       * old handed the *previous* document to `extractPages` and pdf.js answered
       * `Cannot read properties of null (reading 'sendWithPromise')` — measured on the
       * second of two consecutive rotations; the shell reported it as an internal error
       * while the first action looked perfectly healthy.
       */
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null || !canEditRef.current || cancelRef.current !== null) return;
      if (busyRef.current) {
        refuseBusy();
        return;
      }
      setBusy(true);
      // The page panel's selection when there is one, else the page on screen: the
      // status-bar rotate and the context menu act on "this page", and with no selection
      // they used to do nothing at all and say so in a sentence with a raw `{count}`.
      // A control that names its pages (a thumbnail's own rotate or delete) wins over both.
      const named = 'pages' in action ? action.pages : undefined;
      const selection =
        named !== undefined && named.length > 0
          ? named
          : selectedPagesRef.current.length > 0
            ? selectedPagesRef.current
            : [currentPageRef.current];
      const controller = new AbortController();
      cancelRef.current = controller;
      setProgress({ phase: 'pages', labelKey: 'op.step.pages', total: 1, done: 0 });
      void (async () => {
        try {
          const next = await applyPageAction(contextFor(tab, handle), selection, action, {
            signal: controller.signal,
            onProgress: setProgress,
          });
          if (next !== null) {
            setHandle(tab.id, next);
            // The notice names what actually happened: a delete and a move are
            // different journal steps and the History panel shows both.
            const label = pageActionLabel(action, selection.length);
            setNotice(t('op.result.applied', { label: t(label.key, label.params) }));
          } else {
            /**
             * A page action that did nothing says so. The silent version was found by a
             * driver that clicked a disabled button and saw only a stale notice — an
             * inert control and a refused action must not look the same.
             */
            setNotice(t('op.result.noChangePages'));
          }
        } catch (error) {
          const toolError =
            error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
          setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
        } finally {
          if (cancelRef.current === controller) {
            cancelRef.current = null;
            setProgress(null);
            setBusy(false);
          }
        }
      })();
    },
    [contextFor, setBusy, setHandle, store, t, refuseBusy],
  );

  const cancelOperation = useCallback(() => {
    cancelRef.current?.abort();
    setNotice(t('op.cancelRequested'));
  }, [t]);
  const dismissNotice = useCallback(() => setNotice(null), []);

  /**
   * Undo/redo. The model moves its own state and reports which bytes the
   * viewer must show; mounting them is the app's half of the contract. A step whose
   * snapshot the session no longer holds is reported, never guessed.
   */
  const stepHistory = useCallback(
    async (direction: 'undo' | 'redo'): Promise<void> => {
      const tab = store.active;
      const handle = tab === null ? undefined : handles.current.get(tab.id);
      if (tab === null || handle === undefined || cancelRef.current !== null) return;
      if (busyRef.current) {
        refuseBusy();
        return;
      }
      const controller = new AbortController();
      cancelRef.current = controller;
      setBusy(true);
      await (async () => {
        try {
          const result = await applyHistoryStep(contextFor(tab, handle), direction, {
            signal: controller.signal,
          });
          if (result === null) {
            if (store.active?.id === tab.id) setNotice(t('op.undo.unavailable'));
            return;
          }
          if (result.handle !== handle) {
            const values = pendingOverlays(store.active).engineValues;
            if (values !== undefined) pendingEngineValues.current.set(tab.id, values);
            else pendingEngineValues.current.delete(tab.id);
            setHandle(tab.id, result.handle);
            setCurrentPage((page) => Math.min(page, result.handle.pageCount - 1));
          }
          const label = t(
            result.entry.labelKey as Parameters<typeof t>[0],
            (result.entry.labelParams ?? {}) as Readonly<Record<string, string | number>>,
          );
          setNotice(t(direction === 'undo' ? 'op.undo.done' : 'op.redo.done', { label }));
        } catch (error) {
          if (store.active?.id !== tab.id || controller.signal.aborted) return;
          const toolError =
            error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
          setNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
        } finally {
          if (cancelRef.current === controller) {
            cancelRef.current = null;
            setBusy(false);
          }
        }
      })();
    },
    [contextFor, setBusy, setHandle, store, t, refuseBusy],
  );

  /**
   * Undo/redo with the engine's pending gesture folded in first, so there is **one**
   * history rather than two.
   *
   * pdf.js owns a highlight or an ink stroke until something commits it — and this app
   * takes that editor over the moment it commits. An undo that ran before the takeover
   * would therefore undo a different step than the one the user just made, or leave the
   * mark they can see untouched while the engine undid a record nothing else holds.
   * Committing and taking over first makes the two one step: the takeover journals the
   * new mark, and the undo the user asked for is the undo of exactly that.
   *
   * `false` declines the key: with no document, or while an operation is already
   * running, `Ctrl+Z` is not the shell's to answer and is left to whatever owns it.
   *
   * **Steps queue, they are never dropped.** A step spans several awaits (the sweep, the
   * engine checkpoint, the model's own move), so a second press lands while the first is
   * still in flight. Refusing it as "busy" — or letting it run beside the first, where
   * `stepHistory` returns silently on the held lock — loses the press: two quick undos
   * would undo one step. A press that arrives while history steps are pending is chained
   * behind them and runs when the one before has finished.
   */
  const historyTail = useRef<Promise<void>>(Promise.resolve());
  const historyPending = useRef(0);
  const stepHistoryNow = useCallback(
    (direction: 'undo' | 'redo'): boolean => {
      const tab = store.active;
      const handle = tab === null ? null : (handles.current.get(tab.id) ?? null);
      if (tab === null || handle === null) return false;
      const inFlight = orphanSweep.current;
      const queued = historyPending.current > 0;
      if (!queued && inFlight === null && (busyRef.current || cancelRef.current !== null)) {
        refuseBusy();
        return false;
      }
      if (settleNativeEditors()) void sweepOrphanAnnotations();
      const run = async (): Promise<void> => {
        // A step queued behind another starts from the version that one produced, so the
        // handle is read when this step begins, not when the key was pressed.
        const start = handles.current.get(tab.id);
        if (store.active?.id !== tab.id || start === undefined) return;
        // The sweep replaces the working version, so it must be over before the
        // checkpoint reads the engine and before the model moves.
        const sweep = orphanSweep.current;
        if (sweep !== null) await sweep;
        if (store.active?.id !== tab.id || handles.current.get(tab.id) !== start) return;
        if (busyRef.current || cancelRef.current !== null) {
          refuseBusy();
          return;
        }
        /**
         * The engine's live storage is checkpointed first, for the same reason an erase
         * checkpoints it: a history step restores the mark state of *its own* moment,
         * and a form value typed a second ago is not in any step yet — undoing without
         * this would reopen the bytes from before the typing and drop a value the user
         * can still see on the page.
         */
        await checkpointEngineValues();
        if (store.active?.id === tab.id && handles.current.get(tab.id) === start)
          await stepHistory(direction);
      };
      historyPending.current += 1;
      historyTail.current = historyTail.current
        .then(run)
        .catch((error) => {
          if (store.active?.id !== tab.id) return;
          const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
          setNotice(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
        })
        .finally(() => {
          historyPending.current -= 1;
        });
      return true;
    },
    [checkpointEngineValues, refuseBusy, settleNativeEditors, stepHistory, store, sweepOrphanAnnotations, t],
  );

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
        print: () => setPrintOpen(true),
        openBatch: () => setBatchOpen(true),
        openSignature,
        addImage: pickImage,
        measure: (mode) => {
          // The ruler's own sub-mode; `null` puts the tool away. It is the same one
          // canonical value the rail and the palette write, so stopping the ruler from
          // its strip and arming it from the menu cannot leave two answers behind.
          if (mode === null) {
            if (canvasToolRef.current === 'measure') setCanvasTool('select');
            return;
          }
          setMeasureSubMode(mode);
          setCanvasTool('measure');
        },
        measureMode,
        showRightTab: (tab) => {
          setRightDock(true);
          setRightTab(tab);
        },
        undo: () => stepHistoryNow('undo'),
        redo: () => stepHistoryNow('redo'),
        rename: () => setRenamingId(activeTab?.id ?? null),
        closeTab: () => {
          if (activeTab !== null) closeTab(activeTab.id);
        },
        openDialog,
        showShortcuts,
        openSettings: () => setSettingsOpen(true),
        pageAction: runPageAction,
        setZoom: (value) => viewerApi.current?.setZoom(value),
        setSpread: (mode) => viewerApi.current?.setSpreadMode(mode),
        toggleFullscreen: () => void toggleFullscreen(),
        toggleReading: () => setReading((value) => !value),
        toggleMagnifier: () => setMagnifierOn((value) => !value),
        toggleLeftDock: () => setLeftDock((value) => !value),
        toggleRightDock: () => setRightDock((value) => !value),
        selectAllPages: () => setSelectedPages(Array.from({ length: pageCount }, (_v, index) => index)),
        clearSelection: () => setSelectedPages([]),
        palette: () => {
          // A modal surface takes the pointer: the measure overlay covers the viewer, so a
          // tool left armed would swallow the palette's own clicks (measured in the harness).
          setCanvasTool('select');
          setPaletteOpen(true);
        },
        openLeftTab: (tab) => {
          setLeftDock(true);
          setLeftTab(tab);
        },
        activeTool: canvasTool,
        armTool: (tool) => setCanvasTool(tool),
        selectedMarkCount: selectedKeys.length,
        deleteMarkSelection: () => void deleteMarkSelection(),
        selectAllMarks: () => void selectAllMarks(),
        showRedactionAudit: () => {
          setRightDock(true);
          setRightTab('redaction-audit');
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
        exportDocument: () => setExportModalOpen(true),
        // The whole common selection, across every mark family, and only when there is
        // one: the key is not swallowed to mean nothing.
        deleteSelection: deleteMarkSelection,
        print: () => setPrintOpen(true),
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
          setCanvasTool('select');
          setPaletteOpen(true);
        },
        toggleLeftDock: () => setLeftDock((value) => !value),
        toggleRightDock: () => setRightDock((value) => !value),
        reading: () => setReading((value) => !value),
        documentProperties: () => openDialog('properties'),
        selectAllMarks,
      }),
      [
        currentPage,
        deleteMarkSelection,
        openDialog,
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
            setNotice(t('shell.rename.done', { name: next }));
          }}
          isDirty={activeTab.dirty}
          toolsOpen={rightDock && rightTab === 'tools'}
          onTools={toggleToolsPanel}
          reading={reading}
          onRead={() => setReading((open) => !open)}
          editingText={canvasTool === 'text'}
          onEditText={() => setCanvasTool(canvasTool === 'text' ? 'select' : 'text')}
          canEdit={canEdit}
          onConvert={() => setExportModalOpen(true)}
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
          onExportOptions={() => setExportModalOpen(true)}
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
            <Suspense fallback={null}>
              <MeasureSettings
                t={t}
                mode={measureMode}
                onMode={(mode) => {
                  // The strip's own toggle reports `null` when the armed mode is
                  // clicked again, which is the same stop as its Stop button.
                  if (mode === null) {
                    setCanvasTool('select');
                    return;
                  }
                  setMeasureSubMode(mode);
                  setCanvasTool('measure');
                }}
                scale={measureScale}
                onScale={setMeasureScale}
                grid={measureGrid}
                onGrid={setMeasureGrid}
                gridSpacing={measureSpacing}
                onGridSpacing={setMeasureSpacing}
                snapGrid={measureSnapGrid}
                onSnapGrid={setMeasureSnapGrid}
                snapPoints={measureSnapPoints}
                onSnapPoints={setMeasureSnapPoints}
                // Colour, opacity, thickness and author are the annotation style: a
                // ruler and a highlighter are the same kind of mark, so the ruler's
                // settings edit the same state the marker tools do.
                color={annotationColor}
                onColor={setAnnotationColor}
                opacity={annotationOpacity}
                onOpacity={setAnnotationOpacity}
                thickness={annotationThickness}
                onThickness={setAnnotationThickness}
                author={annotationAuthor}
                onAuthor={setAnnotationAuthor}
                reading={measureReading}
                onStop={() => setCanvasTool('select')}
              />
            </Suspense>
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
              onTextColor={setTextColor}
              onFontSize={setFontSize}
              redactionCount={redactionMarks.length}
              onApplyRedaction={() => openDialog('redact')}
              onTool={setCanvasTool}
              selectedCount={selectedKeys.length}
              disabled={!canEdit || (canvasTool === 'select' && existingAnnotations === null)}
              onColor={setAnnotationColor}
              onOpacity={setAnnotationOpacity}
              onThickness={setAnnotationThickness}
              onAuthor={setAnnotationAuthor}
              onShape={setShape}
              // Selection actions share one intent across every mark family.
              onDeleteSelection={() => void removeTargets(selectedKeys)}
              onRotateSelection={() => void transformTargets(selectedKeys, { dx: 0, dy: 0, rotation: 90 })}
              onMoveSelection={(dx, dy) => void transformTargets(selectedKeys, { dx, dy, rotation: 0 })}
              onClearSelection={() => setSelectedKeys([])}
            />
          )}
        </div>
      ) : null}
      <main className="relative min-h-0 flex-1">
        {isHome ? (
          <HomeScreen
            t={t}
            onOpenFiles={(files) => void openFilesFromSurface(files)}
            onOpenPicker={() => void openViaPicker()}
            onStart={(action) => {
              if (action === 'batch') setBatchOpen(true);
              else
                openStart(
                  action === 'blank' ? 'new-document' : action === 'images' ? 'images-to-pdf' : 'merge-files',
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
                setNotice(
                  t(reopened.kind === 'denied' ? 'home.reopen.denied' : 'home.reopen.missing', {
                    name: item.name,
                  }),
                );
                // A refused permission is the user's answer; the picker would ask again.
                if (reopened.kind === 'denied') return;
              }
              try {
                const drafts = await draftStorage.readDrafts();
                const matchedDraft = drafts.find((d) => d.id === item.id);
                if (matchedDraft) {
                  const bytes = await draftStorage.getSource(matchedDraft.sourceKey);
                  if (bytes) {
                    const handle = await openWithPdfjs(bytes);
                    const sha256 = await sha256Hex(bytes);
                    const tab = store.openDocument({
                      id: matchedDraft.id,
                      name: matchedDraft.name,
                      bytes,
                      sha256,
                      pageCount: matchedDraft.pageCount,
                    });
                    handles.current.set(tab.id, handle);
                    store.setActive(tab.id);
                    setShowHomeScreen(false);
                    return;
                  }
                }
              } catch (error) {
                // The draft could not be read back: say so, then offer the picker so the
                // user can open the file itself.
                setNotice(noticeLine(failureNotices(error, 'error.corrupt-document.message'), t));
              }
              void openViaPicker();
            }}
            onOpenPalette={() => setPaletteOpen(true)}
            busy={busy}
          />
        ) : (
          <div className="flex h-full">
            {leftDock ? (
              <div className={compactViewport ? 'absolute inset-y-0 left-0 z-40 max-w-full' : 'contents'}>
                <DocumentPanel
                  onToggle={() => setLeftDock(false)}
                  document={activeHandle}
                  t={t}
                  currentPage={currentPage}
                  selectedPages={selectedPages}
                  onSelectionChange={setSelectedPages}
                  onPageAction={runPageAction}
                  editing={canEdit}
                  version={activeTab.working.stateId}
                  onGoToPage={(pageIndex) => viewerApi.current?.goToPage(pageIndex)}
                  onNotice={setNotice}
                  onHighlightQuery={(query) => viewerApi.current?.find(query)}
                  onLayersChanged={() => void viewerApi.current?.refreshOptionalContent()}
                  onEditOutline={() => openDialog('outline-edit')}
                  onWriteLayers={(request) => void writeLayers(request)}
                  onAddAttachments={(files) => void writeAttachments({ add: files })}
                  onRemoveAttachments={(names) => void writeAttachments({ remove: names })}
                  visibleTabs={mode === 'simple' ? SIMPLE_MODE_DOCK_TABS : undefined}
                  tab={leftTab}
                  onTabChange={setLeftTab}
                />
              </div>
            ) : null}
            <ToolRail
              t={t}
              activeTool={canvasTool}
              markupTool={markupTool}
              onSelectTool={handleSelectLeftTool}
              canEdit={canEdit}
            />
            {/* biome-ignore lint/a11y/noStaticElementInteractions: context menu listener on the document canvas container */}
            <div className="relative min-w-0 flex-1 overflow-hidden" onContextMenu={handleContextMenu}>
              {/* Persistent edge handle to reopen Left Dock */}
              {!leftDock ? (
                <button
                  type="button"
                  title={t('nav.togglePages')}
                  aria-label={t('nav.togglePages')}
                  onClick={() => setLeftDock(true)}
                  className="absolute left-0 top-3 z-30 flex h-9 w-4 items-center justify-center rounded-r-md border border-l-0 border-kumo-line bg-kumo-base/95 text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong pdf-floating-shadow transition-all"
                >
                  <CaretRight size={12} weight="bold" />
                </button>
              ) : null}

              {/* Persistent edge handle to reopen Right Dock */}
              {!rightDock ? (
                <button
                  type="button"
                  title={t('tools.all')}
                  aria-label={t('tools.all')}
                  onClick={() => setRightDock(true)}
                  className="absolute right-0 top-3 z-30 flex h-9 w-4 items-center justify-center rounded-l-md border border-r-0 border-kumo-line bg-kumo-base/95 text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong pdf-floating-shadow transition-all"
                >
                  <CaretLeft size={12} weight="bold" />
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
                // The mark layers live inside the viewer's scroll content, so the browser
                // scrolls them with the pages; outside it they were re-placed only on the
                // next render and slid over the text while the reader scrolled.
                overlay={
                  viewer === null ? null : (
                    <>
                      {redactionActive && viewer !== null ? (
                        <RedactionLayer
                          t={t}
                          viewer={viewer}
                          onMark={(mark) =>
                            setRedactionMarks((marks) => [...marks, { id: crypto.randomUUID(), mark }])
                          }
                          onDone={() => setCanvasTool('select')}
                        />
                      ) : null}
                      {/*
                Measurements remain visible after switching to selection. Only creation
                and the settings strip follow the armed tool, not the marks themselves.
              */}
                      {viewer !== null && (measureMode !== null || visibleMarks.measures.length > 0) ? (
                        <Suspense fallback={null}>
                          <MeasureLayer
                            t={t}
                            viewer={viewer}
                            mode={canEdit ? measureMode : null}
                            scale={measureScale}
                            marks={visibleMarks.measures}
                            color={annotationColor}
                            opacity={annotationOpacity}
                            thickness={annotationThickness}
                            author={annotationAuthor}
                            grid={measureMode !== null && measureGrid}
                            gridSpacing={measureSpacing}
                            snapGrid={measureSnapGrid}
                            snapPoints={measureSnapPoints}
                            onReading={setMeasureReading}
                            onCreate={(mark) => {
                              setMeasureMarks((marks) => [...marks, mark]);
                              if (activeTab !== null) store.setDirty(activeTab.id, true);
                            }}
                          />
                        </Suspense>
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
                          onDone={() => setCanvasTool('select')}
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
                      {viewer !== null && canEdit && canvasTool === 'stamp' && pendingStamp !== null ? (
                        <StampPlacementLayer
                          viewer={viewer}
                          source={pendingStamp}
                          hint={t('sig.placing')}
                          onPlace={placeStamp}
                          onCancel={() => setCanvasTool('select')}
                        />
                      ) : null}
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
                              setCanvasTool('select');
                              openDialog('text-edit');
                            }}
                            onClose={() => setCanvasTool('select')}
                          />
                        </Suspense>
                      ) : null}
                    </>
                  )
                }
              />
            </div>
            {rightDock ? (
              <div className={compactViewport ? 'absolute inset-y-0 right-0 z-40 max-w-full' : 'contents'}>
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
                  ]}
                  activeId={rightTab}
                  onSelect={setRightTab}
                  onToggle={() => setRightDock(false)}
                >
                  {rightTab === 'tools' ? (
                    <ToolsRailPanel
                      t={t}
                      activeSpec={rightDock && rightTab === 'tools' ? dialogSpec : null}
                      context={dialogContext}
                      onSelectTool={(id) => openDialog(id)}
                      onBackToTools={() => {
                        cancelRef.current?.abort();
                        setDialogId(null);
                        setDialogSpec(null);
                        setDialogInput(null);
                        // The block selection belongs to exactly one run: leaving it in
                        // place would let a later `text-edit` open on a paragraph the
                        // user is no longer looking at.
                        setTextEdit(null);
                      }}
                      onResult={(result) => void handleDialogResult(result)}
                      onPageAction={(action) => runPageAction(action as PageAction)}
                      onArmTool={(tool) => {
                        // The rail emits the redaction tool today and offered the
                        // highlighter before it; anything else is not a canvas tool and
                        // must not silently arm one.
                        if (tool === 'redact') setCanvasTool('redact');
                        else if (tool === 'highlight') setCanvasTool('highlight');
                      }}
                      onOpenPalette={() => setPaletteOpen(true)}
                      onExportModal={() => setExportModalOpen(true)}
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
                    <Suspense
                      fallback={
                        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
                          {t('panel.comments')}
                        </p>
                      }
                    >
                      <CommentsPanel
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
                        disabled={!canEdit}
                      />
                    </Suspense>
                  ) : rightTab === 'properties' ? (
                    <Suspense
                      fallback={
                        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
                          {t('props.title')}
                        </p>
                      }
                    >
                      {currentFactsError !== null ? (
                        <div role="alert" className="flex flex-col gap-2 p-2 text-xs text-kumo-danger">
                          <p>
                            {t(currentFactsError.messageKey)} {t(currentFactsError.hintKey)}
                          </p>
                          <Button
                            variant="outline"
                            onClick={() => setInspectionRevision((value) => value + 1)}
                          >
                            {t('inspection.retry')}
                          </Button>
                        </div>
                      ) : (
                        <PropertiesPanel
                          t={t}
                          fonts={documentFacts?.fonts ?? null}
                          attachments={documentFacts?.attachments ?? []}
                          signatures={documentFacts?.signatures ?? []}
                          trustRoots={trustRoots}
                          onRemoveTrustRoot={(id) => {
                            const next = removeTrustRoot({ version: 1, roots: trustRoots }, id);
                            setTrustRoots(next.roots);
                            void writeAppFile('trust-roots.json', next);
                          }}
                          onImportTrustRoots={storeTrustRoots}
                          security={documentFacts?.security ?? null}
                          loading={documentFacts === null}
                          disabled={!canEdit}
                          onAddAttachments={(files) => void addAttachmentsToDocument(files)}
                          onRemoveAttachment={(name) => void removeAttachmentFromDocument(name)}
                          onReadAttachment={(name) => void readAttachmentOut(name)}
                        />
                      )}
                    </Suspense>
                  ) : rightTab === 'redaction-audit' ? (
                    <Suspense
                      fallback={
                        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
                          {t('audit.title')}
                        </p>
                      }
                    >
                      <RedactionAuditPanel
                        t={t}
                        audit={auditReport}
                        loading={auditLoading}
                        onRerun={() => void runRedactionAudit()}
                      />
                    </Suspense>
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
                        onNotice={setNotice}
                        disabled={!canEdit}
                      />
                    </Suspense>
                  ) : rightTab === 'accessibility' ? (
                    <Suspense
                      fallback={
                        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
                          {t('panel.accessibility')}
                        </p>
                      }
                    >
                      <AccessibilityPanel
                        key={activeTab.working.id}
                        t={t}
                        read={currentBytes}
                        // The document's own language cannot be guessed; the interface's is
                        // what the shell knows, and the report says which one it wrote.
                        language="tr-TR"
                        onTagged={(outcome) => void applyAccessibility(outcome)}
                        onAltWritten={(outcome) => void applyAccessibility(outcome)}
                        onNotice={setNotice}
                      />
                    </Suspense>
                  ) : rightTab === 'forms' ? (
                    <Suspense
                      fallback={
                        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
                          {t('panel.forms')}
                        </p>
                      }
                    >
                      {currentForms?.error !== undefined ? (
                        <div role="alert" className="flex flex-col gap-2 p-2 text-xs text-kumo-danger">
                          <p>
                            {t(currentForms.error.messageKey)} {t(currentForms.error.hintKey)}
                          </p>
                          <Button
                            variant="outline"
                            onClick={() => setInspectionRevision((value) => value + 1)}
                          >
                            {t('inspection.retry')}
                          </Button>
                        </div>
                      ) : (
                        <FormPanel
                          key={activeTab.id}
                          t={t}
                          fields={formFields ?? []}
                          loading={formFields === null}
                          selectedName={selectedField}
                          onSelect={(name) => {
                            setSelectedField(name);
                            const field = formFields?.find((entry) => entry.name === name);
                            if (field?.pageIndex != null) viewerApi.current?.goToPage(field.pageIndex);
                          }}
                          onFill={(name, value) => void fillField(name, value)}
                          disabled={!canEdit}
                        />
                      )}
                    </Suspense>
                  ) : (
                    <RedactionPanel
                      t={t}
                      marks={redactionMarks.map((item) => ({
                        id: item.id,
                        pageIndex: item.mark.pageIndex,
                      }))}
                      onRemove={(id) => void removeTargets([markTargetKey('redaction', id, 0)])}
                      onClear={() =>
                        void removeTargets(
                          markTargets
                            .filter((target) => target.family === 'redaction')
                            .map((target) => target.key),
                        )
                      }
                    >
                      <Button
                        size="sm"
                        shape="base"
                        aria-pressed={redactionActive}
                        disabled={!canEdit}
                        onClick={() => setCanvasTool(redactionActive ? 'select' : 'redact')}
                      >
                        {redactionActive ? t('redact.tool.stop') : t('redact.tool.start')}
                      </Button>
                      <Button
                        size="sm"
                        shape="base"
                        variant="primary"
                        disabled={!canEdit || redactionMarks.length === 0}
                        onClick={() => openDialog('redact')}
                      >
                        {t('redact.title')}
                      </Button>
                    </RedactionPanel>
                  )}
                </Dock>
              </div>
            ) : null}
            <ReadingPane
              t={t}
              open={reading}
              onClose={() => setReading(false)}
              viewer={viewerApi.current}
              pageNumber={currentPage}
              onPageChange={(page) => viewerApi.current?.goToPage(page)}
              onNotice={setNotice}
            />
            <SnapshotMenu
              t={t}
              viewer={viewer}
              open={snapshotOpen}
              onClose={() => setSnapshotOpen(false)}
              onNotice={setNotice}
            />
            <Magnifier
              t={t}
              viewer={viewer}
              active={magnifierOn}
              zoom={lensZoom}
              onZoomChange={setLensZoom}
            />
            {printOpen ? (
              <Suspense fallback={null}>
                <PrintDialog
                  t={t}
                  viewer={viewerApi.current}
                  open={printOpen}
                  onClose={() => setPrintOpen(false)}
                  onNotice={setNotice}
                />
              </Suspense>
            ) : null}
          </div>
        )}
        {/*
            Mounted outside the home/editor split: the batch dialog starts from files on disk, so it
            has to open with no document too. Mounted only while it is open: a static import here is what put Kumo's
            dialog primitives on the first-paint graph, and a `lazy` boundary that is
            mounted unconditionally still fetches immediately. The `open` prop stays
            as it was, so the dialog's own open/close contract is unchanged.
          */}
        {startSpec === null ? null : (
          <Suspense fallback={null}>
            <StartDialog
              t={t}
              spec={startSpec}
              context={startContext}
              onClose={() => setStartSpec(null)}
              onResult={(result) => void handleStartResult(result)}
            />
          </Suspense>
        )}
        {batchOpen ? (
          <Suspense fallback={null}>
            <BatchDialog
              t={t}
              open={batchOpen}
              onClose={() => setBatchOpen(false)}
              onDownload={downloadFiles}
              onNotice={setNotice}
            />
          </Suspense>
        ) : null}
        <ActivityOverlay
          t={t}
          notice={notice}
          onDismiss={dismissNotice}
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
              onToggleThumbnails={() => setLeftDock((open) => !open)}
              thumbnailsOpen={leftDock}
              onToggleReading={() => setReading((open) => !open)}
              readingActive={reading}
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
      {shortcutsOpen ? (
        <Suspense fallback={null}>
          <ShortcutsDialog
            t={t}
            open={shortcutsOpen}
            groups={SHELL_SHORTCUT_GROUPS}
            onClose={closeShortcuts}
          />
        </Suspense>
      ) : null}
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
      {closeRequest !== null && signatureWarning === null ? (
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
              if (!busyRef.current) {
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
      {signatureOpen ? (
        <Suspense fallback={null}>
          <SignatureDialog
            t={t}
            saved={savedSignatures}
            // A sensitive session stores nothing, a signature picture included.
            canRemember={activeTab?.sensitive !== true}
            onClose={() => setSignatureOpen(false)}
            onForget={(id) => setSavedSignatures(forgetSignature(id))}
            onPlace={(source, remember) => {
              if (remember && source.role !== 'image' && activeTab?.sensitive !== true) {
                setSavedSignatures(
                  rememberSignature({
                    id: crypto.randomUUID(),
                    role: source.role,
                    dataUrl: source.dataUrl,
                    width: source.pixelWidth,
                    height: source.pixelHeight,
                  }),
                );
              }
              setSignatureOpen(false);
              armStamp(source);
            }}
          />
        </Suspense>
      ) : null}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void onImagePicked(file);
        }}
      />
      {signatureWarning === null ? null : (
        <Suspense fallback={null}>
          <SignatureWarningDialog
            t={t}
            breaks={signatureWarning.breaks}
            signer={signatureWarning.signer}
            fieldName={signatureWarning.fieldName}
            onCancel={() => {
              signatureDecision.current?.(false);
              signatureDecision.current = null;
              setSignatureWarning(null);
            }}
            onContinue={() => {
              signatureDecision.current?.(true);
              signatureDecision.current = null;
              setSignatureWarning(null);
            }}
          />
        </Suspense>
      )}
      {contextMenu !== null ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          t={t}
          hasSelection={contextMenu.hasSelection}
          selectedText={contextMenu.selectedText}
          canEdit={canEdit}
          onHighlight={() => setCanvasTool('highlight')}
          onUnderline={() => setCanvasTool('underline')}
          onStrikeout={() => setCanvasTool('strikeout')}
          onCopy={() => {
            if (contextMenu.selectedText) void navigator.clipboard.writeText(contextMenu.selectedText);
          }}
          onRedact={() => {
            // The selected words become pending redaction areas at once; the tool stays
            // armed so the strip offers the explicit Apply.
            const viewerNow = viewerApi.current;
            if (viewerNow !== null) {
              const areas = selectionRedactAreas(viewerNow);
              if (areas.length > 0) {
                setRedactionMarks((marks) => [
                  ...marks,
                  ...areas.map((mark) => ({ id: crypto.randomUUID(), mark })),
                ]);
                window.getSelection()?.removeAllRanges();
              }
            }
            setCanvasTool('redact');
          }}
          onAddNote={() => handleSelectLeftTool('note')}
          onRotateRight={() => runPageAction({ kind: 'rotate', direction: 'right' })}
          onRotateLeft={() => runPageAction({ kind: 'rotate', direction: 'left' })}
          onDeletePage={() => runPageAction({ kind: 'delete' })}
          onAddText={() => handleSelectLeftTool('freetext')}
          onEditText={() => handleSelectLeftTool('text')}
          onDrawInk={() => handleSelectLeftTool('ink')}
          onFitWidth={() => viewerApi.current?.setZoom('page-width')}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      {exportModalOpen && activeTab !== null ? (
        <Suspense fallback={null}>
          <ExportDialog
            open={exportModalOpen}
            t={t}
            fileName={activeTab.name}
            fileSizeFormatted={`${(activeTab.source.master.byteLength / 1024).toFixed(1)} KB`}
            onClose={() => setExportModalOpen(false)}
            onExport={(opts) => handleExportWithOptions(opts)}
          />
        </Suspense>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
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
