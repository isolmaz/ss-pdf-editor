// @vitest-environment happy-dom
/**
 * The marks a tab can edit: its pending overlay without the marks the file already carries, read
 * at call time by a handler and by a component that renders again when the inventory arrives.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { SessionStore, type SessionTab } from 'pdf-model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingOverlays } from '../../operations';
import { existingInventoryRead, formsStore, initialFormsState } from '../forms/forms-store';
import { annotationMark, fileAnnotation, redactionMark, writeMarks } from './marks-fixtures';
import { editableOverlays, useVisibleMarks } from './overlays';

function drawnTab(): SessionTab {
  const session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 1 });
  const tab = session.active as SessionTab;
  writeMarks(session, tab.id, {
    annotations: [annotationMark('written'), annotationMark('pending')],
    measures: [],
    redactions: [redactionMark('r')],
  });
  return session.active as SessionTab;
}

const ids = (tab: SessionTab) => pendingOverlays(tab).annotations.map((mark) => mark.id);

beforeEach(() => formsStore.set(initialFormsState()));
afterEach(cleanup);

describe('editableOverlays', () => {
  it('is the stored overlay itself while the file`s annotations are unread', () => {
    const tab = drawnTab();
    expect(editableOverlays(tab)).toBe(pendingOverlays(tab));
  });

  it('is the stored overlay when the inventory describes another tab', () => {
    const tab = drawnTab();
    existingInventoryRead({
      tabId: 'other',
      bytesKey: 'source',
      annotations: [fileAnnotation('p', 'written')],
    });
    expect(editableOverlays(tab)).toBe(pendingOverlays(tab));
  });

  it('is the stored overlay when the file carries none of the session`s marks', () => {
    const tab = drawnTab();
    existingInventoryRead({ tabId: tab.id, bytesKey: 'source', annotations: [fileAnnotation('p')] });
    expect(editableOverlays(tab)).toBe(pendingOverlays(tab));
  });

  it('drops the session marks the file already carries and keeps the rest', () => {
    const tab = drawnTab();
    existingInventoryRead({
      tabId: tab.id,
      bytesKey: 'source',
      annotations: [fileAnnotation('p', 'written')],
    });
    const editable = editableOverlays(tab);
    expect(editable.annotations.map((mark) => mark.id)).toEqual(['pending']);
    expect(editable.redactions).toBe(pendingOverlays(tab).redactions);
  });
});

describe('useVisibleMarks', () => {
  it('shows nothing without a tab', () => {
    const { result } = renderHook(() => useVisibleMarks(null));
    expect(result.current).toEqual({ annotations: [], measures: [], redactions: [] });
  });

  it('renders again with the marks the file does not carry once its inventory arrives', () => {
    const tab = drawnTab();
    const { result } = renderHook(() => useVisibleMarks(tab));
    expect(result.current.annotations.map((mark) => mark.id)).toEqual(['written', 'pending']);
    act(() =>
      existingInventoryRead({
        tabId: tab.id,
        bytesKey: 'source',
        annotations: [fileAnnotation('p', 'written')],
      }),
    );
    expect(result.current.annotations.map((mark) => mark.id)).toEqual(['pending']);
    expect(ids(tab)).toEqual(['written', 'pending']);
  });
});
