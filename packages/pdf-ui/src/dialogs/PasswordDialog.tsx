import { Dialog } from '@cloudflare/kumo/components/dialog';
import type { Translator } from 'pdf-shared';
import { useState } from 'react';
import { Button } from '../components/Button';

/**
 * The open password for a protected document.
 *
 * pdf.js asks for the password through its loading task, and the adapter answers with
 * the one the caller supplied (`openWithPdfjs`). Before this dialog existed the shell
 * supplied none: the open failed with "enter the password and try again" and there was
 * no place to enter it. The password is held for this session only — it opens the
 * document and, on request, produces an unlocked copy; it is never written to a draft.
 */
export interface PasswordDialogProps {
  readonly t: Translator;
  readonly name: string;
  /** The previous attempt was refused: say so above the field. */
  readonly incorrect: boolean;
  readonly onSubmit: (password: string) => void;
  readonly onCancel: () => void;
}

export function PasswordDialog({ t, name, incorrect, onSubmit, onCancel }: PasswordDialogProps) {
  const [password, setPassword] = useState('');
  return (
    <Dialog.Root
      open
      onOpenChange={(open, details) => {
        if (!open) {
          details.cancel();
          onCancel();
        }
      }}
    >
      <Dialog size="sm" className="flex flex-col gap-3 p-4">
        <Dialog.Title className="break-words text-sm font-semibold text-kumo-strong">
          {t('password.title', { name })}
        </Dialog.Title>
        <Dialog.Description className="text-xs text-kumo-subtle">{t('password.body')}</Dialog.Description>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(password);
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-kumo-default">
            {t('password.label')}
            <input
              type="password"
              // The dialog exists to take this one value, so the field has the focus.
              autoFocus
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={incorrect}
              className="h-8 rounded-sm border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default outline-none focus:ring-1 focus:ring-kumo-focus"
            />
          </label>
          {incorrect ? (
            <p role="alert" className="text-xs text-kumo-danger">
              {t('error.wrong-password.message')}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              {t('op.cancel')}
            </Button>
            <Button type="submit" variant="primary">
              {t('password.open')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
