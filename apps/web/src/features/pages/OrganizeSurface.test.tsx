// @vitest-environment happy-dom
/**
 * The organize grid as the shell hosts it: on screen exactly while the core store asks for it and
 * a document with an engine handle is open; given the page on screen, the selection, the marks and
 * the version; its actions reach the viewer, the stores and the shell's page actions as the exact
 * calls the shell wires; and it goes away with the document, with the tab and when a form opens
 * in the dock it covers. The grid's internals are pdf-ui's own (and tested there); here it is a
 * stand-in that exposes the props the shell wires.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  bumpHandleVersion,
  closeOrganize,
  coreStore,
  initialCoreState,
  openOrganize,
} from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { dialogsStore, initialDialogsState, operationDialogOpened } from '../dialogs/dialogs-store';
import { formsStore, initialFormsState } from '../forms/forms-store';
import { annotationMark, writeMarks } from '../marks/marks-fixtures';
import { initialOpenState, openStore } from '../open/open-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { OrganizeSurface, type OrganizeSurfaceProps } from './OrganizeSurface';

type ViewProps = {
  document: unknown;
  currentPage: number;
  selectedPages: readonly number[];
  editing: boolean;
  version: string;
  marks: readonly unknown[];
  onSelectionChange: (pages: readonly number[]) => void;
  onGoToPage: (page: number) => void;
  onPageAction: (action: string) => void;
  onClose: () => void;
  onExtract: () => void;
  onInsert: () => void;
};

const view = vi.hoisted(() => ({ latest: null as unknown }));
vi.mock('pdf-ui/organize', async (original) => {
  const { createElement } = await import('react');
  const button = (label: string, onClick: () => void) =>
    createElement('button', { type: 'button', key: label, onClick }, label);
  return {
    ...(await original<typeof import('pdf-ui/organize')>()),
    OrganizeView: (props: ViewProps) => {
      view.latest = props;
      return createElement(
        'section',
        {
          'aria-label': 'organize grid',
          'data-editing': String(props.editing),
          'data-page': String(props.currentPage),
          'data-selected': props.selectedPages.join(','),
          'data-version': props.version,
          'data-marks': String(props.marks.length),
        },
        button('select pages', () => props.onSelectionChange([1, 2])),
        button('go to page', () => props.onGoToPage(3)),
        button('page action', () => props.onPageAction('rotate')),
        button('close', props.onClose),
        button('extract', props.onExtract),
        button('insert', props.onInsert),
      );
    },
  };
});

const t = createTranslator('en');
const handle = { id: 'handle' } as unknown as PdfDocumentHandle;
let session: SessionStore;
let tabIds: string[] = [];
let actions: { runPageAction: Mock; openDialog: Mock };

function viewerStub() {
  return { document: handle, goToPage: vi.fn() };
}

function renderSurface() {
  return render(
    <OrganizeSurface
      session={session}
      tier="desktop"
      t={t}
      actions={actions as unknown as OrganizeSurfaceProps['actions']}
    />,
  );
}

function openTab(name = 'a.pdf') {
  const tab = session.openDocument({ name, bytes: new Uint8Array([1]), sha256: name, pageCount: 3 });
  tabIds.push(tab.id);
  adoptHandle(tab.id, handle);
  return tab;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  formsStore.set(initialFormsState());
  dialogsStore.set(initialDialogsState());
  session = new SessionStore();
  actions = { runPageAction: vi.fn(), openDialog: vi.fn() };
});
afterEach(() => {
  cleanup();
  for (const id of tabIds) dropHandle(id);
  tabIds = [];
});

describe('OrganizeSurface visibility', () => {
  it('shows nothing until the grid is asked for', () => {
    openTab();
    renderSurface();
    expect(screen.queryByLabelText('organize grid')).toBeNull();
  });

  it('shows the grid when the core store asks for it, and takes it away when it is closed', async () => {
    openTab();
    renderSurface();
    act(() => openOrganize());
    expect(await screen.findByLabelText('organize grid')).toBeTruthy();
    act(() => closeOrganize());
    expect(screen.queryByLabelText('organize grid')).toBeNull();
  });

  it('shows nothing with no document open', () => {
    openOrganize();
    renderSurface();
    expect(screen.queryByLabelText('organize grid')).toBeNull();
  });

  it('shows nothing until the open document has an engine handle', async () => {
    const tab = session.openDocument({
      name: 'a.pdf',
      bytes: new Uint8Array([1]),
      sha256: 'a',
      pageCount: 1,
    });
    tabIds.push(tab.id);
    act(() => openOrganize());
    renderSurface();
    expect(screen.queryByLabelText('organize grid')).toBeNull();
    adoptHandle(tab.id, handle);
    act(() => bumpHandleVersion());
    expect(await screen.findByLabelText('organize grid')).toBeTruthy();
  });

  it('is taken away when another tab comes to the front, and with the surface itself', async () => {
    openTab('a.pdf');
    renderSurface();
    act(() => openOrganize());
    await screen.findByLabelText('organize grid');
    act(() => {
      openTab('b.pdf');
    });
    expect(coreStore.get().organize).toBe(false);
    act(() => openOrganize());
    cleanup();
    expect(coreStore.get().organize).toBe(false);
  });

  it('is taken away when a form opens in the dock it covers', async () => {
    const tab = openTab();
    renderSurface();
    act(() => openOrganize());
    await screen.findByLabelText('organize grid');
    act(() =>
      operationDialogOpened(
        {
          tabId: tab.id,
          workingId: tab.working.id,
          name: 'a.pdf',
          pageCount: 3,
          bytes: new Uint8Array([1]),
        },
        { id: 'extract-pages' } as never,
      ),
    );
    expect(coreStore.get().organize).toBe(false);
  });
});

describe('OrganizeSurface inputs', () => {
  it('hands the grid the document, the page on screen, the selection, the version and the visible marks', async () => {
    const tab = openTab();
    writeMarks(session, tab.id, { annotations: [annotationMark('a1')], measures: [], redactions: [] });
    saveStore.set({ currentPage: 2 });
    openStore.set({ selectedPages: [0, 2] });
    openOrganize();
    renderSurface();
    const grid = await screen.findByLabelText('organize grid');
    expect(view.latest).toMatchObject({ document: handle });
    expect(grid.dataset.page).toBe('2');
    expect(grid.dataset.selected).toBe('0,2');
    expect(grid.dataset.marks).toBe('1');
    expect(grid.dataset.version).toBe(session.active?.working.stateId);
  });

  it('lets the grid edit only once the viewer shows this document', async () => {
    openTab();
    openOrganize();
    renderSurface();
    const grid = await screen.findByLabelText('organize grid');
    expect(grid.dataset.editing).toBe('false');
    act(() => viewerChanged(viewerStub() as unknown as ViewerApi));
    expect(grid.dataset.editing).toBe('true');
  });
});

describe('OrganizeSurface actions', () => {
  it('writes the selection to the open store the page panel shares', async () => {
    openTab();
    openOrganize();
    renderSurface();
    await userEvent.click(await screen.findByRole('button', { name: 'select pages' }));
    expect(openStore.get().selectedPages).toEqual([1, 2]);
  });

  it('sends the viewer to the page the grid opens', async () => {
    openTab();
    const viewer = viewerStub();
    act(() => viewerChanged(viewer as unknown as ViewerApi));
    openOrganize();
    renderSurface();
    await userEvent.click(await screen.findByRole('button', { name: 'go to page' }));
    expect(viewer.goToPage).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('does not fail when no viewer is mounted yet', async () => {
    openTab();
    openOrganize();
    renderSurface();
    await userEvent.click(await screen.findByRole('button', { name: 'go to page' }));
    expect(screen.getByLabelText('organize grid')).toBeTruthy();
  });

  it('runs the shell’s page action, closes on request and opens the extract and insert forms', async () => {
    openTab();
    openOrganize();
    renderSurface();
    await userEvent.click(await screen.findByRole('button', { name: 'page action' }));
    expect(actions.runPageAction).toHaveBeenCalledExactlyOnceWith('rotate');
    await userEvent.click(screen.getByRole('button', { name: 'extract' }));
    expect(actions.openDialog).toHaveBeenLastCalledWith('extract-pages');
    await userEvent.click(screen.getByRole('button', { name: 'insert' }));
    expect(actions.openDialog).toHaveBeenLastCalledWith('insert-pages');
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(coreStore.get().organize).toBe(false);
    expect(screen.queryByLabelText('organize grid')).toBeNull();
  });
});
