// @vitest-environment happy-dom
/**
 * The header row is the home header while no editor is shown, and the editor's header (title,
 * tabs, menus, save controls) otherwise; what the user does there reaches the session, the
 * stores and the shell's actions as the exact calls the shell wires. The two headers' internals
 * are their own (and tested there); here they are stand-ins that expose the props the shell wires.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { coreStore, initialCoreState, setBusy } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { exportStore, initialExportState } from '../export/export-store';
import { factsRead, factsStore } from '../facts/facts-store';
import { formInventoryRead, formsStore, initialFormsState } from '../forms/forms-store';
import { hideStartScreen, initialOpenState, openStore, showStartScreen } from '../open/open-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { type EditorSurfaces, editorStore, initialEditorState } from './editor-store';
import { ShellHeader, type ShellHeaderProps } from './ShellHeader';
import { initialShellState, renameTab, shellStore } from './shell-store';

type Props = Record<string, unknown>;
const captured = vi.hoisted(() => ({}) as Record<string, Props>);

/** The props the named stand-in last rendered with. */
function seen(name: string): Props {
  const props = captured[name];
  if (props === undefined) throw new Error(`the ${name} stand-in did not render`);
  return props;
}

vi.mock('pdf-ui/ui', async (original) => {
  const { createElement } = await import('react');
  return {
    ...(await original<typeof import('pdf-ui/ui')>()),
    MenuBar: (props: { commands: readonly Command[] }) =>
      createElement('nav', {
        'aria-label': 'menu bar',
        'data-commands': props.commands.map((command) => command.id).join(','),
      }),
  };
});
vi.mock('../open/OpenSurfaces', async (original) => {
  const { createElement } = await import('react');
  return {
    ...(await original<typeof import('../open/OpenSurfaces')>()),
    HomeHeader: (props: Props) => {
      captured.home = props;
      return createElement(
        'header',
        {
          'aria-label': 'home header',
          'data-title': String(props.title),
          'data-document': String(props.activeDocumentName),
        },
        createElement('button', { type: 'button', onClick: props.onSettings as () => void }, 'home settings'),
        createElement('button', { type: 'button', onClick: props.onPalette as () => void }, 'home palette'),
        createElement('button', { type: 'button', onClick: props.onOpen as () => void }, 'home open'),
      );
    },
  };
});
vi.mock('../../components/ModernEditorHeader', async () => {
  const { createElement } = await import('react');
  const button = (label: string, onClick: () => void) =>
    createElement('button', { type: 'button', key: label, onClick }, label);
  return {
    ModernEditorHeader: (props: Props) => {
      captured.editor = props;
      const tabs = props.tabs as readonly { id: string; name: string; dirty: boolean }[];
      return createElement(
        'header',
        {
          'aria-label': 'editor header',
          'data-doc': String(props.docName),
          'data-renaming': String(props.renaming),
          'data-dirty': String(props.isDirty),
          'data-can-edit': String(props.canEdit),
          'data-can-save': String(props.canSave),
          'data-save-mode': String(props.saveMode),
          'data-can-export': String(props.canExport),
          'data-active-tab': String(props.activeTabId),
          'data-tabs': tabs.map((tab) => `${tab.id}:${tab.name}:${tab.dirty}`).join('|'),
        },
        button('convert', props.onConvert as () => void),
        button('sign', props.onSign as () => void),
        button('home', props.onHome as () => void),
        button('open', props.onOpen as () => void),
        button('save', props.onSave as () => void),
        button('export', props.onExport as () => void),
        button('export options', props.onExportOptions as () => void),
        button('search', props.onSearch as () => void),
        button('palette', props.onPalette as () => void),
        button('settings', props.onSettings as () => void),
        button('cancel rename', props.onRenameCancel as () => void),
        props.menu as never,
      );
    },
  };
});

const t = createTranslator('en');
const handle = { id: 'handle' } as unknown as PdfDocumentHandle;
let session: SessionStore;
let tabIds: string[];
let actions: {
  openViaPicker: Mock;
  saveActive: Mock;
  exportActive: Mock;
  closeTab: Mock;
  openDialog: Mock;
};

const COMMANDS: readonly Command[] = [
  { id: 'file.save', labelKey: 'shell.menu.file', group: 'file', run: vi.fn() },
  { id: 'tools.something-advanced', labelKey: 'shell.menu.tools', group: 'tools', run: vi.fn() },
] as never;

function renderHeader() {
  return render(
    <ShellHeader
      session={session}
      tier="desktop"
      t={t}
      commands={COMMANDS}
      actions={actions as unknown as ShellHeaderProps['actions']}
    />,
  );
}

function openTab(name = 'a.pdf', fileHandle?: unknown) {
  const tab = session.openDocument({
    name,
    bytes: new Uint8Array([1]),
    sha256: name,
    pageCount: 2,
    ...(fileHandle === undefined ? {} : { handle: fileHandle as never }),
  });
  tabIds.push(tab.id);
  adoptHandle(tab.id, handle);
  hideStartScreen();
  return tab;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  coreStore.set({ mode: 'advanced' });
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  formsStore.set(initialFormsState());
  factsStore.set({ facts: null, failure: null });
  exportStore.set(initialExportState());
  shellStore.set(initialShellState());
  // The header only checks that the editor chunk has arrived; none of its surfaces render here.
  editorStore.set({ surfaces: {} as EditorSurfaces, loading: null });
  session = new SessionStore();
  tabIds = [];
  actions = {
    openViaPicker: vi.fn(async () => undefined),
    saveActive: vi.fn(async () => undefined),
    exportActive: vi.fn(async () => undefined),
    closeTab: vi.fn(),
    openDialog: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const id of tabIds) dropHandle(id);
});

describe('ShellHeader on the home screen', () => {
  it('shows the home header with no document, naming none', () => {
    renderHeader();
    const header = screen.getByLabelText('home header');
    expect(header.dataset.title).toBe('SsPdfEditor');
    expect(header.dataset.document).toBe('null');
    expect(screen.queryByLabelText('editor header')).toBeNull();
  });

  it('shows the home header over an open document when the start screen is asked for, naming it', () => {
    openTab('open.pdf');
    renderHeader();
    expect(screen.getByLabelText('editor header')).toBeTruthy();
    act(() => showStartScreen());
    expect(screen.getByLabelText('home header').dataset.document).toBe('open.pdf');
    expect(screen.queryByLabelText('editor header')).toBeNull();
  });

  it('keeps the home header over an open document until the editor chunk has arrived', () => {
    editorStore.set(initialEditorState());
    openTab('open.pdf');
    renderHeader();
    expect(screen.getByLabelText('home header').dataset.document).toBe('open.pdf');
    expect(screen.queryByLabelText('editor header')).toBeNull();
    act(() => editorStore.set({ surfaces: {} as EditorSurfaces }));
    expect(screen.getByLabelText('editor header')).toBeTruthy();
    expect(screen.queryByLabelText('home header')).toBeNull();
  });

  it('opens the settings, the palette and the file picker', async () => {
    renderHeader();
    await userEvent.click(screen.getByRole('button', { name: 'home settings' }));
    expect(shellStore.get().settingsOpen).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'home palette' }));
    expect(shellStore.get().paletteOpen).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'home open' }));
    expect(actions.openViaPicker).toHaveBeenCalledTimes(1);
  });
});

describe('ShellHeader editor state', () => {
  it('shows the document, its dirty state and its tabs', () => {
    const tab = openTab('a.pdf');
    renderHeader();
    const header = screen.getByLabelText('editor header');
    expect(header.dataset.doc).toBe('a.pdf');
    expect(header.dataset.dirty).toBe('false');
    expect(header.dataset.activeTab).toBe(tab.id);
    expect(header.dataset.tabs).toBe(`${tab.id}:a.pdf:false`);
    act(() => session.setDirty(tab.id, true));
    expect(screen.getByLabelText('editor header').dataset.dirty).toBe('true');
    expect(screen.getByLabelText('editor header').dataset.tabs).toBe(`${tab.id}:a.pdf:true`);
  });

  it('allows editing once the viewer shows the document and no operation runs', () => {
    openTab();
    renderHeader();
    expect(screen.getByLabelText('editor header').dataset.canEdit).toBe('false');
    act(() => viewerChanged({ document: handle } as unknown as ViewerApi));
    expect(screen.getByLabelText('editor header').dataset.canEdit).toBe('true');
    act(() => setBusy(true));
    expect(screen.getByLabelText('editor header').dataset.canEdit).toBe('false');
  });

  it('offers Save and Export only once the facts and the form inventory are read', () => {
    const tab = openTab();
    renderHeader();
    expect(screen.getByLabelText('editor header').dataset.canSave).toBe('false');
    expect(screen.getByLabelText('editor header').dataset.canExport).toBe('false');
    act(() => {
      factsRead({
        tabId: tab.id,
        version: tab.working.id,
        fonts: [],
        attachments: [],
        signatures: [],
        security: { encrypted: false, permissions: [] },
      });
      formInventoryRead({ tabId: tab.id, version: tab.working.id, fields: [] } as never);
    });
    expect(screen.getByLabelText('editor header').dataset.canSave).toBe('true');
    expect(screen.getByLabelText('editor header').dataset.canExport).toBe('true');
  });

  it('saves over the file the tab came from when it has a file handle', () => {
    openTab('a.pdf', { name: 'a.pdf' });
    renderHeader();
    expect(screen.getByLabelText('editor header').dataset.saveMode).toBe('save');
  });

  it('asks where to save when the browser can and the tab has no file handle', () => {
    vi.stubGlobal('showSaveFilePicker', vi.fn());
    openTab();
    renderHeader();
    expect(screen.getByLabelText('editor header').dataset.saveMode).toBe('saveAs');
  });

  it('offers no Save where the browser cannot write files and the tab has no file handle', () => {
    openTab();
    renderHeader();
    expect(screen.getByLabelText('editor header').dataset.saveMode).toBe('none');
  });

  it('puts every command in the menu in the advanced mode and the simple set in the simple mode', () => {
    openTab();
    renderHeader();
    expect(screen.getByLabelText('menu bar').dataset.commands).toBe('file.save,tools.something-advanced');
    act(() => coreStore.set({ mode: 'simple' }));
    expect(screen.getByLabelText('menu bar').dataset.commands).toBe('file.save');
  });
});

describe('ShellHeader editor actions', () => {
  it('routes the buttons to the stores and the shell actions', async () => {
    openTab();
    renderHeader();
    await userEvent.click(screen.getByRole('button', { name: 'convert' }));
    expect(exportStore.get().exportOpen).toBe(true);
    exportStore.set(initialExportState());
    await userEvent.click(screen.getByRole('button', { name: 'export options' }));
    expect(exportStore.get().exportOpen).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'sign' }));
    expect(actions.openDialog).toHaveBeenCalledWith('sign');
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(actions.openViaPicker).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(actions.saveActive).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'export' }));
    expect(actions.exportActive).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'palette' }));
    expect(shellStore.get().paletteOpen).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'settings' }));
    expect(shellStore.get().settingsOpen).toBe(true);
    expect(seen('editor').onCloseTab).toBe(actions.closeTab);
  });

  it('goes back to the start screen', async () => {
    openTab();
    renderHeader();
    await userEvent.click(screen.getByRole('button', { name: 'home' }));
    expect(openStore.get().showHomeScreen).toBe(true);
    expect(screen.getByLabelText('home header')).toBeTruthy();
  });

  it('opens the find bar of the viewer, and does nothing without a viewer', async () => {
    openTab();
    renderHeader();
    await userEvent.click(screen.getByRole('button', { name: 'search' }));
    const openFind = vi.fn();
    act(() => viewerChanged({ document: handle, openFind } as unknown as ViewerApi));
    await userEvent.click(screen.getByRole('button', { name: 'search' }));
    expect(openFind).toHaveBeenCalledTimes(1);
  });
});

describe('ShellHeader renaming', () => {
  it('shows the name field for the tab being renamed and cancels without renaming', async () => {
    const tab = openTab();
    renderHeader();
    expect(screen.getByLabelText('editor header').dataset.renaming).toBe('false');
    act(() => renameTab(tab.id));
    expect(screen.getByLabelText('editor header').dataset.renaming).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'cancel rename' }));
    expect(shellStore.get().renamingId).toBeNull();
    expect(session.active?.name).toBe('a.pdf');
  });

  it('renames the tab to the trimmed name and says so', () => {
    const tab = openTab();
    renameTab(tab.id);
    renderHeader();
    act(() => (seen('editor').onRename as (name: string) => void)('  b.pdf '));
    expect(shellStore.get().renamingId).toBeNull();
    expect(session.active?.name).toBe('b.pdf');
    expect(coreStore.get().notice).toBe(t('shell.rename.done', { name: 'b.pdf' }));
  });

  it('keeps the name and stays silent for an empty name or the same name', () => {
    const tab = openTab();
    renameTab(tab.id);
    renderHeader();
    act(() => (seen('editor').onRename as (name: string) => void)('   '));
    expect(session.active?.name).toBe('a.pdf');
    expect(shellStore.get().renamingId).toBeNull();
    act(() => (seen('editor').onRename as (name: string) => void)('a.pdf '));
    expect(session.active?.name).toBe('a.pdf');
    expect(coreStore.get().notice).toBeNull();
  });
});

describe('ShellHeader tab switching', () => {
  it('activates the picked tab, clears the page selection and stops the operation of the tab it leaves', () => {
    const first = openTab('a.pdf');
    const second = openTab('b.pdf');
    act(() => session.setActive(first.id));
    openStore.set({ selectedPages: [0, 1] });
    const controller = new AbortController();
    coreStore.set({ operation: controller });
    renderHeader();
    act(() => (seen('editor').onSelectTab as (id: string) => void)(second.id));
    expect(controller.signal.aborted).toBe(true);
    expect(session.active?.id).toBe(second.id);
    expect(openStore.get().selectedPages).toEqual([]);
  });

  it('keeps the running operation when the picked tab is the active one', () => {
    const first = openTab('a.pdf');
    openStore.set({ selectedPages: [0] });
    const controller = new AbortController();
    coreStore.set({ operation: controller });
    renderHeader();
    act(() => (seen('editor').onSelectTab as (id: string) => void)(first.id));
    expect(controller.signal.aborted).toBe(false);
    expect(session.active?.id).toBe(first.id);
    expect(openStore.get().selectedPages).toEqual([]);
  });
});
