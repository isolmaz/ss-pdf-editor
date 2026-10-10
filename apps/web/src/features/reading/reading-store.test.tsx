// @vitest-environment happy-dom
/**
 * The reading store: what each action writes, and that a component reading one field renders
 * for that field only.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeReading,
  closeSnapshot,
  openSnapshot,
  readingStore,
  setDocumentLanguage,
  setLensZoom,
  toggleMagnifier,
  toggleReading,
  useReading,
} from './reading-store';

const initial = readingStore.get();
beforeEach(() => readingStore.set(initial));
afterEach(cleanup);

describe('the reading store', () => {
  it('starts with everything closed, the lens at 4× and no language', () => {
    expect(initial).toEqual({
      reading: false,
      snapshotOpen: false,
      magnifierOn: false,
      lensZoom: 4,
      documentLanguage: null,
    });
  });

  it('opens and closes the reading pane from any route', () => {
    toggleReading();
    expect(readingStore.get().reading).toBe(true);
    toggleReading();
    expect(readingStore.get().reading).toBe(false);
    toggleReading();
    closeReading();
    expect(readingStore.get().reading).toBe(false);
  });

  it('opens and closes the snapshot menu', () => {
    openSnapshot();
    expect(readingStore.get().snapshotOpen).toBe(true);
    closeSnapshot();
    expect(readingStore.get().snapshotOpen).toBe(false);
  });

  it('toggles the magnifier and sets its magnification', () => {
    toggleMagnifier();
    setLensZoom(6);
    expect(readingStore.get()).toMatchObject({ magnifierOn: true, lensZoom: 6 });
    toggleMagnifier();
    expect(readingStore.get().magnifierOn).toBe(false);
  });

  it('keeps the language the document declares, and forgets it', () => {
    setDocumentLanguage('de');
    expect(readingStore.get().documentLanguage).toBe('de');
    setDocumentLanguage(null);
    expect(readingStore.get().documentLanguage).toBeNull();
  });
});

describe('useReading', () => {
  it('renders the selected field and not the others', () => {
    const renders: boolean[] = [];
    function Pane() {
      const reading = useReading((state) => state.reading);
      renders.push(reading);
      return <output>{String(reading)}</output>;
    }
    render(<Pane />);

    act(() => toggleMagnifier());
    act(() => setDocumentLanguage('fr'));
    expect(renders).toEqual([false]);

    act(() => toggleReading());
    expect(screen.getByRole('status').textContent).toBe('true');
    expect(renders).toEqual([false, true]);
  });
});
