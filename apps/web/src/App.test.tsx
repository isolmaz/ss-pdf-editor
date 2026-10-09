// @vitest-environment happy-dom
/**
 * The composition root: the shell binds the stores, the session and the translator to the
 * layout and the handlers. The layout hosts, the dialogs and the open path are their own (and
 * tested there); here each host is a stand-in that exposes the props the shell wires, and what
 * is checked is what the user's gestures reach through the shell itself: a file dropped on the
 * window, and the select tool handing the pointer back from the engine's native editors.
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { SessionStore } from 'pdf-model';
import { createTranslator, type Translator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { coreStore, initialCoreState } from './features/core/core-store';
import { persistenceStore } from './features/persistence/persistence-store';
import { memoryStorage } from './features/persistence/vault.fixtures';
import { initialSaveState, saveStore, viewerChanged } from './features/save/save-store';
import type * as DocumentEffectsModule from './features/shell/use-document-effects';

type Props = Record<string, unknown>;
const seen = vi.hoisted(() => ({}) as Record<string, Props>);
const open = vi.hoisted(() => ({
  openFile: vi.fn(),
  openProducedTab: vi.fn(),
  openFromSurface: vi.fn(),
  openFilesFromSurface: vi.fn(),
  openViaPicker: vi.fn(),
  selectRecent: vi.fn(),
}));

/** The props the named stand-in last rendered with. */
function propsOf(name: string): Props {
  const props = seen[name];
  if (props === undefined) throw new Error(`the ${name} stand-in did not render`);
  return props;
}

vi.mock('./components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('./features/shell/ShellHeader', () => ({
  ShellHeader: (props: Props) => {
    seen.header = props;
    return null;
  },
}));
vi.mock('./features/shell/ToolStripHost', () => ({ ToolStripHost: () => null }));
vi.mock('./features/shell/ShellBody', () => ({
  ShellBody: (props: Props) => {
    seen.body = props;
    return null;
  },
}));
vi.mock('./features/shell/ShellStatusBar', () => ({ ShellStatusBar: () => null }));
vi.mock('./features/shell/ShellOverlays', () => ({
  PaletteHost: () => null,
  SettingsHost: () => null,
}));
vi.mock('./features/shell/use-document-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof DocumentEffectsModule>()),
  DocumentEffects: () => null,
}));
vi.mock('./features/open/OpenSurfaces', () => ({
  OpenFileInput: () => null,
  PasswordPromptHost: () => null,
}));
vi.mock('./features/open/use-open-actions', () => ({ useOpenActions: () => open }));
vi.mock('./features/dialogs/DialogSurfaces', () => ({ ShortcutsDialogHost: () => null }));
vi.mock('./features/export/ExportSurfaces', () => ({
  ContextMenuHost: () => null,
  ExportDialogHost: () => null,
}));
vi.mock('./features/facts/SignatureWarningPrompt', () => ({ SignatureWarningPrompt: () => null }));
vi.mock('./features/forms/FormsSurface', () => ({ XfaFormDialogHost: () => null }));
vi.mock('./features/save/SaveSurfaces', () => ({ CloseDocumentHost: () => null }));
vi.mock('./features/stamps/StampSurface', () => ({
  ImagePickerInput: () => null,
  SignatureDialogHost: () => null,
}));
// Startup recovery reads the origin's vault and the recent-file stores: not what is under test.
vi.mock('./features/persistence/use-draft-recovery', () => ({ useDraftRecovery: () => undefined }));

/** What a dropped file handle is, as far as the shell can tell: the global the shell tests it against. */
class FakeFileHandle {}

let store: SessionStore;

/** The window-sized root the shell renders: the element a drop lands on. */
function shellRoot(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('the shell rendered no root element');
  return root;
}

/** A viewer that holds no native editor entries, and counts the times it was asked. */
function idleViewer() {
  const captureAnnotationEntries = vi.fn(() => []);
  return {
    api: { document: null, captureAnnotationEntries } as unknown as ViewerApi,
    captureAnnotationEntries,
  };
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  persistenceStore.set({ draftStorage: memoryStorage() });
  for (const mock of Object.values(open)) mock.mockReset();
  for (const name of Object.keys(seen)) delete seen[name];
  store = new SessionStore();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the shell', () => {
  it('hands the layout the session and a translator in the interface language, with no dialog frozen', () => {
    render(<App store={store} />);

    const body = propsOf('body');
    expect(body.session).toBe(store);
    expect(body.dialogContext).toBeNull();
    expect((body.t as Translator)('op.close')).toBe(createTranslator('en')('op.close'));
    expect(propsOf('header').session).toBe(store);
  });
});

describe('a drop on the window', () => {
  it('is refused to the browser and opens the dropped files with the handles Chromium gave', async () => {
    vi.stubGlobal('FileSystemFileHandle', FakeFileHandle);
    const { container } = render(<App store={store} />);
    const root = shellRoot(container);
    const granted = new FakeFileHandle();
    const first = new File(['1'], 'first.pdf');
    const second = new File(['2'], 'second.pdf');
    const third = new File(['3'], 'third.pdf');

    expect(fireEvent.dragOver(root)).toBe(false);
    const accepted = fireEvent.drop(root, {
      dataTransfer: {
        files: [first, second, third],
        items: [
          { kind: 'file', getAsFileSystemHandle: () => Promise.resolve(granted) },
          // A handle the browser refuses to hand over leaves that file openable, just not savable in place.
          { kind: 'file', getAsFileSystemHandle: () => Promise.reject(new Error('denied')) },
          // A browser without `getAsFileSystemHandle` (Firefox, Safari) gives none at all.
          { kind: 'file' },
          { kind: 'string' },
        ],
      },
    });

    expect(accepted).toBe(false);
    await waitFor(() => expect(open.openFilesFromSurface).toHaveBeenCalledTimes(1));
    expect(open.openFilesFromSurface).toHaveBeenCalledWith([first, second, third], [granted, null, null]);
  });

  it('opens the files with no handles at all where the browser has no file-system handle type', async () => {
    const { container } = render(<App store={store} />);
    const file = new File(['1'], 'only.pdf');

    fireEvent.drop(shellRoot(container), {
      dataTransfer: {
        files: [file],
        items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve({}) }],
      },
    });

    await waitFor(() => expect(open.openFilesFromSurface).toHaveBeenCalledTimes(1));
    expect(open.openFilesFromSurface).toHaveBeenCalledWith([file], [null]);
  });
});

describe('the native annotation editors of the engine', () => {
  it('are settled on mount while the select tool holds the pointer', () => {
    const viewer = idleViewer();
    viewerChanged(viewer.api);

    render(<App store={store} />);

    expect(viewer.captureAnnotationEntries).toHaveBeenCalled();
  });

  it('are left alone while another tool holds the pointer', () => {
    const viewer = idleViewer();
    viewerChanged(viewer.api);
    coreStore.set({ canvasTool: 'stamp' });

    render(<App store={store} />);

    expect(viewer.captureAnnotationEntries).not.toHaveBeenCalled();
  });
});
