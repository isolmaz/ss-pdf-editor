// @vitest-environment happy-dom
/**
 * Drawn redaction marks: the active tab's pending overlay, one undoable step per change, and the
 * refusal that keeps an unapplied mark from leaking into Print and Snapshot.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { SessionStore } from 'pdf-model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingOverlays } from '../../operations';
import { coreStore, initialCoreState } from '../core/core-store';
import { redactionMark, t } from './marks-fixtures';
import { refuseUnappliedRedactions, useRedactionMarks, writeRedactions } from './redaction';

function openSession(): SessionStore {
  const session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 1 });
  return session;
}

beforeEach(() => coreStore.set(initialCoreState()));
afterEach(cleanup);

describe('writeRedactions', () => {
  it('stores the new list on the active tab as one journal step', () => {
    const session = openSession();
    writeRedactions(session, [redactionMark('a')]);
    expect(pendingOverlays(session.active).redactions.map((item) => item.id)).toEqual(['a']);
    expect(session.active?.journal.entries.map((entry) => entry.labelKey)).toEqual(['panel.redaction']);
  });

  it('takes a function of the current list', () => {
    const session = openSession();
    writeRedactions(session, [redactionMark('a')]);
    writeRedactions(session, (current) => [...current, redactionMark('b')]);
    expect(pendingOverlays(session.active).redactions.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('does nothing without a tab', () => {
    const session = new SessionStore();
    writeRedactions(session, [redactionMark('a')]);
    expect(pendingOverlays(session.active).redactions).toEqual([]);
  });
});

describe('useRedactionMarks', () => {
  it('shows the active tab`s marks and renders again when one is added', () => {
    const session = openSession();
    const { result } = renderHook(() => useRedactionMarks(session));
    expect(result.current.redactionMarks).toEqual([]);
    act(() => result.current.setRedactionMarks([redactionMark('a')]));
    expect(result.current.redactionMarks.map((item) => item.id)).toEqual(['a']);
  });

  it('hands out a setter that stays the same while the session does', () => {
    const session = openSession();
    const { result, rerender } = renderHook(() => useRedactionMarks(session));
    const first = result.current.setRedactionMarks;
    rerender();
    expect(result.current.setRedactionMarks).toBe(first);
  });
});

describe('refuseUnappliedRedactions', () => {
  it('lets the action through when no mark is waiting', () => {
    expect(refuseUnappliedRedactions(openSession(), t)).toBe(false);
    expect(coreStore.get().notice).toBeNull();
  });

  it('refuses with the same notice as Save while a mark is unapplied', () => {
    const session = openSession();
    writeRedactions(session, [redactionMark('a')]);
    expect(refuseUnappliedRedactions(session, t)).toBe(true);
    expect(coreStore.get().notice).toBe(
      `${t('error.pending-redactions.message')} ${t('error.pending-redactions.hint')}`,
    );
  });
});
