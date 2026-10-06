import type { MessageKey, Translator } from 'pdf-shared';
import type { DialogResultKind } from './types';

/**
 * The two steps every operation dialog has, shown the same way everywhere.
 *
 * A capability first takes its settings, then runs and shows what it did — the report
 * — before anything reaches the document. Without a marker the first button ("apply")
 * read as the end of the job, and closing the report discarded work the user believed
 * was done. The second step is named after what the result will become.
 */
export function DialogSteps({
  t,
  step,
  resultKind,
}: {
  readonly t: Translator;
  readonly step: 1 | 2;
  readonly resultKind: DialogResultKind;
}) {
  const second: MessageKey = resultKind === 'replace' ? 'dialog.step.review' : 'dialog.step.result';
  const items: readonly [MessageKey, 1 | 2][] = [
    ['dialog.step.settings', 1],
    [second, 2],
  ];
  return (
    <ol className="flex items-center gap-2 text-[11px] text-kumo-subtle">
      {items.map(([key, index]) => {
        const current = index === step;
        const passed = index < step;
        return (
          <li key={key} aria-current={current ? 'step' : undefined} className="flex items-center gap-1.5">
            {index > 1 ? <span aria-hidden="true" className="h-px w-4 bg-kumo-line" /> : null}
            <span
              className={`grid size-4 place-items-center rounded-full text-[10px] font-semibold tabular-nums ${
                current
                  ? 'bg-pdf-accent text-pdf-on-accent'
                  : passed
                    ? 'bg-kumo-recessed text-kumo-default'
                    : 'border border-kumo-line text-kumo-subtle'
              }`}
            >
              {index}
            </span>
            <span className={current ? 'font-semibold text-kumo-strong' : ''}>{t(key)}</span>
          </li>
        );
      })}
    </ol>
  );
}
