// @vitest-environment happy-dom
/**
 * The open store: what each action writes, that the page selection a handler reads is always
 * the current one, and that a component reading one field renders for that field only.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  askPassword,
  awaitHomeCommand,
  beginOpening,
  clearPageSelection,
  dismissPasswordPrompt,
  dropHomeCommand,
  endOpening,
  hideStartScreen,
  initialOpenState,
  lockTab,
  openStore,
  selectAllPages,
  selectedPagesNow,
  selectPages,
  showStartScreen,
  useOpen,
} from './open-store';

beforeEach(() => openStore.set(initialOpenState()));
afterEach(cleanup);

describe('the open store', () => {
  it('starts on the start screen with nothing opening, asked, locked, ticked or waiting', () => {
    expect(openStore.get()).toEqual({
      showHomeScreen: true,
      opening: false,
      passwordPrompt: null,
      lockedTabs: new Map(),
      selectedPages: [],
      pendingHomeCommand: null,
    });
  });

  it('hides the start screen when a document is on screen and shows it again on Home', () => {
    hideStartScreen();
    expect(openStore.get().showHomeScreen).toBe(false);
    showStartScreen();
    expect(openStore.get().showHomeScreen).toBe(true);
  });

  it('marks a file as being opened until the open ends', () => {
    beginOpening();
    expect(openStore.get().opening).toBe(true);
    endOpening();
    expect(openStore.get().opening).toBe(false);
  });

  it('keeps the file and handle a password is asked for, and forgets them on dismissal', () => {
    const file = new File(['x'], 'locked.pdf');
    askPassword({ file, incorrect: true });
    expect(openStore.get().passwordPrompt).toEqual({ file, incorrect: true });
    dismissPasswordPrompt();
    expect(openStore.get().passwordPrompt).toBeNull();
  });

  it('remembers each password-opened tab with its password, replacing the map each time', () => {
    const before = openStore.get().lockedTabs;
    lockTab('a', 'one');
    lockTab('b', 'two');
    const locked = openStore.get().lockedTabs;
    expect(locked).not.toBe(before);
    expect([...locked]).toEqual([
      ['a', 'one'],
      ['b', 'two'],
    ]);
    expect(before.size).toBe(0);
  });

  it('ticks pages, ticks all of them, and clears them', () => {
    selectPages([2, 0]);
    expect(openStore.get().selectedPages).toEqual([2, 0]);
    selectAllPages(3);
    expect(openStore.get().selectedPages).toEqual([0, 1, 2]);
    clearPageSelection();
    expect(openStore.get().selectedPages).toEqual([]);
  });

  it('does not notify when an empty selection is cleared again', () => {
    let notified = 0;
    const stop = openStore.subscribe(() => {
      notified += 1;
    });
    clearPageSelection();
    stop();
    expect(notified).toBe(0);
  });

  it('hands handlers the selection as it is now, not as it was when they were made', () => {
    const view = selectedPagesNow;
    expect(view.current).toEqual([]);
    selectPages([4]);
    expect(view.current).toEqual([4]);
  });

  it('holds the start-screen tool that waits for a file, and drops it', () => {
    awaitHomeCommand('rotate');
    expect(openStore.get().pendingHomeCommand).toBe('rotate');
    dropHomeCommand();
    expect(openStore.get().pendingHomeCommand).toBeNull();
  });
});

describe('useOpen', () => {
  function Opening() {
    const opening = useOpen((state) => state.opening);
    return <p>{opening ? 'opening' : 'idle'}</p>;
  }

  it('re-renders the component when the field it selected changes', () => {
    render(<Opening />);
    expect(screen.getByText('idle')).toBeTruthy();
    act(() => beginOpening());
    expect(screen.getByText('opening')).toBeTruthy();
  });
});
