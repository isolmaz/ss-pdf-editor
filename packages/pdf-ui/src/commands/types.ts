/**
 * Command registry (`PLAN.md §4.1`, §4.3).
 *
 * One description per user action, consumed by three surfaces — the menu bar,
 * the floating toolbar and the `Ctrl+K` palette. Every action therefore has an
 * accessible name, a shortcut hint and a single implementation, which is what
 * "every mouse action has a keyboard equivalent" needs in practice (`§4.4`).
 *
 * Commands are built by the app on every render (they close over live state) and
 * passed down; the components stay presentational so the palette, the menus and
 * the toolbar can never drift apart.
 */

import type { MessageKey } from 'pdf-shared';
import type { ReactNode } from 'react';

export type MenuGroup = 'file' | 'edit' | 'view' | 'page' | 'tools' | 'settings' | 'help';

export const MENU_GROUPS: readonly MenuGroup[] = [
  'file',
  'edit',
  'view',
  'page',
  'tools',
  'settings',
  'help',
];

export const MENU_GROUP_KEYS: Record<MenuGroup, MessageKey> = {
  file: 'shell.menu.file',
  edit: 'shell.menu.edit',
  view: 'shell.menu.view',
  page: 'shell.menu.page',
  tools: 'shell.menu.tools',
  settings: 'shell.menu.settings',
  help: 'shell.menu.help',
};

export interface Command {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly group: MenuGroup;
  /** Display-only hint (the binding itself lives in one table, `useShortcuts`). */
  readonly shortcut?: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  /** Rendered with the danger role; reserved for irreversible operations. */
  readonly danger?: boolean;
  readonly keywords?: readonly string[];
  readonly run: () => void;
}
