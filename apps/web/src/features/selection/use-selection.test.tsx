// @vitest-environment happy-dom
/**
 * The selection as the shell uses it: the handlers bound to its host, and the effects that
 * clear, settle and prune the selection as the document, the mode and the inventory change.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { ExistingAnnotation } from 'pdf-core';
import { SessionStore } from 'pdf-model';
import type { MarkTarget } from 'pdf-ui/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationsStore, initialAnnotationsState } from '../annotations/annotations-store';
import { coreStore, initialCoreState } from '../core/core-store';
import { existingTarget, fileAnnotation, redactionTarget } from '../marks/marks-fixtures';
import type { SelectionHost } from './selection-actions';
import {
  initialSelectionState,
  selectAfterWrite,
  selectedMarkKeys,
  selectionStore,
  selectMarks,
} from './selection-store';
import { useSelectionActions, useSelectionEffects } from './use-selection';

beforeEach(() => {
  coreStore.set(initialCoreState());
  annotationsStore.set(initialAnnotationsState());
  selectionStore.set(initialSelectionState());
});
afterEach(cleanup);

describe('useSelectionActions', () => {
  function host(): SelectionHost {
    const session = new SessionStore();
    session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 1 });
    return {
      session,
      cancel: { current: null },
      refuseBusy: vi.fn(),
      settleNativeEditors: vi.fn(() => false),
      sweepOrphanAnnotations: vi.fn(async () => undefined),
      removeTargets: vi.fn(() => true),
    };
  }

  it('deletes through the host the shell gave it', () => {
    const bound = host();
    const view = renderHook(() => useSelectionActions(bound));
    expect(view.result.current.deleteMarkSelection()).toBe(false);
    selectMarks(['a']);
    expect(view.result.current.deleteMarkSelection()).toBe(true);
    expect(bound.removeTargets).toHaveBeenCalledExactlyOnceWith(['a']);
  });

  it('answers Select all for the host`s session, and opens a note', () => {
    const bound = host();
    const view = renderHook(() => useSelectionActions(bound));
    expect(view.result.current.selectAllMarks()).toBe(false);
    view.result.current.openNote({ id: 'n', pageIndex: 0 } as Parameters<
      typeof view.result.current.openNote
    >[0]);
    expect(selectedMarkKeys()).toHaveLength(1);
  });

  it('keeps the same handlers until what they run on changes, then follows the new host', () => {
    const first = host();
    const view = renderHook(({ current }) => useSelectionActions(current), {
      initialProps: { current: first },
    });
    const handlers = view.result.current;
    view.rerender({ current: first });
    expect(view.result.current).toBe(handlers);

    const next = host();
    view.rerender({ current: next });
    expect(view.result.current).not.toBe(handlers);
    selectMarks(['a']);
    view.result.current.deleteMarkSelection();
    expect(next.removeTargets).toHaveBeenCalledWith(['a']);
    expect(first.removeTargets).not.toHaveBeenCalled();
  });
});

describe('useSelectionEffects', () => {
  const live = [redactionTarget('r1'), existingTarget('e1')];
  const read: readonly ExistingAnnotation[] = [fileAnnotation('e1')];

  interface Props {
    markMode: 'select' | null;
    tabId: string | undefined;
    existing: readonly ExistingAnnotation[] | null;
    targets: readonly MarkTarget[];
  }
  const initial: Props = { markMode: 'select', tabId: 'tab-1', existing: read, targets: live };
  const mount = (props: Props = initial) =>
    renderHook((current: Props) => useSelectionEffects(current), { initialProps: props });

  it('selects a mark a write added once the inventory lists it, and only then', () => {
    const view = mount({ ...initial, targets: [] });
    act(() => selectAfterWrite(live[1]?.key as string));
    expect(selectedMarkKeys()).toEqual([]);
    view.rerender({ ...initial, targets: [live[0] as MarkTarget] });
    expect(selectedMarkKeys()).toEqual([]);
    view.rerender({ ...initial, targets: live });
    expect(selectedMarkKeys()).toEqual([live[1]?.key]);
  });

  it('clears the selection when the common layer`s mode is left, not when it is entered', () => {
    const view = mount({ ...initial, markMode: null });
    act(() => selectMarks(['a']));
    view.rerender({ ...initial, markMode: 'select' });
    expect(selectedMarkKeys()).toEqual(['a']);
    view.rerender({ ...initial, markMode: null });
    expect(selectedMarkKeys()).toEqual([]);
  });

  it('clears the selection when another document becomes the active one, and not without one', () => {
    const view = mount({ ...initial, tabId: undefined });
    act(() => selectMarks([live[0]?.key as string]));
    view.rerender({ ...initial, tabId: undefined });
    expect(selectedMarkKeys()).toEqual([live[0]?.key]);
    view.rerender({ ...initial, tabId: 'tab-2' });
    expect(selectedMarkKeys()).toEqual([]);
  });

  it('prunes the selection to the marks still listed once the inventory is read', () => {
    const view = mount();
    act(() => selectMarks([live[0]?.key as string, live[1]?.key as string]));
    view.rerender({ ...initial, targets: [live[1] as MarkTarget] });
    expect(selectedMarkKeys()).toEqual([live[1]?.key]);
  });

  it('keeps the selection while a byte rewrite has left the inventory unread', () => {
    const view = mount();
    act(() => selectMarks([live[0]?.key as string]));
    view.rerender({ ...initial, existing: null, targets: [] });
    expect(selectedMarkKeys()).toEqual([live[0]?.key]);
  });
});
