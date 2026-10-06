/**
 * The app's action list: the menu bar, the shortcuts and the palette.
 *
 * Every capability of the file/page/tools menus is described once here and then
 * appears in three surfaces — the menu bar, the `Ctrl+K` palette and the toolbar
 * — so a capability cannot exist in one and be missing from another.
 *
 * The list is a function of live state (`buildCommands`) rather than a constant:
 * enablement genuinely depends on what is open, what is selected and what the
 * device tier allows, and a disabled entry with a reason is better than a hidden
 * one (an unsupported capability is stated, never silently
 * failing).
 */

import type { Translator } from 'pdf-shared';
import type { Command, DocumentPanelTab } from 'pdf-ui';
import type { CanvasToolId } from 'pdf-ui/tools';
import type { PageAction } from './operations';
import { shortcutHint } from './useShortcuts';

/** The public repository that holds this build's source (AGPL-3.0 §13). */
export const SOURCE_URL = 'https://github.com/isolmaz/ss-pdf-editor';

/**
 * Which surface the user is working in.
 *
 * **Simple** is the default: the capabilities the reference readers put in their free
 * tier — read, annotate, fill, sign, edit, organise pages, print. **Advanced** is
 * everything the application can do, and is one toggle away.
 *
 * The split is a *discovery* filter, not a permission system. A capability that is hidden
 * from the palette and the menus is still reachable by its keyboard shortcut, and no
 * feature is removed from the build. That is deliberate: a mode that silently disables
 * something would turn a preference into a bug report.
 */
export type InterfaceMode = 'simple' | 'advanced';

export interface CommandHost {
  readonly t: Translator;
  /** The surface the user chose; the palette filters on it and offers the way up. */
  readonly mode: InterfaceMode;
  /** Leave the simple mode, from the palette's "hidden by the simple mode" hint. */
  readonly useAdvancedMode: () => void;
  /** A document is open. */
  readonly hasDocument: boolean;
  /** Editing is allowed: a document is open, the tier is not viewing-only and no operation is running. */
  readonly canEdit: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canSave: boolean;
  /** Save verification has finished inspecting the current document version. */
  readonly canExport: boolean;
  readonly selectedPages: readonly number[];
  readonly zoom: number;
  readonly magnifier: boolean;
  readonly reading: boolean;
  readonly leftDock: boolean;
  readonly rightDock: boolean;
  readonly openFile: () => void;
  readonly save: () => void;
  readonly exportDocument: () => void;
  readonly print: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly rename: () => void;
  readonly closeTab: () => void;
  readonly openDialog: (id: string) => void;
  /**
   * The keyboard shortcut list. Help is not a document operation — it answers with no
   * tab open and in either mode, and there are no bytes to freeze — so it is its own
   * host callback rather than a dialog id in the operation registry
   * (`useShortcuts.ts` owns the bindings it lists).
   */
  readonly showShortcuts: () => void;
  /** The settings dialog: language, theme, interface mode, privacy, offline. */
  readonly openSettings: () => void;
  /**
   * The batch dialog is not an `OperationDialogSpec`: it works on a **queue of files**, not
   * on the open document, so it has its own host callback rather than a dialog id.
   */
  readonly openBatch: () => void;
  /**
   * The simple signature: draw, type or photograph one, then click where it goes. It is a
   * picture on the page (a `/Stamp`), not the certificate signing `tools.sign` opens.
   */
  readonly openSignature: () => void;
  /** Pick an image file and click where it goes on the page. */
  readonly addImage: () => void;
  /** Arm the ruler in one of its three modes (`ops/measure.ts`). */
  readonly measure: (mode: 'distance' | 'perimeter' | 'area' | null) => void;
  /** Which measure mode is armed, for the menu's check mark. */
  readonly measureMode: 'distance' | 'perimeter' | 'area' | null;
  /** Open a right-dock tab; the comparison and the accessibility check live there. */
  readonly showRightTab: (tab: string) => void;
  /** Open the left dock on one of its views (the layer write lives behind a tab). */
  readonly openLeftTab: (tab: DocumentPanelTab) => void;
  readonly pageAction: (action: PageAction) => void;
  readonly setZoom: (zoom: number | 'page-width' | 'page-fit' | 'auto') => void;
  readonly setSpread: (mode: 'single' | 'book') => void;
  readonly toggleFullscreen: () => void;
  readonly toggleReading: () => void;
  readonly toggleMagnifier: () => void;
  readonly toggleLeftDock: () => void;
  readonly toggleRightDock: () => void;
  readonly selectAllPages: () => void;
  readonly clearSelection: () => void;
  readonly palette: () => void;
  /**
   * The canvas tools. The arming state is the shell's **one**
   * canonical tool (`CanvasToolId`) rather than a set of per-feature flags: one value
   * per surface means the menu's check mark, the rail's pressed button and the layer
   * that actually owns the pointer cannot disagree, which is what five parallel
   * booleans (`annotationTool`/`textTool`/`redactionActive`/`measureMode`/`leftTool`)
   * could not promise.
   */
  readonly activeTool: CanvasToolId;
  readonly armTool: (tool: CanvasToolId) => void;
  /** How many marks the common selection holds, for the delete/select-all commands. */
  readonly selectedMarkCount: number;
  /** Removes the whole common selection (one journal step, every mark family). */
  readonly deleteMarkSelection: () => void;
  /** Selects every mark the select tool can act on. */
  readonly selectAllMarks: () => void;
  /** The redaction audit panel is a dock tab, not a dialog. */
  readonly showRedactionAudit: () => void;
  /** Theme preference and setter for settings commands. */
  readonly theme: 'light' | 'dark' | 'system';
  readonly setTheme: (theme: 'light' | 'dark' | 'system') => void;
  /** Sensitive session state and toggle. */
  readonly sensitiveSession: boolean;
  readonly toggleSensitiveSession: () => void;
  /** Explicit OPFS save action. */
  readonly opfsSave: () => void;
  /** User-requested scoped cleanup of this document's stored copies. */
  readonly purgeActiveDocument: () => void;
  /** Delete vault blobs no document references any more (`vault.ts`). */
  readonly sweepVault: () => void;
  /**
   * Offline readiness: the worker's own answer, and the
   * preparation pass that fills the cache. Both are app callbacks rather than an
   * `OfflinePanel`, because the answer is one line and the panel that would hold it
   * would be a surface without content.
   */
  readonly checkOffline: () => void;
  readonly prepareOfflinePackages: () => void;
}

/**
 * A command's shortcut hint is **read from the binding table** (`useShortcuts.ts`)
 * rather than typed here, so a hint cannot name a chord nothing listens for and the
 * help surface cannot list a chord the menu disagrees with. A command whose
 * capability has no binding gets no hint at all.
 */

/**
 * The commands the simple mode offers.
 *
 * Derived from what the reference readers ship for free — Adobe Acrobat Reader's
 * annotate/fill/sign set, ONLYOFFICE's default tab, and the common verb list every
 * commercial reader advertises (*edit, annotate, sign, fill, merge, split, print*) — so
 * "simple" means *the features people actually reach for*, not an arbitrary subset.
 *
 * Everything not listed here is advanced: redaction, encryption, permissions, OCR, batch
 * runs, measurement, accessibility audit, document comparison, layers, attachments, page
 * boxes and labels, watermarks, Bates numbering, compression, image/text export, outline
 * editing, image editing, vault and offline tooling.
 */
const SIMPLE_MODE_COMMANDS: ReadonlySet<string> = new Set([
  // File: the verbs every reader has.
  'file.new',
  'file.merge',
  'file.convert',
  'file.create-images',
  'file.save',
  'file.export',
  'file.print',
  'file.add',
  // Edit: undo/redo and selection are table stakes.
  'edit.undo',
  'edit.redo',
  'edit.select-all-pages',
  'edit.clear-selection',
  // Mark selection and its editing controls are available in the simple mode.
  'edit.select-all-marks',
  'edit.delete-mark',
  'edit.rename',
  // View: reading is the point of the application.
  'view.zoom-in',
  'view.zoom-out',
  'view.zoom-reset',
  'view.fit-width',
  'view.fit-page',
  'view.single',
  'view.book',
  'view.fullscreen',
  'view.reading',
  'view.left-dock',
  'view.right-dock',
  // Page: rotate, duplicate, delete and extract cover organising a document.
  'page.rotate-left',
  'page.rotate-right',
  'page.duplicate',
  'page.delete',
  'page.extract',
  // Tools: the annotation, form and signature set the free tier of every reader carries.
  'tools.select',
  'tools.hand',
  'tools.highlight',
  'tools.underline',
  'tools.strikeout',
  'tools.text-edit',
  'tools.note',
  'tools.shapes',
  'tools.ink',
  'tools.sign',
  'tools.signature-simple',
  'tools.image-add',
  'tools.form-fields',
  'tools.link',
  'tools.numbering',
  'tools.watermark',
  // PDF to Word and Excel is the conversion every reader advertises on its first screen.
  'tools.export-office',
  // Help: the palette and the shortcut list are how the rest is discovered.
  'help.palette',
  'help.shortcuts',
  // Offered in every mode: AGPL-3.0 §13 gives every user of the app its source.
  'help.source',
  // Settings hold the language and the way back to the advanced mode: never hidden.
  'settings.open',
]);

/**
 * The tools-rail groups the simple mode keeps.
 *
 * The rail groups are coarser than the command list, so they are named here rather than
 * derived from it: `security` holds redaction, encryption and permission removal, and
 * `stamp` holds Bates numbering and watermarks. Both are advanced-only in the reference
 * readers, while `pages`, `export` and `sign` are free-tier capabilities that must not
 * disappear behind the filter.
 */
export const SIMPLE_MODE_RAIL_GROUPS: readonly string[] = ['pages', 'export', 'sign'];

/**
 * The dock tabs the simple mode keeps.
 *
 * `attachments`, `layers` and `signatures` are readers for advanced structure. The
 * signatures tab lists signature *fields*; signing itself is a tool and stays available.
 */
export const SIMPLE_MODE_DOCK_TABS: readonly DocumentPanelTab[] = ['pages', 'outline', 'search'];

/**
 * Commands that start a document instead of acting on the open one: they run with no
 * document, so the home screen runs them straight away rather than asking for a file.
 */
export const STANDALONE_COMMAND_IDS: ReadonlySet<string> = new Set([
  'file.new',
  'file.merge',
  'file.convert',
  'file.create-images',
  'file.batch',
]);

/** Whether a command is offered in the given mode. */
export function isCommandVisible(command: Command, mode: InterfaceMode): boolean {
  return mode === 'advanced' || SIMPLE_MODE_COMMANDS.has(command.id);
}

/** The commands a surface should render for the given mode. */
export function visibleCommands(commands: readonly Command[], mode: InterfaceMode): readonly Command[] {
  return commands.filter((command) => isCommandVisible(command, mode));
}

export function buildCommands(host: CommandHost): readonly Command[] {
  const noDocument = !host.hasDocument;
  const noEdit = !host.canEdit;
  const noSelection = host.selectedPages.length === 0 || noEdit;
  const dialog = (id: string) => () => host.openDialog(id);
  const action = (kind: PageAction) => () => host.pageAction(kind);
  /**
   * A canvas tool toggle: arming the tool that is already armed puts the tool away, so
   * one command is both "start" and "stop" and the checked state is never a lie.
   * `checked` is read from the same canonical value the rail draws with, which is what
   * makes the menu and the toolbar agree after a palette or context-menu arming.
   */
  const tool = (kind: CanvasToolId) => () => host.armTool(host.activeTool === kind ? 'select' : kind);

  const file: Command[] = [
    {
      id: 'file.new',
      labelKey: 'start.blank.title',
      group: 'file',
      // Enabled without a document: it starts one.
      keywords: ['new', 'blank', 'empty', 'yeni', 'bos', 'belge'],
      run: dialog('new-document'),
    },
    {
      id: 'file.open',
      labelKey: 'shell.open',
      group: 'file',
      shortcut: shortcutHint('file.open'),
      run: host.openFile,
    },
    {
      id: 'file.merge',
      labelKey: 'start.merge.title',
      group: 'file',
      keywords: ['merge', 'combine', 'join', 'birlestir', 'birlestirme'],
      run: dialog('merge-files'),
    },
    {
      id: 'file.convert',
      labelKey: 'convert.command',
      group: 'file',
      // Standalone: Word, Excel, PowerPoint, HTML, text, CSV or EPUB in, a new PDF tab out.
      keywords: [
        'convert',
        'donustur',
        'word',
        'docx',
        'excel',
        'xlsx',
        'powerpoint',
        'pptx',
        'html',
        'txt',
        'csv',
        'epub',
        'office',
      ],
      run: dialog('convert-to-pdf'),
    },
    {
      id: 'file.save',
      labelKey: 'shell.save',
      group: 'file',
      shortcut: shortcutHint('file.save'),
      disabled: !host.canSave,
      run: host.save,
    },
    {
      id: 'file.export',
      labelKey: 'shell.export',
      group: 'file',
      shortcut: shortcutHint('file.export'),
      disabled: !host.canExport,
      run: host.exportDocument,
    },
    {
      id: 'file.add',
      labelKey: 'file.add.title',
      group: 'file',
      disabled: noEdit,
      run: dialog('add-document'),
    },
    {
      id: 'file.batch',
      labelKey: 'batch.title',
      group: 'file',
      // Enabled without a document: a batch starts from files on disk, not from the tab.
      keywords: ['batch', 'queue', 'toplu', 'kuyruk'],
      run: host.openBatch,
    },
    {
      id: 'file.create-images',
      labelKey: 'file.createImages.title',
      group: 'file',
      // Standalone: it opens its result as a new tab whether or not a document is open.
      keywords: ['image', 'photo', 'jpg', 'png', 'gorsel', 'resim', 'fotograf'],
      run: dialog('images-to-pdf'),
    },
    {
      id: 'file.print',
      labelKey: 'print.start',
      group: 'file',
      shortcut: shortcutHint('file.print'),
      disabled: noDocument,
      run: host.print,
    },
    { id: 'file.close', labelKey: 'shell.closeTab', group: 'file', disabled: noDocument, run: host.closeTab },
  ];

  const edit: Command[] = [
    {
      id: 'edit.undo',
      labelKey: 'shell.undo',
      group: 'edit',
      shortcut: shortcutHint('edit.undo'),
      disabled: !host.canUndo,
      run: host.undo,
    },
    {
      id: 'edit.redo',
      labelKey: 'shell.redo',
      group: 'edit',
      shortcut: shortcutHint('edit.redo'),
      disabled: !host.canRedo,
      run: host.redo,
    },
    {
      id: 'edit.select-all-pages',
      labelKey: 'pages.select.all',
      group: 'edit',
      disabled: noDocument,
      run: host.selectAllPages,
    },
    {
      id: 'edit.clear-selection',
      labelKey: 'pages.select.none',
      group: 'edit',
      disabled: noSelection,
      run: host.clearSelection,
    },
    {
      // This deletes selected marks across every family in one journal step,
      // never a page or its underlying document text.
      id: 'edit.delete-mark',
      labelKey: 'ann.remove',
      group: 'edit',
      shortcut: shortcutHint('edit.delete-mark'),
      disabled: noEdit || host.selectedMarkCount === 0,
      keywords: ['delete', 'remove', 'mark', 'sil', 'isaret', 'not'],
      run: host.deleteMarkSelection,
    },
    {
      // Reachable from the palette and the menu as well as the keyboard, and enabled
      // only where it can answer: the select tool with a document open.
      id: 'edit.select-all-marks',
      labelKey: 'ann.selectAll',
      group: 'edit',
      shortcut: shortcutHint('edit.select-all-marks'),
      disabled: noDocument || host.activeTool !== 'select',
      keywords: ['select all', 'marks', 'tumunu sec', 'isaret'],
      run: host.selectAllMarks,
    },
    {
      id: 'edit.rename',
      labelKey: 'shell.rename',
      group: 'edit',
      disabled: noDocument,
      run: host.rename,
    },
  ];

  const view: Command[] = [
    {
      id: 'view.zoom-in',
      labelKey: 'viewer.zoom',
      group: 'view',
      shortcut: shortcutHint('view.zoom-in'),
      disabled: noDocument,
      run: () => host.setZoom(Math.min(4, host.zoom + 0.25)),
    },
    {
      id: 'view.zoom-out',
      labelKey: 'viewer.zoom',
      group: 'view',
      shortcut: shortcutHint('view.zoom-out'),
      disabled: noDocument,
      run: () => host.setZoom(Math.max(0.25, host.zoom - 0.25)),
    },
    {
      id: 'view.zoom-reset',
      labelKey: 'viewer.zoom',
      group: 'view',
      shortcut: shortcutHint('view.zoom-reset'),
      disabled: noDocument,
      run: () => host.setZoom(1),
    },
    {
      id: 'view.fit-width',
      labelKey: 'viewer.fitWidth',
      group: 'view',
      shortcut: shortcutHint('view.fit-width'),
      disabled: noDocument,
      run: () => host.setZoom('page-width'),
    },
    {
      id: 'view.fit-page',
      labelKey: 'viewer.fitPage',
      group: 'view',
      disabled: noDocument,
      run: () => host.setZoom('page-fit'),
    },
    {
      id: 'view.single',
      labelKey: 'viewer.singlePage',
      group: 'view',
      disabled: noDocument,
      run: () => host.setSpread('single'),
    },
    {
      id: 'view.book',
      labelKey: 'viewer.book',
      group: 'view',
      disabled: noDocument,
      run: () => host.setSpread('book'),
    },
    {
      id: 'view.fullscreen',
      labelKey: 'viewer.fullscreen',
      group: 'view',
      disabled: noDocument,
      run: host.toggleFullscreen,
    },
    {
      id: 'view.reading',
      labelKey: 'reading.toggle',
      group: 'view',
      shortcut: shortcutHint('view.reading'),
      disabled: noDocument,
      checked: host.reading,
      run: host.toggleReading,
    },
    {
      id: 'view.magnifier',
      labelKey: 'tools.magnifier',
      group: 'view',
      disabled: noDocument,
      checked: host.magnifier,
      run: host.toggleMagnifier,
    },
    {
      id: 'view.layers',
      labelKey: 'panel.layers',
      group: 'view',
      disabled: noDocument,
      keywords: ['layer', 'ocg', 'katman'],
      // The layer write lives behind a tab, so a command that cannot open that tab is
      // not a way in.
      run: () => host.openLeftTab('layers'),
    },
    {
      id: 'view.outline',
      labelKey: 'panel.outline',
      group: 'view',
      disabled: noDocument,
      keywords: ['outline', 'bookmark', 'icindekiler'],
      run: () => host.openLeftTab('outline'),
    },
    {
      id: 'view.left-dock',
      labelKey: 'dock.toggleLeft',
      group: 'view',
      shortcut: shortcutHint('view.left-dock'),
      checked: host.leftDock,
      disabled: noDocument,
      run: host.toggleLeftDock,
    },
    {
      id: 'view.right-dock',
      labelKey: 'dock.toggleRight',
      group: 'view',
      shortcut: shortcutHint('view.right-dock'),
      checked: host.rightDock,
      disabled: noDocument,
      run: host.toggleRightDock,
    },
  ];

  const page: Command[] = [
    {
      id: 'page.rotate-left',
      labelKey: 'pages.rotate.left',
      group: 'page',
      disabled: noSelection,
      run: action({ kind: 'rotate', direction: 'left' }),
    },
    {
      id: 'page.rotate-right',
      labelKey: 'pages.rotate.right',
      group: 'page',
      disabled: noSelection,
      run: action({ kind: 'rotate', direction: 'right' }),
    },
    {
      id: 'page.duplicate',
      labelKey: 'pages.duplicate',
      group: 'page',
      disabled: noSelection,
      run: action({ kind: 'duplicate' }),
    },
    {
      id: 'page.delete',
      labelKey: 'pages.delete',
      group: 'page',
      danger: true,
      disabled: noSelection,
      run: action({ kind: 'delete' }),
    },
    {
      id: 'page.extract',
      labelKey: 'pages.extract.title',
      group: 'page',
      disabled: noSelection,
      run: dialog('extract-pages'),
    },
    { id: 'page.split', labelKey: 'split.title', group: 'page', disabled: noEdit, run: dialog('split') },
  ];

  page.push(
    {
      id: 'page.insert',
      labelKey: 'insert.title',
      group: 'page',
      disabled: noEdit,
      keywords: ['add', 'blank', 'image'],
      run: dialog('insert-pages'),
    },
    {
      id: 'page.replace',
      labelKey: 'replace.title',
      group: 'page',
      disabled: noEdit || noSelection,
      run: dialog('replace-pages'),
    },
    {
      id: 'page.boxes',
      labelKey: 'boxes.title',
      group: 'page',
      disabled: noEdit,
      keywords: ['crop', 'media', 'trim', 'bleed', 'art', 'resize'],
      run: dialog('page-boxes'),
    },
    {
      id: 'page.labels',
      labelKey: 'labels.dialog.title',
      group: 'page',
      disabled: noEdit,
      keywords: ['numbering', 'roman', 'prefix'],
      run: dialog('page-labels'),
    },
  );

  const tools: Command[] = [
    {
      id: 'tools.numbering',
      labelKey: 'stamp.title',
      group: 'tools',
      disabled: noEdit,
      run: dialog('page-numbers'),
    },
    {
      id: 'tools.watermark',
      labelKey: 'watermark.title',
      group: 'tools',
      disabled: noEdit,
      run: dialog('watermark'),
    },
    {
      id: 'tools.optimize',
      labelKey: 'optimize.title',
      group: 'tools',
      disabled: noEdit,
      run: dialog('compress'),
    },
    { id: 'tools.impose', labelKey: 'impose.title', group: 'tools', disabled: noEdit, run: dialog('impose') },
    { id: 'tools.ocr', labelKey: 'ocr.title', group: 'tools', disabled: noEdit, run: dialog('ocr') },
    {
      id: 'tools.redact',
      labelKey: 'redact.title',
      group: 'tools',
      danger: true,
      disabled: noDocument,
      run: dialog('redact'),
    },
    {
      id: 'tools.security',
      labelKey: 'security.title',
      group: 'tools',
      disabled: noEdit,
      run: dialog('protect'),
    },
    {
      id: 'tools.unlock',
      labelKey: 'security.unlock.title',
      group: 'tools',
      disabled: noEdit,
      run: dialog('unlock'),
    },
    {
      id: 'tools.properties',
      labelKey: 'properties.title',
      group: 'tools',
      shortcut: shortcutHint('tools.properties'),
      disabled: noDocument,
      run: dialog('properties'),
    },
    {
      id: 'tools.export-images',
      labelKey: 'export.images.title',
      group: 'tools',
      disabled: noEdit,
      run: dialog('export-images'),
    },
    {
      id: 'tools.export-text',
      labelKey: 'export.text.title',
      group: 'tools',
      disabled: noEdit,
      run: dialog('export-text'),
    },
    {
      id: 'tools.export-office',
      labelKey: 'export.office.title',
      group: 'tools',
      disabled: noEdit,
      keywords: ['word', 'excel', 'docx', 'xlsx', 'csv', 'office', 'tablo', 'table'],
      run: dialog('export-office'),
    },
    {
      id: 'tools.outline-edit',
      labelKey: 'outline.title',
      group: 'tools',
      disabled: noEdit,
      keywords: ['outline', 'bookmark', 'contents', 'icindekiler'],
      run: dialog('outline-edit'),
    },
  ];

  tools.unshift(
    {
      id: 'tools.select',
      labelKey: 'toolbar.select',
      group: 'tools',
      disabled: noDocument,
      checked: host.activeTool === 'select',
      run: tool('select'),
    },
    {
      id: 'tools.hand',
      labelKey: 'toolbar.hand',
      group: 'tools',
      disabled: noDocument,
      checked: host.activeTool === 'hand',
      run: tool('hand'),
    },
    {
      id: 'tools.highlight',
      labelKey: 'ann.tool.highlight',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'highlight',
      keywords: ['marker', 'markup'],
      run: tool('highlight'),
    },
    {
      id: 'tools.text-edit',
      labelKey: 'cmd.textEdit.label',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'text',
      keywords: ['text', 'paragraph', 'edit', 'metin', 'paragraf', 'duzenle'],
      run: tool('text'),
    },
    {
      id: 'tools.underline',
      labelKey: 'ann.tool.underline',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'underline',
      run: tool('underline'),
    },
    {
      id: 'tools.strikeout',
      labelKey: 'ann.tool.strikeout',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'strikeout',
      run: tool('strikeout'),
    },
    {
      id: 'tools.squiggly',
      labelKey: 'ann.tool.squiggly',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'squiggly',
      run: tool('squiggly'),
    },
    {
      id: 'tools.ink',
      labelKey: 'ann.tool.ink',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'ink',
      run: tool('ink'),
    },
    {
      id: 'tools.shapes',
      labelKey: 'ann.tool.shapes',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'shapes',
      run: tool('shapes'),
    },
    {
      id: 'tools.note',
      labelKey: 'ann.tool.note',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'note',
      run: tool('note'),
    },
    {
      id: 'tools.image-edit',
      labelKey: 'image.title',
      group: 'tools',
      disabled: noEdit,
      keywords: ['image', 'resim', 'gorsel', 'replace'],
      run: dialog('image-edit'),
    },
    {
      id: 'tools.measure-distance',
      labelKey: 'tools.measure.distance',
      group: 'tools',
      disabled: noEdit,
      checked: host.measureMode === 'distance',
      keywords: ['measure', 'olcum', 'mesafe', 'ruler', 'cetvel'],
      run: () => host.measure('distance'),
    },
    {
      id: 'tools.measure-perimeter',
      labelKey: 'tools.measure.perimeter',
      group: 'tools',
      disabled: noEdit,
      checked: host.measureMode === 'perimeter',
      keywords: ['measure', 'olcum', 'cevre'],
      run: () => host.measure('perimeter'),
    },
    {
      id: 'tools.measure-area',
      labelKey: 'tools.measure.area',
      group: 'tools',
      disabled: noEdit,
      checked: host.measureMode === 'area',
      keywords: ['measure', 'olcum', 'alan'],
      run: () => host.measure('area'),
    },
    {
      id: 'tools.compare',
      labelKey: 'compare.title',
      group: 'tools',
      // A comparison reads; it needs a document, not the right to edit one.
      disabled: noDocument,
      keywords: ['compare', 'karsilastir', 'diff', 'fark'],
      run: () => host.showRightTab('compare'),
    },
    {
      id: 'tools.accessibility',
      labelKey: 'panel.a11y',
      group: 'tools',
      disabled: noDocument,
      keywords: ['accessibility', 'erisilebilirlik', 'tagged', 'etiket', 'alt'],
      run: () => host.showRightTab('accessibility'),
    },
    {
      id: 'tools.sign',
      labelKey: 'sign.open',
      group: 'tools',
      // Signing is offered for any open document: a read-only session may still produce a
      // signed copy, and the dialog never writes into the engine's working copy directly —
      // the signed bytes arrive as a session version like any other result.
      disabled: noDocument,
      keywords: ['sign', 'imza', 'pades', 'pkcs12', 'p12', 'sertifika'],
      run: dialog('sign'),
    },
    {
      id: 'tools.signature-simple',
      labelKey: 'sig.command',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'stamp',
      keywords: ['signature', 'imza', 'paraf', 'initials', 'ciz', 'draw', 'e-imza'],
      run: host.openSignature,
    },
    {
      id: 'tools.image-add',
      labelKey: 'img.add.title',
      group: 'tools',
      disabled: noEdit,
      keywords: ['image', 'picture', 'logo', 'gorsel', 'resim', 'fotograf', 'ekle'],
      run: host.addImage,
    },
    {
      id: 'tools.link',
      labelKey: 'link.tool',
      group: 'tools',
      disabled: noEdit,
      checked: host.activeTool === 'link',
      keywords: ['link', 'url', 'baglanti'],
      // A link is a drag, not a mark; arming works exactly like the mark tools, which
      // is why the annotation layer owns both gestures.
      run: tool('link'),
    },
    {
      id: 'tools.form-fields',
      labelKey: 'form.dialog.fields.title',
      group: 'tools',
      disabled: noEdit,
      run: dialog('form-fields'),
    },
    {
      id: 'tools.form-create',
      labelKey: 'form.dialog.create.title',
      group: 'tools',
      disabled: noEdit,
      run: dialog('form-create-field'),
    },
    {
      id: 'tools.form-data',
      labelKey: 'form.dialog.data.title',
      group: 'tools',
      disabled: noDocument,
      run: dialog('form-data'),
    },
    {
      id: 'tools.redaction-audit',
      labelKey: 'audit.title',
      group: 'tools',
      disabled: noDocument,
      run: host.showRedactionAudit,
    },
  );

  const settings: Command[] = [
    {
      id: 'settings.open',
      labelKey: 'settings.open',
      group: 'settings',
      keywords: [
        'settings',
        'preferences',
        'ayarlar',
        'tercihler',
        'dil',
        'language',
        'tema',
        'theme',
        'mod',
        'mode',
      ],
      run: host.openSettings,
    },
    {
      id: 'settings.theme.light',
      labelKey: 'setting.theme.light',
      group: 'settings',
      checked: host.theme === 'light',
      keywords: ['theme', 'light', 'tema', 'acik', 'renk', 'beyaz', 'ayarlar'],
      run: () => host.setTheme('light'),
    },
    {
      id: 'settings.theme.dark',
      labelKey: 'setting.theme.dark',
      group: 'settings',
      checked: host.theme === 'dark',
      keywords: ['theme', 'dark', 'tema', 'koyu', 'gece', 'siyah', 'ayarlar'],
      run: () => host.setTheme('dark'),
    },
    {
      id: 'settings.theme.system',
      labelKey: 'setting.theme.system',
      group: 'settings',
      checked: host.theme === 'system',
      keywords: ['theme', 'system', 'tema', 'sistem', 'otomatik', 'ayarlar'],
      run: () => host.setTheme('system'),
    },
    {
      id: 'settings.sensitive-session',
      labelKey: 'setting.sensitiveSession',
      group: 'settings',
      checked: host.sensitiveSession,
      keywords: ['sensitive', 'session', 'hassas', 'oturum', 'gizli', 'taslak', 'draft', 'guvenlik'],
      run: host.toggleSensitiveSession,
    },
    {
      id: 'settings.opfs-save',
      labelKey: 'setting.opfsSave',
      group: 'settings',
      disabled: noDocument,
      keywords: ['opfs', 'draft', 'save', 'taslak', 'depolama', 'kaydet', 'tarayici'],
      run: host.opfsSave,
    },
    {
      id: 'settings.purge-document',
      labelKey: 'setting.purgeDocument',
      group: 'settings',
      disabled: noDocument,
      keywords: ['purge', 'delete', 'draft', 'vault', 'sil', 'temizle', 'taslak', 'gizlilik', 'mahremiyet'],
      run: host.purgeActiveDocument,
    },
    {
      id: 'settings.sweep-vault',
      labelKey: 'setting.sweepVault',
      group: 'settings',
      keywords: ['sweep', 'orphan', 'vault', 'cleanup', 'temizle', 'artik', 'depo', 'opfs'],
      run: host.sweepVault,
    },
  ];

  const help: Command[] = [
    {
      id: 'help.palette',
      labelKey: 'shell.commandPalette',
      group: 'help',
      shortcut: shortcutHint('help.palette'),
      run: host.palette,
    },
    {
      id: 'help.shortcuts',
      labelKey: 'shell.shortcuts.title',
      group: 'help',
      // No `disabled`: the list is a property of the build, not of what is open.
      run: host.showShortcuts,
    },
    {
      id: 'help.offline',
      labelKey: 'shell.about.offline',
      group: 'help',
      // Both commands work without a document: the cache is a property of the build,
      // not of what is open.
      keywords: ['offline', 'cevrimdisi', 'hazirlik', 'package', 'paket', 'cache', 'onbellek'],
      run: host.checkOffline,
    },
    {
      id: 'help.prepare-offline',
      labelKey: 'shell.about.prepare',
      group: 'help',
      keywords: ['offline', 'prepare', 'hazirla', 'indir', 'download', 'paket', 'package'],
      run: host.prepareOfflinePackages,
    },
    {
      id: 'help.source',
      labelKey: 'shell.about.source',
      group: 'help',
      // AGPL-3.0 §13: users of the deployed app are offered its corresponding source.
      keywords: ['source', 'code', 'kaynak', 'kod', 'github', 'agpl', 'license', 'lisans'],
      run: () => {
        window.open(SOURCE_URL, '_blank', 'noopener,noreferrer');
      },
    },
  ];

  return [...file, ...edit, ...view, ...page, ...tools, ...settings, ...help];
}

/** Palette keywords: search by the Turkish label plus the id's English words. */
export function commandKeywords(command: Command): readonly string[] {
  return [command.id.split('.').join(' '), ...(command.keywords ?? [])];
}
