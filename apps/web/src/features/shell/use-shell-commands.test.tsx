// @vitest-environment happy-dom
/** The command list and the home screen's way of running one. */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { Component, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle } from '../core/handles';
import { factsRead, factsStore } from '../facts/facts-store';
import { formInventoryRead, formsStore, initialFormsState } from '../forms/forms-store';
import { initialMeasureState, measureStore } from '../measure/measure-store';
import { hideStartScreen, initialOpenState, openStore } from '../open/open-store';
import { readingStore } from '../reading/reading-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { initialSelectionState, selectionStore } from '../selection/selection-store';
import type { ShellActions } from './shell-actions';
import { initialShellState, shellStore } from './shell-store';
import { toggleFullscreen, useShellCommands } from './use-shell-commands';

const ui = vi.hoisted(() => ({ theme: 'light', setTheme: vi.fn() }));
vi.mock('pdf-ui/ui', async (original) => ({
  ...(await original<typeof import('pdf-ui/ui')>()),
  useTheme: () => ({ theme: ui.theme, setTheme: ui.setTheme }),
}));

const t = createTranslator('en');
const handle = { id: 'h' } as unknown as PdfDocumentHandle;
let session: SessionStore;
let actions: Record<string, ReturnType<typeof vi.fn>>;
let viewer: {
  document: PdfDocumentHandle;
  setZoom: ReturnType<typeof vi.fn>;
  setSpreadMode: ReturnType<typeof vi.fn>;
};

function openReadyTab() {
  const tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 4 });
  adoptHandle(tab.id, handle);
  hideStartScreen();
  factsRead({
    tabId: tab.id,
    version: tab.working.id,
    fonts: [],
    attachments: [],
    signatures: [],
    security: { encrypted: false, permissions: [] },
  });
  formInventoryRead({ tabId: tab.id, version: tab.working.id, fields: [] } as never);
  viewerChanged(viewer as unknown as ViewerApi);
  return tab;
}

class Boundary extends Component<{ children: ReactNode }> {
  override componentDidCatch(error: Error) {
    process.stdout.write(`BOUNDARY ${error.stack?.slice(0, 900)}\n`);
  }
  static getDerivedStateFromError() {
    return {};
  }
  override render() {
    return this.props.children;
  }
}

function mount() {
  return renderHook(
    () => useShellCommands(session, 'desktop', { ...(actions as unknown as ShellActions), t }),
    { wrapper: Boundary },
  );
}

function run(result: { current: ReturnType<typeof useShellCommands> }, id: string) {
  const command = result.current.commands.find((item) => item.id === id);
  if (command === undefined) throw new Error(`no command ${id}`);
  act(() => command.run());
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  shellStore.set(initialShellState());
  openStore.set(initialOpenState());
  formsStore.set(initialFormsState());
  factsStore.set({ facts: null, failure: null });
  measureStore.set(initialMeasureState());
  selectionStore.set(initialSelectionState());
  readingStore.set({
    reading: false,
    snapshotOpen: false,
    magnifierOn: false,
    lensZoom: 4,
    documentLanguage: null,
  });
  session = new SessionStore();
  viewer = { document: handle, setZoom: vi.fn(), setSpreadMode: vi.fn() };
  actions = Object.fromEntries(
    [
      'openViaPicker',
      'saveActive',
      'exportActive',
      'closeTab',
      'openDialog',
      'showShortcuts',
      'runPageAction',
      'stepHistoryNow',
      'openPrint',
      'openSnapshotMenu',
      'openXfaForm',
      'startFormDetect',
      'openSignature',
      'pickImage',
      'deleteMarkSelection',
      'selectAllMarks',
      'toggleSensitiveSession',
      'opfsSave',
      'purgeActiveDocument',
      'sweepVault',
      'checkOffline',
      'prepareOfflinePackages',
      'changeMode',
    ].map((name) => [name, vi.fn(async () => undefined)]),
  );
});

describe('useShellCommands', () => {
  it('closes the active tab and renames it', () => {
    const tab = openReadyTab();
    const { result } = mount();
    run(result, 'file.close');
    expect(actions.closeTab).toHaveBeenCalledWith(tab.id);
    run(result, 'edit.rename');
    expect(shellStore.get().renamingId).toBe(tab.id);
  });

  it('closes and renames nothing with no document open', () => {
    const { result } = mount();
    run(result, 'file.close');
    run(result, 'edit.rename');
    expect(actions.closeTab).not.toHaveBeenCalled();
    expect(shellStore.get().renamingId).toBeNull();
  });

  it('changes the viewer from the zoom it reports', () => {
    openReadyTab();
    saveStore.set({ zoom: 1 });
    const { result } = mount();
    run(result, 'view.zoom-in');
    run(result, 'view.zoom-out');
    run(result, 'view.zoom-reset');
    run(result, 'view.fit-width');
    run(result, 'view.single');
    run(result, 'view.book');
    expect(viewer.setZoom.mock.calls).toEqual([[1.25], [0.75], [1], ['page-width']]);
    expect(viewer.setSpreadMode.mock.calls).toEqual([['single'], ['book']]);
  });

  it('opens the panels, docks and dialogs of the shell itself', () => {
    openReadyTab();
    const { result } = mount();
    run(result, 'settings.open');
    expect(shellStore.get().settingsOpen).toBe(true);
    run(result, 'help.palette');
    expect(shellStore.get().paletteOpen).toBe(true);
    run(result, 'tools.compare');
    expect(coreStore.get().rightTab).toBe('compare');
    run(result, 'tools.redaction-audit');
    expect(coreStore.get().rightTab).toBe('redaction-audit');
    run(result, 'view.layers');
    expect(coreStore.get().leftTab).toBe('layers');
    const left = coreStore.get().leftDock;
    run(result, 'view.left-dock');
    expect(coreStore.get().leftDock).toBe(!left);
    run(result, 'view.right-dock');
    run(result, 'view.reading');
    expect(readingStore.get().reading).toBe(true);
    run(result, 'view.magnifier');
    expect(readingStore.get().magnifierOn).toBe(true);
  });

  it('arms tools, selects pages and sets the theme', () => {
    openReadyTab();
    const { result } = mount();
    run(result, 'tools.ink');
    expect(coreStore.get().canvasTool).toBe('ink');
    run(result, 'tools.measure-area');
    expect(measureStore.get().subMode).toBe('area');
    run(result, 'edit.select-all-pages');
    expect(openStore.get().selectedPages).toEqual([0, 1, 2, 3]);
    run(result, 'edit.clear-selection');
    expect(openStore.get().selectedPages).toEqual([]);
    run(result, 'settings.theme.dark');
    expect(ui.setTheme).toHaveBeenCalledWith('dark');
  });

  it('leaves the simple mode from the palette hint', () => {
    const { result } = mount();
    expect(result.current.commands.length).toBeGreaterThan(0);
    run(result, 'settings.theme.light');
    expect(ui.setTheme).toHaveBeenCalledWith('light');
  });

  it('enters and leaves fullscreen', async () => {
    const request = vi.fn(async () => undefined);
    const exit = vi.fn(async () => undefined);
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: request,
    });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    await toggleFullscreen();
    expect(request).toHaveBeenCalled();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.body });
    await toggleFullscreen();
    expect(exit).toHaveBeenCalled();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  });

  it('runs the fullscreen command', () => {
    const request = vi.fn(async () => undefined);
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: request,
    });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    const { result } = mount();
    run(result, 'view.fullscreen');
    expect(request).toHaveBeenCalled();
  });

  it('runs the home screen tool at once when it needs no document', () => {
    const { result } = mount();
    act(() => result.current.runHomeCommand('file.batch'));
    expect(openStore.get().pendingHomeCommand).toBeNull();
  });

  it('asks for a file first and waits for its tab when the tool needs a document', () => {
    const { result } = mount();
    act(() => result.current.runHomeCommand('tools.properties'));
    expect(openStore.get().pendingHomeCommand).toBe('tools.properties');
    expect(actions.openViaPicker).toHaveBeenCalled();
  });

  it('runs the tool on the open document and leaves the start screen', () => {
    openReadyTab();
    openStore.set({ showHomeScreen: true });
    const { result } = mount();
    act(() => result.current.runHomeCommand('tools.properties'));
    expect(openStore.get().showHomeScreen).toBe(false);
    expect(actions.openDialog).toHaveBeenCalledWith('properties');
  });

  it('leaves a disabled tool and the start screen alone when the document is open', () => {
    openReadyTab();
    openStore.set({ showHomeScreen: true });
    const { result } = mount();
    // The tab was not opened from a file handle, so "Save" is disabled.
    expect(result.current.commands.find((item) => item.id === 'file.save')?.disabled).toBe(true);
    act(() => result.current.runHomeCommand('file.save'));
    expect(actions.saveActive).not.toHaveBeenCalled();
    expect(openStore.get().showHomeScreen).toBe(true);
    expect(openStore.get().pendingHomeCommand).toBeNull();
    expect(actions.openViaPicker).not.toHaveBeenCalled();
  });

  it('ignores an unknown tool', () => {
    const { result } = mount();
    act(() => result.current.runHomeCommand('no.such.command'));
    expect(actions.openViaPicker).not.toHaveBeenCalled();
  });

  it('runs a waiting tool once its document is shown and no operation holds it', () => {
    const { result } = mount();
    act(() => result.current.runHomeCommand('tools.properties'));
    expect(actions.openDialog).not.toHaveBeenCalled();
    act(() => coreStore.set({ busy: true }));
    act(() => {
      openReadyTab();
    });
    expect(actions.openDialog).not.toHaveBeenCalled();
    act(() => coreStore.set({ busy: false }));
    expect(actions.openDialog).toHaveBeenCalledWith('properties');
    expect(openStore.get().pendingHomeCommand).toBeNull();
  });

  it('drops a waiting tool that has no such command', () => {
    const { result } = mount();
    act(() => openStore.set({ pendingHomeCommand: 'no.such.command' }));
    act(() => {
      openReadyTab();
    });
    expect(result.current.commands.length).toBeGreaterThan(0);
    expect(openStore.get().pendingHomeCommand).toBeNull();
  });

  it('routes each command to the feature handler it names', () => {
    openReadyTab();
    const { result } = mount();
    const routes: readonly [string, string][] = [
      ['file.open', 'openViaPicker'],
      ['file.save', 'saveActive'],
      ['file.export', 'exportActive'],
      ['file.print', 'openPrint'],
      ['edit.delete-mark', 'deleteMarkSelection'],
      ['edit.select-all-marks', 'selectAllMarks'],
      ['view.snapshot', 'openSnapshotMenu'],
      ['tools.signature-simple', 'openSignature'],
      ['tools.image-add', 'pickImage'],
      ['tools.form-detect', 'startFormDetect'],
      ['tools.xfa-fill', 'openXfaForm'],
      ['help.shortcuts', 'showShortcuts'],
      ['settings.sensitive-session', 'toggleSensitiveSession'],
      ['settings.opfs-save', 'opfsSave'],
      ['settings.purge-document', 'purgeActiveDocument'],
      ['settings.sweep-vault', 'sweepVault'],
      ['help.offline', 'checkOffline'],
      ['help.prepare-offline', 'prepareOfflinePackages'],
    ];
    for (const [id, handler] of routes) {
      actions[handler]?.mockClear();
      run(result, id);
      expect(actions[handler], id).toHaveBeenCalled();
    }
    run(result, 'edit.undo');
    run(result, 'edit.redo');
    expect(actions.stepHistoryNow?.mock.calls).toEqual([['undo'], ['redo']]);
    run(result, 'page.rotate-left');
    expect(actions.runPageAction).toHaveBeenCalled();
    run(result, 'page.extract');
    expect(actions.openDialog).toHaveBeenCalledWith('extract-pages');
  });
});
