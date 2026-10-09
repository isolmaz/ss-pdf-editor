// @vitest-environment happy-dom
/**
 * A dialog belongs to the version it froze: when the tab it came from is switched away,
 * closed or changed under it, the dialog is dismissed and the shell is told to drop the rest.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { SessionStore, type SessionTab } from 'pdf-model';
import type { OperationDialogSpec } from 'pdf-ui/ui';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dialogsStore, initialDialogsState, operationDialogOpened } from './dialogs-store';
import { useStaleDialogDismissal } from './use-dialog-dismissal';

const spec = { id: 'compress' } as unknown as OperationDialogSpec;
const onDismissed = vi.fn();

let session: SessionStore;
let first: SessionTab;

function openOn(tab: SessionTab, workingId = tab.working.id) {
  operationDialogOpened(
    { tabId: tab.id, workingId, name: tab.name, pageCount: 1, bytes: new Uint8Array([1]) },
    spec,
  );
}

function mount() {
  return renderHook(() => {
    useStaleDialogDismissal(useSyncExternalStore(session.subscribe, session.getSnapshot), onDismissed);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dialogsStore.set(initialDialogsState());
  session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
  first = session.active as SessionTab;
});
afterEach(cleanup);

describe('useStaleDialogDismissal', () => {
  it('leaves the dialog alone while it still belongs to the active version', () => {
    mount();
    act(() => openOn(first));
    expect(dialogsStore.get().dialogSpec).toBe(spec);
    expect(onDismissed).not.toHaveBeenCalled();
  });

  it('does nothing when no dialog is open', () => {
    mount();
    act(() => {
      session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([2]), sha256: 'b', pageCount: 1 });
    });
    expect(onDismissed).not.toHaveBeenCalled();
  });

  it('dismisses the dialog when the user switches to another tab', () => {
    mount();
    act(() => openOn(first));
    act(() => {
      session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([2]), sha256: 'b', pageCount: 1 });
    });
    expect(dialogsStore.get()).toMatchObject({ dialogSpec: null, dialogInput: null });
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it('dismisses the dialog when its tab is closed', () => {
    mount();
    act(() => openOn(first));
    act(() => {
      session.closeTab(first.id);
    });
    expect(dialogsStore.get().dialogSpec).toBeNull();
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it('dismisses a dialog frozen from a working version the tab has since left', () => {
    mount();
    act(() => openOn(first, 'an-older-version'));
    expect(dialogsStore.get().dialogSpec).toBeNull();
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });
});
