// @vitest-environment happy-dom
/** The window's own surfaces: palette, settings and the tab being renamed. */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import {
  closePalette,
  closeSettings,
  initialShellState,
  openPalette,
  openSettings,
  renameTab,
  shellStore,
  summonPalette,
  useShell,
} from './shell-store';

beforeEach(() => {
  coreStore.set(initialCoreState());
  shellStore.set(initialShellState());
});

describe('shell store', () => {
  it('opens and closes the palette', () => {
    openPalette();
    expect(shellStore.get().paletteOpen).toBe(true);
    closePalette();
    expect(shellStore.get().paletteOpen).toBe(false);
  });

  it('disarms the armed tool when the command or the keyboard summons the palette', () => {
    selectTool('measure');
    summonPalette();
    expect(coreStore.get().canvasTool).toBe('select');
    expect(shellStore.get().paletteOpen).toBe(true);
  });

  it('leaves the tool armed when a header button opens the palette', () => {
    selectTool('ink');
    openPalette();
    expect(coreStore.get().canvasTool).toBe('ink');
  });

  it('opens and closes settings', () => {
    openSettings();
    expect(shellStore.get().settingsOpen).toBe(true);
    closeSettings();
    expect(shellStore.get().settingsOpen).toBe(false);
  });

  it('starts and stops renaming a tab, and a component hears it', () => {
    const { result } = renderHook(() => useShell((state) => state.renamingId));
    expect(result.current).toBeNull();
    act(() => renameTab('tab-1'));
    expect(result.current).toBe('tab-1');
    act(() => renameTab(null));
    expect(result.current).toBeNull();
  });
});
