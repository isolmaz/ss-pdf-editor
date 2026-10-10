// @vitest-environment happy-dom
/**
 * The left dock is on screen exactly while the core store says so and a document with an engine
 * handle is open; what the user does in the panel reaches the viewer, the stores and the shell's
 * actions as the exact calls the shell wires. The panel's internals are pdf-ui's own (and tested
 * there); here it is a stand-in that exposes the props the shell wires.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { SIMPLE_MODE_DOCK_TABS } from '../../commands';
import { bumpHandleVersion, coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { formsStore, initialFormsState } from '../forms/forms-store';
import { annotationMark, writeMarks } from '../marks/marks-fixtures';
import { initialOpenState, openStore } from '../open/open-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { DocumentDock, type DocumentDockProps } from './DocumentDock';

type PanelProps = {
  document: unknown;
  currentPage: number;
  selectedPages: readonly number[];
  editing: boolean;
  version: string;
  marks: readonly unknown[];
  visibleTabs: readonly string[] | undefined;
  tab: string;
  onToggle: () => void;
  onSelectionChange: (pages: readonly number[]) => void;
  onPageAction: (action: string) => void;
  onGoToPage: (page: number) => void;
  onNotice: (message: string) => void;
  onHighlightQuery: (query: string) => void;
  onLayersChanged: () => void;
  onExtract: () => void;
  onEditOutline: () => void;
  onWriteLayers: (request: unknown) => void;
  onAddAttachments: (files: readonly File[]) => void;
  onRemoveAttachments: (names: readonly string[]) => void;
  onTabChange: (tab: string) => void;
};

const panel = vi.hoisted(() => ({ latest: null as unknown }));
vi.mock('pdf-ui/ui', async (original) => {
  const { createElement } = await import('react');
  const button = (label: string, onClick: () => void) =>
    createElement('button', { type: 'button', key: label, onClick }, label);
  return {
    ...(await original<typeof import('pdf-ui/ui')>()),
    DocumentPanel: (props: PanelProps) => {
      panel.latest = props;
      return createElement(
        'section',
        {
          'aria-label': 'document panel',
          'data-editing': String(props.editing),
          'data-page': String(props.currentPage),
          'data-selected': props.selectedPages.join(','),
          'data-version': props.version,
          'data-marks': String(props.marks.length),
          'data-visible-tabs': props.visibleTabs === undefined ? 'all' : props.visibleTabs.join(','),
          'data-tab': props.tab,
        },
        button('hide', props.onToggle),
        button('select pages', () => props.onSelectionChange([1, 2])),
        button('page action', () => props.onPageAction('rotate')),
        button('go to page', () => props.onGoToPage(3)),
        button('notice', () => props.onNotice('panel said')),
        button('highlight', () => props.onHighlightQuery('needle')),
        button('layers changed', props.onLayersChanged),
        button('extract', props.onExtract),
        button('edit outline', props.onEditOutline),
        button('write layers', () => props.onWriteLayers({ hidden: ['L1'] })),
        button('add attachments', () => props.onAddAttachments([new File(['x'], 'x.txt')])),
        button('remove attachments', () => props.onRemoveAttachments(['x.txt'])),
        button('change tab', () => props.onTabChange('outline')),
      );
    },
  };
});

const t = createTranslator('en');
const handle = { id: 'handle' } as unknown as PdfDocumentHandle;
let session: SessionStore;
let tabId: string;
let actions: {
  runPageAction: Mock;
  openDialog: Mock;
  writeLayers: Mock;
  attachments: { write: Mock };
};

function viewerStub() {
  return {
    document: handle,
    goToPage: vi.fn(),
    find: vi.fn(),
    refreshOptionalContent: vi.fn(async () => undefined),
  };
}

function renderDock() {
  return render(
    <DocumentDock
      session={session}
      tier="desktop"
      t={t}
      actions={actions as unknown as DocumentDockProps['actions']}
    />,
  );
}

function openTab() {
  const tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 3 });
  tabId = tab.id;
  adoptHandle(tab.id, handle);
  return tab;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  coreStore.set({ leftDock: true, compactViewport: false, mode: 'advanced', leftTab: 'pages' });
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  formsStore.set(initialFormsState());
  session = new SessionStore();
  actions = {
    runPageAction: vi.fn(),
    openDialog: vi.fn(),
    writeLayers: vi.fn(async () => undefined),
    attachments: { write: vi.fn(async () => undefined) },
  };
});
afterEach(() => {
  cleanup();
  if (tabId !== undefined) dropHandle(tabId);
});

describe('DocumentDock visibility', () => {
  it('shows nothing while the left dock is closed', () => {
    openTab();
    coreStore.set({ leftDock: false });
    renderDock();
    expect(screen.queryByLabelText('document panel')).toBeNull();
  });

  it('shows nothing with no document open', () => {
    renderDock();
    expect(screen.queryByLabelText('document panel')).toBeNull();
  });

  it('shows nothing until the open document has an engine handle', () => {
    const tab = session.openDocument({
      name: 'a.pdf',
      bytes: new Uint8Array([1]),
      sha256: 'a',
      pageCount: 1,
    });
    tabId = tab.id;
    renderDock();
    expect(screen.queryByLabelText('document panel')).toBeNull();
    adoptHandle(tab.id, handle);
    act(() => bumpHandleVersion());
    expect(screen.getByLabelText('document panel')).toBeTruthy();
  });

  it('hides when the panel asks to be toggled away', async () => {
    openTab();
    renderDock();
    await userEvent.click(screen.getByRole('button', { name: 'hide' }));
    expect(coreStore.get().leftDock).toBe(false);
    expect(screen.queryByLabelText('document panel')).toBeNull();
  });
});

describe('DocumentDock panel inputs', () => {
  it('hands the panel the document, the page, the selection, the version and the visible marks', () => {
    const tab = openTab();
    writeMarks(session, tab.id, { annotations: [annotationMark('a1')], measures: [], redactions: [] });
    saveStore.set({ currentPage: 4 });
    openStore.set({ selectedPages: [0, 2] });
    renderDock();
    const view = screen.getByLabelText('document panel');
    expect(panel.latest).toMatchObject({ document: handle });
    expect(view.dataset.page).toBe('4');
    expect(view.dataset.selected).toBe('0,2');
    expect(view.dataset.marks).toBe('1');
    expect(view.dataset.version).toBe(session.active?.working.stateId);
    expect(view.dataset.tab).toBe('pages');
  });

  it('lets the panel edit only once the viewer shows this document', () => {
    openTab();
    renderDock();
    expect(screen.getByLabelText('document panel').dataset.editing).toBe('false');
    act(() => viewerChanged(viewerStub() as unknown as ViewerApi));
    expect(screen.getByLabelText('document panel').dataset.editing).toBe('true');
  });

  it('keeps the dock in the flow on a wide screen and overlays it on a narrow one', () => {
    openTab();
    const { container } = renderDock();
    expect(container.firstElementChild?.className).toBe('contents');
    act(() => coreStore.set({ compactViewport: true }));
    expect(container.firstElementChild?.className).toBe('absolute inset-y-0 start-0 z-40 max-w-full');
  });

  it('offers every tab in the advanced mode and the simple set in the simple mode', () => {
    openTab();
    renderDock();
    expect(screen.getByLabelText('document panel').dataset.visibleTabs).toBe('all');
    act(() => coreStore.set({ mode: 'simple' }));
    expect(screen.getByLabelText('document panel').dataset.visibleTabs).toBe(SIMPLE_MODE_DOCK_TABS.join(','));
  });
});

describe('DocumentDock handlers', () => {
  it('writes the page selection, the tab and the notice the panel reports to the stores', async () => {
    openTab();
    renderDock();
    await userEvent.click(screen.getByRole('button', { name: 'select pages' }));
    expect(openStore.get().selectedPages).toEqual([1, 2]);
    await userEvent.click(screen.getByRole('button', { name: 'change tab' }));
    expect(coreStore.get().leftTab).toBe('outline');
    await userEvent.click(screen.getByRole('button', { name: 'notice' }));
    expect(coreStore.get().notice).toBe('panel said');
  });

  it('routes the panel requests to the shell actions', async () => {
    openTab();
    renderDock();
    await userEvent.click(screen.getByRole('button', { name: 'page action' }));
    expect(actions.runPageAction).toHaveBeenCalledWith('rotate');
    await userEvent.click(screen.getByRole('button', { name: 'extract' }));
    expect(actions.openDialog).toHaveBeenLastCalledWith('extract-pages');
    await userEvent.click(screen.getByRole('button', { name: 'edit outline' }));
    expect(actions.openDialog).toHaveBeenLastCalledWith('outline-edit');
    await userEvent.click(screen.getByRole('button', { name: 'write layers' }));
    expect(actions.writeLayers).toHaveBeenCalledWith({ hidden: ['L1'] });
    const file = new File(['x'], 'x.txt');
    act(() => (panel.latest as PanelProps).onAddAttachments([file]));
    expect(actions.attachments.write).toHaveBeenLastCalledWith({ add: [file] });
    await userEvent.click(screen.getByRole('button', { name: 'remove attachments' }));
    expect(actions.attachments.write).toHaveBeenLastCalledWith({ remove: ['x.txt'] });
  });

  it('drives the viewer for page jumps, searches and layer refreshes', async () => {
    openTab();
    const viewer = viewerStub();
    act(() => viewerChanged(viewer as unknown as ViewerApi));
    renderDock();
    await userEvent.click(screen.getByRole('button', { name: 'go to page' }));
    expect(viewer.goToPage).toHaveBeenCalledWith(3);
    await userEvent.click(screen.getByRole('button', { name: 'highlight' }));
    expect(viewer.find).toHaveBeenCalledWith('needle');
    await userEvent.click(screen.getByRole('button', { name: 'layers changed' }));
    expect(viewer.refreshOptionalContent).toHaveBeenCalledTimes(1);
  });

  it('does nothing for viewer requests while no viewer is mounted', async () => {
    openTab();
    renderDock();
    await userEvent.click(screen.getByRole('button', { name: 'go to page' }));
    await userEvent.click(screen.getByRole('button', { name: 'highlight' }));
    await userEvent.click(screen.getByRole('button', { name: 'layers changed' }));
    expect(screen.getByLabelText('document panel')).toBeTruthy();
    expect(coreStore.get().notice).toBeNull();
  });
});
