// @vitest-environment happy-dom
/**
 * The handlers as the shell uses them: stable until what they run on changes, and the two
 * effects — entering select settles native editors (sweeping only when the engine still holds
 * something it cannot model), and the file's annotations reach the store with the render.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { ExistingAnnotation } from 'pdf-core';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { annotationsStore, initialAnnotationsState, knownExistingAnnotations } from './annotations-store';
import type { AnnotationHost } from './host';
import {
  type AnnotationActions,
  useAnnotationActions,
  usePublishExistingAnnotations,
  useSettleNativeEditors,
} from './use-annotation-actions';

const mocks = vi.hoisted(() => ({ materializeBase: vi.fn(), applyProducedBytes: vi.fn() }));
vi.mock('../../operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../operations')>()),
  materializeBase: mocks.materializeBase,
  applyProducedBytes: mocks.applyProducedBytes,
}));

const t = createTranslator('en');

let session: SessionStore;
let tab: SessionTab;
let handle: PdfDocumentHandle;
let entries: { id: string; value: Record<string, unknown> }[];
let api: ViewerApi;

function hostWith(overrides: Partial<AnnotationHost> = {}): AnnotationHost {
  return {
    session,
    t,
    viewer: { current: api },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  annotationsStore.set(initialAnnotationsState());
  session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 2 });
  tab = session.active as SessionTab;
  handle = { pageCount: 2 } as unknown as PdfDocumentHandle;
  adoptHandle(tab.id, handle);
  entries = [];
  api = {
    document: handle,
    captureAnnotationEntries: () => entries,
    dropAnnotationEntry: vi.fn(),
    pageGeometry: () => ({ x: 0, y: 0, width: 600, height: 800 }),
  } as unknown as ViewerApi;
  mocks.materializeBase.mockResolvedValue(new Uint8Array([7]));
  mocks.applyProducedBytes.mockResolvedValue({ name: 'produced' });
});
afterEach(() => {
  cleanup();
  dropHandle(tab.id);
});

describe('useAnnotationActions', () => {
  it('keeps the same handlers until something they run on changes', () => {
    const base = hostWith();
    const { result, rerender } = renderHook((host: AnnotationHost) => useAnnotationActions(host), {
      initialProps: base,
    });
    const first = result.current;
    rerender({ ...base });
    expect(result.current).toBe(first);
    rerender({ ...base, t: createTranslator('tr') });
    expect(result.current).not.toBe(first);
  });

  it('binds every handler to the host it was built with', async () => {
    const { result } = renderHook(() => useAnnotationActions(hostWith()));
    expect(result.current.takeEngineAnnotations()).toEqual([]);
    expect(result.current.settleNativeEditors()).toBe(false);
    await result.current.exportAnnotationData('json');
    expect(coreStore.get().notice).toBe(t('ann.data.empty'));
    await result.current.importAnnotationData(new File(['nope'], 'x'));
    expect(coreStore.get().notice).not.toBe(t('ann.data.empty'));
    await result.current.sweepOrphanAnnotations();
    expect(mocks.materializeBase).toHaveBeenCalledTimes(1);
  });
});

describe('useSettleNativeEditors', () => {
  const actions = (settle: boolean) =>
    ({
      settleNativeEditors: vi.fn(() => settle),
      sweepOrphanAnnotations: vi.fn(() => Promise.resolve()),
    }) as unknown as AnnotationActions & {
      settleNativeEditors: ReturnType<typeof vi.fn>;
      sweepOrphanAnnotations: ReturnType<typeof vi.fn>;
    };

  it('does nothing while the pointer belongs to a drawing tool', () => {
    const fake = actions(true);
    renderHook(() => useSettleNativeEditors(null, fake));
    expect(fake.settleNativeEditors).not.toHaveBeenCalled();
  });

  it('settles on entering select, and does not sweep when nothing unmodellable is left', () => {
    const fake = actions(false);
    const { rerender } = renderHook(({ mode }) => useSettleNativeEditors(mode, fake), {
      initialProps: { mode: null as 'select' | null },
    });
    rerender({ mode: 'select' });
    expect(fake.settleNativeEditors).toHaveBeenCalledTimes(1);
    expect(fake.sweepOrphanAnnotations).not.toHaveBeenCalled();
  });

  it('sweeps when the engine still holds an entry the app cannot model', () => {
    const fake = actions(true);
    renderHook(() => useSettleNativeEditors('select', fake));
    expect(fake.sweepOrphanAnnotations).toHaveBeenCalledTimes(1);
  });

  it('settles the real engine state the same way', async () => {
    entries = [{ id: 'stamp', value: { annotationType: 13, pageIndex: 0 } }];
    const { result } = renderHook(() => useAnnotationActions(hostWith()));
    renderHook(() => useSettleNativeEditors('select', result.current));
    await act(() => Promise.resolve());
    expect(mocks.materializeBase).toHaveBeenCalledTimes(1);
  });
});

describe('usePublishExistingAnnotations', () => {
  it('hands the store the list the render computed, and unknown when it is dropped', () => {
    const found = [{ id: 'a' }] as unknown as readonly ExistingAnnotation[];
    const { rerender } = renderHook(
      ({ existing }: { existing: readonly ExistingAnnotation[] | null }) =>
        usePublishExistingAnnotations(existing),
      { initialProps: { existing: found as readonly ExistingAnnotation[] | null } },
    );
    expect(knownExistingAnnotations()).toBe(found);
    rerender({ existing: null });
    expect(knownExistingAnnotations()).toBeNull();
  });
});
