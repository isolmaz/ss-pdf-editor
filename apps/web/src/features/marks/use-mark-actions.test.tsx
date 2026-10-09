// @vitest-environment happy-dom
/**
 * The handlers bound to the shell's host: they act on the host they were built with, and stay the
 * same functions until something they run on changes.
 */

import { cleanup, renderHook } from '@testing-library/react';
import type { OperationOutcome } from 'pdf-core';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingOverlays } from '../../operations';
import { coreStore, setBusy } from '../core/core-store';
import { dropHandle } from '../core/handles';
import { type MarksWorld, marksWorld, redactionTarget, setEditable, t } from './marks-fixtures';
import { useMarkActions, useWriterActions } from './use-mark-actions';

let world: MarksWorld;

beforeEach(() => {
  world = marksWorld();
});
afterEach(() => {
  cleanup();
  dropHandle(world.tab.id);
});

describe('useWriterActions', () => {
  it('says the label when the writer gave the same bytes back', async () => {
    const { result } = renderHook(() => useWriterActions(world.host));
    const outcome: OperationOutcome = {
      bytes: new Uint8Array([1]),
      report: {
        engine: 'mupdf',
        steps: [],
        notes: [],
        incremental: true,
        pageCount: 2,
        inputBytes: 1,
        outputBytes: 1,
      },
    };
    await result.current.applyWriterOutcome(world.tab, world.handle, outcome, 'panel.layers');
    expect(coreStore.get().notice).toBe(t('panel.layers'));
  });

  it('refuses a layer write while the document is held', async () => {
    const { result } = renderHook(() => useWriterActions(world.host));
    setBusy(true);
    await result.current.writeLayers({ order: ['a'] });
    expect(coreStore.get().notice).toBe(t('op.busy'));
  });

  it('is rebuilt only when the translator or another dependency changes', () => {
    const { result, rerender } = renderHook((host) => useWriterActions(host), { initialProps: world.host });
    const first = result.current;
    rerender(world.host);
    expect(result.current).toBe(first);
    rerender({ ...world.host, t: createTranslator('tr') });
    expect(result.current).not.toBe(first);
  });
});

describe('useMarkActions', () => {
  it('removes a pending mark through the one removal intent', () => {
    const { result } = renderHook(() => useMarkActions(world.host));
    expect(result.current.removeTargets([redactionTarget('r1').key])).toBe(true);
    expect(pendingOverlays(world.session.active).redactions.map((item) => item.id)).toEqual(['r2']);
  });

  it('moves a pending mark', () => {
    const { result } = renderHook(() => useMarkActions(world.host));
    // The file's annotations must be known before anything moves.
    const move = { dx: 5, dy: 0, rotation: 0 } as const;
    expect(result.current.transformTargets([redactionTarget('r1').key], move)).toBe(false);
    expect(pendingOverlays(world.session.active).redactions[0]?.mark.rect[0]).toBe(10);
  });

  it('refuses a file-annotation write on a read-only document', () => {
    setEditable(world, false);
    const { result } = renderHook(() => useMarkActions(world.host));
    const write = vi.fn();
    expect(result.current.writeFileAnnotation({ key: 'sig.placed' }, write, 'done')).toBe(false);
    expect(coreStore.get().notice).toBe(t('op.busy'));
    expect(write).not.toHaveBeenCalled();
  });

  it('is rebuilt only when the translator or another dependency changes', () => {
    const { result, rerender } = renderHook((host) => useMarkActions(host), { initialProps: world.host });
    const first = result.current;
    rerender(world.host);
    expect(result.current).toBe(first);
    rerender({ ...world.host, t: createTranslator('tr') });
    expect(result.current).not.toBe(first);
  });
});
