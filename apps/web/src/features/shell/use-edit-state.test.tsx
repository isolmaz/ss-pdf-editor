// @vitest-environment happy-dom
/** What the shell derives from the session: the active tab, the tier's verdict and whether editing is allowed. */

import { act, renderHook } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { type JsonValue, SessionStore, type SessionTab, workingBytesKey } from 'pdf-model';
import type { ViewerApi } from 'pdf-ui/viewer';
import { beforeEach, describe, expect, it } from 'vitest';
import { coreStore, initialCoreState, setBusy } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { factsRead, factsStore } from '../facts/facts-store';
import { formInventoryKey, formInventoryRead, formsStore, initialFormsState } from '../forms/forms-store';
import { hideStartScreen, initialOpenState, openStore, showStartScreen } from '../open/open-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { useEditState } from './use-edit-state';

let session: SessionStore;
const handle = { id: 'handle' } as unknown as PdfDocumentHandle;

beforeEach(() => {
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  formsStore.set(initialFormsState());
  factsStore.set({ facts: null, failure: null });
  session = new SessionStore();
});

function openTab(pageCount = 1) {
  const tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount });
  adoptHandle(tab.id, handle);
  hideStartScreen();
  return tab;
}

describe('useEditState', () => {
  it('is the home state with no document', () => {
    const { result } = renderHook(() => useEditState(session, 'desktop'));
    expect(result.current).toMatchObject({
      activeTab: null,
      activeId: null,
      activeHandle: null,
      pageCount: 0,
      canEdit: false,
      canPrepareWrite: false,
      locked: false,
      isHome: true,
    });
    expect(result.current.verdict.kind).not.toBe('viewing-only');
  });

  it('shows the editor once the document has an engine handle, and allows editing once the viewer shows it', () => {
    const tab = openTab(3);
    const { result } = renderHook(() => useEditState(session, 'desktop'));
    expect(result.current).toMatchObject({ pageCount: 3, isHome: false, canEdit: false });
    act(() => viewerChanged({ document: handle } as unknown as ViewerApi));
    expect(result.current.canEdit).toBe(true);
    act(() => setBusy(true));
    expect(result.current.canEdit).toBe(false);
    act(() => setBusy(false));
    expect(result.current.activeId).toBe(tab.id);
    dropHandle(tab.id);
  });

  it('shows the home screen when the start screen is asked for', () => {
    openTab();
    const { result } = renderHook(() => useEditState(session, 'desktop'));
    expect(result.current.isHome).toBe(false);
    act(() => showStartScreen());
    expect(result.current.isHome).toBe(true);
    act(() => hideStartScreen());
    expect(result.current.isHome).toBe(false);
  });

  it('refuses editing on a protected tab', () => {
    const tab = openTab();
    act(() => viewerChanged({ document: handle } as unknown as ViewerApi));
    const { result } = renderHook(() => useEditState(session, 'desktop'));
    expect(result.current.locked).toBe(false);
    act(() => openStore.set({ lockedTabs: new Map([[tab.id, true]] as never) }));
    expect(result.current.locked).toBe(true);
    expect(result.current.canEdit).toBe(false);
  });

  it('allows a write to be prepared only once the facts and the form inventory are read', () => {
    const tab = openTab();
    const { result } = renderHook(() => useEditState(session, 'desktop'));
    expect(result.current.canPrepareWrite).toBe(false);
    act(() => {
      factsRead({
        tabId: tab.id,
        bytesKey: workingBytesKey(tab),
        fonts: [],
        attachments: [],
        signatures: [],
        security: { encrypted: false, permissions: [] },
      });
    });
    expect(result.current.canPrepareWrite).toBe(false);
    act(() => {
      formInventoryRead({ tabId: tab.id, key: formInventoryKey(tab), fields: [] } as never);
    });
    expect(result.current.canPrepareWrite).toBe(true);
    act(() => setBusy(true));
    expect(result.current.canPrepareWrite).toBe(false);
  });

  it('keeps a write preparable through a mark step, and closes it for new bytes or a typed value until they are read', () => {
    const tab = openTab();
    const { result } = renderHook(() => useEditState(session, 'desktop'));
    const readFor = (current: SessionTab) =>
      act(() => {
        factsRead({
          tabId: current.id,
          bytesKey: workingBytesKey(current),
          fonts: [],
          attachments: [],
          signatures: [],
          security: { encrypted: false, permissions: [] },
        });
        formInventoryRead({ tabId: current.id, key: formInventoryKey(current), fields: [] } as never);
      });
    const shown = () => result.current.activeTab as SessionTab;
    const mark = (annotations: readonly object[]) =>
      act(() => {
        session.setOverlays(
          tab.id,
          { annotations, measures: [], redactions: [] } as unknown as JsonValue,
          'ann.transform',
        );
      });
    readFor(tab);
    expect(result.current.canPrepareWrite).toBe(true);

    // A mark step mints a new working id over the same bytes: nothing is read again, and Save stays open.
    mark([{ id: 'm1' }]);
    expect(shown().working.id).not.toBe(tab.working.id);
    expect(result.current.canPrepareWrite).toBe(true);
    mark([]);
    expect(result.current.canPrepareWrite).toBe(true);
    act(() => {
      session.undo(tab.id);
    });
    expect(result.current.canPrepareWrite).toBe(true);

    // A value typed into a form field is not in the bytes: the inventory is read again, with it.
    const typed = { engineValues: { entries: [{ key: 'field', value: { value: 'Acme' } }], dropped: 0 } };
    act(() => session.setOverlays(tab.id, typed as never, 'ann.engineEdit'));
    expect(result.current.canPrepareWrite).toBe(false);
    readFor(shown());
    expect(result.current.canPrepareWrite).toBe(true);

    // New bytes: the facts and the inventory are read again.
    act(() => {
      session.applyOperation({
        tabId: tab.id,
        bytes: new Uint8Array([2]),
        pageCount: 1,
        labelKey: 'form.note.filled',
        engine: 'mupdf',
        steps: [],
        overlays: null,
      });
    });
    expect(result.current.canPrepareWrite).toBe(false);
    readFor(shown());
    expect(result.current.canPrepareWrite).toBe(true);
  });
});
