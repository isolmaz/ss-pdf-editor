import { Dialog } from '@cloudflare/kumo/components/dialog';
import type { Translator } from 'pdf-shared';
import { Button } from '../components/Button';

/**
 * "The file changed after you opened it": the question an in-place Save asks when the file on
 * disk is not the one the editor last saw. Overwriting is the destructive answer, so it is a
 * button of its own and never the default.
 */
export function SaveConflictDialog({
  t,
  name,
  busy,
  onCancel,
  onOverwrite,
  onSaveAs,
}: {
  readonly t: Translator;
  readonly name: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onOverwrite: () => void;
  readonly onSaveAs: () => void;
}) {
  return (
    <Dialog.Root
      open
      // The shell opens the dialog (it has no trigger), so the popup only ever asks to close.
      onOpenChange={(_open, details) => {
        details.cancel();
        onCancel();
      }}
    >
      <Dialog size="sm" className="flex flex-col gap-3 p-4">
        <Dialog.Title className="break-words text-sm font-semibold text-kumo-strong">
          {t('error.conflict.message')}
        </Dialog.Title>
        <Dialog.Description className="text-xs text-kumo-subtle">{t('conflict.body')}</Dialog.Description>
        <p className="break-words text-xs font-medium text-kumo-default">{name}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t('op.cancel')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onSaveAs}>
            {t('shell.saveAs')}
          </Button>
          <Button variant="secondary-destructive" disabled={busy} onClick={onOverwrite}>
            {t('conflict.overwrite')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
