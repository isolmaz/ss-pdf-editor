import type { MessageKey } from 'pdf-shared';
import type { MenuGroup } from 'pdf-ui';
import type { CanvasToolId } from 'pdf-ui/tools';
import { useEffect } from 'react';

/**
 * The shell's keyboard layer: the shortcut infrastructure, with undo/redo, the
 * palette and the docks.
 *
 * One place owns the bindings so a second, competing handler cannot appear later.
 * The viewer keeps `Ctrl+F`, `F3` and `Escape` — they
 * belong to the find bar's own focus scope — and this hook covers everything that
 * acts on the shell: open, save, export, zoom, page navigation.
 *
 * **One table, two readers.** `SHELL_SHORTCUTS` is the binding list: the handler
 * below runs from it, the help surface (`ShortcutsDialog`) prints it, and the menu
 * and palette hints in `commands.ts` read their display text from it. A chord that
 * is listed is therefore a chord that runs — a second, hand-written shortcut list
 * is the one thing this file exists to prevent.
 *
 * **Modifier tolerance is the contract.** A chord names the modifier it needs and
 * nothing more: `Ctrl+O` also fires with `Shift` down, `Ctrl+=` is reached as the
 * physical `Ctrl` `+`, and the modifier-less keys (`F4`, `PageDown`) keep their
 * meaning whatever else is held. `Shift` is written only where it decides between two
 * bindings — `Ctrl+S` saves, `Ctrl+Shift+S` exports — and there the shifted row comes
 * first, exactly as the pre-table handler checked it. A chord whose key the browser also gives
 * modified meanings is `bare` instead: the tool letters (`V`, `H`, `E`, `T`, `U`, `D`, `R`, `N`,
 * `K`, `M`, `X`) answer only with no modifier down, so `Ctrl+R`, `Ctrl+D` and the rest stay the
 * browser's own. A bare chord also stands down inside a menu, a list or a dialog, where typed
 * letters belong to the widget, and ignores key repeat, so holding a letter does not toggle the
 * tool back and forth. `F5` is not bound: it stays the browser's reload; the tools dock is
 * `Shift+F4`, beside `F4` for the page panel.
 *
 * Editing contexts win: while the focus is in a field, a text area or a
 * `contenteditable` (the form widgets pdf.js renders are fields), the shell stays out
 * of the way — except for the five bindings marked `fromAnywhere`, and `Ctrl+S` is
 * the one that matters most: saving must keep working from anywhere. Undo is
 * deliberately part of the "editing wins" set: `Ctrl+Z` inside a form field must undo
 * the typing, not the document's last operation.
 *
 * Documented deviations from the usual desktop bindings, because the browser owns the key and a
 * binding that can never fire is dead code: `Ctrl+W` (close tab), `Ctrl+Tab`
 * (switch tab) and `Ctrl+Shift+R` (hard reload in Chromium) are not bound here, and
 * they are not listed as bindings either. Closing and switching tabs stay reachable
 * from the tab strip, the menu and the palette; redaction is reached from the
 * toolbar, the Tools menu and the palette.
 */

/**
 * A shell action that can decline.
 *
 * `false` means **this key was not the shell's to answer** — there is no document, no
 * mark is selected, or a native action is the right one for the context — and the
 * binding then neither cancels the key nor stops it, so the engine and the browser
 * keep it.
 *
 * When the shell *does* answer, the key is consumed (see the handler below). That is
 * what makes "one undo, one delete, one select-all" true rather than hopeful:
 * pdf.js's own keyboard manager listens on `window` and acts on `Ctrl+Z`, `Ctrl+A`
 * and the delete keys whenever it has an editor tool armed, so an un-consumed key
 * would run the engine's action as well. The shell's own callbacks also fold that
 * pending native gesture into the session first (`stepHistoryNow` in
 * `features/pages/page-actions.ts`, `deleteMarkSelection` in `features/selection/`), which
 * is what leaves the *journal* as the only history —
 * and a field that is being edited still wins outright, because those bindings are
 * not `fromAnywhere` and are skipped while the focus is in a field.
 */
// `boolean | void`, not `unknown`: only `false` declines, so a handler that returned a
// Promise (an accidental `async`) would read as "handled"; this type rejects it.
// biome-ignore lint/suspicious/noConfusingVoidType: `void` is the "handled" return of a plain callback
type ShellAction = () => boolean | void;

export interface ShellShortcuts {
  readonly open: () => void;
  readonly save: () => void;
  readonly exportDocument: () => void;
  readonly print: () => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly zoomReset: () => void;
  readonly fitWidth: () => void;
  /**
   * Page navigation declines (`false`) while a presentation is on: the presentation turns the
   * page keys itself, and a key both answered would turn two pages.
   */
  readonly nextPage: ShellAction;
  readonly previousPage: ShellAction;
  readonly firstPage: ShellAction;
  readonly lastPage: ShellAction;
  /** Editing, palette and docks. */
  readonly undo: ShellAction;
  readonly redo: ShellAction;
  readonly palette: () => void;
  readonly toggleLeftDock: () => void;
  readonly toggleRightDock: () => void;
  /**
   * Arms a canvas tool, or puts the pointer back in select when it is the armed one (the rail's
   * toggle). Declines (`false`) while no document is open or the tool writes and the document is
   * not editable, so the letter is not swallowed to mean nothing.
   */
  readonly armTool: (tool: ShortcutTool) => boolean;
  readonly reading: () => void;
  readonly documentProperties: () => void;
  /** Opens find and replace; `false` when no editable document is open. */
  readonly findReplace?: () => boolean;
  /** Deletes the common layer's whole selection; `false` when there is nothing to delete. */
  readonly deleteSelection?: () => boolean;
  /** Selects every mark of the common selection; `false` unless the select tool can answer. */
  readonly selectAllMarks?: () => boolean;
}

/** What a tool shortcut arms: a canvas tool, or `markup` for the markup button's last-used look. */
export type ShortcutTool = CanvasToolId | 'markup';

/**
 * One key chord, split into its parts so the matcher and the printed form are the
 * same fact. `key`/`alias` are `KeyboardEvent.key` values; single characters are
 * compared case-insensitively, named keys (`PageDown`, `F4`) exactly.
 */
export interface ShortcutChord {
  readonly key: string;
  /** A second key that fires the same chord — `'+'` beside `'='`, as the browser reports them. */
  readonly alias?: string;
  /** `Ctrl` (or `Cmd` on macOS) must be held. */
  readonly accel?: boolean;
  /**
   * `Shift` must be held. Left out, `Shift` is not part of the chord and is ignored:
   * the row that owns the shifted form is listed ahead of its plain sibling instead.
   */
  readonly shift?: boolean;
  /**
   * No modifier at all is held — not `Ctrl`, `Cmd`, `Shift` or `Alt`. For a key whose modified forms
   * belong to the browser, so the chord does not swallow them: the single tool letters.
   */
  readonly bare?: boolean;
}

/**
 * One shell binding.
 *
 * `id` is the command id where the capability has one (`commands.ts` builds the menu
 * and palette from the same ids), so the menu hint, the palette hint and this row
 * name one binding rather than three look-alikes.
 */
export interface ShellShortcut {
  readonly id: string;
  readonly group: MenuGroup;
  readonly labelKey: MessageKey;
  readonly chords: readonly ShortcutChord[];
  /** The tool a tool shortcut arms; the rail's tooltip reads its key from the row that names its tool. */
  readonly tool?: ShortcutTool;
  /** Runs while a field owns the focus; every other binding stands down there. */
  readonly fromAnywhere?: boolean;
  /**
   * Runs the binding. Returning `false` declines the key: the shell neither cancels
   * nor stops it, and the search continues with the next row. Every other return —
   * including the usual `undefined` — counts as handled.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: see `ShellAction` — `void` counts as handled
  readonly run: (shortcuts: ShellShortcuts) => boolean | void;
}

/**
 * The shell's bindings, in the order the help surface lists them — which is also the
 * order the handler tries them, first match wins. A row that owns a shifted chord
 * (`Ctrl+Shift+S`) therefore stands in front of the plain row it shares a key with
 * (`Ctrl+S`), because `Shift` is not part of the plain chord.
 *
 * `PageUp`/`PageDown`/`Home`/`End` are page navigation, not scrolling: the viewer
 * keeps the scroll keys for the page canvas.
 */
/**
 * One tool letter. `id` is the command id where the tool has a menu command (so the menu hint
 * comes from here), `key` is the plain letter.
 */
function toolShortcut(id: string, tool: ShortcutTool, key: string, labelKey: MessageKey): ShellShortcut {
  return { id, group: 'tools', labelKey, chords: [{ key, bare: true }], tool, run: (s) => s.armTool(tool) };
}

export const SHELL_SHORTCUTS: readonly ShellShortcut[] = [
  // File — the four gestures that must work from anywhere.
  {
    id: 'file.open',
    group: 'file',
    labelKey: 'shell.open',
    chords: [{ key: 'o', accel: true }],
    fromAnywhere: true,
    run: (shortcuts) => shortcuts.open(),
  },
  {
    // `Ctrl+Shift+S` exports, so the shifted row is tried before `Ctrl+S` saves.
    id: 'file.export',
    group: 'file',
    labelKey: 'shell.export',
    chords: [{ key: 's', accel: true, shift: true }],
    fromAnywhere: true,
    run: (shortcuts) => shortcuts.exportDocument(),
  },
  {
    id: 'file.save',
    group: 'file',
    labelKey: 'shell.save',
    chords: [{ key: 's', accel: true }],
    fromAnywhere: true,
    run: (shortcuts) => shortcuts.save(),
  },
  {
    id: 'file.print',
    group: 'file',
    labelKey: 'print.start',
    chords: [{ key: 'p', accel: true }],
    fromAnywhere: true,
    run: (shortcuts) => shortcuts.print(),
  },

  // Edit — `Ctrl+Shift+Z` redoes and `Ctrl+Y` is the other redo, so both are tried
  // before `Ctrl+Z` undoes.
  {
    id: 'edit.redo',
    group: 'edit',
    labelKey: 'shell.redo',
    chords: [
      { key: 'z', accel: true, shift: true },
      { key: 'y', accel: true },
    ],
    run: (shortcuts) => shortcuts.redo(),
  },
  {
    id: 'edit.undo',
    group: 'edit',
    labelKey: 'shell.undo',
    chords: [{ key: 'z', accel: true }],
    run: (shortcuts) => shortcuts.undo(),
  },
  {
    // The selected mark on the page, not a page or a text selection: `Delete` inside a
    // field belongs to the field, which is why this binding is not `fromAnywhere`. It
    // answers the **whole** common selection — every mark family at once — and declines
    // the key when there is nothing selected.
    id: 'edit.delete-mark',
    group: 'edit',
    labelKey: 'ann.remove',
    chords: [{ key: 'Delete' }, { key: 'Backspace' }],
    run: (shortcuts) => shortcuts.deleteSelection?.() ?? false,
  },
  {
    // `Ctrl/Cmd+A` selects the marks the select tool acts on. It answers only in that
    // tool with a document open and something to select: anywhere else — a native
    // tool armed, the hand, or a page with no marks — it declines, so the page's own
    // text selection and the engine's own select-all keep their meaning. Inside a field
    // it is already out of reach (`fromAnywhere` is absent).
    id: 'edit.select-all-marks',
    group: 'edit',
    labelKey: 'ann.selectAll',
    chords: [{ key: 'a', accel: true }],
    run: (shortcuts) => shortcuts.selectAllMarks?.() ?? false,
  },
  {
    // `Ctrl+H`, the find-and-replace chord of every word processor; `Ctrl+F` stays the
    // viewer's find bar.
    id: 'edit.find-replace',
    group: 'edit',
    labelKey: 'cmd.findReplace.label',
    chords: [{ key: 'h', accel: true }],
    run: (shortcuts) => shortcuts.findReplace?.() ?? false,
  },

  // View
  {
    id: 'view.zoom-in',
    group: 'view',
    labelKey: 'nav.zoomIn',
    chords: [{ key: '=', alias: '+', accel: true }],
    run: (shortcuts) => shortcuts.zoomIn(),
  },
  {
    id: 'view.zoom-out',
    group: 'view',
    labelKey: 'nav.zoomOut',
    chords: [{ key: '-', accel: true }],
    run: (shortcuts) => shortcuts.zoomOut(),
  },
  {
    id: 'view.zoom-reset',
    group: 'view',
    labelKey: 'shell.shortcuts.actualSize',
    chords: [{ key: '1', accel: true }],
    run: (shortcuts) => shortcuts.zoomReset(),
  },
  {
    id: 'view.fit-width',
    group: 'view',
    labelKey: 'nav.fitWidth',
    chords: [{ key: '0', accel: true }],
    run: (shortcuts) => shortcuts.fitWidth(),
  },
  {
    id: 'view.reading',
    group: 'view',
    labelKey: 'nav.readingMode',
    // F9, the reader-view key of Edge and Firefox. Not `Ctrl+H`: find and replace owns that
    // chord (the word processors' key), and the earlier row would always win.
    chords: [{ key: 'F9' }],
    run: (shortcuts) => shortcuts.reading(),
  },
  {
    // Ahead of `F4`, which fires with any modifier held. Not `F5`: that is the browser's reload.
    id: 'view.right-dock',
    group: 'view',
    labelKey: 'dock.toggleRight',
    chords: [{ key: 'F4', shift: true }],
    run: (shortcuts) => shortcuts.toggleRightDock(),
  },
  {
    id: 'view.left-dock',
    group: 'view',
    labelKey: 'dock.toggleLeft',
    chords: [{ key: 'F4' }],
    run: (shortcuts) => shortcuts.toggleLeftDock(),
  },
  {
    id: 'tools.properties',
    group: 'tools',
    labelKey: 'properties.title',
    chords: [{ key: 'd', accel: true, shift: true }],
    run: (shortcuts) => shortcuts.documentProperties(),
  },
  // The tool letters, as the common PDF editors have them. Plain letters only (`bare`).
  toolShortcut('tools.select', 'select', 'v', 'toolbar.select'),
  toolShortcut('tools.hand', 'hand', 'h', 'toolbar.hand'),
  toolShortcut('tools.text-edit', 'text', 'e', 'cmd.textEdit.label'),
  toolShortcut('tools.freetext', 'freetext', 't', 'toolbar.freetext'),
  toolShortcut('tools.markup', 'markup', 'u', 'toolbar.markup'),
  toolShortcut('tools.ink', 'ink', 'd', 'ann.tool.ink'),
  toolShortcut('tools.shapes', 'shapes', 'r', 'toolbar.shape'),
  toolShortcut('tools.note', 'note', 'n', 'toolbar.comment'),
  toolShortcut('tools.link', 'link', 'k', 'link.tool'),
  toolShortcut('tools.measure', 'measure', 'm', 'toolbar.measure'),
  toolShortcut('tools.redact-area', 'redact', 'x', 'toolbar.redact'),

  // Page navigation
  {
    id: 'page.next',
    group: 'page',
    labelKey: 'nav.nextPage',
    chords: [{ key: 'PageDown' }],
    run: (shortcuts) => shortcuts.nextPage(),
  },
  {
    id: 'page.previous',
    group: 'page',
    labelKey: 'nav.prevPage',
    chords: [{ key: 'PageUp' }],
    run: (shortcuts) => shortcuts.previousPage(),
  },
  {
    id: 'page.first',
    group: 'page',
    labelKey: 'shell.shortcuts.firstPage',
    chords: [{ key: 'Home' }],
    run: (shortcuts) => shortcuts.firstPage(),
  },
  {
    id: 'page.last',
    group: 'page',
    labelKey: 'shell.shortcuts.lastPage',
    chords: [{ key: 'End' }],
    run: (shortcuts) => shortcuts.lastPage(),
  },

  // Help
  {
    id: 'help.palette',
    group: 'help',
    labelKey: 'shell.commandPalette',
    chords: [{ key: 'k', accel: true }],
    fromAnywhere: true,
    run: (shortcuts) => shortcuts.palette(),
  },
];

/** The printed form of a named key; a single character prints as its upper-case self. */
const KEY_LABELS: Readonly<Record<string, string>> = {
  '=': '+',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  Home: 'Home',
  End: 'End',
  Delete: 'Delete',
  Backspace: 'Backspace',
  F4: 'F4',
  F9: 'F9',
};

/** `Ctrl+Shift+S`, `PageDown`, `Ctrl++` — derived from the chord, never written twice. */
export function chordLabel(chord: ShortcutChord): string {
  const parts: string[] = [];
  if (chord.accel === true) parts.push('Ctrl');
  if (chord.shift === true) parts.push('Shift');
  parts.push(KEY_LABELS[chord.key] ?? chord.key.toUpperCase());
  return parts.join('+');
}

/** The display text for one binding: its chords, in order, separated by ` / `. */
export function shortcutLabel(binding: ShellShortcut): string {
  return binding.chords.map(chordLabel).join(' / ');
}

/**
 * The hint a menu or palette entry shows for a binding.
 *
 * `commands.ts` builds its entries from command ids, so the lookup is by id and a
 * command that has no binding gets no hint — rather than a hand-written string that
 * could name a key nothing listens for.
 */
export function shortcutHint(id: string): string | undefined {
  const binding = SHELL_SHORTCUTS.find((candidate) => candidate.id === id);
  return binding === undefined ? undefined : shortcutLabel(binding);
}

/** The printed key of the shortcut that arms `tool`, for the rail's tooltip; `undefined` if it has none. */
export function toolShortcutHint(tool: ShortcutTool): string | undefined {
  const binding = SHELL_SHORTCUTS.find((candidate) => candidate.tool === tool);
  return binding === undefined ? undefined : shortcutLabel(binding);
}

/** A name with its shortcut after it, as a tooltip prints it; the bare name when there is none. */
export function withShortcut(name: string, shortcut: string | undefined): string {
  return shortcut === undefined ? name : `${name} (${shortcut})`;
}

/** One section of the help surface: a menu group and the bindings it holds. */
export interface ShellShortcutGroup {
  readonly group: MenuGroup;
  readonly rows: readonly {
    readonly id: string;
    readonly labelKey: MessageKey;
    readonly keys: string;
  }[];
}

/**
 * The help surface's data, grouped by the table's own order — the file actions first,
 * because that is the order a reader looks for them in.
 */
export const SHELL_SHORTCUT_GROUPS: readonly ShellShortcutGroup[] = (() => {
  const groups: { group: MenuGroup; rows: ShellShortcutGroup['rows'][number][] }[] = [];
  for (const binding of SHELL_SHORTCUTS) {
    const row = { id: binding.id, labelKey: binding.labelKey, keys: shortcutLabel(binding) };
    const current = groups[groups.length - 1];
    if (current === undefined || current.group !== binding.group) {
      groups.push({ group: binding.group, rows: [row] });
    } else {
      current.rows.push(row);
    }
  }
  return groups;
})();

/** A modal dialog: the letters typed in it are not the canvas's. */
function inDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="dialog"],[role="alertdialog"]') !== null;
}

function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Widgets that own the navigation keys (Home, End, Page Up/Down) and the plain letters while the
 * focus is inside them: the ARIA composite roles, the controls that take typed or arrowed values
 * (a select's `combobox` button, a `textbox`, a `spinbutton`, a `slider`), and a list that walks its
 * own rows (`data-owns-page-keys`).
 */
const COMPOSITE_WIDGETS =
  '[role="menubar"],[role="menu"],[role="listbox"],[role="tree"],[role="grid"],[role="tablist"],[role="combobox"],[role="textbox"],[role="spinbutton"],[role="slider"],[data-owns-page-keys]';

/**
 * Whether the focus sits in a composite widget (a menu bar, a menu, the thumbnail list, a dock's tabs):
 * those handle the page-navigation keys themselves, and the shell answering first (it
 * listens in the capture phase) would stop the widget from ever seeing them.
 */
export function inCompositeWidget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSITE_WIDGETS) !== null;
}

/**
 * Whether `event` is the chord: the key (or its alias) matches, and every modifier the
 * chord *names* is held. A modifier the chord does not name is not checked — the
 * printed `Ctrl++` arrives as `'+'` with `Shift` down, which this chord does not demand,
 * and `F4` fires with `Shift`, `Ctrl` or `Alt` down, as it did before this table existed. A `bare`
 * chord is the exception: it needs every modifier up.
 *
 * Single characters compare case-insensitively (`KeyboardEvent.key` reports `'S'`
 * while Shift is held); named keys (`PageDown`, `F4`) compare exactly.
 */
function chordMatches(chord: ShortcutChord, event: KeyboardEvent, accel: boolean): boolean {
  if (chord.accel === true && !accel) return false;
  if (chord.shift === true && !event.shiftKey) return false;
  if (chord.bare === true && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return false;
  const same = (candidate: string) =>
    candidate.length === 1 ? candidate === event.key.toLowerCase() : candidate === event.key;
  return same(chord.key) || (chord.alias !== undefined && same(chord.alias));
}

export function useShellShortcuts(shortcuts: ShellShortcuts): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const accel = event.ctrlKey || event.metaKey;
      const editing = isEditing(event.target);
      const composite = inCompositeWidget(event.target);
      for (const binding of SHELL_SHORTCUTS) {
        if (editing && binding.fromAnywhere !== true) continue;
        const bare = binding.chords.some((chord) => chord.bare === true);
        if (composite && (binding.group === 'page' || bare)) continue;
        if (bare && (event.repeat || inDialog(event.target))) continue;
        if (!binding.chords.some((chord) => chordMatches(chord, event, accel))) continue;
        /**
         * **One owner per key.** `false` means the shell did not answer: the row is
         * skipped and the event keeps travelling, so the engine's own keyboard manager
         * (which listens on `window` for `Ctrl+Z`, `Delete` and `Ctrl+A` whenever an
         * editor tool is armed) or the browser still gets it. When the shell *does*
         * answer, the key is consumed with `stopPropagation` — without that, arming a
         * native tool would run two undos, two deletes or two select-alls for one
         * keystroke, which is the defect this listener exists to prevent.
         *
         * The listener runs in the **capture** phase for the same reason: pdf.js
         * registers its own `keydown` on `window` before this one (the viewer mounts
         * inside the shell), so a bubble-phase handler could only ever act after the
         * engine had already acted.
         */
        const result = binding.run(shortcuts);
        if (result === false) continue;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcuts]);
}
