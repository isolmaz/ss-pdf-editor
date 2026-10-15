// @vitest-environment happy-dom
/**
 * The key handler against real keydown events: which keystrokes the shell answers and consumes,
 * and which it leaves to the browser. The tools dock owns a bare `F5`; `Ctrl+F5` and `Shift+F5`
 * are the browser's reloads, and a toggle that swallowed them left no keyboard way to reload.
 */

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ShellShortcuts, useShellShortcuts } from './useShortcuts';

function shortcuts(): ShellShortcuts {
  const action = () => vi.fn();
  return {
    open: action(),
    save: action(),
    exportDocument: action(),
    print: action(),
    zoomIn: action(),
    zoomOut: action(),
    zoomReset: action(),
    fitWidth: action(),
    nextPage: action(),
    previousPage: action(),
    firstPage: action(),
    lastPage: action(),
    undo: action(),
    redo: action(),
    palette: action(),
    toggleLeftDock: action(),
    toggleRightDock: action(),
    reading: action(),
    documentProperties: action(),
  };
}

/** Press `key` with the modifiers; the event reports whether the shell consumed it. */
function press(key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  document.body.dispatchEvent(event);
  return event;
}

afterEach(cleanup);

describe('the F5 binding', () => {
  it('toggles the tools dock on a bare F5 and consumes the key', () => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));

    const event = press('F5');

    expect(actions.toggleRightDock).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each<[string, KeyboardEventInit]>([
    ['Ctrl+F5', { ctrlKey: true }],
    ['Cmd+F5', { metaKey: true }],
    ['Shift+F5', { shiftKey: true }],
    ['Alt+F5', { altKey: true }],
    ['Ctrl+Shift+F5', { ctrlKey: true, shiftKey: true }],
  ])('leaves %s to the browser: no toggle, key not consumed', (_chord, modifiers) => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));

    const event = press('F5', modifiers);

    expect(actions.toggleRightDock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps the other function keys answering whatever modifier is held', () => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));

    const event = press('F4', { shiftKey: true });

    expect(actions.toggleLeftDock).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
