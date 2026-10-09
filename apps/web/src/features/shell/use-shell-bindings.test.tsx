// @vitest-environment happy-dom
/** The keyboard layer's actions: each reads the viewer, zoom, page and session when the key is pressed. */

import { renderHook } from '@testing-library/react';
import { SessionStore } from 'pdf-model';
import type { ViewerApi } from 'pdf-ui/viewer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellShortcuts } from '../../useShortcuts';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import { exportStore, initialExportState } from '../export/export-store';
import { readingStore } from '../reading/reading-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import type { ShellActions } from './shell-actions';
import { initialShellState, shellStore } from './shell-store';
import { useShellBindings } from './use-shell-bindings';

const captured = vi.hoisted(() => ({ shortcuts: null as unknown as ShellShortcuts }));
vi.mock('../../useShortcuts', () => ({
  useShellShortcuts: (shortcuts: ShellShortcuts) => {
    captured.shortcuts = shortcuts;
  },
}));

let session: SessionStore;
let actions: Record<string, ReturnType<typeof vi.fn>>;
let editing: boolean;
let viewer: { setZoom: ReturnType<typeof vi.fn>; goToPage: ReturnType<typeof vi.fn> };

function mount() {
  renderHook(() =>
    useShellBindings({ session, actions: actions as unknown as ShellActions, canEdit: () => editing }),
  );
  return captured.shortcuts;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  shellStore.set(initialShellState());
  exportStore.set(initialExportState());
  session = new SessionStore();
  editing = true;
  viewer = { setZoom: vi.fn(), goToPage: vi.fn() };
  actions = {
    openViaPicker: vi.fn(async () => undefined),
    saveActive: vi.fn(async () => true),
    deleteMarkSelection: vi.fn(() => true),
    openPrint: vi.fn(),
    stepHistoryNow: vi.fn(() => true),
    openDialog: vi.fn(),
    selectAllMarks: vi.fn(() => true),
  };
});

describe('shell bindings', () => {
  it('hands the file, history and mark actions to the matching key', () => {
    const shortcuts = mount();
    shortcuts.open();
    shortcuts.save();
    shortcuts.print();
    shortcuts.undo();
    shortcuts.redo();
    shortcuts.documentProperties();
    expect(actions.openViaPicker).toHaveBeenCalledTimes(1);
    expect(actions.saveActive).toHaveBeenCalledTimes(1);
    expect(actions.openPrint).toHaveBeenCalledTimes(1);
    expect(actions.stepHistoryNow).toHaveBeenNthCalledWith(1, 'undo');
    expect(actions.stepHistoryNow).toHaveBeenNthCalledWith(2, 'redo');
    expect(actions.openDialog).toHaveBeenCalledWith('properties');
    expect(shortcuts.deleteSelection?.()).toBe(true);
    expect(shortcuts.selectAllMarks?.()).toBe(true);
  });

  it('opens the export dialog without asking the save path', () => {
    mount().exportDocument();
    expect(exportStore.get().exportOpen).toBe(true);
  });

  it('zooms from the zoom the viewer reports now, within the allowed range', () => {
    viewerChanged(viewer as unknown as ViewerApi);
    const shortcuts = mount();
    saveStore.set({ zoom: 1 });
    shortcuts.zoomIn();
    saveStore.set({ zoom: 4 });
    shortcuts.zoomIn();
    saveStore.set({ zoom: 1 });
    shortcuts.zoomOut();
    saveStore.set({ zoom: 0.25 });
    shortcuts.zoomOut();
    shortcuts.zoomReset();
    shortcuts.fitWidth();
    expect(viewer.setZoom.mock.calls).toEqual([[1.25], [4], [0.75], [0.25], [1], ['page-width']]);
  });

  it('walks pages from the page the viewer reports now', () => {
    viewerChanged(viewer as unknown as ViewerApi);
    const shortcuts = mount();
    saveStore.set({ currentPage: 3 });
    shortcuts.nextPage();
    shortcuts.previousPage();
    shortcuts.firstPage();
    expect(viewer.goToPage.mock.calls).toEqual([[4], [2], [0]]);
  });

  it('goes to the last page of the active document, or the first with none', () => {
    viewerChanged(viewer as unknown as ViewerApi);
    const shortcuts = mount();
    shortcuts.lastPage();
    session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 5 });
    shortcuts.lastPage();
    expect(viewer.goToPage.mock.calls).toEqual([[0], [4]]);
  });

  it('does nothing to the viewer when no document is shown', () => {
    const shortcuts = mount();
    shortcuts.zoomIn();
    shortcuts.zoomOut();
    shortcuts.zoomReset();
    shortcuts.fitWidth();
    shortcuts.nextPage();
    shortcuts.previousPage();
    shortcuts.firstPage();
    shortcuts.lastPage();
    expect(viewer.setZoom).not.toHaveBeenCalled();
    expect(viewer.goToPage).not.toHaveBeenCalled();
  });

  it('summons the palette with no tool armed under it, and toggles the docks and reading mode', () => {
    selectTool('measure');
    const shortcuts = mount();
    shortcuts.palette();
    expect(shellStore.get().paletteOpen).toBe(true);
    expect(coreStore.get().canvasTool).toBe('select');
    const left = coreStore.get().leftDock;
    const right = coreStore.get().rightDock;
    shortcuts.toggleLeftDock();
    shortcuts.toggleRightDock();
    expect(coreStore.get().leftDock).toBe(!left);
    expect(coreStore.get().rightDock).toBe(!right);
    const reading = readingStore.get().reading;
    shortcuts.reading();
    expect(readingStore.get().reading).toBe(!reading);
  });

  it('declines find and replace unless editing is allowed when the key is pressed', () => {
    const shortcuts = mount();
    editing = false;
    expect(shortcuts.findReplace?.()).toBe(false);
    expect(actions.openDialog).not.toHaveBeenCalled();
    editing = true;
    expect(shortcuts.findReplace?.()).toBe(true);
    expect(actions.openDialog).toHaveBeenCalledWith('find-replace');
  });
});
