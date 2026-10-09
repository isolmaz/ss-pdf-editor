/** The palette and the settings dialog: both mount when they open, so neither reaches the entry chunk. */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import { lazy, Suspense } from 'react';
import { visibleCommands } from '../../commands';
import { useCore } from '../core/core-store';
import type { ShellActions } from './shell-actions';
import { closePalette, closeSettings, useShell } from './shell-store';
import { useEditState } from './use-edit-state';

/**
 * The command palette is the only consumer of Kumo's command palette, which held the entry
 * chunk over the budget. It is reached by a gesture, so it loads on demand — and `main.tsx`
 * prefetches it while the browser is idle, so the first `Ctrl+K` is not a visible wait.
 */
const CommandPalette = lazy(async () => {
  const module = await import('pdf-ui/palette');
  return { default: module.CommandPalette };
});

const SettingsDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.SettingsDialog };
});

export interface PaletteHostProps {
  readonly t: Translator;
  readonly commands: readonly Command[];
  readonly changeMode: ShellActions['changeMode'];
}

export function PaletteHost({ t, commands, changeMode }: PaletteHostProps) {
  const paletteOpen = useShell((state) => state.paletteOpen);
  const mode = useCore((state) => state.mode);
  if (!paletteOpen) return null;
  const visible = mode === 'simple' ? visibleCommands(commands, 'simple') : commands;
  return (
    <Suspense fallback={null}>
      <CommandPalette
        t={t}
        commands={visible}
        open={paletteOpen}
        onClose={closePalette}
        onRun={(command) => {
          closePalette();
          command.run();
        }}
        hiddenByMode={commands.length - visible.length}
        onUseAdvanced={() => changeMode('advanced')}
      />
    </Suspense>
  );
}

export interface SettingsHostProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  readonly actions: Pick<
    ShellActions,
    | 'changeMode'
    | 'toggleSensitiveSession'
    | 'opfsSave'
    | 'purgeActiveDocument'
    | 'sweepVault'
    | 'prepareOfflinePackages'
    | 'checkOffline'
    | 'showShortcuts'
  >;
}

export function SettingsHost({ session, tier, t, actions }: SettingsHostProps) {
  const settingsOpen = useShell((state) => state.settingsOpen);
  const mode = useCore((state) => state.mode);
  const { activeTab } = useEditState(session, tier);
  if (!settingsOpen) return null;
  return (
    <Suspense fallback={null}>
      <SettingsDialog
        t={t}
        onClose={closeSettings}
        mode={mode}
        onModeChange={actions.changeMode}
        sensitive={activeTab === null ? null : activeTab.sensitive}
        onToggleSensitive={actions.toggleSensitiveSession}
        onSaveDraft={() => void actions.opfsSave()}
        onPurgeDocument={() => void actions.purgeActiveDocument()}
        onSweepVault={() => void actions.sweepVault()}
        onPrepareOffline={() => void actions.prepareOfflinePackages()}
        onCheckOffline={() => void actions.checkOffline()}
        onShowShortcuts={() => {
          closeSettings();
          actions.showShortcuts();
        }}
      />
    </Suspense>
  );
}
