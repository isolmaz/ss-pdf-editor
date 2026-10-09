/**
 * The one removal intent. The session is the real `SessionStore` and the stores are the real ones;
 * the fakes are the engine handle and the operations that would drive it, so every assertion is
 * about the exact calls the handler makes into the session, the writer and the shell.
 */

import type { SessionTab } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Operations from '../../operations';
import { pendingOverlays } from '../../operations';
import { orphanSweepStarted } from '../annotations/annotations-store';
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
  writeMarks,
} from './marks-fixtures';
import { removeTargets } from './remove-targets';

const mocks = vi.hoisted(() => ({
  applyProducedBytes: vi.fn(),
  removeMarkTargets: vi.fn(),
  hasEngineEdits: vi.fn(),
}));

vi.mock('../../operations', async (importOriginal) => ({
  ...(await importOriginal<typeof Operations>()),
  ...mocks,
}));

const produced = { name: 'produced' };
const outcome = {
  bytes: new Uint8Array([9]),
  pageCount: 2,
  engine: 'mupdf',
  steps: ['strip'],
  overlays: { kept: 1 },
};
const notice = () => coreStore.get().notice;
const redactionIds = (tab: SessionTab | null) => pendingOverlays(tab).redactions.map((item) => item.id);

let world: MarksWorld;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hasEngineEdits.mockReturnValue(false);
  mocks.applyProducedBytes.mockResolvedValue(produced);
  mocks.removeMarkTargets.mockResolvedValue(outcome);
  world = marksWorld();
});
afterEach(() => dropHandle(world.tab.id));

describe('removing marks that are only pending', () => {
  it('takes them out of the overlay as one journal step and says how many', () => {
    expect(removeTargets(world.host, [redactionTarget('r1').key])).toBe(true);
    expect(redactionIds(world.session.active)).toEqual(['r2']);
    expect(world.session.active?.journal.entries.map((entry) => entry.labelKey).at(-1)).toBe('ann.remove');
    expect(notice()).toBe(t('ann.removed', { count: 1 }));
    expect(operationRunning()).toBe(false);
    expect(isBusy()).toBe(false);
    expect(world.host.checkpointEngineValues).not.toHaveBeenCalled();
  });

  it('removes a whole batch in a single step', () => {
    const before = world.session.active?.journal.entries.length ?? 0;
    removeTargets(world.host, [redactionTarget('r1').key, redactionTarget('r2').key]);
    expect(redactionIds(world.session.active)).toEqual([]);
    expect(world.session.active?.journal.entries.length).toBe(before + 1);
    expect(notice()).toBe(t('ann.removed', { count: 2 }));
  });

  it('does nothing for keys that name no mark', () => {
    expect(removeTargets(world.host, ['redaction:missing'])).toBe(false);
    expect(redactionIds(world.session.active)).toEqual(['r1', 'r2']);
    expect(notice()).toBeNull();
  });

  it('does nothing without a tab, without its engine handle, or on a read-only document', () => {
    setEditable(world, false);
    expect(removeTargets(world.host, [redactionTarget('r1').key])).toBe(false);
    setEditable(world, true);
    dropHandle(world.tab.id);
    expect(removeTargets(world.host, [redactionTarget('r1').key])).toBe(false);
    world.session.closeTab(world.tab.id);
    expect(removeTargets(world.host, [redactionTarget('r1').key])).toBe(false);
    expect(notice()).toBeNull();
  });
});

describe('removing while the engine holds edits', () => {
  beforeEach(() => mocks.hasEngineEdits.mockReturnValue(true));

  it('takes the document, checkpoints the engine values first, then writes the overlay', async () => {
    const checkpoint = deferred<boolean>();
    world.host.checkpointEngineValues.mockReturnValue(checkpoint.promise);
    expect(removeTargets(world.host, [redactionTarget('r1').key])).toBe(true);
    expect(isBusy()).toBe(true);
    expect(coreStore.get().operation).toBeInstanceOf(AbortController);
    expect(redactionIds(world.session.active)).toEqual(['r1', 'r2']);
    checkpoint.resolve(true);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(redactionIds(world.session.active)).toEqual(['r2']);
    expect(notice()).toBe(t('ann.removed', { count: 1 }));
    expect(operationRunning()).toBe(false);
  });

  it('declines a second removal while one holds the document', async () => {
    const checkpoint = deferred<boolean>();
    world.host.checkpointEngineValues.mockReturnValue(checkpoint.promise);
    removeTargets(world.host, [redactionTarget('r1').key]);
    expect(removeTargets(world.host, [redactionTarget('r2').key])).toBe(false);
    checkpoint.resolve(false);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
  });

  it('refuses when another operation holds the document', () => {
    coreStore.set({ operation: new AbortController() });
    expect(removeTargets(world.host, [redactionTarget('r1').key])).toBe(false);
    expect(coreStore.get().notice).toBe(t('op.busy'));
    expect(redactionIds(world.session.active)).toEqual(['r1', 'r2']);
  });

  it('waits for the orphan sweep instead of refusing, then removes', async () => {
    const sweep = deferred();
    orphanSweepStarted(sweep.promise);
    expect(removeTargets(world.host, [redactionTarget('r1').key])).toBe(true);
    expect(coreStore.get().notice).not.toBe(t('op.busy'));
    sweep.resolve();
    await vi.waitFor(() => expect(redactionIds(world.session.active)).toEqual(['r2']));
    expect(coreStore.get().notice).not.toBe(t('op.busy'));
  });

  it('refuses after the sweep when the document is held by then', async () => {
    const sweep = deferred();
    orphanSweepStarted(sweep.promise);
    expect(removeTargets(world.host, [redactionTarget('r1').key])).toBe(true);
    setBusy(true);
    sweep.resolve();
    await vi.waitFor(() => expect(coreStore.get().notice).toBe(t('op.busy')));
    expect(redactionIds(world.session.active)).toEqual(['r1', 'r2']);
    expect(operationRunning()).toBe(false);
    expect(isBusy()).toBe(true);
  });

  it('writes nothing when Cancel aborted the operation during the checkpoint', async () => {
    world.host.checkpointEngineValues.mockImplementation(async () => {
      cancelOperation();
      return true;
    });
    removeTargets(world.host, [redactionTarget('r1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(redactionIds(world.session.active)).toEqual(['r1', 'r2']);
    expect(notice()).toBeNull();
  });

  it('writes nothing when the tab was closed during the checkpoint', async () => {
    world.host.checkpointEngineValues.mockImplementation(async () => {
      world.session.closeTab(world.tab.id);
      return true;
    });
    removeTargets(world.host, [redactionTarget('r1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(notice()).toBeNull();
  });

  it('writes nothing when another tab became active during the checkpoint', async () => {
    world.host.checkpointEngineValues.mockImplementation(async () => {
      world.session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([4]), sha256: 'b', pageCount: 1 });
      return true;
    });
    removeTargets(world.host, [redactionTarget('r1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(redactionIds(world.session.getSnapshot().tabs[0] ?? null)).toEqual(['r1', 'r2']);
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
    removeTargets(world.host, [redactionTarget('r1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(redactionIds(world.session.active)).toEqual(['r1', 'r2']);
    expect(notice()).toBeNull();
  });
});

describe('removing marks the file already carries', () => {
  it('removes them with the core writer and mounts the result with the remaining overlays', async () => {
    expect(removeTargets(world.host, [existingTarget('e1').key, redactionTarget('r1').key])).toBe(true);
    await vi.waitFor(() => expect(handleFor(world.tab.id)).not.toBe(world.handle));
    expect(mocks.removeMarkTargets).toHaveBeenCalledWith(
      expect.objectContaining({ tab: expect.objectContaining({ id: world.tab.id }), handle: world.handle }),
      { annotations: [], measures: [], redactions: ['r1'], existing: [{ pageIndex: 0, id: 'e1' }] },
      { signal: expect.any(AbortSignal) },
      [],
      pendingOverlays(world.session.active),
    );
    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      expect.objectContaining({ handle: world.handle }),
      outcome.bytes,
      2,
      { key: 'ann.remove', params: { count: 2 } },
      'mupdf',
      ['strip'],
      { signal: expect.any(AbortSignal) },
      outcome.overlays,
    );
    expect(handleFor(world.tab.id)).toBe(produced);
    expect(notice()).toBe(t('ann.removed', { count: 2 }));
    await tick();
    expect(isBusy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('applies nothing when Cancel aborted the writer', async () => {
    mocks.removeMarkTargets.mockImplementation(async () => {
      cancelOperation();
      return outcome;
    });
    removeTargets(world.host, [existingTarget('e1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(handleFor(world.tab.id)).toBe(world.handle);
    expect(notice()).toBeNull();
  });

  it('applies nothing when the tab was left while the writer ran', async () => {
    mocks.removeMarkTargets.mockImplementation(async () => {
      world.session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([4]), sha256: 'b', pageCount: 1 });
      return outcome;
    });
    removeTargets(world.host, [existingTarget('e1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
  });

  it('applies nothing when the marks changed while the writer ran', async () => {
    mocks.removeMarkTargets.mockImplementation(async () => {
      writeMarks(world.session, world.tab.id, { annotations: [], measures: [], redactions: [] });
      return outcome;
    });
    removeTargets(world.host, [existingTarget('e1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('says what went wrong when the writer fails with a known error', async () => {
    mocks.removeMarkTargets.mockRejectedValue(new ToolError('write-failed', { engine: 'mupdf' }));
    removeTargets(world.host, [existingTarget('e1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    const failure = new ToolError('write-failed', { engine: 'mupdf' });
    expect(notice()).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    expect(handleFor(world.tab.id)).toBe(world.handle);
  });

  it('reports an unexpected failure as an internal error', async () => {
    mocks.removeMarkTargets.mockRejectedValue(new Error('boom'));
    removeTargets(world.host, [existingTarget('e1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    const failure = new ToolError('internal', { engine: 'model' });
    expect(notice()).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
  });

  it('stays silent about a failure caused by Cancel', async () => {
    mocks.removeMarkTargets.mockImplementation(async () => {
      cancelOperation();
      throw new Error('aborted');
    });
    removeTargets(world.host, [existingTarget('e1').key]);
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(notice()).toBeNull();
  });

  it('leaves the lock to whoever took it over', async () => {
    const other = new AbortController();
    mocks.removeMarkTargets.mockImplementation(async () => {
      coreStore.set({ operation: other });
      throw new Error('boom');
    });
    removeTargets(world.host, [existingTarget('e1').key]);
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    await tick();
    expect(coreStore.get().operation).toBe(other);
    expect(isBusy()).toBe(true);
  });
});
