/**
 * The shell's key table. The handler tries the rows in order and the first match wins, so
 * two rows on one chord leave the second unreachable — reading mode sat silently behind find
 * and replace on `Ctrl+H` that way.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chordLabel,
  inCompositeWidget,
  SHELL_SHORTCUT_GROUPS,
  SHELL_SHORTCUTS,
  type ShellShortcuts,
  shortcutHint,
  shortcutLabel,
} from './useShortcuts';

/** The shell action each binding stands for. A binding must reach its own action and no other. */
const ACTION_OF: Readonly<Record<string, keyof ShellShortcuts>> = {
  'file.open': 'open',
  'file.export': 'exportDocument',
  'file.save': 'save',
  'file.print': 'print',
  'edit.redo': 'redo',
  'edit.undo': 'undo',
  'edit.delete-mark': 'deleteSelection',
  'edit.select-all-marks': 'selectAllMarks',
  'edit.find-replace': 'findReplace',
  'view.zoom-in': 'zoomIn',
  'view.zoom-out': 'zoomOut',
  'view.zoom-reset': 'zoomReset',
  'view.fit-width': 'fitWidth',
  'view.reading': 'reading',
  'view.left-dock': 'toggleLeftDock',
  'view.right-dock': 'toggleRightDock',
  'tools.properties': 'documentProperties',
  'page.next': 'nextPage',
  'page.previous': 'previousPage',
  'page.first': 'firstPage',
  'page.last': 'lastPage',
  'help.palette': 'palette',
};

/** Every action records its own name; `answers` decides what the optional ones return. */
function recorder(answers: { optional?: boolean } = {}) {
  const calls: string[] = [];
  const make = (name: string, result?: boolean) => () => {
    calls.push(name);
    return result;
  };
  const shortcuts: ShellShortcuts = {
    open: make('open'),
    save: make('save'),
    exportDocument: make('exportDocument'),
    print: make('print'),
    zoomIn: make('zoomIn'),
    zoomOut: make('zoomOut'),
    zoomReset: make('zoomReset'),
    fitWidth: make('fitWidth'),
    nextPage: make('nextPage'),
    previousPage: make('previousPage'),
    firstPage: make('firstPage'),
    lastPage: make('lastPage'),
    undo: make('undo'),
    redo: make('redo'),
    palette: make('palette'),
    toggleLeftDock: make('toggleLeftDock'),
    toggleRightDock: make('toggleRightDock'),
    reading: make('reading'),
    documentProperties: make('documentProperties'),
    ...(answers.optional === true
      ? {
          findReplace: make('findReplace', true) as () => boolean,
          deleteSelection: make('deleteSelection', true) as () => boolean,
          selectAllMarks: make('selectAllMarks', true) as () => boolean,
        }
      : {}),
  };
  return { shortcuts, calls };
}

describe('SHELL_SHORTCUTS', () => {
  it('gives every chord to one row only', () => {
    const owners = new Map<string, string>();
    const clashes: string[] = [];
    for (const row of SHELL_SHORTCUTS) {
      for (const chord of row.chords) {
        for (const key of [chord.key, ...(chord.alias === undefined ? [] : [chord.alias])]) {
          const id = `${key.toLowerCase()}|${chord.accel === true}|${chord.shift === true}`;
          const owner = owners.get(id);
          if (owner !== undefined && owner !== row.id) clashes.push(`${id}: ${owner} and ${row.id}`);
          else owners.set(id, row.id);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it('opens reading mode with F9 and find and replace with Ctrl+H', () => {
    expect(shortcutHint('view.reading')).toBe('F9');
    expect(shortcutHint('edit.find-replace')).toMatch(/^(Ctrl|⌘)\+H$/);
  });

  it('has a binding for each shell action named in the table above, and no other', () => {
    expect(SHELL_SHORTCUTS.map((row) => row.id).sort()).toEqual(Object.keys(ACTION_OF).sort());
  });

  it('runs exactly the action each binding stands for', () => {
    for (const row of SHELL_SHORTCUTS) {
      const { shortcuts, calls } = recorder({ optional: true });
      const result = row.run(shortcuts);
      expect(calls, row.id).toEqual([ACTION_OF[row.id]]);
      expect(result, row.id).not.toBe(false);
    }
  });

  it('declines Delete, select-all and find-replace when the shell has no handler for them', () => {
    for (const id of ['edit.delete-mark', 'edit.select-all-marks', 'edit.find-replace']) {
      const { shortcuts, calls } = recorder();
      const row = SHELL_SHORTCUTS.find((candidate) => candidate.id === id);
      expect(row?.run(shortcuts), id).toBe(false);
      expect(calls, id).toEqual([]);
    }
  });

  it('keeps the shifted rows ahead of the plain rows they share a key with', () => {
    const order = SHELL_SHORTCUTS.map((row) => row.id);
    expect(order.indexOf('file.export')).toBeLessThan(order.indexOf('file.save'));
    expect(order.indexOf('edit.redo')).toBeLessThan(order.indexOf('edit.undo'));
  });
});

describe('printed chords', () => {
  it('prints modifiers first, named keys as named and single keys upper-case', () => {
    expect(chordLabel({ key: 's', accel: true, shift: true })).toBe('Ctrl+Shift+S');
    expect(chordLabel({ key: 'o', accel: true })).toBe('Ctrl+O');
    expect(chordLabel({ key: '=', alias: '+', accel: true })).toBe('Ctrl++');
    expect(chordLabel({ key: 'PageDown' })).toBe('PageDown');
    expect(chordLabel({ key: 'F4' })).toBe('F4');
    expect(chordLabel({ key: 'ArrowLeft' })).toBe('ARROWLEFT');
  });

  it('lists every chord of a binding, separated by a slash', () => {
    const redo = SHELL_SHORTCUTS.find((row) => row.id === 'edit.redo');
    expect(redo === undefined ? null : shortcutLabel(redo)).toBe('Ctrl+Shift+Z / Ctrl+Y');
    expect(shortcutHint('edit.redo')).toBe('Ctrl+Shift+Z / Ctrl+Y');
    expect(shortcutHint('no.such.command')).toBeUndefined();
  });

  it('groups the help surface by the table order, with the file actions first', () => {
    expect(SHELL_SHORTCUT_GROUPS[0]?.group).toBe('file');
    expect(SHELL_SHORTCUT_GROUPS[0]?.rows.map((row) => row.keys)).toEqual([
      'Ctrl+O',
      'Ctrl+Shift+S',
      'Ctrl+S',
      'Ctrl+P',
    ]);
    const flattened = SHELL_SHORTCUT_GROUPS.flatMap((group) => group.rows.map((row) => row.id));
    expect(flattened).toEqual(SHELL_SHORTCUTS.map((row) => row.id));
    // No two neighbouring groups share a menu group: a group is one run of the table.
    const names = SHELL_SHORTCUT_GROUPS.map((group) => group.group);
    expect(names.every((name, index) => index === 0 || name !== names[index - 1])).toBe(true);
  });
});

describe('composite widgets', () => {
  /** A DOM element whose `closest` answers for the role selector the way a real tree would. */
  class FakeElement {
    constructor(private readonly roles: readonly string[]) {}
    closest(selector: string): FakeElement | null {
      return this.roles.some((role) => selector.includes(`[role="${role}"]`)) ? this : null;
    }
  }

  afterEach(() => vi.unstubAllGlobals());

  it("treats the focus inside a menu bar, menu, list, tree or grid as the widget's own", () => {
    vi.stubGlobal('Element', FakeElement);
    for (const role of ['menubar', 'menu', 'listbox', 'tree', 'grid']) {
      expect(inCompositeWidget(new FakeElement([role]) as unknown as EventTarget), role).toBe(true);
    }
  });

  it('leaves the focus on plain elements and on no target to the shell', () => {
    vi.stubGlobal('Element', FakeElement);
    expect(inCompositeWidget(new FakeElement(['button']) as unknown as EventTarget)).toBe(false);
    expect(inCompositeWidget(null)).toBe(false);
    expect(inCompositeWidget({} as EventTarget)).toBe(false);
  });
});
