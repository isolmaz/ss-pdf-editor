// @vitest-environment happy-dom
/**
 * The close-document question follows the save store: it is on screen exactly while the store
 * holds a close request (and no signature prompt is open), and what the user answers reaches the
 * shell as the exact calls it wired. The dialog's own markup is pdf-ui's (and tested there); here
 * it is a stand-in that exposes the props the shell wires.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { signaturePrompt } from '../facts/signature-prompt';
import { CloseDocumentHost } from './SaveSurfaces';
import { closeRequested, initialSaveState, saveStore } from './save-store';

vi.mock('pdf-ui/dialog', async () => {
  const { createElement } = await import('react');
  return {
    CloseDocumentDialog: (props: {
      name: string;
      canSave: boolean;
      busy: boolean;
      notice: string | null;
      onCancel: () => void;
      onDiscard: () => void;
      onExport: () => void;
      onSave: () => void;
    }) =>
      createElement(
        'section',
        { 'aria-label': 'close dialog', 'data-name': props.name, 'data-can-save': String(props.canSave) },
        createElement('p', null, `busy ${props.busy} notice ${props.notice}`),
        createElement('button', { type: 'button', onClick: props.onCancel }, 'cancel'),
        createElement('button', { type: 'button', onClick: props.onDiscard }, 'discard'),
        createElement('button', { type: 'button', onClick: props.onExport }, 'export'),
        createElement('button', { type: 'button', onClick: props.onSave }, 'save'),
      ),
  };
});

const t = createTranslator('en');

// The dialog is a dynamic chunk (mocked here): resolve it once up front so no test races the first import.
beforeAll(async () => {
  await import('pdf-ui/dialog');
}, 120_000);

let session: SessionStore;
let tab: SessionTab;
let cancelRef: { current: AbortController | null };
let discardTab: Mock<(id: string) => void>;
let saveActive: Mock<(id: string) => Promise<boolean>>;
let exportActive: Mock<(id: string) => Promise<void>>;

function host() {
  return render(
    <CloseDocumentHost
      t={t}
      session={session}
      cancelRef={cancelRef}
      discardTab={discardTab}
      saveActive={saveActive}
      exportActive={exportActive}
    />,
  );
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  signaturePrompt.set({ warning: null });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
  session = new SessionStore();
  tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
  cancelRef = { current: null };
  discardTab = vi.fn();
  saveActive = vi.fn(async () => true);
  exportActive = vi.fn(async () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CloseDocumentHost', () => {
  it('shows nothing while no close question is asked', () => {
    const view = host();
    expect(view.container.innerHTML).toBe('');
  });

  it('asks about the tab it was opened for, with what the dialog needs to word it', async () => {
    host();
    act(() => closeRequested(tab.id, null));
    const dialog = await screen.findByLabelText('close dialog');
    expect(dialog.getAttribute('data-name')).toBe('a.pdf');
    // A document without a file of its own can only be exported.
    expect(dialog.getAttribute('data-can-save')).toBe('false');
    expect(screen.getByText('busy false notice null')).toBeTruthy();

    act(() => coreStore.set({ busy: true, notice: 'Working' }));
    expect(screen.getByText('busy true notice Working')).toBeTruthy();
  });

  it('offers Save to a document that has a file of its own', async () => {
    cleanup();
    session = new SessionStore();
    tab = session.openDocument({
      name: 'b.pdf',
      bytes: new Uint8Array([1]),
      sha256: 'b',
      pageCount: 1,
      handle: {} as FileSystemFileHandle,
    });
    host();
    act(() => closeRequested(tab.id, null));
    expect((await screen.findByLabelText('close dialog')).getAttribute('data-can-save')).toBe('true');
  });

  it('names nothing when the tab behind the question is gone', async () => {
    host();
    act(() => closeRequested('gone', null));
    const dialog = await screen.findByLabelText('close dialog');
    expect(dialog.getAttribute('data-name')).toBe('');
    expect(dialog.getAttribute('data-can-save')).toBe('false');
  });

  it('waits while a signature prompt is open, and returns when it is answered', async () => {
    host();
    act(() => closeRequested(tab.id, null));
    await screen.findByLabelText('close dialog');
    act(() => signaturePrompt.set({ warning: { breaks: true, signer: null, fieldName: 'Sig1' } }));
    expect(screen.queryByLabelText('close dialog')).toBeNull();
    act(() => signaturePrompt.set({ warning: null }));
    expect(await screen.findByLabelText('close dialog')).toBeTruthy();
  });

  it('keeps the document open on Cancel, stopping what is running', async () => {
    const controller = new AbortController();
    cancelRef.current = controller;
    host();
    act(() => closeRequested(tab.id, null));
    await userEvent.click(await screen.findByRole('button', { name: 'cancel' }));
    expect(controller.signal.aborted).toBe(true);
    expect(saveStore.get().closeRequest).toBeNull();
    expect(screen.queryByLabelText('close dialog')).toBeNull();
    expect(discardTab).not.toHaveBeenCalled();
  });

  it('closes the document on Discard', async () => {
    host();
    act(() => closeRequested(tab.id, null));
    await userEvent.click(await screen.findByRole('button', { name: 'discard' }));
    expect(discardTab).toHaveBeenCalledWith(tab.id);
    expect(saveStore.get().closeRequest).toBeNull();
  });

  it('exports the tab on Export, leaving the question open', async () => {
    host();
    act(() => closeRequested(tab.id, null));
    await userEvent.click(await screen.findByRole('button', { name: 'export' }));
    expect(exportActive).toHaveBeenCalledWith(tab.id);
    expect(saveStore.get().closeRequest).toBe(tab.id);
  });

  it('saves on Save, and closes the document once the save left it clean', async () => {
    host();
    act(() => closeRequested(tab.id, null));
    await userEvent.click(await screen.findByRole('button', { name: 'save' }));
    expect(saveActive).toHaveBeenCalledWith(tab.id);
    await vi.waitFor(() => expect(discardTab).toHaveBeenCalledWith(tab.id));
    expect(saveStore.get().closeRequest).toBeNull();
  });

  it('keeps the document open when the save did not happen', async () => {
    saveActive.mockResolvedValue(false);
    host();
    act(() => closeRequested(tab.id, null));
    await userEvent.click(await screen.findByRole('button', { name: 'save' }));
    await vi.waitFor(() => expect(saveActive).toHaveBeenCalled());
    expect(discardTab).not.toHaveBeenCalled();
    expect(saveStore.get().closeRequest).toBe(tab.id);
  });
});
