// @vitest-environment happy-dom
/**
 * Opening and running the operation dialogs: the exact calls the openers make into the
 * session, the engine and the busy gate, what each result does with the produced files, and
 * what the status line says.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import type { OperationDialogSpec, OpRunResult } from 'pdf-ui/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelOperation,
  clearNotice,
  coreStore,
  initialCoreState,
  operationRunning,
  setBusy,
} from '../core/core-store';
import { adoptHandle, dropHandle, handleFor } from '../core/handles';
import {
  erasedWordsOf,
  initialRedactionState,
  redactedWordsRead,
  redactionStore,
} from '../marks/redaction-store';
import { initialResultsState, resultsStore } from '../results/results-store';
import { createDialogOpeners, createDialogRuns } from './dialog-actions';
import {
  dialogsStore,
  initialDialogsState,
  operationDialogOpened,
  shortcutsOpened,
  startDialogOpened,
} from './dialogs-store';

const mocks = vi.hoisted(() => ({
  dialogById: vi.fn(),
  hasDialog: vi.fn(),
  isStandaloneDialog: vi.fn(),
  applyProducedBytes: vi.fn(),
  downloadFiles: vi.fn(),
  materializeBase: vi.fn(),
  pendingOverlays: vi.fn(),
  redactionNeedles: vi.fn(),
  listPdfImages: vi.fn(),
  unlockDocument: vi.fn(),
}));
vi.mock('pdf-ui/ui', () => ({
  dialogById: mocks.dialogById,
  hasDialog: mocks.hasDialog,
  isStandaloneDialog: mocks.isStandaloneDialog,
}));
vi.mock('../../operations', () => ({
  applyProducedBytes: mocks.applyProducedBytes,
  downloadFiles: mocks.downloadFiles,
  materializeBase: mocks.materializeBase,
  pendingOverlays: mocks.pendingOverlays,
  redactionNeedles: mocks.redactionNeedles,
}));
vi.mock('../../lazy-ops', () => ({ listPdfImages: mocks.listPdfImages }));
vi.mock('pdf-core/ops/security', () => ({ unlockDocument: mocks.unlockDocument }));

const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`) as unknown as Translator;

const handle = { name: 'handle' } as unknown as PdfDocumentHandle;
const produced = { name: 'produced' } as unknown as PdfDocumentHandle;
const notice = () => coreStore.get().notice;
const busy = () => coreStore.get().busy;
const failure = (error: ToolError) => `${error.messageKey} ${error.hintKey}`;
const internal = new ToolError('internal', { engine: 'model' });

let session: SessionStore;
let tab: SessionTab;
const setImages = vi.fn();
const openProducedTab =
  vi.fn<(name: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<string | null>>();

const spec = (over: Record<string, unknown> = {}): OperationDialogSpec =>
  ({ id: 'compress', titleKey: 'op.compress.title', resultKind: 'replace', ...over }) as never;
const specs = new Map<string, OperationDialogSpec>();

function openers() {
  return createDialogOpeners({
    session,
    t,
    setImages,
  });
}

function runs(over: { dialogContext?: never; lockedTabs?: ReadonlyMap<string, string> } = {}) {
  return createDialogRuns({
    session,
    t,
    openProducedTab,
    dialogContext: over.dialogContext ?? null,
    lockedTabs: over.lockedTabs ?? new Map(),
  });
}

/** Wait for the opener's background work to finish and release the busy gate. */
const settled = () => vi.waitFor(() => expect(busy()).toBe(false));

function bump(): void {
  session.applyOperation({
    tabId: tab.id,
    bytes: new Uint8Array([9]),
    pageCount: 1,
    labelKey: 'op.compress.title' as never,
    engine: 'mupdf',
    steps: [],
    overlays: null,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const bytes = new Uint8Array([4, 5, 6]);

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  resultsStore.set(initialResultsState());
  dialogsStore.set(initialDialogsState());
  redactionStore.set(initialRedactionState());
  session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]), sha256: 'hash', pageCount: 4 });
  tab = session.active as SessionTab;
  adoptHandle(tab.id, handle);
  specs.clear();
  mocks.hasDialog.mockReturnValue(true);
  mocks.isStandaloneDialog.mockReturnValue(false);
  mocks.dialogById.mockImplementation(async (id: string) => specs.get(id));
  specs.set('compress', spec());
  mocks.materializeBase.mockResolvedValue(bytes);
  mocks.pendingOverlays.mockReturnValue({ annotations: [], measures: [], redactions: [] });
  mocks.applyProducedBytes.mockResolvedValue(produced);
  mocks.redactionNeedles.mockResolvedValue([]);
  mocks.listPdfImages.mockResolvedValue({ images: [] });
  openProducedTab.mockResolvedValue(null);
});
afterEach(() => {
  dropHandle(tab.id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('openDialog', () => {
  it('opens the camera scanner as a modal of its own, not an operation dialog', () => {
    coreStore.set({ notice: 'old' });
    openers().openDialog('scan-camera');
    expect(resultsStore.get().scanOpen).toBe(true);
    expect(notice()).toBeNull();
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(busy()).toBe(false);
  });

  it('ignores an id no capability owns', () => {
    mocks.hasDialog.mockReturnValue(false);
    openers().openDialog('nope');
    expect(mocks.hasDialog).toHaveBeenCalledWith('nope');
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(busy()).toBe(false);
  });

  it('loads a standalone operation’s spec into its modal without freezing any bytes', async () => {
    mocks.isStandaloneDialog.mockReturnValue(true);
    specs.set('merge', spec({ id: 'merge' }));
    coreStore.set({ notice: 'old' });
    openers().openDialog('merge');
    await vi.waitFor(() => expect(dialogsStore.get().startSpec).toBe(specs.get('merge')));
    expect(notice()).toBeNull();
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(dialogsStore.get().dialogSpec).toBeNull();
  });

  it('opens nothing when the standalone operation has no spec', async () => {
    mocks.isStandaloneDialog.mockReturnValue(true);
    openers().openStart('missing');
    await vi.waitFor(() => expect(mocks.dialogById).toHaveBeenCalledWith('missing'));
    await Promise.resolve();
    expect(dialogsStore.get().startSpec).toBeNull();
  });

  it('refuses a standalone operation while another operation holds the gate', () => {
    setBusy(true);
    openers().openStart('merge');
    expect(notice()).toBe(t('op.busy'));
    expect(mocks.dialogById).not.toHaveBeenCalled();
  });

  it('does nothing without an active tab or without its engine handle', () => {
    dropHandle(tab.id);
    openers().openDialog('compress');
    session.closeTab(tab.id);
    openers().openDialog('compress');
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(busy()).toBe(false);
    expect(coreStore.get().notice).toBeNull();
  });

  it('refuses while another operation holds the gate, whether it is the flag or a run in flight', () => {
    setBusy(true);
    openers().openDialog('compress');
    expect(notice()).toBe(t('op.busy'));
    clearNotice();
    setBusy(false);
    coreStore.set({ operation: new AbortController() });
    openers().openDialog('compress');
    expect(notice()).toBe(t('op.busy'));
    expect(mocks.materializeBase).not.toHaveBeenCalled();
  });

  it('freezes the working bytes, stores the dialog beside them and opens the tools panel', async () => {
    coreStore.set({ notice: 'old', rightDock: false, rightTab: 'history' });
    openers().openDialog('compress');

    expect(busy()).toBe(true);
    expect(operationRunning()).toBe(true);
    expect(notice()).toBeNull();
    await settled();
    expect(mocks.materializeBase).toHaveBeenCalledWith(
      { store: session, t, tab, handle },
      {
        signal: expect.any(AbortSignal),
      },
    );
    expect(dialogsStore.get().dialogSpec).toBe(specs.get('compress'));
    expect(dialogsStore.get().dialogInput).toEqual({
      tabId: tab.id,
      workingId: tab.working.id,
      name: 'a.pdf',
      pageCount: 4,
      bytes,
    });
    expect(Object.hasOwn(dialogsStore.get().dialogInput ?? {}, 'presets')).toBe(false);
    expect(setImages).toHaveBeenCalledWith(null);
    expect(mocks.listPdfImages).not.toHaveBeenCalled();
    expect(coreStore.get()).toMatchObject({ rightDock: true, rightTab: 'tools' });
    expect(operationRunning()).toBe(false);
  });

  it('carries the opener’s presets into the frozen input', async () => {
    openers().openDialog('compress', { level: 'high' });
    await settled();
    expect(dialogsStore.get().dialogInput?.presets).toEqual({ level: 'high' });
  });

  it('reads the image dialog’s target list from the same frozen bytes', async () => {
    const listing = [{ id: 'img-1' }];
    mocks.listPdfImages.mockResolvedValue({ images: listing });
    specs.set('image-edit', spec({ id: 'image-edit' }));
    openers().openDialog('image-edit');
    await settled();
    expect(mocks.listPdfImages).toHaveBeenCalledWith(bytes, { signal: expect.any(AbortSignal) });
    expect(setImages).toHaveBeenCalledWith(listing);
    expect(dialogsStore.get().dialogSpec).toBe(specs.get('image-edit'));
  });

  it('opens nothing when the tab was switched while the bytes were being frozen', async () => {
    const frozen = deferred<Uint8Array>();
    mocks.materializeBase.mockReturnValue(frozen.promise);
    openers().openDialog('compress');
    session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([2]), sha256: 'b', pageCount: 1 });
    frozen.resolve(bytes);
    await settled();
    expect(mocks.dialogById).not.toHaveBeenCalled();
    expect(dialogsStore.get().dialogSpec).toBeNull();
    expect(operationRunning()).toBe(false);
  });

  it('opens nothing when the tab was closed while the bytes were being frozen', async () => {
    const frozen = deferred<Uint8Array>();
    mocks.materializeBase.mockReturnValue(frozen.promise);
    openers().openDialog('compress');
    session.closeTab(tab.id);
    frozen.resolve(bytes);
    await settled();
    expect(dialogsStore.get().dialogSpec).toBeNull();
  });

  it('opens nothing when an operation landed on the version being frozen', async () => {
    const frozen = deferred<Uint8Array>();
    mocks.materializeBase.mockReturnValue(frozen.promise);
    openers().openDialog('compress');
    bump();
    frozen.resolve(bytes);
    await settled();
    expect(dialogsStore.get().dialogSpec).toBeNull();
  });

  it('opens nothing when the capability has no spec', async () => {
    specs.delete('compress');
    openers().openDialog('compress');
    await settled();
    expect(dialogsStore.get().dialogSpec).toBeNull();
    expect(notice()).toBeNull();
  });

  it('opens nothing when the tab changed while the spec was loading', async () => {
    const loading = deferred<OperationDialogSpec>();
    mocks.dialogById.mockReturnValue(loading.promise);
    openers().openDialog('compress');
    await vi.waitFor(() => expect(mocks.dialogById).toHaveBeenCalled());
    bump();
    loading.resolve(spec());
    await settled();
    expect(dialogsStore.get().dialogSpec).toBeNull();
  });

  it('opens nothing when the tab changed while the image list was being read', async () => {
    const listing = deferred<{ images: never[] }>();
    mocks.listPdfImages.mockReturnValue(listing.promise);
    specs.set('image-edit', spec({ id: 'image-edit' }));
    openers().openDialog('image-edit');
    await vi.waitFor(() => expect(mocks.listPdfImages).toHaveBeenCalled());
    bump();
    listing.resolve({ images: [] });
    await settled();
    expect(setImages).not.toHaveBeenCalled();
    expect(dialogsStore.get().dialogSpec).toBeNull();
  });

  it('refuses a dialog that would leave the tab while redaction marks are staged', async () => {
    specs.set('compress', spec({ resultKind: 'download' }));
    mocks.pendingOverlays.mockReturnValue({ annotations: [], measures: [], redactions: [{ mark: {} }] });
    openers().openDialog('compress');
    await settled();
    expect(notice()).toBe(failure(new ToolError('pending-redactions', { engine: 'model' })));
    expect(dialogsStore.get().dialogSpec).toBeNull();
  });

  it('opens a dialog that applies to the tab while marks are staged', async () => {
    mocks.pendingOverlays.mockReturnValue({ annotations: [], measures: [], redactions: [{ mark: {} }] });
    openers().openDialog('compress');
    await settled();
    expect(dialogsStore.get().dialogSpec).toBe(specs.get('compress'));
  });

  it('says what failed, in the engine’s words, and releases the gate', async () => {
    const error = new ToolError('selection-empty', { engine: 'model' });
    mocks.materializeBase.mockRejectedValue(error);
    openers().openDialog('compress');
    await settled();
    expect(notice()).toBe(failure(error));
    expect(dialogsStore.get().dialogSpec).toBeNull();
  });

  it('says an unexpected failure was internal', async () => {
    mocks.materializeBase.mockRejectedValue(new Error('boom'));
    openers().openDialog('compress');
    await settled();
    expect(notice()).toBe(failure(internal));
  });

  it('stays silent about a failure that came after the user cancelled', async () => {
    mocks.materializeBase.mockImplementation(async () => {
      cancelOperation();
      throw new Error('aborted');
    });
    openers().openDialog('compress');
    await settled();
    expect(notice()).toBeNull();
    expect(dialogsStore.get().dialogSpec).toBeNull();
  });

  it('leaves the gate to the run that took it over', async () => {
    const frozen = deferred<Uint8Array>();
    mocks.materializeBase.mockReturnValue(frozen.promise);
    openers().openDialog('compress');
    const other = new AbortController();
    coreStore.set({ operation: other });
    frozen.resolve(bytes);
    await vi.waitFor(() => expect(dialogsStore.get().dialogSpec).not.toBeNull());
    expect(coreStore.get().operation).toBe(other);
    expect(busy()).toBe(true);
  });
});

describe('the shortcut list', () => {
  it('puts an armed tool away and remembers the control that had the focus', () => {
    coreStore.set({ canvasTool: 'measure' });
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    openers().showShortcuts();
    expect(coreStore.get().canvasTool).toBe('select');
    expect(dialogsStore.get()).toMatchObject({ shortcutsOpen: true, shortcutsTrigger: opener });
  });

  it('remembers no opener when nothing but <body> had the focus', () => {
    openers().showShortcuts();
    expect(dialogsStore.get()).toMatchObject({ shortcutsOpen: true, shortcutsTrigger: null });
  });

  it('remembers no opener when the focused thing is not an HTML element', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(svg);
    openers().showShortcuts();
    expect(dialogsStore.get().shortcutsTrigger).toBeNull();
  });

  describe('closing', () => {
    beforeEach(() => {
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      });
    });

    it('closes and gives the focus back to the control that opened it', () => {
      const opener = document.createElement('button');
      document.body.append(opener);
      shortcutsOpened(opener);
      openers().closeShortcuts();
      expect(dialogsStore.get().shortcutsOpen).toBe(false);
      expect(document.activeElement).toBe(opener);
    });

    it('falls back to the menu bar when the opener is gone', () => {
      const gone = document.createElement('input');
      shortcutsOpened(gone);
      document.body.innerHTML =
        '<div role="menubar"><button role="menuitem">File</button></div><main><button>Main</button></main>';
      openers().closeShortcuts();
      expect(document.activeElement?.textContent).toBe('File');
    });

    it('falls back to the first control of the main area without a menu bar or an opener', () => {
      shortcutsOpened(null);
      document.body.innerHTML = '<main><button>Main</button></main>';
      openers().closeShortcuts();
      expect(document.activeElement?.textContent).toBe('Main');
    });

    it('drops the focus nowhere when there is nothing to take it', () => {
      shortcutsOpened(null);
      expect(() => openers().closeShortcuts()).not.toThrow();
      expect(document.activeElement).toBe(document.body);
    });
  });
});

describe('dialogResult', () => {
  const result = (over: Record<string, unknown> = {}): OpRunResult =>
    ({
      files: [{ name: 'out.pdf', bytes: new Uint8Array([7, 8]), mime: 'application/pdf' }],
      report: { engine: 'mupdf', steps: ['compress'], pageCount: 2 },
      ...over,
    }) as never;

  function openFrozen(dialog: OperationDialogSpec = spec()) {
    operationDialogOpened(
      { tabId: tab.id, workingId: tab.working.id, name: tab.name, pageCount: 4, bytes },
      dialog,
    );
  }

  it('does nothing when no dialog is open', async () => {
    await runs().dialogResult(result());
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(busy()).toBe(false);
  });

  it('does nothing when only half a dialog is open', async () => {
    dialogsStore.set({ dialogSpec: spec() });
    await runs().dialogResult(result());
    expect(busy()).toBe(false);
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
  });

  it.each([
    ['its tab is gone', () => session.closeTab(tab.id)],
    ['its engine handle is gone', () => dropHandle(tab.id)],
    ['an operation landed on its version', () => bump()],
    [
      'another tab is in front',
      () => session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([2]), sha256: 'b', pageCount: 1 }),
    ],
  ])('dismisses the dialog and writes nothing when %s', async (_name, change) => {
    openFrozen();
    change();
    await runs().dialogResult(result());
    expect(dialogsStore.get()).toMatchObject({ dialogSpec: null, dialogInput: null });
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(handleFor(tab.id)).not.toBe(produced);
    expect(busy()).toBe(false);
  });

  it('refuses while another operation holds the gate and keeps the dialog', async () => {
    openFrozen();
    setBusy(true);
    await runs().dialogResult(result());
    expect(notice()).toBe(t('op.busy'));
    clearNotice();
    coreStore.set({ operation: new AbortController() });
    setBusy(false);
    await runs().dialogResult(result());
    expect(notice()).toBe(t('op.busy'));
    expect(dialogsStore.get().dialogSpec).not.toBeNull();
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
  });

  it('writes a replace result onto the working document and closes the dialog', async () => {
    openFrozen();
    await runs().dialogResult(result());

    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      { store: session, t, tab, handle },
      new Uint8Array([7, 8]),
      2,
      { key: 'op.compress.title' },
      'mupdf',
      ['compress'],
      { signal: expect.any(AbortSignal) },
      undefined,
    );
    expect(handleFor(tab.id)).toBe(produced);
    expect(notice()).toBe('op.result.applied {"label":"op.compress.title"}');
    expect(dialogsStore.get().dialogSpec).toBeNull();
    expect(busy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('says what the dialog asked it to say when it is a replace result', async () => {
    openFrozen();
    await runs().dialogResult(result({ noticeKey: 'op.custom', noticeParams: { n: 2 } }));
    expect(notice()).toBe('op.custom {"n":2}');
  });

  it('says a custom notice with no parameters', async () => {
    openFrozen();
    await runs().dialogResult(result({ noticeKey: 'op.custom' }));
    expect(notice()).toBe('op.custom {}');
  });

  it('downloads a download result without touching the document', async () => {
    openFrozen(spec({ resultKind: 'download' }));
    const files = result().files;
    await runs().dialogResult(result());
    expect(mocks.downloadFiles).toHaveBeenCalledWith(files);
    expect(notice()).toBe('op.result.downloaded {"name":"out.pdf"}');
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(dialogsStore.get().dialogSpec).toBeNull();
    expect(busy()).toBe(false);
  });

  it('lets the result choose how it is delivered over the spec’s default', async () => {
    openFrozen(spec({ resultKind: 'replace' }));
    await runs().dialogResult(result({ deliver: 'download', noticeKey: 'op.saved', noticeParams: { n: 1 } }));
    expect(mocks.downloadFiles).toHaveBeenCalled();
    expect(notice()).toBe('op.saved {"n":1}');
  });

  it('says a custom notice with no parameters for a download result', async () => {
    openFrozen(spec({ resultKind: 'download' }));
    await runs().dialogResult(result({ noticeKey: 'op.saved' }));
    expect(notice()).toBe('op.saved {}');
  });

  it('names no file when a download has none', async () => {
    openFrozen(spec({ resultKind: 'download' }));
    await runs().dialogResult(result({ files: [] }));
    expect(notice()).toBe('op.result.downloaded {"name":""}');
  });

  it('does nothing and keeps the dialog when a non-download result has no file', async () => {
    openFrozen();
    await runs().dialogResult(result({ files: [] }));
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(dialogsStore.get().dialogSpec).not.toBeNull();
    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
  });

  it('opens a new-tab result beside the document, with the stored-copy warning', async () => {
    openFrozen(spec({ resultKind: 'new-tab' }));
    openProducedTab.mockResolvedValue('copy not stored');
    await runs().dialogResult(result());
    expect(openProducedTab).toHaveBeenCalledWith('out.pdf', new Uint8Array([7, 8]), expect.any(AbortSignal));
    expect(notice()).toBe('op.result.opened {"name":"out.pdf"} copy not stored');
    expect(dialogsStore.get().dialogSpec).toBeNull();
    expect(busy()).toBe(false);
  });

  it('says the dialog’s own sentence for a new-tab result', async () => {
    openFrozen(spec({ resultKind: 'new-tab' }));
    await runs().dialogResult(result({ noticeKey: 'op.split.done', noticeParams: { n: 3 } }));
    expect(notice()).toBe('op.split.done {"n":3}');
  });

  it('says a custom notice with no parameters for a new-tab result', async () => {
    openFrozen(spec({ resultKind: 'new-tab' }));
    await runs().dialogResult(result({ noticeKey: 'op.split.done' }));
    expect(notice()).toBe('op.split.done {}');
  });

  describe('the redaction dialog', () => {
    const redact = () => spec({ id: 'redact', titleKey: 'op.redact.title' });
    const marks = [{ page: 0 }, { page: 1 }] as never;
    const context = { redactions: marks } as never;

    it('applies with the pending marks cleared and records the words it removed', async () => {
      redactedWordsRead(tab.id, ['alpha']);
      mocks.redactionNeedles.mockResolvedValue(['alpha', 'beta']);
      openFrozen(redact());
      await runs({ dialogContext: context }).dialogResult(result());

      expect(mocks.applyProducedBytes.mock.calls[0]?.[7]).toEqual({
        annotations: [],
        measures: [],
        redactions: [],
      });
      expect(mocks.redactionNeedles).toHaveBeenCalledWith(bytes, marks, { signal: expect.any(AbortSignal) });
      await vi.waitFor(() => expect(erasedWordsOf(tab.id)).toEqual(['alpha', 'beta']));
      expect(notice()).toBe('op.result.applied {"label":"op.redact.title"}');
    });

    it('starts the tab’s word list when it had none', async () => {
      mocks.redactionNeedles.mockResolvedValue(['gamma']);
      openFrozen(redact());
      await runs({ dialogContext: context }).dialogResult(result());
      await vi.waitFor(() => expect(erasedWordsOf(tab.id)).toEqual(['gamma']));
    });

    it('records nothing when the marks removed no words', async () => {
      openFrozen(redact());
      await runs({ dialogContext: context }).dialogResult(result());
      await vi.waitFor(() => expect(mocks.redactionNeedles).toHaveBeenCalled());
      await Promise.resolve();
      expect(erasedWordsOf(tab.id)).toEqual([]);
    });

    it('reads no words from a dialog frozen with no marks', async () => {
      openFrozen(redact());
      await runs().dialogResult(result());
      expect(mocks.redactionNeedles).toHaveBeenCalledWith(bytes, [], { signal: expect.any(AbortSignal) });
    });

    it('still applies when the words cannot be read', async () => {
      mocks.redactionNeedles.mockRejectedValue(new Error('unreadable'));
      openFrozen(redact());
      await runs({ dialogContext: context }).dialogResult(result());
      await Promise.resolve();
      expect(handleFor(tab.id)).toBe(produced);
      expect(erasedWordsOf(tab.id)).toEqual([]);
      expect(notice()).toBe('op.result.applied {"label":"op.redact.title"}');
    });
  });

  it('says what failed, keeps the dialog and releases the gate', async () => {
    const error = new ToolError('selection-empty', { engine: 'model' });
    mocks.applyProducedBytes.mockRejectedValue(error);
    openFrozen();
    await runs().dialogResult(result());
    expect(notice()).toBe(failure(error));
    expect(dialogsStore.get().dialogSpec).not.toBeNull();
    expect(busy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('says an unexpected failure was internal', async () => {
    mocks.applyProducedBytes.mockRejectedValue(new Error('boom'));
    openFrozen();
    await runs().dialogResult(result());
    expect(notice()).toBe(failure(internal));
  });

  it('stays silent about a failure after the user cancelled', async () => {
    mocks.applyProducedBytes.mockImplementation(async () => {
      cancelOperation();
      throw new Error('aborted');
    });
    openFrozen();
    await runs().dialogResult(result());
    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
  });

  it('leaves the gate to the run that took it over', async () => {
    const other = new AbortController();
    mocks.applyProducedBytes.mockImplementation(async () => {
      coreStore.set({ operation: other });
      return produced;
    });
    openFrozen();
    await runs().dialogResult(result());
    expect(coreStore.get().operation).toBe(other);
    expect(busy()).toBe(true);
  });
});

describe('startResult', () => {
  const result = (over: Record<string, unknown> = {}): OpRunResult =>
    ({ files: [{ name: 'new.pdf', bytes: new Uint8Array([1]), mime: 'application/pdf' }], ...over }) as never;

  it('does nothing when no standalone operation is open', async () => {
    await runs().startResult(result());
    expect(mocks.downloadFiles).not.toHaveBeenCalled();
    expect(openProducedTab).not.toHaveBeenCalled();
  });

  it('downloads a download result and closes the modal', async () => {
    startDialogOpened(spec({ resultKind: 'download' }));
    const files = result().files;
    await runs().startResult(result());
    expect(mocks.downloadFiles).toHaveBeenCalledWith(files);
    expect(notice()).toBe('op.result.downloaded {"name":"new.pdf"}');
    expect(dialogsStore.get().startSpec).toBeNull();
  });

  it('lets the result choose to download over the spec’s default, naming no file when it has none', async () => {
    startDialogOpened(spec({ resultKind: 'new-tab' }));
    await runs().startResult(result({ deliver: 'download', files: [] }));
    expect(notice()).toBe('op.result.downloaded {"name":""}');
    expect(dialogsStore.get().startSpec).toBeNull();
  });

  it('keeps the modal when there is no file to open', async () => {
    startDialogOpened(spec({ resultKind: 'new-tab' }));
    await runs().startResult(result({ files: [] }));
    expect(openProducedTab).not.toHaveBeenCalled();
    expect(dialogsStore.get().startSpec).not.toBeNull();
    expect(busy()).toBe(false);
  });

  it('refuses while another operation holds the gate and keeps the modal', async () => {
    startDialogOpened(spec({ resultKind: 'new-tab' }));
    setBusy(true);
    await runs().startResult(result());
    expect(notice()).toBe(t('op.busy'));
    clearNotice();
    setBusy(false);
    coreStore.set({ operation: new AbortController() });
    await runs().startResult(result());
    expect(notice()).toBe(t('op.busy'));
    expect(openProducedTab).not.toHaveBeenCalled();
    expect(dialogsStore.get().startSpec).not.toBeNull();
  });

  it('opens the produced file as a new tab, closes the modal and passes on the warning', async () => {
    startDialogOpened(spec({ resultKind: 'new-tab' }));
    openProducedTab.mockResolvedValue('copy not stored');
    await runs().startResult(result());
    expect(openProducedTab).toHaveBeenCalledWith('new.pdf', new Uint8Array([1]), expect.any(AbortSignal));
    expect(dialogsStore.get().startSpec).toBeNull();
    expect(notice()).toBe('op.result.opened {"name":"new.pdf"} copy not stored');
    expect(busy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('says what failed and keeps the modal', async () => {
    startDialogOpened(spec({ resultKind: 'new-tab' }));
    openProducedTab.mockRejectedValue(new ToolError('selection-empty', { engine: 'model' }));
    await runs().startResult(result());
    expect(notice()).toContain('selection-empty');
    expect(dialogsStore.get().startSpec).not.toBeNull();
    expect(busy()).toBe(false);
  });

  it('stays silent about a failure after the user cancelled', async () => {
    startDialogOpened(spec({ resultKind: 'new-tab' }));
    openProducedTab.mockImplementation(async () => {
      cancelOperation();
      throw new Error('aborted');
    });
    await runs().startResult(result());
    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
  });

  it('leaves the gate to the run that took it over', async () => {
    startDialogOpened(spec({ resultKind: 'new-tab' }));
    const other = new AbortController();
    openProducedTab.mockImplementation(async () => {
      coreStore.set({ operation: other });
      return null;
    });
    await runs().startResult(result());
    expect(coreStore.get().operation).toBe(other);
    expect(busy()).toBe(true);
  });
});

describe('unlockActiveCopy', () => {
  const noPassword = new Map<string, string>();
  const locked = () => new Map([[tab.id, 'secret']]);
  const outcome = (notes: unknown[] = []) => ({
    bytes: new Uint8Array([5]),
    report: { notes },
  });

  beforeEach(() => {
    clearNotice();
    mocks.unlockDocument.mockResolvedValue(outcome());
  });

  it('does nothing without an active tab, without its password or while busy', async () => {
    await runs({ lockedTabs: noPassword }).unlockActiveCopy();
    setBusy(true);
    await runs({ lockedTabs: locked() }).unlockActiveCopy();
    setBusy(false);
    session.closeTab(tab.id);
    await runs({ lockedTabs: locked() }).unlockActiveCopy();
    expect(mocks.unlockDocument).not.toHaveBeenCalled();
    expect(openProducedTab).not.toHaveBeenCalled();
  });

  it('builds an unlocked copy in a new tab and says so', async () => {
    mocks.unlockDocument.mockImplementation(async (_bytes, _password, options) => {
      options.onProgress({ phase: 'pages', labelKey: 'op.step.pages', total: 2, done: 1 });
      expect(resultsStore.get().progress).toMatchObject({ done: 1 });
      expect(busy()).toBe(true);
      expect(operationRunning()).toBe(true);
      return outcome();
    });
    await runs({ lockedTabs: locked() }).unlockActiveCopy();

    expect(mocks.unlockDocument).toHaveBeenCalledWith(expect.any(Uint8Array), 'secret', {
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    });
    expect(openProducedTab).toHaveBeenCalledWith('a-security.unlock.suffix.pdf', new Uint8Array([5]));
    expect(notice()).toBe('locked.done');
    expect(resultsStore.get().progress).toBeNull();
    expect(busy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('adds what unlocking cost the file and the stored-copy warning', async () => {
    mocks.unlockDocument.mockResolvedValue(
      outcome([
        { kind: 'lost', key: 'note.signature', params: { n: 1 } },
        { kind: 'lost', key: 'note.other' },
        { kind: 'preserved', key: 'note.kept' },
      ]),
    );
    openProducedTab.mockResolvedValue('copy not stored');
    await runs({ lockedTabs: locked() }).unlockActiveCopy();
    expect(notice()).toBe('locked.done note.signature {"n":1} note.other {} copy not stored');
  });

  it('says what failed in the engine’s words', async () => {
    const error = new ToolError('selection-empty', { engine: 'model' });
    mocks.unlockDocument.mockRejectedValue(error);
    await runs({ lockedTabs: locked() }).unlockActiveCopy();
    expect(notice()).toBe(failure(error));
    expect(busy()).toBe(false);
    expect(resultsStore.get().progress).toBeNull();
  });

  it('says an unexpected failure was internal', async () => {
    mocks.unlockDocument.mockRejectedValue(new Error('boom'));
    await runs({ lockedTabs: locked() }).unlockActiveCopy();
    expect(notice()).toBe(failure(new ToolError('internal', { engine: 'mupdf' })));
  });

  it('leaves the gate registration to the run that took it over', async () => {
    const other = new AbortController();
    mocks.unlockDocument.mockImplementation(async () => {
      coreStore.set({ operation: other });
      return outcome();
    });
    await runs({ lockedTabs: locked() }).unlockActiveCopy();
    expect(coreStore.get().operation).toBe(other);
  });
});
