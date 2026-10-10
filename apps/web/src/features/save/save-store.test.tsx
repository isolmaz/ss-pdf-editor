// @vitest-environment happy-dom
/**
 * The save store: what each action writes, that the viewer reference reads the store at the
 * moment it is asked, and that a component reading one field renders for that field only.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDismissed,
  closeRequested,
  currentViewer,
  initialSaveState,
  isSaveLocked,
  layoutChanged,
  saveLocked,
  saveReleased,
  saveStore,
  setCurrentPage,
  useSave,
  viewerChanged,
  viewerRef,
  zoomChanged,
} from './save-store';

const api = { id: 'viewer' } as unknown as ViewerApi;

beforeEach(() => saveStore.set(initialSaveState()));
afterEach(cleanup);

describe('the save store', () => {
  it('starts unlocked, with no viewer, at 100% on the first page and no close question', () => {
    expect(saveStore.get()).toEqual({
      saveLock: false,
      viewer: null,
      zoom: 1,
      currentPage: 0,
      layoutRevision: 0,
      closeRequest: null,
      closeTrigger: null,
    });
  });

  it('takes and releases the save lock', () => {
    saveLocked();
    expect(isSaveLocked()).toBe(true);
    saveReleased();
    expect(isSaveLocked()).toBe(false);
  });

  it('holds the viewer API, which the viewer reference reads at the moment it is asked', () => {
    expect(currentViewer()).toBeNull();
    expect(viewerRef.current).toBeNull();
    viewerChanged(api);
    expect(currentViewer()).toBe(api);
    expect(viewerRef.current).toBe(api);
    viewerChanged(null);
    expect(viewerRef.current).toBeNull();
  });

  it('records the zoom and the layout changes the viewer reports', () => {
    zoomChanged(1.5);
    expect(saveStore.get().zoom).toBe(1.5);
    layoutChanged();
    layoutChanged();
    expect(saveStore.get().layoutRevision).toBe(2);
  });

  it('shows a page, or the page an update derives from the current one', () => {
    setCurrentPage(4);
    expect(saveStore.get().currentPage).toBe(4);
    setCurrentPage((page) => Math.min(page, 2));
    expect(saveStore.get().currentPage).toBe(2);
  });

  it('asks the close question with the element to give the focus back to, and ends it', () => {
    const trigger = document.createElement('button');
    closeRequested('tab-1', trigger);
    expect(saveStore.get()).toMatchObject({ closeRequest: 'tab-1', closeTrigger: trigger });
    closeDismissed();
    // The trigger stays: the focus is given back after the question has closed.
    expect(saveStore.get()).toMatchObject({ closeRequest: null, closeTrigger: trigger });
  });
});

describe('useSave', () => {
  it('re-renders a component only when the field it selects changes', () => {
    let renders = 0;
    function Zoom() {
      renders += 1;
      return <p>zoom {useSave((state) => state.zoom)}</p>;
    }
    render(<Zoom />);
    expect(screen.getByText('zoom 1')).toBeTruthy();
    const initial = renders;
    act(() => setCurrentPage(3));
    expect(renders).toBe(initial);
    act(() => zoomChanged(2));
    expect(screen.getByText('zoom 2')).toBeTruthy();
    expect(renders).toBe(initial + 1);
  });
});
