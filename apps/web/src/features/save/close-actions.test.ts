// @vitest-environment happy-dom
/**
 * Closing a document: what a discard releases, when the close question is asked and who gets the
 * focus back, and what each answer does.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import type { OperationDialogSpec } from 'pdf-ui/ui';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { dialogsStore, initialDialogsState } from '../dialogs/dialogs-store';
import {
  type CloseHost,
  cancelClose,
  closeTab,
  discardAndClose,
  discardDocument,
  keepOpen,
  saveAndClose,
} from './close-actions';
import { initialSaveState, saveStore } from './save-store';

const mocks = vi.hoisted(() => ({
  dropHandle: vi.fn(),
  handleFor: vi.fn(),
  hasEngineEdits: vi.fn(),
  releaseEngineValues: vi.fn(),
  redactedWordsForgotten: vi.fn(),
}));
vi.mock('../core/handles', () => ({ dropHandle: mocks.dropHandle, handleFor: mocks.handleFor }));
vi.mock('../../operations', () => ({ hasEngineEdits: mocks.hasEngineEdits }));
vi.mock('../annotations/annotations-store', () => ({ releaseEngineValues: mocks.releaseEngineValues }));
vi.mock('../marks/redaction-store', () => ({ redactedWordsForgotten: mocks.redactedWordsForgotten }));

const t = ((key: string) => key) as Translator;
let session: SessionStore;
let cancelRef: { current: AbortController | null };

function open(name = 'a.pdf'): SessionTab {
  return session.openDocument({ name, bytes: new Uint8Array([1]), sha256: name, pageCount: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  dialogsStore.set(initialDialogsState());
  session = new SessionStore();
  cancelRef = { current: null };
  mocks.handleFor.mockReturnValue(undefined);
  mocks.hasEngineEdits.mockReturnValue(false);
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('discardDocument', () => {
  let forgetTabDraft: Mock<CloseHost['forgetTabDraft']>;
  let host: CloseHost;
  const flush = () => Promise.resolve().then(() => Promise.resolve());

  beforeEach(async () => {
    forgetTabDraft = vi.fn(async () => []);
    host = { session, cancelRef, translator: { current: t }, forgetTabDraft };
    const { draftWrites } = await import('../persistence/persistence-store');
    draftWrites.current = Promise.resolve();
  });

  it('drops the tab from the session and everything the shell keeps for it', async () => {
    const tab = open();
    discardDocument(host, tab.id);
    expect(session.getSnapshot().tabs).toHaveLength(0);
    expect(mocks.dropHandle).toHaveBeenCalledWith(tab.id);
    expect(mocks.releaseEngineValues).toHaveBeenCalledWith(tab.id);
    expect(mocks.redactedWordsForgotten).toHaveBeenCalledWith(tab.id);
    const { draftWrites } = await import('../persistence/persistence-store');
    await draftWrites.current;
    expect(forgetTabDraft).toHaveBeenCalledWith(tab.id);
    expect(coreStore.get().notice).toBeNull();
  });

  it('cancels the operation running for the active tab, and only that tab', () => {
    const first = open('a.pdf');
    const second = open('b.pdf');
    const controller = new AbortController();
    cancelRef.current = controller;
    discardDocument(host, first.id);
    expect(controller.signal.aborted).toBe(false);
    discardDocument(host, second.id);
    expect(controller.signal.aborted).toBe(true);
  });

  it('closes the active tab without an operation to cancel', () => {
    const tab = open();
    discardDocument(host, tab.id);
    expect(cancelRef.current).toBeNull();
  });

  it('destroys the abandoned engine handle, and reports a handle that would not shut down', async () => {
    const tab = open();
    const destroy = vi.fn(async () => undefined);
    mocks.dropHandle.mockReturnValueOnce({ destroy } as unknown as PdfDocumentHandle);
    discardDocument(host, tab.id);
    expect(destroy).toHaveBeenCalledTimes(1);
    await flush();
    expect(coreStore.get().notice).toBeNull();

    const other = open('b.pdf');
    mocks.dropHandle.mockReturnValueOnce({
      destroy: async () => {
        throw new Error('stuck');
      },
    } as unknown as PdfDocumentHandle);
    discardDocument(host, other.id);
    await flush();
    expect(coreStore.get().notice).toBe('notice.engineReleaseFailed');
  });

  it('says so when the vault inventory was incomplete and nothing was deleted', async () => {
    const tab = open();
    forgetTabDraft.mockResolvedValue(null);
    discardDocument(host, tab.id);
    const { draftWrites } = await import('../persistence/persistence-store');
    await draftWrites.current;
    expect(coreStore.get().notice).toBe('vault.incomplete');
  });

  it('says so when forgetting the draft failed', async () => {
    const tab = open();
    forgetTabDraft.mockRejectedValue(new Error('quota'));
    discardDocument(host, tab.id);
    const { draftWrites } = await import('../persistence/persistence-store');
    await draftWrites.current;
    expect(coreStore.get().notice).toBe('error.write-failed.message');
  });
});

describe('closeTab', () => {
  let refuseBusy: Mock<() => void>;
  let discardTab: Mock<(id: string) => void>;
  const host = () => ({ session, cancelRef, refuseBusy, discardTab });

  beforeEach(() => {
    refuseBusy = vi.fn();
    discardTab = vi.fn();
  });

  it.each([
    ['an operation is running', () => coreStore.set({ busy: true })],
    ['a save holds the controller', () => (cancelRef.current = new AbortController())],
    [
      'an operation dialog is open',
      () => dialogsStore.set({ dialogSpec: { id: 'compress' } as unknown as OperationDialogSpec }),
    ],
  ])('is refused while %s', (_what, arrange) => {
    const tab = open();
    arrange();
    closeTab(host(), tab.id);
    expect(refuseBusy).toHaveBeenCalledTimes(1);
    expect(discardTab).not.toHaveBeenCalled();
    expect(saveStore.get().closeRequest).toBeNull();
  });

  it('ignores a tab that is gone', () => {
    closeTab(host(), 'gone');
    expect(discardTab).not.toHaveBeenCalled();
    expect(refuseBusy).not.toHaveBeenCalled();
  });

  it('discards a tab with nothing unsaved at once', () => {
    const tab = open();
    mocks.handleFor.mockReturnValue({});
    closeTab(host(), tab.id);
    expect(discardTab).toHaveBeenCalledWith(tab.id);
    expect(saveStore.get().closeRequest).toBeNull();
  });

  it('asks first when the tab holds unsaved overlay edits, remembering what had the focus', () => {
    const first = open('a.pdf');
    const second = open('b.pdf');
    session.setOverlays(first.id, { annotations: ['edit'] }, 'ann.engineEdit');
    expect(session.active?.id).toBe(second.id);
    const button = document.body.appendChild(document.createElement('button'));
    button.focus();
    coreStore.set({ notice: 'stale' });

    closeTab(host(), first.id);

    expect(discardTab).not.toHaveBeenCalled();
    expect(session.active?.id).toBe(first.id);
    expect(coreStore.get().notice).toBeNull();
    expect(saveStore.get()).toMatchObject({ closeRequest: first.id, closeTrigger: button });
  });

  it('asks first when only the engine holds unsaved edits', () => {
    const tab = open();
    mocks.handleFor.mockReturnValue({});
    mocks.hasEngineEdits.mockReturnValue(true);
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(null);
    closeTab(host(), tab.id);
    expect(saveStore.get()).toMatchObject({ closeRequest: tab.id, closeTrigger: null });
  });
});

describe('cancelClose', () => {
  beforeEach(() => vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback()));

  it('ends the question and gives the focus back to what had it', () => {
    const trigger = document.body.appendChild(document.createElement('button'));
    saveStore.set({ closeRequest: 'tab-1', closeTrigger: trigger });
    cancelClose();
    expect(saveStore.get().closeRequest).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('focuses the open document tab when what had the focus is gone', () => {
    const gone = document.createElement('button');
    const tabButton = document.body.appendChild(document.createElement('button'));
    tabButton.setAttribute('data-document-tab', '');
    tabButton.setAttribute('aria-current', 'true');
    saveStore.set({ closeTrigger: gone });
    cancelClose();
    expect(document.activeElement).toBe(tabButton);
  });

  it('falls back to the first button of the main region, and to nothing when there is none', () => {
    saveStore.set({ closeTrigger: null });
    const main = document.body.appendChild(document.createElement('main'));
    const button = main.appendChild(document.createElement('button'));
    cancelClose();
    expect(document.activeElement).toBe(button);
    document.body.innerHTML = '';
    expect(() => cancelClose()).not.toThrow();
  });
});

describe('the answers to the close question', () => {
  let discardTab: Mock<(id: string) => void>;
  let saveActive: Mock<(id: string) => Promise<boolean>>;
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
    discardTab = vi.fn();
    saveActive = vi.fn();
    saveStore.set({ closeRequest: 'tab-1' });
  });

  it('Cancel stops what is running and keeps the document open', () => {
    const controller = new AbortController();
    cancelRef.current = controller;
    keepOpen({ cancelRef });
    expect(controller.signal.aborted).toBe(true);
    expect(saveStore.get().closeRequest).toBeNull();
    expect(() => {
      cancelRef.current = null;
      keepOpen({ cancelRef });
    }).not.toThrow();
  });

  it('Discard closes the document, unless an operation is running', () => {
    coreStore.set({ busy: true });
    discardAndClose({ discardTab }, 'tab-1');
    expect(discardTab).not.toHaveBeenCalled();
    expect(saveStore.get().closeRequest).toBe('tab-1');
    coreStore.set({ busy: false });
    discardAndClose({ discardTab }, 'tab-1');
    expect(discardTab).toHaveBeenCalledWith('tab-1');
    expect(saveStore.get().closeRequest).toBeNull();
  });

  describe('Save and close', () => {
    const host = () => ({ session, cancelRef, discardTab, saveActive });

    it('closes the document once the save left it clean', async () => {
      const tab = open();
      saveStore.set({ closeRequest: tab.id });
      saveActive.mockResolvedValue(true);
      await saveAndClose(host(), tab.id);
      expect(saveActive).toHaveBeenCalledWith(tab.id);
      expect(discardTab).toHaveBeenCalledWith(tab.id);
      expect(saveStore.get().closeRequest).toBeNull();
    });

    it('keeps the document open when the save did not happen', async () => {
      const tab = open();
      saveActive.mockResolvedValue(false);
      await saveAndClose(host(), tab.id);
      expect(discardTab).not.toHaveBeenCalled();
    });

    it('keeps the document open when it was edited again while the save ran', async () => {
      const tab = open();
      saveActive.mockImplementation(async () => {
        session.setOverlays(tab.id, { annotations: ['newer'] }, 'ann.engineEdit');
        return true;
      });
      await saveAndClose(host(), tab.id);
      expect(discardTab).not.toHaveBeenCalled();
      expect(saveStore.get().closeRequest).toBe('tab-1');
    });

    it('does nothing for a tab that went away while the save ran', async () => {
      saveActive.mockResolvedValue(true);
      await saveAndClose(host(), 'gone');
      expect(discardTab).not.toHaveBeenCalled();
    });
  });
});
