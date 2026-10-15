// @vitest-environment happy-dom
/**
 * The key handler against real keydown events: which keystrokes the shell answers and consumes,
 * and which it leaves to the browser. `F5` is the browser's reload and is not bound (the tools dock is
 * `Shift+F4`); the tool letters answer only as plain letters outside a field, a menu and a dialog.
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
    armTool: action(),
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

describe('the dock keys', () => {
  it('toggles the tools dock on Shift+F4 and consumes the key, without touching the page panel', () => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));

    const event = press('F4', { shiftKey: true });

    expect(actions.toggleRightDock).toHaveBeenCalledTimes(1);
    expect(actions.toggleLeftDock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('toggles the page panel on a plain F4', () => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));

    const event = press('F4');

    expect(actions.toggleLeftDock).toHaveBeenCalledTimes(1);
    expect(actions.toggleRightDock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it.each<[string, KeyboardEventInit]>([
    ['F5', {}],
    ['Ctrl+F5', { ctrlKey: true }],
    ['Shift+F5', { shiftKey: true }],
    ['Alt+F5', { altKey: true }],
  ])('leaves %s to the browser: no toggle, key not consumed', (_chord, modifiers) => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));

    const event = press('F5', modifiers);

    expect(actions.toggleRightDock).not.toHaveBeenCalled();
    expect(actions.toggleLeftDock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('the tool letters', () => {
  const LETTERS: readonly [string, string][] = [
    ['v', 'select'],
    ['h', 'hand'],
    ['e', 'text'],
    ['t', 'freetext'],
    ['u', 'markup'],
    ['d', 'ink'],
    ['r', 'shapes'],
    ['n', 'note'],
    ['k', 'link'],
    ['m', 'measure'],
    ['x', 'redact'],
  ];

  it.each(LETTERS)('%s arms %s and consumes the key, also as a capital with Caps Lock', (letter, tool) => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));

    const event = press(letter);
    press(letter.toUpperCase());

    expect(actions.armTool).toHaveBeenNthCalledWith(1, tool);
    expect(actions.armTool).toHaveBeenCalledTimes(2);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each<[string, KeyboardEventInit]>([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
    ['AltGr', { ctrlKey: true, altKey: true }],
  ])('ignores a letter with %s held, so the browser and the other chords keep it', (_name, modifiers) => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));

    const event = press('r', modifiers);

    expect(actions.armTool).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['input', 'textarea', 'select'])('stands down while the focus is in a %s', (tag) => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));
    const field = document.body.appendChild(document.createElement(tag));

    const event = new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true });
    field.dispatchEvent(event);

    expect(actions.armTool).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    field.remove();
  });

  it.each([
    ['a menu', '<div role="menu"><button id="x" role="menuitem">Open</button></div>'],
    ['a list', '<ul role="listbox"><li id="x" role="option">Page</li></ul>'],
    ['a dialog', '<div role="dialog"><button id="x">OK</button></div>'],
    ['an alert dialog', '<div role="alertdialog"><button id="x">OK</button></div>'],
  ])('stands down inside %s, where typed letters belong to the widget', (_name, html) => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));
    const host = document.body.appendChild(document.createElement('div'));
    host.innerHTML = html;

    const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true });
    host.querySelector('#x')?.dispatchEvent(event);

    expect(actions.armTool).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    host.remove();
  });

  it('ignores key repeat: holding a letter does not toggle the tool back and forth', () => {
    const actions = shortcuts();
    renderHook(() => useShellShortcuts(actions));

    press('t');
    const repeat = press('t', { repeat: true });

    expect(actions.armTool).toHaveBeenCalledTimes(1);
    expect(repeat.defaultPrevented).toBe(false);
  });

  it('does not consume the letter when the shell declines it (no document, or it cannot edit)', () => {
    const actions = { ...shortcuts(), armTool: vi.fn(() => false) };
    renderHook(() => useShellShortcuts(actions));

    const event = press('d');

    expect(actions.armTool).toHaveBeenCalledWith('ink');
    expect(event.defaultPrevented).toBe(false);
  });
});
