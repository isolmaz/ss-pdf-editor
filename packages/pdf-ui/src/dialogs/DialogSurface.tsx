/**
 * The dialog surface, behind one dynamic-import boundary.
 *
 * The modal dialogs (close, password, signature warning, export, shortcuts, batch) and
 * `OperationForm` — the one body every operation renders in the tools panel — carry the
 * field widgets, the report panel and the run hook. None of that is reachable before it
 * is opened, so the shell loads it on demand (`PLAN.md §7` budget; the same reason the
 * dock panels have their own boundary).
 *
 * A re-export module, so the components themselves do not move.
 */

export { BatchDialog, type BatchDialogProps } from './BatchDialog';
export { CloseDocumentDialog } from './CloseDocumentDialog';
export { ExportDialog, type ExportDialogProps, type ExportOptions } from './ExportDialog';
export { OperationForm, type OperationFormProps } from './OperationForm';
export { PasswordDialog, type PasswordDialogProps } from './PasswordDialog';
export { OperationReportPanel, type OperationReportPanelProps } from './ReportPanel';
export { SettingsDialog, type SettingsDialogProps } from './SettingsDialog';
export {
  ShortcutsDialog,
  type ShortcutsDialogGroup,
  type ShortcutsDialogProps,
  type ShortcutsDialogRow,
} from './ShortcutsDialog';
export { SignatureWarningDialog, type SignatureWarningDialogProps } from './SignatureWarningDialog';
export type { OperationRunContext } from './useOperationRun';
