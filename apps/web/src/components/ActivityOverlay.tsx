import { X } from '@phosphor-icons/react';
import type { MessageKey, Translator } from 'pdf-shared';
import { Button } from 'pdf-ui/ui';
import { useEffect, useState } from 'react';

/**
 * The shell's notice and progress, **over** the document instead of above it.
 *
 * Both used to be rows in the page's flow between the header and the viewer. Every
 * operation raised the progress row and then a notice row, so the document jumped down
 * by one row, up again, and down again for a notice that never went away (measured on
 * a page rotation: the viewer moved 29.5 px and stayed there). Floating them keeps the
 * viewer's box — and so the reader's place — exactly where it was.
 *
 * A notice closes itself after {@link NOTICE_MS} unless the pointer rests on it, and can
 * be closed at once; the text stays in a polite live region for assistive technology.
 */

/** How long a notice stays up on its own. Long enough to read a two-line error. */
export const NOTICE_MS = 9000;

export interface ActivityProgress {
  readonly labelKey: MessageKey;
  readonly done?: number;
  readonly total?: number;
}

export interface ActivityOverlayProps {
  readonly t: Translator;
  readonly notice: string | null;
  readonly onDismiss: () => void;
  readonly progress: ActivityProgress | null;
  readonly onCancel: () => void;
  /**
   * Work in flight that reports no steps and cannot be cancelled — opening a file is
   * the case: until the engine has parsed it there is no tab to show, and the home
   * screen used to sit still with nothing saying anything was happening.
   */
  readonly activity?: string | null;
}

export function ActivityOverlay({
  t,
  notice,
  onDismiss,
  progress,
  onCancel,
  activity = null,
}: ActivityOverlayProps) {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (notice === null || hovered) return undefined;
    const timer = setTimeout(onDismiss, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, hovered, onDismiss]);

  const percent =
    progress === null || progress.total === undefined || progress.total === 0
      ? 100
      : Math.round((100 * (progress.done ?? 0)) / progress.total);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-50 flex flex-col items-center gap-2 px-3">
      {activity === null || progress !== null ? null : (
        <div
          role="status"
          aria-live="polite"
          className="pdf-floating-shadow flex items-center gap-2 rounded-md border border-kumo-line bg-kumo-base px-3 py-1.5 text-xs text-kumo-subtle"
        >
          <span
            aria-hidden="true"
            className="size-3.5 animate-spin rounded-full border-2 border-kumo-line border-t-pdf-accent motion-reduce:animate-none"
          />
          {activity}
        </div>
      )}
      {progress === null ? null : (
        <div
          role="progressbar"
          aria-label={t('progress.label')}
          aria-valuemin={0}
          aria-valuemax={progress.total ?? 0}
          aria-valuenow={progress.done ?? 0}
          className="pdf-floating-shadow pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-md border border-kumo-line bg-kumo-base px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 truncate text-kumo-subtle">
            {progress.total === undefined
              ? t(progress.labelKey)
              : t('op.progress', {
                  label: t(progress.labelKey),
                  done: progress.done ?? 0,
                  total: progress.total,
                })}
          </span>
          <span className="h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-kumo-recessed">
            <span className="block h-full bg-pdf-accent" style={{ width: `${percent}%` }} />
          </span>
          <Button size="sm" shape="base" onClick={onCancel}>
            {t('progress.cancel')}
          </Button>
        </div>
      )}
      <div
        role="status"
        aria-live="polite"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className={
          notice === null
            ? 'sr-only'
            : 'pdf-floating-shadow pointer-events-auto flex w-full max-w-xl items-start gap-2 rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-xs text-kumo-default'
        }
      >
        {notice === null ? null : (
          <>
            <span className="min-w-0 flex-1 whitespace-pre-line">{notice}</span>
            <button
              type="button"
              aria-label={t('op.close')}
              title={t('op.close')}
              onClick={onDismiss}
              className="grid size-5 shrink-0 place-items-center rounded-sm text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong focus-visible:outline-2 focus-visible:outline-kumo-focus"
            >
              <X size={12} weight="bold" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
