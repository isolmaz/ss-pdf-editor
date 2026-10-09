/**
 * The writer pipeline: what is journaled and said after a MuPDF writer ran, and the layers
 * panel's write. The session and the stores are real; the fakes are the engine handle and the
 * operations that would drive it, so every assertion is about the exact calls made into them.
 */

import type { OperationOutcome } from 'pdf-core';
import type { OperationNote } from 'pdf-core/ops/types';
import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Operations from '../../operations';
import { coreStore, isBusy, setBusy } from '../core/core-store';
import { dropHandle } from '../core/handles';
import { type MarksWorld, marksWorld, t } from './marks-fixtures';
import { applyWriterOutcome, writeLayers } from './writer';

const mocks = vi.hoisted(() => ({
  applyProducedBytes: vi.fn(),
  materializeBase: vi.fn(),
  applyLayerWrite: vi.fn(),
}));

vi.mock('../../operations', async (importOriginal) => ({
  ...(await importOriginal<typeof Operations>()),
  applyProducedBytes: mocks.applyProducedBytes,
  materializeBase: mocks.materializeBase,
}));
vi.mock('../../lazy-ops', () => ({ applyLayerWrite: mocks.applyLayerWrite }));

const produced = { name: 'produced' };
const base = new Uint8Array([4, 5]);
const notice = () => coreStore.get().notice;

function outcome(notes: readonly OperationNote[], incremental = false): OperationOutcome {
  return {
    bytes: new Uint8Array([8]),
    report: {
      engine: 'mupdf',
      steps: ['layers'],
      notes,
      incremental,
      pageCount: 2,
      inputBytes: 1,
      outputBytes: 1,
    },
  };
}

let world: MarksWorld;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.applyProducedBytes.mockResolvedValue(produced);
  mocks.materializeBase.mockResolvedValue(base);
  world = marksWorld();
});
afterEach(() => dropHandle(world.tab.id));

describe('applyWriterOutcome', () => {
  it('says the label and journals nothing when the writer gave the same bytes back', async () => {
    await applyWriterOutcome(world.host, world.tab, world.handle, outcome([], true), 'panel.layers');
    expect(notice()).toBe(t('panel.layers'));
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(world.host.setHandle).not.toHaveBeenCalled();
  });

  it('says the first note that is not merely preserved when the writer changed nothing', async () => {
    const notes: OperationNote[] = [
      { kind: 'preserved', key: 'ann.remove' },
      { kind: 'warning', key: 'ann.removed', params: { count: 3 } },
    ];
    await applyWriterOutcome(world.host, world.tab, world.handle, outcome(notes, true), 'panel.layers');
    expect(notice()).toBe(t('ann.removed', { count: 3 }));
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
  });

  it('says a note that carries no parameters', async () => {
    await applyWriterOutcome(
      world.host,
      world.tab,
      world.handle,
      outcome([{ kind: 'lost', key: 'ann.remove' }], true),
      'panel.layers',
    );
    expect(notice()).toBe(t('ann.remove'));
  });

  it('journals the produced bytes, swaps the handle and says the label', async () => {
    const result = outcome([{ kind: 'preserved', key: 'ann.remove' }]);
    await applyWriterOutcome(world.host, world.tab, world.handle, result, 'panel.layers');
    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      expect.objectContaining({ tab: world.tab, handle: world.handle }),
      result.bytes,
      2,
      { key: 'panel.layers' },
      'mupdf',
      ['layers'],
    );
    expect(world.host.setHandle).toHaveBeenCalledWith(world.tab.id, produced);
    expect(notice()).toBe(t('panel.layers'));
  });

  it('says every note the report is not merely preserving', async () => {
    const notes: OperationNote[] = [
      { kind: 'changed', key: 'ann.removed', params: { count: 1 } },
      { kind: 'preserved', key: 'ann.remove' },
      { kind: 'lost', key: 'ann.transform' },
    ];
    await applyWriterOutcome(world.host, world.tab, world.handle, outcome(notes), 'panel.layers');
    expect(notice()).toBe(`${t('ann.removed', { count: 1 })} ${t('ann.transform')}`);
  });
});

describe('writeLayers', () => {
  const request = { order: ['a', 'b'] };

  it('writes the working document with the layer state and journals the result', async () => {
    const result = outcome([]);
    mocks.applyLayerWrite.mockResolvedValue(result);
    await writeLayers(world.host, request);
    expect(mocks.materializeBase).toHaveBeenCalledWith(
      expect.objectContaining({ tab: world.session.active, handle: world.handle }),
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.applyLayerWrite).toHaveBeenCalledWith(base, request, { signal: expect.any(AbortSignal) });
    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      expect.anything(),
      result.bytes,
      2,
      { key: 'panel.layers' },
      'mupdf',
      ['layers'],
    );
    expect(world.host.setHandle).toHaveBeenCalledWith(world.tab.id, produced);
    expect(notice()).toBe(t('panel.layers'));
    expect(isBusy()).toBe(false);
  });

  it('does nothing without a tab or without its engine handle', async () => {
    dropHandle(world.tab.id);
    await writeLayers(world.host, request);
    world.session.closeTab(world.tab.id);
    await writeLayers(world.host, request);
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(world.host.refuseBusy).not.toHaveBeenCalled();
  });

  it('refuses while another operation holds the document', async () => {
    setBusy(true);
    await writeLayers(world.host, request);
    expect(world.host.refuseBusy).toHaveBeenCalledTimes(1);
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(isBusy()).toBe(true);
  });

  it('says what went wrong when the write fails with a known error, and releases the lock', async () => {
    mocks.applyLayerWrite.mockRejectedValue(new ToolError('write-failed', { engine: 'mupdf' }));
    await writeLayers(world.host, request);
    const failure = new ToolError('write-failed', { engine: 'mupdf' });
    expect(notice()).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    expect(isBusy()).toBe(false);
    expect(world.host.setHandle).not.toHaveBeenCalled();
  });

  it('reports an unexpected failure as an internal error', async () => {
    mocks.materializeBase.mockRejectedValue(new Error('boom'));
    await writeLayers(world.host, request);
    const failure = new ToolError('internal', { engine: 'model' });
    expect(notice()).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    expect(isBusy()).toBe(false);
  });
});
