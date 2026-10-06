/**
 * The application menu bar (`PLAN.md §4.1`, §4.3): one trigger per `MENU_GROUPS`
 * entry, the commands of that group in a menu, and the same `Command` objects the
 * palette and the toolbar render.
 *
 * **Kumo has no menubar.** Its `MenuBar` export is a deprecated horizontal
 * icon-button toolbar, not `role="menubar"`: it takes an icon and a tooltip per
 * option and has no notion of an application menu, submenu or checked item. So
 * this is our own widget, built to the ARIA menubar pattern:
 *
 *  - the bar is a single tab stop with a **roving tabindex** (one trigger is
 *    `tabIndex={0}`, the rest are `-1`), and ArrowLeft/ArrowRight/Home/End move
 *    between triggers — and, when a menu is already open, open the one focus
 *    arrives on. That is how a menu bar is used with a keyboard, and no Kumo
 *    primitive provides it;
 *  - each trigger carries `aria-haspopup="menu"` and `aria-expanded`, and points
 *    `aria-controls` at the menu only while that menu exists;
 *  - focus stays on the bar or on the menu container, and the highlighted item is
 *    published with `aria-activedescendant` — moving a real focus ring through
 *    every item would make the menu a tab stop per entry;
 *  - Escape closes and returns focus to its trigger; Tab closes and lets focus
 *    continue, because a menu is not a trap.
 *
 * The markup nests a `role="group"` per trigger so a menu can be positioned under
 * the trigger that owns it — no portal and no measured offsets. `group` is one of
 * the children `role="menubar"` may own, so the structure is ARIA-legal (verified
 * against axe-core's `ariaRoles.requiredOwned` for `menubar`).
 */

import { Check } from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { type Command, MENU_GROUP_KEYS, MENU_GROUPS, type MenuGroup } from './types';

export interface MenuBarProps {
  readonly t: Translator;
  readonly commands: readonly Command[];
}

export function MenuBar({ t, commands }: MenuBarProps) {
  const [openGroup, setOpenGroup] = useState<MenuGroup | null>(null);
  /** The roving-tabindex anchor: the trigger that owns the bar's tab stop. */
  const [anchorGroup, setAnchorGroup] = useState<MenuGroup | null>(null);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef(new Map<MenuGroup, HTMLButtonElement>());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const focusPanelOnRender = useRef(false);
  const id = useId();

  // Only populated groups get a trigger: an empty "Yardım" menu would be a trap.
  const groups = MENU_GROUPS.filter((group) => commands.some((command) => command.group === group));
  const anchor = anchorGroup !== null && groups.includes(anchorGroup) ? anchorGroup : groups[0];
  const items = openGroup === null ? [] : commands.filter((command) => command.group === openGroup);
  // Disabled entries are rendered but skipped when walking the menu, so a menu
  // whose only entries are unavailable cannot be entered and then dead-ended.
  const enabled = items.filter((command) => command.disabled !== true);
  const current = enabled[Math.min(highlight, enabled.length - 1)];

  // Focus can only be moved into the panel after it exists, so opening defers the
  // focus to the render that mounts it.
  useEffect(() => {
    if (openGroup === null || !focusPanelOnRender.current) return;
    focusPanelOnRender.current = false;
    panelRef.current?.focus();
  }, [openGroup]);

  // A click anywhere else dismisses the menu. `pointerdown`, not `click`: the menu
  // must be gone before the element under the pointer receives the press.
  useEffect(() => {
    if (openGroup === null) return;
    const dismiss = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpenGroup(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [openGroup]);

  const openMenu = (group: MenuGroup, focusPanel: boolean, fromEnd: boolean) => {
    const available = commands.filter((command) => command.group === group && command.disabled !== true);
    setOpenGroup(group);
    setAnchorGroup(group);
    setHighlight(fromEnd ? Math.max(available.length - 1, 0) : 0);
    if (focusPanel) focusPanelOnRender.current = true;
  };

  const closeMenu = (refocus: boolean) => {
    const group = openGroup;
    setOpenGroup(null);
    if (refocus && group !== null) triggerRefs.current.get(group)?.focus();
  };

  const focusGroupAt = (index: number) => {
    const next = groups[(index + groups.length) % groups.length];
    if (next === undefined) return;
    setAnchorGroup(next);
    triggerRefs.current.get(next)?.focus();
    // Moving along an open bar swaps which menu is showing (`§4.1`).
    if (openGroup !== null) openMenu(next, true, false);
  };

  const activate = (command: Command) => {
    // Close before running: the command may open a dialog or another document, and
    // focus has to be back on the bar before that happens.
    closeMenu(true);
    command.run();
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, group: MenuGroup) => {
    const index = groups.indexOf(group);
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft':
        event.preventDefault();
        focusGroupAt(index + (event.key === 'ArrowRight' ? 1 : -1));
        break;
      case 'Home':
        event.preventDefault();
        focusGroupAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusGroupAt(groups.length - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        openMenu(group, true, false);
        break;
      case 'ArrowUp':
        event.preventDefault();
        openMenu(group, true, true);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        openMenu(group, true, false);
        break;
      case 'Escape':
        if (openGroup !== null) {
          event.preventDefault();
          closeMenu(false);
        }
        break;
      case 'Tab':
        closeMenu(false);
        break;
      default:
        break;
    }
  };

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (enabled.length === 0) return;
    const at = Math.min(highlight, enabled.length - 1);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setHighlight((at + 1) % enabled.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setHighlight((at - 1 + enabled.length) % enabled.length);
        break;
      case 'Home':
        event.preventDefault();
        setHighlight(0);
        break;
      case 'End':
        event.preventDefault();
        setHighlight(enabled.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (current !== undefined) activate(current);
        break;
      case 'Tab':
        closeMenu(false);
        break;
      default:
        break;
    }
  };

  if (groups.length === 0) return null;

  return (
    <div ref={rootRef} className="flex items-center">
      <div role="menubar" aria-label={t('shell.menuBar')} className="flex items-center gap-0.5">
        {groups.map((group) => {
          const groupLabel = t(MENU_GROUP_KEYS[group]);
          const open = openGroup === group;
          const menuId = `${id}-${group}`;
          return (
            // `none` is the ARIA escape hatch for exactly this shape: the wrapper
            // only positions the menu under its trigger, so it is removed from the
            // accessibility tree and the menubar owns the trigger and the menu
            // directly. `<div role="group">` would be the other legal choice, but a
            // `<fieldset>` (what that role maps to) is form semantics, not menus.
            <div key={group} role="none" className="relative">
              <button
                type="button"
                id={`${menuId}-trigger`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                tabIndex={group === anchor ? 0 : -1}
                ref={(element) => {
                  if (element === null) triggerRefs.current.delete(group);
                  else triggerRefs.current.set(group, element);
                }}
                onClick={() => (open ? closeMenu(true) : openMenu(group, false, false))}
                onKeyDown={(event) => handleTriggerKeyDown(event, group)}
                onPointerEnter={() => {
                  // Hovering another trigger while a menu is open moves the menu —
                  // the behaviour every desktop menu bar has.
                  if (openGroup !== null && !open) openMenu(group, false, false);
                }}
                className={`rounded-sm px-2 py-1 text-xs ${
                  open ? 'bg-kumo-tint text-kumo-strong' : 'text-kumo-default hover:bg-kumo-tint'
                }`}
              >
                {groupLabel}
              </button>
              {open ? (
                <div
                  ref={panelRef}
                  id={menuId}
                  role="menu"
                  aria-labelledby={`${menuId}-trigger`}
                  // Programmatic focus, never a tab stop: the container holds focus
                  // while `aria-activedescendant` names the highlighted item.
                  tabIndex={-1}
                  aria-activedescendant={
                    current === undefined ? undefined : `${menuId}-${items.indexOf(current)}`
                  }
                  onKeyDown={handlePanelKeyDown}
                  className="absolute top-full left-0 z-50 mt-0.5 flex max-h-[min(70vh,32rem)] min-w-48 flex-col gap-0.5 overflow-y-auto rounded-md border border-kumo-line bg-kumo-base p-1 outline-none"
                >
                  {items.map((command, index) => (
                    <button
                      key={command.id}
                      id={`${menuId}-${index}`}
                      type="button"
                      // A command with a `checked` state is a toggle, and its role has
                      // to say so for `aria-checked` to be legal — so both travel
                      // together in one spread.
                      role={command.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                      {...(command.checked === undefined ? {} : { 'aria-checked': command.checked })}
                      disabled={command.disabled === true}
                      tabIndex={-1}
                      onClick={() => activate(command)}
                      onPointerEnter={() => {
                        const at = enabled.indexOf(command);
                        if (at >= 0) setHighlight(at);
                      }}
                      // The old disabled class named a text token Kumo does not
                      // declare, so a disabled row rendered exactly like an
                      // enabled one. `subtle` is Kumo's own disabled text and
                      // stays legible.
                      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-kumo-tint disabled:text-kumo-subtle disabled:hover:bg-transparent ${
                        command.danger === true ? 'text-kumo-danger' : 'text-kumo-default'
                      }`}
                    >
                      {command.icon === undefined ? null : (
                        <span aria-hidden="true" className="shrink-0 text-kumo-subtle">
                          {command.icon}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{t(command.labelKey)}</span>
                      {command.checked === true ? (
                        <Check aria-hidden="true" className="size-3 shrink-0" />
                      ) : null}
                      {command.shortcut === undefined ? null : (
                        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-kumo-subtle">
                          {command.shortcut}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
