// @vitest-environment happy-dom
/**
 * Freezing the working bytes for the text tool: one engine pass when the tool is armed, nothing
 * while it is not, and an honest notice and a return to select when the document cannot be read.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Operations from '../../operations';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import { initialTextToolState, textToolStore } from './text-tool-store';
import { useTextToolBytes } from './use-text-tool-bytes';

const mocks = vi.hoisted(() => ({ materializeBase: vi.fn() }));
vi.mock('../../operations', async (importOriginal) => ({
  ...(await importOriginal<typeof Operations>()),
  ...mocks,
}));

const t = createTranslator('en');
const handle = { raw: {}, pageCount: 1, destroy: vi.fn() } as unknown as PdfDocumentHandle;
const session = new SessionStore();
session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 1 });
const tab = session.active as SessionTab;

const frozen = () => textToolStore.get().bytes;
const mount = (initial: { tab?: SessionTab | null; handle?: PdfDocumentHandle | null } = {}) =>
  renderHook(
    (props: { tab: SessionTab | null; handle: PdfDocumentHandle | null }) =>
      useTextToolBytes(session, props.tab, props.handle, t),
    {
      initialProps: {
        tab: initial.tab === undefined ? tab : initial.tab,
        handle: initial.handle === undefined ? handle : initial.handle,
      },
    },
  );

beforeEach(() => {
  vi.resetAllMocks();
  coreStore.set(initialCoreState());
  textToolStore.set(initialTextToolState());
});
afterEach(cleanup);

describe('useTextToolBytes', () => {
  it('reads nothing while the text tool is not armed', () => {
    mount();
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(frozen()).toBeNull();
  });

  it('freezes the working bytes of the document the moment the tool is armed', async () => {
    const bytes = new Uint8Array([7, 7]);
    mocks.materializeBase.mockResolvedValue(bytes);
    mount();
    act(() => selectTool('text'));
    await vi.waitFor(() => expect(frozen()).toBe(bytes));
    expect(mocks.materializeBase).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tab, handle }), {
      signal: expect.any(AbortSignal),
    });
  });

  it('lets the bytes go when the tool is put down, and when there is no document or engine handle', async () => {
    mocks.materializeBase.mockResolvedValue(new Uint8Array([1]));
    mount();
    act(() => selectTool('text'));
    await vi.waitFor(() => expect(frozen()).not.toBeNull());
    act(() => selectTool('select'));
    expect(frozen()).toBeNull();

    textToolStore.set({ bytes: new Uint8Array([2]) });
    const noTab = mount({ tab: null });
    act(() => selectTool('text'));
    expect(frozen()).toBeNull();
    noTab.unmount();

    textToolStore.set({ bytes: new Uint8Array([2]) });
    mount({ handle: null });
    expect(frozen()).toBeNull();
  });

  it('drops a read that finished after the tool was put down', async () => {
    let finish: (bytes: Uint8Array) => void = () => undefined;
    mocks.materializeBase.mockReturnValue(new Promise<Uint8Array>((resolve) => (finish = resolve)));
    mount();
    act(() => selectTool('text'));
    act(() => selectTool('select'));
    await act(async () => finish(new Uint8Array([9])));
    expect(frozen()).toBeNull();
  });

  it('says why the document could not be read and returns to select', async () => {
    mocks.materializeBase.mockRejectedValue(new ToolError('corrupt-document', { engine: 'model' }));
    mount();
    act(() => selectTool('text'));
    const failure = new ToolError('corrupt-document', { engine: 'model' });
    await vi.waitFor(() => expect(coreStore.get().canvasTool).toBe('select'));
    expect(coreStore.get().notice).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    expect(frozen()).toBeNull();
  });

  it('reports a failure that is not a tool error as an internal one', async () => {
    mocks.materializeBase.mockRejectedValue(new Error('boom'));
    mount();
    act(() => selectTool('text'));
    const internal = new ToolError('internal', { engine: 'model' });
    await vi.waitFor(() =>
      expect(coreStore.get().notice).toBe(`${t(internal.messageKey)} ${t(internal.hintKey)}`),
    );
    expect(coreStore.get().canvasTool).toBe('select');
  });

  it('stays silent about a failure that finished after the tool was put down', async () => {
    let fail: (error: unknown) => void = () => undefined;
    mocks.materializeBase.mockReturnValue(new Promise<Uint8Array>((_, reject) => (fail = reject)));
    mount();
    act(() => selectTool('text'));
    act(() => selectTool('select'));
    await act(async () => fail(new Error('late')));
    expect(coreStore.get().notice).toBeNull();
  });
});
