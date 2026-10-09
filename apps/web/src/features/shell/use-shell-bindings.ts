/**
 * The keyboard layer's actions (`useShortcuts.ts` owns the chords): each one reads the viewer, the
 * zoom, the page and the session **when the key is pressed**, so the table is rebuilt only when a
 * handler changes, never because the user scrolled or zoomed.
 */

import { type SessionStore, workingPageCount } from 'pdf-model';
import { isPresenting } from 'pdf-ui/tools';
import { useMemo } from 'react';
import { useShellShortcuts } from '../../useShortcuts';
import { toggleLeftDock, toggleRightDock } from '../core/core-store';
import { canEdit } from '../core/document';
import { openExportDialog } from '../export/export-store';
import { toggleReading } from '../reading/reading-store';
import { currentViewer, saveStore } from '../save/save-store';
import type { ShellActions } from './shell-actions';
import { summonPalette } from './shell-store';

/**
 * A page key's action: the viewer goes to the page `target` names, read when the key is pressed.
 *
 * A presentation turns the page keys itself, and both listeners sit on `window`'s capture phase,
 * where the first to register runs first whatever `stopPropagation` says — so the shell would turn
 * a page and the presentation, finding the viewer on the new page, one more. The shell therefore
 * declines while one is on (`false`: the key is neither cancelled nor stopped), and a key press
 * turns exactly one page whichever listener is reached first.
 */
function turnPage(target: () => number): false | undefined {
  const viewer = currentViewer();
  if (isPresenting(viewer)) return false;
  viewer?.goToPage(target());
  return undefined;
}

export interface ShellBindingHost {
  readonly session: SessionStore;
  readonly actions: ShellActions;
}

export function useShellBindings({ session, actions }: ShellBindingHost): void {
  const {
    openViaPicker,
    saveActive,
    deleteMarkSelection,
    openPrint,
    stepHistoryNow,
    openDialog,
    selectAllMarks,
  } = actions;
  useShellShortcuts(
    useMemo(
      () => ({
        open: () => void openViaPicker(),
        save: () => void saveActive(),
        exportDocument: () => openExportDialog(),
        // The whole common selection, across every mark family, and only when there is
        // one: the key is not swallowed to mean nothing.
        deleteSelection: deleteMarkSelection,
        print: openPrint,
        zoomIn: () => currentViewer()?.setZoom(Math.min(4, saveStore.get().zoom + 0.25)),
        zoomOut: () => currentViewer()?.setZoom(Math.max(0.25, saveStore.get().zoom - 0.25)),
        zoomReset: () => currentViewer()?.setZoom(1),
        fitWidth: () => currentViewer()?.setZoom('page-width'),
        nextPage: () => turnPage(() => saveStore.get().currentPage + 1),
        previousPage: () => turnPage(() => saveStore.get().currentPage - 1),
        firstPage: () => turnPage(() => 0),
        lastPage: () =>
          turnPage(() => {
            const tab = session.active;
            return Math.max(0, (tab === null ? 0 : workingPageCount(tab)) - 1);
          }),
        undo: () => stepHistoryNow('undo'),
        redo: () => stepHistoryNow('redo'),
        palette: summonPalette,
        toggleLeftDock,
        toggleRightDock,
        reading: toggleReading,
        documentProperties: () => openDialog('properties'),
        findReplace: () => {
          if (!canEdit(session)) return false;
          openDialog('find-replace');
          return true;
        },
        selectAllMarks,
      }),
      [
        deleteMarkSelection,
        openDialog,
        openPrint,
        openViaPicker,
        saveActive,
        selectAllMarks,
        session,
        stepHistoryNow,
      ],
    ),
  );
}
