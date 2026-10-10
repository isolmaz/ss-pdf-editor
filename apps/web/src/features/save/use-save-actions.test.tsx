// @vitest-environment happy-dom
/**
 * The save and viewer handlers as the shell gets them: bound to its session, translator and
 * hooks, each keeping its identity until what it runs on changes.
 */

import { renderHook } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { initialSaveState, saveStore, viewerChanged } from './save-store';
import { type SaveActionsDeps, useSaveActions } from './use-save-actions';

const mocks = vi.hoisted(() => ({ readAnnotations: vi.fn() }));
vi.mock('pdf-core/ops/annotations', () => ({ readAnnotations: mocks.readAnnotations }));

const t = createTranslator('en');
const document = { id: 'document' } as unknown as PdfDocumentHandle;
let session: SessionStore;
let deps: SaveActionsDeps;
let discardTab: Mock<(id: string) => void>;
let prepareOutput: Mock;
let takeEngineAnnotations: Mock;
let captureEngineValues: Mock;
let api: ViewerApi;

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  session = new SessionStore();
  discardTab = vi.fn();
  prepareOutput = vi.fn(async () => null);
  takeEngineAnnotations = vi.fn();
  captureEngineValues = vi.fn(async () => ({ entries: [], dropped: 0 }));
  mocks.readAnnotations.mockResolvedValue([]);
  api = { document, captureEngineValues, getZoom: () => 2 } as unknown as ViewerApi;
  deps = {
    session,
    t,
    cancelRef: { current: null },
    refuseBusy: vi.fn(),
    prepareOutput,
    discardTab,
    takeEngineAnnotations,
  };
});

describe('useSaveActions', () => {
  it('closes a tab with nothing unsaved through the shell discard', () => {
    const tab = session.openDocument({
      name: 'a.pdf',
      bytes: new Uint8Array([1]),
      sha256: 'a',
      pageCount: 1,
    });
    const { result } = renderHook(() => useSaveActions(deps));
    result.current.closeTab(tab.id);
    expect(discardTab).toHaveBeenCalledWith(tab.id);
  });

  it('exports the active tab unless another is named', async () => {
    const first = session.openDocument({
      name: 'a.pdf',
      bytes: new Uint8Array([1]),
      sha256: 'a',
      pageCount: 1,
    });
    const second = session.openDocument({
      name: 'b.pdf',
      bytes: new Uint8Array([2]),
      sha256: 'b',
      pageCount: 1,
    });
    const { result } = renderHook(() => useSaveActions(deps));
    await result.current.exportActive();
    expect(prepareOutput).toHaveBeenLastCalledWith(second.id, expect.any(AbortController));
    await result.current.exportActive(first.id);
    expect(prepareOutput).toHaveBeenLastCalledWith(first.id, expect.any(AbortController));
  });

  it('hands the viewer API to the store when the viewer is ready, and takes the engine marks over', () => {
    const { result } = renderHook(() => useSaveActions(deps));
    result.current.handleViewerReady(api);
    expect(saveStore.get()).toMatchObject({ viewer: api, zoom: 2 });
    expect(takeEngineAnnotations).toHaveBeenCalledWith(api);
    result.current.handleViewerReady(null);
    expect(saveStore.get().viewer).toBeNull();
  });

  it('checkpoints the engine values and marks the document dirty when the engine changed one', async () => {
    const tab = session.openDocument({
      name: 'a.pdf',
      bytes: new Uint8Array([1]),
      sha256: 'a',
      pageCount: 1,
    });
    adoptHandle(tab.id, document);
    viewerChanged(api);
    captureEngineValues.mockResolvedValue({ entries: [{ key: 'city', value: 'Ankara' }], dropped: 0 });
    const { result } = renderHook(() => useSaveActions(deps));

    result.current.markActiveDirty();
    expect(takeEngineAnnotations).toHaveBeenCalledWith(api);
    await vi.waitFor(() => expect(session.active?.dirty).toBe(true));

    captureEngineValues.mockResolvedValue({ entries: [], dropped: 3 });
    expect(await result.current.checkpointEngineValues()).toBe(true);
    dropHandle(tab.id);
  });

  it('keeps each handler identity until what it runs on changes', () => {
    const { result, rerender } = renderHook((props: SaveActionsDeps) => useSaveActions(props), {
      initialProps: deps,
    });
    const first = result.current;
    rerender({ ...deps });
    expect(result.current).toEqual(first);
    for (const name of Object.keys(first) as (keyof typeof first)[]) {
      expect(result.current[name]).toBe(first[name]);
    }
    rerender({ ...deps, discardTab: vi.fn() });
    expect(result.current.closeTab).not.toBe(first.closeTab);
    expect(result.current.handleViewerReady).toBe(first.handleViewerReady);
    expect(result.current.markActiveDirty).toBe(first.markActiveDirty);
    expect(result.current.exportActive).toBe(first.exportActive);
    expect(result.current.checkpointEngineValues).toBe(first.checkpointEngineValues);
  });
});
