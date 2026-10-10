/**
 * The surfaces that carry the document out of the window or act on the pointer's place in it —
 * the export dialog and the canvas context menu — wired to the export store. The dialog loads
 * on demand: it is reached by a gesture, so it does not belong in the first paint.
 */

import type { RedactRect } from 'pdf-core/ops/redact';
import type { SessionTab } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import type { ExportOptions } from 'pdf-ui/dialog';
import { selectionBoxes } from 'pdf-ui/tools';
import { ContextMenu } from 'pdf-ui/ui';
import type { ViewerApi } from 'pdf-ui/viewer';
import { lazy, Suspense } from 'react';
import type { MarkedRedaction } from '../../annotation-interaction';
import type { PageAction } from '../../operations';
import { pickTool, selectTool } from '../core/core-store';
import type { OverlayChange } from '../core/overlays';
import { closeContextMenu, closeExportDialog, useExport } from './export-store';

const ExportDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.ExportDialog };
});

export interface ExportDialogHostProps {
  readonly t: Translator;
  /** The active tab; the dialog is on screen only while there is one. */
  readonly tab: SessionTab | null;
  /** Run the export the dialog chose. */
  readonly onExport: (options: ExportOptions) => void;
}

/** Mounted only while the store says the dialog is open and a document is. */
export function ExportDialogHost({ t, tab, onExport }: ExportDialogHostProps) {
  const exportOpen = useExport((state) => state.exportOpen);
  if (!exportOpen || tab === null) return null;
  return (
    <Suspense fallback={null}>
      <ExportDialog
        open={exportOpen}
        t={t}
        fileName={tab.name}
        fileSize={(tab.working.produced?.bytes ?? tab.source.master).byteLength}
        onClose={closeExportDialog}
        onExport={onExport}
      />
    </Suspense>
  );
}

/**
 * The browser's text selection as pending redaction areas, one per selected line, in
 * the redaction writer's own space. The words the user selected are exactly the words
 * the areas cover, so "select, right-click, Redact" marks what was selected instead of
 * only arming a tool that then waits for a drag.
 */
function selectionRedactAreas(viewer: ViewerApi): readonly RedactRect[] {
  return selectionBoxes(viewer).flatMap((selection) =>
    selection.boxes.map((box) => ({ pageIndex: selection.pageIndex, space: 'app-v1' as const, rect: box })),
  );
}

export interface ContextMenuHostProps {
  readonly t: Translator;
  readonly canEdit: boolean;
  /** The viewer API, read when an entry is chosen. */
  readonly viewer: { readonly current: ViewerApi | null };
  /** Change the active tab's pending redaction marks. */
  readonly setRedactionMarks: (change: OverlayChange<readonly MarkedRedaction[]>) => void;
  readonly onPageAction: (action: PageAction) => void;
}

/** Mounted only while the store holds a menu to show. */
export function ContextMenuHost({
  t,
  canEdit,
  viewer,
  setRedactionMarks,
  onPageAction,
}: ContextMenuHostProps) {
  const contextMenu = useExport((state) => state.contextMenu);
  if (contextMenu === null) return null;
  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      t={t}
      hasSelection={contextMenu.hasSelection}
      selectedText={contextMenu.selectedText}
      canEdit={canEdit}
      onHighlight={() => selectTool('highlight')}
      onUnderline={() => selectTool('underline')}
      onStrikeout={() => selectTool('strikeout')}
      onCopy={() => {
        if (contextMenu.selectedText) void navigator.clipboard.writeText(contextMenu.selectedText);
      }}
      onRedact={() => {
        // The selected words become pending redaction areas at once; the tool stays
        // armed so the strip offers the explicit Apply.
        const viewerNow = viewer.current;
        if (viewerNow !== null) {
          const areas = selectionRedactAreas(viewerNow);
          if (areas.length > 0) {
            setRedactionMarks((marks) => [
              ...marks,
              ...areas.map((mark) => ({ id: crypto.randomUUID(), mark })),
            ]);
            window.getSelection()?.removeAllRanges();
          }
        }
        selectTool('redact');
      }}
      onAddNote={() => pickTool('note')}
      onRotateRight={() => onPageAction({ kind: 'rotate', direction: 'right' })}
      onRotateLeft={() => onPageAction({ kind: 'rotate', direction: 'left' })}
      onDeletePage={() => onPageAction({ kind: 'delete' })}
      onAddText={() => pickTool('freetext')}
      onEditText={() => pickTool('text')}
      onDrawInk={() => pickTool('ink')}
      onFitWidth={() => viewer.current?.setZoom('page-width')}
      onClose={closeContextMenu}
    />
  );
}
