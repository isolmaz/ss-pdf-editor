// @vitest-environment happy-dom
/**
 * The unlocked copy of a document opened with its password, through the real dialog run, tab
 * opener and session: what is left of it when the tab in front changes while it opens.
 */

import { SessionStore } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelOperation, coreStore, initialCoreState } from '../core/core-store';
import { dropHandle } from '../core/handles';
import { createOpenActions } from '../open/open-actions';
import { initialOpenState, openStore } from '../open/open-store';
import { persistenceStore } from '../persistence/persistence-store';
import { type MemoryStorage, memoryStorage } from '../persistence/vault.fixtures';
import { createDialogRuns } from './dialog-actions';

const outside = vi.hoisted(() => ({
  openWithPdfjs: vi.fn(),
  unlockDocument: vi.fn(),
}));
vi.mock('pdf-core/engines/pdfjs-handle', () => ({ openWithPdfjs: outside.openWithPdfjs }));
vi.mock('pdf-core/ops/security', () => ({ unlockDocument: outside.unlockDocument }));
vi.mock('pdf-model', async (original) => ({
  ...(await original<typeof import('pdf-model')>()),
  sha256Hex: vi.fn(async () => 'sha'),
}));
vi.mock('pdf-ui/ui', () => ({ dialogById: vi.fn(), hasDialog: vi.fn(), isStandaloneDialog: vi.fn() }));
vi.mock('../../recent', () => ({ addRecentDocument: vi.fn() }));
vi.mock('../../recent-handles', () => ({
  putRecentHandle: vi.fn(async () => undefined),
  getRecentHandle: vi.fn(async () => null),
  reopenFromHandle: vi.fn(),
}));

const t = ((key: string) => key) as unknown as Translator;
const fakeHandle = () => ({ pageCount: 1, destroy: vi.fn(async () => undefined), raw: {} });

let session: SessionStore;
let storage: MemoryStorage;

const opens = () =>
  createOpenActions({ session, t, tier: 'desktop', setCurrentPage: vi.fn(), setRedactionMarks: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  openStore.set(initialOpenState());
  session = new SessionStore();
  storage = memoryStorage();
  persistenceStore.set({ draftStorage: storage });
  outside.openWithPdfjs.mockImplementation(async () => fakeHandle());
  outside.unlockDocument.mockResolvedValue({ bytes: new Uint8Array([42]), report: { notes: [] } });
});
afterEach(() => {
  for (const tab of session.getSnapshot().tabs) dropHandle(tab.id);
});

describe('the unlocked copy', () => {
  it('is cancelled, leaving no tab and no stored copy, when another tab is picked while it opens', async () => {
    await opens().openFile(new File([new Uint8Array([1])], 'public.pdf'));
    const publicTab = session.active;
    await opens().openFile(new File([new Uint8Array([2])], 'secret.pdf'), undefined, 'pw');
    expect(session.active?.sensitive).toBe(true);
    storage.sources.clear();
    let opened!: (handle: unknown) => void;
    outside.openWithPdfjs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );

    const running = createDialogRuns({
      session,
      t,
      openProducedTab: opens().openProducedTab,
      dialogContext: null,
      lockedTabs: openStore.get().lockedTabs,
    }).unlockActiveCopy();
    await vi.waitFor(() => expect(outside.openWithPdfjs).toHaveBeenCalledTimes(3));
    // What the tab menu does when another document is picked.
    cancelOperation();
    session.setActive(publicTab?.id ?? '');
    opened(fakeHandle());
    await running;

    const aborted = new ToolError('aborted', { engine: 'model' });
    expect(session.getSnapshot().tabs.map((tab) => tab.name)).toEqual(['public.pdf', 'secret.pdf']);
    expect(storage.sources.size).toBe(0);
    expect(coreStore.get().notice).toBe(`${aborted.messageKey} ${aborted.hintKey}`);
  });
});
