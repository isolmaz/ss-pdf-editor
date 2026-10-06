/**
 * The operation dialog registry.
 *
 * Every capability the file/page/tools menus can run is described by exactly one
 * `OperationDialogSpec`, and each spec is loaded **when its dialog opens** rather
 * than with the shell. The specs are not small — field tables, page-scope
 * handling, per-mode previews — and none of them is needed to paint the editor,
 * so keeping them out of the entry graph is what holds the first-paint budget
 * (≤ 250 KiB gzip) while still shipping fifteen capabilities.
 *
 * The map is the single source of truth for "which dialogs exist": `App.tsx` asks
 * for one by id, and an unknown id is a no-op rather than an empty dialog.
 */

import type { OperationDialogSpec } from '../dialogs/types';

/** One loader per dialog id; the id is the same string the command registry opens. */
const LOADERS: Record<string, () => Promise<OperationDialogSpec>> = {
  'add-document': async () => (await import('./file')).addDocumentDialog,
  'images-to-pdf': async () => (await import('./file')).imagesToPdfDialog,
  'export-images': async () => (await import('./file')).exportImagesDialog,
  'export-text': async () => (await import('./file')).exportTextDialog,
  'export-office': async () => (await import('./office')).exportOfficeDialog,
  'extract-pages': async () => (await import('./pages')).extractPagesDialog,
  split: async () => (await import('./pages')).splitDialog,
  compress: async () => (await import('./optimize')).compressDialog,
  'page-numbers': async () => (await import('./stamp')).pageNumbersDialog,
  watermark: async () => (await import('./stamp')).watermarkDialog,
  properties: async () => (await import('./properties')).propertiesDialog,
  protect: async () => (await import('./security')).protectDialog,
  unlock: async () => (await import('./security')).unlockDialog,
  redact: async () => (await import('./redact')).redactDialog,
  ocr: async () => (await import('./ocr')).ocrDialog,
  impose: async () => (await import('./impose')).imposeDialog,
  'form-fields': async () => (await import('./forms')).formFieldsDialog,
  'form-create-field': async () => (await import('./forms')).createFieldDialog,
  'form-data': async () => (await import('./forms')).formDataDialog,
  'page-boxes': async () => (await import('./pageboxes')).pageBoxesDialog,
  'page-labels': async () => (await import('./pagelabels')).pageLabelsDialog,
  'insert-pages': async () => (await import('./pageedit')).insertPagesDialog,
  'replace-pages': async () => (await import('./pageedit')).replacePagesDialog,
  'text-edit': async () => (await import('./TextEditSurface')).textEditDialog,
  'outline-edit': async () => (await import('./outline-edit')).outlineEditDialog,
  'link-add': async () => (await import('./link-add')).linkAddDialog,
  'image-edit': async () => (await import('./image-edit')).imageEditDialog,
  sign: async () => (await import('./sign')).signDialog,
  'new-document': async () => (await import('./start')).newDocumentDialog,
  'merge-files': async () => (await import('./start')).mergeFilesDialog,
  'convert-to-pdf': async () => (await import('./convert')).convertDialog,
};

/**
 * The dialogs that start a document instead of changing one (`OperationDialogSpec.standalone`).
 * Known synchronously, before the spec loads, because the shell decides from the id alone
 * whether an opening needs a document at all.
 */
const STANDALONE: ReadonlySet<string> = new Set([
  'images-to-pdf',
  'new-document',
  'merge-files',
  'convert-to-pdf',
]);

export function isStandaloneDialog(id: string): boolean {
  return STANDALONE.has(id);
}

/** Dialog ids the menus and the palette can open, for tests and documentation. */
export const DIALOG_IDS: readonly string[] = Object.keys(LOADERS);

export function hasDialog(id: string): boolean {
  return id in LOADERS;
}

export async function dialogById(id: string): Promise<OperationDialogSpec | undefined> {
  const load = LOADERS[id];
  return load === undefined ? undefined : await load();
}
