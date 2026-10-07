import { ArrowClockwise, Sparkle, X } from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { useServiceWorkerUpdate } from '../serviceWorkerUpdate';

export interface UpdateBannerProps {
  readonly t: Translator;
}

export function UpdateBanner({ t }: UpdateBannerProps) {
  const { updateAvailable, reloadToUpdate, dismissUpdate } = useServiceWorkerUpdate();

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center justify-between border-b border-pdf-accent/30 bg-pdf-accent px-4 py-2 text-xs font-medium text-pdf-on-accent select-none shadow-sm animate-in slide-in-from-top duration-200"
    >
      <div className="flex items-center gap-2">
        <Sparkle size={16} weight="fill" className="shrink-0 animate-pulse text-amber-300" />
        <span>{t('update.available')}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reloadToUpdate}
          className="flex items-center gap-1.5 rounded bg-kumo-base px-3 py-1 font-semibold text-pdf-accent hover:bg-kumo-base/90 active:scale-95 transition-all shadow-xs"
        >
          <ArrowClockwise size={13} weight="bold" />
          <span>{t('update.refresh')}</span>
        </button>

        <button
          type="button"
          onClick={dismissUpdate}
          title={t('op.close')}
          aria-label={t('op.close')}
          className="flex size-6 items-center justify-center rounded text-pdf-on-accent/80 hover:bg-black/10 hover:text-pdf-on-accent transition-colors"
        >
          <X size={14} weight="bold" />
        </button>
      </div>
    </div>
  );
}
