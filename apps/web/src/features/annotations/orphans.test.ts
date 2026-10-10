/**
 * Native editors and the orphan sweep: when a restored gesture is committed, and the exact calls
 * the sweep makes (lock, materialise, mount) or refuses to make (busy, no document, a tab that
 * moved on, a cancel), with the one status line that reports a failure.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState, isBusy, setBusy } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { annotationsStore, initialAnnotationsState, orphanSweepInFlight } from './annotations-store';
import type { AnnotationHost } from './host';
import { settleNativeEditors, sweepOrphanAnnotations } from './orphans';

const mocks = vi.hoisted(() => ({ materializeBase: vi.fn(), applyProducedBytes: vi.fn() }));
vi.mock('../../operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../operations')>()),
  materializeBase: mocks.materializeBase,
  applyProducedBytes: mocks.applyProducedBytes,
}));

const t = createTranslator('en');
const notice = () => coreStore.get().notice;
const bytes = new Uint8Array([9, 9]);

let session: SessionStore;
let tab: SessionTab;
let handle: PdfDocumentHandle;
const produced = { name: 'produced' } as unknown as PdfDocumentHandle;
const setHandle = vi.fn();
const contextFor = vi.fn((forTab: SessionTab, forHandle: PdfDocumentHandle) => ({
  store: session,
  t,
  tab: forTab,
  handle: forHandle,
}));
let cancel: { current: AbortController | null };
let entries: { id: string; value: Record<string, unknown> }[];

const viewerFor = (document: PdfDocumentHandle): ViewerApi =>
  ({
    document,
    captureAnnotationEntries: () => entries,
    dropAnnotationEntry: vi.fn(),
    pageGeometry: () => ({ x: 0, y: 0, width: 600, height: 800 }),
  }) as unknown as ViewerApi;

const host = (api: ViewerApi | null = null): AnnotationHost => ({
  session,
  t,
  viewer: { current: api },
  cancel,
  contextFor: contextFor as never,
  setHandle,
});

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  annotationsStore.set(initialAnnotationsState());
  session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 2 });
  tab = session.active as SessionTab;
  handle = { pageCount: 2 } as unknown as PdfDocumentHandle;
  adoptHandle(tab.id, handle);
  cancel = { current: null };
  entries = [];
  mocks.materializeBase.mockImplementation(async (_context, _options, executed: unknown[]) => {
    executed.push({ id: 'step-1', engine: 'mupdf' });
    return bytes;
  });
  mocks.applyProducedBytes.mockResolvedValue(produced);
});
afterEach(() => {
  dropHandle(tab.id);
});

describe('settleNativeEditors', () => {
  it('has nothing to settle without a viewer', () => {
    expect(settleNativeEditors(host())).toBe(false);
  });

  it('says the engine holds nothing when it has no entries', () => {
    expect(settleNativeEditors(host(viewerFor(handle)))).toBe(false);
  });

  it('commits the entries it can model, and says no more is left', () => {
    entries = [
      {
        id: 'e1',
        value: { annotationType: 9, pageIndex: 0, quadPoints: [10, 700, 110, 700, 10, 690, 110, 690] },
      },
    ];
    const api = viewerFor(handle);
    // The takeover reads the engine once and drops what it took; the settle check reads it again.
    api.captureAnnotationEntries = vi.fn().mockReturnValueOnce(entries).mockReturnValue([]);
    expect(settleNativeEditors(host(api))).toBe(false);
    expect(api.dropAnnotationEntry).toHaveBeenCalledWith('e1');
  });

  it('says the engine still holds entries it cannot model: those need the sweep', () => {
    entries = [{ id: 'stamp', value: { annotationType: 13, pageIndex: 0 } }];
    expect(settleNativeEditors(host(viewerFor(handle)))).toBe(true);
  });
});

describe('sweepOrphanAnnotations', () => {
  it('writes the engine`s entries into the bytes and mounts the result, holding the lock meanwhile', async () => {
    let lockDuring: { busy: boolean; controller: boolean; inFlight: boolean } | null = null;
    mocks.materializeBase.mockImplementation(async (_context, _options, executed: unknown[]) => {
      executed.push({ id: 'step-1', engine: 'mupdf' }, { id: 'step-2', engine: 'qpdf' });
      await Promise.resolve();
      lockDuring = {
        busy: isBusy(),
        controller: cancel.current !== null,
        inFlight: orphanSweepInFlight() !== null,
      };
      return bytes;
    });
    const sweep = sweepOrphanAnnotations(host());
    await sweep;
    expect(lockDuring).toEqual({ busy: true, controller: true, inFlight: true });
    expect(mocks.materializeBase).toHaveBeenCalledWith(
      { store: session, t, tab, handle },
      { signal: expect.any(AbortSignal) },
      expect.any(Array),
    );
    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      { store: session, t, tab, handle },
      bytes,
      2,
      { key: 'ann.engineEdit' },
      'qpdf',
      ['step-1', 'step-2'],
      { signal: expect.any(AbortSignal) },
    );
    expect(setHandle).toHaveBeenCalledWith(tab.id, produced);
    expect(isBusy()).toBe(false);
    expect(cancel.current).toBeNull();
    expect(orphanSweepInFlight()).toBeNull();
  });

  it('names pdfjs as the engine when no step ran', async () => {
    mocks.materializeBase.mockResolvedValue(bytes);
    await sweepOrphanAnnotations(host());
    expect(mocks.applyProducedBytes.mock.calls[0]?.slice(4, 6)).toEqual(['pdfjs', []]);
  });

  it('keeps its promise as the one in flight until it settles', async () => {
    const sweep = sweepOrphanAnnotations(host());
    expect(orphanSweepInFlight()).toBe(sweep);
    await sweep;
    expect(orphanSweepInFlight()).toBeNull();
  });

  it('does nothing while another operation holds the document', async () => {
    setBusy(true);
    await sweepOrphanAnnotations(host());
    cancel.current = new AbortController();
    setBusy(false);
    await sweepOrphanAnnotations(host());
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(cancel.current).not.toBeNull();
  });

  it('does nothing without an active tab or without its engine handle', async () => {
    dropHandle(tab.id);
    await sweepOrphanAnnotations(host());
    session = new SessionStore();
    await sweepOrphanAnnotations(host());
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(isBusy()).toBe(false);
  });

  it('mounts nothing when the user switched tabs while the bytes were written', async () => {
    mocks.materializeBase.mockImplementation(async () => {
      session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([2]), sha256: 'h2', pageCount: 1 });
      return bytes;
    });
    await sweepOrphanAnnotations(host());
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(setHandle).not.toHaveBeenCalled();
    expect(isBusy()).toBe(false);
  });

  it('mounts nothing when an operation replaced the working version meanwhile', async () => {
    mocks.materializeBase.mockImplementation(async () => {
      session.applyOperation({
        tabId: tab.id,
        bytes: new Uint8Array([5]),
        pageCount: 2,
        labelKey: 'ann.engineEdit',
        engine: 'pdfjs',
        steps: [],
        overlays: {},
      });
      return bytes;
    });
    await sweepOrphanAnnotations(host());
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
  });

  it('mounts nothing and says nothing when the user cancelled', async () => {
    mocks.materializeBase.mockImplementation(async () => {
      cancel.current?.abort();
      return bytes;
    });
    await sweepOrphanAnnotations(host());
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
    expect(isBusy()).toBe(false);
  });

  it('stays silent about a failure that came from a cancel', async () => {
    mocks.materializeBase.mockImplementation(async () => {
      cancel.current?.abort();
      throw new Error('aborted');
    });
    await sweepOrphanAnnotations(host());
    expect(notice()).toBeNull();
  });

  it('says why a refused write failed, with its hint', async () => {
    const failure = new ToolError('write-failed', { engine: 'mupdf' });
    mocks.applyProducedBytes.mockRejectedValue(failure);
    await sweepOrphanAnnotations(host());
    expect(notice()).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    expect(isBusy()).toBe(false);
    expect(cancel.current).toBeNull();
  });

  it('reports anything unexpected as an internal error', async () => {
    mocks.materializeBase.mockRejectedValue(new Error('boom'));
    await sweepOrphanAnnotations(host());
    const internal = new ToolError('internal', { engine: 'model' });
    expect(notice()).toBe(`${t(internal.messageKey)} ${t(internal.hintKey)}`);
  });

  it('leaves the lock to whoever took it if the controller was replaced', async () => {
    const other = new AbortController();
    mocks.materializeBase.mockImplementation(async () => {
      cancel.current = other;
      return bytes;
    });
    await sweepOrphanAnnotations(host());
    expect(cancel.current).toBe(other);
    expect(isBusy()).toBe(true);
  });
});
