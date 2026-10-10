// @vitest-environment happy-dom
/**
 * Startup recovery: restorable drafts come back as tabs behind whatever the user already has
 * open, a draft that cannot be restored is said so without stopping the others, and switching
 * the interface language never replays any of it.
 */

import { act, cleanup, render } from '@testing-library/react';
import { type Draft, type DraftSnapshot, SessionStore } from 'pdf-model';
import { createTranslator, ToolError, type Translator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  annotationsStore,
  heldEngineValues,
  initialAnnotationsState,
} from '../annotations/annotations-store';
import { coreStore, initialCoreState } from '../core/core-store';
import { handleFor } from '../core/handles';
import { persistedKeysFor, persistenceStore, resetPersistence } from './persistence-store';
import { type RecoveryHost, useDraftRecovery } from './use-draft-recovery';
import { type MemoryStorage, manifest, memoryStorage, openTab } from './vault.fixtures';

const outside = vi.hoisted(() => ({
  openWithPdfjs: vi.fn(),
  getRecentHandle: vi.fn(),
  pruneRecentHandles: vi.fn(),
  addRecentDocument: vi.fn(),
  loadRecentDocuments: vi.fn(),
}));
vi.mock('pdf-core/engines/pdfjs-handle', () => ({ openWithPdfjs: outside.openWithPdfjs }));
vi.mock('../../recent-handles', () => ({
  getRecentHandle: outside.getRecentHandle,
  pruneRecentHandles: outside.pruneRecentHandles,
}));
vi.mock('../../recent', () => ({
  addRecentDocument: outside.addRecentDocument,
  loadRecentDocuments: outside.loadRecentDocuments,
}));

const en = createTranslator('en');
const source = new Uint8Array([1, 2, 3]);
let storage: MemoryStorage;
let store: SessionStore;
let openAndFingerprint: RecoveryHost['openAndFingerprint'];

function Recovery(props: { readonly translator: { readonly current: Translator } }) {
  useDraftRecovery({ store, translator: props.translator, openAndFingerprint });
  return null;
}

/** Mount recovery and let every restore settle. */
async function recover(translator: { readonly current: Translator } = { current: en }) {
  const view = render(<Recovery translator={translator} />);
  await act(() => vi.waitFor(() => expect(outside.pruneRecentHandles).toHaveBeenCalled()));
  return view;
}

function notice(): string | null {
  return coreStore.get().notice;
}

function stored(draft: Draft, bytes: Uint8Array = source): void {
  storage.drafts.set(draft.id, draft);
  storage.sources.set(draft.sourceKey, bytes);
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  annotationsStore.set(initialAnnotationsState());
  resetPersistence();
  for (const mock of Object.values(outside)) mock.mockReset();
  outside.openWithPdfjs.mockImplementation(async () => ({ destroy: vi.fn(async () => undefined) }));
  outside.getRecentHandle.mockResolvedValue(null);
  outside.pruneRecentHandles.mockResolvedValue(undefined);
  outside.loadRecentDocuments.mockReturnValue([{ id: 'kept' }]);
  storage = memoryStorage();
  persistenceStore.set({ draftStorage: storage });
  store = new SessionStore();
  openAndFingerprint = async (opening, fingerprinting) => [await opening, await fingerprinting];
});
afterEach(cleanup);

describe('useDraftRecovery', () => {
  it('restores a dirty draft as a tab with its engine handle, history and recent entry', async () => {
    stored(manifest('draft', { name: 'report.pdf', dirty: true, sourcePageCount: 4, pageCount: 4 }));
    await recover();

    const tab = store.getSnapshot().tabs[0];
    expect(tab?.id).toBe('draft');
    expect(tab?.name).toBe('report.pdf');
    expect(tab?.dirty).toBe(true);
    expect(tab?.source.pageCount).toBe(4);
    expect(handleFor('draft')).toBeDefined();
    expect(outside.addRecentDocument).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'draft', name: 'report.pdf', sizeBytes: 3 }),
    );
    expect(notice()).toBe(en('draft.restored', { count: 1 }));
    expect(outside.pruneRecentHandles).toHaveBeenCalledWith(new Set(['kept']));
  });

  it('keeps the document the user already has in front', async () => {
    const open = openTab(store, 'open', 'open.pdf');
    stored(manifest('draft'));
    await recover();
    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual([open.id, 'draft']);
    expect(store.getSnapshot().activeId).toBe(open.id);
  });

  it('reopens the file handle that was kept for the document', async () => {
    const fileHandle = { name: 'report.pdf' };
    outside.getRecentHandle.mockResolvedValue(fileHandle);
    stored(manifest('draft'));
    await recover();
    expect(store.getSnapshot().tabs[0]?.source.handle).toBe(fileHandle);
  });

  it('restores from the stored snapshots, the working version first, and remembers their keys', async () => {
    const snapshot: DraftSnapshot = {
      id: 'snap',
      pageCount: 2,
      inputBytes: 3,
      labelKey: 'shell.open',
      key: 'snapshot-snap',
    };
    stored(manifest('draft', { workingId: 'snap', snapshots: [snapshot], pageCount: 2 }));
    storage.sources.set('snapshot-snap', new Uint8Array([9, 9, 9, 9]));
    await recover();

    expect(outside.addRecentDocument).toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: 4 }));
    expect(store.snapshotsFor('draft').map((item) => item.id)).toEqual(['snap']);
    expect(persistedKeysFor('draft')).toEqual(['snapshot-snap']);
  });

  it('holds the engine values for the viewer that will take them', async () => {
    const engineValues = { entries: [{ key: 'ann', value: { a: 1 } }], dropped: 0 };
    stored(manifest('draft', { engineValues }));
    await recover();
    expect(heldEngineValues('draft')).toEqual(engineValues);
  });

  it('restores a saved document whose draft still carries history', async () => {
    const edited = new SessionStore();
    const original = openTab(edited);
    edited.applyOperation({
      tabId: original.id,
      bytes: new Uint8Array([4]),
      pageCount: 1,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: [],
      overlays: null,
    });
    const journal = edited.getSnapshot().tabs[0]?.journal;
    stored(
      manifest('draft', {
        dirty: false,
        journal: journal?.entries ?? [],
        journalCursor: journal?.cursor ?? 0,
      }),
    );
    await recover();
    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['draft']);
    expect(store.getSnapshot().tabs[0]?.dirty).toBe(false);
  });

  it('skips a clean draft, which carries nothing the user does not already have', async () => {
    stored(manifest('clean', { dirty: false }));
    await recover();
    expect(store.getSnapshot().tabs).toEqual([]);
    expect(notice()).toBeNull();
  });

  it('skips a draft whose document is already open', async () => {
    const open = openTab(store, 'open');
    stored(manifest(open.id));
    await recover();
    expect(store.getSnapshot().tabs).toHaveLength(1);
    expect(outside.openWithPdfjs).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('works with a storage that only lists drafts', async () => {
    stored(manifest('draft'));
    delete storage.readDraftInventory;
    await recover();
    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['draft']);
  });

  it('says a draft whose source is gone is damaged, and restores the others', async () => {
    storage.drafts.set('lost', manifest('lost', { updatedAt: 9 }));
    stored(manifest('draft', { updatedAt: 1 }));
    await recover();
    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['draft']);
    const damaged = new ToolError('corrupt-document', { engine: 'model' });
    expect(notice()).toBe(`${en(damaged.messageKey)} ${en(damaged.hintKey)}`);
  });

  it('says a draft whose working version is missing is damaged', async () => {
    const snapshot: DraftSnapshot = {
      id: 'snap',
      pageCount: 2,
      inputBytes: 3,
      labelKey: 'shell.open',
      key: 'snapshot-snap',
    };
    stored(manifest('draft', { workingId: 'snap', snapshots: [snapshot] }));
    await recover();
    expect(store.getSnapshot().tabs).toEqual([]);
    expect(notice()).toContain(en('error.corrupt-document.message'));
  });

  it.each([
    [
      'a tool error',
      new ToolError('unsupported-format', { engine: 'pdfjs' }),
      'error.unsupported-format.message',
    ],
    ['any other failure', new Error('worker died'), 'error.corrupt-document.message'],
  ] as const)('says what failed when the engine cannot open the document: %s', async (_name, error, key) => {
    stored(manifest('draft'));
    openAndFingerprint = async () => {
      throw error;
    };
    await recover();
    expect(store.getSnapshot().tabs).toEqual([]);
    expect(notice()).toContain(en(key));
  });

  it('says how many drafts were unreadable and does not claim the others came back cleanly', async () => {
    storage.inventory = { drafts: [manifest('draft')], unreadable: ['bad.json', 'worse.json'] };
    storage.sources.set('src-draft', source);
    await recover();
    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['draft']);
    expect(notice()).toBe(en('draft.corrupt', { count: 2 }));
  });

  it('says the vault could not be listed and restores nothing', async () => {
    storage.inventory = { drafts: [manifest('draft')], unreadable: [], enumerationFailed: true };
    storage.sources.set('src-draft', source);
    render(<Recovery translator={{ current: en }} />);
    await act(() => vi.waitFor(() => expect(notice()).toBe(en('error.write-failed.message'))));
    expect(store.getSnapshot().tabs).toEqual([]);
    expect(outside.pruneRecentHandles).not.toHaveBeenCalled();
  });

  it('destroys the engine handle and opens nothing when the shell is gone before the restore lands', async () => {
    const destroy = vi.fn(async () => undefined);
    outside.openWithPdfjs.mockResolvedValue({ destroy });
    const { promise: handleLookup, resolve } = Promise.withResolvers<null>();
    outside.getRecentHandle.mockReturnValue(handleLookup);
    stored(manifest('draft'));
    const view = render(<Recovery translator={{ current: en }} />);
    await act(() => vi.waitFor(() => expect(outside.getRecentHandle).toHaveBeenCalled()));
    view.unmount();
    resolve(null);
    await act(() => vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1)));
    expect(store.getSnapshot().tabs).toEqual([]);
    expect(notice()).toBeNull();
    expect(outside.pruneRecentHandles).not.toHaveBeenCalled();
  });

  it('keeps the tab the user opened meanwhile and still restores the other drafts', async () => {
    const destroy = vi.fn(async () => undefined);
    outside.openWithPdfjs.mockResolvedValueOnce({ destroy });
    outside.getRecentHandle.mockImplementationOnce(async () => {
      store.openDocument({ id: 'first', name: 'mine.pdf', bytes: source, sha256: 'x', pageCount: 1 });
      return null;
    });
    stored(manifest('first', { updatedAt: 2 }));
    stored(manifest('second', { updatedAt: 1 }));
    await recover();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().tabs.map((tab) => tab.name)).toEqual(['mine.pdf', 'second.pdf']);
    expect(notice()).toBe(en('draft.restored', { count: 1 }));
  });

  it('says nothing and prunes nothing when the shell is gone while the vault is read', async () => {
    const { promise: inventory, resolve } = Promise.withResolvers<{
      drafts: never[];
      unreadable: string[];
    }>();
    storage.readDraftInventory = () => inventory;
    const view = render(<Recovery translator={{ current: en }} />);
    view.unmount();
    resolve({ drafts: [], unreadable: ['bad.json'] });
    await act(() => inventory);
    await act(() => Promise.resolve());
    expect(notice()).toBeNull();
    expect(outside.pruneRecentHandles).not.toHaveBeenCalled();
  });

  it('says nothing about a listing that failed once the shell is gone', async () => {
    const { promise: inventory, resolve } = Promise.withResolvers<{
      drafts: never[];
      unreadable: string[];
      enumerationFailed: true;
    }>();
    storage.readDraftInventory = () => inventory;
    const view = render(<Recovery translator={{ current: en }} />);
    view.unmount();
    resolve({ drafts: [], unreadable: [], enumerationFailed: true });
    await act(() => inventory);
    await act(() => Promise.resolve());
    expect(notice()).toBeNull();
  });

  it('does not replay over live tabs when only the interface language changes', async () => {
    stored(manifest('draft'));
    const translator = { current: en };
    const readDraftInventory = vi.spyOn(storage, 'readDraftInventory');
    const view = await recover(translator);
    translator.current = createTranslator('tr');
    view.rerender(<Recovery translator={translator} />);
    await act(() => Promise.resolve());
    expect(readDraftInventory).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().tabs).toHaveLength(1);
  });
});
