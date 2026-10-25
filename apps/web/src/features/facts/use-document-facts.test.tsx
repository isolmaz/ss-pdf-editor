// @vitest-environment happy-dom
/**
 * The facts follow the document on screen: they are read from the materialised working bytes
 * (verdicts judged against the user's trust), start over whenever the bytes, the handle, the
 * trust or a retry changes — not for a mark step, which changes no byte — and a read that arrives
 * late or fails after the next one began is dropped.
 */

import { act, cleanup, render } from '@testing-library/react';
import { SessionStore, type SessionTab, workingBytesKey } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentFacts, currentFactsError, factsReading, factsStore } from './facts-store';
import { trustStore } from './trust-store';
import { useDocumentFacts } from './use-document-facts';

const emptyOverlays = vi.hoisted(() => ({ annotations: [], measures: [], redactions: [] }));
const calls = vi.hoisted(() => ({
  materializeBase: vi.fn(),
  listPdfFonts: vi.fn(),
  verifySignatures: vi.fn(),
  inspectProtection: vi.fn(),
  listPdfAttachments: vi.fn(),
  readPdfAttachment: vi.fn(),
}));
vi.mock('../../operations', () => ({
  EMPTY_OVERLAYS: emptyOverlays,
  materializeBase: calls.materializeBase,
}));
vi.mock('../../lazy-ops', () => ({
  listPdfFonts: calls.listPdfFonts,
  verifySignatures: calls.verifySignatures,
  inspectProtection: calls.inspectProtection,
}));
vi.mock('pdf-core/attachments', () => ({
  listPdfAttachments: calls.listPdfAttachments,
  readPdfAttachment: calls.readPdfAttachment,
}));

const t = createTranslator('en');
const bytes = new Uint8Array([1, 2, 3]);
const handle = { name: 'handle' } as never;
const otherHandle = { name: 'other' } as never;
const empty = trustStore.get();

function openTab(store = new SessionStore()): SessionTab {
  return store.openDocument({ name: 'a.pdf', bytes, sha256: 'a', pageCount: 1 });
}

/** The tab after a mark step: a new working id over the same bytes. */
function mark(store: SessionStore, tab: SessionTab): SessionTab {
  store.setOverlays(tab.id, { annotations: [{ id: 'm1' }], measures: [], redactions: [] }, 'ann.transform');
  return store.active as SessionTab;
}

/** The tab after a byte operation landed. */
function produce(store: SessionStore, tab: SessionTab): SessionTab {
  store.applyOperation({
    tabId: tab.id,
    bytes: new Uint8Array([4, 5]),
    pageCount: 1,
    labelKey: 'ann.transform',
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
  readonly revision?: number;
}) {
  useDocumentFacts({
    store: props.store,
    t,
    tab: props.tab,
    handle: props.handle,
    revision: props.revision ?? 0,
  });
  return null;
}

beforeEach(() => {
  factsReading();
  trustStore.set(empty);
  for (const call of Object.values(calls)) call.mockReset();
  calls.materializeBase.mockResolvedValue(bytes);
  calls.listPdfFonts.mockResolvedValue([{ name: 'Helvetica' }]);
  calls.verifySignatures.mockResolvedValue([{ fieldName: 'Sig1' }]);
  calls.inspectProtection.mockResolvedValue({
    encrypted: true,
    permissions: { print: true, copy: false, modify: true },
  });
  calls.listPdfAttachments.mockResolvedValue([]);
  calls.readPdfAttachment.mockResolvedValue(new Uint8Array(0));
});
afterEach(cleanup);

describe('useDocumentFacts', () => {
  it('reads fonts, signatures, measured attachments and the granted permissions of the version on screen', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    calls.listPdfAttachments.mockResolvedValue([
      { filename: 'a.txt', description: 'first' },
      { filename: 'b.txt', description: 'second' },
    ]);
    calls.readPdfAttachment.mockImplementation(async (_handle: unknown, attachment: { filename: string }) => {
      if (attachment.filename === 'b.txt') throw new Error('unreadable');
      return new Uint8Array(5);
    });
    trustStore.set({ rootBytes: [new Uint8Array([9])], listBytes: [new Uint8Array([8])] });

    render(<Follower store={store} tab={tab} handle={handle} />);
    expect(currentFacts(tab)).toBeNull();
    await act(async () => undefined);

    expect(calls.materializeBase).toHaveBeenCalledWith(
      { store, t, tab, handle },
      { signal: expect.any(AbortSignal) },
      undefined,
      emptyOverlays,
    );
    expect(calls.materializeBase.mock.calls[0]?.[3]).toBe(emptyOverlays);
    expect(calls.verifySignatures).toHaveBeenCalledWith(bytes, expect.any(AbortSignal), {
      roots: [new Uint8Array([9])],
      crls: [new Uint8Array([8])],
    });
    expect(currentFacts(tab)).toEqual({
      tabId: tab.id,
      bytesKey: workingBytesKey(tab),
      fonts: [{ name: 'Helvetica' }],
      signatures: [{ fieldName: 'Sig1' }],
      attachments: [
        { name: 'a.txt', description: 'first', size: 5 },
        { name: 'b.txt', description: 'second', size: null },
      ],
      security: { encrypted: true, permissions: ['print', 'modify'] },
      unread: [],
    });
  });

  it('has no facts without a document or a handle, and forgets the previous ones', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);
    expect(currentFacts(tab)).not.toBeNull();

    view.rerender(<Follower store={store} tab={tab} handle={null} />);
    expect(factsStore.get()).toEqual({ facts: null, failure: null });

    view.rerender(<Follower store={store} tab={null} handle={null} />);
    expect(factsStore.get()).toEqual({ facts: null, failure: null });
    expect(calls.materializeBase).toHaveBeenCalledTimes(1);
  });

  it('does not read again for a mark step, which mints a new working id over the same bytes', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);
    const facts = currentFacts(tab);
    expect(facts).not.toBeNull();

    const drawn = mark(store, tab);
    expect(drawn.working.id).not.toBe(tab.working.id);
    view.rerender(<Follower store={store} tab={drawn} handle={handle} />);
    await act(async () => undefined);
    mark(store, drawn);
    view.rerender(<Follower store={store} tab={store.active} handle={handle} />);
    await act(async () => undefined);

    expect(calls.materializeBase).toHaveBeenCalledTimes(1);
    expect(currentFacts(store.active)).toBe(facts);
    expect(factsStore.get().facts).toBe(facts);
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
    expect(currentFacts(next)).toMatchObject({ tabId: tab.id, bytesKey: workingBytesKey(next) });
    expect(currentFacts(tab)).toBeNull();

    // Another read of the same bytes (a swapped handle) sees the marks the store has since gained,
    // not the tab object its caller last rendered.
    const drawn = mark(store, next);
    view.rerender(<Follower store={store} tab={next} handle={otherHandle} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(3);
    expect(calls.materializeBase.mock.calls[2]?.[0].tab).toBe(drawn);
    expect(currentFacts(drawn)).not.toBeNull();
  });

  it('reads nothing for a tab the store no longer holds', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    store.closeTab(tab.id);
    render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);

    expect(calls.materializeBase).not.toHaveBeenCalled();
    expect(factsStore.get()).toEqual({ facts: null, failure: null });
  });

  it('starts over when the handle changes, the user imports a root, or asks to retry', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = render(<Follower store={store} tab={tab} handle={handle} revision={0} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(1);

    view.rerender(<Follower store={store} tab={tab} handle={otherHandle} revision={0} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(2);

    act(() => trustStore.set({ rootBytes: [new Uint8Array([2])] }));
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(3);

    view.rerender(<Follower store={store} tab={tab} handle={otherHandle} revision={1} />);
    await act(async () => undefined);
    expect(calls.materializeBase).toHaveBeenCalledTimes(4);
  });

  it('keeps a failed read as the failure of that version, and wraps a stray error as internal', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const failure = new ToolError('internal', { engine: 'model' });
    calls.materializeBase.mockRejectedValueOnce(failure);

    const view = render(<Follower store={store} tab={tab} handle={handle} revision={0} />);
    await act(async () => undefined);
    expect(currentFactsError(tab)).toBe(failure);
    expect(currentFacts(tab)).toBeNull();

    calls.verifySignatures.mockRejectedValueOnce(new Error('worker gone'));
    view.rerender(<Follower store={store} tab={tab} handle={handle} revision={1} />);
    await act(async () => undefined);
    expect(currentFactsError(tab)).toBeInstanceOf(ToolError);
    expect(currentFactsError(tab)?.messageKey).toBe(failure.messageKey);
  });

  it('fails the read when the protection could not be read, as it does for the signatures', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    calls.inspectProtection.mockRejectedValueOnce(new ToolError('internal', { engine: 'model' }));

    render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);

    expect(currentFacts(tab)).toBeNull();
    expect(currentFactsError(tab)?.code).toBe('internal');
  });

  it('keeps the facts a write needs when the fonts or the attachments cannot be read, and names what is unread', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    calls.listPdfFonts.mockRejectedValueOnce(new Error('worker gone'));

    const view = render(<Follower store={store} tab={tab} handle={handle} revision={0} />);
    await act(async () => undefined);

    expect(currentFactsError(tab)).toBeNull();
    expect(currentFacts(tab)).toEqual({
      tabId: tab.id,
      bytesKey: workingBytesKey(tab),
      fonts: [],
      signatures: [{ fieldName: 'Sig1' }],
      attachments: [],
      security: { encrypted: true, permissions: ['print', 'modify'] },
      unread: ['fonts'],
    });

    calls.listPdfAttachments.mockRejectedValueOnce(new Error('no names'));
    view.rerender(<Follower store={store} tab={tab} handle={handle} revision={1} />);
    await act(async () => undefined);

    expect(currentFacts(tab)).toMatchObject({
      fonts: [{ name: 'Helvetica' }],
      attachments: [],
      signatures: [{ fieldName: 'Sig1' }],
      unread: ['attachments'],
    });
  });

  it('drops a read that lands, or fails, after the next one started', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    let finishFirst!: (value: Uint8Array) => void;
    calls.materializeBase.mockImplementationOnce(
      () => new Promise<Uint8Array>((resolve) => (finishFirst = resolve)),
    );
    const view = render(<Follower store={store} tab={tab} handle={handle} revision={0} />);

    view.rerender(<Follower store={store} tab={tab} handle={handle} revision={1} />);
    await act(async () => undefined);
    const fresh = currentFacts(tab);
    expect(fresh).not.toBeNull();

    await act(async () => finishFirst(bytes));
    expect(currentFacts(tab)).toBe(fresh);

    let failSecond!: (error: Error) => void;
    calls.materializeBase.mockImplementationOnce(
      () => new Promise<Uint8Array>((_resolve, reject) => (failSecond = reject)),
    );
    view.rerender(<Follower store={store} tab={tab} handle={handle} revision={2} />);
    view.unmount();
    await act(async () => failSecond(new Error('late')));
    expect(currentFactsError(tab)).toBeNull();
  });

  it('stops measuring attachments once the read was abandoned', async () => {
    const store = new SessionStore();
    const tab = openTab(store);
    let listed!: (value: unknown[]) => void;
    calls.listPdfAttachments.mockImplementationOnce(() => new Promise((resolve) => (listed = resolve)));
    const view = render(<Follower store={store} tab={tab} handle={handle} />);
    await act(async () => undefined);

    view.unmount();
    await act(async () => listed([{ filename: 'a.txt', description: '' }]));

    expect(calls.readPdfAttachment).not.toHaveBeenCalled();
  });
});
