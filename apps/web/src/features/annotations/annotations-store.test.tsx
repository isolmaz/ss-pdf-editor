// @vitest-environment happy-dom
/**
 * What the annotation feature keeps: the tool style (a change is one notification, a repeat is
 * none), the engine values a draft restored, the file's own annotations, and the sweep in flight.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { ExistingAnnotation } from 'pdf-core';
import type { EngineValuesDraft } from 'pdf-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  annotationsStore,
  chooseAuthor,
  chooseStyle,
  existingAnnotationsRead,
  heldEngineValues,
  holdEngineValues,
  initialAnnotationsState,
  knownExistingAnnotations,
  orphanSweepInFlight,
  orphanSweepSettled,
  orphanSweepStarted,
  releaseEngineValues,
  useAnnotationAuthor,
  useToolStyle,
} from './annotations-store';

const draft = (dropped = 0): EngineValuesDraft => ({ entries: [], dropped });

beforeEach(() => {
  localStorage.clear();
  annotationsStore.set(initialAnnotationsState());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the annotation styles', () => {
  it('start per tool: a translucent marker, solid underline, ink and shapes, a yellow note, black text', () => {
    const { styles } = annotationsStore.get();
    expect(styles.highlight).toEqual({ color: '#ffd400', opacity: 0.4, thickness: 2, fontSize: 12 });
    expect(styles.measure).toEqual(styles.highlight);
    for (const tool of ['underline', 'strikeout', 'squiggly', 'ink', 'shapes', 'note', 'freetext'] as const) {
      expect(styles[tool].opacity, tool).toBe(1);
    }
    expect(styles.note.color).toBe('#ffd400');
    expect(styles.freetext.color).toBe('#000000');
    expect(styles.ink.color).not.toBe(styles.highlight.color);
    expect(annotationsStore.get().author).toBe('');
  });

  it('changes one value of one tool and leaves its other values and every other tool as they were', () => {
    const before = annotationsStore.get().styles;
    chooseStyle('ink', { color: '#ff0000' });
    chooseStyle('ink', { opacity: 0.9, thickness: 5 });
    chooseStyle('freetext', { fontSize: 18 });
    chooseAuthor('Ada');
    const { styles, author } = annotationsStore.get();
    expect(styles.ink).toEqual({ ...before.ink, color: '#ff0000', opacity: 0.9, thickness: 5 });
    expect(styles.freetext).toEqual({ ...before.freetext, fontSize: 18 });
    expect(styles.highlight).toBe(before.highlight);
    expect(styles.shapes).toBe(before.shapes);
    expect(author).toBe('Ada');
  });

  it('remembers the styles: a store started after a change reads them back', async () => {
    chooseStyle('shapes', { color: '#00ff00', thickness: 7 });
    vi.resetModules();
    const fresh = await import('./annotations-store');
    expect(fresh.annotationsStore.get().styles.shapes).toMatchObject({ color: '#00ff00', thickness: 7 });
    expect(fresh.annotationsStore.get().styles.highlight).toEqual(annotationsStore.get().styles.highlight);
  });

  it('writes the styles only when a value really changed', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem });
    chooseStyle('ink', { color: '#123456' });
    chooseStyle('ink', { color: '#123456' });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(setItem.mock.calls[0]?.[1] as string).ink.color).toBe('#123456');
  });

  it('re-renders a reader of one tool only when that tool`s style changed', () => {
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return useToolStyle('ink');
    });
    const first = result.current;
    act(() => chooseStyle('ink', { color: first.color }));
    act(() => chooseStyle('highlight', { color: '#123456' }));
    expect(result.current).toBe(first);
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => chooseStyle('ink', { color: '#654321' }));
    expect(result.current.color).toBe('#654321');
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it('keeps the author apart from the styles, and lets a component read it', () => {
    const { result } = renderHook(() => useAnnotationAuthor());
    act(() => chooseAuthor('Grace'));
    expect(result.current).toBe('Grace');
  });

  it('remembers the author: a store started after a change starts with it', async () => {
    chooseAuthor('Grace');
    vi.resetModules();
    const fresh = await import('./annotations-store');
    expect(fresh.annotationsStore.get().author).toBe('Grace');
  });
});

describe('the file`s own annotations', () => {
  it('are unknown until a read says what they are, and unknown again when it is dropped', () => {
    expect(knownExistingAnnotations()).toBeNull();
    const found = [{ id: 'a' }] as unknown as readonly ExistingAnnotation[];
    existingAnnotationsRead(found);
    expect(knownExistingAnnotations()).toBe(found);
    existingAnnotationsRead(null);
    expect(knownExistingAnnotations()).toBeNull();
  });
});

describe('engine values waiting for a viewer', () => {
  it('are kept per tab and handed back until the viewer takes them', () => {
    const a = draft(1);
    const b = draft(2);
    holdEngineValues('a', a);
    holdEngineValues('b', b);
    expect(heldEngineValues('a')).toBe(a);
    expect(heldEngineValues('b')).toBe(b);
    releaseEngineValues('a');
    expect(heldEngineValues('a')).toBeUndefined();
    expect(heldEngineValues('b')).toBe(b);
  });

  it('replace the copy a tab held, and holding none forgets it', () => {
    holdEngineValues('a', draft(1));
    holdEngineValues('a', draft(2));
    expect(heldEngineValues('a')?.dropped).toBe(2);
    holdEngineValues('a', undefined);
    expect(heldEngineValues('a')).toBeUndefined();
  });

  it('say nothing when there is nothing to release', () => {
    const listener = vi.fn();
    const stop = annotationsStore.subscribe(listener);
    releaseEngineValues('never-held');
    holdEngineValues('never-held', undefined);
    stop();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the orphan sweep in flight', () => {
  it('is the one started, until it settles', () => {
    expect(orphanSweepInFlight()).toBeNull();
    const sweep = Promise.resolve();
    orphanSweepStarted(sweep);
    expect(orphanSweepInFlight()).toBe(sweep);
    orphanSweepSettled(sweep);
    expect(orphanSweepInFlight()).toBeNull();
  });

  it('is not cleared by an older sweep settling after a newer one started', () => {
    const older = Promise.resolve();
    const newer = Promise.resolve();
    orphanSweepStarted(older);
    orphanSweepStarted(newer);
    orphanSweepSettled(older);
    expect(orphanSweepInFlight()).toBe(newer);
  });
});
