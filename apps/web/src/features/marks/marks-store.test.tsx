// @vitest-environment happy-dom
/** The marks store: the published targets, and that a component reading them renders for them. */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existingTarget, redactionTarget } from './marks-fixtures';
import {
  currentMarkTargets,
  initialMarksState,
  marksStore,
  markTargetsPublished,
  useMarks,
} from './marks-store';

beforeEach(() => marksStore.set(initialMarksState()));
afterEach(cleanup);

describe('the marks store', () => {
  it('starts with no targets', () => {
    expect(currentMarkTargets()).toEqual([]);
  });

  it('holds the targets that were published last', () => {
    const targets = [redactionTarget('r1'), existingTarget('e1')];
    markTargetsPublished(targets);
    expect(currentMarkTargets()).toBe(targets);
  });

  it('renders a component reading the targets whenever they change', () => {
    function Count() {
      const count = useMarks((state) => state.targets.length);
      return <p>{count} marks</p>;
    }
    render(<Count />);
    expect(screen.getByText('0 marks')).toBeTruthy();
    act(() => markTargetsPublished([redactionTarget('r1'), redactionTarget('r2')]));
    expect(screen.getByText('2 marks')).toBeTruthy();
  });
});
