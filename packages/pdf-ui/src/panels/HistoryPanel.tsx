/**
 * The step list (`PLAN.md §4.1` right dock: "History (labelled step list, e.g.
 * “Rotated page 3”)", `§4.4` live-region announcements).
 *
 * The journal is data, not functions (`pdf-model/journal.ts`): each entry carries
 * an i18n key plus JSON params, so the panel can only render what the entry
 * declared — it cannot invent a sentence, and an untranslated label is a compile
 * error rather than an English string in the dock.
 *
 * The list is a log, not a widget: nothing inside it is focusable, the current
 * position is marked with `aria-current="step"`, and the two controls that do
 * exist (undo/redo) are the only tab stops. The keyboard bindings for those live in
 * the app, which owns the journal.
 */

import { ArrowClockwise, ArrowCounterClockwise } from '@phosphor-icons/react';
import type { JournalEntry, JsonValue } from 'pdf-model';
import type { MessageKey, Translator } from 'pdf-shared';
import { Button } from '../components/Button';
import { PanelMessage } from './PanelParts';

export interface HistoryPanelProps {
  readonly t: Translator;
  readonly entries: readonly JournalEntry[];
  /** Entries applied so far: everything from here on is redoable. */
  readonly cursor: number;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

/**
 * `labelParams` arrives as JSON, and the translator takes scalars. Anything that
 * is not a string, number or boolean (a nested payload) is dropped rather than
 * stringified into the sentence: `{count}` reading `[object Object]` would be
 * worse than the placeholder staying visible.
 */
function labelParams(value: JsonValue | undefined): Readonly<Record<string, string>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const params: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      params[key] = String(item);
    }
  }
  return Object.keys(params).length === 0 ? undefined : params;
}

export function HistoryPanel({ t, entries, cursor, onUndo, onRedo }: HistoryPanelProps) {
  const undoable = cursor;
  const redoable = entries.length - cursor;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-kumo-line px-2 py-1.5">
        <Button variant="outline" icon={ArrowCounterClockwise} disabled={undoable === 0} onClick={onUndo}>
          {t('op.undo')}
        </Button>
        <Button variant="outline" icon={ArrowClockwise} disabled={redoable === 0} onClick={onRedo}>
          {t('op.redo')}
        </Button>
      </div>

      <p className="shrink-0 px-2 py-1 text-[11px] tabular-nums text-kumo-subtle">
        {t('panel.history.undoable', { count: undoable })}
        {' · '}
        {t('panel.history.redoable', { count: redoable })}
      </p>

      {entries.length === 0 ? (
        <PanelMessage text={t('panel.history.empty')} />
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto p-1" aria-label={t('panel.history')}>
          {entries.map((entry, index) => {
            const applied = index < cursor;
            return (
              <li
                key={entry.id}
                // `step` is the ARIA token for "where we are in a sequence", which is
                // exactly what the journal cursor means.
                aria-current={index === cursor - 1 ? 'step' : undefined}
                className="flex items-baseline gap-1.5 rounded-sm px-1.5 py-1"
              >
                <span className="shrink-0 text-[11px] tabular-nums text-kumo-subtle">{index + 1}</span>
                {/* Not truncated: the label *is* the record of what happened, and a
                    clipped sentence ("Rotated page …") is a hidden fact. */}
                <span
                  className={`min-w-0 flex-1 break-words text-xs ${
                    applied ? 'text-kumo-default' : 'text-kumo-subtle'
                  }`}
                >
                  {t(entry.labelKey as MessageKey, labelParams(entry.labelParams))}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
