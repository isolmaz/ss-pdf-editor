import type { Icon } from '@phosphor-icons/react';
import {
  BookOpen,
  CaretDown,
  Command,
  DownloadSimple,
  FilePdf,
  FloppyDisk,
  FolderOpen,
  GearSix,
  House,
  MagnifyingGlass,
  PenNib,
  SquaresFour,
  TextT,
  X,
} from '@phosphor-icons/react';
import type { MessageKey, Translator } from 'pdf-shared';
import { Button } from 'pdf-ui/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * The editor's header: identity, menus, the four task shortcuts, the document switcher
 * and the file actions.
 *
 * The task shortcuts used to be five "modes" (Tools, Read, Edit, Convert, Sign) with a
 * highlighted one — but nothing in the app had modes: "Edit" was highlighted on open
 * while the select tool was armed, and "Read" stayed highlighted after the reading pane
 * was closed. They are now what they always did: **toggles that show the real state**
 * (the tools panel, the reading pane, the text-edit tool) and one-shot actions that
 * show none (convert, sign).
 */
export interface ModernEditorHeaderProps {
  readonly t: Translator;
  readonly docName: string;
  /** The name is being edited in place (the Rename command); Enter or blur commits, Escape cancels. */
  readonly renaming?: boolean;
  readonly onRename?: (name: string) => void;
  readonly onRenameCancel?: () => void;
  readonly isDirty: boolean;
  /** The tools panel is open in the right dock. */
  readonly toolsOpen: boolean;
  readonly onTools: () => void;
  /** The reading pane is open. */
  readonly reading: boolean;
  readonly onRead: () => void;
  /** The text-edit tool is armed. */
  readonly editingText: boolean;
  readonly onEditText: () => void;
  readonly canEdit: boolean;
  readonly onConvert: () => void;
  readonly onSign: () => void;
  readonly onHome: () => void;
  readonly onOpen: () => void;
  readonly canSave: boolean;
  /**
   * What Save does for this document: write over the file it came from, ask where to
   * write it first (no file is attached yet), or nothing at all — a browser without the
   * File System Access API can only download, which is Export, so Save is not offered.
   */
  readonly saveMode: 'save' | 'saveAs' | 'none';
  readonly onSave: () => void;
  readonly canExport: boolean;
  readonly onExport: () => void;
  readonly onExportOptions?: () => void;
  readonly onSearch: () => void;
  readonly onPalette: () => void;
  readonly menu?: ReactNode;
  readonly tabs: readonly { readonly id: string; readonly name: string; readonly dirty: boolean }[];
  readonly activeTabId: string | null;
  readonly onSelectTab: (id: string) => void;
  readonly onCloseTab: (id: string) => void;
  /** Language, theme, interface mode, privacy and offline preferences. */
  readonly onSettings: () => void;
}

const TASK_CLASS =
  'flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-kumo-focus disabled:opacity-40';
const TASK_IDLE = 'text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong';
const TASK_ON = 'bg-kumo-recessed text-kumo-strong ring-1 ring-inset ring-kumo-line';
const ICON_CLASS =
  'flex size-8 shrink-0 items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-recessed hover:text-kumo-strong focus-visible:outline-2 focus-visible:outline-kumo-focus';

function TaskButton({
  label,
  icon: Glyph,
  pressed,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly icon: Icon;
  /** Absent for a one-shot action: it has no state to show. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      className={`${TASK_CLASS} ${pressed === true ? TASK_ON : TASK_IDLE}`}
    >
      <Glyph size={14} weight={pressed === true ? 'fill' : 'regular'} aria-hidden="true" />
      <span className="hidden 2xl:inline">{label}</span>
    </button>
  );
}

export function ModernEditorHeader({
  t,
  docName,
  renaming = false,
  onRename,
  onRenameCancel,
  isDirty,
  toolsOpen,
  onTools,
  reading,
  onRead,
  editingText,
  onEditText,
  canEdit,
  onConvert,
  onSign,
  onHome,
  onOpen,
  canSave,
  saveMode,
  onSave,
  canExport,
  onExport,
  onExportOptions,
  onSearch,
  onPalette,
  menu,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onSettings,
}: ModernEditorHeaderProps) {
  const [showTabMenu, setShowTabMenu] = useState(false);
  /** Set by Escape so the blur that follows it cancels instead of committing. */
  const cancelled = useRef(false);
  const switcherRef = useRef<HTMLDivElement | null>(null);

  // The switcher is a popover: a press outside it or Escape closes it. It used to stay
  // open until its own button was pressed again.
  useEffect(() => {
    if (!showTabMenu) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || switcherRef.current?.contains(event.target) !== true) {
        setShowTabMenu(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowTabMenu(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [showTabMenu]);

  const task = (key: MessageKey) => t(key);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-base px-2 select-none sm:px-3">
      {/* Identity and menus: the menus yield first on a narrow bar (they are also in the palette). */}
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onHome}
          className="flex items-center gap-1.5 rounded-md p-1.5 text-kumo-strong transition-colors hover:bg-kumo-recessed"
          title={t('shell.home')}
          aria-label={t('shell.home')}
        >
          <span className="flex size-7 items-center justify-center rounded bg-pdf-accent text-pdf-on-accent">
            <FilePdf size={18} weight="fill" aria-hidden="true" />
          </span>
          <House size={16} className="hidden text-kumo-subtle sm:block" aria-hidden="true" />
        </button>
        {menu ? (
          <div className="hidden items-center border-l border-kumo-line pl-1 md:flex">{menu}</div>
        ) : null}
      </div>

      {/* Task shortcuts: icons below 1536 px, icon and label above. */}
      <nav
        aria-label={t('shell.tasks')}
        className="hidden shrink-0 items-center gap-0.5 border-l border-kumo-line pl-2 lg:flex"
      >
        <TaskButton label={task('mode.tools')} icon={SquaresFour} pressed={toolsOpen} onClick={onTools} />
        <TaskButton label={task('mode.read')} icon={BookOpen} pressed={reading} onClick={onRead} />
        <TaskButton
          label={task('mode.edit')}
          icon={TextT}
          pressed={editingText}
          disabled={!canEdit}
          onClick={onEditText}
        />
        <TaskButton
          label={task('mode.convert')}
          icon={DownloadSimple}
          disabled={!canExport}
          onClick={onConvert}
        />
        <TaskButton label={task('mode.sign')} icon={PenNib} onClick={onSign} />
      </nav>

      {/* The document switcher takes the remaining width and truncates the name. */}
      <div ref={switcherRef} className="relative flex min-w-0 flex-1 justify-center">
        {renaming ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the editor is opened by the explicit Rename command.
            autoFocus
            type="text"
            defaultValue={docName}
            aria-label={t('shell.rename.prompt')}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelled.current = true;
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => {
              if (cancelled.current) {
                cancelled.current = false;
                onRenameCancel?.();
                return;
              }
              onRename?.(event.currentTarget.value);
            }}
            className="h-7 w-64 max-w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-xs text-kumo-strong outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowTabMenu((open) => !open)}
            aria-expanded={showTabMenu}
            aria-haspopup="true"
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-kumo-strong transition-colors hover:bg-kumo-recessed"
            title={docName}
          >
            <span className="truncate">{docName}</span>
            {isDirty ? (
              <span className="size-1.5 shrink-0 rounded-full bg-pdf-accent" title={t('status.dirty')} />
            ) : null}
            <CaretDown size={12} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
          </button>
        )}
        {showTabMenu && !renaming ? (
          <div className="pdf-overlay-shadow absolute top-full left-1/2 z-50 mt-1 w-64 max-w-[90vw] -translate-x-1/2 rounded-lg border border-kumo-line bg-kumo-base p-1">
            <div className="px-2 py-1 text-[11px] font-semibold tracking-wider text-kumo-subtle uppercase">
              {t('shell.openTabs')} ({tabs.length})
            </div>
            <div className="max-h-48 overflow-y-auto">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`flex items-center justify-between rounded px-2 py-1.5 text-xs transition-colors ${
                    tab.id === activeTabId
                      ? 'bg-kumo-recessed font-semibold text-kumo-strong'
                      : 'text-kumo-default hover:bg-kumo-recessed/50'
                  }`}
                >
                  <button
                    type="button"
                    className="flex-1 truncate text-left"
                    title={tab.name}
                    onClick={() => {
                      onSelectTab(tab.id);
                      setShowTabMenu(false);
                    }}
                  >
                    {tab.name}
                  </button>
                  {tab.dirty ? (
                    <span className="mr-1.5 size-1.5 shrink-0 rounded-full bg-pdf-accent" />
                  ) : null}
                  <button
                    type="button"
                    aria-label={t('shell.closeTab')}
                    onClick={() => onCloseTab(tab.id)}
                    className="rounded p-0.5 text-kumo-subtle hover:bg-kumo-contrast/10 hover:text-kumo-danger"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* File actions: labels yield below 768 px, the controls keep their size. */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onSearch}
          className={ICON_CLASS}
          title={`${t('shell.search')} (Ctrl+F)`}
          aria-label={t('shell.search')}
        >
          <MagnifyingGlass size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onPalette}
          className={ICON_CLASS}
          title={`${t('palette.title')} (Ctrl+K)`}
          aria-label={t('palette.title')}
        >
          <Command size={16} aria-hidden="true" />
        </button>
        <Button
          size="sm"
          variant="ghost"
          icon={FolderOpen}
          onClick={onOpen}
          title={`${t('shell.open')} (Ctrl+O)`}
          aria-label={t('shell.open')}
        >
          <span className="hidden md:inline">{t('shell.open')}</span>
        </Button>
        {saveMode === 'none' ? null : (
          <Button
            size="sm"
            variant={canSave && isDirty ? 'primary' : 'outline'}
            icon={FloppyDisk}
            onClick={onSave}
            disabled={!canSave}
            title={`${t(saveMode === 'save' ? 'shell.save.hint' : 'shell.saveAs.hint')} (Ctrl+S)`}
            aria-label={t(saveMode === 'save' ? 'shell.save' : 'shell.saveAs')}
          >
            <span className="hidden md:inline">{t(saveMode === 'save' ? 'shell.save' : 'shell.saveAs')}</span>
          </Button>
        )}
        <div className="flex items-center">
          <Button
            size="sm"
            variant="outline"
            icon={DownloadSimple}
            onClick={onExport}
            disabled={!canExport}
            title={t('shell.export.hint')}
            aria-label={t('shell.export')}
            className={onExportOptions ? 'rounded-r-none border-r-0' : ''}
          >
            <span className="hidden md:inline">{t('shell.export')}</span>
          </Button>
          {onExportOptions ? (
            <button
              type="button"
              onClick={onExportOptions}
              title={t('tools.exportOptions')}
              aria-label={t('tools.exportOptions')}
              className="flex h-8 items-center justify-center rounded-r-md border border-kumo-line bg-kumo-base px-1.5 text-kumo-subtle transition-colors hover:bg-kumo-recessed hover:text-kumo-strong"
            >
              <CaretDown size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onSettings}
          className={ICON_CLASS}
          title={t('settings.open')}
          aria-label={t('settings.open')}
        >
          <GearSix size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
