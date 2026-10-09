/**
 * The keyboard layer's actions (`useShortcuts.ts` owns the chords): each one reads the viewer, the
 * zoom, the page and the session **when the key is pressed**, so the table is rebuilt only when a
 * handler changes, never because the user scrolled or zoomed.
 */

import { type SessionStore, workingPageCount } from 'pdf-model';
import { useMemo } from 'react';
import { useShellShortcuts } from '../../useShortcuts';
import { toggleLeftDock, toggleRightDock } from '../core/core-store';
import { openExportDialog } from '../export/export-store';
import { toggleReading } from '../reading/reading-store';
import { currentViewer, saveStore } from '../save/save-store';
import type { ShellActions } from './shell-actions';
import { summonPalette } from './shell-store';

export interface ShellBindingHost {
  readonly session: SessionStore;
  readonly actions: ShellActions;
  /** Whether a write may start now, read when the key is pressed. */
  readonly canEdit: () => boolean;
}

export function useShellBindings({ session, actions, canEdit }: ShellBindingHost): void {
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
        nextPage: () => currentViewer()?.goToPage(saveStore.get().currentPage + 1),
        previousPage: () => currentViewer()?.goToPage(saveStore.get().currentPage - 1),
        firstPage: () => currentViewer()?.goToPage(0),
        lastPage: () => {
          const tab = session.active;
          currentViewer()?.goToPage(Math.max(0, (tab === null ? 0 : workingPageCount(tab)) - 1));
        },
        undo: () => stepHistoryNow('undo'),
        redo: () => stepHistoryNow('redo'),
        palette: summonPalette,
        toggleLeftDock,
        toggleRightDock,
        reading: toggleReading,
        documentProperties: () => openDialog('properties'),
        findReplace: () => {
          if (!canEdit()) return false;
          openDialog('find-replace');
          return true;
        },
        selectAllMarks,
      }),
      [
        canEdit,
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
