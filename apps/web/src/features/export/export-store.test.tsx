// @vitest-environment happy-dom
/**
 * The export store: what each action writes, and that a component reading one field renders
 * for that field only.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeContextMenu,
  closeExportDialog,
  exportStore,
  initialExportState,
  openContextMenu,
  openExportDialog,
  useExport,
} from './export-store';

beforeEach(() => exportStore.set(initialExportState()));
afterEach(cleanup);

describe('the export store', () => {
  it('starts with the dialog closed and no context menu', () => {
    expect(exportStore.get()).toEqual({ exportOpen: false, contextMenu: null });
  });

  it('opens and closes the export dialog without touching the context menu', () => {
    const anchor = { x: 3, y: 4, hasSelection: false };
    openContextMenu(anchor);
    openExportDialog();
    expect(exportStore.get()).toEqual({ exportOpen: true, contextMenu: anchor });
    closeExportDialog();
    expect(exportStore.get()).toEqual({ exportOpen: false, contextMenu: anchor });
  });

  it('holds the place and the selection the context menu opened with until it closes', () => {
    const anchor = { x: 10, y: 20, hasSelection: true, selectedText: 'words' };
    openContextMenu(anchor);
    expect(exportStore.get().contextMenu).toBe(anchor);
    closeContextMenu();
    expect(exportStore.get().contextMenu).toBeNull();
  });

  it('re-renders a component for the field it reads and for no other', () => {
    let renders = 0;
    function Probe() {
      const exportOpen = useExport((state) => state.exportOpen);
      renders += 1;
      return <p>{exportOpen ? 'open' : 'closed'}</p>;
    }
    render(<Probe />);
    expect(screen.getByText('closed')).toBeTruthy();
    const before = renders;

    act(() => openContextMenu({ x: 1, y: 1, hasSelection: false }));
    expect(renders).toBe(before);

    act(() => openExportDialog());
    expect(screen.getByText('open')).toBeTruthy();
    expect(renders).toBe(before + 1);
  });
});
