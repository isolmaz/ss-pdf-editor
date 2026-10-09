// @vitest-environment happy-dom
/** The open handlers bound to the shell: rebuilt only when what they run on changes. */

import { renderHook } from '@testing-library/react';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { describe, expect, it, vi } from 'vitest';
import type { OpenDeps } from './open-actions';
import { useOpenActions } from './use-open-actions';

const deps = (): OpenDeps => ({
  session: new SessionStore(),
  t: createTranslator('en'),
  tier: 'desktop',
  cancelRef: { current: null },
  refuseBusy: vi.fn(),
  setCurrentPage: vi.fn(),
  setRedactionMarks: vi.fn(),
});

describe('useOpenActions', () => {
  it('offers every open handler', () => {
    const { result } = renderHook(() => useOpenActions(deps()));
    expect(Object.keys(result.current).sort()).toEqual([
      'convertAndOpen',
      'openFile',
      'openFilesFromSurface',
      'openFromSurface',
      'openProducedTab',
      'openViaPicker',
      'selectRecent',
    ]);
  });

  it('keeps the same handlers across renders that change nothing they run on', () => {
    const fixed = deps();
    const { result, rerender } = renderHook(() => useOpenActions(fixed));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('rebuilds them when the translator changes', () => {
    const fixed = deps();
    const { result, rerender } = renderHook(
      ({ locale }) => useOpenActions({ ...fixed, t: createTranslator(locale) }),
      {
        initialProps: { locale: 'en' as 'en' | 'tr' },
      },
    );
    const first = result.current;
    rerender({ locale: 'tr' });
    expect(result.current).not.toBe(first);
  });
});
