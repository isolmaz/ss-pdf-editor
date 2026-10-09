/** The header row: the home header, or the editor's title, tabs, menus and save controls. */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import { MenuBar } from 'pdf-ui/ui';
import { visibleCommands } from '../../commands';
import { ModernEditorHeader } from '../../components/ModernEditorHeader';
import { cancelOperation, showNotice, useCore } from '../core/core-store';
import { openExportDialog } from '../export/export-store';
import { HomeHeader } from '../open/OpenSurfaces';
import { clearPageSelection, showStartScreen } from '../open/open-store';
import { currentViewer } from '../save/save-store';
import { useEditorSurfaces } from './editor-store';
import type { ShellActions } from './shell-actions';
import { openPalette, openSettings, renameTab, useShell } from './shell-store';
import { PRODUCT_TITLE } from './use-document-effects';
import { useEditState } from './use-edit-state';

export interface ShellHeaderProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  readonly commands: readonly Command[];
  readonly actions: Pick<
    ShellActions,
    'openViaPicker' | 'saveActive' | 'exportActive' | 'closeTab' | 'openDialog'
  >;
}

/** What Save does for a tab: write over its file, ask where to write it, or nothing (download is Export). */
function saveModeFor(hasFileHandle: boolean): 'save' | 'saveAs' | 'none' {
  if (hasFileHandle) return 'save';
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
    ? 'saveAs'
    : 'none';
}

export function ShellHeader({ session, tier, t, commands, actions }: ShellHeaderProps) {
  const { activeTab, activeId, tabs, canEdit, canPrepareWrite, isHome } = useEditState(session, tier);
  const mode = useCore((state) => state.mode);
  const renamingId = useShell((state) => state.renamingId);
  const editor = useEditorSurfaces();
  // The editor's header waits for the editor chunk, so header and body switch in one commit.
  if (isHome || activeTab === null || editor === null) {
    return (
      <HomeHeader
        t={t}
        title={PRODUCT_TITLE}
        activeDocumentName={activeTab === null ? null : activeTab.name}
        onSettings={openSettings}
        onPalette={openPalette}
        onOpen={() => void actions.openViaPicker()}
      />
    );
  }
  return (
    <ModernEditorHeader
      t={t}
      docName={activeTab.name}
      renaming={renamingId === activeTab.id}
      onRenameCancel={() => renameTab(null)}
      onRename={(name) => {
        renameTab(null);
        const next = name.trim();
        if (next === '' || next === activeTab.name) return;
        session.renameTab(activeTab.id, next);
        showNotice(t('shell.rename.done', { name: next }));
      }}
      isDirty={activeTab.dirty}
      canEdit={canEdit}
      onConvert={openExportDialog}
      onSign={() => actions.openDialog('sign')}
      onHome={showStartScreen}
      onOpen={() => void actions.openViaPicker()}
      canSave={canPrepareWrite}
      saveMode={saveModeFor(activeTab.source.handle !== undefined)}
      onSave={() => void actions.saveActive()}
      canExport={canPrepareWrite}
      onExport={() => void actions.exportActive()}
      onExportOptions={openExportDialog}
      onSearch={() => currentViewer()?.openFind()}
      onPalette={openPalette}
      menu={<MenuBar t={t} commands={mode === 'simple' ? visibleCommands(commands, 'simple') : commands} />}
      tabs={tabs.map((tab) => ({ id: tab.id, name: tab.name, dirty: tab.dirty }))}
      activeTabId={activeId}
      onSelectTab={(id) => {
        if (session.active?.id !== id) cancelOperation();
        session.setActive(id);
        clearPageSelection();
      }}
      onCloseTab={actions.closeTab}
      onSettings={openSettings}
    />
  );
}
