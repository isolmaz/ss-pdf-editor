// @vitest-environment happy-dom
/**
 * The right dock follows the core store: it is on screen exactly while the store says so and a
 * document is open, shows the panel of the selected tab, and what the user does in a panel
 * reaches the stores, the viewer and the shell's actions as the exact calls the shell wires.
 * The panels' internals are their own (and tested there); here each is a stand-in that exposes
 * the props the shell wires.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { type MarkTarget, markTargetKey } from 'pdf-ui/tools';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { SIMPLE_MODE_RAIL_GROUPS } from '../../commands';
import { pendingOverlays } from '../../operations';
import { coreStore, initialCoreState, setBusy } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { dialogsStore, initialDialogsState, operationDialogOpened } from '../dialogs/dialogs-store';
import { exportStore, initialExportState } from '../export/export-store';
import { formsStore, initialFormsState } from '../forms/forms-store';
import {
  annotationMark,
  existingTarget,
  fileAnnotation,
  redactionMark,
  writeMarks,
} from '../marks/marks-fixtures';
import { initialMarksState, marksStore } from '../marks/marks-store';
import { erasedWordsOf } from '../marks/redaction-store';
import { initialOpenState, openStore } from '../open/open-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { initialSelectionState, selectionStore } from '../selection/selection-store';
import { initialTextToolState, textBlockPicked, textToolStore } from '../selection/text-tool-store';
import { RightDock, type RightDockProps } from './RightDock';
import { initialShellState, shellStore } from './shell-store';

/** The props each stand-in last rendered with, for the handlers that take arguments. */
type Props = Record<string, unknown>;
const captured = vi.hoisted(() => ({}) as Record<string, Props>);

/** The props the named stand-in last rendered with. */
function seen(name: string): Props {
  const props = captured[name];
  if (props === undefined) throw new Error(`the ${name} stand-in did not render`);
  return props;
}

/** Call the handler the named stand-in last received, as the panel would. */
function call(name: string, handler: string, ...args: unknown[]): unknown {
  const fn = seen(name)[handler];
  if (typeof fn !== 'function') throw new Error(`the ${name} stand-in received no ${handler}`);
  return fn(...args);
}

vi.mock('pdf-ui/ui', async (original) => {
  const { createElement } = await import('react');
  const button = (label: string, onClick: () => void) =>
    createElement('button', { type: 'button', key: label, onClick }, label);
  return {
    ...(await original<typeof import('pdf-ui/ui')>()),
    Dock: (props: Props) => {
      captured.dock = props;
      const tabs = props.tabs as readonly { id: string; label: string }[];
      return createElement(
        'aside',
        { 'aria-label': 'dock', 'data-active': String(props.activeId), 'data-wide': String(props.wide) },
        button('hide dock', props.onToggle as () => void),
        ...tabs.map((tab) => button(`tab ${tab.id}`, () => (props.onSelect as (id: string) => void)(tab.id))),
        props.children as never,
      );
    },
    ToolsRailPanel: (props: Props) => {
      captured.tools = props;
      return createElement(
        'section',
        {
          'aria-label': 'tools panel',
          'data-spec': String((props.activeSpec as { id?: string } | null)?.id ?? 'none'),
          'data-context': String((props.context as { name?: string } | null)?.name ?? 'none'),
          'data-groups':
            props.visibleGroups === undefined ? 'all' : (props.visibleGroups as string[]).join(','),
        },
        button('back to tools', props.onBackToTools as () => void),
        button('open palette', props.onOpenPalette as () => void),
        button('export modal', props.onExportModal as () => void),
      );
    },
    HistoryPanel: (props: Props) => {
      captured.history = props;
      return createElement(
        'section',
        {
          'aria-label': 'history panel',
          'data-entries': String((props.entries as unknown[]).length),
          'data-cursor': String(props.cursor),
        },
        button('undo', props.onUndo as () => void),
        button('redo', props.onRedo as () => void),
      );
    },
  };
});
vi.mock('pdf-ui/panels', async () => {
  const { createElement } = await import('react');
  return {
    ComparePanel: (props: Props) => {
      captured.compare = props;
      return createElement(
        'section',
        { 'aria-label': 'compare panel', 'data-disabled': String(props.disabled) },
        createElement(
          'button',
          { type: 'button', onClick: () => void (props.readDocument as () => unknown)() },
          'read',
        ),
        createElement(
          'button',
          { type: 'button', onClick: () => (props.onGoToPage as (page: number) => void)(6) },
          'go',
        ),
        createElement(
          'button',
          { type: 'button', onClick: () => (props.onNotice as (text: string) => void)('cmp') },
          'say',
        ),
      );
    },
  };
});
vi.mock('../comments/CommentsDock', async () => {
  const { createElement } = await import('react');
  return {
    CommentsDock: (props: Props) => {
      captured.comments = props;
      return createElement('section', {
        'aria-label': 'comments panel',
        'data-marks': String((props.marks as unknown[]).length),
        'data-existing': String((props.existing as unknown[] | null)?.length ?? 'none'),
        'data-selected': String(props.selectedId),
        'data-disabled': String(props.disabled),
      });
    },
  };
});
vi.mock('../facts/PropertiesFacts', async () => {
  const { createElement } = await import('react');
  return {
    PropertiesFacts: (props: Props) => {
      captured.properties = props;
      return createElement(
        'section',
        { 'aria-label': 'properties panel', 'data-disabled': String(props.disabled) },
        createElement('button', { type: 'button', onClick: props.onRetry as () => void }, 'retry'),
      );
    },
  };
});
vi.mock('../facts/RedactionAuditView', async () => {
  const { createElement } = await import('react');
  return {
    RedactionAuditView: (props: Props) => {
      captured.audit = props;
      return createElement('section', { 'aria-label': 'audit panel' });
    },
  };
});
vi.mock('../forms/FormsSurface', async () => {
  const { createElement } = await import('react');
  return {
    FormsPanel: (props: Props) => {
      captured.forms = props;
      return createElement(
        'section',
        { 'aria-label': 'forms panel', 'data-can-edit': String(props.canEdit) },
        createElement('button', { type: 'button', onClick: props.onDetect as () => void }, 'detect'),
        createElement('button', { type: 'button', onClick: props.onApply as () => void }, 'apply'),
        createElement(
          'button',
          { type: 'button', onClick: () => (props.goToPage as (page: number) => void)(2) },
          'forms go',
        ),
      );
    },
  };
});
vi.mock('../marks/RedactionSurfaces', async () => {
  const { createElement } = await import('react');
  return {
    RedactionDock: (props: Props) => {
      captured.redaction = props;
      return createElement(
        'section',
        {
          'aria-label': 'redaction panel',
          'data-marks': String((props.marks as unknown[]).length),
          'data-can-edit': String(props.canEdit),
        },
        createElement('button', { type: 'button', onClick: props.onApply as () => void }, 'apply redactions'),
      );
    },
  };
});
vi.mock('../results/ResultsSurfaces', async () => {
  const { createElement } = await import('react');
  return {
    AccessibilityDock: (props: Props) => {
      captured.accessibility = props;
      return createElement(
        'section',
        {
          'aria-label': 'accessibility panel',
          'data-language': String(props.language),
          'data-page': String(props.currentPage),
          'data-can-edit': String(props.canEdit),
        },
        createElement(
          'button',
          { type: 'button', onClick: () => void (props.read as () => unknown)() },
          'read a11y',
        ),
        createElement(
          'button',
          { type: 'button', onClick: () => (props.onGoToPage as (page: number) => void)(8) },
          'a11y go',
        ),
      );
    },
    PdfADock: (props: Props) => {
      captured.pdfa = props;
      return createElement(
        'section',
        { 'aria-label': 'pdfa panel' },
        createElement('button', { type: 'button', onClick: props.onConvert as () => void }, 'convert'),
        createElement(
          'button',
          { type: 'button', onClick: () => void (props.read as () => unknown)() },
          'read pdfa',
        ),
      );
    },
  };
});

const t = createTranslator('en');
const handle = { id: 'handle' } as unknown as PdfDocumentHandle;
let session: SessionStore;
let tabId: string;
let actions: {
  openDialog: Mock;
  runPageAction: Mock;
  stepHistoryNow: Mock;
  startFormDetect: Mock;
  dialogResult: Mock;
  removeTargets: Mock;
  annotationData: { exportAnnotationData: Mock; importAnnotationData: Mock };
  commentReview: { onReply: Mock; onSetState: Mock; onRemoveReply: Mock };
  attachments: { addToDocument: Mock; removeFromDocument: Mock; readOut: Mock };
  results: { applyAccessibility: Mock };
  currentBytes: Mock;
  applyFormDetect: Mock;
  fillField: Mock;
};
let viewer: { document: PdfDocumentHandle; goToPage: Mock };

// The compare panel is a dynamic chunk (mocked here): resolve it once up front so no test races the first import.
beforeAll(async () => {
  await import('pdf-ui/panels');
}, 120_000);

beforeEach(() => {
  coreStore.set(initialCoreState());
  coreStore.set({ rightDock: true, compactViewport: false, mode: 'advanced', rightTab: 'history' });
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  formsStore.set(initialFormsState());
  dialogsStore.set(initialDialogsState());
  exportStore.set(initialExportState());
  marksStore.set(initialMarksState());
  selectionStore.set(initialSelectionState());
  textToolStore.set(initialTextToolState());
  shellStore.set(initialShellState());
  session = new SessionStore();
  viewer = { document: handle, goToPage: vi.fn() };
  actions = {
    openDialog: vi.fn(),
    runPageAction: vi.fn(),
    stepHistoryNow: vi.fn(async () => undefined),
    startFormDetect: vi.fn(),
    dialogResult: vi.fn(async () => undefined),
    removeTargets: vi.fn(() => true),
    annotationData: {
      exportAnnotationData: vi.fn(async () => undefined),
      importAnnotationData: vi.fn(async () => undefined),
    },
    commentReview: { onReply: vi.fn(), onSetState: vi.fn(), onRemoveReply: vi.fn() },
    attachments: {
      addToDocument: vi.fn(async () => undefined),
      removeFromDocument: vi.fn(async () => undefined),
      readOut: vi.fn(async () => undefined),
    },
    results: { applyAccessibility: vi.fn() },
    currentBytes: vi.fn(async () => new Uint8Array([1])),
    applyFormDetect: vi.fn(),
    fillField: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  if (tabId !== undefined) dropHandle(tabId);
});

function openTab() {
  const tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 3 });
  tabId = tab.id;
  adoptHandle(tab.id, handle);
  return tab;
}

/** An editable document: the viewer shows it, nothing holds it. */
function openEditable() {
  const tab = openTab();
  act(() => viewerChanged(viewer as unknown as ViewerApi));
  return tab;
}

function renderDock(rightTab: string, dialogContext: RightDockProps['dialogContext'] = null) {
  coreStore.set({ rightTab });
  return render(
    <RightDock
      session={session}
      tier="desktop"
      t={t}
      dialogContext={dialogContext}
      actions={actions as unknown as RightDockProps['actions']}
    />,
  );
}

function annotationTarget(id: string): MarkTarget {
  return {
    key: markTargetKey('annotation', id, 0),
    family: 'annotation',
    id,
    pageIndex: 0,
    boxes: [[0, 0, 1, 1]],
    label: 'Note',
  };
}

function annotationsOfActive() {
  return pendingOverlays(session.active).annotations;
}

describe('RightDock visibility and frame', () => {
  it('shows nothing while the right dock is closed', () => {
    openTab();
    coreStore.set({ rightDock: false });
    renderDock('history');
    expect(screen.queryByLabelText('dock')).toBeNull();
  });

  it('shows nothing with no document open', () => {
    renderDock('history');
    expect(screen.queryByLabelText('dock')).toBeNull();
  });

  it('keeps the dock in the flow on a wide screen and overlays it on a narrow one', () => {
    openTab();
    const { container } = renderDock('history');
    expect(container.firstElementChild?.className).toBe('contents');
    act(() => coreStore.set({ compactViewport: true }));
    expect(container.firstElementChild?.className).toBe('absolute inset-y-0 end-0 z-40 max-w-full');
  });

  it('lists the ten tabs, selects one the user presses and closes on request', async () => {
    openTab();
    renderDock('history');
    expect((seen('dock').tabs as { id: string }[]).map((tab) => tab.id)).toEqual([
      'tools',
      'history',
      'comments',
      'forms',
      'properties',
      'redaction',
      'redaction-audit',
      'compare',
      'accessibility',
      'pdfa',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'tab comments' }));
    expect(coreStore.get().rightTab).toBe('comments');
    expect(screen.getByLabelText('comments panel')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'hide dock' }));
    expect(coreStore.get().rightDock).toBe(false);
    expect(screen.queryByLabelText('dock')).toBeNull();
  });

  it('widens the dock for the accessibility panel only', () => {
    openTab();
    renderDock('history');
    expect(screen.getByLabelText('dock').dataset.wide).toBe('false');
    act(() => coreStore.set({ rightTab: 'accessibility' }));
    expect(screen.getByLabelText('dock').dataset.wide).toBe('true');
  });
});

describe('RightDock tools tab', () => {
  it('hands the rail the open dialog, its frozen context and the groups of the mode', () => {
    openTab();
    operationDialogOpened(
      { tabId, workingId: 'w', name: 'frozen.pdf', pageCount: 3, bytes: new Uint8Array([1]) },
      { id: 'merge' } as never,
    );
    renderDock('tools', { name: 'ctx' } as never);
    const panel = screen.getByLabelText('tools panel');
    expect(panel.dataset.spec).toBe('merge');
    expect(panel.dataset.context).toBe('ctx');
    expect(panel.dataset.groups).toBe('all');
    act(() => coreStore.set({ mode: 'simple' }));
    expect(screen.getByLabelText('tools panel').dataset.groups).toBe(SIMPLE_MODE_RAIL_GROUPS.join(','));
  });

  it('opens the operation the user picked', () => {
    openEditable();
    renderDock('tools');
    act(() => call('tools', 'onSelectTool', 'merge' as never));
    expect(actions.openDialog).toHaveBeenCalledWith('merge');
  });

  it('opens the redaction form on an editable document', () => {
    openEditable();
    renderDock('tools');
    act(() => call('tools', 'onSelectTool', 'redact' as never));
    expect(actions.openDialog).toHaveBeenCalledWith('redact');
  });

  it('says why the redaction form is refused on a protected document', () => {
    const tab = openEditable();
    act(() => openStore.set({ lockedTabs: new Map([[tab.id, 'pw']]) }));
    renderDock('tools');
    act(() => call('tools', 'onSelectTool', 'redact' as never));
    expect(coreStore.get().notice).toBe(t('locked.banner'));
    expect(actions.openDialog).not.toHaveBeenCalled();
  });

  it('refuses the redaction form while an operation holds the document', () => {
    openEditable();
    act(() => setBusy(true));
    renderDock('tools');
    act(() => call('tools', 'onSelectTool', 'redact' as never));
    expect(coreStore.get().notice).toBe(t('op.busy'));
    expect(actions.openDialog).not.toHaveBeenCalled();
  });

  it('refuses the redaction form silently until the viewer shows the document', () => {
    openTab();
    renderDock('tools');
    act(() => call('tools', 'onSelectTool', 'redact' as never));
    expect(coreStore.get().notice).toBeNull();
    expect(actions.openDialog).not.toHaveBeenCalled();
  });

  it('leaves the operation: stops it, dismisses its dialog and drops the block selection', async () => {
    openEditable();
    operationDialogOpened(
      { tabId, workingId: 'w', name: 'frozen.pdf', pageCount: 3, bytes: new Uint8Array([1]) },
      { id: 'merge' } as never,
    );
    textBlockPicked({ pageIndex: 0, block: 'b', model: 'm', fonts: [] } as never);
    const controller = new AbortController();
    coreStore.set({ operation: controller });
    renderDock('tools');
    await userEvent.click(screen.getByRole('button', { name: 'back to tools' }));
    expect(controller.signal.aborted).toBe(true);
    expect(dialogsStore.get().dialogSpec).toBeNull();
    expect(dialogsStore.get().dialogInput).toBeNull();
    expect(textToolStore.get().edit).toBeNull();
  });

  it('forwards dialog results and page actions to the shell', () => {
    openEditable();
    renderDock('tools');
    const result = { kind: 'done' };
    act(() => void call('tools', 'onResult', result as never));
    expect(actions.dialogResult).toHaveBeenCalledWith(result);
    act(() => call('tools', 'onPageAction', 'rotate-left' as never));
    expect(actions.runPageAction).toHaveBeenCalledWith('rotate-left');
  });

  it('arms the redaction tool on an editable document', () => {
    openEditable();
    renderDock('tools');
    act(() => call('tools', 'onArmTool', 'redact' as never));
    expect(coreStore.get().canvasTool).toBe('redact');
  });

  it('refuses to arm the redaction tool on a protected document and says why', () => {
    const tab = openEditable();
    act(() => openStore.set({ lockedTabs: new Map([[tab.id, 'pw']]) }));
    renderDock('tools');
    act(() => call('tools', 'onArmTool', 'redact' as never));
    expect(coreStore.get().canvasTool).toBe('select');
    expect(coreStore.get().notice).toBe(t('locked.banner'));
  });

  it('refuses to arm the redaction tool where nothing can be written, without a notice', () => {
    openTab();
    renderDock('tools');
    act(() => call('tools', 'onArmTool', 'redact' as never));
    expect(coreStore.get().canvasTool).toBe('select');
    expect(coreStore.get().notice).toBeNull();
  });

  it('arms the highlighter and ignores any other tool the rail names', () => {
    openEditable();
    renderDock('tools');
    act(() => call('tools', 'onArmTool', 'ink' as never));
    expect(coreStore.get().canvasTool).toBe('select');
    act(() => call('tools', 'onArmTool', 'highlight' as never));
    expect(coreStore.get().canvasTool).toBe('highlight');
  });

  it('opens the palette and the export dialog from the rail', async () => {
    openEditable();
    renderDock('tools');
    await userEvent.click(screen.getByRole('button', { name: 'open palette' }));
    expect(shellStore.get().paletteOpen).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'export modal' }));
    expect(exportStore.get().exportOpen).toBe(true);
  });
});

describe('RightDock history tab', () => {
  it('shows the journal of the open document and steps it on request', async () => {
    const tab = openEditable();
    writeMarks(session, tab.id, { annotations: [annotationMark('a1')], measures: [], redactions: [] });
    renderDock('history');
    const panel = screen.getByLabelText('history panel');
    expect(panel.dataset.entries).toBe('1');
    expect(panel.dataset.cursor).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'undo' }));
    expect(actions.stepHistoryNow).toHaveBeenLastCalledWith('undo');
    await userEvent.click(screen.getByRole('button', { name: 'redo' }));
    expect(actions.stepHistoryNow).toHaveBeenLastCalledWith('redo');
  });
});

describe('RightDock comments tab', () => {
  function withAnnotations() {
    const tab = openEditable();
    writeMarks(session, tab.id, {
      annotations: [annotationMark('a1'), annotationMark('a2')],
      measures: [],
      redactions: [redactionMark('r1')],
    });
    marksStore.set({ targets: [annotationTarget('a1'), annotationTarget('a2'), existingTarget('e1')] });
    return tab;
  }

  it('hands the panel the marks, the file’s own annotations and whether editing is off', () => {
    const tab = withAnnotations();
    formsStore.set({
      existingInventory: { tabId: tab.id, bytesKey: 'source', annotations: [fileAnnotation('f1')] },
    });
    renderDock('comments');
    const panel = screen.getByLabelText('comments panel');
    expect(panel.dataset.marks).toBe('2');
    expect(panel.dataset.existing).toBe('1');
    expect(panel.dataset.disabled).toBe('false');
    expect(seen('comments').onReply).toBe(actions.commentReview.onReply);
    expect(seen('comments').onSetState).toBe(actions.commentReview.onSetState);
    expect(seen('comments').onRemoveReply).toBe(actions.commentReview.onRemoveReply);
  });

  it('disables the panel while the document cannot be edited', () => {
    openTab();
    renderDock('comments');
    expect(screen.getByLabelText('comments panel').dataset.disabled).toBe('true');
    expect(screen.getByLabelText('comments panel').dataset.existing).toBe('none');
  });

  it('highlights the row of the selected annotation and none for other selections', () => {
    withAnnotations();
    renderDock('comments');
    expect(screen.getByLabelText('comments panel').dataset.selected).toBe('null');
    act(() => selectionStore.set({ selectedKeys: [markTargetKey('existing', 'e1', 0)] }));
    expect(screen.getByLabelText('comments panel').dataset.selected).toBe('null');
    act(() => selectionStore.set({ selectedKeys: [markTargetKey('annotation', 'a2', 0)] }));
    expect(screen.getByLabelText('comments panel').dataset.selected).toBe('a2');
  });

  it('selects the row the user picks, and clears the selection on the second click', () => {
    withAnnotations();
    renderDock('comments');
    act(() => call('comments', 'onSelect', 'a2' as never));
    expect(selectionStore.get().selectedKeys).toEqual([markTargetKey('annotation', 'a2', 0)]);
    act(() => call('comments', 'onSelect', null as never));
    expect(selectionStore.get().selectedKeys).toEqual([]);
  });

  it('ignores a row that names no mark', () => {
    withAnnotations();
    selectionStore.set({ selectedKeys: ['kept'] });
    renderDock('comments');
    act(() => call('comments', 'onSelect', 'ghost' as never));
    expect(selectionStore.get().selectedKeys).toEqual(['kept']);
  });

  it('writes an edited comment into that mark only, as one journal step', () => {
    withAnnotations();
    renderDock('comments');
    const before = session.active?.journal.entries.length ?? 0;
    act(() => call('comments', 'onEdit', 'a1' as never, 'new text' as never));
    expect(annotationsOfActive().map((mark) => [mark.id, mark.contents])).toEqual([
      ['a1', 'new text'],
      ['a2', ''],
    ]);
    expect(session.active?.journal.entries.length).toBe(before + 1);
  });

  it('removes one mark, or every annotation, through the one removal intent', () => {
    withAnnotations();
    renderDock('comments');
    act(() => call('comments', 'onRemove', 'a1' as never));
    expect(actions.removeTargets).toHaveBeenLastCalledWith([markTargetKey('annotation', 'a1', 0)]);
    act(() => call('comments', 'onClear'));
    expect(actions.removeTargets).toHaveBeenLastCalledWith([
      markTargetKey('annotation', 'a1', 0),
      markTargetKey('annotation', 'a2', 0),
    ]);
  });

  it('forwards the annotation data export and import', () => {
    withAnnotations();
    renderDock('comments');
    act(() => call('comments', 'onExportData', 'xfdf' as never));
    expect(actions.annotationData.exportAnnotationData).toHaveBeenCalledWith('xfdf');
    const file = new File(['x'], 'a.xfdf');
    act(() => call('comments', 'onImportData', file as never));
    expect(actions.annotationData.importAnnotationData).toHaveBeenCalledWith(file);
  });

  it('scrolls the viewer to a page the panel names, and does nothing without a viewer', () => {
    openTab();
    renderDock('comments');
    act(() => call('comments', 'onGoToPage', 4 as never));
    expect(viewer.goToPage).not.toHaveBeenCalled();
    act(() => viewerChanged(viewer as unknown as ViewerApi));
    act(() => call('comments', 'onGoToPage', 4 as never));
    expect(viewer.goToPage).toHaveBeenCalledWith(4);
  });
});

describe('RightDock properties tab', () => {
  it('shows the facts of the open document and routes attachment writes and reads', () => {
    openEditable();
    renderDock('properties');
    expect(screen.getByLabelText('properties panel').dataset.disabled).toBe('false');
    const file = new File(['x'], 'x.txt');
    act(() => call('properties', 'onAddAttachments', [file] as never));
    expect(actions.attachments.addToDocument).toHaveBeenCalledWith([file]);
    act(() => call('properties', 'onRemoveAttachment', 'x.txt' as never));
    expect(actions.attachments.removeFromDocument).toHaveBeenCalledWith('x.txt');
    act(() => call('properties', 'onReadAttachment', 'x.txt' as never));
    expect(actions.attachments.readOut).toHaveBeenCalledWith('x.txt');
  });

  it('asks for the facts to be read again and disables writes while the document cannot be edited', async () => {
    openTab();
    renderDock('properties');
    expect(screen.getByLabelText('properties panel').dataset.disabled).toBe('true');
    const revision = formsStore.get().inspectionRevision;
    await userEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(formsStore.get().inspectionRevision).toBe(revision + 1);
  });
});

describe('RightDock redaction audit tab', () => {
  it('audits the session with the redaction store’s erased words', () => {
    openTab();
    renderDock('redaction-audit');
    expect(screen.getByLabelText('audit panel')).toBeTruthy();
    expect(seen('audit').store).toBe(session);
    expect(seen('audit').erasedTerms).toBe(erasedWordsOf);
  });
});

describe('RightDock compare tab', () => {
  it('names the panel while its chunk loads, then reads the working bytes on request', async () => {
    openEditable();
    const { container } = renderDock('compare');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByLabelText('compare panel')).toBeTruthy();
    expect(screen.getByLabelText('compare panel').dataset.disabled).toBe('false');
    await userEvent.click(screen.getByRole('button', { name: 'read' }));
    expect(actions.currentBytes).toHaveBeenCalledTimes(1);
    const operation = actions.currentBytes.mock.calls[0]?.[0] as { signal: AbortSignal };
    expect(operation.signal.aborted).toBe(false);
  });

  it('scrolls the viewer and reports on the status line', async () => {
    openEditable();
    renderDock('compare');
    await screen.findByLabelText('compare panel');
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(viewer.goToPage).toHaveBeenCalledWith(6);
    await userEvent.click(screen.getByRole('button', { name: 'say' }));
    expect(coreStore.get().notice).toBe('cmp');
  });

  it('is disabled while the document cannot be edited', async () => {
    openTab();
    renderDock('compare');
    expect((await screen.findByLabelText('compare panel')).dataset.disabled).toBe('true');
  });
});

describe('RightDock accessibility tab', () => {
  it('gives the panel the page, the language and the editing state, and the shell’s writers', async () => {
    openEditable();
    saveStore.set({ currentPage: 5 });
    renderDock('accessibility');
    const panel = screen.getByLabelText('accessibility panel');
    expect(panel.dataset.page).toBe('5');
    expect(panel.dataset.language).toBe('en');
    expect(panel.dataset.canEdit).toBe('true');
    expect(seen('accessibility').onWritten).toBe(actions.results.applyAccessibility);
    expect(seen('accessibility').read).toBe(actions.currentBytes);
    await userEvent.click(screen.getByRole('button', { name: 'a11y go' }));
    expect(viewer.goToPage).toHaveBeenCalledWith(8);
  });
});

describe('RightDock PDF/A tab', () => {
  it('opens the conversion dialog and reads the working bytes', async () => {
    openEditable();
    renderDock('pdfa');
    await userEvent.click(screen.getByRole('button', { name: 'convert' }));
    expect(actions.openDialog).toHaveBeenCalledWith('pdfa');
    expect(seen('pdfa').read).toBe(actions.currentBytes);
  });
});

describe('RightDock forms tab', () => {
  it('wires detection, review and filling to the shell', async () => {
    openEditable();
    renderDock('forms');
    expect(screen.getByLabelText('forms panel').dataset.canEdit).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'detect' }));
    expect(actions.startFormDetect).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'apply' }));
    expect(actions.applyFormDetect).toHaveBeenCalledTimes(1);
    act(() => call('forms', 'onFill', 'name' as never, true as never));
    expect(actions.fillField).toHaveBeenCalledWith('name', true);
    await userEvent.click(screen.getByRole('button', { name: 'forms go' }));
    expect(viewer.goToPage).toHaveBeenCalledWith(2);
  });
});

describe('RightDock redaction tab', () => {
  it('lists the drawn redactions and opens the redaction dialog', async () => {
    const tab = openEditable();
    writeMarks(session, tab.id, {
      annotations: [],
      measures: [],
      redactions: [redactionMark('r1'), redactionMark('r2')],
    });
    renderDock('redaction');
    const panel = screen.getByLabelText('redaction panel');
    expect(panel.dataset.marks).toBe('2');
    expect(panel.dataset.canEdit).toBe('true');
    expect(seen('redaction').removeTargets).toBe(actions.removeTargets);
    await userEvent.click(screen.getByRole('button', { name: 'apply redactions' }));
    expect(actions.openDialog).toHaveBeenCalledWith('redact');
  });
});
