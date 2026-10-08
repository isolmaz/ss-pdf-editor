/**
 * The shell's own primitives, behind one import path.
 *
 * The library's root export re-exports every panel, dialog and tool, and a barrel
 * over a large surface is what the bundler cannot reduce: importing one component
 * through it brought the whole graph into the first paint (measured: 206 KiB gzip
 * for the barrel against 15 KiB for the viewer pane alone). The
 * shell therefore imports the group it needs, and each group is a plain
 * re-export of the components in it — no behaviour lives here.
 *
 * A re-export here is an **eager edge**: everything listed below is reachable
 * from `main.tsx` and lands in the first-paint chunk, so a component only gets an
 * entry when the shell renders it before the user asks for anything. Nothing is
 * re-exported "for convenience" — a surface with a lazy boundary of its own is
 * reached through that boundary, not through this file:
 *
 *  - `CommandPalette` is loaded by the shell's own dynamic import (its Kumo
 *    command palette is the single largest block this barrel used to carry).
 *  - `PagesPanel` is imported by `DocumentPanel`, the only component that mounts
 *    it; it never needed to travel through the shell to get there.
 */

export { MenuBar, type MenuBarProps } from '../commands/MenuBar';
export { type Command, MENU_GROUPS, type MenuGroup } from '../commands/types';
export { type AppButtonProps, Button } from '../components/Button';
export {
  applyLocale,
  getStoredLocale,
  LanguageSelector,
  type LanguageSelectorProps,
  useLocale,
} from '../components/LanguageSelector';
export {
  applyTheme,
  getStoredTheme,
  type ThemeMode,
  ThemeSelector,
  type ThemeSelectorProps,
  useTheme,
} from '../components/ThemeSelector';
export { Tooltip, type TooltipProps, type TooltipSide } from '../components/Tooltip';
export type {
  DialogParams,
  DialogResultKind,
  FieldCondition,
  FieldOption,
  FieldSpec,
  FieldValue,
  OperationDialogSpec,
  OpRunContext,
  OpRunResult,
} from '../dialogs/types';
export type { OperationRunContext } from '../dialogs/useOperationRun';
export { DIALOG_IDS, dialogById, hasDialog, isStandaloneDialog } from '../ops';
export {
  AnnotationLayer,
  type AnnotationLayerProps,
  type AnnotationTool,
  type TextSelection,
} from '../ops/AnnotationLayer';
export { RedactionLayer, type RedactionLayerProps } from '../ops/RedactionLayer';
export type { DocumentPanelTab } from '../panels/DocumentPanel';
export { DocumentPanel, type DocumentPanelProps, type OutlineEntry } from '../panels/DocumentPanel';
export { HistoryPanel, type HistoryPanelProps } from '../panels/HistoryPanel';
export { RedactionPanel, type RedactionPanelProps } from '../panels/RedactionPanel';
export { ToolsRailPanel, type ToolsRailPanelProps } from '../panels/ToolsRailPanel';
export { ContextMenu, type ContextMenuProps } from '../viewer/ContextMenu';
export { Dock, type DockProps, type DockTab } from './Dock';
export { StatusBar, type StatusBarProps } from './StatusBar';
