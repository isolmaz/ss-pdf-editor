/**
 * The dock panels whose modules carry a **writer**.
 *
 * Each of these three panels is the only consumer of an operation module that
 * loads an engine: the properties panel needs the font reader, the signature
 * verifier and the embedded-file writer; the form panel needs the form writer; the
 * audit panel needs the byte-level auditor. None of them is visible
 * before a tab is opened, so re-exporting them through one module gives the shell
 * a single dynamic-import boundary — and keeps a capability nobody has asked for
 * out of the first paint, which is what the ≤250 KiB budget is for (`PLAN.md §7`).
 *
 * The re-export is the whole file: the panels themselves stay where they are, so
 * nothing about their own surface changes.
 */

export { AccessibilityPanel, type AccessibilityPanelProps } from './AccessibilityPanel';
export { CommentsPanel, type CommentsPanelProps } from './CommentsPanel';
export { ComparePanel, type ComparePanelProps } from './ComparePanel';
export { FormPanel, type FormPanelProps } from './FormPanel';
export { PropertiesPanel, type PropertiesPanelProps } from './PropertiesPanel';
export { RedactionAuditPanel, type RedactionAuditPanelProps } from './RedactionAuditPanel';
