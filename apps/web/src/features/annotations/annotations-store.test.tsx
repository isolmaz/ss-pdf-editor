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
  chooseColor,
  chooseFontSize,
  chooseOpacity,
  chooseTextColor,
  chooseThickness,
  existingAnnotationsRead,
  heldEngineValues,
  holdEngineValues,
  initialAnnotationsState,
  knownExistingAnnotations,
  orphanSweepInFlight,
  orphanSweepSettled,
  orphanSweepStarted,
  releaseEngineValues,
  useAnnotationStyle,
  useAnnotations,
} from './annotations-store';

const draft = (dropped = 0): EngineValuesDraft => ({ entries: [], dropped });

beforeEach(() => annotationsStore.set(initialAnnotationsState()));
afterEach(cleanup);

describe('the annotation style', () => {
  it('starts as the marker a first-time user gets', () => {
    expect(annotationsStore.get().style).toEqual({
      color: '#ffd400',
      textColor: '#000000',
      fontSize: 12,
      opacity: 0.4,
      thickness: 2,
      author: '',
    });
  });

  it('changes one value at a time and leaves the others as they were', () => {
    chooseColor('#ff0000');
    chooseTextColor('#00ff00');
    chooseFontSize(18);
    chooseOpacity(0.9);
    chooseThickness(5);
    chooseAuthor('Ada');
    expect(annotationsStore.get().style).toEqual({
      color: '#ff0000',
      textColor: '#00ff00',
      fontSize: 18,
      opacity: 0.9,
      thickness: 5,
      author: 'Ada',
    });
  });

  it('re-renders a reader only when a value really changed', () => {
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return useAnnotationStyle();
    });
    const first = result.current;
    act(() => chooseColor('#ffd400'));
    expect(result.current).toBe(first);
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => chooseColor('#123456'));
    expect(result.current.color).toBe('#123456');
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it('lets a component select any part of the state', () => {
    const { result } = renderHook(() => useAnnotations((state) => state.style.author));
    act(() => chooseAuthor('Grace'));
    expect(result.current).toBe('Grace');
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
