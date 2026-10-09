// @vitest-environment happy-dom
/**
 * The compact-viewport watcher: a crossing of the breakpoint reaches the core store (closing
 * both docks on narrowing), and the hook stops watching when the shell unmounts.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreStore, showLeftDock, showRightDock } from './core-store';
import { useCompactViewport, watchCompactViewport } from './viewport';

/** A media query list the test can flip, with the `change` event a browser fires. */
function fakeMedia() {
  const target = new EventTarget();
  const media = Object.assign(target, { matches: false }) as EventTarget & { matches: boolean };
  return {
    media: media as unknown as MediaQueryList,
    cross(matches: boolean) {
      media.matches = matches;
      target.dispatchEvent(new Event('change'));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('watchCompactViewport', () => {
  it('reports each crossing to the store, and stops when told to', () => {
    const { media, cross } = fakeMedia();
    showLeftDock();
    showRightDock();
    const stop = watchCompactViewport(media);

    cross(true);
    expect(coreStore.get()).toMatchObject({ compactViewport: true, leftDock: false, rightDock: false });

    showLeftDock();
    cross(false);
    expect(coreStore.get()).toMatchObject({ compactViewport: false, leftDock: true });

    stop();
    cross(true);
    expect(coreStore.get().compactViewport).toBe(false);
  });
});

describe('useCompactViewport', () => {
  it('watches the window’s compact query while mounted', () => {
    const { media, cross } = fakeMedia();
    const query = vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    function Shell() {
      useCompactViewport();
      return null;
    }
    const { unmount } = render(<Shell />);
    expect(query).toHaveBeenCalledWith('(max-width: 1023px)');

    cross(true);
    expect(coreStore.get().compactViewport).toBe(true);

    unmount();
    cross(false);
    expect(coreStore.get().compactViewport).toBe(true);
  });
});
