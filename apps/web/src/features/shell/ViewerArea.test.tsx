// @vitest-environment happy-dom
/**
 * The document canvas: the viewer, every mark layer drawn over its pages and the dock edge
 * handles. The viewer pane and each layer are pdf-ui's or their feature's own (and tested there);
 * here they are stand-ins that expose the props the shell wires, so each handler can be driven
 * and its call into the feature action or store asserted.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnnotationMark } from 'pdf-core';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { markTargetKey } from 'pdf-ui/tools';
import type { ViewerApi } from 'pdf-ui/viewer';
import { Profiler, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { pendingOverlays } from '../../operations';
import { annotationsStore, initialAnnotationsState } from '../annotations/annotations-store';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle } from '../core/handles';
import { writeOverlay } from '../core/overlays';
import { existingInventoryRead, formsStore, initialFormsState } from '../forms/forms-store';
import { initialMarksState, marksStore } from '../marks/marks-store';
import { hideStartScreen, initialOpenState, lockTab, openStore } from '../open/open-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { initialSelectionState, selectionStore } from '../selection/selection-store';
import { ViewerArea } from './ViewerArea';

vi.mock('pdf-ui/viewer', async () => {
  const { createElement } = await import('react');
  return {
    PdfViewerPane: (props: {
      document: { id: string };
      documentKey: string | undefined;
      handTool: boolean;
      onReady: (api: unknown) => void;
      onDocumentReleased: (handle: unknown) => void;
      onCurrentPageChange: (page: number) => void;
      onScaleChange: (scale: number) => void;
      onModifiedChange: () => void;
      onLayoutChange: () => void;
      onReplace: ((query: string) => void) | undefined;
      overlay: ReactNode;
    }) =>
      createElement(
        'main',
        {
          'aria-label': 'viewer pane',
          'data-document': props.document.id,
          'data-key': String(props.documentKey),
          'data-hand': String(props.handTool),
        },
        createElement('button', { type: 'button', onClick: () => props.onReady({ ready: true }) }, 'ready'),
        createElement('button', { type: 'button', onClick: () => props.onReady(null) }, 'unready'),
        createElement(
          'button',
          { type: 'button', onClick: () => props.onDocumentReleased(props.document) },
          'released',
        ),
        createElement('button', { type: 'button', onClick: () => props.onCurrentPageChange(3) }, 'page 3'),
        createElement('button', { type: 'button', onClick: () => props.onScaleChange(1.5) }, 'scale 1.5'),
        createElement('button', { type: 'button', onClick: props.onModifiedChange }, 'modified'),
        createElement('button', { type: 'button', onClick: props.onLayoutChange }, 'layout'),
        props.onReplace === undefined
          ? null
          : createElement(
              'button',
              { type: 'button', onClick: () => props.onReplace?.('needle') },
              'replace',
            ),
        props.overlay,
      ),
  };
});
vi.mock('pdf-ui/tools', async (original) => {
  const { createElement } = await import('react');
  return {
    ...(await original<typeof import('pdf-ui/tools')>()),
    MarkInteractionLayer: (props: {
      mode: string | null;
      targets: readonly unknown[];
      selectedKeys: readonly string[];
      disabled: boolean;
      resizeLabel: string;
      onSelectionChange: (keys: readonly string[]) => void;
      onMove: (keys: readonly string[], dx: number, dy: number) => void;
      onResize: (key: string, rect: readonly [number, number, number, number]) => void;
    }) =>
      createElement(
        'section',
        {
          'aria-label': 'mark interaction',
          'data-mode': String(props.mode),
          'data-targets': String(props.targets.length),
          'data-selected': props.selectedKeys.join(','),
          'data-disabled': String(props.disabled),
          'data-resize-label': props.resizeLabel,
        },
        createElement(
          'button',
          { type: 'button', onClick: () => props.onSelectionChange(['x', 'y']) },
          'select marks',
        ),
        createElement('button', { type: 'button', onClick: () => props.onMove(['x'], 3, 4) }, 'move marks'),
        createElement(
          'button',
          { type: 'button', onClick: () => props.onResize('k', [1, 2, 3, 4]) },
          'resize mark',
        ),
      ),
  };
});
vi.mock('pdf-ui/ui', async (original) => {
  const { createElement } = await import('react');
  return {
    ...(await original<typeof import('pdf-ui/ui')>()),
    AnnotationLayer: (props: {
      tool: string | null;
      marks: readonly unknown[];
      color: string;
      opacity: number;
      thickness: number;
      author: string;
      shape: string;
      textColor: string;
      fontSize: number;
      onCreate: (mark: unknown) => void;
      onDone: () => void;
      onRegion: (region: unknown) => void;
    }) =>
      createElement(
        'section',
        {
          'aria-label': 'annotation layer',
          'data-tool': String(props.tool),
          'data-marks': String(props.marks.length),
          'data-color': props.color,
          'data-opacity': String(props.opacity),
          'data-thickness': String(props.thickness),
          'data-author': props.author,
          'data-shape': props.shape,
          'data-text-color': props.textColor,
          'data-font-size': String(props.fontSize),
        },
        createElement(
          'button',
          { type: 'button', onClick: () => props.onCreate(markOf('highlight', 'h1')) },
          'create highlight',
        ),
        createElement(
          'button',
          { type: 'button', onClick: () => props.onCreate(markOf('note', 'n1')) },
          'create note',
        ),
        createElement('button', { type: 'button', onClick: props.onDone }, 'done'),
        createElement('button', { type: 'button', onClick: () => props.onRegion(region) }, 'region'),
      ),
  };
});
vi.mock('pdf-ui/panels', async () => {
  const { createElement } = await import('react');
  return {
    ReadingOrderLayer: () => createElement('section', { 'aria-label': 'reading order' }),
  };
});
vi.mock('../marks/RedactionSurfaces', async () => {
  const { createElement } = await import('react');
  return {
    RedactionMarkLayer: (props: { enabled: boolean }) =>
      createElement('section', { 'aria-label': 'redaction layer', 'data-enabled': String(props.enabled) }),
  };
});
vi.mock('../measure/MeasureOverlay', async () => {
  const { createElement } = await import('react');
  return {
    MeasureOverlay: (props: {
      marks: readonly unknown[];
      canEdit: boolean;
      color: string;
      opacity: number;
      thickness: number;
      author: string;
    }) =>
      createElement('section', {
        'aria-label': 'measure overlay',
        'data-marks': String(props.marks.length),
        'data-can-edit': String(props.canEdit),
        'data-color': props.color,
        'data-opacity': String(props.opacity),
        'data-thickness': String(props.thickness),
        'data-author': props.author,
      }),
  };
});
vi.mock('../stamps/StampSurface', async () => {
  const { createElement } = await import('react');
  return {
    StampPlacementHost: (props: { canEdit: boolean; onPlace: (placement: unknown) => void }) =>
      createElement(
        'section',
        { 'aria-label': 'stamp placement', 'data-can-edit': String(props.canEdit) },
        createElement('button', { type: 'button', onClick: () => props.onPlace(placement) }, 'place stamp'),
      ),
  };
});
vi.mock('../forms/FormsSurface', async () => {
  const { createElement } = await import('react');
  return {
    FieldCandidateHost: (props: { tab: { id: string }; canEdit: boolean }) =>
      createElement('section', {
        'aria-label': 'field candidates',
        'data-tab': props.tab.id,
        'data-can-edit': String(props.canEdit),
      }),
  };
});
vi.mock('../selection/TextToolSurface', async () => {
  const { createElement } = await import('react');
  return {
    TextToolSurface: (props: { currentPage: number; onEdit: () => void }) =>
      createElement(
        'section',
        { 'aria-label': 'text tool', 'data-page': String(props.currentPage) },
        createElement('button', { type: 'button', onClick: props.onEdit }, 'edit text'),
      ),
  };
});

const region = { pageIndex: 2, rect: [1, 2, 3, 4] };
const placement = { pageIndex: 1, x: 10, y: 20 };

function markOf(kind: string, id: string): AnnotationMark {
  return {
    id,
    kind,
    pageIndex: 1,
    quads: [[0, 0, 1, 1]],
    color: '#ffd400',
    opacity: 0.4,
    contents: '',
    author: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as AnnotationMark;
}

// The right-dock reading-order layer is lazy: resolve the (mocked) panel module up front so the
// first open does not wait on a cold import. A static import would defeat the point.
beforeAll(async () => {
  await import('pdf-ui/panels');
}, 120_000);

const t = createTranslator('en');
const handle = { id: 'handle-1' } as unknown as PdfDocumentHandle;
const viewer = { document: handle } as unknown as ViewerApi;
let session: SessionStore;
let actions: {
  openDialog: Mock;
  transformTargets: Mock;
  onReady: Mock;
  onDocumentReleased: Mock;
  onModifiedChange: Mock;
  onPlaceStamp: Mock;
  onResizeStamp: Mock;
  onLinkRegion: Mock;
};

function openTab(pageCount = 2) {
  const tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount });
  adoptHandle(tab.id, handle);
  hideStartScreen();
  return tab;
}

function mount(tier: 'desktop' | 'mobile' = 'desktop') {
  return render(<ViewerArea session={session} tier={tier} t={t} actions={actions} />);
}

function attribute(label: string, name: string): string | null {
  return screen.getByLabelText(label).getAttribute(name);
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  formsStore.set(initialFormsState());
  annotationsStore.set(initialAnnotationsState());
  selectionStore.set(initialSelectionState());
  marksStore.set(initialMarksState());
  session = new SessionStore();
  actions = {
    openDialog: vi.fn(),
    transformTargets: vi.fn(async () => undefined),
    onReady: vi.fn(),
    onDocumentReleased: vi.fn(),
    onModifiedChange: vi.fn(),
    onPlaceStamp: vi.fn(),
    onResizeStamp: vi.fn(),
    onLinkRegion: vi.fn(),
  };
});

describe('ViewerArea', () => {
  it('shows nothing, not even the dock handles, until the engine has opened the document', () => {
    coreStore.set({ leftDock: false, rightDock: false });
    mount();
    expect(screen.queryByLabelText('viewer pane')).toBeNull();
    expect(screen.queryByRole('button', { name: t('nav.togglePages') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('tools.all') })).toBeNull();
  });

  it('feeds the viewer the document, and arms its hand tool with the hand tool', () => {
    const tab = openTab();
    coreStore.set({ canvasTool: 'hand' });
    mount();
    expect(attribute('viewer pane', 'data-document')).toBe('handle-1');
    expect(attribute('viewer pane', 'data-key')).toBe(tab.id);
    expect(attribute('viewer pane', 'data-hand')).toBe('true');
    act(() => coreStore.set({ canvasTool: 'select' }));
    expect(attribute('viewer pane', 'data-hand')).toBe('false');
  });

  it('reopens each dock from its edge handle and hides the handle while the dock is open', async () => {
    const user = userEvent.setup();
    openTab();
    coreStore.set({ leftDock: false, rightDock: false });
    mount();
    await user.click(screen.getByRole('button', { name: t('nav.togglePages') }));
    expect(coreStore.get().leftDock).toBe(true);
    expect(coreStore.get().rightDock).toBe(false);
    expect(screen.queryByRole('button', { name: t('nav.togglePages') })).toBeNull();
    await user.click(screen.getByRole('button', { name: t('tools.all') }));
    expect(coreStore.get().rightDock).toBe(true);
    expect(screen.queryByRole('button', { name: t('tools.all') })).toBeNull();
  });

  it('reports what the viewer does to the save store and the shell handlers', async () => {
    const user = userEvent.setup();
    openTab();
    mount();
    await user.click(screen.getByRole('button', { name: 'ready' }));
    expect(actions.onReady).toHaveBeenCalledWith({ ready: true });
    await user.click(screen.getByRole('button', { name: 'unready' }));
    expect(actions.onReady).toHaveBeenLastCalledWith(null);
    await user.click(screen.getByRole('button', { name: 'released' }));
    expect(actions.onDocumentReleased).toHaveBeenCalledWith(handle);
    await user.click(screen.getByRole('button', { name: 'modified' }));
    expect(actions.onModifiedChange).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'page 3' }));
    expect(saveStore.get().currentPage).toBe(3);
    await user.click(screen.getByRole('button', { name: 'scale 1.5' }));
    expect(saveStore.get().zoom).toBe(1.5);
    const revision = saveStore.get().layoutRevision;
    await user.click(screen.getByRole('button', { name: 'layout' }));
    expect(saveStore.get().layoutRevision).toBe(revision + 1);
  });

  it('redraws for a layout change only once the viewer has handed back its API', async () => {
    const user = userEvent.setup();
    openTab();
    let commits = 0;
    render(
      <Profiler
        id="viewer-area"
        onRender={() => {
          commits += 1;
        }}
      >
        <ViewerArea session={session} tier="desktop" t={t} actions={actions} />
      </Profiler>,
    );
    const mounted = commits;
    await user.click(screen.getByRole('button', { name: 'layout' }));
    expect(commits).toBe(mounted);
    act(() => viewerChanged(viewer));
    const shown = commits;
    await user.click(screen.getByRole('button', { name: 'layout' }));
    expect(commits).toBe(shown + 1);
  });

  it('opens find-and-replace from the viewer only while the document can be edited', async () => {
    const user = userEvent.setup();
    openTab();
    mount();
    expect(screen.queryByRole('button', { name: 'replace' })).toBeNull();
    act(() => viewerChanged(viewer));
    await user.click(screen.getByRole('button', { name: 'replace' }));
    expect(actions.openDialog).toHaveBeenCalledWith('find-replace', { find: 'needle' });
    act(() => coreStore.set({ busy: true }));
    expect(screen.queryByRole('button', { name: 'replace' })).toBeNull();
  });

  it('draws no mark layer until the viewer has handed back its API', () => {
    openTab();
    mount();
    expect(screen.getByLabelText('viewer pane')).toBeTruthy();
    expect(screen.queryByLabelText('annotation layer')).toBeNull();
    expect(screen.queryByLabelText('mark interaction')).toBeNull();
    act(() => viewerChanged(viewer));
    expect(screen.getByLabelText('annotation layer')).toBeTruthy();
    expect(screen.getByLabelText('mark interaction')).toBeTruthy();
    act(() => viewerChanged(null));
    expect(screen.queryByLabelText('annotation layer')).toBeNull();
  });

  it('marks areas to redact only on a document that can be marked', () => {
    const tab = openTab();
    viewerChanged(viewer);
    mount();
    expect(attribute('redaction layer', 'data-enabled')).toBe('true');
    act(() => lockTab(tab.id, 'secret'));
    expect(attribute('redaction layer', 'data-enabled')).toBe('false');
  });

  it('refuses redaction marks on a viewing-only document', () => {
    openTab(301);
    viewerChanged(viewer);
    mount('mobile');
    expect(attribute('redaction layer', 'data-enabled')).toBe('false');
    expect(attribute('annotation layer', 'data-tool')).toBe('null');
    expect(attribute('measure overlay', 'data-can-edit')).toBe('false');
  });

  it('draws the annotation style on the measurements and the annotation layer', () => {
    openTab();
    viewerChanged(viewer);
    annotationsStore.set({
      style: {
        color: '#abcdef',
        textColor: '#123456',
        fontSize: 14,
        opacity: 0.5,
        thickness: 3,
        author: 'Zed',
      },
    });
    coreStore.set({ shape: 'circle' });
    writeOverlay(session, 'measures', [{ id: 'm1' } as never], 'panel.comments');
    mount();
    expect(attribute('measure overlay', 'data-marks')).toBe('1');
    expect(attribute('measure overlay', 'data-can-edit')).toBe('true');
    for (const layer of ['measure overlay', 'annotation layer']) {
      expect(attribute(layer, 'data-color'), layer).toBe('#abcdef');
      expect(attribute(layer, 'data-opacity'), layer).toBe('0.5');
      expect(attribute(layer, 'data-thickness'), layer).toBe('3');
      expect(attribute(layer, 'data-author'), layer).toBe('Zed');
    }
    expect(attribute('annotation layer', 'data-shape')).toBe('circle');
    expect(attribute('annotation layer', 'data-text-color')).toBe('#123456');
    expect(attribute('annotation layer', 'data-font-size')).toBe('14');
  });

  it.each([
    ['highlight', 'highlight'],
    ['underline', 'underline'],
    ['strikeout', 'strikeout'],
    ['squiggly', 'squiggly'],
    ['ink', 'ink'],
    ['shapes', 'shapes'],
    ['note', 'note'],
    ['link', 'link'],
    ['freetext', 'freetext'],
    ['select', 'null'],
    ['hand', 'null'],
    ['redact', 'null'],
  ] as const)('arms the annotation layer for the %s tool as %s', (tool, armed) => {
    openTab();
    viewerChanged(viewer);
    coreStore.set({ canvasTool: tool });
    mount();
    expect(attribute('annotation layer', 'data-tool')).toBe(armed);
  });

  it('disarms the annotation creator while an operation holds the document, but keeps the marks', () => {
    openTab();
    viewerChanged(viewer);
    coreStore.set({ canvasTool: 'highlight' });
    mount();
    expect(attribute('annotation layer', 'data-tool')).toBe('highlight');
    act(() => coreStore.set({ busy: true }));
    expect(attribute('annotation layer', 'data-tool')).toBe('null');
    expect(screen.getByLabelText('annotation layer')).toBeTruthy();
  });

  it('adds a created mark to the document as a pending change and marks the tab dirty', async () => {
    const user = userEvent.setup();
    const tab = openTab();
    viewerChanged(viewer);
    coreStore.set({ canvasTool: 'highlight' });
    mount();
    await user.click(screen.getByRole('button', { name: 'create highlight' }));
    const current = session.getSnapshot().tabs.find((item) => item.id === tab.id);
    expect(current?.dirty).toBe(true);
    expect(pendingOverlays(current ?? null).annotations.map((mark) => mark.id)).toEqual(['h1']);
    expect(attribute('annotation layer', 'data-marks')).toBe('1');
    expect(coreStore.get().canvasTool).toBe('highlight');
    expect(coreStore.get().rightTab).not.toBe('comments');
    expect(selectionStore.get().selectedKeys).toEqual([]);
  });

  it('opens a created note for editing: selected, in the comments dock, with the pointer back on select', async () => {
    const user = userEvent.setup();
    openTab();
    viewerChanged(viewer);
    coreStore.set({ canvasTool: 'note', rightDock: false });
    mount();
    await user.click(screen.getByRole('button', { name: 'create note' }));
    expect(selectionStore.get().selectedKeys).toEqual([markTargetKey('annotation', 'n1', 1)]);
    expect(coreStore.get().canvasTool).toBe('select');
    expect(coreStore.get().rightDock).toBe(true);
    expect(coreStore.get().rightTab).toBe('comments');
  });

  it('puts the pointer back on select when the creation gesture ends', async () => {
    const user = userEvent.setup();
    openTab();
    viewerChanged(viewer);
    coreStore.set({ canvasTool: 'ink' });
    mount();
    await user.click(screen.getByRole('button', { name: 'done' }));
    expect(coreStore.get().canvasTool).toBe('select');
  });

  it('holds a dragged link region for the dialog that asks where it should point', async () => {
    const user = userEvent.setup();
    openTab();
    viewerChanged(viewer);
    mount();
    await user.click(screen.getByRole('button', { name: 'region' }));
    expect(actions.onLinkRegion).toHaveBeenCalledWith(region);
    expect(actions.openDialog).toHaveBeenCalledWith('link-add');
    expect(actions.onLinkRegion.mock.invocationCallOrder[0]).toBeLessThan(
      actions.openDialog.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('runs the common mark layer in select mode with the published targets and the selection', () => {
    openTab();
    viewerChanged(viewer);
    marksStore.set({ targets: [{ key: 'a' }, { key: 'b' }] as never });
    selectionStore.set({ selectedKeys: ['a'] });
    mount();
    expect(attribute('mark interaction', 'data-mode')).toBe('select');
    expect(attribute('mark interaction', 'data-targets')).toBe('2');
    expect(attribute('mark interaction', 'data-selected')).toBe('a');
    expect(attribute('mark interaction', 'data-resize-label')).toBe(t('stamp.resize'));
    act(() => coreStore.set({ canvasTool: 'ink' }));
    expect(attribute('mark interaction', 'data-mode')).toBe('null');
  });

  it('lets the common mark layer act only on an editable document whose saved marks are read', () => {
    const tab = openTab();
    viewerChanged(viewer);
    mount();
    expect(attribute('mark interaction', 'data-disabled')).toBe('true');
    act(() => existingInventoryRead({ tabId: tab.id, bytesKey: 'source', annotations: [] }));
    expect(attribute('mark interaction', 'data-disabled')).toBe('false');
    act(() => coreStore.set({ busy: true }));
    expect(attribute('mark interaction', 'data-disabled')).toBe('true');
  });

  it('writes the common layer’s selection, move and resize to the store and the shell handlers', async () => {
    const user = userEvent.setup();
    openTab();
    viewerChanged(viewer);
    mount();
    await user.click(screen.getByRole('button', { name: 'select marks' }));
    expect(selectionStore.get().selectedKeys).toEqual(['x', 'y']);
    await user.click(screen.getByRole('button', { name: 'move marks' }));
    expect(actions.transformTargets).toHaveBeenCalledWith(['x'], { dx: 3, dy: 4, rotation: 0 });
    await user.click(screen.getByRole('button', { name: 'resize mark' }));
    expect(actions.onResizeStamp).toHaveBeenCalledWith('k', [1, 2, 3, 4]);
  });

  it('hands stamp placement, field candidates and the text tool what they need', async () => {
    const user = userEvent.setup();
    const tab = openTab();
    viewerChanged(viewer);
    saveStore.set({ currentPage: 4 });
    mount();
    expect(attribute('stamp placement', 'data-can-edit')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'place stamp' }));
    expect(actions.onPlaceStamp).toHaveBeenCalledWith(placement);
    expect(attribute('field candidates', 'data-tab')).toBe(tab.id);
    expect(attribute('field candidates', 'data-can-edit')).toBe('true');
    expect(attribute('text tool', 'data-page')).toBe('4');
    await user.click(screen.getByRole('button', { name: 'edit text' }));
    expect(actions.openDialog).toHaveBeenCalledWith('text-edit');
  });

  it('draws the reading-order boxes only while the accessibility tab of the open right dock is shown', async () => {
    openTab();
    viewerChanged(viewer);
    coreStore.set({ rightDock: true, rightTab: 'accessibility' });
    mount();
    expect(await screen.findByLabelText('reading order')).toBeTruthy();
    act(() => coreStore.set({ rightTab: 'comments' }));
    expect(screen.queryByLabelText('reading order')).toBeNull();
    act(() => coreStore.set({ rightTab: 'accessibility', rightDock: false }));
    expect(screen.queryByLabelText('reading order')).toBeNull();
  });
});
