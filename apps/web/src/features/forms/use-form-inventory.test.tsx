// @vitest-environment happy-dom
/**
 * The form inventory follows the document on screen: it is read from the materialised working
 * bytes, starts over when the bytes, a value typed into the engine, the handle or a retry changes
 * — not for a mark step, which changes none of them — keeps the form list when only the XFA read
 * fails, and a read that lands after the next one started is dropped.
 */

import { act, cleanup, render } from '@testing-library/react';
import type { FormFieldInfo } from 'pdf-core';
import { type EngineValuesDraft, type JsonValue, SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentForms,
  formInventoryKey,
  formsStore,
  initialFormsState,
  retryInspection,
} from './forms-store';
import { useFormInventory } from './use-form-inventory';

const emptyOverlays = vi.hoisted(() => ({ annotations: [], measures: [], redactions: [] }));
const calls = vi.hoisted(() => ({
  materializeBase: vi.fn(),
  readFormFields: vi.fn(),
  inspectXfa: vi.fn(),
}));
vi.mock('../../operations', () => ({
  EMPTY_OVERLAYS: emptyOverlays,
  materializeBase: calls.materializeBase,
}));
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

/** The tab after a mark step: a new working id over the same bytes and the same typed values. */
function mark(store: SessionStore, tab: SessionTab, values?: EngineValuesDraft): SessionTab {
  const overlays = { annotations: [{ id: 'm1' }], measures: [], redactions: [], engineValues: values };
  store.setOverlays(tab.id, overlays as unknown as JsonValue, 'ann.transform');
  return store.active as SessionTab;
}

/** What the engine holds once `value` was typed into a field. */
function typed(value: string): EngineValuesDraft {
  return { entries: [{ key: 'field-1', value: { value } }], dropped: 0 };
}

/** The tab after those values were typed into the engine. */
function typeValues(store: SessionStore, tab: SessionTab, engineValues: EngineValuesDraft): SessionTab {
  store.setOverlays(tab.id, { engineValues } as unknown as JsonValue, 'ann.engineEdit');
  return store.active as SessionTab;
}

/** The tab after a byte operation landed. */
function produce(store: SessionStore, tab: SessionTab): SessionTab {
  store.applyOperation({
    tabId: tab.id,
    bytes: new Uint8Array([4, 5]),
    pageCount: 1,
    labelKey: 'form.note.filled',
    engine: 'mupdf',
    steps: [],
    overlays: null,
  });
  return store.active as SessionTab;
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
    expect(currentForms(tab)).toEqual({ tabId: tab.id, key: formInventoryKey(tab) });
    await act(async () => undefined);

    expect(calls.materializeBase).toHaveBeenCalledWith(
      { store, t, tab, handle },
      { signal: expect.any(AbortSignal) },
      undefined,
      emptyOverlays,
    );
    expect(calls.materializeBase.mock.calls[0]?.[3]).toBe(emptyOverlays);
    expect(calls.readFormFields).toHaveBeenCalledWith(bytes, expect.any(AbortSignal));
    expect(calls.inspectXfa).toHaveBeenCalledWith(bytes);
    expect(currentForms(tab)).toEqual({
      tabId: tab.id,
      key: formInventoryKey(tab),
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
    expect(currentForms(tab)).toEqual({ tabId: tab.id, key: formInventoryKey(tab), fields, xfa: null });
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

  it('does not read again for a mark step, which mints a new working id over the same bytes', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);
    const inventory = formsStore.get().formInventory;
    expect(inventory?.fields).toBe(fields);

    const drawn = mark(store, tab);
    expect(drawn.working.id).not.toBe(tab.working.id);
    view.rerender(<Follower store={store} tab={drawn} handle={handle} />);
    await act(async () => undefined);
    view.rerender(<Follower store={store} tab={mark(store, drawn)} handle={handle} />);
    await act(async () => undefined);

    expect(calls.materializeBase).toHaveBeenCalledTimes(1);
    expect(formsStore.get().formInventory).toBe(inventory);
    expect(currentForms(store.active)?.fields).toBe(fields);
  });

  it('reads again for another version of the bytes, and takes the tab it reads from the store', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);

    const next = produce(store, tab);
    view.rerender(<Follower store={store} tab={next} handle={handle} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(2);
    expect(calls.materializeBase.mock.calls[1]?.[0].tab).toBe(next);
    expect(currentForms(next)?.fields).toBe(fields);
    expect(currentForms(tab)).toBeNull();

    // Another read of the same bytes (a swapped handle) is of the tab the store holds now.
    const drawn = mark(store, next);
    view.rerender(<Follower store={store} tab={next} handle={otherHandle} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(3);
    expect(calls.materializeBase.mock.calls[2]?.[0].tab).toBe(drawn);
    expect(currentForms(drawn)?.fields).toBe(fields);
  });

  it('reads again once a value is typed, so what Save verifies against is the typed value', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const typedFields = [{ name: 'Name', value: 'Acme' }] as unknown as readonly FormFieldInfo[];
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);
    expect(currentForms(tab)?.fields).toBe(fields);

    // The engine now holds the typed value; the next read of the bytes carries it.
    calls.readFormFields.mockResolvedValueOnce(typedFields);
    const acme = typed('Acme');
    const typing = typeValues(store, tab, acme);
    expect(currentForms(typing)).toBeNull();
    view.rerender(<Follower store={store} tab={typing} handle={handle} />);
    expect(currentForms(typing)).toEqual({ tabId: tab.id, key: formInventoryKey(typing) });
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(2);
    expect(currentForms(typing)?.fields).toBe(typedFields);

    // A mark drawn over the typing keeps those values: no third read.
    const drawn = mark(store, typing, acme);
    view.rerender(<Follower store={store} tab={drawn} handle={handle} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(2);
    expect(currentForms(drawn)?.fields).toBe(typedFields);

    // The next keystroke is another value: read again.
    const another = typeValues(store, drawn, typed('Acme Ltd'));
    view.rerender(<Follower store={store} tab={another} handle={handle} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(3);
  });

  it('reads nothing for a tab the store no longer holds', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    store.closeTab(tab.id);
    render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);

    expect(calls.materializeBase).not.toHaveBeenCalled();
    expect(formsStore.get().formInventory).toBeNull();
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
