// @vitest-environment happy-dom
/**
 * The body is the home screen while no editor is shown, and the editor's docks, rail and canvas
 * otherwise, with the dialogs and the status overlay beside either. What the user does on the
 * home screen and the status overlay reaches the stores and the shell's actions as the exact
 * calls the shell wires. The panels, the canvas and the dialogs are their own (and tested
 * there); here each is a stand-in that exposes the props the shell wires.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { STANDALONE_COMMAND_IDS } from '../../commands';
import { coreStore, initialCoreState, setBusy } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { dialogsStore, initialDialogsState } from '../dialogs/dialogs-store';
import { exportStore, initialExportState } from '../export/export-store';
import { hideStartScreen, initialOpenState, openStore, showStartScreen } from '../open/open-store';
import { initialResultsState, resultsStore, setProgress } from '../results/results-store';
import { initialSaveState, saveStore, viewerChanged, viewerRef } from '../save/save-store';
import { ShellBody, type ShellBodyProps } from './ShellBody';
import { initialShellState, shellStore } from './shell-store';

type Props = Record<string, unknown>;
const captured = vi.hoisted(() => ({}) as Record<string, Props>);

/** The props the named stand-in last rendered with. */
function seen(name: string): Props {
  const props = captured[name];
  if (props === undefined) throw new Error(`the ${name} stand-in did not render`);
  return props;
}

vi.mock('../../components/HomeScreen', async () => {
  const { createElement } = await import('react');
  const button = (label: string, onClick: () => void) =>
    createElement('button', { type: 'button', key: label, onClick }, label);
  return {
    HomeScreen: (props: Props) => {
      captured.homeScreen = props;
      const onStart = props.onStart as (action: string) => void;
      return createElement(
        'section',
        {
          'aria-label': 'home screen',
          'data-document': String(props.activeDocumentName),
          'data-busy': String(props.busy),
          'data-open-ids': [...(props.openIds as ReadonlySet<string>)].join(','),
          'data-commands': String((props.commands as unknown[]).length),
        },
        button('open files', () =>
          (props.onOpenFiles as (files: File[]) => void)([new File(['x'], 'x.pdf')]),
        ),
        button('open picker', props.onOpenPicker as () => void),
        button('start blank', () => onStart('blank')),
        button('start images', () => onStart('images')),
        button('start convert', () => onStart('convert')),
        button('start merge', () => onStart('merge')),
        button('start batch', () => onStart('batch')),
        button('start scan', () => onStart('scan')),
        button('run command', () => (props.onRunCommand as (id: string) => void)('file.new')),
        button('select recent', () => (props.onSelectRecent as (item: unknown) => void)({ id: 'recent-1' })),
        button('open palette', props.onOpenPalette as () => void),
      );
    },
  };
});
vi.mock('../../components/ToolRail', async () => {
  const { createElement } = await import('react');
  return {
    ToolRail: (props: Props) =>
      createElement('nav', { 'aria-label': 'tool rail', 'data-can-edit': String(props.canEdit) }),
  };
});
vi.mock('../../components/ActivityOverlay', async () => {
  const { createElement } = await import('react');
  return {
    ActivityOverlay: (props: Props) => {
      captured.overlay = props;
      return createElement(
        'section',
        {
          'aria-label': 'activity overlay',
          'data-notice': String(props.notice),
          'data-progress': JSON.stringify(props.progress),
          'data-activity': String(props.activity),
        },
        createElement('button', { type: 'button', onClick: props.onDismiss as () => void }, 'dismiss'),
        createElement('button', { type: 'button', onClick: props.onCancel as () => void }, 'cancel'),
      );
    },
  };
});
vi.mock('../dialogs/DialogSurfaces', async () => {
  const { createElement } = await import('react');
  return {
    StartDialogHost: (props: Props) => {
      captured.startHost = props;
      return createElement(
        'button',
        { type: 'button', onClick: () => void (props.onResult as (r: unknown) => void)({ kind: 'started' }) },
        'start result',
      );
    },
    BatchDialogHost: () => createElement('div', { 'aria-label': 'batch host' }),
  };
});
vi.mock('../results/ResultsSurfaces', async () => {
  const { createElement } = await import('react');
  return {
    PrintDialogHost: (props: Props) => {
      captured.printHost = props;
      return createElement(
        'button',
        {
          type: 'button',
          onClick: () => void (props.onProduced as (file: unknown) => void)({ name: 'p.pdf' }),
        },
        'print produced',
      );
    },
    ScanDialogHost: (props: Props) => {
      captured.scanHost = props;
      return createElement(
        'button',
        {
          type: 'button',
          onClick: () => void (props.onDocument as (doc: unknown) => void)({ name: 's.pdf' }),
        },
        'scan produced',
      );
    },
  };
});
vi.mock('../reading/ReadingLayers', async () => {
  const { createElement } = await import('react');
  return {
    ReadingLayers: (props: Props) => {
      captured.reading = props;
      return createElement('div', {
        'aria-label': 'reading layers',
        'data-page': String(props.pageNumber),
        'data-locale': String(props.locale),
      });
    },
  };
});
vi.mock('./DocumentDock', async () => {
  const { createElement } = await import('react');
  return {
    DocumentDock: (props: Props) => {
      captured.documentDock = props;
      return createElement('aside', { 'aria-label': 'document dock' });
    },
  };
});
vi.mock('./RightDock', async () => {
  const { createElement } = await import('react');
  return {
    RightDock: (props: Props) => {
      captured.rightDock = props;
      return createElement('aside', { 'aria-label': 'right dock' });
    },
  };
});
vi.mock('./ViewerArea', async () => {
  const { createElement } = await import('react');
  return {
    ViewerArea: (props: Props) => {
      captured.viewerArea = props;
      return createElement('div', { 'aria-label': 'viewer area' });
    },
  };
});

const t = createTranslator('en');
const handle = { id: 'handle' } as unknown as PdfDocumentHandle;
const COMMANDS = [{ id: 'file.new' }, { id: 'file.open' }] as unknown as readonly Command[];
let session: SessionStore;
let tabIds: string[];
let props: {
  runHomeCommand: Mock;
  dialogContext: ShellBodyProps['dialogContext'];
  home: { openFilesFromSurface: Mock; openViaPicker: Mock; openStart: Mock; selectRecent: Mock };
  dock: Record<string, unknown>;
  viewer: Record<string, unknown>;
  right: Record<string, unknown>;
  results: { printProduced: Mock; scanDocument: Mock };
  startResult: Mock;
  cancelOperation: Mock;
};

function renderBody() {
  return render(
    <ShellBody
      session={session}
      tier="desktop"
      t={t}
      commands={COMMANDS}
      runHomeCommand={props.runHomeCommand}
      dialogContext={props.dialogContext}
      home={props.home as unknown as ShellBodyProps['home']}
      dock={props.dock as unknown as ShellBodyProps['dock']}
      viewer={props.viewer as unknown as ShellBodyProps['viewer']}
      right={props.right as unknown as ShellBodyProps['right']}
      results={props.results as unknown as ShellBodyProps['results']}
      startResult={props.startResult}
      cancelOperation={props.cancelOperation}
    />,
  );
}

function openTab(name = 'a.pdf') {
  const tab = session.openDocument({ name, bytes: new Uint8Array([1]), sha256: name, pageCount: 2 });
  tabIds.push(tab.id);
  adoptHandle(tab.id, handle);
  hideStartScreen();
  return tab;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  resultsStore.set(initialResultsState());
  dialogsStore.set(initialDialogsState());
  exportStore.set(initialExportState());
  shellStore.set(initialShellState());
  session = new SessionStore();
  tabIds = [];
  props = {
    runHomeCommand: vi.fn(),
    dialogContext: { name: 'ctx' } as never,
    home: {
      openFilesFromSurface: vi.fn(async () => undefined),
      openViaPicker: vi.fn(async () => undefined),
      openStart: vi.fn(),
      selectRecent: vi.fn(),
    },
    dock: { marker: 'dock' },
    viewer: { marker: 'viewer' },
    right: { marker: 'right' },
    results: { printProduced: vi.fn(async () => undefined), scanDocument: vi.fn(async () => undefined) },
    startResult: vi.fn(async () => undefined),
    cancelOperation: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  for (const id of tabIds) dropHandle(id);
});

describe('ShellBody home screen', () => {
  it('shows the home screen with no document, naming none, and no editor', () => {
    renderBody();
    const home = screen.getByLabelText('home screen');
    expect(home.dataset.document).toBe('null');
    expect(home.dataset.busy).toBe('false');
    expect(home.dataset.commands).toBe('2');
    expect(seen('homeScreen').standaloneCommands).toBe(STANDALONE_COMMAND_IDS);
    expect(screen.queryByLabelText('document dock')).toBeNull();
    expect(screen.queryByLabelText('right dock')).toBeNull();
    expect(screen.queryByLabelText('viewer area')).toBeNull();
  });

  it('names the open document and lists the open tabs when the start screen is asked for over it', () => {
    const first = openTab('a.pdf');
    const second = openTab('b.pdf');
    renderBody();
    expect(screen.queryByLabelText('home screen')).toBeNull();
    act(() => showStartScreen());
    const home = screen.getByLabelText('home screen');
    expect(home.dataset.document).toBe('b.pdf');
    expect(home.dataset.openIds).toBe(`${first.id},${second.id}`);
    expect(screen.queryByLabelText('viewer area')).toBeNull();
  });

  it('tells the home screen an operation is running', () => {
    renderBody();
    act(() => setBusy(true));
    expect(screen.getByLabelText('home screen').dataset.busy).toBe('true');
  });

  it('opens dropped files, the picker, a recent document and the palette through the shell', async () => {
    renderBody();
    await userEvent.click(screen.getByRole('button', { name: 'open files' }));
    expect(props.home.openFilesFromSurface).toHaveBeenCalledTimes(1);
    expect(props.home.openFilesFromSurface.mock.calls).toEqual([
      [[expect.objectContaining({ name: 'x.pdf' })]],
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'open picker' }));
    expect(props.home.openViaPicker).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'select recent' }));
    expect(props.home.selectRecent).toHaveBeenCalledWith({ id: 'recent-1' });
    await userEvent.click(screen.getByRole('button', { name: 'run command' }));
    expect(props.runHomeCommand).toHaveBeenCalledWith('file.new');
    await userEvent.click(screen.getByRole('button', { name: 'open palette' }));
    expect(shellStore.get().paletteOpen).toBe(true);
  });

  it('starts the batch dialog and the scanner from the start screen', async () => {
    renderBody();
    await userEvent.click(screen.getByRole('button', { name: 'start batch' }));
    expect(dialogsStore.get().batchOpen).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'start scan' }));
    expect(resultsStore.get().scanOpen).toBe(true);
    expect(props.home.openStart).not.toHaveBeenCalled();
  });

  it.each([
    ['start blank', 'new-document'],
    ['start images', 'images-to-pdf'],
    ['start convert', 'convert-to-pdf'],
    ['start merge', 'merge-files'],
  ])('%s starts the %s operation', async (label, operation) => {
    renderBody();
    await userEvent.click(screen.getByRole('button', { name: label }));
    expect(props.home.openStart).toHaveBeenCalledWith(operation);
    expect(dialogsStore.get().batchOpen).toBe(false);
    expect(resultsStore.get().scanOpen).toBe(false);
  });
});

describe('ShellBody editor', () => {
  it('shows the docks, the rail, the canvas and the reading layers for the open document', () => {
    openTab();
    renderBody();
    expect(screen.queryByLabelText('home screen')).toBeNull();
    expect(screen.getByLabelText('document dock')).toBeTruthy();
    expect(screen.getByLabelText('right dock')).toBeTruthy();
    expect(screen.getByLabelText('viewer area')).toBeTruthy();
    expect(seen('documentDock').actions).toBe(props.dock);
    expect(seen('viewerArea').actions).toBe(props.viewer);
    expect(seen('rightDock').actions).toBe(props.right);
    expect(seen('rightDock').dialogContext).toBe(props.dialogContext);
    expect(seen('documentDock').session).toBe(session);
  });

  it('lets the rail edit only once the viewer shows the document', () => {
    openTab();
    renderBody();
    expect(screen.getByLabelText('tool rail').dataset.canEdit).toBe('false');
    act(() => viewerChanged({ document: handle } as unknown as ViewerApi));
    expect(screen.getByLabelText('tool rail').dataset.canEdit).toBe('true');
  });

  it('gives the reading layers the viewer, its ref, the page and the interface language', () => {
    openTab();
    const viewer = { document: handle } as unknown as ViewerApi;
    act(() => viewerChanged(viewer));
    act(() => saveStore.set({ currentPage: 7 }));
    renderBody();
    expect(screen.getByLabelText('reading layers').dataset.page).toBe('7');
    expect(screen.getByLabelText('reading layers').dataset.locale).toBe('en');
    expect(seen('reading').viewer).toBe(viewer);
    expect(seen('reading').viewerRef).toBe(viewerRef);
    expect(seen('printHost').viewer).toBe(viewer);
  });

  it('hands the print and scan results to the shell', async () => {
    openTab();
    renderBody();
    await userEvent.click(screen.getByRole('button', { name: 'print produced' }));
    expect(props.results.printProduced).toHaveBeenCalledWith({ name: 'p.pdf' });
    await userEvent.click(screen.getByRole('button', { name: 'scan produced' }));
    expect(props.results.scanDocument).toHaveBeenCalledWith({ name: 's.pdf' });
  });

  it('opens the context menu where the user right-clicks the canvas', () => {
    openTab();
    renderBody();
    const canvas = screen.getByLabelText('viewer area').parentElement as HTMLElement;
    const allowed = fireEvent.contextMenu(canvas, { clientX: 12, clientY: 34 });
    expect(allowed).toBe(false);
    expect(exportStore.get().contextMenu).toMatchObject({ x: 12, y: 34, hasSelection: false });
  });
});

describe('ShellBody dialogs and status overlay', () => {
  it('mounts the standalone dialog hosts with and without a document', async () => {
    renderBody();
    expect(screen.getByLabelText('batch host')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'start result' }));
    expect(props.startResult).toHaveBeenCalledWith({ kind: 'started' });
    cleanup();
    openTab();
    renderBody();
    expect(screen.getByLabelText('batch host')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'start result' }));
    expect(props.startResult).toHaveBeenCalledTimes(2);
  });

  it('hands the scanned document to the shell from the home screen too', async () => {
    renderBody();
    await userEvent.click(screen.getByRole('button', { name: 'scan produced' }));
    expect(props.results.scanDocument).toHaveBeenCalledWith({ name: 's.pdf' });
  });

  it('shows the notice, and clears it when the user dismisses it', async () => {
    renderBody();
    expect(screen.getByLabelText('activity overlay').dataset.notice).toBe('null');
    act(() => coreStore.set({ notice: 'saved' }));
    expect(screen.getByLabelText('activity overlay').dataset.notice).toBe('saved');
    await userEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(coreStore.get().notice).toBeNull();
  });

  it('shows the running operation’s progress and cancels it through the shell', async () => {
    renderBody();
    act(() => setProgress({ step: 1, total: 3 } as never));
    expect(screen.getByLabelText('activity overlay').dataset.progress).toBe('{"step":1,"total":3}');
    await userEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(props.cancelOperation).toHaveBeenCalledTimes(1);
  });

  it('says a file is opening while it is being read', () => {
    renderBody();
    expect(screen.getByLabelText('activity overlay').dataset.activity).toBe('null');
    act(() => openStore.set({ opening: true }));
    expect(screen.getByLabelText('activity overlay').dataset.activity).toBe(t('open.progress'));
  });
});
