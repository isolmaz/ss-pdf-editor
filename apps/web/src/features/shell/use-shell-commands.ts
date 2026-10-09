/**
 * The command list the menus, the palette and the home screen's tool grid all read, and the
 * home screen's way of running one.
 *
 * The list is built from the stores (what is armed, which docks are open, the zoom, the
 * selection) and from the feature handlers the shell hands in, so it is rebuilt exactly when
 * one of those changes.
 */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import { useTheme } from 'pdf-ui/ui';
import { useCallback, useEffect, useMemo } from 'react';
import { buildCommands, STANDALONE_COMMAND_IDS } from '../../commands';
import {
  openLeftPanel,
  openRightPanel,
  selectTool,
  toggleLeftDock,
  toggleRightDock,
  useCore,
} from '../core/core-store';
import { openBatchDialog } from '../dialogs/dialogs-store';
import { armMeasure, useMeasureMode } from '../measure/measure-store';
import {
  awaitHomeCommand,
  clearPageSelection,
  dropHomeCommand,
  hideStartScreen,
  openStore,
  selectAllPages,
  useOpen,
} from '../open/open-store';
import { toggleMagnifier, toggleReading, useReading } from '../reading/reading-store';
import { currentViewer, useSave } from '../save/save-store';
import { useSelection } from '../selection/selection-store';
import type { ShellActions } from './shell-actions';
import { openSettings, renameTab, summonPalette } from './shell-store';
import { useEditState } from './use-edit-state';

/** Enter fullscreen, or leave it when the window already is. */
export async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement === null) await document.documentElement.requestFullscreen();
  else await document.exitFullscreen();
}

export interface ShellCommands {
  readonly commands: readonly Command[];
  /**
   * A tool picked on the home screen. A standalone command (blank document, images, merge,
   * batch) runs at once; with a document open the command runs on it; with none, the file is
   * asked for first and the command waits for its tab.
   */
  readonly runHomeCommand: (commandId: string) => void;
}

export function useShellCommands(
  session: SessionStore,
  tier: DeviceTier,
  actions: ShellActions,
): ShellCommands {
  const { theme, setTheme } = useTheme();
  const { activeTab, activeHandle, canEdit, canPrepareWrite, pageCount } = useEditState(session, tier);
  const zoom = useSave((state) => state.zoom);
  const viewer = useSave((state) => state.viewer);
  const selectedPages = useOpen((state) => state.selectedPages);
  const magnifier = useReading((state) => state.magnifierOn);
  const reading = useReading((state) => state.reading);
  const leftDock = useCore((state) => state.leftDock);
  const rightDock = useCore((state) => state.rightDock);
  const canvasTool = useCore((state) => state.canvasTool);
  const mode = useCore((state) => state.mode);
  const busy = useCore((state) => state.busy);
  const selectedMarkCount = useSelection((state) => state.selectedKeys.length);
  const measureMode = useMeasureMode();
  const {
    t,
    openViaPicker,
    saveActive,
    exportActive,
    closeTab,
    openDialog,
    showShortcuts,
    runPageAction,
    stepHistoryNow,
    openPrint,
    openSnapshotMenu,
    openXfaForm,
    startFormDetect,
    openSignature,
    pickImage,
    deleteMarkSelection,
    selectAllMarks,
    toggleSensitiveSession,
    opfsSave,
    purgeActiveDocument,
    sweepVault,
    checkOffline,
    prepareOfflinePackages,
  } = actions;

  const commands = useMemo(
    () =>
      buildCommands({
        t,
        hasDocument: activeTab !== null,
        canEdit,
        canUndo: activeTab?.journal.canUndo ?? false,
        canRedo: activeTab?.journal.canRedo ?? false,
        canSave: canPrepareWrite && activeTab?.source.handle !== undefined,
        canExport: canPrepareWrite,
        selectedPages,
        zoom,
        magnifier,
        reading,
        leftDock,
        rightDock,
        openFile: () => void openViaPicker(),
        save: () => void saveActive(),
        exportDocument: () => void exportActive(),
        print: openPrint,
        openBatch: openBatchDialog,
        openSignature,
        addImage: pickImage,
        measure: armMeasure,
        measureMode,
        detectFormFields: startFormDetect,
        showRightTab: openRightPanel,
        undo: () => stepHistoryNow('undo'),
        redo: () => stepHistoryNow('redo'),
        rename: () => renameTab(activeTab?.id ?? null),
        closeTab: () => {
          if (activeTab !== null) closeTab(activeTab.id);
        },
        openDialog,
        openXfaForm,
        showShortcuts,
        openSettings,
        pageAction: runPageAction,
        setZoom: (value) => currentViewer()?.setZoom(value),
        setSpread: (spread) => currentViewer()?.setSpreadMode(spread),
        toggleFullscreen: () => void toggleFullscreen(),
        toggleReading,
        toggleMagnifier,
        openSnapshot: openSnapshotMenu,
        toggleLeftDock,
        toggleRightDock,
        selectAllPages: () => selectAllPages(pageCount),
        clearSelection: clearPageSelection,
        palette: summonPalette,
        openLeftTab: openLeftPanel,
        activeTool: canvasTool,
        armTool: selectTool,
        selectedMarkCount,
        deleteMarkSelection: () => void deleteMarkSelection(),
        selectAllMarks: () => void selectAllMarks(),
        showRedactionAudit: () => openRightPanel('redaction-audit'),
        theme,
        setTheme,
        sensitiveSession: activeTab?.sensitive ?? false,
        toggleSensitiveSession,
        opfsSave: () => void opfsSave(),
        purgeActiveDocument: () => void purgeActiveDocument(),
        sweepVault: () => void sweepVault(),
        checkOffline: () => void checkOffline(),
        prepareOfflinePackages: () => void prepareOfflinePackages(),
        mode,
      }),
    [
      t,
      activeTab,
      canEdit,
      canPrepareWrite,
      selectedPages,
      zoom,
      magnifier,
      reading,
      leftDock,
      rightDock,
      openViaPicker,
      saveActive,
      exportActive,
      openPrint,
      openSignature,
      pickImage,
      measureMode,
      startFormDetect,
      stepHistoryNow,
      closeTab,
      openDialog,
      openXfaForm,
      showShortcuts,
      runPageAction,
      openSnapshotMenu,
      pageCount,
      canvasTool,
      selectedMarkCount,
      deleteMarkSelection,
      selectAllMarks,
      theme,
      setTheme,
      toggleSensitiveSession,
      opfsSave,
      purgeActiveDocument,
      sweepVault,
      checkOffline,
      prepareOfflinePackages,
      mode,
    ],
  );

  const runHomeCommand = useCallback(
    (commandId: string) => {
      const command = commands.find((item) => item.id === commandId);
      if (command === undefined) return;
      if (STANDALONE_COMMAND_IDS.has(commandId)) {
        command.run();
        return;
      }
      if (activeTab !== null && activeHandle !== null) {
        if (command.disabled === true) return;
        hideStartScreen();
        command.run();
        return;
      }
      awaitHomeCommand(commandId);
      void openViaPicker();
    },
    [activeHandle, activeTab, commands, openViaPicker],
  );

  useEffect(() => {
    const pending = openStore.get().pendingHomeCommand;
    // The open that brought the document is still holding the busy gate until it settles:
    // a dialog asked for before then is refused as "another operation is running".
    if (pending === null || viewer === null || activeHandle === null || busy) return;
    dropHomeCommand();
    const command = commands.find((item) => item.id === pending);
    if (command !== undefined && command.disabled !== true) command.run();
  }, [viewer, activeHandle, busy, commands]);

  return { commands, runHomeCommand };
}
