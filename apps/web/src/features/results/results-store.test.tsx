// @vitest-environment happy-dom
/**
 * The results store: what each action writes, and that a component reading one field renders
 * for that field only.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closePrintDialog,
  closeScanDialog,
  initialResultsState,
  openPrintDialog,
  openScanDialog,
  resultsStore,
  setProgress,
  useResults,
} from './results-store';

beforeEach(() => resultsStore.set(initialResultsState()));
afterEach(cleanup);

describe('the results store', () => {
  it('starts with both dialogs closed and no progress', () => {
    expect(resultsStore.get()).toEqual({ printOpen: false, scanOpen: false, progress: null });
  });

  it('opens and closes the print dialog and the scanner independently', () => {
    openPrintDialog();
    openScanDialog();
    expect(resultsStore.get()).toMatchObject({ printOpen: true, scanOpen: true });
    closePrintDialog();
    expect(resultsStore.get()).toMatchObject({ printOpen: false, scanOpen: true });
    closeScanDialog();
    expect(resultsStore.get()).toMatchObject({ printOpen: false, scanOpen: false });
  });

  it('holds the progress an operation reports until it clears it', () => {
    const progress = { phase: 'pages', labelKey: 'op.step.pages', total: 4, done: 1 } as const;
    setProgress(progress);
    expect(resultsStore.get().progress).toBe(progress);
    setProgress(null);
    expect(resultsStore.get().progress).toBeNull();
  });

  it('re-renders a component for the field it reads and for no other', () => {
    let renders = 0;
    function Probe() {
      const printOpen = useResults((state) => state.printOpen);
      renders += 1;
      return <p>{printOpen ? 'print open' : 'print closed'}</p>;
    }
    render(<Probe />);
    expect(screen.getByText('print closed')).toBeTruthy();
    const before = renders;

    act(() => openScanDialog());
    act(() => setProgress({ phase: 'pages', labelKey: 'op.step.pages', total: 1, done: 0 }));
    expect(renders).toBe(before);

    act(() => openPrintDialog());
    expect(screen.getByText('print open')).toBeTruthy();
  });
});
