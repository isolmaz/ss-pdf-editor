/**
 * The redaction mark list (right dock: "Redaction marks"; the pattern search
 * fills it).
 *
 * The panel owns exactly two things: which areas are marked, and clearing them.
 * Everything about *how* a mark is made — box drawing, text search, the handling
 * of images and metadata — is the active tool's settings and arrives as children,
 * so the tool can change without this list knowing about it.
 *
 * Rows are not interactive and carry no roving tabindex: the only controls are the
 * per-row remove button and the clear-all action, both of which are ordinary tab
 * stops. The empty state is the dictionary's own sentence, which also tells the
 * user how to make the first mark.
 */

import { X } from '@phosphor-icons/react';
import type { MessageKey, Translator } from 'pdf-shared';
import type { ReactNode } from 'react';
import { Button } from '../components/Button';
import { PanelMessage } from './PanelParts';

export interface RedactionMark {
  readonly id: string;
  /** 0-based page the mark is drawn on; the list shows it 1-based, like every page number in the product. */
  readonly pageIndex: number;
  /** What the mark covers when the tool knows it (the found text, the drawn area). */
  readonly labelKey?: MessageKey;
  readonly labelParams?: Readonly<Record<string, string | number>>;
}

export interface RedactionPanelProps {
  readonly t: Translator;
  readonly marks: readonly RedactionMark[];
  readonly onRemove: (id: string) => void;
  readonly onClear: () => void;
  /** The active tool's settings; omitted means no tool is active. */
  readonly children?: ReactNode;
}

export function RedactionPanel({ t, marks, onRemove, onClear, children }: RedactionPanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-kumo-line px-2 py-1.5">
        <p className="min-w-0 flex-1 text-xs text-kumo-default">
          {t('redact.markCount', { count: marks.length })}
        </p>
        <Button variant="outline" disabled={marks.length === 0} onClick={onClear}>
          {t('redact.clearMarks')}
        </Button>
      </div>

      {marks.length === 0 ? (
        <PanelMessage text={t('redact.marks.empty')} />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1" aria-label={t('redact.marks')}>
          {marks.map((mark) => {
            const pageLabel = t('dialog.redactMark.page', { page: mark.pageIndex + 1 });
            return (
              <li key={mark.id} className="flex items-start gap-1 rounded-sm px-1.5 py-1">
                <span className="min-w-0 flex-1">
                  {mark.labelKey === undefined ? null : (
                    <span className="block break-words text-xs text-kumo-default">
                      {t(mark.labelKey, mark.labelParams)}
                    </span>
                  )}
                  <span className="block text-[11px] tabular-nums text-kumo-subtle">{pageLabel}</span>
                </span>
                <Button
                  shape="square"
                  variant="ghost"
                  icon={X}
                  // Named by the mark it removes, not by its icon: with several rows
                  // on screen, "İşareti kaldır" alone would be the same name five times.
                  aria-label={`${t('redact.removeMark')}: ${pageLabel}`}
                  onClick={() => onRemove(mark.id)}
                />
              </li>
            );
          })}
        </ul>
      )}

      <section
        aria-label={t('panel.toolSettings')}
        className="flex shrink-0 flex-col gap-2 border-t border-kumo-line p-2"
      >
        <h3 className="text-xs font-semibold text-kumo-subtle">{t('panel.toolSettings')}</h3>
        {children ?? <p className="text-xs text-kumo-subtle">{t('panel.toolSettings.none')}</p>}
      </section>
    </div>
  );
}
