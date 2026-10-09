/**
 * What the viewer's reports mean to the session: its API arriving for a document (the file's own
 * annotations read, a draft's engine values applied) and the engine's live values checkpointed
 * into the journal — each against a real session, with the viewer and the handles as fakes.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { engineValuesNotices, failureNotices, noticeLine } from '../../notices';
import {
  annotationsStore,
  heldEngineValues,
  holdEngineValues,
  initialAnnotationsState,
} from '../annotations/annotations-store';
import { coreStore, initialCoreState } from '../core/core-store';
import { formsStore, initialFormsState } from '../forms/forms-store';
import { initialSaveState, saveStore, viewerChanged } from './save-store';
import { checkpointEngineValues, markActiveDirty, viewerReady } from './viewer-actions';

const mocks = vi.hoisted(() => ({ readAnnotations: vi.fn(), handleFor: vi.fn(), handleInUse: vi.fn() }));
vi.mock('pdf-core/ops/annotations', () => ({ readAnnotations: mocks.readAnnotations }));
vi.mock('../core/handles', () => ({ handleFor: mocks.handleFor, handleInUse: mocks.handleInUse }));

const t = createTranslator('en');
const document = { id: 'document' } as unknown as PdfDocumentHandle;
const entries = [{ key: 'city', value: 'Ankara' }];

interface FakeViewer {
  readonly api: ViewerApi;
  readonly applyEngineValues: Mock;
  readonly captureEngineValues: Mock;
  readonly getZoom: Mock;
}

function fakeViewer(): FakeViewer {
  const applyEngineValues = vi.fn(async () => 0);
  const captureEngineValues = vi.fn(async () => ({ entries: [], dropped: 0 }));
  const getZoom = vi.fn(() => 1.25);
  return {
    api: { document, applyEngineValues, captureEngineValues, getZoom } as unknown as ViewerApi,
    applyEngineValues,
    captureEngineValues,
    getZoom,
  };
}

let session: SessionStore;
let tab: SessionTab;
let takeEngineAnnotations: Mock;
const host = () => ({ session, t, takeEngineAnnotations });
/** Let every promise the code under test chained settle: microtasks only, no clock. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  formsStore.set(initialFormsState());
  annotationsStore.set(initialAnnotationsState());
  session = new SessionStore();
  tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
  takeEngineAnnotations = vi.fn(() => []);
  mocks.readAnnotations.mockResolvedValue([{ id: 'existing' }]);
  mocks.handleFor.mockReturnValue(document);
});

describe('viewerReady', () => {
  it('forgets the viewer, and the file inventory read for it, when the viewer goes away', () => {
    const viewer = fakeViewer();
    viewerChanged(viewer.api);
    formsStore.set({ existingInventory: { tabId: tab.id, bytesKey: 'source', annotations: [] } });
    viewerReady(host(), null);
    expect(saveStore.get().viewer).toBeNull();
    expect(formsStore.get().existingInventory).toBeNull();
    expect(mocks.readAnnotations).not.toHaveBeenCalled();
  });

  it('holds the API, reports the zoom, takes the engine marks over and reads the file annotations', async () => {
    const viewer = fakeViewer();
    viewerReady(host(), viewer.api);

    expect(saveStore.get()).toMatchObject({ viewer: viewer.api, zoom: 1.25 });
    expect(mocks.handleInUse).toHaveBeenCalledWith(document);
    expect(takeEngineAnnotations).toHaveBeenCalledWith(viewer.api);
    expect(mocks.readAnnotations).toHaveBeenCalledWith(document, { signal: expect.any(AbortSignal) });
    await settle();
    expect(formsStore.get().existingInventory).toEqual({
      tabId: tab.id,
      bytesKey: 'source',
      annotations: [{ id: 'existing' }],
    });
    expect(viewer.applyEngineValues).not.toHaveBeenCalled();
  });

  it('keys the inventory to the produced version once the bytes were operated on', async () => {
    session.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([2]),
      pageCount: 1,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: ['rotate'],
      overlays: null,
    });
    viewerReady(host(), fakeViewer().api);
    await settle();
    expect(formsStore.get().existingInventory?.bytesKey).toBe(session.active?.working.produced?.id);
  });

  it('drops a read that lands after the viewer moved on', async () => {
    viewerReady(host(), fakeViewer().api);
    viewerChanged(null);
    await settle();
    expect(formsStore.get().existingInventory).toBeNull();
  });

  it('reads nothing into a session with no tab, and applies nothing', async () => {
    const empty = new SessionStore();
    const viewer = fakeViewer();
    viewerReady({ session: empty, t, takeEngineAnnotations }, viewer.api);
    await settle();
    expect(formsStore.get().existingInventory).toBeNull();
    expect(viewer.applyEngineValues).not.toHaveBeenCalled();
  });

  it('treats a failed read as unknown rather than empty, and says why', async () => {
    mocks.readAnnotations.mockRejectedValueOnce(new ToolError('unsupported', { engine: 'pdfjs' }));
    viewerReady(host(), fakeViewer().api);
    await settle();
    expect(formsStore.get().existingInventory).toBeNull();
    expect(coreStore.get().notice).toBe(t(new ToolError('unsupported', { engine: 'pdfjs' }).messageKey));

    coreStore.set(initialCoreState());
    mocks.readAnnotations.mockRejectedValueOnce(new Error('boom'));
    viewerReady(host(), fakeViewer().api);
    await settle();
    expect(coreStore.get().notice).toBe(t(new ToolError('internal', { engine: 'pdfjs' }).messageKey));
  });

  it('stays quiet about a failed read the viewer has already moved on from', async () => {
    mocks.readAnnotations.mockRejectedValueOnce(new Error('boom'));
    viewerReady(host(), fakeViewer().api);
    viewerChanged(null);
    await settle();
    expect(coreStore.get().notice).toBeNull();
  });

  describe('a draft that carried engine-side values', () => {
    const pending = { entries, dropped: 0 };

    it('applies the values held for the tab, then releases them and takes the engine marks again', async () => {
      holdEngineValues(tab.id, pending as never);
      const viewer = fakeViewer();
      viewer.applyEngineValues.mockResolvedValue(1);
      viewerReady(host(), viewer.api);
      await settle();
      expect(viewer.applyEngineValues).toHaveBeenCalledWith(pending);
      expect(heldEngineValues(tab.id)).toBeUndefined();
      expect(takeEngineAnnotations).toHaveBeenCalledTimes(2);
      // A complete restoration still speaks when nothing else has.
      expect(coreStore.get().notice).toBe(
        noticeLine(engineValuesNotices({ applied: 1, carried: 1, dropped: 0 }), t),
      );
    });

    it('applies the values the tab overlay carries when nothing is held', async () => {
      session.setOverlays(tab.id, { engineValues: pending } as never, 'ann.engineEdit');
      const viewer = fakeViewer();
      viewer.applyEngineValues.mockResolvedValue(1);
      viewerReady(host(), viewer.api);
      await settle();
      expect(viewer.applyEngineValues).toHaveBeenCalledWith(pending);
    });

    it('says how much was restored when the engine took only part, or the draft dropped some', async () => {
      const partial = { entries, dropped: 0 };
      holdEngineValues(tab.id, partial as never);
      viewerReady(host(), fakeViewer().api);
      await settle();
      expect(coreStore.get().notice).toBe(
        noticeLine(engineValuesNotices({ applied: 0, carried: 1, dropped: 0 }), t),
      );

      coreStore.set(initialCoreState());
      holdEngineValues(tab.id, { entries, dropped: 2 } as never);
      const viewer = fakeViewer();
      viewer.applyEngineValues.mockResolvedValue(1);
      viewerReady(host(), viewer.api);
      await settle();
      expect(coreStore.get().notice).toBe(
        noticeLine(engineValuesNotices({ applied: 1, carried: 1, dropped: 2 }), t),
      );
    });

    it('keeps the result of an operation that already spoke when the restoration was complete', async () => {
      coreStore.set({ notice: 'Rotated.' });
      holdEngineValues(tab.id, pending as never);
      const viewer = fakeViewer();
      viewer.applyEngineValues.mockResolvedValue(1);
      viewerReady(host(), viewer.api);
      await settle();
      expect(coreStore.get().notice).toBe('Rotated.');
    });

    it('leaves the values staged when the viewer moved on before the engine took them', async () => {
      holdEngineValues(tab.id, pending as never);
      const viewer = fakeViewer();
      viewer.applyEngineValues.mockImplementation(async () => {
        viewerChanged(null);
        return 1;
      });
      viewerReady(host(), viewer.api);
      await settle();
      expect(heldEngineValues(tab.id)).toEqual(pending);
      expect(takeEngineAnnotations).toHaveBeenCalledTimes(1);
    });

    it('leaves the values staged and says so when the engine rejects them', async () => {
      holdEngineValues(tab.id, pending as never);
      const viewer = fakeViewer();
      const failure = new Error('engine');
      viewer.applyEngineValues.mockRejectedValue(failure);
      viewerReady(host(), viewer.api);
      await settle();
      expect(heldEngineValues(tab.id)).toEqual(pending);
      expect(coreStore.get().notice).toBe(
        noticeLine(failureNotices(failure, 'error.write-failed.message'), t),
      );
    });

    it('stays quiet about a rejection the viewer has already moved on from', async () => {
      holdEngineValues(tab.id, pending as never);
      const viewer = fakeViewer();
      viewer.applyEngineValues.mockImplementation(async () => {
        viewerChanged(null);
        throw new Error('engine');
      });
      viewerReady(host(), viewer.api);
      await settle();
      expect(coreStore.get().notice).toBeNull();
    });
  });
});

describe('checkpointEngineValues', () => {
  const captured = { entries, dropped: 0 };

  function attach(viewer = fakeViewer()): FakeViewer {
    viewerChanged(viewer.api);
    return viewer;
  }

  it('does nothing without a viewer, without a tab, or for a document the viewer is not showing', async () => {
    expect(await checkpointEngineValues(session)).toBe(false);
    const viewer = attach();
    expect(await checkpointEngineValues(new SessionStore())).toBe(false);
    mocks.handleFor.mockReturnValue({});
    expect(await checkpointEngineValues(session)).toBe(false);
    expect(viewer.captureEngineValues).not.toHaveBeenCalled();
  });

  it('folds new engine values into the tab overlays as one coalesced undo step', async () => {
    const viewer = attach();
    viewer.captureEngineValues.mockResolvedValue(captured);
    const setOverlays = vi.spyOn(session, 'setOverlays');

    expect(await checkpointEngineValues(session)).toBe(true);

    expect(setOverlays).toHaveBeenCalledWith(
      tab.id,
      expect.objectContaining({ engineValues: captured }),
      'ann.engineEdit',
      { coalesceWithinMs: 1500 },
    );
    expect(session.active?.dirty).toBe(true);
    // The same values again change nothing.
    expect(await checkpointEngineValues(session)).toBe(false);
    expect(setOverlays).toHaveBeenCalledTimes(1);
    // Different values replace the previous ones and keep the other overlays.
    viewer.captureEngineValues.mockResolvedValue({ entries: [], dropped: 1 });
    expect(await checkpointEngineValues(session)).toBe(true);
    expect(setOverlays).toHaveBeenLastCalledWith(
      tab.id,
      expect.objectContaining({ engineValues: { entries: [], dropped: 1 } }),
      'ann.engineEdit',
      { coalesceWithinMs: 1500 },
    );
  });

  it('records nothing when the engine holds nothing and nothing was recorded before', async () => {
    attach();
    expect(await checkpointEngineValues(session)).toBe(false);
  });

  it('drops the capture when the viewer was replaced while it was taken', async () => {
    const viewer = attach();
    viewer.captureEngineValues.mockImplementation(async () => {
      viewerChanged(null);
      return captured;
    });
    expect(await checkpointEngineValues(session)).toBe(false);
    expect(session.active?.dirty).toBe(false);
  });

  it.each([
    ['the tab was closed', (id: string) => session.closeTab(id)],
    [
      'another tab became active',
      () => session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([2]), sha256: 'b', pageCount: 1 }),
    ],
    ['the tab got another handle', () => mocks.handleFor.mockReturnValue({})],
    [
      'the bytes were operated on',
      (id: string) =>
        session.applyOperation({
          tabId: id,
          bytes: new Uint8Array([9]),
          pageCount: 1,
          labelKey: 'ann.engineEdit',
          engine: 'mupdf',
          steps: ['rotate'],
          overlays: null,
        }),
    ],
  ])('drops the capture when %s while it was taken', async (_what, change) => {
    const viewer = attach();
    viewer.captureEngineValues.mockImplementation(async () => {
      change(tab.id);
      return captured;
    });
    const setOverlays = vi.spyOn(session, 'setOverlays');
    expect(await checkpointEngineValues(session)).toBe(false);
    expect(setOverlays).not.toHaveBeenCalled();
  });
});

describe('markActiveDirty', () => {
  it('does nothing without a viewer, without a tab, or for a document the viewer is not showing', () => {
    markActiveDirty(host());
    const viewer = fakeViewer();
    viewerChanged(viewer.api);
    markActiveDirty({ session: new SessionStore(), t, takeEngineAnnotations });
    mocks.handleFor.mockReturnValue({});
    markActiveDirty(host());
    expect(takeEngineAnnotations).not.toHaveBeenCalled();
    expect(viewer.captureEngineValues).not.toHaveBeenCalled();
  });

  it('takes the engine marks over and checkpoints the engine values', async () => {
    const viewer = fakeViewer();
    viewer.captureEngineValues.mockResolvedValue({ entries, dropped: 0 });
    viewerChanged(viewer.api);
    markActiveDirty(host());
    expect(takeEngineAnnotations).toHaveBeenCalledWith(viewer.api);
    await settle();
    expect(session.active?.dirty).toBe(true);
  });

  it('says why when the checkpoint fails', async () => {
    const viewer = fakeViewer();
    viewerChanged(viewer.api);
    viewer.captureEngineValues.mockRejectedValueOnce(new ToolError('unsupported', { engine: 'pdfjs' }));
    markActiveDirty(host());
    await settle();
    expect(coreStore.get().notice).toBe(t(new ToolError('unsupported', { engine: 'pdfjs' }).messageKey));

    viewer.captureEngineValues.mockRejectedValueOnce(new Error('boom'));
    markActiveDirty(host());
    await settle();
    expect(coreStore.get().notice).toBe(t(new ToolError('internal', { engine: 'pdfjs' }).messageKey));
  });
});
