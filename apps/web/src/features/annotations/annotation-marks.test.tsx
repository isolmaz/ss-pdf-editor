// @vitest-environment happy-dom
/**
 * The marks of the active tab are its pending overlay: a change is one undoable journal step named
 * for what changed, and a reader re-renders when the session changes.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { AnnotationMark } from 'pdf-core';
import { SessionStore } from 'pdf-model';
import { afterEach, describe, expect, it } from 'vitest';
import { annotationStepLabel } from '../../annotation-interaction';
import { pendingOverlays } from '../../operations';
import { useAnnotationMarks, writeAnnotations } from './annotation-marks';

const mark = (id: string): AnnotationMark => ({
  id,
  kind: 'note',
  pageIndex: 0,
  quads: [],
  color: '#ffcc00',
  opacity: 1,
  contents: '',
  author: 'Ada',
  createdAt: '2026-01-01T00:00:00.000Z',
});

function openSession(): SessionStore {
  const session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 1 });
  return session;
}

afterEach(cleanup);

describe('writeAnnotations', () => {
  it('stores the new list on the active tab as one journal step', () => {
    const session = openSession();
    writeAnnotations(session, [mark('a')]);
    expect(pendingOverlays(session.active).annotations.map((m) => m.id)).toEqual(['a']);
    expect(session.active?.journal.entries.map((entry) => entry.labelKey)).toEqual([
      annotationStepLabel([], [mark('a')]),
    ]);
  });

  it('takes a function of the current list', () => {
    const session = openSession();
    writeAnnotations(session, [mark('a')]);
    writeAnnotations(session, (current) => [...current, mark('b')]);
    expect(pendingOverlays(session.active).annotations.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('does nothing without a tab', () => {
    const session = new SessionStore();
    writeAnnotations(session, [mark('a')]);
    expect(pendingOverlays(session.active).annotations).toEqual([]);
  });
});

describe('useAnnotationMarks', () => {
  it('shows the active tab`s marks and re-renders when one is added', () => {
    const session = openSession();
    const { result } = renderHook(() => useAnnotationMarks(session));
    expect(result.current.annotations).toEqual([]);
    act(() => result.current.setAnnotations([mark('a')]));
    expect(result.current.annotations.map((m) => m.id)).toEqual(['a']);
  });

  it('keeps the same writer for the same session', () => {
    const session = openSession();
    const { result, rerender } = renderHook(() => useAnnotationMarks(session));
    const writer = result.current.setAnnotations;
    rerender();
    expect(result.current.setAnnotations).toBe(writer);
  });
});
