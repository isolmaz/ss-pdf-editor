// @vitest-environment happy-dom
/**
 * The form inventory follows the document on screen: it is read from the materialised working
 * bytes, starts over when the version, the handle or a retry changes, keeps the form list when
 * only the XFA read fails, and a read that lands after the next one started is dropped.
 */

import { act, cleanup, render } from '@testing-library/react';
import type { FormFieldInfo } from 'pdf-core';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentForms, formsStore, initialFormsState, retryInspection } from './forms-store';
import { useFormInventory } from './use-form-inventory';

const calls = vi.hoisted(() => ({
  materializeBase: vi.fn(),
  readFormFields: vi.fn(),
  inspectXfa: vi.fn(),
}));
vi.mock('../../operations', () => ({ materializeBase: calls.materializeBase }));
vi.mock('../../lazy-ops', () => ({
  readFormFields: calls.readFormFields,
  inspectXfa: calls.inspectXfa,
}));

const t = createTranslator('en');
const bytes = new Uint8Array([1, 2, 3]);
const handle = { name: 'handle' } as never;
const otherHandle = { name: 'other' } as never;
const fields = [{ name: 'Name' }] as unknown as readonly FormFieldInfo[];

function openTab(store = new SessionStore()): SessionTab {
  return store.openDocument({ name: 'a.pdf', bytes, sha256: 'a', pageCount: 1 });
}

function Follower(props: {
  readonly store: SessionStore;
  readonly tab: SessionTab | null;
  readonly handle: never | null;
}) {
  useFormInventory({ store: props.store, t, tab: props.tab, handle: props.handle });
  return null;
}

beforeEach(() => {
  formsStore.set(initialFormsState());
  for (const call of Object.values(calls)) call.mockReset();
  calls.materializeBase.mockResolvedValue(bytes);
  calls.readFormFields.mockResolvedValue(fields);
  calls.inspectXfa.mockResolvedValue({ kind: 'dynamic' });
});
afterEach(cleanup);

describe('useFormInventory', () => {
  it('reads the fields and the XFA of the version on screen from the materialised bytes', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    render(<Follower store={store} tab={tab} handle={handle} />);
    expect(currentForms(tab)).toEqual({ tabId: tab.id, version: tab.working.id });
    await act(async () => undefined);

    expect(calls.materializeBase).toHaveBeenCalledWith(
      { store, t, tab, handle },
      { signal: expect.any(AbortSignal) },
    );
    expect(calls.readFormFields).toHaveBeenCalledWith(bytes, expect.any(AbortSignal));
    expect(calls.inspectXfa).toHaveBeenCalledWith(bytes);
    expect(currentForms(tab)).toEqual({
      tabId: tab.id,
      version: tab.working.id,
      fields,
      xfa: { kind: 'dynamic' },
    });
  });

  it('keeps the form list when only the XFA read fails', async () => {
    calls.inspectXfa.mockRejectedValue(new Error('no xfa reader'));
    const store = new SessionStore();
    const tab = openTab(store);
    render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);
    expect(currentForms(tab)).toEqual({ tabId: tab.id, version: tab.working.id, fields, xfa: null });
  });

  it('keeps the reason a read failed, wording an unknown failure as an internal one', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const reason = new ToolError('write-failed', { engine: 'mupdf' });
    calls.readFormFields.mockRejectedValueOnce(reason);
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);
    expect(currentForms(tab)?.error).toBe(reason);

    calls.readFormFields.mockRejectedValueOnce(new Error('boom'));
    view.rerender(<Follower store={store} tab={tab} handle={otherHandle} />);
    await act(async () => undefined);
    expect(currentForms(tab)?.error).toEqual(new ToolError('internal', { engine: 'model' }));
  });

  it('has no inventory without a document or a handle, and forgets the previous one', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);
    expect(currentForms(tab)?.fields).toBe(fields);

    view.rerender(<Follower store={store} tab={tab} handle={null} />);
    expect(formsStore.get().formInventory).toBeNull();
    view.rerender(<Follower store={store} tab={null} handle={null} />);
    expect(formsStore.get().formInventory).toBeNull();
    expect(calls.materializeBase).toHaveBeenCalledTimes(1);
  });

  it('starts over when the handle changes or the user asks to retry', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(1);

    view.rerender(<Follower store={store} tab={tab} handle={otherHandle} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(2);

    await act(async () => retryInspection());
    expect(calls.materializeBase).toHaveBeenCalledTimes(3);
  });

  it('drops a read that lands after the next one started', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const late = Promise.withResolvers<readonly FormFieldInfo[]>();
    calls.readFormFields.mockReturnValueOnce(late.promise);
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);

    view.rerender(<Follower store={store} tab={tab} handle={otherHandle} />);
    await act(async () => undefined);
    const current = formsStore.get().formInventory;
    await act(async () => late.resolve([{ name: 'Stale' }] as unknown as readonly FormFieldInfo[]));
    expect(formsStore.get().formInventory).toBe(current);
    expect(currentForms(tab)?.fields).toBe(fields);
  });

  it('drops a failure that lands after the next read started', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const late = Promise.withResolvers<readonly FormFieldInfo[]>();
    calls.readFormFields.mockReturnValueOnce(late.promise);
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);

    view.rerender(<Follower store={store} tab={tab} handle={otherHandle} />);
    await act(async () => undefined);
    await act(async () => late.reject(new Error('late')));
    expect(currentForms(tab)?.error).toBeUndefined();
    expect(currentForms(tab)?.fields).toBe(fields);
  });
});
