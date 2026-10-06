export { CommandPalette, type CommandPaletteProps } from './commands/CommandPalette';
export { MenuBar, type MenuBarProps } from './commands/MenuBar';
export { type Command, MENU_GROUP_KEYS, MENU_GROUPS, type MenuGroup } from './commands/types';
export { type AppButtonProps, Button } from './components/Button';
export { EmptyState, type EmptyStateProps } from './components/EmptyState';
export {
  applyLocale,
  getStoredLocale,
  LanguageSelector,
  type LanguageSelectorProps,
  useLocale,
} from './components/LanguageSelector';
export { type InterfaceMode, ModeSelector, type ModeSelectorProps } from './components/ModeSelector';
export {
  applyTheme,
  getStoredTheme,
  type ThemeMode,
  ThemeSelector,
  type ThemeSelectorProps,
  useTheme,
} from './components/ThemeSelector';
export { BatchDialog, type BatchDialogProps } from './dialogs/BatchDialog';
export { ExportDialog, type ExportDialogProps, type ExportOptions } from './dialogs/ExportDialog';
export { OperationForm, type OperationFormProps } from './dialogs/OperationForm';
export { OperationReportPanel, type OperationReportPanelProps } from './dialogs/ReportPanel';
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
} from './dialogs/types';
export type { OperationRunContext } from './dialogs/useOperationRun';
export { DIALOG_IDS, dialogById, hasDialog } from './ops';
export {
  AnnotationLayer,
  type AnnotationLayerProps,
  type TextSelection,
} from './ops/AnnotationLayer';
export {
  MeasureLayer,
  type MeasureLayerProps,
  type MeasureReading,
  MeasureSettings,
  type MeasureSettingsProps,
} from './ops/MeasureLayer';
export { RedactionLayer, type RedactionLayerProps } from './ops/RedactionLayer';
export { CommentsPanel, type CommentsPanelProps } from './panels/CommentsPanel';
export {
  DocumentPanel,
  type DocumentPanelProps,
  type DocumentPanelTab,
  type OutlineEntry,
} from './panels/DocumentPanel';
export { FormPanel, type FormPanelProps } from './panels/FormPanel';
export { HistoryPanel, type HistoryPanelProps } from './panels/HistoryPanel';
export { type PageMoveAction, PagesPanel, type PagesPanelProps } from './panels/PagesPanel';
export { PropertiesPanel, type PropertiesPanelProps } from './panels/PropertiesPanel';
export { RedactionAuditPanel, type RedactionAuditPanelProps } from './panels/RedactionAuditPanel';
export { RedactionPanel, type RedactionPanelProps } from './panels/RedactionPanel';
export { ToolsRailPanel, type ToolsRailPanelProps } from './panels/ToolsRailPanel';
export { PrintDialog, type PrintDialogProps } from './printing/PrintDialog';
export { parsePageRange } from './printing/pageRange';
export type { PrintProducedFile, PrintRequest, PrintScale } from './printing/usePrinting';
export { ReadingPane, type ReadingPaneProps } from './reading/ReadingPane';
export type { ReadingViewer } from './reading/useReadingText';
export { Dock, type DockProps, type DockTab } from './shell/Dock';
export { StatusBar, type StatusBarProps } from './shell/StatusBar';
export { type DocumentTabDescriptor, TabStrip, type TabStripProps } from './shell/TabStrip';
export { TopBar, type TopBarProps } from './shell/TopBar';
export { Magnifier, type MagnifierProps } from './tools/Magnifier';
export { SnapshotMenu, type SnapshotMenuProps } from './tools/SnapshotMenu';
export { usePresentation } from './tools/usePresentation';
export { useViewHistory } from './tools/useViewHistory';
export { ContextMenu, type ContextMenuProps } from './viewer/ContextMenu';
export { PdfViewerPane, type PdfViewerPaneProps, type ViewerApi } from './viewer/PdfViewerPane';
