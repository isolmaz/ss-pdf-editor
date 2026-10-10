// @vitest-environment happy-dom
/**
 * The autosave writes every tab's draft once the model has been still for 600 ms and words a
 * failure without repeating it; the channel effect owns the channel's whole life and keeps the
 * other windows told which keys this one holds.
 */

import { act, cleanup, render } from '@testing-library/react';
import { SessionStore } from 'pdf-model';
import { createTranslator, ToolError, type Translator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storedCopyWarning } from '../../notices';
import { coreStore, initialCoreState } from '../core/core-store';
import { persistedKeysRecorded, persistenceStore, resetPersistence } from './persistence-store';
import { useDraftAutosave, useVaultChannel } from './use-vault-sync';
import { fakeChannel, openTab } from './vault.fixtures';

const channels = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../vault-channel', () => ({ createVaultChannel: channels.create }));

const en = createTranslator('en');

function Autosave(props: {
  readonly store: SessionStore;
  readonly persist: (tabId: string) => Promise<unknown>;
  readonly translator: { readonly current: Translator };
}) {
  useDraftAutosave({
    session: props.store.getSnapshot(),
    store: props.store,
    persist: props.persist,
    translator: props.translator,
  });
  return null;
}

function Channel(props: { readonly store: SessionStore }) {
  useVaultChannel(props.store, props.store.getSnapshot());
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  coreStore.set(initialCoreState());
  resetPersistence();
  channels.create.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDraftAutosave', () => {
  const translator = { current: en };

  it('writes nothing with no document open', async () => {
    const persist = vi.fn();
    render(<Autosave store={new SessionStore()} persist={persist} translator={translator} />);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(persist).not.toHaveBeenCalled();
  });

  it('writes every tab 600 ms after the render, and not before', async () => {
    const store = new SessionStore();
    const first = openTab(store, 'one');
    const second = openTab(store, 'two', 'b.pdf');
    const persist = vi.fn(async () => 'written');
    render(<Autosave store={store} persist={persist} translator={translator} />);
    await act(() => vi.advanceTimersByTimeAsync(599));
    expect(persist).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(persist.mock.calls).toEqual([[first.id], [second.id]]);
  });

  it('starts over when the document model changes before the timer fires', async () => {
    const store = new SessionStore();
    openTab(store, 'one');
    const persist = vi.fn(async () => 'written');
    const { rerender } = render(<Autosave store={store} persist={persist} translator={translator} />);
    await act(() => vi.advanceTimersByTimeAsync(400));
    openTab(store, 'two', 'b.pdf');
    rerender(<Autosave store={store} persist={persist} translator={translator} />);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(persist).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('does not write after the shell is gone', async () => {
    const store = new SessionStore();
    openTab(store);
    const persist = vi.fn();
    const { unmount } = render(<Autosave store={store} persist={persist} translator={translator} />);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(persist).not.toHaveBeenCalled();
  });

  it('words a tool error in the language current when it fails', async () => {
    const store = new SessionStore();
    openTab(store);
    const error = new ToolError('write-failed', { engine: 'model' });
    const current = { current: createTranslator('tr') };
    render(
      <Autosave
        store={store}
        persist={async () => {
          throw error;
        }}
        translator={current}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(coreStore.get().notice).toBe(
      `${current.current(error.messageKey)} ${current.current(error.hintKey)}`,
    );
  });

  it('says the stored copy was refused once, however often the write fails', async () => {
    const store = new SessionStore();
    openTab(store);
    const refused = new DOMException('full', 'QuotaExceededError');
    const persist = vi.fn(async () => {
      throw refused;
    });
    const { rerender } = render(<Autosave store={store} persist={persist} translator={translator} />);
    await act(() => vi.advanceTimersByTimeAsync(600));
    const warning = storedCopyWarning(refused, en);
    expect(coreStore.get().notice).toBe(warning);
    coreStore.set({ notice: `Opened. ${warning}` });
    openTab(store, 'two', 'b.pdf');
    rerender(<Autosave store={store} persist={persist} translator={translator} />);
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(coreStore.get().notice).toBe(`Opened. ${warning}`);
  });
});

describe('useVaultChannel', () => {
  it('opens the channel for the handlers, announces the held keys and closes it on unmount', () => {
    const announce = vi.fn();
    const channel = fakeChannel({ announce });
    channels.create.mockReturnValue(channel);
    const store = new SessionStore();
    const tab = openTab(store, 'one');
    persistedKeysRecorded(tab.id, ['snapshot-1']);

    const { unmount } = render(<Channel store={store} />);
    expect(persistenceStore.get().channel).toBe(channel);
    expect(announce).toHaveBeenCalledWith(['src-one', 'snapshot-1']);

    unmount();
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(persistenceStore.get().channel).toBeNull();
  });

  it('announces again when the document model changes', () => {
    const announce = vi.fn();
    channels.create.mockReturnValue(fakeChannel({ announce }));
    const store = new SessionStore();
    const { rerender } = render(<Channel store={store} />);
    expect(announce).toHaveBeenLastCalledWith([]);
    openTab(store, 'one');
    rerender(<Channel store={store} />);
    expect(announce).toHaveBeenLastCalledWith(['src-one']);
  });
});
