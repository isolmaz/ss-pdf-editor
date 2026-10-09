// @vitest-environment happy-dom
/**
 * The common layer's targets: every family in one identity space, labelled in the user's words,
 * placed with the viewer's own page geometry, and published for the handlers that read them later.
 */

import { renderHook } from '@testing-library/react';
import { annotationKindKey } from 'pdf-core/ops/annotations';
import type { ViewerApi } from 'pdf-ui/viewer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MarkTargetsInput, useMarkTargets } from './mark-targets';
import { annotationMark, fileAnnotation, redactionMark, t } from './marks-fixtures';
import { currentMarkTargets, initialMarksState, marksStore } from './marks-store';

const viewer = {
  pageGeometry: vi.fn(() => ({ y: 10, height: 190 })),
} as unknown as ViewerApi;

function input(over: Partial<MarkTargetsInput> = {}): MarkTargetsInput {
  return { annotations: [], measures: [], redactions: [], existing: [], viewer, t, ...over };
}

beforeEach(() => marksStore.set(initialMarksState()));

describe('useMarkTargets', () => {
  it('offers no target while the file`s own annotations are unread', () => {
    const { result } = renderHook(() =>
      useMarkTargets(input({ existing: null, redactions: [redactionMark('r1')] })),
    );
    expect(result.current).toEqual([]);
    expect(currentMarkTargets()).toEqual([]);
  });

  it('describes the session`s marks and publishes them with the render that computed them', () => {
    const { result } = renderHook(() =>
      useMarkTargets(input({ annotations: [annotationMark('a1')], redactions: [redactionMark('r1')] })),
    );
    expect(result.current.map((target) => [target.key, target.family, target.label])).toEqual([
      ['annotation:a1', 'annotation', t(annotationKindKey('note'))],
      ['redaction:r1', 'redaction', t('redact.title')],
    ]);
    expect(currentMarkTargets()).toBe(result.current);
  });

  it('names a mark the file carries by its kind, or by its subtype when the kind is unknown', () => {
    const named = { ...fileAnnotation('p1'), id: 'p1', kind: 'highlight' as const, pageBox: undefined };
    const { result } = renderHook(() => useMarkTargets(input({ existing: [named, fileAnnotation('p2')] })));
    expect(result.current.map((target) => target.label)).toEqual([
      `${t(annotationKindKey('highlight'))} · ${t('ann.inFile')}`,
      `Square · ${t('ann.inFile')}`,
    ]);
  });

  it('places a mark from the viewer`s page geometry, and leaves it unplaced when it cannot say', () => {
    const unplaced = { ...fileAnnotation('p1'), pageBox: undefined };
    const placed = renderHook(() => useMarkTargets(input({ existing: [unplaced] })));
    expect(viewer.pageGeometry).toHaveBeenCalledWith(0);
    expect(placed.result.current[0]?.boxes).toEqual([[60, 110, 90, 140]]);
    const without = renderHook(() => useMarkTargets(input({ existing: [unplaced], viewer: null })));
    expect(without.result.current[0]?.boxes).toEqual([]);
    vi.mocked(viewer.pageGeometry).mockReturnValueOnce(null as never);
    const unknown = renderHook(() => useMarkTargets(input({ existing: [unplaced] })));
    expect(unknown.result.current[0]?.boxes).toEqual([]);
  });

  it('keeps the same list while what it is derived from is unchanged', () => {
    const props = input({ redactions: [redactionMark('r1')] });
    const { result, rerender } = renderHook(() => useMarkTargets(props));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
