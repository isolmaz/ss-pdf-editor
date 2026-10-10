/**
 * The surfaces that belong to opening a document: the start screen's header, the password
 * question and the hidden file input of the plain-input path — wired to the open store.
 */

import { Command, FilePdf, FolderOpen, GearSix } from '@phosphor-icons/react';
import { CONVERT_ACCEPT } from 'pdf-core/ops/convert-formats';
import type { Translator } from 'pdf-shared';
import { Button } from 'pdf-ui/ui';
import { lazy, Suspense, useEffect } from 'react';
import { fileInput } from './open-actions';
import { dismissPasswordPrompt, dropHomeCommand, hideStartScreen, useOpen } from './open-store';

const PasswordDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.PasswordDialog };
});

export interface HomeHeaderProps {
  readonly t: Translator;
  /** The product's name, shown beside the mark. */
  readonly title: string;
  /** The open document's name, or `null` when none is: the way back to it is offered only then. */
  readonly activeDocumentName: string | null;
  readonly onSettings: () => void;
  readonly onPalette: () => void;
  readonly onOpen: () => void;
}

/** The bar above the start screen. */
export function HomeHeader({ t, title, activeDocumentName, onSettings, onPalette, onOpen }: HomeHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4 select-none">
      <div className="flex min-w-0 items-center gap-2.5">
        {/* `bg-pdf-accent`/`text-pdf-on-accent` are the product's own contrast
            pair: `bg-kumo-strong` is not a token Kumo declares, which left this
            mark a transparent chip with white glyph on white. Same pair as the
            editor header's mark. */}
        <div className="flex size-7 shrink-0 items-center justify-center rounded bg-pdf-accent text-pdf-on-accent">
          <FilePdf size={18} weight="fill" />
        </div>
        {/* Below 400px the wordmark is dropped rather than clipped to one letter:
            the mark still identifies the app, and the controls keep their real
            size. */}
        <span className="hidden shrink-0 text-sm font-semibold text-kumo-strong min-[400px]:inline">
          {title}
        </span>
        <span className="hidden text-xs text-kumo-subtle md:inline">{t('shell.homeTagline')}</span>
      </div>
      {/* `shrink-0` keeps the controls at their real size: without it flex
          shrinks them below their content and the row overflows the viewport
          on a phone. The identity above is what yields, via `min-w-0`. */}
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          icon={GearSix}
          onClick={onSettings}
          title={t('settings.open')}
          aria-label={t('settings.open')}
        />
        {activeDocumentName !== null ? (
          <Button size="sm" variant="outline" onClick={hideStartScreen}>
            {t('shell.backToDocument')} ({activeDocumentName})
          </Button>
        ) : null}
        {/* Below `md` the icon carries the control and the tooltip names it;
            the full label is what pushed the row past the viewport edge. */}
        <Button
          size="sm"
          variant="ghost"
          icon={Command}
          onClick={onPalette}
          title={t('shell.commandPalette')}
          aria-label={t('shell.commandPalette')}
        >
          <span className="hidden md:inline">{t('shell.commandPaletteShort')}</span>
        </Button>
        <Button size="sm" variant="primary" icon={FolderOpen} onClick={onOpen}>
          {t('shell.open')}
        </Button>
      </div>
    </header>
  );
}

export interface PasswordPromptHostProps {
  readonly t: Translator;
  /** Open the file again with the password the user typed. */
  readonly onSubmit: (file: File, handle: FileSystemFileHandle | undefined, password: string) => void;
}

/** Mounted only while a protected file waits for its password. */
export function PasswordPromptHost({ t, onSubmit }: PasswordPromptHostProps) {
  const prompt = useOpen((state) => state.passwordPrompt);
  if (prompt === null) return null;
  return (
    <Suspense fallback={null}>
      <PasswordDialog
        t={t}
        name={prompt.file.name}
        incorrect={prompt.incorrect}
        onCancel={() => {
          dropHomeCommand();
          dismissPasswordPrompt();
        }}
        onSubmit={(password) => {
          dismissPasswordPrompt();
          onSubmit(prompt.file, prompt.handle, password);
        }}
      />
    </Suspense>
  );
}

export interface OpenFileInputProps {
  /** A file the plain input picked (the path without the File System Access picker). */
  readonly onFile: (file: File) => void;
}

/**
 * The hidden file input. Its own "cancel" drops the tool the start screen was waiting to
 * run, so it cannot run on a document opened later for another reason.
 */
export function OpenFileInput({ onFile }: OpenFileInputProps) {
  useEffect(() => {
    // Mounted with the component: a child's ref is attached before its effects run.
    const input = fileInput.current as HTMLInputElement;
    input.addEventListener('cancel', dropHomeCommand);
    return () => input.removeEventListener('cancel', dropHomeCommand);
  }, []);
  return (
    <input
      ref={fileInput}
      type="file"
      accept={`application/pdf,.pdf,${CONVERT_ACCEPT}`}
      className="hidden"
      onChange={(event) => {
        const file = event.target.files?.item(0);
        if (file != null) onFile(file);
        event.target.value = '';
      }}
    />
  );
}
