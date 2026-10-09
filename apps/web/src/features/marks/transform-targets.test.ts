/**
 * Moving and rotating marks. The session and the stores are real; the fakes are the engine
 * handle and the operations that would drive it, so every assertion is about the exact calls the
 * handler makes into the session, the writers and the shell.
 */

import type * as AnnotationTransform from 'pdf-core/ops/annotation-transform';
import type { SessionTab } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Operations from '../../operations';
import { pendingOverlays } from '../../operations';
import { existingAnnotationsRead } from '../annotations/annotations-store';
import { cancelOperation, coreStore, isBusy, operationRunning, setBusy } from '../core/core-store';
import { dropHandle, handleFor } from '../core/handles';
import {
  deferred,
  existingTarget,
  type MarksWorld,
  marksWorld,
  redactionTarget,
  setEditable,
  t,
  tick,
} from './marks-fixtures';
import { transformTargets } from './transform-targets';

const mocks = vi.hoisted(() => ({
  applyProducedBytes: vi.fn(),
  materializeBase: vi.fn(),
  hasEngineEdits: vi.fn(),
  transformPdfAnnotations: vi.fn(),
}));

vi.mock('../../operations', async (importOriginal) => ({
  ...(await importOriginal<typeof Operations>()),
  applyProducedBytes: mocks.applyProducedBytes,
  materializeBase: mocks.materializeBase,
  hasEngineEdits: mocks.hasEngineEdits,
}));
vi.mock('pdf-core/ops/annotation-transform', async (importOriginal) => ({
  ...(await importOriginal<typeof AnnotationTransform>()),
  transformPdfAnnotations: mocks.transformPdfAnnotations,
}));

const move = { dx: 5, dy: 0, rotation: 0 } as const;
const produced = { name: 'produced' };
const base = new Uint8Array([4, 5]);
const written = { bytes: new Uint8Array([8]), report: { pageCount: 2, engine: 'mupdf', steps: ['moved'] } };
const notice = () => coreStore.get().notice;
const rects = (tab: SessionTab | null) => pendingOverlays(tab).redactions.map((item) => item.mark.rect[0]);

let world: MarksWorld;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hasEngineEdits.mockReturnValue(false);
  mocks.applyProducedBytes.mockResolvedValue(produced);
  mocks.materializeBase.mockImplementation(async (_context, _options, steps: { id: string }[]) => {
    steps.push({ id: 'flatten' });
    return base;
  });
  mocks.transformPdfAnnotations.mockResolvedValue(written);
  world = marksWorld();
  existingAnnotationsRead([]);
});
afterEach(() => dropHandle(world.tab.id));

describe('what is refused without a word', () => {
  const keys = [redactionTarget('r1').key];

  it('does nothing without a tab, an engine handle, or the file`s annotations read', () => {
    existingAnnotationsRead(null);
    expect(transformTargets(world.host, keys, move)).toBe(false);
    existingAnnotationsRead([]);
    dropHandle(world.tab.id);
    expect(transformTargets(world.host, keys, move)).toBe(false);
    world.session.closeTab(world.tab.id);
    expect(transformTargets(world.host, keys, move)).toBe(false);
    expect(notice()).toBeNull();
  });

  it('does nothing while the document is held, or when it is read-only', () => {
    setBusy(true);
    expect(transformTargets(world.host, keys, move)).toBe(false);
    setBusy(false);
    coreStore.set({ operation: new AbortController() });
    expect(transformTargets(world.host, keys, move)).toBe(false);
    coreStore.set({ operation: null });
    setEditable(world, false);
    expect(transformTargets(world.host, keys, move)).toBe(false);
    expect(rects(world.session.active)).toEqual([10, 10]);
    expect(coreStore.get().notice).not.toBe(t('op.busy'));
  });

  it('does nothing for an edit that moves nothing, or keys that name no mark', () => {
    expect(transformTargets(world.host, keys, { dx: 0, dy: 0, rotation: 0 })).toBe(false);
    expect(transformTargets(world.host, ['redaction:missing'], move)).toBe(false);
    expect(rects(world.session.active)).toEqual([10, 10]);
    expect(notice()).toBeNull();
  });
});

describe('moving marks that are only pending', () => {
  it('rewrites the moved mark alone, as one journal step, and says how many moved', () => {
    const untouched = pendingOverlays(world.session.active).redactions[1];
    expect(transformTargets(world.host, [redactionTarget('r1').key], move)).toBe(true);
    const after = pendingOverlays(world.session.active).redactions;
    expect(after[0]?.mark.rect[0]).toBe(15);
    expect(after[1]).toBe(untouched);
    expect(world.session.active?.journal.entries.map((entry) => entry.labelKey).at(-1)).toBe('ann.transform');
    expect(notice()).toBe(t('ann.transformed', { count: 1 }));
    expect(isBusy()).toBe(false);
    expect(operationRunning()).toBe(false);
    expect(world.host.checkpointEngineValues).not.toHaveBeenCalled();
  });

  it('rotates a quarter turn', () => {
    const turn = { dx: 0, dy: 0, rotation: 90 } as const;
    expect(transformTargets(world.host, [redactionTarget('r1').key], turn)).toBe(true);
    expect(pendingOverlays(world.session.active).redactions[0]?.mark.rect).not.toEqual([10, 10, 50, 30]);
  });

  it('checkpoints the engine values first when the engine holds edits', async () => {
    mocks.hasEngineEdits.mockReturnValue(true);
    const checkpoint = deferred<boolean>();
    world.host.checkpointEngineValues.mockReturnValue(checkpoint.promise);
    expect(transformTargets(world.host, [redactionTarget('r1').key], move)).toBe(true);
    expect(isBusy()).toBe(true);
    expect(rects(world.session.active)).toEqual([10, 10]);
    checkpoint.resolve(true);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(rects(world.session.active)).toEqual([15, 10]);
    expect(notice()).toBe(t('ann.transformed', { count: 1 }));
    expect(operationRunning()).toBe(false);
    expect(mocks.materializeBase).not.toHaveBeenCalled();
  });
});

describe('moving marks the file already carries', () => {
  const keys = [existingTarget('e1').key, redactionTarget('r1').key];

  it('moves them with the core writer and mounts the result with the moved overlays', async () => {
    expect(transformTargets(world.host, keys, move)).toBe(true);
    await vi.waitFor(() => expect(handleFor(world.tab.id)).not.toBe(world.handle));
    const before = pendingOverlays(world.session.active);
    expect(mocks.materializeBase).toHaveBeenCalledWith(
      expect.objectContaining({ handle: world.handle }),
      { signal: expect.any(AbortSignal) },
      expect.any(Array),
      { ...before, annotations: [], measures: [] },
    );
    expect(mocks.transformPdfAnnotations).toHaveBeenCalledWith(
      base,
      { targets: [{ pageIndex: 0, id: 'e1' }], transform: move },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      expect.objectContaining({ handle: world.handle }),
      written.bytes,
      2,
      { key: 'ann.transform' },
      'mupdf',
      ['flatten', 'moved'],
      { signal: expect.any(AbortSignal) },
      expect.objectContaining({ redactions: [expect.objectContaining({ id: 'r1' }), before.redactions[1]] }),
    );
    expect(handleFor(world.tab.id)).toBe(produced);
    expect(notice()).toBe(t('ann.transformed', { count: 2 }));
    await tick();
    expect(isBusy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('writes nothing when Cancel aborted the operation during the checkpoint', async () => {
    world.host.checkpointEngineValues.mockImplementation(async () => {
      cancelOperation();
      return true;
    });
    transformTargets(world.host, keys, move);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(mocks.transformPdfAnnotations).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('writes nothing when another tab became active during the checkpoint', async () => {
    world.host.checkpointEngineValues.mockImplementation(async () => {
      world.session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([4]), sha256: 'b', pageCount: 1 });
      return true;
    });
    transformTargets(world.host, keys, move);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(mocks.transformPdfAnnotations).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('writes nothing when the bytes changed during the checkpoint', async () => {
    world.host.checkpointEngineValues.mockImplementation(async () => {
      world.session.applyOperation({
        tabId: world.tab.id,
        bytes: new Uint8Array([7]),
        pageCount: 2,
        labelKey: 'panel.layers',
        engine: 'mupdf',
        steps: [],
        overlays: pendingOverlays(world.session.active) as never,
      });
      return true;
    });
    transformTargets(world.host, keys, move);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(mocks.transformPdfAnnotations).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('says what went wrong when the writer fails with a known error', async () => {
    mocks.transformPdfAnnotations.mockRejectedValue(new ToolError('write-failed', { engine: 'mupdf' }));
    transformTargets(world.host, keys, move);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    const failure = new ToolError('write-failed', { engine: 'mupdf' });
    expect(notice()).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    expect(handleFor(world.tab.id)).toBe(world.handle);
  });

  it('reports an unexpected failure as an internal error', async () => {
    mocks.transformPdfAnnotations.mockRejectedValue(new Error('boom'));
    transformTargets(world.host, keys, move);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    const failure = new ToolError('internal', { engine: 'model' });
    expect(notice()).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
  });

  it('stays silent about a failure caused by Cancel', async () => {
    mocks.transformPdfAnnotations.mockImplementation(async () => {
      cancelOperation();
      throw new Error('aborted');
    });
    transformTargets(world.host, keys, move);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(notice()).toBeNull();
  });

  it('leaves the lock to whoever took it over', async () => {
    const other = new AbortController();
    mocks.transformPdfAnnotations.mockImplementation(async () => {
      coreStore.set({ operation: other });
      throw new Error('boom');
    });
    transformTargets(world.host, keys, move);
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    await tick();
    expect(coreStore.get().operation).toBe(other);
    expect(isBusy()).toBe(true);
  });
});
