/**
 * What the export dialog's choice starts, where the context menu opens, and the route the
 * read-only panels take to the working bytes.
 *
 * The feature's own state is `export-store.ts`. What the shell still holds — the operation
 * dialog opener and the PDF download — arrives as deps; the active tab and its handle are read **at call time**.
 */

import type { OperationContext } from 'pdf-core/ops/types';
import type { SessionStore } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import type { FieldValue } from 'pdf-ui';
import type { ExportOptions } from 'pdf-ui/dialog';
import { compressionPresets } from '../../export-presets';
import { materializeBase } from '../../operations';
import { documentContext } from '../core/document';
import { handleFor } from '../core/handles';
import { editableOverlays } from '../marks/overlays';
import { openContextMenu } from './export-store';

/** What the shell still holds that the export choice runs on. */
export interface ExportDeps {
  /** Open the operation dialog `id`, its form starting from `presets`. */
  readonly openDialog: (id: string, presets?: Readonly<Record<string, FieldValue>>) => void;
  /** Download the active document as a PDF. */
  readonly exportActive: () => Promise<void>;
}

/** Run the export the dialog chose: a PDF downloads, every other kind opens its operation form. */
export function createExportChoice(deps: ExportDeps): (choice: ExportOptions) => void {
  return (choice) => {
    if (choice.kind === 'pdf') {
      void deps.exportActive();
    } else if (choice.kind === 'compressed') {
      // The level chosen in the export dialog fills the form; it was read and dropped.
      deps.openDialog('compress', compressionPresets(choice.compressionLevel));
    } else if (choice.kind === 'images') {
      // The choice made in the export dialog is the form's starting value; dropping it
      // made a JPG request open a PNG form.
      deps.openDialog('export-images', { format: choice.imageFormat === 'jpg' ? 'jpeg' : 'png' });
    } else if (choice.kind === 'text') {
      deps.openDialog('export-text');
    } else {
      // The Word layout is the form's own field only while Word is the format.
      const format = choice.officeFormat ?? 'docx';
      deps.openDialog(
        'export-office',
        format === 'docx' ? { format, layout: choice.officeLayout ?? 'layout' } : { format },
      );
    }
  };
}

/** Open the context menu where the pointer is, carrying the words the browser has selected. */
export function showContextMenu(event: {
  readonly preventDefault: () => void;
  readonly clientX: number;
  readonly clientY: number;
}): void {
  event.preventDefault();
  const selection = window.getSelection()?.toString().trim() ?? '';
  openContextMenu({
    x: event.clientX,
    y: event.clientY,
    hasSelection: selection.length > 0,
    selectedText: selection,
  });
}

/** What the working-bytes reader runs on. */
export interface CurrentBytesDeps {
  readonly session: SessionStore;
  readonly t: Translator;
}

/**
 * The session-to-bytes route the read-only panels take (`workingBytes`): the live tab and
 * handle are read at call time for the same reason a save reads them — a control rendered
 * before the last operation must not hand over the previous version.
 */
export function createCurrentBytes(
  deps: CurrentBytesDeps,
): (operation: OperationContext) => Promise<Uint8Array> {
  return async (operation) => {
    const tab = deps.session.active;
    const handle = tab === null ? null : (handleFor(tab.id) ?? null);
    if (tab === null || handle === null) throw new ToolError('selection-empty', { engine: 'model' });
    return materializeBase(
      documentContext(deps.session, deps.t, tab, handle),
      operation,
      undefined,
      editableOverlays(tab),
    );
  };
}
