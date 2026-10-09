/**
 * The one write into a file annotation. The session and the stores are real; the fakes are the
 * engine handle and the two operations that would drive it, so every assertion is about the exact
 * calls the handler makes into the session, the operations and the shell.
 */

import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Operations from '../../operations';
import { pendingOverlays } from '../../operations';
import {
  cancelOperation,
  clearNotice,
  coreStore,
  isBusy,
  operationRunning,
  setBusy,
} from '../core/core-store';
import { dropHandle, handleFor } from '../core/handles';
import { selectionStore } from '../selection/selection-store';
import { writeFileAnnotation } from './file-annotation';
import { deferred, type MarksWorld, marksWorld, setEditable, t, tick } from './marks-fixtures';

const mocks = vi.hoisted(() => ({ applyProducedBytes: vi.fn(), materializeBase: vi.fn() }));

vi.mock('../../operations', async (importOriginal) => ({
  ...(await importOriginal<typeof Operations>()),
  ...mocks,
}));

const produced = { name: 'produced' };
const base = new Uint8Array([4, 5]);
const label = { key: 'sig.placed', params: { kind: 'Signature' } } as const;
const outcome = (annotationId?: string) => ({
  bytes: new Uint8Array([8]),
  report: { pageCount: 2, engine: 'mupdf', steps: ['stamp'] },
  ...(annotationId === undefined ? {} : { annotationId }),
});
const notice = () => coreStore.get().notice;

let world: MarksWorld;
const write = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.applyProducedBytes.mockResolvedValue(produced);
  mocks.materializeBase.mockImplementation(async (_context, _options, steps: { id: string }[]) => {
    steps.push({ id: 'flatten' });
    return base;
  });
  write.mockResolvedValue(outcome('stamp-1'));
  world = marksWorld();
});
afterEach(() => dropHandle(world.tab.id));

describe('what does not start', () => {
  it('declines quietly without a tab or without its engine handle', () => {
    dropHandle(world.tab.id);
    expect(writeFileAnnotation(world.host, label, write, 'done')).toBe(false);
    world.session.closeTab(world.tab.id);
    expect(writeFileAnnotation(world.host, label, write, 'done')).toBe(false);
    expect(coreStore.get().notice).not.toBe(t('op.busy'));
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses out loud while the document is held, or when it is read-only', () => {
    const refused = () => {
      expect(writeFileAnnotation(world.host, label, write, 'done')).toBe(false);
      expect(coreStore.get().notice).toBe(t('op.busy'));
      clearNotice();
    };
    setBusy(true);
    refused();
    setBusy(false);
    coreStore.set({ operation: new AbortController() });
    refused();
    coreStore.set({ operation: null });
    setEditable(world, false);
    refused();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('a write that goes through', () => {
  it('writes into the base without the pending marks and mounts the result with them', async () => {
    const checkpoint = deferred<boolean>();
    world.host.checkpointEngineValues.mockReturnValue(checkpoint.promise);
    expect(writeFileAnnotation(world.host, label, write, 'Signature placed', 1)).toBe(true);
    expect(isBusy()).toBe(true);
    expect(coreStore.get().operation).toBeInstanceOf(AbortController);
    checkpoint.resolve(true);
    await vi.waitFor(() => expect(notice()).toBe('Signature placed'));
    const before = pendingOverlays(world.session.active);
    expect(mocks.materializeBase).toHaveBeenCalledWith(
      expect.objectContaining({ handle: world.handle }),
      { signal: expect.any(AbortSignal) },
      expect.any(Array),
      { ...before, annotations: [], measures: [] },
    );
    expect(write).toHaveBeenCalledWith(base, expect.any(AbortSignal));
    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      expect.objectContaining({ handle: world.handle }),
      outcome().bytes,
      2,
      label,
      'mupdf',
      ['flatten', 'stamp'],
      { signal: expect.any(AbortSignal) },
      before,
    );
    expect(handleFor(world.tab.id)).toBe(produced);
    expect(selectionStore.get().afterWrite).toBe('existing:1:stamp-1');
    await tick();
    expect(isBusy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('selects nothing when the write names no annotation or the caller asked for no page', async () => {
    write.mockResolvedValueOnce(outcome());
    writeFileAnnotation(world.host, label, write, 'first', 0);
    await vi.waitFor(() => expect(notice()).toBe('first'));
    await tick();
    // The viewer now shows the handle the first write produced.
    setEditable(world, true, handleFor(world.tab.id));
    writeFileAnnotation(world.host, label, write, 'second');
    await vi.waitFor(() => expect(notice()).toBe('second'));
    expect(selectionStore.get().afterWrite).toBeNull();
  });

  it('writes nothing when Cancel aborted the operation during the checkpoint', async () => {
    world.host.checkpointEngineValues.mockImplementation(async () => {
      cancelOperation();
      return true;
    });
    writeFileAnnotation(world.host, label, write, 'done');
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(write).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('writes nothing when another tab became active during the checkpoint', async () => {
    world.host.checkpointEngineValues.mockImplementation(async () => {
      world.session.openDocument({ name: 'b.pdf', bytes: new Uint8Array([4]), sha256: 'b', pageCount: 1 });
      return true;
    });
    writeFileAnnotation(world.host, label, write, 'done');
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(write).not.toHaveBeenCalled();
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
    writeFileAnnotation(world.host, label, write, 'done');
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(write).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('says what went wrong when the write fails with a known error', async () => {
    write.mockRejectedValue(new ToolError('write-failed', { engine: 'mupdf' }));
    writeFileAnnotation(world.host, label, write, 'done');
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    const failure = new ToolError('write-failed', { engine: 'mupdf' });
    expect(notice()).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    expect(handleFor(world.tab.id)).toBe(world.handle);
  });

  it('reports an unexpected failure as an internal error', async () => {
    write.mockRejectedValue(new Error('boom'));
    writeFileAnnotation(world.host, label, write, 'done');
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    const failure = new ToolError('internal', { engine: 'model' });
    expect(notice()).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
  });

  it('stays silent about a failure caused by Cancel', async () => {
    write.mockImplementation(async () => {
      cancelOperation();
      throw new Error('aborted');
    });
    writeFileAnnotation(world.host, label, write, 'done');
    await vi.waitFor(() => expect(isBusy()).toBe(false));
    expect(notice()).toBeNull();
  });

  it('leaves the lock to whoever took it over', async () => {
    const other = new AbortController();
    write.mockImplementation(async () => {
      coreStore.set({ operation: other });
      throw new Error('boom');
    });
    writeFileAnnotation(world.host, label, write, 'done');
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    await tick();
    expect(coreStore.get().operation).toBe(other);
    expect(isBusy()).toBe(true);
  });
});
