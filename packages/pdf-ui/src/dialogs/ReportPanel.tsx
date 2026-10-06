/**
 * The result surface every operation ends in (`PLAN.md §1.2`, §3.3 rule 7).
 *
 * The report is the product's honesty contract made visible: the page count, the
 * size delta, whether the file stayed incremental or was rewritten, the engine
 * steps that actually ran, and — grouped and translated — what the operation
 * lost, changed, warned about and preserved. It is a panel and not a modal
 * (`§3.3` rule 7: "a report is produced in the background ... a blocking
 * confirmation appears only for destructive steps"), so the same component can
 * be rendered inside the operation dialog or under a save.
 *
 * Two rendering rules carry the contract:
 *
 *  - **`lost` is read first and is never quieter than `preserved`.** The groups
 *    are ordered losses → warnings → changes → preserved, and the loss group
 *    takes the strong text role while the preserved group recedes to the subtle
 *    one. A user who skims must not be able to come away believing a loss was a
 *    preservation.
 *  - **Every sentence comes from the dictionary.** `OperationNote` carries an
 *    i18n key, never English text (`pdf-core/ops/types.ts`), so this file cannot
 *    invent product copy even by accident.
 */

import type { OperationNote, OperationNoteKind, OperationReport } from 'pdf-core/ops/types';
import { formatBytes } from 'pdf-core/ops/types';
import type { MessageKey, Translator } from 'pdf-shared';
import { useId } from 'react';

/** Reading order of the note groups: what was lost is read before what survived. */
const NOTE_ORDER: readonly OperationNoteKind[] = ['lost', 'warning', 'changed', 'preserved'];

/** Group headings `op.result.losses`/`op.result.preserved` did not already name. */
const NOTE_HEADINGS: Record<OperationNoteKind, MessageKey> = {
  lost: 'op.result.losses',
  warning: 'dialog.result.warnings',
  changed: 'dialog.result.changed',
  preserved: 'op.result.preserved',
};

/**
 * The honesty contract as colour role: the loss group is the strong one, an
 * advisory takes the amber the rest of the product uses for warnings, and the
 * groups that describe survival recede. Status is never colour alone — each
 * group's own heading is the word (`DESIGN.md`, "The Never-Colour-Alone Rule").
 */
const NOTE_TONE: Record<OperationNoteKind, { readonly heading: string; readonly text: string }> = {
  lost: { heading: 'text-kumo-strong', text: 'text-kumo-default' },
  warning: { heading: 'text-kumo-warning', text: 'text-kumo-default' },
  changed: { heading: 'text-kumo-subtle', text: 'text-kumo-subtle' },
  preserved: { heading: 'text-kumo-subtle', text: 'text-kumo-subtle' },
};

export interface OperationReportPanelProps {
  readonly t: Translator;
  readonly report: OperationReport;
  /**
   * Extra notes to group with the engine's own — a capability's after-the-fact
   * observation, or the run's notice. Omitted, the report speaks for itself.
   */
  readonly notes?: readonly OperationNote[];
}

export function OperationReportPanel({ t, report, notes }: OperationReportPanelProps) {
  const headingId = useId();
  const all = notes === undefined ? report.notes : [...report.notes, ...notes];
  const sizeKey: MessageKey =
    report.outputBytes > report.inputBytes ? 'op.result.size.grew' : 'op.result.size';

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      {/* h3 under Kumo's Dialog.Title (the dialog's h2); the groups below are h4. */}
      <h3 id={headingId} className="text-sm font-semibold text-kumo-strong">
        {t('op.result.title')}
      </h3>

      <ul className="flex flex-col gap-0.5 text-xs text-kumo-default">
        <li>{t('op.result.pages', { count: report.pageCount })}</li>
        <li className="tabular-nums">
          {t(sizeKey, {
            before: formatBytes(report.inputBytes),
            after: formatBytes(report.outputBytes),
          })}
        </li>
        <li>{t(report.incremental ? 'op.result.incremental' : 'op.result.fullRewrite')}</li>
      </ul>

      {report.steps.length === 0 ? null : (
        <p className="text-xs text-kumo-subtle">
          {/* Engine step ids (`pages`, `verify`) are identifiers, not copy: they are
              joined into the dictionary's sentence rather than translated one by one. */}
          {t('op.result.steps', { steps: report.steps.join(', ') })}
        </p>
      )}

      {NOTE_ORDER.map((kind) => {
        const group = all.filter((note) => note.kind === kind);
        if (group.length === 0) return null;
        const tone = NOTE_TONE[kind];
        return (
          <div key={kind} className="flex flex-col gap-0.5">
            <h4 className={`text-xs font-semibold ${tone.heading}`}>{t(NOTE_HEADINGS[kind])}</h4>
            <ul className={`flex flex-col gap-0.5 text-xs ${tone.text}`}>
              {group.map((note, index) => (
                // Notes are positional data, not entities: the key is their place in
                // the group, and the group never reorders within a report.
                <li key={`${kind}-${String(index)}`}>{t(note.key, note.params)}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
