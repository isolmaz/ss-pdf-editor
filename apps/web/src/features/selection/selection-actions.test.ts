/**
 * What Delete, Select all and a new note do with the selection: which gate refuses, which
 * handler is called with which keys, and what the user is left with.
 */

import { SessionStore } from 'pdf-model';
import { markTargetKey } from 'pdf-ui/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationsStore, initialAnnotationsState } from '../annotations/annotations-store';
import { coreStore, initialCoreState, isBusy, selectTool, setBusy } from '../core/core-store';
import { annotationMark, existingTarget, fileAnnotation, redactionTarget } from '../marks/marks-fixtures';
import { initialMarksState, marksStore } from '../marks/marks-store';
import { deleteMarkSelection, openNote, type SelectionHost, selectAllMarks } from './selection-actions';
import { initialSelectionState, selectedMarkKeys, selectionStore, selectMarks } from './selection-store';

function openSession(): SessionStore {
  const session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 1 });
  return session;
}

function hostFor(session: SessionStore, overrides: Partial<SelectionHost> = {}) {
  const base = {
    session,
    cancel: { current: null } as SelectionHost['cancel'],
    refuseBusy: vi.fn(),
    settleNativeEditors: vi.fn(() => false),
    sweepOrphanAnnotations: vi.fn(async () => undefined),
    removeTargets: vi.fn(() => true),
  };
  return { ...base, ...overrides } as typeof base;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  annotationsStore.set(initialAnnotationsState());
  marksStore.set(initialMarksState());
  selectionStore.set(initialSelectionState());
});

describe('deleteMarkSelection', () => {
  it('is not the shell`s to answer while nothing is selected', () => {
    const host = hostFor(openSession());
    expect(deleteMarkSelection(host)).toBe(false);
    expect(host.removeTargets).not.toHaveBeenCalled();
    expect(host.refuseBusy).not.toHaveBeenCalled();
  });

  it('removes the whole selection in one call and returns what the removal answered', () => {
    const host = hostFor(openSession());
    selectMarks(['a', 'b']);
    expect(deleteMarkSelection(host)).toBe(true);
    expect(host.removeTargets).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
    host.removeTargets.mockReturnValueOnce(false);
    expect(deleteMarkSelection(host)).toBe(false);
  });

  it('says the document is busy, and removes nothing, while an operation holds it', () => {
    const host = hostFor(openSession());
    selectMarks(['a']);
    setBusy(true);
    expect(deleteMarkSelection(host)).toBe(false);
    setBusy(false);
    const held = hostFor(openSession(), { cancel: { current: new AbortController() } });
    expect(deleteMarkSelection(held)).toBe(false);
    expect(host.refuseBusy).toHaveBeenCalledTimes(1);
    expect(held.refuseBusy).toHaveBeenCalledTimes(1);
    expect(host.removeTargets).not.toHaveBeenCalled();
    expect(held.removeTargets).not.toHaveBeenCalled();
    expect(isBusy()).toBe(false);
  });

  it('does not refuse while the orphan sweep is the operation in flight', () => {
    const host = hostFor(openSession());
    selectMarks(['a']);
    setBusy(true);
    annotationsStore.set({ sweep: new Promise<void>(() => undefined) });
    expect(deleteMarkSelection(host)).toBe(true);
    expect(host.refuseBusy).not.toHaveBeenCalled();
    expect(host.removeTargets).toHaveBeenCalledWith(['a']);
  });

  it('adopts the engine`s leftover records before removing, only when there are some', () => {
    const quiet = hostFor(openSession());
    selectMarks(['a']);
    deleteMarkSelection(quiet);
    expect(quiet.settleNativeEditors).toHaveBeenCalledTimes(1);
    expect(quiet.sweepOrphanAnnotations).not.toHaveBeenCalled();

    const leftovers = hostFor(openSession(), { settleNativeEditors: vi.fn(() => true) });
    deleteMarkSelection(leftovers);
    expect(leftovers.sweepOrphanAnnotations).toHaveBeenCalledTimes(1);
    expect(leftovers.removeTargets).toHaveBeenCalledWith(['a']);
  });
});

describe('selectAllMarks', () => {
  const targets = () => [redactionTarget('r1'), existingTarget('e1')];

  beforeEach(() => {
    marksStore.set({ targets: targets() });
    annotationsStore.set({ existing: [fileAnnotation('e1')] });
  });

  it('selects every mark the page shows, in the select tool with a read inventory', () => {
    expect(selectAllMarks(openSession())).toBe(true);
    expect(selectedMarkKeys()).toEqual(targets().map((target) => target.key));
  });

  it('declines under any other tool, so the key stays the engine`s or the page text`s', () => {
    selectTool('highlight');
    expect(selectAllMarks(openSession())).toBe(false);
    expect(selectedMarkKeys()).toEqual([]);
  });

  it('declines without a document, while the file`s annotations are unread, or with no marks', () => {
    expect(selectAllMarks(new SessionStore())).toBe(false);
    annotationsStore.set({ existing: null });
    expect(selectAllMarks(openSession())).toBe(false);
    annotationsStore.set({ existing: [] });
    marksStore.set({ targets: [] });
    expect(selectAllMarks(openSession())).toBe(false);
    expect(selectedMarkKeys()).toEqual([]);
  });
});

describe('openNote', () => {
  it('returns to select, selects just that note, and shows the comments dock', () => {
    selectTool('note');
    selectMarks(['old']);
    const note = { ...annotationMark('n1'), pageIndex: 3 };
    openNote(note);
    expect(coreStore.get().canvasTool).toBe('select');
    expect(selectedMarkKeys()).toEqual([markTargetKey('annotation', 'n1', 3)]);
    expect(coreStore.get().rightDock).toBe(true);
    expect(coreStore.get().rightTab).toBe('comments');
  });
});
