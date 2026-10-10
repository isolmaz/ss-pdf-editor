// @vitest-environment happy-dom
/**
 * The core store's intent-named actions: what each one writes, which fields move together in
 * one notification, and the rules that follow a change of tool (the stamp's picture, the
 * markup look). Components read it with `useCore`.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'pdf-shared';
import type { StampSource } from 'pdf-ui/dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStoredMode } from '../../interface-mode';
import {
  armStampTool,
  beginOperation,
  bumpHandleVersion,
  cancelOperation,
  clearNotice,
  compactViewportChanged,
  coreStore,
  endOperation,
  hideLeftDock,
  hideRightDock,
  initialCoreState,
  isBusy,
  isCompactViewport,
  openLeftPanel,
  openRightPanel,
  operationRunning,
  pickTool,
  refuseBusy,
  selectLeftTab,
  selectRightTab,
  selectShape,
  selectTool,
  setBusy,
  setInterfaceMode,
  showLeftDock,
  showNotice,
  showNoticeIfEmpty,
  showNoticeOnce,
  showRightDock,
  toggleLeftDock,
  toggleRightDock,
  toggleRightPanel,
  toggleTool,
  useCore,
} from './core-store';
import { isMarkupTool } from './tools';

const initial = coreStore.get();
const stamp = { role: 'signature', bytes: new Uint8Array([1]) } as unknown as StampSource;

beforeEach(() => {
  localStorage.clear();
  coreStore.set(initial);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the starting state', () => {
  it('opens both docks on a desktop and closes them on a narrow screen', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(isCompactViewport()).toBe(false);
    expect(initialCoreState()).toMatchObject({ compactViewport: false, leftDock: true, rightDock: true });

    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(isCompactViewport()).toBe(true);
    expect(initialCoreState()).toMatchObject({ compactViewport: true, leftDock: false, rightDock: false });
  });

  it('treats a page with no media queries as a desktop', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(isCompactViewport()).toBe(false);
  });

  it('starts in the mode the user last chose, on the select tool, with nothing on the notice line', () => {
    setInterfaceMode('advanced');
    expect(initialCoreState()).toMatchObject({
      mode: 'advanced',
      canvasTool: 'select',
      markupTool: 'highlight',
      pendingStamp: null,
      notice: null,
      busy: false,
      leftTab: 'pages',
      rightTab: 'history',
    });
  });
});

describe('the notice line', () => {
  it('shows a message, replaces it, and clears it', () => {
    showNotice('Saved');
    expect(coreStore.get().notice).toBe('Saved');
    showNotice('Exported');
    expect(coreStore.get().notice).toBe('Exported');
    clearNotice();
    expect(coreStore.get().notice).toBeNull();
  });

  it('says a repeated warning once: it is shown unless the line already contains it', () => {
    showNoticeOnce('Storage is full');
    const first = coreStore.get();
    showNoticeOnce('Storage is full');
    expect(coreStore.get()).toBe(first);

    showNotice('Storage is full. Free some space.');
    showNoticeOnce('Storage is full');
    expect(coreStore.get().notice).toBe('Storage is full. Free some space.');

    showNotice('Saved');
    showNoticeOnce('Storage is full');
    expect(coreStore.get().notice).toBe('Storage is full');
  });

  it('lets a footnote fill an empty line and never replace a message that is showing', () => {
    showNoticeIfEmpty('Restored 2 edits');
    expect(coreStore.get().notice).toBe('Restored 2 edits');
    showNoticeIfEmpty('Something else');
    expect(coreStore.get().notice).toBe('Restored 2 edits');
  });
});

describe('the busy gate', () => {
  it('is read at the moment of the call, not from a render', () => {
    expect(isBusy()).toBe(false);
    setBusy(true);
    expect(isBusy()).toBe(true);
    setBusy(false);
    expect(isBusy()).toBe(false);
  });

  it('counts handle swaps', () => {
    bumpHandleVersion();
    bumpHandleVersion();
    expect(coreStore.get().handleVersion).toBe(2);
  });
});

describe('refusing a gesture the busy gate closed', () => {
  it('says the document is busy, in the language it is given', () => {
    refuseBusy(createTranslator('en'));
    expect(coreStore.get().notice).toBe(createTranslator('en')('op.busy'));
  });
});

describe('the running operation', () => {
  it('registers the controller of the operation that began, and runs nothing otherwise', () => {
    expect(operationRunning()).toBe(false);
    const controller = beginOperation();
    expect(operationRunning()).toBe(true);
    expect(coreStore.get().operation).toBe(controller);
    expect(controller.signal.aborted).toBe(false);
  });

  it('aborts the running operation on Cancel, and does nothing when none runs', () => {
    expect(() => cancelOperation()).not.toThrow();
    const controller = beginOperation();
    cancelOperation();
    expect(controller.signal.aborted).toBe(true);
    expect(operationRunning()).toBe(true);
  });

  it('releases only the operation that owns the document', () => {
    const first = beginOperation();
    expect(endOperation(first)).toBe(true);
    expect(operationRunning()).toBe(false);
    expect(endOperation(first)).toBe(false);
    const older = beginOperation();
    const newer = beginOperation();
    expect(endOperation(older)).toBe(false);
    expect(coreStore.get().operation).toBe(newer);
    expect(endOperation(newer)).toBe(true);
  });
});

describe('tools', () => {
  it('arms a tool and puts the pointer back on select', () => {
    selectTool('ink');
    expect(coreStore.get().canvasTool).toBe('ink');
    selectTool('select');
    expect(coreStore.get().canvasTool).toBe('select');
  });

  it('remembers the last markup look, and only a markup look', () => {
    selectTool('underline');
    expect(coreStore.get().markupTool).toBe('underline');
    selectTool('ink');
    expect(coreStore.get().markupTool).toBe('underline');
    selectTool('squiggly');
    selectTool('select');
    expect(coreStore.get().markupTool).toBe('squiggly');
    expect(isMarkupTool('strikeout')).toBe(true);
    expect(isMarkupTool('ink')).toBe(false);
  });

  it('arms the stamp tool with its picture in one change, and any other tool drops the picture', () => {
    const seen: (typeof initial)[] = [];
    coreStore.subscribe(() => seen.push(coreStore.get()));

    armStampTool(stamp);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ canvasTool: 'stamp', pendingStamp: stamp });

    selectTool('select');
    expect(coreStore.get()).toMatchObject({ canvasTool: 'select', pendingStamp: null });

    coreStore.set({ pendingStamp: stamp });
    selectTool('stamp');
    expect(coreStore.get()).toMatchObject({ canvasTool: 'stamp', pendingStamp: stamp });
  });

  it('arming the tool already armed changes nothing, not even a picture set beside it', () => {
    coreStore.set({ pendingStamp: stamp });
    const before = coreStore.get();
    selectTool('select');
    expect(coreStore.get()).toBe(before);
  });

  it('toggles a tool: a second press puts the pointer back on select', () => {
    toggleTool('redact');
    expect(coreStore.get().canvasTool).toBe('redact');
    toggleTool('redact');
    expect(coreStore.get().canvasTool).toBe('select');
  });

  it('opens the comments dock for the note tool, and only for it', () => {
    hideRightDock();
    pickTool('ink');
    expect(coreStore.get()).toMatchObject({ canvasTool: 'ink', rightDock: false });

    pickTool('note');
    expect(coreStore.get()).toMatchObject({ canvasTool: 'note', rightDock: true, rightTab: 'comments' });

    selectRightTab('history');
    pickTool('note');
    expect(coreStore.get().rightTab).toBe('comments');
  });

  it('chooses the shape the next shape mark carries', () => {
    selectShape('circle');
    expect(coreStore.get().shape).toBe('circle');
  });
});

describe('docks and tabs', () => {
  it('shows, hides and toggles each dock on its own', () => {
    hideLeftDock();
    hideRightDock();
    expect(coreStore.get()).toMatchObject({ leftDock: false, rightDock: false });
    showLeftDock();
    expect(coreStore.get()).toMatchObject({ leftDock: true, rightDock: false });
    showRightDock();
    toggleLeftDock();
    toggleRightDock();
    expect(coreStore.get()).toMatchObject({ leftDock: false, rightDock: false });
    toggleLeftDock();
    expect(coreStore.get().leftDock).toBe(true);
  });

  it('switches a dock’s view without opening or closing the dock', () => {
    hideLeftDock();
    hideRightDock();
    selectLeftTab('outline');
    selectRightTab('forms');
    expect(coreStore.get()).toMatchObject({
      leftTab: 'outline',
      rightTab: 'forms',
      leftDock: false,
      rightDock: false,
    });
  });

  it('opens a dock on a view in one change', () => {
    hideLeftDock();
    hideRightDock();
    const seen: unknown[] = [];
    coreStore.subscribe(() => seen.push(coreStore.get()));

    openRightPanel('comments');
    openLeftPanel('layers');

    expect(seen).toHaveLength(2);
    expect(coreStore.get()).toMatchObject({
      rightDock: true,
      rightTab: 'comments',
      leftDock: true,
      leftTab: 'layers',
    });
  });

  it('closes the dock on a second press of the panel it shows, and switches to it otherwise', () => {
    openRightPanel('tools');
    toggleRightPanel('tools');
    expect(coreStore.get().rightDock).toBe(false);
    toggleRightPanel('tools');
    expect(coreStore.get()).toMatchObject({ rightDock: true, rightTab: 'tools' });
    toggleRightPanel('history');
    expect(coreStore.get()).toMatchObject({ rightDock: true, rightTab: 'history' });
  });

  it('closes both docks when the screen narrows and leaves them alone when it widens', () => {
    compactViewportChanged(true);
    expect(coreStore.get()).toMatchObject({ compactViewport: true, leftDock: false, rightDock: false });
    showLeftDock();
    compactViewportChanged(false);
    expect(coreStore.get()).toMatchObject({ compactViewport: false, leftDock: true, rightDock: false });
  });
});

describe('the interface mode', () => {
  it('applies the choice now and remembers it for the next visit', () => {
    setInterfaceMode('advanced');
    expect(coreStore.get().mode).toBe('advanced');
    expect(readStoredMode()).toBe('advanced');
    setInterfaceMode('simple');
    expect(readStoredMode()).toBe('simple');
  });
});

describe('useCore', () => {
  it('renders the selected part and follows it, ignoring changes elsewhere', () => {
    const renders: boolean[] = [];
    function Busy() {
      const busy = useCore((state) => state.busy);
      renders.push(busy);
      return <output>{String(busy)}</output>;
    }
    render(<Busy />);

    act(() => showNotice('unrelated'));
    expect(renders).toEqual([false]);

    act(() => setBusy(true));
    expect(screen.getByRole('status').textContent).toBe('true');
    expect(renders).toEqual([false, true]);
  });
});
