import { Dialog } from '@cloudflare/kumo/components/dialog';
import type { Translator } from 'pdf-shared';
import { Button } from '../components/Button';

export function CloseDocumentDialog({
  t,
  name,
  canSave,
  busy,
  notice,
  onCancel,
  onSave,
  onExport,
  onDiscard,
}: {
  readonly t: Translator;
  readonly name: string;
  readonly canSave: boolean;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly onExport: () => void;
  readonly onDiscard: () => void;
}) {
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
          {t('close.title', { name })}
        </Dialog.Title>
        <Dialog.Description className="text-xs text-kumo-subtle">
          {t(canSave ? 'close.body' : 'close.exportHint')}
        </Dialog.Description>
        {notice === null || notice === t(canSave ? 'close.body' : 'close.exportHint') ? null : (
          <p role="status" className="text-xs text-kumo-subtle">
            {notice}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t('op.cancel')}
          </Button>
          <Button variant="secondary-destructive" disabled={busy} onClick={onDiscard}>
            {t('close.discard')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={canSave ? onSave : onExport}>
            {t(canSave ? 'close.save' : 'shell.export')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
