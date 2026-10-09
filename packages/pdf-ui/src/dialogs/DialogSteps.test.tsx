// @vitest-environment happy-dom
/**
 * The step marker every operation dialog shows: which of the two steps the user is on, and what
 * the second one is called for the kind of result the operation produces.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DialogSteps } from './DialogSteps';
import type { DialogResultKind } from './types';

const t = createTranslator('en');

afterEach(cleanup);

function steps(step: 1 | 2, resultKind: DialogResultKind) {
  render(<DialogSteps t={t} step={step} resultKind={resultKind} />);
  return within(screen.getByRole('list')).getAllByRole('listitem');
}

describe('DialogSteps', () => {
  it('marks the settings step as current while the user is filling them in', () => {
    const [first, second] = steps(1, 'replace');
    expect(first?.textContent).toBe('1Settings');
    expect(first?.getAttribute('aria-current')).toBe('step');
    expect(second?.textContent).toBe('2Review and apply');
    expect(second?.hasAttribute('aria-current')).toBe(false);
  });

  it('marks the second step as current once there is a result', () => {
    const [first, second] = steps(2, 'replace');
    expect(first?.hasAttribute('aria-current')).toBe(false);
    expect(second?.getAttribute('aria-current')).toBe('step');
  });

  it('names the second step "Review and apply" only when the result replaces the document', () => {
    expect(steps(1, 'replace')[1]?.textContent).toBe('2Review and apply');
    cleanup();
    expect(steps(1, 'new-tab')[1]?.textContent).toBe('2Result');
    cleanup();
    expect(steps(1, 'download')[1]?.textContent).toBe('2Result');
  });
});
