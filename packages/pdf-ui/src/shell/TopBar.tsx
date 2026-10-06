import { Command, DownloadSimple, FloppyDisk, FolderOpen, MagnifyingGlass } from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import type { ReactNode } from 'react';
import { Button } from '../components/Button';

/**
 * Top bar: identity, the menu bar, the two file verbs and the honesty line.
 *
 * Menus and the command palette arrive as props rather than being built here: the
 * bar owns the layout, `MenuBar` owns the menubar's keyboard model and the app
 * owns the command table. The tool toolbar is a Phase 3 surface; this skeleton
 * carries only what the shell must prove (open a document, show the Save/Export
 * split from `K5`/`K22`, state the locality claim). Phase 0 renders on desktop
 * Chromium; the compact/mobile variants of §4.4 arrive with the panels they
 * belong to.
 */

export interface TopBarProps {
  readonly t: Translator;
  /** The application menu bar; rendered between the identity and the actions. */
  readonly menu?: ReactNode;
  /** Opens the `Ctrl+K` command palette; renders a search-labelled button when provided. */
  readonly onPalette?: () => void;
  readonly onOpen: () => void;
  readonly onSearch: () => void;
  readonly canSave: boolean;
  readonly canExport: boolean;
  readonly onSave: () => void;
  readonly onExport: () => void;
}

export function TopBar({
  t,
  menu,
  onPalette,
  onOpen,
  onSearch,
  canSave,
  canExport,
  onSave,
  onExport,
}: TopBarProps) {
  return (
    <header className="flex h-[var(--spacing-pdf-topbar)] items-center gap-3 border-b border-kumo-line bg-kumo-base px-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-kumo-strong">{t('app.name')}</span>
        <span className="hidden text-xs text-kumo-subtle lg:inline">{t('app.tagline')}</span>
      </div>
      {/* `min-w-0` is what lets the menu bar shrink: its flex base size is its
          content, so without it a wide menu squeezes the action cluster. No
          `overflow-hidden` here — the menus open out of this box and would be
          clipped by it. */}
      {menu === undefined ? null : <div className="min-w-0 flex-1">{menu}</div>}
      <div className="ml-auto flex items-center gap-2">
        {onPalette === undefined ? null : (
          <Button
            icon={Command}
            shape="square"
            variant="ghost"
            title={t('shell.commandPalette')}
            aria-label={t('shell.commandPalette')}
            onClick={onPalette}
          />
        )}
        <Button
          icon={MagnifyingGlass}
          shape="square"
          variant="ghost"
          title={t('viewer.find.label')}
          aria-label={t('viewer.find.label')}
          onClick={onSearch}
        />
        <Button icon={FolderOpen} onClick={onOpen} variant="outline">
          {t('shell.open')}
        </Button>
        <Button icon={FloppyDisk} onClick={onSave} disabled={!canSave}>
          {t('shell.save')}
        </Button>
        <Button icon={DownloadSimple} onClick={onExport} disabled={!canExport}>
          {t('shell.export')}
        </Button>
      </div>
    </header>
  );
}
